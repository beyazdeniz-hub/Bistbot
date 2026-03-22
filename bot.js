const puppeteer = require("puppeteer");
const axios = require("axios");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad(value, width, right = false) {
  const s = String(value ?? "-").trim();
  if (s.length >= width) return s.slice(0, width);
  return right ? s.padStart(width, " ") : s.padEnd(width, " ");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toNumber(value) {
  if (value == null) return NaN;

  const s = String(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  return Number(s);
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik.");
  }

  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  });
}

function buildTelegramMessage(rows) {
  const now = new Date();
  const timeText = now.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });

  let msg = "";
  msg += `Tarama zamanı: ${escapeHtml(timeText)}\n\n`;

  if (!rows.length) {
    msg += `Uygun sinyal bulunamadı.`;
    return msg;
  }

  msg += `<b>Risk <= 3 uygun hisseler</b>\n`;
  msg += `<pre>`;
  msg += `${pad("Hisse", 7)} ${pad("Alış", 10, true)} ${pad("Stop", 10, true)} ${pad("Hedef", 10, true)} ${pad("Risk%", 7, true)}\n`;
  msg += `${"-".repeat(50)}\n`;

  for (const row of rows) {
    msg += `${pad(row.ticker, 7)} ${pad(row.buy, 10, true)} ${pad(row.stop, 10, true)} ${pad(row.target, 10, true)} ${pad(row.riskPct, 7, true)}\n`;
  }

  msg += `</pre>`;
  return msg;
}

async function autoScroll(page) {
  let lastHeight = 0;

  for (let i = 0; i < 20; i++) {
    const newHeight = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });

    await sleep(1500);

    if (newHeight === lastHeight) {
      break;
    }

    lastHeight = newHeight;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(800);
}

async function getTickers(page) {
  const tickers = await page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll('a[href*="SignalPage.aspx?lang=tr&Ticker="]')
    );

    const result = new Set();

    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const match = href.match(/Ticker=([^&]+)/i);
      if (match && match[1]) {
        result.add(match[1].trim().toUpperCase());
      }
    }

    return Array.from(result);
  });

  return tickers;
}

async function readDetail(browser, ticker) {
  const page = await browser.newPage();

  try {
    await page.goto(`${DETAIL_URL}${ticker}`, {
      waitUntil: "networkidle2",
      timeout: 120000
    });

    await page.setViewport({ width: 1400, height: 2200 });
    await sleep(1500);

    const data = await page.evaluate((fallbackTicker) => {
      const bodyText = document.body.innerText || "";

      function pickValue(labels) {
        for (const label of labels) {
          const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(escaped + "\\s*:?\\s*([\\d.,]+)", "i");
          const m = bodyText.match(re);
          if (m && m[1]) return m[1].trim();
        }
        return "";
      }

      function detectTicker() {
        const title = document.title || "";
        const titleMatch = title.match(/([A-ZÇĞİÖŞÜ]{2,10})/);
        if (titleMatch) return titleMatch[1].trim().toUpperCase();

        const h1 = document.querySelector("h1")?.innerText || "";
        const h1Match = h1.match(/([A-ZÇĞİÖŞÜ]{2,10})/);
        if (h1Match) return h1Match[1].trim().toUpperCase();

        return fallbackTicker;
      }

      return {
        ticker: detectTicker(),
        buy: pickValue(["Alış Seviyesi", "Alis Seviyesi"]),
        stop: pickValue(["Stop Seviyesi"]),
        target: pickValue(["Hedef Seviyesi"])
      };
    }, ticker);

    return data;
  } finally {
    await page.close();
  }
}

async function scrapeData() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2500 });

    await page.goto(URL, {
      waitUntil: "networkidle2",
      timeout: 120000
    });

    await sleep(2000);
    await autoScroll(page);

    const tickers = await getTickers(page);
    const results = [];

    for (const ticker of tickers) {
      try {
        const row = await readDetail(browser, ticker);

        const buyNum = toNumber(row.buy);
        const stopNum = toNumber(row.stop);
        const targetNum = toNumber(row.target);

        if (!row.ticker || Number.isNaN(buyNum) || Number.isNaN(stopNum) || Number.isNaN(targetNum)) {
          continue;
        }

        if (stopNum >= buyNum) {
          continue;
        }

        const riskPct = ((buyNum - stopNum) / buyNum) * 100;

        if (riskPct > 3) {
          continue;
        }

        results.push({
          ticker: row.ticker,
          buy: row.buy,
          stop: row.stop,
          target: row.target,
          riskPct: riskPct.toFixed(2)
        });
      } catch (err) {
        console.log(`Detay okunamadı: ${ticker} -> ${err.message}`);
      }
    }

    results.sort((a, b) => Number(a.riskPct) - Number(b.riskPct));

    return results;
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    const results = await scrapeData();
    const telegramMessage = buildTelegramMessage(results);
    await sendTelegram(telegramMessage);
    console.log("İşlem tamamlandı.");
  } catch (err) {
    console.error("Genel hata:", err);
    process.exit(1);
  }
}

main();
