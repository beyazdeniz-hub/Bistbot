const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage } = require("canvas");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const MAX_CHARTS_PER_RUN = 12;
const TEMP_DIR = "tmp_charts";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function toNumber(value) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const num = parseFloat(normalized);
  return isNaN(num) ? NaN : num;
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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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
    disable_web_page_preview: true,
  });
}

function buildTable(title, rows) {
  let text = `${title}\n\n`;
  text += `${pad("No", 3, true)} ${pad("Hisse", 6)} ${pad("Alis", 9, true)} ${pad("STOP", 9, true)} ${pad("Risk%", 6, true)}\n`;
  text += `${pad("---", 3)} ${pad("------", 6)} ${pad("---------", 9)} ${pad("---------", 9)} ${pad("------", 6)}\n`;

  rows.forEach((row, i) => {
    text += `${pad(i + 1, 3, true)} ${pad(row.ticker, 6)} ${pad(row.alis, 9, true)} ${pad(row.stop, 9, true)} ${pad(row.risk.toFixed(2), 6, true)}\n`;
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

function saveLatestJson(filename, rows) {
  const payload = {
    updatedAt: getTurkeyNow().toLocaleString("tr-TR"),
    signals: rows.map((row) => ({
      ticker: row.ticker,
      alis: row.alis,
      stop: row.stop,
      risk: row.risk.toFixed(2),
      current: row.current ?? null,
      change: row.change ?? null,
      grafikUrl: row.grafikUrl ?? null,
    })),
  };

  fs.writeFileSync(filename, JSON.stringify(payload, null, 2), "utf8");
  console.log(`${filename} oluşturuldu`);
}

function saveHistory(rows) {
  const now = getTurkeyNow();
  const today = now.toLocaleDateString("tr-TR");

  let db = {};

  if (fs.existsSync("history.json")) {
    try {
      db = JSON.parse(fs.readFileSync("history.json", "utf8"));
    } catch {
      db = {};
    }
  }

  db[today] = {
    date: today,
    updatedAt: now.toLocaleString("tr-TR"),
    signals: rows.map((row) => ({
      ticker: row.ticker,
      alis: row.alis,
      stop: row.stop,
      risk: row.risk.toFixed(2),
      current: row.current ?? null,
      change: row.change ?? null,
      grafikUrl: row.grafikUrl ?? null,
    })),
  };

  fs.writeFileSync("history.json", JSON.stringify(db, null, 2), "utf8");
  console.log("history.json güncellendi");
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
        clientHeight: doc.clientHeight,
      };
    });

    await page.evaluate(async () => {
      const doc = document.scrollingElement || document.documentElement || document.body;
      const distance = Math.max(500, Math.floor(window.innerHeight * 0.8));
      const steps = 6;

      for (let i = 0; i < steps; i++) {
        window.scrollBy(0, distance);
        doc.scrollTop = doc.scrollTop + distance;

        const allEls = Array.from(document.querySelectorAll("*")).filter((el) => {
          const style = window.getComputedStyle(el);
          const canScroll =
            /(auto|scroll)/i.test(style.overflowY) &&
            el.scrollHeight > el.clientHeight + 50;
          return canScroll;
        });

        for (const el of allEls) {
          el.scrollTop = el.scrollHeight;
        }

        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    });

    await sleep(2000);

    const currentCount = await getVisibleTickerCount(page);
    const after = await page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement || document.body;
      return {
        scrollTop: doc.scrollTop,
        scrollHeight: doc.scrollHeight,
        clientHeight: doc.clientHeight,
      };
    });

    const reachedBottom = after.scrollTop + after.clientHeight >= after.scrollHeight - 5;
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
    const trList = Array.from(document.querySelectorAll("tr")).filter((tr) =>
      tr.querySelector('a[href*="SignalPage"]')
    );

    for (const tr of trList) {
      const link = tr.querySelector('a[href*="SignalPage"]');
      const ticker = getTickerFromHref(link?.getAttribute("href"));

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

      rows.push({
        ticker,
        alis,
        son,
        yuzde,
      });
    }

    const seen = new Set();
    return rows.filter((row) => {
      if (seen.has(row.ticker)) return false;
      seen.add(row.ticker);
      return true;
    });
  });
}

async function extractDetailLevels(detailPage, ticker) {
  await detailPage.goto(`${DETAIL_URL}${ticker}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
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
        if (m && m[1]) return m[1].trim();
      }
      return "-";
    }

    const alSeviyesi = pick([
      /Al Seviyesi[:\s]*([0-9.,]+)/i,
      /AL Seviyesi[:\s]*([0-9.,]+)/i,
    ]);

    const stoploss = pick([
      /Stoploss[:\s]*([0-9.,]+)/i,
      /Stop Loss[:\s]*([0-9.,]+)/i,
      /Stop[:\s]*([0-9.,]+)/i,
    ]);

    return {
      alSeviyesi,
      stoploss,
    };
  });
}

function makeTradingViewHtml(ticker) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${ticker}</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #0b1220;
      width: 1280px;
      height: 720px;
      overflow: hidden;
      font-family: Arial, sans-serif;
    }
    #wrap {
      width: 1280px;
      height: 720px;
      position: relative;
      background: #0b1220;
    }
    .tradingview-widget-container,
    .tradingview-widget-container__widget {
      width: 1280px !important;
      height: 720px !important;
    }
  </style>
</head>
<body>
  <div id="wrap">
    <div class="tradingview-widget-container">
      <div id="tv_chart"></div>
      <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
      <script type="text/javascript">
        new TradingView.widget({
          "width": 1280,
          "height": 720,
          "symbol": "BIST:${ticker}",
          "interval": "D",
          "timezone": "Europe/Istanbul",
          "theme": "dark",
          "style": "1",
          "locale": "tr",
          "toolbar_bg": "#0b1220",
          "enable_publishing": false,
          "hide_top_toolbar": false,
          "hide_legend": false,
          "save_image": false,
          "container_id": "tv_chart"
        });
      </script>
    </div>
  </div>
</body>
</html>`;
}

async function captureTradingViewBase(browser, ticker) {
  ensureDir(TEMP_DIR);

  const htmlPath = path.join(TEMP_DIR, `tv_${ticker}.html`);
  const shotPath = path.join(TEMP_DIR, `tv_${ticker}_base.png`);

  fs.writeFileSync(htmlPath, makeTradingViewHtml(ticker), "utf8");

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

  await page.goto(`file://${path.resolve(htmlPath)}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await sleep(9000);

  await page.screenshot({
    path: shotPath,
    type: "png",
  });

  await page.close();

  return shotPath;
}

function drawLineLabel(ctx, text, x, y, color, alignRight = true) {
  const paddingX = 8;
  const paddingY = 5;
  ctx.font = "bold 18px Arial";

  const metrics = ctx.measureText(text);
  const boxW = metrics.width + paddingX * 2;
  const boxH = 28;

  const boxX = alignRight ? x - boxW - 10 : x + 10;
  const boxY = Math.max(8, Math.min(y - boxH / 2, 720 - boxH - 8));

  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(boxX, boxY, boxW, boxH);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX, boxY, boxW, boxH);

  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, boxX + paddingX, boxY + 19);
}

async function addLevelsToImage(baseImagePath, outputImagePath, row) {
  const image = await loadImage(baseImagePath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(image, 0, 0);

  const buy = toNumber(row.alis);
  const stop = toNumber(row.stop);
  const current = toNumber(row.current);
  const target = !isNaN(buy) && !isNaN(stop) && buy > stop ? buy + (buy - stop) * 2 : NaN;

  const values = [buy, stop, current, target].filter((v) => !isNaN(v));
  if (!values.length) {
    fs.writeFileSync(outputImagePath, canvas.toBuffer("image/png"));
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.18, 0.4);
  const chartMin = min - padding;
  const chartMax = max + padding;
  const range = chartMax - chartMin || 1;

  const topY = 95;
  const bottomY = 650;
  const leftX = 70;
  const rightX = image.width - 45;

  function yPos(value) {
    const ratio = (value - chartMin) / range;
    return bottomY - ratio * (bottomY - topY);
  }

  function drawHorizontal(value, color, label, dashed = false) {
    if (isNaN(value)) return;

    const y = yPos(value);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;

    if (dashed) {
      ctx.setLineDash([12, 10]);
    }

    ctx.beginPath();
    ctx.moveTo(leftX, y);
    ctx.lineTo(rightX, y);
    ctx.stroke();
    ctx.restore();

    drawLineLabel(ctx, `${label}: ${Number(value).toFixed(2)}`, rightX, y, color, true);
  }

  ctx.globalAlpha = 0.85;
  ctx.fillStyle = "#07101d";
  ctx.fillRect(18, 18, 280, 92);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#22324a";
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, 280, 92);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px Arial";
  ctx.fillText(row.ticker, 32, 52);

  ctx.font = "18px Arial";
  ctx.fillStyle = "#cbd5e1";
  ctx.fillText(`Alış: ${row.alis}   Stop: ${row.stop}`, 32, 80);
  ctx.fillText(`Güncel: ${row.current ?? "-"}   Risk: %${row.risk.toFixed(2)}`, 32, 102);

  drawHorizontal(stop, "#ef4444", "STOP");
  drawHorizontal(buy, "#22d3ee", "ALIŞ");
  drawHorizontal(current, "#22c55e", "GÜNCEL");
  drawHorizontal(target, "#f59e0b", "HEDEF", true);

  fs.writeFileSync(outputImagePath, canvas.toBuffer("image/png"));
}

async function getExistingGitHubSha(ownerRepo, remotePath) {
  try {
    const url = `https://api.github.com/repos/${ownerRepo}/contents/${remotePath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
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
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    return null;
  }

  const contentBase64 = fs.readFileSync(localPath, "base64");
  const sha = await getExistingGitHubSha(GITHUB_REPOSITORY, remotePath);

  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${remotePath}`;

  await axios.put(
    url,
    {
      message: `chart upload: ${remotePath}`,
      content: contentBase64,
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

async function generateAndUploadCharts(browser, rows, folderName) {
  if (!rows.length) return rows;

  ensureDir(TEMP_DIR);

  const subset = rows.slice(0, MAX_CHARTS_PER_RUN);

  for (const row of subset) {
    try {
      const basePath = await captureTradingViewBase(browser, row.ticker);
      const outPath = path.join(TEMP_DIR, `final_${folderName}_${row.ticker}.png`);

      await addLevelsToImage(basePath, outPath, row);

      const remotePath = `charts/${folderName}/${row.ticker}.png`;
      const grafikUrl = await uploadFileToGithub(outPath, remotePath);

      row.grafikUrl = grafikUrl || null;
      console.log(`Grafik hazır: ${row.ticker}`);
    } catch (e) {
      row.grafikUrl = null;
      console.log(`Grafik üretilemedi (${row.ticker}): ${e.message}`);
    }

    await sleep(1200);
  }

  return rows;
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
    await autoScroll(page);
    await sleep(2000);

    const rows = await extractRows(page);

    if (!rows.length) {
      await sendTelegram("Bot hatası:\nListe boş geldi");
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

    const filtered = [];

    for (const row of rows) {
      const alisNum = toNumber(row.alis);
      const stopNum = toNumber(row.son);

      if (isNaN(alisNum) || isNaN(stopNum) || alisNum <= 0 || stopNum >= alisNum) {
        continue;
      }

      const risk = ((alisNum - stopNum) / alisNum) * 100;
      if (risk > 3) continue;

      const live = await getLivePrice(row.ticker);

      let change = null;
      if (live && !isNaN(live)) {
        change = ((live - alisNum) / alisNum) * 100;
      }

      filtered.push({
        ticker: row.ticker,
        alis: row.alis,
        stop: row.son,
        risk,
        current: live ? Number(live).toFixed(2) : null,
        change: change !== null ? change.toFixed(2) : null,
        grafikUrl: null,
      });

      await sleep(250);
    }

    const category = getTimeCategory();
    const chartFolder =
      category === "onay" ? "onay" :
      category === "seans" ? "seans" :
      "diger";

    await generateAndUploadCharts(browser, filtered, chartFolder);

    saveLatestJson("signals.json", filtered);

    if (category === "onay") {
      saveLatestJson("onay.json", filtered);
      saveHistory(filtered);
    }

    if (category === "seans") {
      saveLatestJson("seans.json", filtered);
    }

    if (!filtered.length) {
      await sendTelegram("Risk <= 3 uygun sinyal bulunamadı");
      return;
    }

    let title = "Risk <= 3 Uygun Hisseler";
    if (category === "onay") title = "21:00 Onay Alan Hisseler";
    if (category === "seans") title = "Seans İçi Sinyaller";

    const messages = splitRowsForTelegram(title, filtered, 25);

    for (const message of messages) {
      await sendTelegram(message);
      await sleep(700);
    }

    console.log("Tamamlandı");
  } finally {
    await browser.close();
  }
}

run().catch(async (err) => {
  try {
    await sendTelegram(`Bot hatası:\n${err.message}`);
  } catch (e) {
    console.log("Telegram hata gönderimi de başarısız:", e.message);
  }
});
