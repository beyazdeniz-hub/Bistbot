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

function toNumber(text) {
  if (!text) return null;
  let s = text.replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  });
}

async function autoScroll(page) {
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1000);
  }
}

async function getTickers(page) {
  await page.goto(URL, { waitUntil: "networkidle2" });
  await sleep(2000);

  await autoScroll(page);

  const tickers = await page.evaluate(() => {
    const text = document.body.innerText;
    const matches = text.match(/\b[A-Z]{3,6}\b/g) || [];
    return [...new Set(matches)];
  });

  return tickers;
}

async function getDetail(browser, ticker) {
  const page = await browser.newPage();

  try {
    await page.goto(`${DETAIL_URL}${ticker}`, { waitUntil: "networkidle2" });
    await sleep(1500);

    const data = await page.evaluate(() => {
      const text = document.body.innerText;

      function find(label) {
        const regex = new RegExp(label + "\\s*[:\\-]?\\s*([0-9.,]+)", "i");
        const m = text.match(regex);
        return m ? m[1] : null;
      }

      return {
        alisText: find("Alış"),
        stopText: find("Stop"),
        hedefText: find("Hedef"),
        riskText: find("Risk")
      };
    });

    return { ticker, ...data };

  } catch (e) {
    return { ticker, error: e.message };
  } finally {
    await page.close();
  }
}

function buildRows(raw) {
  const rows = [];

  for (const r of raw) {
    if (!r || r.error) continue;

    const alis = toNumber(r.alisText);
    const stop = toNumber(r.stopText);
    const hedef = toNumber(r.hedefText);
    let risk = toNumber(r.riskText);

    if (alis == null) continue;

    // stop yoksa yine listeye al (test için)
    if (stop == null) {
      rows.push({
        ticker: r.ticker,
        alis,
        stop: "-",
        hedef: hedef ?? "-",
        risk: "-",
        kar: "-"
      });
      continue;
    }

    if (stop >= alis) continue;

    if (risk == null) {
      risk = ((alis - stop) / alis) * 100;
    }

    const kar = hedef ? ((hedef - alis) / alis) * 100 : null;

    rows.push({
      ticker: r.ticker,
      alis,
      stop,
      hedef: hedef ?? "-",
      risk: risk.toFixed(2),
      kar: kar ? kar.toFixed(2) : "-"
    });
  }

  return rows;
}

function buildTelegramMessage(rows) {
  const now = new Date();
  const time = now.toLocaleString("tr-TR");

  if (!rows.length) {
    return `Tarama zamanı: ${time}\n\nUygun sinyal bulunamadı.`;
  }

  let msg = `Tarama zamanı: ${time}\n\n`;
  msg += `<pre>`;
  msg += `Hisse   Alış     Stop     Hedef    Risk   Kar\n`;
  msg += `------------------------------------------------\n`;

  for (const r of rows.slice(0, 20)) {
    msg += `${pad(r.ticker,6)} ${pad(r.alis,8,true)} ${pad(r.stop,8,true)} ${pad(r.hedef,8,true)} ${pad(r.risk,6,true)} ${pad(r.kar,6,true)}\n`;
  }

  msg += `</pre>`;
  return msg;
}

async function run() {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox"]
    });

    const page = await browser.newPage();

    const tickers = await getTickers(page);

    console.log("Ticker sayısı:", tickers.length);

    const raw = [];
    for (const t of tickers.slice(0, 20)) {
      const d = await getDetail(browser, t);
      raw.push(d);
    }

    console.log("Ham veri:", JSON.stringify(raw.slice(0,5), null, 2));

    const rows = buildRows(raw);

    console.log("Filtre sonrası:", rows.length);

    const message = buildTelegramMessage(rows);
    await sendTelegram(message);

    console.log("Bitti");

  } catch (e) {
    console.error("Hata:", e.message);
  } finally {
    if (browser) await browser.close();
  }
}

run();
