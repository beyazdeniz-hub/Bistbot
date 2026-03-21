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
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toNumber(text) {
  if (text == null) return null;
  let s = String(text).trim();

  s = s.replace(/\s+/g, "");
  s = s.replace(/[^0-9,.-]/g, "");

  if (!s) return null;

  const commaCount = (s.match(/,/g) || []).length;
  const dotCount = (s.match(/\./g) || []).length;

  if (commaCount > 0 && dotCount > 0) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "");
      s = s.replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (commaCount > 0 && dotCount === 0) {
    s = s.replace(",", ".");
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik.");
  }

  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  await axios.post(url, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function autoScroll(page) {
  let previousHeight = 0;
  let stableCount = 0;

  for (let i = 0; i < 30; i++) {
    const currentHeight = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });

    await sleep(1500);

    if (currentHeight === previousHeight) {
      stableCount++;
    } else {
      stableCount = 0;
    }

    previousHeight = currentHeight;

    if (stableCount >= 3) break;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(800);
}

async function getSignalTickers(page) {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(2500);

  await autoScroll(page);

  const tickers = await page.evaluate(() => {
    const text = document.body.innerText || "";
    const found = text.match(/\b[A-ZÇĞİÖŞÜ]{3,6}\b/g) || [];

    const blacklist = new Set([
      "BIST", "IMKB", "TLM", "USD", "EUR", "TR", "EN",
      "AL", "SAT", "END", "ADET", "RISK"
    ]);

    const filtered = found.filter(x => !blacklist.has(x));

    return [...new Set(filtered)];
  });

  return tickers;
}

async function getDetailData(browser, ticker) {
  const page = await browser.newPage();

  try {
    await page.goto(`${DETAIL_URL}${ticker}`, {
      waitUntil: "networkidle2",
      timeout: 120000
    });

    await sleep(2000);

    const data = await page.evaluate((ticker) => {
      const bodyText = document.body.innerText || "";

      function pickNumberNear(labelList) {
        for (const label of labelList) {
          const regex = new RegExp(label + "\\s*[:\\-]?\\s*([0-9.,]+)", "i");
          const m = bodyText.match(regex);
          if (m && m[1]) return m[1];
        }
        return null;
      }

      const alisText = pickNumberNear([
        "Alış Seviyesi",
        "Alış",
        "Al Seviyesi",
        "Buy Level",
        "Buy"
      ]);

      const stopText = pickNumberNear([
        "Stop",
        "Stop Seviyesi",
        "Stop Loss",
        "Zarar Kes"
      ]);

      const hedefText = pickNumberNear([
        "Hedef",
        "Hedef Fiyat",
        "Target",
        "Target Price"
      ]);

      const riskText = pickNumberNear([
        "Risk",
        "Risk Oranı",
        "Risk Ratio"
      ]);

      return {
        ticker,
        alisText,
        stopText,
        hedefText,
        riskText
      };
    }, ticker);

    return data;
  } catch (err) {
    return {
      ticker,
      error: err.message
    };
  } finally {
    await page.close();
  }
}

function buildRows(rawRows) {
  const rows = [];

  for (const item of rawRows) {
    if (!item || item.error) continue;

    const alis = toNumber(item.alisText);
    const stop = toNumber(item.stopText);
    const hedef = toNumber(item.hedefText);
    let risk = toNumber(item.riskText);

    if (alis == null || stop == null) continue;

    if (stop >= alis) continue;

    if (risk == null) {
      risk = Number((((alis - stop) / alis) * 100).toFixed(2));
    }

    if (risk > 3) continue;

    const karPotansiyeli =
      hedef != null ? Number((((hedef - alis) / alis) * 100).toFixed(2)) : null;

    rows.push({
      ticker: item.ticker,
      alis: Number(alis.toFixed(4)),
      stop: Number(stop.toFixed(4)),
      hedef: hedef != null ? Number(hedef.toFixed(4)) : null,
      risk: Number(risk.toFixed(2)),
      karPotansiyeli
    });
  }

  rows.sort((a, b) => a.risk - b.risk);
  return rows;
}

function buildTelegramMessage(rows) {
  const now = new Date();
  const timeText = now.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });

  if (!rows.length) {
    return escapeHtml(
      `Tarama zamanı: ${timeText}\n\nUygun sinyal bulunamadı.`
    );
  }

  let msg = "";
  msg += `<b>Tarama zamanı:</b> ${escapeHtml(timeText)}\n\n`;
  msg += `<b>Risk <= 3 uygun hisseler</b>\n`;
  msg += `<pre>`;
  msg += `${pad("Hisse", 7)} ${pad("Alış", 10, true)} ${pad("Stop", 10, true)} ${pad("Hedef", 10, true)} ${pad("Risk%", 7, true)} ${pad("Kar%", 7, true)}\n`;
  msg += `${"-".repeat(60)}\n`;

  for (const r of rows) {
    msg += `${pad(r.ticker, 7)} ${pad(r.alis, 10, true)} ${pad(r.stop, 10, true)} ${pad(r.hedef ?? "-", 10, true)} ${pad(r.risk, 7, true)} ${pad(r.karPotansiyeli ?? "-", 7, true)}\n`;
  }

  msg += `</pre>`;
  return msg;
}

async function run() {
  let browser;

  try {
    if (!TOKEN || !CHAT_ID) {
      throw new Error("Secret tanımları eksik. TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID girilmelidir.");
    }

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });

    const tickers = await getSignalTickers(page);

    const uniqueTickers = [...new Set(tickers)].filter(x => /^[A-ZÇĞİÖŞÜ]{3,6}$/.test(x));

    const rawRows = [];
    for (const ticker of uniqueTickers) {
      const detail = await getDetailData(browser, ticker);
      rawRows.push(detail);
      await sleep(800);
    }

    const rows = buildRows(rawRows);
    const message = buildTelegramMessage(rows);

    await sendTelegram(message);

    console.log("Mesaj gönderildi.");
  } catch (err) {
    console.error("Hata:", err.message);

    try {
      await sendTelegram(
        escapeHtml(`Bot hatası:\n${err.message}`)
      );
    } catch (e) {
      console.error("Telegram hata mesajı da gönderilemedi:", e.message);
    }

    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

run();
