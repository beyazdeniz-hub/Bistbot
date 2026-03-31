const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const TELEGRAM_CHUNK_SIZE = 25;
const MAX_ROWS = 200;
const RISK_LIMIT = 3;
const HAFIZA_DOSYASI = "borsa_hafiza.json";

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
    .replace(/,/g, ".")
    .replace(/[^\d.-]/g, "");

  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : NaN;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(digits).replace(".", ",");
}

function getNowTR() {
  return new Date().toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul",
  });
}

function memoryKey(item) {
  return `${item.ticker}|${formatNumber(item.alis, 4)}|${formatNumber(item.stop, 4)}`;
}

function hafizayiOku() {
  try {
    if (!fs.existsSync(HAFIZA_DOSYASI)) {
      return {};
    }
    const raw = fs.readFileSync(HAFIZA_DOSYASI, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch (err) {
    console.log("Hafıza okunamadı, sıfırdan başlanıyor:", err.message);
    return {};
  }
}

function hafizayiYaz(data) {
  try {
    fs.writeFileSync(HAFIZA_DOSYASI, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.log("Hafıza yazılamadı:", err.message);
  }
}

function hafizaTemizle(memory, maxAgeDays = 30) {
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const temiz = {};

  for (const [key, value] of Object.entries(memory || {})) {
    if (!value || !value.ts) continue;
    if (now - value.ts <= maxAgeMs) {
      temiz[key] = value;
    }
  }

  return temiz;
}

async function telegramGonder(text) {
  const endpoint = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  await axios.post(endpoint, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function detaydanAlisStopGetir(browser, ticker) {
  const page = await browser.newPage();

  try {
    await page.goto(`${DETAIL_URL}${ticker}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await sleep(1500);

    const bodyText = await page.evaluate(() => document.body.innerText || "");

    const satirlar = bodyText
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

    let alis = NaN;
    let stop = NaN;

    for (let i = 0; i < satirlar.length; i++) {
      const s = satirlar[i].toLowerCase();

      if (!Number.isFinite(alis) && s.includes("alış")) {
        const joined = `${satirlar[i]} ${satirlar[i + 1] || ""} ${satirlar[i + 2] || ""}`;
        const match = joined.match(/(\d{1,4}(?:[.,]\d{1,4})?)/);
        if (match) alis = toNumber(match[1]);
      }

      if (!Number.isFinite(stop) && s.includes("stop")) {
        const joined = `${satirlar[i]} ${satirlar[i + 1] || ""} ${satirlar[i + 2] || ""}`;
        const match = joined.match(/(\d{1,4}(?:[.,]\d{1,4})?)/);
        if (match) stop = toNumber(match[1]);
      }
    }

    if (!Number.isFinite(alis) || !Number.isFinite(stop)) {
      const html = await page.content();
      if (!Number.isFinite(alis)) {
        const m1 = html.match(/Alış[^0-9]{0,40}(\d{1,4}(?:[.,]\d{1,4})?)/i);
        if (m1) alis = toNumber(m1[1]);
      }
      if (!Number.isFinite(stop)) {
        const m2 = html.match(/Stop[^0-9]{0,40}(\d{1,4}(?:[.,]\d{1,4})?)/i);
        if (m2) stop = toNumber(m2[1]);
      }
    }

    return { alis, stop };
  } catch (err) {
    console.log(`${ticker} detay hatası:`, err.message);
    return { alis: NaN, stop: NaN };
  } finally {
    await page.close();
  }
}

async function sinyalListesiniGetir(page) {
  await page.goto(URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await sleep(2500);

  let lastCount = 0;
  let sameCount = 0;

  for (let i = 0; i < 35; i++) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    await sleep(1200);

    const count = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const matches = text.match(/\b[A-ZÇĞİÖŞÜ]{2,6}\b/g) || [];
      return matches.length;
    });

    if (count === lastCount) {
      sameCount++;
    } else {
      sameCount = 0;
      lastCount = count;
    }

    if (sameCount >= 3) break;
  }

  await sleep(1500);

  const tickers = await page.evaluate(() => {
    const text = document.body.innerText || "";
    const found = text.match(/\b[A-ZÇĞİÖŞÜ]{2,6}\b/g) || [];

    const blacklist = new Set([
      "BIST",
      "IMKB",
      "BORSA",
      "SAT",
      "AL",
      "STOP",
      "TR",
      "USD",
      "EUR",
      "TL",
      "DETAY",
      "SAYFA",
      "LANG",
      "MARKETSYMBOL",
      "SIGNALLIST",
      "SIGNALPAGE",
      "HOME",
      "DEFAULT",
    ]);

    const unique = [];
    for (const item of found) {
      const t = item.trim().toUpperCase();
      if (t.length < 3 || t.length > 6) continue;
      if (blacklist.has(t)) continue;
      if (!unique.includes(t)) unique.push(t);
    }

    return unique;
  });

  return tickers.slice(0, MAX_ROWS);
}

function tabloHazirla(rows, taramaZamani, yeniSayisi) {
  const lines = [];

  lines.push(`Tarama zamanı: ${taramaZamani}`);
  lines.push(`Yeni sinyal sayısı: ${yeniSayisi}`);
  lines.push("");
  lines.push(
    `${pad("Hisse", 8)} ${pad("Alış", 10, true)} ${pad("Stop", 10, true)} ${pad("Risk%", 8, true)} ${pad("Kar%", 8, true)}`
  );
  lines.push(
    `${pad("-----", 8)} ${pad("------", 10, true)} ${pad("------", 10, true)} ${pad("------", 8, true)} ${pad("------", 8, true)}`
  );

  for (const item of rows) {
    lines.push(
      `${pad(item.ticker, 8)} ${pad(formatNumber(item.alis), 10, true)} ${pad(formatNumber(item.stop), 10, true)} ${pad(formatNumber(item.risk), 8, true)} ${pad(formatNumber(item.kar), 8, true)}`
    );
  }

  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

async function main() {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik.");
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2400 });

    console.log("Sinyal listesi açılıyor...");
    const tickers = await sinyalListesiniGetir(page);
    console.log("Bulunan ticker sayısı:", tickers.length);

    const tumSonuclar = [];

    for (const ticker of tickers) {
      console.log("İşleniyor:", ticker);

      const { alis, stop } = await detaydanAlisStopGetir(browser, ticker);

      if (!Number.isFinite(alis) || !Number.isFinite(stop)) {
        console.log(`${ticker} geçildi: alış/stop bulunamadı`);
        continue;
      }

      if (stop >= alis) {
        console.log(`${ticker} geçildi: stop alıştan büyük/eşit`);
        continue;
      }

      const risk = ((alis - stop) / alis) * 100;
      if (!Number.isFinite(risk) || risk <= 0 || risk > RISK_LIMIT) {
        console.log(`${ticker} geçildi: risk uygun değil -> ${risk}`);
        continue;
      }

      const kar = (risk * 2);

      tumSonuclar.push({
        ticker,
        alis,
        stop,
        risk,
        kar,
      });

      await sleep(400);
    }

    tumSonuclar.sort((a, b) => a.risk - b.risk);

    console.log("Filtre sonrası toplam uygun sinyal:", tumSonuclar.length);

    let hafiza = hafizayiOku();
    hafiza = hafizaTemizle(hafiza, 30);

    const yeniSinyaller = [];
    const nowTs = Date.now();

    for (const item of tumSonuclar) {
      const key = memoryKey(item);

      if (!hafiza[key]) {
        yeniSinyaller.push(item);
        hafiza[key] = {
          ticker: item.ticker,
          alis: item.alis,
          stop: item.stop,
          ts: nowTs,
          tarih: getNowTR(),
        };
      }
    }

    hafizayiYaz(hafiza);

    console.log("Yeni sinyal sayısı:", yeniSinyaller.length);

    if (yeniSinyaller.length === 0) {
      console.log("Yeni sinyal yok, Telegram gönderimi yapılmadı.");
      return;
    }

    const taramaZamani = getNowTR();

    for (let i = 0; i < yeniSinyaller.length; i += TELEGRAM_CHUNK_SIZE) {
      const chunk = yeniSinyaller.slice(i, i + TELEGRAM_CHUNK_SIZE);
      const text = tabloHazirla(chunk, taramaZamani, yeniSinyaller.length);
      await telegramGonder(text);
      await sleep(1200);
    }

    console.log("Telegram gönderimi tamamlandı.");
  } catch (err) {
    console.error("HATA:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();