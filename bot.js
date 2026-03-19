const puppeteer = require("puppeteer");
const axios = require("axios");

const TOKEN = "8775847619:AAGT8RrKMOLWV1YYuakcc6zAXLWIgaitias";
const CHAT_ID = "-1003675682598";

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

// Risk filtresi: sadece bu değerin altındaki/eşit hisseler gönderilir
const MAX_RISK_PERCENT = 8.00;

// Çok düşük riskli hisseler için işaret
const FIRSAT_RISK_PERCENT = 3.00;

// Telegram mesaj bölme
const CHUNK_SIZE_MAIN = 20;
const CHUNK_SIZE_EARLY = 20;

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
  if (value == null) return NaN;

  let s = String(value).trim();

  s = s.replace(/\s+/g, "");
  s = s.replace(/%/g, "");

  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }

  return parseFloat(s);
}

function formatRisk(row) {
  const alis = parseNumber(row.alis);
  const stop = parseNumber(row.son);

  if (!isNaN(alis) && !isNaN(stop) && alis > 0) {
    return ((alis - stop) / alis) * 100;
  }

  return NaN;
}

function getSignalTag(risk) {
  if (isNaN(risk)) return "-";
  if (risk <= FIRSAT_RISK_PERCENT) return "FIRSAT";
  return "";
}

function getScanTimeText() {
  const now = new Date();

  const tarih = now.toLocaleDateString("tr-TR");
  const saat = now.toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  return `Tarama: ${tarih} ${saat}`;
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

    const links = Array.from(document.querySelectorAll('a[href*="SignalPage"]'));
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

async function extractRows(page, sourceLabel = "AL") {
  return await page.evaluate((sourceLabel) => {
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
        yuzde,
        source: sourceLabel
      });
    }

    const seen = new Set();
    return rows.filter(row => {
      if (seen.has(row.ticker)) return false;
      seen.add(row.ticker);
      return true;
    });
  }, sourceLabel);
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
      /Stop Loss[:\s]*([0-9.,]+)/i,
      /STOPLOSS[:\s]*([0-9.,]+)/i
    ]);

    return {
      alSeviyesi,
      stoploss
    };
  });
}

async function enrichRowsWithDetails(detailPage, rows) {
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
      // detay okunamazsa mevcut değerler kalsın
    }

    await sleep(700);
  }
}

function applyRiskFilter(rows) {
  return rows
    .map(row => {
      const alis = parseNumber(row.alis);
      const stop = parseNumber(row.son);

      if (isNaN(alis) || isNaN(stop) || alis <= 0) {
        return null;
      }

      // Stop alıştan büyük veya eşitse ele
      if (stop >= alis) {
        return null;
      }

      const risk = ((alis - stop) / alis) * 100;

      // Negatif / geçersiz risk ele
      if (isNaN(risk) || risk < 0) {
        return null;
      }

      // Risk filtresi
      if (risk > MAX_RISK_PERCENT) {
        return null;
      }

      return {
        ...row,
        risk,
        signalTag: getSignalTag(risk)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.risk - b.risk);
}

function buildTable(title, rows, totalBeforeFilter = null) {
  let text = `${title}\n`;
  text += `${getScanTimeText()}\n`;
  text += `Risk filtresi: <= ${MAX_RISK_PERCENT.toFixed(2)}%\n`;
  text += `FIRSAT: <= ${FIRSAT_RISK_PERCENT.toFixed(2)}%\n\n`;

  text += `${pad("No", 3, true)} ${pad("Hisse", 6)} ${pad("Alis", 9, true)} ${pad("STOP", 9, true)} ${pad("Risk%", 7, true)} ${pad("Not", 8)}\n`;
  text += `${pad("---", 3)} ${pad("------", 6)} ${pad("---------", 9)} ${pad("---------", 9)} ${pad("-------", 7)} ${pad("--------", 8)}\n`;

  rows.forEach((row, i) => {
    const risk = row.risk ?? NaN;
    const riskText = isNaN(risk) ? "-" : risk.toFixed(2);
    const noteText = row.signalTag || "";

    text += `${pad(i + 1, 3, true)} ${pad(row.ticker, 6)} ${pad(row.alis, 9, true)} ${pad(row.son, 9, true)} ${pad(riskText, 7, true)} ${pad(noteText, 8)}\n`;
  });

  text += `\nToplam: ${rows.length}`;
  if (totalBeforeFilter !== null) {
    text += `\nFiltre oncesi: ${totalBeforeFilter}`;
  }

  return text;
}

function splitRowsForTelegram(title, rows, chunkSize = 20, totalBeforeFilter = null) {
  const messages = [];

  if (!rows.length) {
    messages.push(
      `${title}\n${getScanTimeText()}\nRisk filtresi: <= ${MAX_RISK_PERCENT.toFixed(2)}%\nFIRSAT: <= ${FIRSAT_RISK_PERCENT.toFixed(2)}%\n\nUygun hisse bulunamadi.\nFiltre oncesi: ${totalBeforeFilter ?? 0}`
    );
    return messages;
  }

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const chunkTitle = i === 0 ? title : `${title} (devam)`;
    const totalInfo = i === 0 ? totalBeforeFilter : null;
    messages.push(buildTable(chunkTitle, chunk, totalInfo));
  }

  return messages;
}

async function openOversoldTab(page) {
  const clicked = await page.evaluate(() => {
    function normalize(text) {
      return String(text || "")
        .toLowerCase()
        .replace(/ı/g, "i")
        .replace(/ş/g, "s")
        .replace(/ğ/g, "g")
        .replace(/ü/g, "u")
        .replace(/ö/g, "o")
        .replace(/ç/g, "c")
        .trim();
    }

    const candidates = Array.from(document.querySelectorAll("a, button, span, td, li, div"))
      .filter(el => {
        const text = normalize(el.innerText || el.textContent || "");
        return text.includes("asiri satim") || text.includes("asiri satimlar") || text === "asiri satim";
      });

    for (const el of candidates) {
      try {
        el.scrollIntoView({ behavior: "instant", block: "center" });
        el.click();
        return true;
      } catch (e) {}
    }

    return false;
  });

  if (!clicked) {
    return false;
  }

  await sleep(4000);
  await autoScroll(page);
  await sleep(2000);
  return true;
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

    // 1) Normal AL listesi
    await autoScroll(page);
    await sleep(2000);

    const mainRowsRaw = await extractRows(page, "AL");

    if (!mainRowsRaw.length) {
      await sendTelegram(`Bot hatasi:\n${getScanTimeText()}\nListe bos geldi`);
      return;
    }

    const detailPage = await browser.newPage();
    await detailPage.setViewport({ width: 1400, height: 2200 });

    await enrichRowsWithDetails(detailPage, mainRowsRaw);

    const mainRowsFiltered = applyRiskFilter(mainRowsRaw);

    // 2) Aşırı satım sekmesi
    let oversoldRowsRaw = [];
    let oversoldRowsFiltered = [];

    try {
      const oversoldOpened = await openOversoldTab(page);

      if (oversoldOpened) {
        oversoldRowsRaw = await extractRows(page, "ERKEN");
        await enrichRowsWithDetails(detailPage, oversoldRowsRaw);
        oversoldRowsFiltered = applyRiskFilter(oversoldRowsRaw);
      }
    } catch (e) {
      // Aşırı satım kısmı alınamazsa ana liste yine gönderilsin
    }

    await detailPage.close();

    const allMessages = [
      ...splitRowsForTelegram(
        "Guncel AL listesi",
        mainRowsFiltered,
        CHUNK_SIZE_MAIN,
        mainRowsRaw.length
      ),
      ...splitRowsForTelegram(
        "Erken Alim Sinyali (Asiri Satim)",
        oversoldRowsFiltered,
        CHUNK_SIZE_EARLY,
        oversoldRowsRaw.length
      )
    ];

    for (const message of allMessages) {
      await sendTelegram(message);
      await sleep(700);
    }
  } finally {
    await browser.close();
  }
}

run().catch(async err => {
  try {
    await sendTelegram(`Bot hatasi:\n${getScanTimeText()}\n${err.message}`);
  } catch (e) {
    console.log("Telegram hata gonderimi de basarisiz:", e.message);
  }
});
