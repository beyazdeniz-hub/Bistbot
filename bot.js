const https = require("https");
const { URL } = require("url");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("HATA: TELEGRAM_TOKEN veya TELEGRAM_CHAT_ID eksik.");
  process.exit(1);
}

const TARGET_URL =
  "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
          Connection: "keep-alive",
        },
      },
      (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          resolve(data);
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.setTimeout(25000, () => {
      req.destroy(new Error("İstek zaman aşımına uğradı."));
    });
  });
}

function cleanText(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueArray(arr) {
  return [...new Set(arr)];
}

function extractTickers(html) {
  const tickers = [];

  const linkRegex =
    /SignalPage\.aspx\?lang=tr&Ticker=([A-ZÇĞİÖŞÜ0-9]+)/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    if (match[1]) {
      tickers.push(match[1].trim().toUpperCase());
    }
  }

  const tdRegex = /<td[^>]*>(.*?)<\/td>/gis;
  while ((match = tdRegex.exec(html)) !== null) {
    const text = cleanText(match[1]);
    if (/^[A-ZÇĞİÖŞÜ]{3,6}$/.test(text)) {
      tickers.push(text.toUpperCase());
    }
  }

  return uniqueArray(tickers).sort();
}

function splitMessage(text, maxLen = 4000) {
  const parts = [];
  let current = "";

  for (const line of text.split("\n")) {
    if ((current + line + "\n").length > maxLen) {
      parts.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function sendTelegramMessage(message) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true,
    });

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            reject(new Error(`Telegram API hatası: ${data}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Telegram cevabı okunamadı: ${data}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

async function main() {
  try {
    console.log("Sayfa alınıyor...");
    const html = await fetchPage(TARGET_URL);

    const tickers = extractTickers(html);

    if (!tickers.length) {
      await sendTelegramMessage(
        "⚠️ Turkishbulls sayfasından hisse listesi alınamadı."
      );
      console.log("Liste boş.");
      return;
    }

    let message = `📊 Turkishbulls AL listesi\n\nToplam hisse: ${tickers.length}\n\n`;
    message += tickers.map((t, i) => `${i + 1}. ${t}`).join("\n");

    const parts = splitMessage(message);

    for (const part of parts) {
      await sendTelegramMessage(part);
    }

    console.log("Telegram mesajı gönderildi.");
  } catch (error) {
    console.error("Genel hata:", error.message);
    try {
      await sendTelegramMessage(`❌ Bot hatası:\n${error.message}`);
    } catch (telegramError) {
      console.error("Telegram hata mesajı da gönderilemedi:", telegramError.message);
    }
    process.exit(1);
  }
}

main();
