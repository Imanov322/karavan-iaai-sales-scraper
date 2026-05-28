const fs = require("fs");
const path = require("path");
const os = require("os");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const unzipper = require("unzipper");
const { getCopartDetailsFromHTML, generateCopartMessage } = require("./parser");
const { uploadImages } = require("./appwrite");

const stealth = StealthPlugin();
if (stealth.enabledEvasions && stealth.enabledEvasions.delete) {
  stealth.enabledEvasions.delete("chrome.app");
}
puppeteer.use(stealth);

const HEADFUL = process.env.HEADFUL === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getLaunchOpts() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  return {
    headless: HEADFUL ? false : "new",
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--lang=en-US",
      "--window-size=1920,1080",
    ],
  };
}

// Copart serves a single "Download all" ZIP containing every full-resolution
// image for a lot. We let the page download it (via CDP), then unzip and read
// the bytes. This is the only reliable way to get *all* images — the gallery
// lazy-loads thumbnails, so sniffing what the page renders misses most of them.
async function allowDownloads(page, downloadPath) {
  const client = await page.target().createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath,
  });
}

async function waitForZip(downloadDir, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const files = await fs.promises.readdir(downloadDir);
    const zips = files.filter((f) => f.toLowerCase().endsWith(".zip"));
    // Ignore partial Chromium downloads (*.crdownload).
    const partials = files.filter((f) => f.endsWith(".crdownload"));
    if (zips.length && partials.length === 0) {
      let latest = null;
      let latestTime = 0;
      for (const z of zips) {
        const p = path.join(downloadDir, z);
        const st = await fs.promises.stat(p);
        if (st.mtimeMs > latestTime) {
          latest = p;
          latestTime = st.mtimeMs;
        }
      }
      return latest;
    }
    await sleep(1000);
  }
  throw new Error("Timed out waiting for images ZIP");
}

async function unzip(zipFile, outDir) {
  await fs.promises.mkdir(outDir, { recursive: true });
  await fs
    .createReadStream(zipFile)
    .pipe(unzipper.Extract({ path: outDir }))
    .promise();
}

async function downloadLotImages(page, lotNumber) {
  const downloadDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `copart_${lotNumber}_`),
  );
  await allowDownloads(page, downloadDir);

  // Open the floating download CTA, then click "Download all" in the overlay.
  // Classes on the menu item look dynamic, so match on its text instead.
  await page.waitForSelector(".lot-image-floating-CTA", { timeout: 15000 });
  await page.click(".lot-image-floating-CTA");
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("a,button")).some((el) =>
        /download all/i.test((el.textContent || "").trim()),
      ),
    { timeout: 20000 },
  );
  const clicked = await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll("a,button")).find((el) =>
      /download all/i.test((el.textContent || "").trim()),
    );
    if (hit) {
      hit.click();
      return true;
    }
    return false;
  });
  if (!clicked) throw new Error("Could not click 'Download all' after CTA");

  const zipPath = await waitForZip(downloadDir, 120000);
  const extractDir = path.join(downloadDir, "extracted");
  await unzip(zipPath, extractDir);

  const files = await fs.promises.readdir(extractDir);
  const imageFiles = files
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const images = await Promise.all(
    imageFiles.map(async (f) => ({
      filename: f,
      buffer: await fs.promises.readFile(path.join(extractDir, f)),
    })),
  );

  return { images, downloadDir };
}

async function scrapeCopart({ lotNumber }) {
  if (!lotNumber) throw new Error("lotNumber is required");

  const browser = await puppeteer.launch(getLaunchOpts());
  let downloadDir = null;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setDefaultTimeout(60000);
    await page.setDefaultNavigationTimeout(60000);

    console.log(`[copart] navigating to lot ${lotNumber}`);
    await page.goto(`https://www.copart.ca/lot/${lotNumber}`, {
      waitUntil: "networkidle2",
    });
    await page.waitForSelector("h1.title", { timeout: 15000 });

    const html = await page.content();
    const data = getCopartDetailsFromHTML(html, lotNumber);
    data.link = `https://www.copart.ca/lot/${lotNumber}`;

    let imageUrls = [];
    try {
      const { images, downloadDir: dir } = await downloadLotImages(
        page,
        lotNumber,
      );
      downloadDir = dir;
      console.log(
        `[copart] lot ${lotNumber}: downloaded ${images.length} image(s), uploading to storage`,
      );
      imageUrls = await uploadImages(images, lotNumber);
    } catch (err) {
      console.error(`[copart] image download/upload failed: ${err.message}`);
    }

    data.images = imageUrls;
    const telegramDescription = generateCopartMessage(data);

    console.log(
      `[copart] lot ${lotNumber}: ${imageUrls.length} image(s), make=${data.make || "?"}`,
    );

    return { data, telegramDescription, imageUrls };
  } finally {
    await browser.close().catch(() => {});
    if (downloadDir) {
      await fs.promises
        .rm(downloadDir, { recursive: true, force: true })
        .catch(() => {});
    }
  }
}

module.exports = { scrapeCopart };
