const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MODE = (process.env.BOT_MODE || "intraday").trim().toLowerCase();
// intraday | approved

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const TELEGRAM_CHUNK_SIZE = 25;
const MAX_ROWS = 400;
const RISK_LIMIT = 3;

const APPROVED_FILE = "approved_signals.json";
const INTRADAY_FILE = "intraday_signals.json";
const STATE_FILE = "bot_state.json";
const LAST_SIGNALS_FILE = "last_signals.json";

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
  if (value === null || value === undefined) return NaN;

  let str = String(value).trim();
  if (!str) return NaN;

  str = str
    .replace(/\s+/g, "")
    .replace(/₺/g, "")
    .replace(/TL/gi, "")
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.-]/g, "");

  const num = Number(str);
  return Number.isFinite(num) ? num : NaN;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(digits).replace(".", ",");
}

function formatPercent(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(digits).replace(".", ",") + "%";
}

function getNow() {
  return new Date();
}

function getLocalDateTimeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  return {
    day: map.day,
    month: map.month,
    year: map.year,
    hour: map.hour,
    minute: map.minute,
    second: map.second
  };
}

function getLocalTimeString(date = new Date()) {
  const p = getLocalDateTimeParts(date);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

function getLocalDateString(date = new Date()) {
  const p = getLocalDateTimeParts(date);
  return `${p.day}.${p.month}.${p.year}`;
}

function getLocalHourMinute(date = new Date()) {
  const p = getLocalDateTimeParts(date);
  return `${p.hour}:${p.minute}`;
}

function readJsonFile(path, fallback) {
  try {
    if (!fs.existsSync(path)) return fallback;
    const raw = fs.readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`${path} okunamadı, varsayılan kullanılacak:`, err.message);
    return fallback;
  }
}

function writeJsonFile(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

async function sendTelegramMessage(message) {
  if (!TOKEN || !CHAT_ID) {
    console.log("Telegram bilgileri eksik, mesaj atlanıyor.");
    return;
  }

  const tgUrl = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  await axios.post(tgUrl, {
    chat_id: CHAT_ID,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

function normalizeTicker(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-ZÇĞİÖŞÜ]/g, "");
}

async function extractTickersFromPage(page) {
  const tickers = await page.evaluate(() => {
    const result = new Set();

    const blacklist = new Set([
      "IMKB",
      "BIST",
      "BORSA",
      "TURKISH",
      "BULLS",
      "AL",
      "SAT",
      "TR",
      "EN",
      "HOME",
      "PAGE",
      "SIGNAL",
      "LIST",
      "SINYAL",
      "SAYFA",
      "FX",
      "AY",
      "BOGA",
      "AYI"
    ]);

    const addTicker = (value) => {
      const t = String(value || "").trim().toUpperCase();
      if (/^[A-ZÇĞİÖŞÜ]{2,6}$/.test(t) && !blacklist.has(t)) {
        result.add(t);
      }
    };

    const links = Array.from(document.querySelectorAll("a"));
    for (const a of links) {
      const txt = (a.textContent || a.innerText || "").trim().toUpperCase();
      addTicker(txt);

      const href = a.href || "";
      const m = href.match(/Ticker=([A-ZÇĞİÖŞÜ]{2,10})/i);
      if (m && m[1]) {
        addTicker(m[1]);
      }
    }

    const text = document.body.innerText || "";
    const matches = text.match(/\b[A-ZÇĞİÖŞÜ]{2,6}\b/g) || [];
    for (const m of matches) {
      addTicker(m);
    }

    return Array.from(result);
  });

  return [...new Set(tickers.map(normalizeTicker).filter((x) => /^[A-ZÇĞİÖŞÜ]{2,6}$/.test(x)))];
}

async function autoScrollToBottom(page) {
  let sameCountRounds = 0;
  let lastTickerCount = 0;
  let lastHeight = 0;

  for (let round = 0; round < 80; round++) {
    const pageInfo = await page.evaluate(() => {
      return {
        innerHeight: window.innerHeight,
        scrollY: window.scrollY,
        scrollHeight: document.body.scrollHeight
      };
    });

    const step = Math.max(700, Math.floor(pageInfo.innerHeight * 0.9));
    const targetY = Math.min(
      pageInfo.scrollY + step,
      Math.max(0, pageInfo.scrollHeight - pageInfo.innerHeight)
    );

    await page.evaluate((y) => {
      window.scrollTo({ top: y, behavior: "instant" });
    }, targetY);

    await sleep(900);

    const tickersNow = await extractTickersFromPage(page);
    const afterInfo = await page.evaluate(() => {
      return {
        scrollY: window.scrollY,
        innerHeight: window.innerHeight,
        scrollHeight: document.body.scrollHeight
      };
    });

    const atBottom =
      afterInfo.scrollY + afterInfo.innerHeight >= afterInfo.scrollHeight - 20;

    const noGrowth =
      tickersNow.length === lastTickerCount &&
      afterInfo.scrollHeight === lastHeight;

    if (noGrowth) {
      sameCountRounds++;
    } else {
      sameCountRounds = 0;
    }

    lastTickerCount = tickersNow.length;
    lastHeight = afterInfo.scrollHeight;

    console.log(
      `Scroll turu ${round + 1} | ticker=${tickersNow.length} | y=${afterInfo.scrollY} | h=${afterInfo.scrollHeight} | bottom=${atBottom}`
    );

    if (atBottom) {
      await sleep(1800);

      const finalTickers = await extractTickersFromPage(page);
      const finalInfo = await page.evaluate(() => {
        return {
          scrollY: window.scrollY,
          innerHeight: window.innerHeight,
          scrollHeight: document.body.scrollHeight
        };
      });

      const stillBottom =
        finalInfo.scrollY + finalInfo.innerHeight >= finalInfo.scrollHeight - 20;

      if (stillBottom && finalTickers.length === lastTickerCount) {
        console.log("Sayfa sonuna ulaşıldı.");
        break;
      }
    }

    if (sameCountRounds >= 6) {
      console.log("Yeni ticker gelmiyor, scroll sonlandırıldı.");
      break;
    }
  }

  await sleep(1000);
}

async function getTickersFromList(page) {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(4000);

  await autoScrollToBottom(page);

  const tickers = await extractTickersFromPage(page);

  console.log("Toplanan toplam ticker:", tickers.length);

  return tickers.slice(0, MAX_ROWS);
}

async function getDetailData(page, ticker) {
  const url = `${DETAIL_URL}${encodeURIComponent(ticker)}`;

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });
    await sleep(1800);

    const text = await page.evaluate(() => {
      return (document.body.innerText || "")
        .replace(/\r/g, "\n")
        .replace(/\t/g, " ")
        .replace(/[ ]+/g, " ");
    });

    let alis = NaN;
    let stop = NaN;
    let hedef = NaN;

    const alisPatterns = [
      /Alış Seviyesi[:\s]*([0-9.,]+)/i,
      /Alis Seviyesi[:\s]*([0-9.,]+)/i,
      /Alış[:\s]*([0-9.,]+)/i,
      /Alis[:\s]*([0-9.,]+)/i
    ];

    const stopPatterns = [
      /Stop Seviyesi[:\s]*([0-9.,]+)/i,
      /Stop[:\s]*([0-9.,]+)/i
    ];

    const hedefPatterns = [
      /Hedef Fiyat[:\s]*([0-9.,]+)/i,
      /Hedef[:\s]*([0-9.,]+)/i,
      /Direnç[:\s]*([0-9.,]+)/i
    ];

    for (const p of alisPatterns) {
      const m = text.match(p);
      if (m?.[1]) {
        alis = toNumber(m[1]);
        if (Number.isFinite(alis)) break;
      }
    }

    for (const p of stopPatterns) {
      const m = text.match(p);
      if (m?.[1]) {
        stop = toNumber(m[1]);
        if (Number.isFinite(stop)) break;
      }
    }

    for (const p of hedefPatterns) {
      const m = text.match(p);
      if (m?.[1]) {
        hedef = toNumber(m[1]);
        if (Number.isFinite(hedef)) break;
      }
    }

    if (!Number.isFinite(alis) || !Number.isFinite(stop)) {
      const nums = [...text.matchAll(/\b\d{1,4}[.,]\d{1,4}\b/g)]
        .map((x) => x[0])
        .map(toNumber)
        .filter(Number.isFinite);

      if (!Number.isFinite(alis) && nums.length >= 1) alis = nums[0];
      if (!Number.isFinite(stop) && nums.length >= 2) stop = nums[1];
      if (!Number.isFinite(hedef) && nums.length >= 3) hedef = nums[2];
    }

    return {
      ticker,
      alis,
      stop,
      hedef: Number.isFinite(hedef) ? hedef : null
    };
  } catch (err) {
    console.error(`Detay okunamadı: ${ticker}`, err.message);
    return null;
  }
}

function calculateSignal(detail) {
  if (!detail) return null;

  const alis = toNumber(detail.alis);
  const stop = toNumber(detail.stop);
  const hedef = toNumber(detail.hedef);

  if (!Number.isFinite(alis) || !Number.isFinite(stop)) return null;
  if (alis <= 0 || stop <= 0) return null;
  if (stop >= alis) return null;

  const risk = ((alis - stop) / alis) * 100;
  if (!Number.isFinite(risk) || risk <= 0 || risk > RISK_LIMIT) return null;

  let kar = null;
  if (Number.isFinite(hedef) && hedef > alis) {
    kar = ((hedef - alis) / alis) * 100;
  }

  return {
    ticker: detail.ticker,
    alis,
    stop,
    hedef: Number.isFinite(hedef) ? hedef : null,
    risk,
    kar
  };
}

function normalizeSignalForJson(item, extra = {}) {
  return {
    ticker: item.ticker,
    alis: formatNumber(item.alis),
    stop: formatNumber(item.stop),
    hedef: item.hedef != null ? formatNumber(item.hedef) : null,
    risk: formatPercent(item.risk),
    kar: item.kar != null ? formatPercent(item.kar) : null,
    ...extra
  };
}

function buildTelegramChunks(title, signals, updatedAt, showFirstSeen = false) {
  const chunks = [];

  for (let i = 0; i < signals.length; i += TELEGRAM_CHUNK_SIZE) {
    const part = signals.slice(i, i + TELEGRAM_CHUNK_SIZE);

    let text = "";
    text += `<b>${escapeHtml(title)}</b>\n`;
    text += `<b>Saat:</b> ${escapeHtml(updatedAt)}\n`;
    text += `<pre>`;

    if (showFirstSeen) {
      text += `${pad("Hisse", 8)} ${pad("Alış", 10, true)} ${pad("Stop", 10, true)} ${pad("Risk%", 8, true)} ${pad("Saat", 6, true)}\n`;
      text += `${"-".repeat(52)}\n`;
      for (const item of part) {
        text += `${pad(item.ticker, 8)} ${pad(formatNumber(item.alis), 10, true)} ${pad(formatNumber(item.stop), 10, true)} ${pad(formatNumber(item.risk), 8, true)} ${pad(item.firstSeen || "-", 6, true)}\n`;
      }
    } else {
      text += `${pad("Hisse", 8)} ${pad("Alış", 10, true)} ${pad("Stop", 10, true)} ${pad("Risk%", 8, true)} ${pad("Kar%", 8, true)}\n`;
      text += `${"-".repeat(50)}\n`;
      for (const item of part) {
        text += `${pad(item.ticker, 8)} ${pad(formatNumber(item.alis), 10, true)} ${pad(formatNumber(item.stop), 10, true)} ${pad(formatNumber(item.risk), 8, true)} ${pad(item.kar != null ? formatNumber(item.kar) : "-", 8, true)}\n`;
      }
    }

    text += `</pre>`;
    chunks.push(text);
  }

  return chunks;
}

async function sendChunks(chunks) {
  for (const chunk of chunks) {
    await sendTelegramMessage(chunk);
    await sleep(1500);
  }
}

function sortSignals(signals) {
  return [...signals].sort((a, b) => {
    if (a.risk !== b.risk) return a.risk - b.risk;
    return a.ticker.localeCompare(b.ticker, "tr");
  });
}

async function collectSignals(page) {
  console.log("Liste sayfası açılıyor...");
  const tickers = await getTickersFromList(page);
  console.log("Bulunan ticker sayısı:", tickers.length);

  const details = [];
  for (const ticker of tickers) {
    console.log("Detay okunuyor:", ticker);
    const detail = await getDetailData(page, ticker);
    if (detail) details.push(detail);
    await sleep(450);
  }

  const signals = sortSignals(
    details.map(calculateSignal).filter(Boolean)
  );

  console.log("Filtre sonrası sinyal sayısı:", signals.length);
  return signals;
}

function ensureStateShape(state) {
  return {
    approved: {
      lastDate: state?.approved?.lastDate || null,
      tickers: Array.isArray(state?.approved?.tickers) ? state.approved.tickers : []
    },
    intraday: {
      lastDate: state?.intraday?.lastDate || null,
      seenTickers: Array.isArray(state?.intraday?.seenTickers) ? state.intraday.seenTickers : []
    }
  };
}

function saveLastSignals(signals, updatedAt, type) {
  writeJsonFile(LAST_SIGNALS_FILE, {
    updatedAt,
    type,
    signals: signals.map((x) => normalizeSignalForJson(x, x.firstSeen ? { firstSeen: x.firstSeen } : {}))
  });
}

async function runApproved(page) {
  const now = getNow();
  const updatedAt = getLocalTimeString(now);
  const today = getLocalDateString(now);

  const state = ensureStateShape(readJsonFile(STATE_FILE, {}));
  const signals = await collectSignals(page);

  const approvedJson = {
    updatedAt,
    type: "approved",
    signals: signals.map((x) => normalizeSignalForJson(x))
  };

  writeJsonFile(APPROVED_FILE, approvedJson);
  saveLastSignals(signals, updatedAt, "approved");

  state.approved.lastDate = today;
  state.approved.tickers = signals.map((x) => x.ticker);
  writeJsonFile(STATE_FILE, state);

  if (!signals.length) {
    await sendTelegramMessage(`<b>Onay Alanlar</b>\n<b>Saat:</b> ${escapeHtml(updatedAt)}\nUygun hisse bulunamadı.`);
    return;
  }

  const chunks = buildTelegramChunks("Onay Alanlar", signals, updatedAt, false);
  await sendChunks(chunks);
}

async function runIntraday(page) {
  const now = getNow();
  const updatedAt = getLocalTimeString(now);
  const today = getLocalDateString(now);
  const firstSeen = getLocalHourMinute(now);

  const state = ensureStateShape(readJsonFile(STATE_FILE, {}));

  if (state.intraday.lastDate !== today) {
    state.intraday.lastDate = today;
    state.intraday.seenTickers = [];
  }

  const allSignals = await collectSignals(page);
  const seenSet = new Set(state.intraday.seenTickers);

  const newSignals = allSignals
    .filter((x) => !seenSet.has(x.ticker))
    .map((x) => ({ ...x, firstSeen }));

  const currentJson = readJsonFile(INTRADAY_FILE, {
    updatedAt: null,
    type: "intraday",
    signals: []
  });

  const existingSignals = Array.isArray(currentJson.signals) ? currentJson.signals : [];

  const mergedSignals = [
    ...existingSignals,
    ...newSignals.map((x) => normalizeSignalForJson(x, { firstSeen: x.firstSeen }))
  ];

  const intradayJson = {
    updatedAt,
    type: "intraday",
    signals: mergedSignals
  };

  writeJsonFile(INTRADAY_FILE, intradayJson);
  saveLastSignals(newSignals, updatedAt, "intraday");

  state.intraday.seenTickers = [...new Set([
    ...state.intraday.seenTickers,
    ...allSignals.map((x) => x.ticker)
  ])];
  writeJsonFile(STATE_FILE, state);

  if (!newSignals.length) {
    console.log("Yeni seans içi sinyal yok.");
    return;
  }

  const chunks = buildTelegramChunks("Seans İçi Yeni Düşenler", newSignals, updatedAt, true);
  await sendChunks(chunks);
}

async function main() {
  console.log("Bot modu:", MODE);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 2600 });

  try {
    if (MODE === "approved") {
      await runApproved(page);
    } else if (MODE === "intraday") {
      await runIntraday(page);
    } else {
      throw new Error(`Geçersiz BOT_MODE: ${MODE}`);
    }

    console.log("İşlem tamamlandı.");
  } catch (err) {
    console.error("HATA:", err);
    const msg = escapeHtml(err.message || String(err));
    await sendTelegramMessage(`<b>Bot hatası</b>\n<pre>${msg}</pre>`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();