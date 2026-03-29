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

async function generateChart(row, folder) {
  ensureDir(TEMP_DIR);

  const width = 900;
  const height = 500;
  const img = new Jimp(width, height, 0x081220ff);

  const titleFont = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  const a = toNumber(row.alis);
  const s = toNumber(row.stop);
  const h = a + (a - s) * 2;

  const min = Math.min(a, s, h) * 0.95;
  const max = Math.max(a, s, h) * 1.05;

  function y(v) {
    return 400 - ((v - min) / (max - min)) * 300;
  }

  function drawHLine(val, color, dashed = false) {
    const yy = Math.round(y(val));
    for (let x = 50; x < 850; x++) {
      if (dashed && Math.floor((x - 50) / 10) % 2 === 1) continue;
      for (let t = 0; t < 3; t++) {
        if (yy + t >= 0 && yy + t < height) {
          img.setPixelColor(color, x, yy + t);
        }
      }
    }
  }

  function fillRect(x, y0, w, h0, color) {
    for (let yy = y0; yy < y0 + h0; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (xx >= 0 && xx < width && yy >= 0 && yy < height) {
          img.setPixelColor(color, xx, yy);
        }
      }
    }
  }

  for (let gy = 100; gy <= 400; gy += 60) {
    for (let x = 50; x < 850; x++) {
      img.setPixelColor(Jimp.rgbaToInt(25, 40, 70, 255), x, gy);
    }
  }

  for (let gx = 50; gx <= 850; gx += 100) {
    for (let yy = 100; yy < 430; yy++) {
      img.setPixelColor(Jimp.rgbaToInt(18, 32, 58, 255), gx, yy);
    }
  }

  const cAlis = Jimp.rgbaToInt(34, 211, 238, 255);
  const cStop = Jimp.rgbaToInt(239, 68, 68, 255);
  const cHedef = Jimp.rgbaToInt(245, 158, 11, 255);
  const cCurrent = Jimp.rgbaToInt(34, 197, 94, 255);

  drawHLine(a, cAlis, false);
  drawHLine(s, cStop, false);
  drawHLine(h, cHedef, true);

  if (row.current && !isNaN(toNumber(row.current))) {
    drawHLine(toNumber(row.current), cCurrent, true);
  }

  fillRect(25, 20, 300, 95, Jimp.rgbaToInt(5, 12, 24, 220));

  img.print(titleFont, 40, 28, row.ticker);
  img.print(font, 40, 70, `Alış: ${row.alis}`);
  img.print(font, 170, 70, `Stop: ${row.stop}`);
  img.print(font, 300, 70, `Risk: %${row.risk.toFixed(2)}`);

  if (row.current) {
    img.print(font, 40, 92, `Güncel: ${row.current}`);
  }

  img.print(font, 690, Math.round(y(a)) - 10, `ALIŞ ${a.toFixed(2)}`);
  img.print(font, 690, Math.round(y(s)) - 10, `STOP ${s.toFixed(2)}`);
  img.print(font, 675, Math.round(y(h)) - 10, `HEDEF ${h.toFixed(2)}`);

  if (row.current && !isNaN(toNumber(row.current))) {
    img.print(font, 660, Math.round(y(toNumber(row.current))) - 10, `GÜNCEL ${row.current}`);
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
