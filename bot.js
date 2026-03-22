const puppeteer = require("puppeteer");
const axios = require("axios");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const MAX_ROWS = 200;
const MAX_AI_COMMENTS = 8; // maliyet ve sure icin; istersen arttirirsin
const RISK_LIMIT = 3;
const TELEGRAM_MAX_LEN = 3500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toNumber(value) {
  if (value == null) return null;
  const s = String(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(/%/g, "")
    .replace(/\.(?=\d{3}\b)/g, "")
    .replace(",", ".");
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

function fmt(value, digits = 2) {
  const n = typeof value === "number" ? value : toNumber(value);
  return n == null ? "-" : n.toFixed(digits);
}

function formatPct(value, digits = 2) {
  const n = typeof value === "number" ? value : toNumber(value);
  return n == null ? "-" : `%${n.toFixed(digits)}`;
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TOKEN veya CHAT_ID eksik");
  }

  const api = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  await axios.post(api, {
    chat_id: CHAT_ID,
    text: escapeHtml(text),
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendTelegramLong(text) {
  const chunks = [];
  let current = "";

  const parts = String(text).split("\n");
  for (const part of parts) {
    if ((current + part + "\n").length > TELEGRAM_MAX_LEN) {
      if (current.trim()) chunks.push(current.trim());
      current = part + "\n";
    } else {
      current += part + "\n";
    }
  }
  if (current.trim()) chunks.push(current.trim());

  for (const chunk of chunks) {
    await sendTelegram(chunk);
    await sleep(700);
  }
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
      /AL Seviyesi[:\s]*([0-9.,]+)/i,
      /Alış[:\s]*([0-9.,]+)/i
    ]);

    const stoploss = pick([
      /Stoploss[:\s]*([0-9.,]+)/i,
      /Stop Loss[:\s]*([0-9.,]+)/i,
      /Stop[:\s]*([0-9.,]+)/i
    ]);

    const hedef = pick([
      /Hedef[:\s]*([0-9.,]+)/i,
      /Hedef Fiyat[:\s]*([0-9.,]+)/i
    ]);

    const riskText = pick([
      /Risk[:\s]*([0-9.,]+%?)/i
    ]);

    return {
      alSeviyesi,
      stoploss,
      hedef,
      riskText
    };
  });
}

async function click24Months(detailPage) {
  const clicked = await detailPage.evaluate(() => {
    function textOf(el) {
      return (
        el.innerText ||
        el.textContent ||
        el.value ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        ""
      ).replace(/\s+/g, " ").trim();
    }

    const candidates = Array.from(
      document.querySelectorAll("a, button, input[type='button'], input[type='submit'], span, div, li")
    );

    const target = candidates.find(el => {
      const t = textOf(el).toLowerCase();
      return (
        t.includes("24 ay") ||
        t.includes("24ay") ||
        t.includes("24 ayl") ||
        t.includes("24 aylik") ||
        t.includes("24 aylık") ||
        t.includes("24 month")
      );
    });

    if (!target) return false;

    target.click();
    return true;
  });

  if (clicked) {
    await sleep(2500);
  }

  return clicked;
}

async function autoScrollDetail(detailPage) {
  for (let i = 0; i < 20; i++) {
    await detailPage.evaluate(() => {
      window.scrollBy(0, Math.max(window.innerHeight * 0.9, 700));
      const els = Array.from(document.querySelectorAll("*")).filter(el => {
        const style = window.getComputedStyle(el);
        return /(auto|scroll)/i.test(style.overflowY) && el.scrollHeight > el.clientHeight + 50;
      });
      for (const el of els) {
        el.scrollTop = el.scrollHeight;
      }
    });
    await sleep(900);
  }
  await sleep(1500);
}

async function extractSignalHistory(detailPage) {
  await click24Months(detailPage);
  await autoScrollDetail(detailPage);

  return await detailPage.evaluate(() => {
    function clean(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function parseDate(text) {
      const m = String(text).match(/(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/);
      return m ? m[1] : null;
    }

    function parsePct(text) {
      const m = String(text).match(/([+\-]?\d+(?:[.,]\d+)?)\s*%/);
      return m ? m[1].replace(",", ".") : null;
    }

    function parseSignal(text) {
      const t = clean(text).toUpperCase();
      if (/\bAL\b/.test(t)) return "AL";
      if (/\bSAT\b/.test(t)) return "SAT";
      return null;
    }

    const trs = Array.from(document.querySelectorAll("tr"));
    const rows = [];

    for (const tr of trs) {
      const cells = Array.from(tr.querySelectorAll("td, th"))
        .map(el => clean(el.innerText || el.textContent))
        .filter(Boolean);

      if (!cells.length) continue;

      const joined = cells.join(" | ");
      const signal = parseSignal(joined);
      const date = parseDate(joined);

      if (!signal || !date) continue;

      const pct = parsePct(joined);

      rows.push({
        date,
        signal,
        pct,
        cells,
        raw: joined
      });
    }

    const seen = new Set();
    return rows.filter(row => {
      const key = `${row.date}_${row.signal}_${row.raw}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

function enrichAndFilterRows(rows) {
  const out = [];

  for (const row of rows) {
    const alisNum = toNumber(row.alis);
    const stopNum = toNumber(row.son);
    const hedefNum = toNumber(row.hedef);
    let riskNum = toNumber(row.risk);

    if (alisNum == null) continue;
    if (stopNum == null) continue;
    if (stopNum >= alisNum) continue;

    if (riskNum == null) {
      riskNum = ((alisNum - stopNum) / alisNum) * 100;
    }

    if (riskNum > RISK_LIMIT) continue;

    const karNum = hedefNum != null
      ? ((hedefNum - alisNum) / alisNum) * 100
      : null;

    out.push({
      ticker: row.ticker,
      alis: fmt(alisNum),
      stop: fmt(stopNum),
      hedef: hedefNum != null ? fmt(hedefNum) : "-",
      risk: fmt(riskNum),
      kar: karNum != null ? fmt(karNum) : "-",
      riskValue: riskNum,
      karValue: karNum
    });
  }

  out.sort((a, b) => a.riskValue - b.riskValue);
  return out;
}

function summarizeHistory(history) {
  const total = history.length;
  const alRows = history.filter(x => x.signal === "AL");
  const satRows = history.filter(x => x.signal === "SAT");

  const alPctNums = alRows
    .map(x => toNumber(x.pct))
    .filter(x => x != null);

  const posAlPct = alPctNums.filter(x => x > 0);
  const negAlPct = alPctNums.filter(x => x < 0);

  let alternations = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i].signal !== history[i - 1].signal) alternations++;
  }

  const alternationRate =
    history.length >= 2 ? alternations / (history.length - 1) : 0;

  const recent = history.slice(0, 10).map(x =>
    `${x.date} ${x.signal}${x.pct != null ? ` ${x.pct}%` : ""}`
  );

  const rawCompact = history.slice(0, 25).map(x => x.raw);

  return {
    total,
    alCount: alRows.length,
    satCount: satRows.length,
    alPctCount: alPctNums.length,
    avgAlPct: alPctNums.length
      ? (alPctNums.reduce((a, b) => a + b, 0) / alPctNums.length)
      : null,
    maxAlPct: alPctNums.length ? Math.max(...alPctNums) : null,
    minAlPct: alPctNums.length ? Math.min(...alPctNums) : null,
    positiveRate: alPctNums.length ? posAlPct.length / alPctNums.length : null,
    negativeRate: alPctNums.length ? negAlPct.length / alPctNums.length : null,
    alternationRate,
    recent,
    rawCompact
  };
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data?.output)) {
    const parts = [];

    for (const item of data.output) {
      if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && c?.text) {
            parts.push(c.text);
          }
          if (c?.type === "text" && c?.text) {
            parts.push(c.text);
          }
        }
      }
    }

    if (parts.length) return parts.join("\n").trim();
  }

  return "";
}

async function getAICommentForRow(row, history, historySummary) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY eksik");
  }

  const prompt = `
Sen BIST hisseleri icin teknik yorum ureten bir asistansin.

Amac:
- Kullaniciya uzun ama net bir yorum ver.
- Yorum, burada bu sohbette daha once yaptigin tarzda olsun.
- Gereksiz abarti yapma.
- Bilmedigin seyi uydurma.
- Yorumda sunlar olsun:
  1) Gecmis 24 aylik sinyal davranisinin ozeti
  2) Hissenin trend mi yoksa daha cok kisa trade hissesi mi oldugu
  3) Mevcut sinyalin nasil okunmasi gerektigi
  4) Yaklasik hedef / kar-al / risk mantigi
  5) Sonuc cumlesi

Veriler:

Hisse: ${row.ticker}
Alis seviyesi: ${row.alis}
Stop seviyesi: ${row.stop}
Hedef: ${row.hedef}
Risk: %${row.risk}
Potansiyel kar: ${row.kar === "-" ? "bilinmiyor" : "%" + row.kar}

24 ay gecmis sinyal ozetleri:
- Toplam sinyal sayisi: ${historySummary.total}
- AL sayisi: ${historySummary.alCount}
- SAT sayisi: ${historySummary.satCount}
- Yuzde verisi olan AL sayisi: ${historySummary.alPctCount}
- Ortalama AL yuzdesi: ${historySummary.avgAlPct == null ? "-" : historySummary.avgAlPct.toFixed(2) + "%"}
- En iyi AL yuzdesi: ${historySummary.maxAlPct == null ? "-" : historySummary.maxAlPct.toFixed(2) + "%"}
- En kotu AL yuzdesi: ${historySummary.minAlPct == null ? "-" : historySummary.minAlPct.toFixed(2) + "%"}
- Pozitif AL orani: ${historySummary.positiveRate == null ? "-" : (historySummary.positiveRate * 100).toFixed(0) + "%"}
- Negatif AL orani: ${historySummary.negativeRate == null ? "-" : (historySummary.negativeRate * 100).toFixed(0) + "%"}
- AL/SAT sirali degisim orani: ${(historySummary.alternationRate * 100).toFixed(0)}%

Son 10 sinyal ozeti:
${historySummary.recent.map(x => "- " + x).join("\n")}

Ham satirlar (ilk 25):
${historySummary.rawCompact.map(x => "- " + x).join("\n")}

Kurallar:
- Teknik yorum dili kullan ama anlasilir yaz.
- Uzunluk orta-uzun olsun.
- Madde isareti kullanma.
- Metni direkt Telegram'da kullanilacak sekilde yaz.
- Ilk satirda "${row.ticker} yorumu:" diye basla.
`;

  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-5.4",
      input: prompt,
      max_output_tokens: 700
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      timeout: 120000
    }
  );

  const text = extractResponseText(response.data);

  if (!text) {
    throw new Error(`${row.ticker} icin AI yorum donmedi`);
  }

  return text.trim();
}

async function buildCommentMessage(row, history, historySummary) {
  const aiText = await getAICommentForRow(row, history, historySummary);

  return [
    `Tarama zamani: ${new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}`,
    "",
    aiText,
    "",
    `Mevcut seviye ozeti: Alis ${row.alis} | Stop ${row.stop} | Hedef ${row.hedef} | Risk %${row.risk}${row.kar !== "-" ? ` | Kar %${row.kar}` : ""}`,
    `24 ay sinyal ozeti: Toplam ${historySummary.total} | AL ${historySummary.alCount} | SAT ${historySummary.satCount}`
  ].join("\n");
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

    let rows = await extractRows(page);

    if (!rows.length) {
      await sendTelegram("Bot hatasi:\nListe bos geldi");
      return;
    }

    rows = rows.slice(0, MAX_ROWS);

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

        row.hedef = detail.hedef && detail.hedef !== "-" ? detail.hedef : "-";
        row.risk = detail.riskText && detail.riskText !== "-" ? detail.riskText : "-";
      } catch (e) {
        row.hedef = "-";
        row.risk = "-";
      }

      await sleep(700);
    }

    const filteredRows = enrichAndFilterRows(rows);

    if (!filteredRows.length) {
      const scanTime = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
      await sendTelegram(`Tarama zamani: ${scanTime}\n\nRisk <= ${RISK_LIMIT} uygun sinyal bulunamadi.`);
      await detailPage.close();
      return;
    }

    const selectedRows = filteredRows.slice(0, MAX_AI_COMMENTS);

    await sendTelegram(
      `Tarama basladi.\nRisk <= ${RISK_LIMIT} filtreyi gecen ${filteredRows.length} hisse bulundu.\nYorum uretilen hisse sayisi: ${selectedRows.length}`
    );
    await sleep(700);

    for (const row of selectedRows) {
      try {
        await detailPage.goto(`${DETAIL_URL}${row.ticker}`, {
          waitUntil: "networkidle2",
          timeout: 60000
        });

        await sleep(2500);

        const history = await extractSignalHistory(detailPage);
        const historySummary = summarizeHistory(history);

        const msg = await buildCommentMessage(row, history, historySummary);
        await sendTelegramLong(msg);
      } catch (e) {
        await sendTelegram(
          `${row.ticker} yorumu olusturulamadi.\nNeden: ${e.message}`
        );
      }

      await sleep(1200);
    }

    await detailPage.close();
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
