const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const RISK_LIMIT = 5;
const TELEGRAM_CHUNK_SIZE = 25;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function toNumber(value) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const num = parseFloat(normalized);
  return Number.isNaN(num) ? NaN : num;
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TOKEN veya CHAT_ID eksik");
  }

  const api = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  await axios.post(
    api,
    {
      chat_id: CHAT_ID,
      text: `<pre>${escapeHtml(text)}</pre>`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    { timeout: 30000 }
  );
}

function saveJson(rows) {
  const payload = {
    updatedAt: new Date().toLocaleString("tr-TR", {
      timeZone: "Europe/Istanbul",
    }),
    signals: rows.map((row) => ({
      ticker: row.ticker,
      buy: row.alis,
      stop: row.son,
      riskPct: row.risk.toFixed(2),
    })),
    earlySignals: [],
  };

  fs.writeFileSync("signals.json", JSON.stringify(payload, null, 2), "utf8");
  console.log("signals.json oluşturuldu");
}

async function safeGoto(page, url) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await sleep(3500);
}

async function getPageStats(page) {
  return await page.evaluate(() => {
    const doc =
      document.scrollingElement || document.documentElement || document.body;

    function getTickerFromHref(href) {
      const m = String(href || "").match(/Ticker=([A-Z]+)/i);
      return m ? m[1].toUpperCase() : null;
    }

    const links = Array.from(document.querySelectorAll('a[href*="SignalPage"]'));
    const tickers = new Set();

    for (const link of links) {
      const hrefTicker = getTickerFromHref(link.getAttribute("href") || link.href);
      const textTicker = String(link.textContent || "").trim().toUpperCase();

      if (hrefTicker) tickers.add(hrefTicker);
      if (/^[A-Z]{3,6}$/.test(textTicker)) tickers.add(textTicker);
    }

    return {
      scrollTop: doc.scrollTop,
      scrollHeight: doc.scrollHeight,
      clientHeight: doc.clientHeight,
      tickerCount: tickers.size,
    };
  });
}

async function forceScrollContainers(page) {
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("*"));

    for (const el of els) {
      const style = window.getComputedStyle(el);
      const canScroll =
        /(auto|scroll)/i.test(style.overflowY) &&
        el.scrollHeight > el.clientHeight + 40;

      if (canScroll) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });
}

async function doOneScrollRound(page) {
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      const doc =
        document.scrollingElement || document.documentElement || document.body;
      const step = Math.max(700, Math.floor(window.innerHeight * 0.9));
      window.scrollBy(0, step);
      doc.scrollTop = doc.scrollTop + step;
    });

    await forceScrollContainers(page);
    await sleep(900);
  }

  try {
    await page.keyboard.press("End");
    await sleep(1200);
  } catch (e) {}

  await page.evaluate(() => {
    const doc =
      document.scrollingElement || document.documentElement || document.body;
    window.scrollTo(0, doc.scrollHeight);
    doc.scrollTop = doc.scrollHeight;
  });

  await forceScrollContainers(page);
  await sleep(2200);
}

async function autoScroll(page) {
  let stableRounds = 0;
  let lastCount = 0;
  let lastHeight = 0;

  for (let round = 1; round <= 60; round++) {
    const before = await getPageStats(page);

    await doOneScrollRound(page);

    const after = await getPageStats(page);

    const reachedBottom =
      after.scrollTop + after.clientHeight >= after.scrollHeight - 10;
    const countUnchanged = after.tickerCount === lastCount;
    const heightUnchanged = after.scrollHeight === lastHeight;

    console.log(
      `Scroll ${round} | ticker=${after.tickerCount} | top=${after.scrollTop} | height=${after.scrollHeight} | bottom=${reachedBottom}`
    );

    if (countUnchanged && heightUnchanged && reachedBottom) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }

    if (after.tickerCount > lastCount) lastCount = after.tickerCount;
    if (after.scrollHeight > lastHeight) lastHeight = after.scrollHeight;

    if (stableRounds >= 4) {
      console.log("Scroll sabitlendi, çıkılıyor.");
      break;
    }

    if (after.scrollTop === before.scrollTop && reachedBottom) {
      stableRounds++;
    }
  }

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      const doc =
        document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, doc.scrollHeight);
      doc.scrollTop = doc.scrollHeight;
    });
    await forceScrollContainers(page);
    await sleep(1800);
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

    const found = new Map();

    const links = Array.from(document.querySelectorAll('a[href*="SignalPage"]'));

    for (const link of links) {
      const href = link.getAttribute("href") || link.href || "";
      const tickerFromHref = getTickerFromHref(href);
      const tickerFromText = clean(link.innerText || link.textContent).toUpperCase();

      const ticker =
        tickerFromHref ||
        (/^[A-Z]{3,6}$/.test(tickerFromText) ? tickerFromText : null);

      if (!ticker) continue;

      if (!found.has(ticker)) {
        found.set(ticker, {
          ticker,
          alis: "-",
          son: "-",
          yuzde: "-",
        });
      }
    }

    const trList = Array.from(document.querySelectorAll("tr")).filter((tr) =>
      tr.querySelector('a[href*="SignalPage"]')
    );

    for (const tr of trList) {
      const link = tr.querySelector('a[href*="SignalPage"]');
      const ticker = getTickerFromHref(link?.getAttribute("href") || link?.href);

      if (!ticker) continue;

      const cells = Array.from(tr.querySelectorAll("td, th"))
        .map((el) => clean(el.innerText || el.textContent))
        .filter(Boolean);

      let alis = "-";
      let son = "-";
      let yuzde = "-";

      if (cells.length >= 4) {
        const nonTickerCells = cells.filter((cell) => !cell.includes(ticker));

        if (nonTickerCells.length >= 3) {
          alis = nonTickerCells[0] || "-";
          son = nonTickerCells[1] || "-";
          yuzde = nonTickerCells[2] || "-";
        }
      }

      if (alis === "-" && son === "-" && yuzde === "-") {
        const tokens = cells
          .flatMap((cell) => cell.split(/\s+/))
          .map(clean)
          .filter(Boolean)
          .filter((token) => !token.includes(ticker))
          .filter((token) => looksNumeric(token));

        if (tokens.length >= 1) alis = tokens[0];
        if (tokens.length >= 2) son = tokens[1];
        if (tokens.length >= 3) yuzde = tokens[2];
      }

      const prev = found.get(ticker) || {
        ticker,
        alis: "-",
        son: "-",
        yuzde: "-",
      };

      found.set(ticker, {
        ticker,
        alis: prev.alis !== "-" ? prev.alis : alis,
        son: prev.son !== "-" ? prev.son : son,
        yuzde: prev.yuzde !== "-" ? prev.yuzde : yuzde,
      });
    }

    return Array.from(found.values()).sort((a, b) =>
      a.ticker.localeCompare(b.ticker, "tr")
    );
  });
}

async function extractDetailLevels(detailPage, ticker) {
  await safeGoto(detailPage, `${DETAIL_URL}${ticker}`);

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
      /Alış\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Aliş\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Al\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /AL\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Alış[:\s]*([0-9.,]+)/i,
    ]);

    const stoploss = pick([
      /Stoploss[:\s]*([0-9.,]+)/i,
      /Stop\s*Loss[:\s]*([0-9.,]+)/i,
      /Stoploss\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Stop\s*Loss\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Stop\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Stop[:\s]*([0-9.,]+)/i,
    ]);

    return {
      alSeviyesi,
      stoploss,
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

function splitRowsForTelegram(title, rows, chunkSize = TELEGRAM_CHUNK_SIZE) {
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
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });

    await safeGoto(page, URL);
    await autoScroll(page);
    await sleep(2000);

    const rows = await extractRows(page);
    console.log(`Toplanan toplam ticker: ${rows.length}`);

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
      } catch (e) {
        console.log(`Detay okunamadi: ${row.ticker} | ${e.message}`);
      }

      await sleep(700);
    }

    await detailPage.close();

    const filtered = rows
      .map((row) => {
        const alisNum = toNumber(row.alis);
        const stopNum = toNumber(row.son);

        if (
          Number.isNaN(alisNum) ||
          Number.isNaN(stopNum) ||
          alisNum <= 0 ||
          stopNum >= alisNum
        ) {
          return null;
        }

        const risk = ((alisNum - stopNum) / alisNum) * 100;

        return {
          ...row,
          risk,
        };
      })
      .filter(Boolean)
      .filter((row) => row.risk <= RISK_LIMIT)
      .sort((a, b) => a.risk - b.risk);

    saveJson(filtered);

    if (!filtered.length) {
      await sendTelegram(`Risk <= ${RISK_LIMIT} uygun sinyal bulunamadi`);
      return;
    }

    const messages = splitRowsForTelegram(
      `Risk <= ${RISK_LIMIT} Uygun Hisseler`,
      filtered
    );

    for (const message of messages) {
      await sendTelegram(message);
      await sleep(700);
    }
  } finally {
    await browser.close();
  }
}

run().catch(async (err) => {
  try {
    await sendTelegram(`Bot hatasi:\n${err.message}`);
  } catch (e) {
    console.log("Telegram hata gonderimi de basarisiz:", e.message);
  }
});