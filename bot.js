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

async function run() {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik.");
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
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

    await page.goto(URL, {
      waitUntil: "networkidle2",
      timeout: 120000,
    });

    await sleep(5000);

    // Basit popup/kabul butonlarını kapatmayı dener
    const closeTexts = [
      "Kabul Et",
      "Accept",
      "Tamam",
      "I Agree",
      "Anladım",
      "Close",
      "Kapat",
    ];

    for (const text of closeTexts) {
      try {
        const elements = await page.$$("button, a, div");
        for (const el of elements) {
          const value = await page.evaluate((node) => {
            return (node.innerText || node.textContent || "").trim();
          }, el);

          if (value === text) {
            await el.click();
            await sleep(1000);
            break;
          }
        }
      } catch (e) {
        // geç
      }
    }

    await page.screenshot({
      path: SCREENSHOT_FILE,
      fullPage: false,
    });

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
      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: message,
      });
    } catch (telegramError) {
      console.error("Telegram hata mesajı da gönderilemedi:", telegramError.message);
    }

    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }

    if (fs.existsSync(SCREENSHOT_FILE)) {
      fs.unlinkSync(SCREENSHOT_FILE);
    }
  }
}

run();