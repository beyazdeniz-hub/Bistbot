const puppeteer = require("puppeteer");
const axios = require("axios");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const TEST_MODE = true;

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

function parseNumber(value) {
  if (value === null || value === undefined) return NaN;

  const raw = String(value).trim();
  if (!raw) return NaN;

  if (raw.includes(",") && raw.includes(".")) {
    return parseFloat(raw.replace(/\./g, "").replace(",", "."));
  }

  if (raw.includes(",")) {
    return parseFloat(raw.replace(",", "."));
  }

  return parseFloat(raw);
}

function calculateRisk(row) {
  const alis = parseNumber(row.alis);
  const stop = parseNumber(row.son);

  if (isNaN(alis) || isNaN(stop) || alis === 0) return NaN;
  return ((alis - stop) / alis) * 100;
}

function calculateScore(row) {
  const risk = calculateRisk(row);
  if (isNaN(risk)) return 0;

  let score = 0;

  if (risk <= 1) score = 100;
  else if (risk <= 1.5) score = 90;
  else if (risk <= 2) score = 75;
  else if (risk <= 2.5) score = 60;
  else if (risk <= 3) score = 45;
  else score = 0;

  return score;
}

function applyRiskFilterAndSort(rows) {
  return rows
    .map(row => {
      const risk = calculateRisk(row);
      const score = calculateScore(row);

      return {
        ...row,
        riskValue: risk,
        score
      };
    })
    .filter(row => {
      const alis = parseNumber(row.alis);
      const stop = parseNumber(row.son);

      if (isNaN(alis) || isNaN(stop)) return false;
      if (alis <= 0) return false;
      if (stop > alis) return false;
      if (isNaN(row.riskValue)) return false;
      if (row.riskValue < 0) return false;
      if (row.riskValue > 3) return false;

      return true;
    })
    .sort((a, b) => {
      if (a.riskValue !== b.riskValue) {
        return a.riskValue - b.riskValue;
      }
      return b.score - a.score;
    });
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
  text += `${pad("No", 3, true)} ${pad("Hisse", 6)} ${pad("Alis", 9, true)} ${pad("STOP", 9, true)} ${pad("Risk%", 6, true)} ${pad("Skor", 5, true)}\n`;
  text += `${pad("---", 3)} ${pad("------", 6)} ${pad("---------", 9)} ${pad("---------", 9)} ${pad("------", 6)} ${pad("-----", 5)}\n`;

  rows.forEach((row, i) => {
    let riskText = "-";
    const risk = calculateRisk(row);

    if (!isNaN(risk)) {
      riskText = risk.toFixed(2);
    }

    const scoreText = row.score !== undefined ? String(row.score) : "-";

    text += `${pad(i + 1, 3, true)} ${pad(row.ticker, 6)} ${pad(row.alis, 9, true)} ${pad(row.son, 9, true)} ${pad(riskText, 6, true)} ${pad(scoreText, 5, true)}\n`;
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
      if (TEST_MODE) {
        console.log("Bot hatasi: Liste bos geldi");
      } else {
        await sendTelegram("Bot hatasi:\nListe bos geldi");
      }
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

    const filteredRows = applyRiskFilterAndSort(rows);

    if (!filteredRows.length) {
      if (TEST_MODE) {
        console.log("\nFiltre sonrasi uygun hisse kalmadi.\n");
      } else {
        await sendTelegram("Guncel AL listesi\n\nFiltre sonrasi uygun hisse kalmadi.");
      }
      return;
    }

    const messages = splitRowsForTelegram("Guncel AL listesi", filteredRows);

    for (const message of messages) {
      if (TEST_MODE) {
        console.log("\n=== TEST MESAJ ===\n");
        console.log(message);
      } else {
        await sendTelegram(message);
        await sleep(700);
      }
    }
  } finally {
    await browser.close();
  }
}

run().catch(async err => {
  try {
    if (TEST_MODE) {
      console.log("Bot hatasi:", err.message);
    } else {
      await sendTelegram(`Bot hatasi:\n${err.message}`);
    }
  } catch (e) {
    console.log("Telegram hata gonderimi de basarisiz:", e.message);
  }
});
