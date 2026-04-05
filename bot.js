const axios = require("axios");
const cheerio = require("cheerio");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const LIST_URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const RISK_LIMIT = 5;
const REQUEST_TIMEOUT = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toNumber(value) {
  if (value === null || value === undefined) return NaN;

  const normalized = String(value)
    .replace(/\s+/g, "")
    .replace(/TL/gi, "")
    .replace(/₺/g, "")
    .replace(/%/g, "")
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.-]/g, "");

  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(digits).replace(".", ",");
}

function formatRisk(value) {
  if (!Number.isFinite(value)) return "-";
  return "%" + formatNumber(value, 2);
}

function getTurkeyNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Istanbul" })
  );
}

function getTimeCategory() {
  const now = getTurkeyNow();
  const hour = now.getHours();

  if (hour === 21) return "onay";
  if (hour >= 9 && hour <= 18) return "seans";
  return "diger";
}

function formatTurkeyDateTime() {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

function pad(value, width, right = false) {
  const s = String(value ?? "-");
  if (s.length >= width) return s.slice(0, width);
  return right ? s.padStart(width, " ") : s.padEnd(width, " ");
}

async function sendTelegramMessage(text) {
  await axios.post(
    `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    {
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    {
      timeout: REQUEST_TIMEOUT,
    }
  );
}

async function fetchText(url) {
  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: "https://www.turkishbulls.com/",
    },
    responseType: "text",
  });

  return response.data;
}

function extractTickersFromHtml(html) {
  const tickers = new Set();

  const regexes = [
    /SignalPage\.aspx\?lang=tr&Ticker=([A-ZÇĞİÖŞÜ0-9._-]+)/gi,
    /SignalPage\.aspx\?Ticker=([A-ZÇĞİÖŞÜ0-9._-]+)/gi,
    /Ticker=([A-ZÇĞİÖŞÜ0-9._-]{2,15})/gi,
  ];

  for (const regex of regexes) {
    const matches = html.matchAll(regex);
    for (const match of matches) {
      const ticker = String(match[1] || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9._-]/g, "");
      if (ticker) tickers.add(ticker);
    }
  }

  const $ = cheerio.load(html);
  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();

    if (/SignalPage\.aspx/i.test(href)) {
      const m = href.match(/Ticker=([A-Z0-9._-]+)/i);
      if (m?.[1]) tickers.add(m[1].toUpperCase());
    }

    if (/^[A-Z]{3,6}$/.test(text)) {
      if (
        href.includes("SignalPage") ||
        href.includes("Ticker=") ||
        href.toLowerCase().includes("signalpage")
      ) {
        tickers.add(text.toUpperCase());
      }
    }
  });

  return [...tickers];
}

function extractLabeledValue(text, labels) {
  const escaped = labels.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    `(?:${escaped.join("|")})\\s*[:\\-]?\\s*([0-9.,]+)`,
    "i"
  );

  const match = text.match(pattern);
  if (match?.[1]) return match[1];

  return null;
}

function extractDetailData(html, ticker) {
  const text = cheerio.load(html).text().replace(/\s+/g, " ").trim();

  let alisText =
    extractLabeledValue(text, [
      "Al Seviyesi",
      "AL Seviyesi",
      "Alış Seviyesi",
      "Alis Seviyesi",
      "Alış",
      "Alis",
      "AL",
    ]) || null;

  let stopText =
    extractLabeledValue(text, [
      "Stoploss",
      "Stop Loss",
      "Stop",
      "STOPLOSS",
      "STOP",
    ]) || null;

  const alis = toNumber(alisText);
  const stop = toNumber(stopText);

  return {
    ticker,
    alisText: alisText || "-",
    stopText: stopText || "-",
    alis,
    stop,
    rawText: text,
  };
}

async function fetchTickerList() {
  const html = await fetchText(LIST_URL);
  const tickers = extractTickersFromHtml(html);

  if (!tickers.length) {
    throw new Error("Liste sayfasından hiç hisse alınamadı.");
  }

  return tickers;
}

async function fetchSignalDetail(ticker) {
  const url = `${DETAIL_URL}${encodeURIComponent(ticker)}`;
  const html = await fetchText(url);
  const detail = extractDetailData(html, ticker);

  if (!Number.isFinite(detail.alis) || !Number.isFinite(detail.stop)) {
    return {
      ticker,
      alis: NaN,
      stop: NaN,
      risk: NaN,
      detailUrl: url,
      ok: false,
      reason: "Alış veya stop bulunamadı",
    };
  }

  if (detail.stop >= detail.alis) {
    return {
      ticker,
      alis: detail.alis,
      stop: detail.stop,
      risk: NaN,
      detailUrl: url,
      ok: false,
      reason: "Stop alıştan büyük/eşit",
    };
  }

  const risk = ((detail.alis - detail.stop) / detail.alis) * 100;

  return {
    ticker,
    alis: detail.alis,
    stop: detail.stop,
    risk,
    detailUrl: url,
    ok: Number.isFinite(risk) && risk <= RISK_LIMIT,
    reason: Number.isFinite(risk) && risk <= RISK_LIMIT ? "" : "Risk limiti üstünde",
  };
}

function buildTelegramTable(signals, category) {
  const titleMap = {
    onay: "Onay Alanlar",
    seans: "Seans İçi",
    diger: "Diğer Zaman",
  };

  let text = `<b>📊 Turkishbulls ${escapeHtml(titleMap[category] || "Sinyaller")}</b>\n`;
  text += `<b>🕒 ${escapeHtml(formatTurkeyDateTime())}</b>\n\n`;

  if (!signals.length) {
    text += "Uygun sinyal bulunamadı.";
    return text;
  }

  text += "<pre>";
  text +=
    pad("HİSSE", 8) +
    pad("ALIŞ", 10, true) +
    pad("STOP", 10, true) +
    pad("RİSK", 10, true) +
    "\n";
  text += "-".repeat(38) + "\n";

  for (const item of signals) {
    text +=
      pad(item.ticker, 8) +
      pad(formatNumber(item.alis), 10, true) +
      pad(formatNumber(item.stop), 10, true) +
      pad(formatRisk(item.risk), 10, true) +
      "\n";
  }

  text += "</pre>";
  return text;
}

async function run() {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik.");
  }

  const category = getTimeCategory();

  try {
    console.log("Liste sayfası çekiliyor...");
    const tickers = await fetchTickerList();
    console.log(`Bulunan hisse sayısı: ${tickers.length}`);

    const results = [];
    const failed = [];

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i];
      console.log(`[${i + 1}/${tickers.length}] ${ticker} işleniyor...`);

      try {
        const detail = await fetchSignalDetail(ticker);

        if (detail.ok) {
          results.push(detail);
        } else {
          failed.push({
            ticker,
            reason: detail.reason,
          });
        }
      } catch (err) {
        failed.push({
          ticker,
          reason: err.message || "Bilinmeyen hata",
        });
      }

      await sleep(350);
    }

    results.sort((a, b) => a.risk - b.risk);

    console.log(`Uygun sinyal: ${results.length}`);
    console.log(`Başarısız/elenen: ${failed.length}`);

    const message = buildTelegramTable(results, category);
    await sendTelegramMessage(message);

    if (!results.length) {
      let info = `<b>Bilgi</b>\n`;
      info += `Liste sayfasından <b>${tickers.length}</b> hisse bulundu.\n`;
      info += `Ama filtre sonrası uygun kayıt çıkmadı.\n\n`;

      const preview = failed.slice(0, 15);
      if (preview.length) {
        info += "<b>İlk nedenler:</b>\n";
        for (const item of preview) {
          info += `• ${escapeHtml(item.ticker)} → ${escapeHtml(item.reason)}\n`;
        }
      }

      await sendTelegramMessage(info);
    }
  } catch (error) {
    console.error("HATA:", error);

    const text =
      `<b>Bot hata verdi</b>\n\n` +
      `Mesaj: ${escapeHtml(error.message || "Bilinmeyen hata")}`;

    try {
      await sendTelegramMessage(text);
    } catch (e) {
      console.error("Telegram hata mesajı da gönderilemedi:", e.message);
    }

    process.exitCode = 1;
  }
}

run();