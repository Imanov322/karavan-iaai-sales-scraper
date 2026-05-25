const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { getCopartDetailsFromHTML, generateCopartMessage } = require("./parser");

const stealth = StealthPlugin();
if (stealth.enabledEvasions && stealth.enabledEvasions.delete) {
  stealth.enabledEvasions.delete("chrome.app");
}
puppeteer.use(stealth);

const HEADFUL = process.env.HEADFUL === "true";

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

function extractImageUrls(imagesPayload) {
  // Copart's /lotImages response shape:
  //   { returnCode, data: { imagesList: { FULL_IMAGE: [...], HIGH_RESOLUTION_IMAGE: [...] } } }
  // We prefer HIGH_RESOLUTION_IMAGE when present, falling back to FULL_IMAGE.
  const list = imagesPayload?.data?.imagesList;
  if (!list) return [];

  const pick = (arr) =>
    (arr || [])
      .slice()
      .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0))
      .map((img) => img.highRes || img.url || img.fullUrl || img.url720)
      .filter(Boolean);

  const hires = pick(list.HIGH_RESOLUTION_IMAGE);
  if (hires.length) return hires;
  return pick(list.FULL_IMAGE);
}

async function scrapeCopart({ lotNumber }) {
  if (!lotNumber) throw new Error("lotNumber is required");

  const browser = await puppeteer.launch(getLaunchOpts());
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setDefaultTimeout(60000);
    await page.setDefaultNavigationTimeout(60000);

    // Sniff the lotImages JSON the page fetches on its own.
    let imagesPayload = null;
    page.on("response", async (res) => {
      const url = res.url();
      if (!/\/lotImages\//i.test(url)) return;
      try {
        const json = await res.json();
        imagesPayload = json;
      } catch (_) {
        // not JSON or already consumed — ignore
      }
    });

    console.log(`[copart] navigating to lot ${lotNumber}`);
    await page.goto(`https://www.copart.ca/lot/${lotNumber}`, {
      waitUntil: "networkidle2",
    });
    await page.waitForSelector("h1.title", { timeout: 15000 });

    // The images response usually arrives during networkidle2, but give it a
    // brief grace period in case it lags.
    if (!imagesPayload) {
      try {
        await page.waitForResponse(
          (res) => /\/lotImages\//i.test(res.url()),
          { timeout: 10000 },
        );
      } catch (_) {
        // fall through — we'll still return whatever we parsed from the DOM
      }
    }

    const html = await page.content();
    const data = getCopartDetailsFromHTML(html, lotNumber);
    data.images = extractImageUrls(imagesPayload);
    data.link = `https://www.copart.ca/lot/${lotNumber}`;

    const telegramDescription = generateCopartMessage(data);
    const imageUrls = data.images;

    console.log(
      `[copart] lot ${lotNumber}: ${imageUrls.length} image(s), make=${data.make || "?"}`,
    );

    return { data, telegramDescription, imageUrls };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeCopart };
