const puppeteer = require("puppeteer");
const axios = require("axios");

const TOKEN = "8775847619:AAGT8RrKMOLWV1YYuakcc6zAXLWIgaitias";
const CHAT_ID = "-1003675682598";

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad(value, width, right = false) {
  const s = String(value ?? "-").trim();
  if (s.length >= width) return s.slice(0, width);
  return right ? s.padStart(width, " ") : s.padEnd(width, " ");
}

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  });
}

async function runBot() {

  // ✅ BURASI DÜZELTİLDİ (CRASH FIX)
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "networkidle2" });

  // sayfayı en aşağı kadar kaydır
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });

  await sleep(2000);

  const stocks = await page.evaluate(() => {
    const rows = document.querySelectorAll("table tbody tr");
    const data = [];

    rows.forEach(row => {
      const cols = row.querySelectorAll("td");
      if (cols.length > 1) {
        const name = cols[0].innerText.trim();
        const signal = cols[1].innerText.trim();

        if (name && signal.includes("AL")) {
          data.push(name);
        }
      }
    });

    return data;
  });

  const results = [];

  for (let stock of stocks) {
    try {
      const detailPage = await browser.newPage();
      await detailPage.goto(DETAIL_URL + stock, { waitUntil: "networkidle2" });

      await sleep(1000);

      const detail = await detailPage.evaluate(() => {
        const text = document.body.innerText;

        const alMatch = text.match(/Al\s*:\s*([\d.]+)/i);
        const stopMatch = text.match(/Stop\s*:\s*([\d.]+)/i);

        return {
          al: alMatch ? parseFloat(alMatch[1]) : null,
          stop: stopMatch ? parseFloat(stopMatch[1]) : null
        };
      });

      await detailPage.close();

      if (detail.al && detail.stop) {
        const risk = ((detail.al - detail.stop) / detail.al) * 100;

        // ✅ STOP > AL OLANLARI ELE
        if (detail.stop >= detail.al) continue;

        // ✅ RİSK FİLTRESİ (3'ten küçük)
        if (risk >= 3) continue;

        results.push({
          stock,
          al: detail.al,
          stop: detail.stop,
          risk: risk.toFixed(2)
        });
      }

    } catch (e) {
      console.log("Hata:", stock);
    }
  }

  // ✅ RİSKE GÖRE SIRALA
  results.sort((a, b) => a.risk - b.risk);

  let message = `<b>📊 Sinyal Listesi</b>\n\n`;

  results.forEach(r => {
    message += `${pad(r.stock, 10)} | AL: ${r.al} | STOP: ${r.stop} | Risk: %${r.risk}\n`;
  });

  if (results.length === 0) {
    message += "Uygun sinyal yok.";
  }

  await sendTelegram(message);

  // ✅ ERKEN ALIM (AŞIRI SATIM)
  const early = await page.evaluate(() => {
    const text = document.body.innerText;
    const lines = text.split("\n");

    return lines.filter(x => x.toLowerCase().includes("aşırı satım"));
  });

  if (early.length > 0) {
    let earlyMsg = `\n\n<b>📌 ERKEN ALIM SİNYALLERİ</b>\n\n`;

    early.forEach(e => {
      earlyMsg += `${e}\n`;
    });

    await sendTelegram(earlyMsg);
  }

  await browser.close();
}

runBot();
