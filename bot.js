require('dotenv').config();
const puppeteer = require("puppeteer");
const axios = require("axios");

const TOKEN = process.env.TG_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";
const BATCH_SIZE = 4;
const MESSAGE_CHUNK = 20;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

function parseNumber(value) {
  if (value === null || value === undefined || value === "-") return NaN;
  const s = String(value).trim().replace(/\./g, "").replace(",", ".");
  return parseFloat(s);
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) throw new Error("TG_TOKEN veya TG_CHAT_ID tanımlı değil");
  
  const api = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  
  // Telegram 4096 karakter limiti
  if (text.length > 4000) {
    text = text.slice(0, 4000) + "\n...kesildi";
  }

  await axios.post(api, {
    chat_id: CHAT_ID,
    text: `<pre>${escapeHtml(text)}</pre>`,
    parse_mode: "HTML",
    disable_web_page_preview: true
  }, { timeout: 15000 });
}

async function getVisibleTickerCount(page) {
  return await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="SignalPage"]');
    const tickers = new Set();
    for (const link of links) {
      const m = link.href.match(/Ticker=([A-Z]+)/i);
      if (m) tickers.add(m[1].toUpperCase());
    }
    return tickers.size;
  });
}

async function autoScroll(page) {
  let stableRounds = 0, lastCount = 0, lastHeight = 0;

  for (let round = 0; round < 30; round++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
      document.querySelectorAll("*").forEach(el => {
        const style = getComputedStyle(el);
        if (/(auto|scroll)/i.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
        }
      });
    });

    await sleep(1500);

    const currentCount = await getVisibleTickerCount(page);
    const { scrollHeight } = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight
    }));

    if (currentCount === lastCount && scrollHeight === lastHeight) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }

    lastCount = currentCount;
    lastHeight = scrollHeight;
    if (stableRounds >= 2) break;
  }
  await sleep(1000);
}

async function extractRows(page) {
  return await page.evaluate(() => {
    const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const getTicker = (href) => {
      const m = String(href || "").match(/Ticker=([A-Z]+)/i);
      return m ? m[1].toUpperCase() : null;
    };

    const rows = [];
    const seen = new Set();
    const trList = document.querySelectorAll("tr");

    for (const tr of trList) {
      const link = tr.querySelector('a[href*="SignalPage"]');
      if (!link) continue;

      const ticker = getTicker(link.href);
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);

      const cells = Array.from(tr.querySelectorAll("td, th")).map(el => clean(el.innerText));
      const nonTicker = cells.filter(c => !c.includes(ticker));

      rows.push({
        ticker,
        alis: nonTicker[0] || "-",
        sonFiyat: nonTicker[1] || "-",
        stoploss: "-",
        yuzde: nonTicker[2] || "-"
      });
    }
    return rows;
  });
}

async function extractDetailLevels(browser, ticker) {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) req.abort();
      else req.continue();
    });

    await page.goto(`${DETAIL_URL}${ticker}`, { 
      waitUntil: "domcontentloaded", 
      timeout: 30000 
    });

    await page.waitForSelector('body', { timeout: 5000 });

    const data = await page.evaluate(() => {
      const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
      const bodyText = clean(document.body.innerText);
      
      const pick = (regexList) => {
        for (const r of regexList) {
          const m = bodyText.match(r);
          if (m?.[1]) return m[1].trim();
        }
        return "-";
      };

      return {
        alSeviyesi: pick([/Al Seviyesi[:\s]*([0-9.,]+)/i, /AL Seviyesi[:\s]*([0-9.,]+)/i]),
        stoploss: pick([/Stoploss[:\s]*([0-9.,]+)/i, /Stop Loss[:\s]*([0-9.,]+)/i])
      };
    });

    return data;
  } catch (e) {
    return { alSeviyesi: "-", stoploss: "-" };
  } finally {
    await page.close();
  }
}

function buildTable(title, rows) {
  let text = `${title}\n\n`;
  text += `${pad("No", 3, true)} ${pad("Hisse", 6)} ${pad("AL", 9, true)} ${pad("STOP", 9, true)} ${pad("Risk%", 6, true)}\n`;
  text += `${pad("---", 3)} ${pad("------", 6)} ${pad("---------", 9)} ${pad("---------", 9)} ${pad("------", 6)}\n`;

  rows.forEach((row, i) => {
    const alis = parseNumber(row.alis);
    const stop = parseNumber(row.stoploss);
    let risk = "-";

    if (!isNaN(alis) && !isNaN(stop) && alis > 0) {
      risk = (((alis - stop) / alis) * 100).toFixed(2);
    }

    text += `${pad(i + 1, 3, true)} ${pad(row.ticker, 6)} ${pad(row.alis, 9, true)} ${pad(row.stoploss, 9, true)} ${pad(risk, 6, true)}\n`;
  });

  text += `\nToplam: ${rows.length}`;
  return text;
}

async function run() {
  console.log("Bot başladı...");
  if (!TOKEN || !CHAT_ID) {
    console.error("HATA: TG_TOKEN ve TG_CHAT_ID tanımlı değil!");
    return;
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(3000);
    await autoScroll(page);

    let rows = await extractRows(page);
    if (!rows.length) {
      await sendTelegram("Bot hatasi:\nListe bos geldi");
      return;
    }

    console.log(`${rows.length} hisse bulundu. Detaylar çekiliyor...`);

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(row => extractDetailLevels(browser, row.ticker))
      );
      
      results.forEach((detail, idx) => {
        const row = batch[idx];
        if (detail.alSeviyesi !== "-") row.alis = detail.alSeviyesi;
        if (detail.stoploss !== "-") row.stoploss = detail.stoploss;
      });

      console.log(`İşlendi: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
      await sleep(500);
    }

    rows = rows.filter(row => {
      const alis = parseNumber(row.alis);
      const stop = parseNumber(row.stoploss);
      if (isNaN(alis) || isNaN(stop)) return false;
      return stop <= alis;
    });

    if (!rows.length) {
      await sendTelegram("Guncel AL listesi\n\nFiltre sonrasi uygun hisse kalmadi.");
      return;
    }

    rows.sort((a, b) => {
      const riskA = parseNumber(a.alis) - parseNumber(a.stoploss);
      const riskB = parseNumber(b.alis) - parseNumber(b.stoploss);
      return riskA - riskB;
    });

    for (let i = 0; i < rows.length; i += MESSAGE_CHUNK) {
      const chunk = rows.slice(i, i + MESSAGE_CHUNK);
      const title = i === 0 ? "Guncel AL listesi" : "Guncel AL listesi (devam)";
      await sendTelegram(buildTable(title, chunk));
      await sleep(1000);
    }

    console.log("Bitti. Toplam gönderilen:", rows.length);

  } catch (err) {
    console.error("Ana hata:", err);
    try {
      await sendTelegram(`Bot hatasi:\n${err.message}`);
    } catch (e) {
      console.error("Telegram hata mesajı gönderilemedi:", e.message);
    }
  } finally {
    await browser.close();
    console.log("Browser kapatıldı.");
  }
}

run();