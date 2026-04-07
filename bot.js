const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const SCREENSHOT_FILE = "turkishbulls_home.png";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegramMessage(text) {
  const telegramUrl = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  await axios.post(telegramUrl, {
    chat_id: CHAT_ID,
    text,
  });
}

async function sendTelegramPhoto(filePath, caption = "") {
  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  form.append("caption", caption);
  form.append("photo", fs.createReadStream(filePath));

  const telegramUrl = `https://api.telegram.org/bot${TOKEN}/sendPhoto`;

  await axios.post(telegramUrl, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
  });
}

async function dismissPopups(page) {
  const texts = [
    "Kabul",
    "Accept",
    "Tamam",
    "Allow",
    "İzin ver",
    "Anladım",
    "Got it",
    "Close",
    "Kapat",
  ];

  for (const text of texts) {
    try {
      const xpath = `//*[self::button or self::a or self::span or self::div][contains(normalize-space(.), "${text}")]`;
      const elements = await page.$x(xpath);
      if (elements.length > 0) {
        await elements[0].click().catch(() => {});
        await sleep(1000);
      }
    } catch (err) {
      // geç
    }
  }
}

async function autoScroll(page) {
  let lastHeight = 0;
  let sameCount = 0;

  for (let i = 0; i < 40; i++) {
    const currentHeight = await page.evaluate(() => {
      window.scrollBy(0, 1200);
      return Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
    });

    await sleep(1200);

    if (currentHeight === lastHeight) {
      sameCount++;
    } else {
      sameCount = 0;
    }

    lastHeight = currentHeight;

    if (sameCount >= 3) break;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1500);
}

async function run() {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik.");
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
      ],
    });

    const page = await browser.newPage();

    await page.setViewport({
      width: 1440,
      height: 2200,
      deviceScaleFactor: 1,
    });

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    );

    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);

    await page.goto(URL, {
      waitUntil: "networkidle2",
      timeout: 90000,
    });

    await sleep(4000);
    await dismissPopups(page);
    await autoScroll(page);

    await page.screenshot({
      path: SCREENSHOT_FILE,
      fullPage: false,
    });

    await sendTelegramPhoto(
      SCREENSHOT_FILE,
      "Turkishbulls anasayfa ekran görüntüsü"
    );

    console.log("İşlem tamamlandı.");
  } catch (error) {
    console.error("HATA:", error);

    try {
      await sendTelegramMessage(`Bot hata verdi:\n${error.message}`);
    } catch (telegramError) {
      console.error("Telegram hata mesajı da gönderilemedi:", telegramError.message);
    }

    process.exit(1);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }

    if (fs.existsSync(SCREENSHOT_FILE)) {
      fs.unlinkSync(SCREENSHOT_FILE);
    }
  }
}

run();