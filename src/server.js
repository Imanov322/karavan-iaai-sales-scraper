require("dotenv").config();

const express = require("express");
const morgan = require("morgan");
const { scrape } = require("./scraper");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 4100;

// Single in-flight scrape — Puppeteer is heavy and IAAI sessions don't like
// parallel logins from the same account. Queue subsequent requests.
let inFlight = Promise.resolve();
function queueScrape(fn) {
  const next = inFlight.then(fn, fn);
  inFlight = next.catch(() => undefined);
  return next;
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "karavan-iaai-sales-scraper" });
});

app.post("/scrape", async (req, res) => {
  // Auth — shared secret
  if (API_KEY) {
    const provided = req.header("x-api-key");
    if (provided !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const { lotNumber, winDate, account } = req.body || {};
  if (!lotNumber || !winDate || !account) {
    return res.status(400).json({
      error: "lotNumber, winDate and account are required",
    });
  }

  try {
    const result = await queueScrape(() =>
      scrape({ lotNumber, winDate, account }),
    );
    return res.json(result);
  } catch (err) {
    console.error("[scrape] failed:", err);
    return res
      .status(500)
      .json({ error: "Scrape failed", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`karavan-iaai-sales-scraper listening on ${PORT}`);
});
