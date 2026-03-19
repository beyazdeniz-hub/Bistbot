const puppeteer = require("puppeteer");
const axios = require("axios");

const TOKEN = "BURAYA_TELEGRAM_BOT_TOKEN";
const CHAT_ID = "BURAYA_CHAT_ID";

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

function toNumber(value) {
  if (value == null) return null;
  const cleaned = String(value)
    .replace(/\s/g, "")
    .replace("%", "")
    .replace(/\./g, "")
    .replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  });
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let lastHeight = 0;
      let sameCount = 0;

      const timer = setInterval(() => {
        window.scrollBy(0, 500);
        const newHeight = document.body.scrollHeight;

        if (newHeight === lastHeight) {
          sameCount++;
        } else {
          sameCount = 0;
          lastHeight = newHeight;
        }

        if (sameCount >= 8) {
          clearInterval(timer);
          resolve();
        }
      }, 400);
    });
  });
}

async function extractSignalStocks(page) {
  const rows = await page.evaluate(() => {
    const allRows = Array.from(document.querySelectorAll("tr"));
    return allRows.map((row) => {
      const cells = Array.from(row.querySelectorAll("td")).map(td =>
        td.innerText.replace(/\s+/g, " ").trim()
      );
      return cells;
    }).filter(r => r.length > 0);
  });

  console.log("Bulunan toplam satır:", rows.length);

  const stocks = [];
  const seen = new Set();

  for (const row of rows) {
    const joined = row.join(" | ").toUpperCase();

    const hasBuySignal =
      joined.includes(" AL ") ||
      joined.startsWith("AL ") ||
      joined.endsWith(" AL") ||
      joined.includes("|AL|") ||
      joined.includes(" AL|") ||
      joined.includes("| AL") ||
      joined.includes("ALIŞ") ||
      joined.includes("AL SİNYAL");

    if (!hasBuySignal) continue;

    for (const cell of row) {
      const m = cell.match(/^[A-ZÇĞİÖŞÜ]{3,6}$/);
      if (m) {
        const code = m[0].trim();
        if (!seen.has(code)) {
          seen.add(code);
          stocks.push(code);
        }
        break;
      }
    }
  }

  console.log("AL sinyalli hisseler:", stocks);
  return stocks;
}

async function extractDetail(page, stock) {
  const bodyText = await page.evaluate(() =>
    document.body.innerText.replace(/\s+/g, " ").trim()
  );

  console.log(`${stock} detay uzunluğu:`, bodyText.length);

  const patternsAl = [
    /Al\s*[:=]\s*([0-9.,]+)/i,
    /Alış\s*[:=]\s*([0-9.,]+)/i,
    /Buy\s*[:=]\s*([0-9.,]+)/i
  ];

  const patternsStop = [
    /Stop\s*[:=]\s*([0-9.,]+)/i,
    /Zarar\s*Kes\s*[:=]\s*([0-9.,]+)/i,
    /Stoploss\s*[:=]\s*([0-9.,]+)/i
  ];

  let al = null;
  let stop = null;

  for (const p of patternsAl) {
    const m = bodyText.match(p);
    if (m) {
      al = toNumber(m[1]);
      if (al != null) break;
    }
  }

  for (const p of patternsStop) {
    const m = bodyText.match(p);
    if (m) {
      stop = toNumber(m[1]);
      if (stop != null) break;
    }
  }

  return { al, stop, raw: bodyText.slice(0, 1000) };
}

async function runBot() {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });

    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await sleep(4000);
    await autoScroll(page);
    await sleep(3000);

    const stocks = await extractSignalStocks(page);

    if (!stocks.length) {
      await sendTelegram("<b>📊 Sinyal Listesi</b>\n\nHiç AL sinyali okunamadı.");
      await browser.close();
      return;
    }

    const results = [];

    for (const stock of stocks) {
      try {
        const detailPage = await browser.newPage();
        await detailPage.setViewport({ width: 1400, height: 2200 });
        await detailPage.goto(DETAIL_URL + stock, {
          waitUntil: "domcontentloaded",
          timeout: 90000
        });
        await sleep(2500);

        const detail = await extractDetail(detailPage, stock);
        await detailPage.close();

        console.log(stock, detail);

        if (detail.al == null || detail.stop == null) continue;
        if (detail.stop >= detail.al) continue;

        const risk = ((detail.al - detail.stop) / detail.al) * 100;
        if (risk >= 3) continue;

        results.push({
          stock,
          al: detail.al,
          stop: detail.stop,
          risk: risk
        });
      } catch (err) {
        console.log("Detay hatası:", stock, err.message);
      }
    }

    results.sort((a, b) => a.risk - b.risk);

    let message = "<b>📊 Sinyal Listesi</b>\n\n";

    if (results.length === 0) {
      message += "Filtreye uygun sinyal bulunamadı.";
    } else {
      for (const r of results) {
        message += `${pad(r.stock, 8)} | AL: ${r.al} | STOP: ${r.stop} | Risk: %${r.risk.toFixed(2)}\n`;
      }
    }

    await sendTelegram(message);
    await browser.close();
  } catch (err) {
    console.log("Genel hata:", err);
    if (browser) await browser.close();
    await sendTelegram(`<b>Bot hata verdi</b>\n\n${String(err.message || err)}`);
  }
}

runBot();
