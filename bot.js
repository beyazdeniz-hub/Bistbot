const puppeteer = require("puppeteer");
const { getInstalledBrowsers } = require("@puppeteer/browsers");
const axios = require("axios");
const os = require("os");
const path = require("path");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik");
  }

  await axios.post(
    `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    {
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: true,
    },
    {
      timeout: 30000,
    }
  );
}

async function resolveChromePath() {
  const cacheDir =
    process.env.PUPPETEER_CACHE_DIR ||
    path.join(os.homedir(), ".cache", "puppeteer");

  const installed = await getInstalledBrowsers({ cacheDir });

  if (!installed.length) {
    throw new Error(
      `Kurulu Chrome bulunamadi. Cache klasoru: ${cacheDir}`
    );
  }

  const chromeCandidates = installed.filter((b) => {
    return String(b.browser).toLowerCase().includes("chrome");
  });

  const selected =
    chromeCandidates[chromeCandidates.length - 1] ||
    installed[installed.length - 1];

  if (!selected || !selected.executablePath) {
    throw new Error("Chrome executable path bulunamadi.");
  }

  console.log("Kullanilan browser:", selected.browser);
  console.log("Kullanilan buildId:", selected.buildId);
  console.log("Kullanilan executablePath:", selected.executablePath);

  return selected.executablePath;
}

async function getTickerCount(page) {
  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="SignalPage"]'));
    const set = new Set();

    for (const a of links) {
      const href = a.getAttribute("href") || a.href || "";
      const m = href.match(/Ticker=([A-Z]+)/i);
      if (m && m[1]) {
        set.add(m[1].toUpperCase());
      }
    }

    return set.size;
  });
}

async function forceInnerScrollables(page) {
  await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("*"));

    for (const el of nodes) {
      const style = window.getComputedStyle(el);
      const isScrollable =
        /(auto|scroll)/i.test(style.overflowY) &&
        el.scrollHeight > el.clientHeight + 50;

      if (isScrollable) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });
}

async function scrollToBottom(page) {
  let lastCount = 0;
  let stableRounds = 0;

  for (let round = 1; round <= 80; round++) {
    await page.evaluate(async () => {
      const doc = document.scrollingElement || document.documentElement || document.body;

      for (let i = 0; i < 8; i++) {
        const step = 1200;
        window.scrollBy(0, step);
        doc.scrollTop = doc.scrollTop + step;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    });

    await forceInnerScrollables(page);

    try {
      await page.keyboard.press("End");
    } catch (e) {}

    await sleep(1800);

    await page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, doc.scrollHeight);
      doc.scrollTop = doc.scrollHeight;
    });

    await forceInnerScrollables(page);
    await sleep(2000);

    const count = await getTickerCount(page);
    console.log(`Tur ${round} | ticker sayisi: ${count}`);

    if (count === lastCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
      lastCount = count;
    }

    if (stableRounds >= 4) {
      console.log("Yeni hisse gelmiyor, scroll tamamlandi.");
      break;
    }
  }

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, doc.scrollHeight);
      doc.scrollTop = doc.scrollHeight;
    });

    await forceInnerScrollables(page);
    await sleep(1800);
  }
}

async function collectTickers(page) {
  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="SignalPage"]'));
    const set = new Set();

    for (const a of links) {
      const href = a.getAttribute("href") || a.href || "";
      const match = href.match(/Ticker=([A-Z]+)/i);

      if (match && match[1]) {
        set.add(match[1].toUpperCase());
      }
    }

    return Array.from(set).sort((a, b) => a.localeCompare(b, "tr"));
  });
}

function splitMessage(text, maxLen = 3500) {
  const parts = [];
  let current = "";

  for (const line of text.split("\n")) {
    if ((current + line + "\n").length > maxLen) {
      if (current.trim()) {
        parts.push(current.trimEnd());
      }
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }

  if (current.trim()) {
    parts.push(current.trimEnd());
  }

  return parts;
}

async function run() {
  const chromePath = await resolveChromePath();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });

    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await sleep(5000);

    await scrollToBottom(page);

    const tickers = await collectTickers(page);

    console.log("Toplam hisse:", tickers.length);

    if (!tickers.length) {
      await sendTelegram("Hisse listesi bos geldi.");
      return;
    }

    let text = `Turkishbulls AL verenler\nToplam: ${tickers.length}\n\n`;

    for (let i = 0; i < tickers.length; i++) {
      text += `${i + 1}. ${tickers[i]}\n`;
    }

    const chunks = splitMessage(text, 3500);

    for (const chunk of chunks) {
      await sendTelegram(chunk);
      await sleep(1200);
    }
  } finally {
    await browser.close();
  }
}

run().catch(async (err) => {
  console.log("BOT HATA:", err.message);

  try {
    await sendTelegram(`Bot hatasi:\n${err.message}`);
  } catch (e) {
    console.log("Telegram hata:", e.message);
  }
});
