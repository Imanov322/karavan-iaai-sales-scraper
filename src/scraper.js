const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { resolveCredentials } = require("./credentials");
const { getCarDetailsFromHTML, generateMessage } = require("./parser");

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

function waitForNewPage(browser, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.off("targetcreated", handler);
      reject(new Error("No new page opened within timeout"));
    }, timeout);

    const handler = async (target) => {
      if (target.type() === "page") {
        clearTimeout(timer);
        const newPage = await target.page();
        resolve(newPage);
      }
    };

    browser.once("targetcreated", handler);
  });
}

async function login(page, user, pass) {
  await page.goto("https://ca.iaai.com/Account/Login", {
    waitUntil: "networkidle2",
  });
  await page.waitForSelector("#Email");
  await page.type("#Email", user);
  await page.type("#Password", pass);
  await page.click('button[type="submit"]');
  await page.waitForSelector('a[id="searchMenu"]');
}

async function navigateToPurchaseHistory(page) {
  await page.waitForSelector(
    '[data-bind="text: toBePaidVehiclesCount, click: toBePaidVehiclesClick"]',
    { visible: true },
  );
  await page.click(
    '[data-bind="text: toBePaidVehiclesCount, click: toBePaidVehiclesClick"]',
  );
  await sleep(2000);

  await page.waitForSelector("#liPurchaseHistory", { visible: true });
  await page.evaluate(() => {
    const el = document.getElementById("liPurchaseHistory");
    if (el) el.click();
  });
  await sleep(2000);
}

async function setDateAndGetReport(page, dateForPicker) {
  await page.waitForSelector("#FromDate", { visible: true });

  const setResult = await page.evaluate((dateStr) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dateObj = new Date(y, m - 1, d);

    // Reset QuickDate to "Select" (9999) so the manual From/To dates aren't
    // overridden by a preset range like "Last 7 Days".
    const quickDate = document.getElementById("QuickDate");
    let quickDateBefore = null;
    let quickDateAfter = null;
    if (quickDate) {
      quickDateBefore = quickDate.value;
      try {
        // eslint-disable-next-line no-undef
        const widget = kendo.widgetInstance(quickDate);
        if (widget && typeof widget.value === "function") {
          widget.value("9999");
          widget.trigger("change");
        } else {
          quickDate.value = "9999";
          quickDate.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } catch (_) {
        quickDate.value = "9999";
        quickDate.dispatchEvent(new Event("change", { bubbles: true }));
      }
      quickDateAfter = quickDate.value;
    }

    const setField = (id) => {
      const input = document.getElementById(id);
      if (!input) return { id, ok: false, reason: "input not found", value: "" };
      try {
        // eslint-disable-next-line no-undef
        const widget = kendo.widgetInstance(input);
        if (widget && typeof widget.value === "function") {
          widget.value(dateObj);
          widget.trigger("change");
          return {
            id,
            ok: true,
            via: "kendo",
            value: input.value,
            widgetValue: widget.value()?.toISOString?.() || null,
          };
        }
      } catch (e) {
        // fall through
      }
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      nativeSetter.call(input, dateStr);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { id, ok: true, via: "native", value: input.value };
    };
    return {
      QuickDate: { before: quickDateBefore, after: quickDateAfter },
      FromDate: setField("FromDate"),
      ToDate: setField("ToDate"),
    };
  }, dateForPicker);

  console.log(
    `[scrape]     QuickDate -> ${JSON.stringify(setResult.QuickDate)}`,
  );
  console.log(`[scrape]     FromDate  -> ${JSON.stringify(setResult.FromDate)}`);
  console.log(`[scrape]     ToDate    -> ${JSON.stringify(setResult.ToDate)}`);

  await sleep(1000);

  await page.waitForSelector("#btnGetReport", { visible: true });
  await page.evaluate(() => {
    document.getElementById("btnGetReport").click();
  });

  try {
    await page.waitForSelector("#ReportGrid tbody tr.k-master-row", {
      visible: true,
      timeout: 20000,
    });
    await sleep(3000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every stock number currently rendered in the report grid.
 */
async function getStockNumbersInGrid(page) {
  return await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll("#ReportGrid tbody tr.k-master-row"),
    );
    return rows.map((row) => {
      const link = row.querySelector("td:nth-child(5) a.bpLinkUnderline");
      return (link?.textContent || "").trim();
    });
  });
}

/**
 * Find the row in the report grid whose Stock column matches `lotNumber`.
 * Returns 0-based row index, or -1.
 */
async function findRowByLot(page, lotNumber) {
  return await page.evaluate((needle) => {
    const target = String(needle).trim();
    const rows = Array.from(
      document.querySelectorAll("#ReportGrid tbody tr.k-master-row"),
    );
    for (let i = 0; i < rows.length; i++) {
      // Stock column is 5th in Purchase History
      const stockLink = rows[i].querySelector(
        "td:nth-child(5) a.bpLinkUnderline",
      );
      const stockNum = (stockLink?.textContent || "").trim();
      if (stockNum === target) return i;
    }
    return -1;
  }, lotNumber);
}

async function openLotInNewTab(page, browser, rowIdx) {
  const newPagePromise = waitForNewPage(browser);
  const clicked = await page.evaluate((idx) => {
    const rows = Array.from(
      document.querySelectorAll("#ReportGrid tbody tr.k-master-row"),
    );
    const row = rows[idx];
    if (!row) return false;
    const stockLink = row.querySelector("td:nth-child(5) a.bpLinkUnderline");
    if (!stockLink) return false;
    stockLink.scrollIntoView({ block: "center" });
    stockLink.click();
    return true;
  }, rowIdx);

  if (!clicked) throw new Error("Could not click the lot row");

  const vehiclePage = await newPagePromise;
  await vehiclePage.waitForSelector("#VehicleDetailsVM", { timeout: 30000 });
  await vehiclePage
    .waitForNetworkIdle({ idleTime: 3000, timeout: 8000 })
    .catch(() => {});
  await sleep(500);
  const html = await vehiclePage.evaluate(
    () => document.documentElement.outerHTML,
  );
  await vehiclePage.close().catch(() => {});
  await page.bringToFront();
  return html;
}

/**
 * Main entry point. Returns:
 *   { data, telegramDescription, imageUrls }
 */
async function scrape({ lotNumber, winDate, account }) {
  if (!lotNumber) throw new Error("lotNumber is required");
  if (!winDate) throw new Error("winDate is required (YYYY-MM-DD)");
  if (!account) throw new Error("account is required");

  const { user, pass, accountKey } = resolveCredentials(account);

  const browser = await puppeteer.launch(getLaunchOpts());
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setDefaultTimeout(120000);
    await page.setDefaultNavigationTimeout(120000);

    console.log(`[scrape] login as ${accountKey}`);
    await login(page, user, pass);

    console.log(`[scrape] navigating to Purchase History`);
    await navigateToPurchaseHistory(page);

    // Iterate tenant tabs — buyer accounts may have multiple, the lot lives in
    // exactly one of them. We try each until we find a match.
    await page.waitForSelector(".tenantBarItem", { visible: true });
    const tenantCount = await page.$$eval(
      ".tenantBarItem",
      (els) => els.length,
    );
    console.log(`[scrape] ${tenantCount} tenant tab(s) to scan`);

    const tenantNames = { 1: "IAA", 2: "ADESA", 3: "MPI", 4: "SGI", 5: "ICBC" };

    let html = null;
    for (let i = 0; i < tenantCount; i++) {
      const tabs = await page.$$(".tenantBarItem");
      const tab = tabs[i];
      const tenantId = await tab.evaluate(
        (el) =>
          el.querySelector(".tenantBarBody")?.getAttribute("data-id") || "?",
      );
      const tenantLabel = `tab ${i + 1} (data-id=${tenantId} ${tenantNames[tenantId] || "?"})`;

      await tab.click();
      await sleep(1500);

      console.log(
        `[scrape]   ${tenantLabel}: setting FromDate=ToDate=${winDate}`,
      );
      const hasRows = await setDateAndGetReport(page, winDate);
      if (!hasRows) {
        console.log(`[scrape]   ${tenantLabel}: no rows for ${winDate}`);
        continue;
      }

      const stockNums = await getStockNumbersInGrid(page);
      console.log(
        `[scrape]   ${tenantLabel}: ${stockNums.length} row(s), stock #s: ${stockNums.join(", ") || "(none)"}`,
      );

      const rowIdx = await findRowByLot(page, lotNumber);
      if (rowIdx < 0) {
        console.log(`[scrape]   ${tenantLabel}: lot ${lotNumber} not found`);
        continue;
      }

      console.log(
        `[scrape]   ${tenantLabel}: lot ${lotNumber} at row ${rowIdx}`,
      );
      html = await openLotInNewTab(page, browser, rowIdx);
      break;
    }

    if (!html) {
      throw new Error(
        `Lot ${lotNumber} not found in purchase history for ${winDate} on account ${accountKey}`,
      );
    }

    const data = getCarDetailsFromHTML(html);
    const telegramDescription = generateMessage(data);
    const imageUrls = data.images || [];

    return { data, telegramDescription, imageUrls };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrape };
