const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");

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
  const n = Number(String(value).replace(",", ".").replace(/[^\d.-]/g, ""));
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
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
  });
}

async function getLivePrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}.IS`;
    const res = await axios.get(url);
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
        x.innerText.trim()
      );

      rows.push({
        ticker,
        alis: cells[1],
        son: cells[2],
      });
    }

    return rows;
  });
}

async function extractDetailLevels(page, ticker) {
  await page.goto(`${DETAIL_URL}${ticker}`, { waitUntil: "networkidle2" });
  await sleep(2000);

  return await page.evaluate(() => {
    const text = document.body.innerText;

    const al = text.match(/Al Seviyesi[:\s]*([0-9.,]+)/i)?.[1];
    const stop = text.match(/Stop[:\s]*([0-9.,]+)/i)?.[1];

    return { al, stop };
  });
}

async function uploadFileToGithub(localPath, remotePath) {
  if (!GITHUB_TOKEN) return null;

  const content = fs.readFileSync(localPath, "base64");

  await axios.put(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${remotePath}`,
    {
      message: "chart upload",
      content,
      branch: GITHUB_BRANCH,
    },
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
      },
    }
  );

  return `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GITHUB_BRANCH}/${remotePath}`;
}

async function generateChart(row, folder) {
  ensureDir(TEMP_DIR);

  const img = new Jimp(800, 400, 0x0b1220ff);

  const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  const a = toNumber(row.alis);
  const s = toNumber(row.stop);
  const h = a + (a - s) * 2;

  const min = Math.min(a, s, h) * 0.95;
  const max = Math.max(a, s, h) * 1.05;

  function y(v) {
    return 350 - ((v - min) / (max - min)) * 300;
  }

  function line(val, color) {
    for (let x = 50; x < 750; x++) {
      img.setPixelColor(color, x, Math.round(y(val)));
    }
  }

  line(a, Jimp.rgbaToInt(34, 211, 238, 255));
  line(s, Jimp.rgbaToInt(239, 68, 68, 255));
  line(h, Jimp.rgbaToInt(245, 158, 11, 255));

  img.print(font, 50, 20, row.ticker);
  img.print(font, 50, 50, `Alış: ${row.alis}`);
  img.print(font, 50, 70, `Stop: ${row.stop}`);

  const file = path.join(TEMP_DIR, `${row.ticker}.png`);
  await img.writeAsync(file);

  const remote = `charts/${folder}/${row.ticker}.png`;
  return await uploadFileToGithub(file, remote);
}

async function run() {
  ensureDir(TEMP_DIR);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage();

  await page.goto(URL, { waitUntil: "networkidle2" });
  await sleep(4000);

  const rows = await extractRows(page);

  const detailPage = await browser.newPage();

  const results = [];

  for (const r of rows) {
    const detail = await extractDetailLevels(detailPage, r.ticker);

    const alis = detail.al || r.alis;
    const stop = detail.stop || r.son;

    const a = toNumber(alis);
    const s = toNumber(stop);

    if (isNaN(a) || isNaN(s) || s >= a) continue;

    const risk = ((a - s) / a) * 100;
    if (risk > 3) continue;

    const live = await getLivePrice(r.ticker);

    results.push({
      ticker: r.ticker,
      alis,
      stop,
      risk,
      current: live ? live.toFixed(2) : null,
    });

    await sleep(300);
  }

  const category = getTimeCategory();

  for (const row of results) {
    const url = await generateChart(row, category);
    row.grafikUrl = url;
  }

  let text = `Sinyaller (${category})\n\n`;

  for (const r of results) {
    text += `${r.ticker} | ${r.alis} | ${r.stop} | %${r.risk.toFixed(2)}\n`;
  }

  await sendTelegram(text);

  await browser.close();
}

run();
