const puppeteer = require("puppeteer");
const axios = require("axios");

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

  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: true,
  });
}

async function getTickerCount(page) {
  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="SignalPage"]'));
    const set = new Set();

    for (const a of links) {
      const href = a.getAttribute("href") || a.href || "";
      const m = href.match(/Ticker=([A-Z]+)/i);
      if (m && m[1]) set.add(m[1].toUpperCase());
    }

    return set.size;
  });
}

async function scrollToBottom(page) {
  let lastCount = 0;
  let stableRounds = 0;

  for (let round = 1; round <= 80; round++) {
    await page.evaluate(async () => {
      const doc = document.scrollingElement || document.documentElement || document.body;

      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, 1200);
        doc.scrollTop = doc.scrollTop + 1200;

        const scrollables = Array.from(document.querySelectorAll("*")).filter((el) => {
          const style = window.getComputedStyle(el);
          return /(auto|scroll)/i.test(style.overflowY) && el.scrollHeight > el.clientHeight + 50;
        });

        for (const el of scrollables) {
          el.scrollTop = el.scrollHeight;
        }

        await new Promise((resolve) => setTimeout(resolve, 700));
      }

      window.scrollTo(0, doc.scrollHeight);
      doc.scrollTop = doc.scrollHeight;
    });

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
      console.log("Yeni hisse gelmiyor, scroll bitti.");
      break;
    }
  }

  await page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement || document.body;
    window.scrollTo(0, doc.scrollHeight);
    doc.scrollTop = doc.scrollHeight;
  });

  await sleep(2500);
}

async function collectTickers(page) {
  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="SignalPage"]'));
    const set = new Set();

    for (const a of links) {
      const href = a.getAttribute("href") || a.href || "";
      const m = href.match(/Ticker=([A-Z]+)/i);
      if (m && m[1]) set.add(m[1].toUpperCase());
    }

    return Array.from(set).sort((a, b) => a.localeCompare(b, "tr"));
  });
}

async function run() {
  const browser = await puppeteer.launch({
    headless: true,
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

    if (!tickers.length) {
      await sendTelegram("Hisse listesi boş geldi.");
      return;
    }

    console.log("Toplam hisse:", tickers.length);

    let text = `Turkishbulls AL verenler\nToplam: ${tickers.length}\n\n`;

    for (let i = 0; i < tickers.length; i++) {
      text += `${i + 1}. ${tickers[i]}\n`;
    }

    // Telegram limitine karşı parça parça gönder
    const maxLen = 3500;
    for (let i = 0; i < text.length; i += maxLen) {
      await sendTelegram(text.slice(i, i + maxLen));
      await sleep(1000);
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