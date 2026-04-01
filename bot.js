const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegramMessage(text) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TOKEN veya CHAT_ID eksik");
  }

  const api = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  await axios.post(api, {
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: true
  });
}

async function sendTelegramPhoto(filePath, caption = "") {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TOKEN veya CHAT_ID eksik");
  }

  const api = `https://api.telegram.org/bot${TOKEN}/sendPhoto`;
  const form = new FormData();

  form.append("chat_id", CHAT_ID);
  form.append("caption", caption);
  form.append("photo", fs.createReadStream(filePath));

  await axios.post(api, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity
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
      if (ticker) {
        tickers.add(ticker);
      }
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
        clientHeight: doc.clientHeight
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

async function getFirstTicker(page) {
  return await page.evaluate(() => {
    function getTickerFromHref(href) {
      const m = String(href || "").match(/Ticker=([A-Z]+)/i);
      return m ? m[1].toUpperCase() : null;
    }

    const links = Array.from(document.querySelectorAll('a[href*="SignalPage"]'));

    for (const link of links) {
      const ticker = getTickerFromHref(link.getAttribute("href"));
      if (ticker) {
        return ticker;
      }
    }

    return null;
  });
}

async function captureChart(page, outPath) {
  const svgs = await page.$$("svg");
  const candidates = [];

  for (const svg of svgs) {
    try {
      const box = await svg.boundingBox();
      if (!box) {
        continue;
      }

      const info = await svg.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        return {
          width: rect.width,
          height: rect.height,
          text
        };
      });

      const width = box.width;
      const height = box.height;
      const area = width * height;
      const text = String(info.text || "");

      if (width < 300 || height < 150) {
        continue;
      }

      if (width > 1200 || height > 900) {
        continue;
      }

      let score = 0;

      if (width >= 500 && width <= 900) score += 4;
      if (height >= 220 && height <= 420) score += 4;
      if (area >= 120000 && area <= 350000) score += 3;

      if (/Alış|Al Seviyesi|Stoploss|Stop Loss|Kapanış|Tarih/i.test(text)) {
        score += 6;
      }

      candidates.push({
        svg,
        box,
        score,
        textPreview: text.slice(0, 200)
      });
    } catch (e) {
      console.log("SVG aday okunamadı:", e.message);
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    console.log("Uygun SVG grafik bulunamadı");
    return false;
  }

  const best = candidates[0];

  console.log("Seçilen SVG grafik:", {
    x: best.box.x,
    y: best.box.y,
    width: best.box.width,
    height: best.box.height,
    score: best.score,
    textPreview: best.textPreview
  });

  await best.svg.screenshot({
    path: outPath
  });

  return true;
}

async function launchBrowser() {
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    puppeteer.executablePath();

  console.log("Kullanılan Chrome yolu:", executablePath);

  return await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
}

async function run() {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });

    await page.goto(URL, {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    await sleep(5000);
    await autoScroll(page);

    const ticker = await getFirstTicker(page);

    if (!ticker) {
      await sendTelegramMessage("İlk hisse bulunamadı");
      return;
    }

    const detailPage = await browser.newPage();
    await detailPage.setViewport({ width: 1400, height: 2200 });

    await detailPage.goto(`${DETAIL_URL}${ticker}`, {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    await sleep(5000);

    const tmpDir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const chartPath = path.join(tmpDir, `${ticker}_chart.png`);
    const fallbackPath = path.join(tmpDir, `${ticker}_detail_full.png`);

    const foundChart = await captureChart(detailPage, chartPath);

    if (foundChart && fs.existsSync(chartPath)) {
      await sendTelegramPhoto(chartPath, `${ticker} grafik`);
    } else {
      await detailPage.screenshot({
        path: fallbackPath,
        fullPage: true
      });

      await sendTelegramPhoto(
        fallbackPath,
        `${ticker} için SVG grafik bulunamadı, detay sayfası gönderildi`
      );
    }

    await detailPage.close();
  } finally {
    await browser.close();
  }
}

run().catch(async (err) => {
  console.log("Bot genel hata:", err);

  try {
    await sendTelegramMessage(`Bot hatası: ${err.message}`);
  } catch (e) {
    console.log("Telegram hata gönderimi de başarısız:", e.message);
  }
});