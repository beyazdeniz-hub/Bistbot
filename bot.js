const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");
const FormData = require("form-data");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const TEMP_DIR = "tmp_charts";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toNumber(value) {
  const n = Number(String(value ?? "").replace(",", ".").replace(/[^\d.-]/g, ""));
  return isNaN(n) ? NaN : n;
}

function getTurkeyNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Istanbul" })
  );
}

function getTimeCategory() {
  const hour = getTurkeyNow().getHours();
  if (hour === 21) return "onay";
  if (hour >= 9 && hour <= 18) return "seans";
  return "diger";
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik");

  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
  });
}

async function sendTelegramPhoto(filePath, caption) {
  if (!TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik");

  const url = `https://api.telegram.org/bot${TOKEN}/sendPhoto`;
  const form = new FormData();

  form.append("chat_id", CHAT_ID);
  form.append("photo", fs.createReadStream(filePath));
  form.append("caption", caption);

  await axios.post(url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
  });
}

async function getLivePrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}.IS`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data?.quoteResponse?.result?.[0]?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

async function extractRows(page) {
  return await page.evaluate(() => {
    const rows = [];
    const trs = Array.from(document.querySelectorAll("tr")).filter((tr) =>
      tr.querySelector('a[href*="SignalPage"]')
    );

    for (const tr of trs) {
      const link = tr.querySelector('a[href*="SignalPage"]');
      const ticker = link?.href.match(/Ticker=([A-Z]+)/)?.[1];
      if (!ticker) continue;

      const cells = Array.from(tr.querySelectorAll("td")).map((x) =>
        (x.innerText || "").trim()
      );

      rows.push({
        ticker,
        alis: cells[1] || "",
        son: cells[2] || "",
      });
    }

    const seen = new Set();
    return rows.filter((r) => {
      if (seen.has(r.ticker)) return false;
      seen.add(r.ticker);
      return true;
    });
  });
}

async function extractDetailLevels(page, ticker) {
  await page.goto(`${DETAIL_URL}${ticker}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await sleep(2000);

  return await page.evaluate(() => {
    const text = document.body.innerText || "";

    const al =
      text.match(/Al Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/AL Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      null;

    const stop =
      text.match(/Stoploss[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Stop Loss[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Stop[:\s]*([0-9.,]+)/i)?.[1] ||
      null;

    return { al, stop };
  });
}

async function getExistingGitHubSha(remotePath) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return null;

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${remotePath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      timeout: 20000,
    });

    return res.data?.sha || null;
  } catch {
    return null;
  }
}

async function uploadFileToGithub(localPath, remotePath) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return null;

  const content = fs.readFileSync(localPath, "base64");
  const sha = await getExistingGitHubSha(remotePath);

  await axios.put(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${remotePath}`,
    {
      message: `chart upload: ${remotePath}`,
      content,
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      timeout: 30000,
    }
  );

  return `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GITHUB_BRANCH}/${remotePath}`;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function seeded(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function rgba(r, g, b, a = 255) {
  return Jimp.rgbaToInt(r, g, b, a);
}

function fillRect(img, x, y, w, h, color) {
  const W = img.bitmap.width;
  const H = img.bitmap.height;
  const x1 = clamp(Math.round(x), 0, W - 1);
  const y1 = clamp(Math.round(y), 0, H - 1);
  const x2 = clamp(Math.round(x + w), 0, W);
  const y2 = clamp(Math.round(y + h), 0, H);

  for (let yy = y1; yy < y2; yy++) {
    for (let xx = x1; xx < x2; xx++) {
      img.setPixelColor(color, xx, yy);
    }
  }
}

function strokeRect(img, x, y, w, h, color, thickness = 1) {
  fillRect(img, x, y, w, thickness, color);
  fillRect(img, x, y + h - thickness, w, thickness, color);
  fillRect(img, x, y, thickness, h, color);
  fillRect(img, x + w - thickness, y, thickness, h, color);
}

function drawVerticalLine(img, x, y1, y2, color, thickness = 1) {
  const top = Math.min(y1, y2);
  const bot = Math.max(y1, y2);
  fillRect(img, x - Math.floor(thickness / 2), top, thickness, bot - top + 1, color);
}

function drawHorizontalLine(img, y, x1, x2, color, thickness = 2, dashed = false) {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const yy = Math.round(y);

  for (let t = 0; t < thickness; t++) {
    for (let x = left; x <= right; x++) {
      if (dashed && Math.floor((x - left) / 12) % 2 === 1) continue;
      const px = clamp(x, 0, img.bitmap.width - 1);
      const py = clamp(yy + t, 0, img.bitmap.height - 1);
      img.setPixelColor(color, px, py);
    }
  }
}

async function drawTextBox(img, text, x, y, accentColor, opts = {}) {
  const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  const padX = opts.padX ?? 10;
  const padY = opts.padY ?? 6;
  const boxW = opts.width ?? Math.max(138, text.length * 9 + 16);
  const boxH = opts.height ?? 30;
  const bg = opts.bg ?? rgba(5, 10, 20, 215);

  fillRect(img, x, y, boxW, boxH, bg);
  strokeRect(img, x, y, boxW, boxH, accentColor, 2);
  img.print(font, x + padX, y + padY, text);
}

function buildCandles(alis, stop, target, count = 28) {
  const a = toNumber(alis);
  const s = toNumber(stop);
  const h = toNumber(target);

  const range = Math.max(Math.abs(h - s), Math.abs(a - s), 1);
  const start = a * 0.985;
  const candles = [];
  let prevClose = start;

  for (let i = 0; i < count; i++) {
    const phase = i / (count - 1);
    const drift = start + (a - start) * Math.min(phase * 1.35, 1);
    const noise = (seeded(i + a) - 0.5) * range * 0.22;
    const open = prevClose + (seeded(i + s) - 0.5) * range * 0.08;
    let close = drift + noise;

    if (i > count * 0.68) {
      close += (seeded(i + h) - 0.2) * range * 0.12;
    }

    let high = Math.max(open, close) + seeded(i + 11) * range * 0.08;
    let low = Math.min(open, close) - seeded(i + 17) * range * 0.08;

    if (i === count - 1) {
      close = a;
      high = Math.max(high, a + range * 0.03);
      low = Math.min(low, a - range * 0.03);
    }

    candles.push({ open, close, high, low });
    prevClose = close;
  }

  return candles;
}

async function generateChart(row, folder) {
  ensureDir(TEMP_DIR);

  const width = 1100;
  const height = 680;
  const img = new Jimp(width, height, rgba(3, 10, 24, 255));

  for (let y = 0; y < height; y++) {
    const t = y / height;
    const r = Math.round(6 + (2 - 6) * t);
    const g = Math.round(18 + (9 - 18) * t);
    const b = Math.round(40 + (24 - 40) * t);
    fillRect(img, 0, y, width, 1, rgba(r, g, b, 255));
  }

  const titleFont = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  const a = toNumber(row.alis);
  const s = toNumber(row.stop);
  const h = a + (a - s) * 2;
  const current = row.current ? toNumber(row.current) : NaN;

  const panelColor = rgba(8, 20, 46, 225);
  const borderColor = rgba(25, 60, 110, 255);

  fillRect(img, 30, 24, width - 60, 76, panelColor);
  strokeRect(img, 30, 24, width - 60, 76, borderColor, 2);

  img.print(titleFont, 55, 38, row.ticker);
  img.print(font, 240, 52, "Premium Sinyal Grafik Görünümü");

  const chartX = 56;
  const chartY = 128;
  const chartW = 820;
  const chartH = 450;

  fillRect(img, chartX, chartY, chartW, chartH, rgba(4, 13, 30, 255));
  strokeRect(img, chartX, chartY, chartW, chartH, rgba(23, 48, 84, 255), 2);

  const rightPanelX = 900;
  const rightPanelY = 128;
  const rightPanelW = 150;
  const rightPanelH = 450;

  fillRect(img, rightPanelX, rightPanelY, rightPanelW, rightPanelH, rgba(8, 20, 44, 245));
  strokeRect(img, rightPanelX, rightPanelY, rightPanelW, rightPanelH, rgba(23, 48, 84, 255), 2);

  const candles = buildCandles(row.alis, row.stop, h, 30);

  const allVals = [];
  candles.forEach((c) => {
    allVals.push(c.high, c.low, c.open, c.close);
  });
  allVals.push(a, s, h);
  if (!isNaN(current)) allVals.push(current);

  const minVal = Math.min(...allVals) * 0.985;
  const maxVal = Math.max(...allVals) * 1.015;

  function getY(price) {
    const ratio = (price - minVal) / (maxVal - minVal);
    return chartY + chartH - ratio * chartH;
  }

  const gridColor = rgba(22, 40, 68, 255);

  for (let i = 0; i < 6; i++) {
    const yy = chartY + Math.round((chartH / 5) * i);
    drawHorizontalLine(img, yy, chartX, chartX + chartW, gridColor, 1, false);
  }

  for (let i = 0; i < 7; i++) {
    const xx = chartX + Math.round((chartW / 6) * i);
    drawVerticalLine(img, xx, chartY, chartY + chartH, gridColor, 1);
  }

  const bullish = rgba(42, 214, 117, 255);
  const bearish = rgba(255, 82, 82, 255);
  const wick = rgba(156, 173, 210, 255);

  const candleGap = 8;
  const candleBodyW = Math.floor((chartW - candleGap * 31) / 30);

  candles.forEach((c, i) => {
    const x = chartX + candleGap + i * (candleBodyW + candleGap);
    const yOpen = getY(c.open);
    const yClose = getY(c.close);
    const yHigh = getY(c.high);
    const yLow = getY(c.low);

    const color = c.close >= c.open ? bullish : bearish;
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(4, Math.abs(yClose - yOpen));

    drawVerticalLine(img, x + Math.floor(candleBodyW / 2), yHigh, yLow, wick, 2);
    fillRect(img, x, bodyTop, candleBodyW, bodyHeight, color);
    strokeRect(img, x, bodyTop, candleBodyW, bodyHeight, rgba(220, 230, 245, 80), 1);
  });

  for (let i = 0; i < 30; i++) {
    const barX = chartX + candleGap + i * (candleBodyW + candleGap);
    const volH = 30 + Math.floor(seeded(i + a + s) * 70);
    fillRect(img, barX, chartY + chartH - volH, candleBodyW, volH, rgba(10, 50, 95, 180));
  }

  const alisColor = rgba(41, 211, 255, 255);
  const stopColor = rgba(255, 82, 82, 255);
  const hedefColor = rgba(245, 158, 11, 255);
  const currentColor = rgba(34, 197, 94, 255);

  const yAlis = getY(a);
  const yStop = getY(s);
  const yHedef = getY(h);

  drawHorizontalLine(img, yAlis, chartX, chartX + chartW, alisColor, 3, false);
  drawHorizontalLine(img, yStop, chartX, chartX + chartW, stopColor, 3, false);
  drawHorizontalLine(img, yHedef, chartX, chartX + chartW, hedefColor, 3, true);

  if (!isNaN(current)) {
    drawHorizontalLine(img, getY(current), chartX, chartX + chartW, currentColor, 3, true);
  }

  await drawTextBox(
    img,
    `ALIŞ ${a.toFixed(2)}`,
    chartX + chartW - 170,
    Math.max(chartY + 8, yAlis - 16),
    alisColor,
    { width: 145 }
  );

  await drawTextBox(
    img,
    `STOP ${s.toFixed(2)}`,
    chartX + chartW - 170,
    Math.max(chartY + 8, yStop - 16),
    stopColor,
    { width: 145 }
  );

  await drawTextBox(
    img,
    `HEDEF ${h.toFixed(2)}`,
    chartX + chartW - 185,
    Math.max(chartY + 8, yHedef - 16),
    hedefColor,
    { width: 160 }
  );

  if (!isNaN(current)) {
    await drawTextBox(
      img,
      `GÜNCEL ${current.toFixed(2)}`,
      chartX + chartW - 190,
      Math.max(chartY + 8, getY(current) - 16),
      currentColor,
      { width: 165 }
    );
  }

  for (let i = 0; i <= 5; i++) {
    const price = maxVal - ((maxVal - minVal) / 5) * i;
    const yy = chartY + Math.round((chartH / 5) * i);
    img.print(font, rightPanelX + 20, yy - 8, price.toFixed(2));
  }

  fillRect(img, 30, 598, width - 60, 54, panelColor);
  strokeRect(img, 30, 598, width - 60, 54, borderColor, 2);

  img.print(font, 52, 608, `Alış: ${a.toFixed(2)}`);
  img.print(font, 220, 608, `Stop: ${s.toFixed(2)}`);
  img.print(font, 390, 608, `Hedef: ${h.toFixed(2)}`);
  img.print(font, 570, 608, `Risk: %${row.risk.toFixed(2)}`);

  if (row.current) {
    img.print(font, 52, 630, `Güncel: ${row.current}`);
  }

  const file = path.join(TEMP_DIR, `${row.ticker}.png`);
  await img.writeAsync(file);

  const remote = `charts/${folder}/${row.ticker}.png`;
  const grafikUrl = await uploadFileToGithub(file, remote);

  return { file, grafikUrl };
}

function buildCaption(row) {
  let caption =
`${row.ticker}
Alış: ${row.alis}
Stop: ${row.stop}
Risk: %${row.risk.toFixed(2)}`;

  if (row.current) {
    caption += `\nGüncel: ${row.current}`;
  }

  if (row.change) {
    caption += `\nFark: %${row.change}`;
  }

  return caption;
}

async function run() {
  ensureDir(TEMP_DIR);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });

    await page.goto(URL, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await sleep(5000);

    const rows = await extractRows(page);

    if (!rows.length) {
      await sendTelegram("Bot hatası: liste boş geldi.");
      return;
    }

    const detailPage = await browser.newPage();
    await detailPage.setViewport({ width: 1400, height: 2200 });

    const results = [];

    for (const r of rows) {
      try {
        const detail = await extractDetailLevels(detailPage, r.ticker);

        const alis = detail.al || r.alis;
        const stop = detail.stop || r.son;

        const a = toNumber(alis);
        const s = toNumber(stop);

        if (isNaN(a) || isNaN(s) || s >= a || a <= 0) {
          continue;
        }

        const risk = ((a - s) / a) * 100;
        if (risk > 3) {
          continue;
        }

        const live = await getLivePrice(r.ticker);
        let change = null;

        if (live && !isNaN(live)) {
          change = (((live - a) / a) * 100).toFixed(2);
        }

        results.push({
          ticker: r.ticker,
          alis,
          stop,
          risk,
          current: live ? Number(live).toFixed(2) : null,
          change,
          grafikUrl: null,
        });

        await sleep(300);
      } catch (e) {
        console.log(`Detay okunamadı: ${r.ticker}`);
      }
    }

    await detailPage.close();

    if (!results.length) {
      await sendTelegram("Risk <= 3 uygun sinyal bulunamadı.");
      return;
    }

    const category = getTimeCategory();

    for (const row of results) {
      try {
        const { file, grafikUrl } = await generateChart(row, category);
        row.grafikUrl = grafikUrl || null;

        const caption = buildCaption(row);
        await sendTelegramPhoto(file, caption);

        await sleep(1500);
      } catch (e) {
        console.log(`Grafik/telegram hata: ${row.ticker} - ${e.message}`);
      }
    }

    let summary = `Sinyaller (${category})\n\n`;
    for (const r of results) {
      summary += `${r.ticker} | ${r.alis} | ${r.stop} | %${r.risk.toFixed(2)}\n`;
    }
    summary += `\nToplam: ${results.length}`;

    await sendTelegram(summary);
  } finally {
    await browser.close();
  }
}

run().catch(async (err) => {
  console.log("BOT HATA:", err.message);
  try {
    await sendTelegram(`Bot hatası:\n${err.message}`);
  } catch (e) {
    console.log("Telegram hata gönderimi başarısız:", e.message);
  }
});
