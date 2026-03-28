const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toNumber(value) {
  const normalized = String(value ?? "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");
  return parseFloat(normalized);
}

function getTimeCategory() {
  const hour = new Date().getHours();

  if (hour === 21) return "onay"; // 21:00
  if (hour >= 9 && hour <= 18) return "seans";
  return "diger";
}

// 📦 GEÇMİŞ KAYIT
function saveHistory(rows) {
  const today = new Date().toLocaleDateString("tr-TR");
  const category = getTimeCategory();

  let db = {};

  if (fs.existsSync("history.json")) {
    db = JSON.parse(fs.readFileSync("history.json", "utf8"));
  }

  if (!db[today]) {
    db[today] = {
      onay: [],
      seans: []
    };
  }

  db[today][category] = rows;

  fs.writeFileSync("history.json", JSON.stringify(db, null, 2));
  console.log("history.json güncellendi");
}

// 📊 ANA JSON (APP İÇİN)
function saveSignals(rows) {
  const payload = {
    updatedAt: new Date().toLocaleString("tr-TR"),
    signals: rows
  };

  fs.writeFileSync("signals.json", JSON.stringify(payload, null, 2));
}

// 📈 CANLI FİYAT (BASİT API)
async function getLivePrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}.IS`;
    const res = await axios.get(url);
    return res.data.quoteResponse.result[0]?.regularMarketPrice || null;
  } catch {
    return null;
  }
}

// 🧠 ANA BOT
async function run() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: "networkidle2" });
    await sleep(4000);

    const rows = await page.evaluate(() => {
      const data = [];
      document.querySelectorAll('a[href*="SignalPage"]').forEach(link => {
        const ticker = link.href.match(/Ticker=([A-Z]+)/)?.[1];
        if (ticker) data.push({ ticker });
      });
      return [...new Map(data.map(i => [i.ticker, i])).values()];
    });

    const detailPage = await browser.newPage();

    for (const row of rows) {
      try {
        await detailPage.goto(`${DETAIL_URL}${row.ticker}`);
        await sleep(1500);

        const detail = await detailPage.evaluate(() => {
          const text = document.body.innerText;

          const al = text.match(/Al Seviyesi[:\s]*([0-9.,]+)/i);
          const stop = text.match(/Stop[:\s]*([0-9.,]+)/i);

          return {
            alis: al ? al[1] : null,
            stop: stop ? stop[1] : null
          };
        });

        row.alis = detail.alis;
        row.stop = detail.stop;

      } catch {}
    }

    await detailPage.close();

    const filtered = [];

    for (const row of rows) {
      const alis = toNumber(row.alis);
      const stop = toNumber(row.stop);

      if (!alis || !stop || stop >= alis) continue;

      const risk = ((alis - stop) / alis) * 100;
      if (risk > 3) continue;

      const live = await getLivePrice(row.ticker);

      let change = null;
      if (live) {
        change = ((live - alis) / alis) * 100;
      }

      filtered.push({
        ticker: row.ticker,
        alis,
        stop,
        risk: risk.toFixed(2),
        current: live,
        change: change ? change.toFixed(2) : null
      });
    }

    // 📦 kayıtlar
    saveSignals(filtered);
    saveHistory(filtered);

    console.log("Tamamlandı");

  } finally {
    await browser.close();
  }
}

run();
