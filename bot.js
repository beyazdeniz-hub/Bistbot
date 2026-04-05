const puppeteer = require("puppeteer-core");
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
  if (!TOKEN || !CHAT_ID) return;

  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
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

async function safeClickText(page, text) {
  try {
    const clicked = await page.evaluate((targetText) => {
      const nodes = Array.from(document.querySelectorAll("button, a, div, span"));
      const el = nodes.find((node) => {
        const value = (node.innerText || node.textContent || "").trim();
        return value === targetText;
      });

      if (el) {
        el.click();
        return true;
      }

      return false;
    }, text);

    return clicked;
  } catch (e) {
    return false;
  }
}

async function closePopups(page) {
  const closeTexts = [
    "Kabul Et",
    "Accept",
    "Tamam",
    "I Agree",
    "Anladım",
    "Close",
    "Kapat",
    "Accept All",
    "Tümünü Kabul Et",
    "Onayla",
  ];

  for (const text of closeTexts) {
    const clicked = await safeClickText(page, text);
    if (clicked) {
      await sleep(1200);
    }
  }

  try {
    await page.keyboard.press("Escape");
    await sleep(500);
  } catch (e) {
    // geç
  }
}

async function ensurePageReady(page) {
  try {
    await page.waitForSelector("body", { timeout: 30000 });
  } catch (e) {
    // geç
  }

  await sleep(3000);

  try {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
  } catch (e) {
    // geç
  }

  await sleep(1000);
}

async function takeScreenshot(page, path) {
  await page.screenshot({
    path,
    type: "png",
    fullPage: false,
    captureBeyondViewport: false,
  });
}

async function run() {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik.");
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        "/usr/bin/chromium" ||
        "/usr/bin/chromium-browser",
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-features=site-per-process",
        "--window-size=1440,2200",
      ],
      defaultViewport: {
        width: 1440,
        height: 2200,
        deviceScaleFactor: 1,
      },
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
    );

    await page.setExtraHTTPHeaders({
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(120000);

    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    await sleep(4000);

    try {
      await page.waitForNetworkIdle({
        idleTime: 1500,
        timeout: 20000,
      });
    } catch (e) {
      // bazı sitelerde bu bekleme gereksiz patlayabilir, geçiyoruz
    }

    await ensurePageReady(page);
    await closePopups(page);
    await ensurePageReady(page);

    try {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
    } catch (e) {
      // geç
    }

    await sleep(1500);

    await takeScreenshot(page, SCREENSHOT_FILE);

    await sendTelegramPhoto(
      SCREENSHOT_FILE,
      "Turkishbulls ana sayfa ekran görüntüsü"
    );

    console.log("Screenshot çekildi ve Telegram'a gönderildi.");
  } catch (error) {
    console.error("HATA:", error);

    const message = [
      "Bot hata verdi.",
      "",
      `Mesaj: ${error.message || "Bilinmeyen hata"}`,
    ].join("\n");

    try {
      await sendTelegramMessage(message);
    } catch (telegramError) {
      console.error(
        "Telegram hata mesajı da gönderilemedi:",
        telegramError.message
      );
    }

    process.exitCode = 1;
  } finally {
    try {
      if (browser) {
        await browser.close();
      }
    } catch (e) {
      // geç
    }

    try {
      if (fs.existsSync(SCREENSHOT_FILE)) {
        fs.unlinkSync(SCREENSHOT_FILE);
      }
    } catch (e) {
      console.error("Geçici dosya silinemedi:", e.message);
    }
  }
}

run();