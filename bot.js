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
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
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

function saveJson(rows) {
  const payload = {
    updatedAt: new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }),
    signals: rows.map(row => ({
      ticker: row.ticker,
      buy: row.alis,
      stop: row.son,
      riskPct: row.risk.toFixed(2)
    })),
    earlySignals: []
  };

  fs.writeFileSync("signals.json", JSON.stringify(payload, null, 2), "utf8");
  console.log("signals.json oluşturuldu");
}

async function getVisibleTickerCount(page) {
  return await page.evaluate(() => {
    function getTickerFromHref(href) {
      const m = String(href || "").match(/Ticker=([A-Z]+)/i);
      return m ? m[1].toUpperCase() : null;
    }

    const links = Array.from(
      document.querySelectorAll('a[href*="SignalPage"]')
    );

    const tickers = new Set();
    for (const link of links) {
      const ticker = getTickerFromHref(link.getAttribute("href"));
      if (ticker) tickers.add(ticker);
    }

    return tickers.size;
  });
}

async function autoScroll(page) {
  let stableRounds = 0;
  let lastCount = 0;
  let lastHeight = 0;

  for (let round = 0; round < 80; round++) {
    const before = await page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement || document.body;
      return {
        scrollTop: doc.scrollTop,
        scrollHeight: doc.scrollHeight,
        clientHeight: doc.clientHeight
      };
    });

    await page.evaluate(async () => {
      const doc = document.scrollingElement || document.documentElement || document.body;
      const distance = Math.max(500, Math.floor(window.innerHeight * 0.8));
      const steps = 6;

      for (let i = 0; i < steps; i++) {
        window.scrollBy(0, distance);
        doc.scrollTop = doc.scrollTop + distance;

        const allEls = Array.from(document.querySelectorAll("*")).filter(el => {
          const style = window.getComputedStyle(el);
          const canScroll =
            /(auto|scroll)/i.test(style.overflowY) &&
            el.scrollHeight > el.clientHeight + 50;
          return canScroll;
        });

        for (const el of allEls) {
          el.scrollTop = el.scrollHeight;
        }

        await new Promise(resolve => setTimeout(resolve, 700));
      }
    });

    await sleep(2000);

    const currentCount = await getVisibleTickerCount(page);
    const after = await page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement || document.body;
      return {
        scrollTop: doc.scrollTop,
        scrollHeight: doc.scrollHeight,
        clientHeight: doc.clientHeight
      };
    });

    const reachedBottom =
      after.scrollTop + after.clientHeight >= after.scrollHeight - 5;

    const countUnchanged = currentCount === lastCount;
    const heightUnchanged = after.scrollHeight === lastHeight;

    if (countUnchanged && heightUnchanged && reachedBottom) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }

    lastCount = currentCount;
    lastHeight = after.scrollHeight;

    if (stableRounds >= 3) {
      break;
    }

    if (after.scrollTop === before.scrollTop && reachedBottom) {
      stableRounds++;
    }
  }

  await sleep(2000);
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

    function looksNumeric(text) {
      return /^[+\-]?\d[\d.,]*%?$/.test(clean(text));
    }

    const rows = [];
    const trList = Array.from(document.querySelectorAll("tr"))
      .filter(tr => tr.querySelector('a[href*="SignalPage"]'));

    for (const tr of trList) {
      const link = tr.querySelector('a[href*="SignalPage"]');
      const ticker = getTickerFromHref(link?.getAttribute("href"));

      if (!ticker) continue;

      const cells = Array.from(tr.querySelectorAll("td, th"))
        .map(el => clean(el.innerText || el.textContent))
        .filter(Boolean);

      let alis = "-";
      let son = "-";
      let yuzde = "-";

      if (cells.length >= 4) {
        const nonTickerCells = cells.filter(cell => !cell.includes(ticker));

        if (nonTickerCells.length >= 3) {
          alis = nonTickerCells[0] || "-";
          son = nonTickerCells[1] || "-";
          yuzde = nonTickerCells[2] || "-";
        }
      }

      if (alis === "-" && son === "-" && yuzde === "-") {
        const tokens = cells
          .flatMap(cell => cell.split(/\s+/))
          .map(clean)
          .filter(Boolean)
          .filter(token => !token.includes(ticker))
          .filter(token => looksNumeric(token));

        if (tokens.length >= 1) alis = tokens[0];
        if (tokens.length >= 2) son = tokens[1];
        if (tokens.length >= 3) yuzde = tokens[2];
      }

      rows.push({
        ticker,
        alis,
        son,
        yuzde
      });
    }

    const seen = new Set();
    return rows.filter(row => {
      if (seen.has(row.ticker)) return false;
      seen.add(row.ticker);
      return true;
    });
  });
}

async function extractDetailLevels(detailPage, ticker) {
  await detailPage.goto(`${DETAIL_URL}${ticker}`, {
    waitUntil: "networkidle2",
    timeout: 60000
  });

  await sleep(2500);

  return await detailPage.evaluate(() => {
    function clean(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    const bodyText = clean(document.body.innerText || "");

    function pick(regexList) {
      for (const regex of regexList) {
        const m = bodyText.match(regex);
        if (m && m[1]) {
          return m[1].trim();
        }
      }
      return "-";
    }

    const alSeviyesi = pick([
      /Al Seviyesi[:\s]*([0-9.,]+)/i,
      /AL Seviyesi[:\s]*([0-9.,]+)/i
    ]);

    const stoploss = pick([
      /Stoploss[:\s]*([0-9.,]+)/i,
      /Stop Loss[:\s]*([0-9.,]+)/i
    ]);

    return {
      alSeviyesi,
      stoploss
    };
  });
}

function buildTable(title, rows) {
  let text = `${title}\n\n`;
  text += `${pad("No", 3, true)} ${pad("Hisse", 6)} ${pad("Alis", 9, true)} ${pad("STOP", 9, true)} ${pad("Risk%", 6, true)}\n`;
  text += `${pad("---", 3)} ${pad("------", 6)} ${pad("---------", 9)} ${pad("---------", 9)} ${pad("------", 6)}\n`;

  rows.forEach((row, i) => {
    text += `${pad(i + 1, 3, true)} ${pad(row.ticker, 6)} ${pad(row.alis, 9, true)} ${pad(row.son, 9, true)} ${pad(row.risk.toFixed(2), 6, true)}\n`;
  });

  text += `\nToplam: ${rows.length}`;
  return text;
}

function splitRowsForTelegram(title, rows, chunkSize = 25) {
  const messages = [];

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const chunkTitle = i === 0 ? title : `${title} (devam)`;
    messages.push(buildTable(chunkTitle, chunk));
  }

  return messages;
}

async function run() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });

    await page.goto(URL, {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    await sleep(5000);
    await autoScroll(page);
    await sleep(2000);

    const rows = await extractRows(page);

    if (!rows.length) {
      await sendTelegram("Bot hatasi:\nListe bos geldi");
      return;
    }

    const detailPage = await browser.newPage();
    await detailPage.setViewport({ width: 1400, height: 2200 });

    for (const row of rows) {
      try {
        const detail = await extractDetailLevels(detailPage, row.ticker);

        if (detail.alSeviyesi && detail.alSeviyesi !== "-") {
          row.alis = detail.alSeviyesi;
        }

        if (detail.stoploss && detail.stoploss !== "-") {
          row.son = detail.stoploss;
        }
      } catch (e) {}

      await sleep(700);
    }

    await detailPage.close();

    const filtered = rows
      .map(row => {
        const alisNum = toNumber(row.alis);
        const stopNum = toNumber(row.son);

        if (isNaN(alisNum) || isNaN(stopNum) || alisNum <= 0 || stopNum >= alisNum) {
          return null;
        }

        const risk = ((alisNum - stopNum) / alisNum) * 100;

        return {
          ...row,
          risk
        };
      })
      .filter(Boolean)
      .filter(row => row.risk <= 3)
      .sort((a, b) => a.risk - b.risk);

    saveJson(filtered);

    if (!filtered.length) {
      await sendTelegram("Risk <= 3 uygun sinyal bulunamadi");
      return;
    }

    const messages = splitRowsForTelegram("Risk <= 3 Uygun Hisseler", filtered);

    for (const message of messages) {
      await sendTelegram(message);
      await sleep(700);
    }
  } finally {
    await browser.close();
  }
}

run().catch(async err => {
  try {
    await sendTelegram(`Bot hatasi:\n${err.message}`);
  } catch (e) {
    console.log("Telegram hata gonderimi de basarisiz:", e.message);
  }
});