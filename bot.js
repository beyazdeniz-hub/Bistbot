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

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TOKEN veya CHAT_ID eksik");
  }

  const api = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  await axios.post(api, {
    chat_id: CHAT_ID,
    text: `<pre>${escapeHtml(text)}</pre>`,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

function toNumber(value) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const num = parseFloat(normalized);
  return isNaN(num) ? NaN : num;
}

// 🔥 YENİ: JSON KAYDET
function saveJson(rows) {
  const data = {
    updatedAt: new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }),
    signals: rows.map(r => ({
      ticker: r.ticker,
      buy: r.alis,
      stop: r.son,
      riskPct: r.risk ? r.risk.toFixed(2) : "-"
    })),
    earlySignals: []
  };

  fs.writeFileSync("signals.json", JSON.stringify(data, null, 2), "utf8");
  console.log("signals.json oluşturuldu");
}

async function autoScroll(page) {
  let stableRounds = 0;
  let lastCount = 0;
  let lastHeight = 0;

  for (let round = 0; round < 80; round++) {
    await page.evaluate(async () => {
      window.scrollBy(0, window.innerHeight * 0.8);
      await new Promise(r => setTimeout(r, 700));
    });

    await sleep(1500);

    const height = await page.evaluate(() => document.body.scrollHeight);

    if (height === lastHeight) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }

    lastHeight = height;

    if (stableRounds >= 3) break;
  }
}

async function extractRows(page) {
  return await page.evaluate(() => {
    function clean(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function getTickerFromHref(href) {
      const m = String(href || "").match(/Ticker=([A-Z]+)/i);
      return m ? m[1].toUpperCase() : null;
    }

    const rows = [];
    const trs = Array.from(document.querySelectorAll("tr"))
      .filter(tr => tr.querySelector('a[href*="SignalPage"]'));

    for (const tr of trs) {
      const link = tr.querySelector('a[href*="SignalPage"]');
      const ticker = getTickerFromHref(link?.getAttribute("href"));

      if (!ticker) continue;

      const cells = Array.from(tr.querySelectorAll("td"))
        .map(td => clean(td.innerText))
        .filter(Boolean);

      let alis = cells[1] || "-";
      let son = cells[2] || "-";

      rows.push({ ticker, alis, son });
    }

    return rows;
  });
}

async function extractDetailLevels(page, ticker) {
  await page.goto(`${DETAIL_URL}${ticker}`, {
    waitUntil: "networkidle2",
    timeout: 60000
  });

  await sleep(2000);

  return await page.evaluate(() => {
    const text = document.body.innerText;

    function pick(regex) {
      const m = text.match(regex);
      return m ? m[1] : "-";
    }

    return {
      al: pick(/Al Seviyesi[:\s]*([0-9.,]+)/i),
      stop: pick(/Stop.*?:\s*([0-9.,]+)/i)
    };
  });
}

function buildTable(title, rows) {
  let text = `${title}\n\n`;
  text += `${pad("No", 3, true)} ${pad("Hisse", 6)} ${pad("Alis", 9, true)} ${pad("STOP", 9, true)} ${pad("Risk%", 6, true)}\n`;

  rows.forEach((row, i) => {
    const risk = row.risk ? row.risk.toFixed(2) : "-";

    text += `${pad(i + 1, 3, true)} ${pad(row.ticker, 6)} ${pad(row.alis, 9, true)} ${pad(row.son, 9, true)} ${pad(risk, 6, true)}\n`;
  });

  text += `\nToplam: ${rows.length}`;
  return text;
}

async function run() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const page = await browser.newPage();

    await page.goto(URL, { waitUntil: "networkidle2" });
    await sleep(4000);

    await autoScroll(page);

    const rows = await extractRows(page);

    const detailPage = await browser.newPage();

    for (const row of rows) {
      const detail = await extractDetailLevels(detailPage, row.ticker);

      if (detail.al !== "-") row.alis = detail.al;
      if (detail.stop !== "-") row.son = detail.stop;

      await sleep(500);
    }

    await detailPage.close();

    const filtered = rows
      .map(r => {
        const al = toNumber(r.alis);
        const st = toNumber(r.son);

        let risk = null;
        if (!isNaN(al) && !isNaN(st) && st < al) {
          risk = ((al - st) / al) * 100;
        }

        return { ...r, risk };
      })
      .filter(r => r.risk !== null && r.risk <= 3)
      .sort((a, b) => a.risk - b.risk);

    // 🔥 JSON KAYDET
    saveJson(filtered);

    if (!filtered.length) {
      await sendTelegram("Risk <= 3 uygun sinyal bulunamadi");
      return;
    }

    const message = buildTable("Risk <= 3 Uygun Hisseler", filtered);
    await sendTelegram(message);

  } finally {
    await browser.close();
  }
}

run();
