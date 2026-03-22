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

function normalizeRow(row) {
  return {
    ticker: String(row.ticker ?? "").trim(),
    buy: String(row.buy ?? "").trim(),
    stop: String(row.stop ?? "").trim(),
    target: String(row.target ?? "").trim(),
    riskPct: String(row.riskPct ?? "").trim()
  };
}

function saveJson(signals) {
  const payload = {
    updatedAt: new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }),
    signals: signals.map(normalizeRow),
    earlySignals: []
  };

  fs.writeFileSync("signals.json", JSON.stringify(payload, null, 2), "utf8");
  console.log("signals.json oluşturuldu.");
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
      console.log("Sayfa sonuna ulaşıldı.");
      break;
    }

    lastHeight = newHeight;
    console.log(`Scroll turu ${i + 1} tamam.`);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(800);
}

async function getTickers(page) {
  const tickers = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="SignalPage.aspx?lang=tr&Ticker="]'));
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

    console.log("Ana sayfa açılıyor...");
    await page.goto(URL, {
      waitUntil: "networkidle2",
      timeout: 120000
    });

    await sleep(2000);
    await autoScroll(page);

    const tickers = await getTickers(page);
    console.log("Bulunan ticker sayısı:", tickers.length);
    console.log("Tickerlar:", tickers);

    const results = [];

    for (const ticker of tickers) {
      try {
        console.log(`Detay okunuyor: ${ticker}`);
        const row = await readDetail(browser, ticker);

        const buyNum = toNumber(row.buy);
        const stopNum = toNumber(row.stop);
        const targetNum = toNumber(row.target);

        console.log("Detay verisi:", row);

        if (!row.ticker || Number.isNaN(buyNum) || Number.isNaN(stopNum) || Number.isNaN(targetNum)) {
          console.log(`Eksik veri nedeniyle atlandı: ${ticker}`);
          continue;
        }

        if (stopNum >= buyNum) {
          console.log(`Stop >= Alış olduğu için elendi: ${ticker}`);
          continue;
        }

        const riskPct = ((buyNum - stopNum) / buyNum) * 100;

        if (riskPct > 3) {
          console.log(`Risk 3'ten büyük olduğu için elendi: ${ticker} (${riskPct.toFixed(2)}%)`);
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

    console.log("Filtre sonrası sonuç sayısı:", results.length);

    return results;
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    const results = await scrapeData();

    saveJson(results);

    const telegramMessage = buildTelegramMessage(results);
    await sendTelegram(telegramMessage);

    console.log("İşlem tamamlandı.");
  } catch (err) {
    console.error("Genel hata:", err);
    process.exit(1);
  }
}

main();
