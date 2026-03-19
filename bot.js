const puppeteer = require("puppeteer");
const axios = require("axios");

const TOKEN = "8775847619:AAGT8RrKMOLWV1YYuakcc6zAXLWIgaitias";
const CHAT_ID = "-1003675682598";

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

// ✅ RİSK FİLTRESİ 3%
const MAX_RISK_PERCENT = 3.0;

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
    text: text,
    parse_mode: "HTML"
  });
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
}

function calculateRisk(al, stop) {
  return ((al - stop) / al) * 100;
}

(async () => {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();

  await page.goto(URL, { waitUntil: "networkidle2" });

  await autoScroll(page);
  await sleep(2000);

  const hisseler = await page.evaluate(() => {
    const rows = document.querySelectorAll("table tr");
    let data = [];

    rows.forEach(row => {
      const cols = row.querySelectorAll("td");
      if (cols.length >= 2) {
        const hisse = cols[1]?.innerText?.trim();
        if (hisse && hisse.length <= 10) {
          data.push(hisse);
        }
      }
    });

    return [...new Set(data)];
  });

  let results = [];

  for (let hisse of hisseler) {
    try {
      const detailPage = await browser.newPage();
      await detailPage.goto(DETAIL_URL + hisse, { waitUntil: "networkidle2" });
      await sleep(1000);

      const data = await detailPage.evaluate(() => {
        let al = null;
        let stop = null;

        const texts = document.body.innerText.split("\n");

        texts.forEach(line => {
          if (line.includes("Alış")) {
            al = parseFloat(line.replace(",", ".").match(/\d+(\.\d+)?/));
          }
          if (line.includes("Stop")) {
            stop = parseFloat(line.replace(",", ".").match(/\d+(\.\d+)?/));
          }
        });

        return { al, stop };
      });

      await detailPage.close();

      if (data.al && data.stop && data.stop < data.al) {
        const risk = calculateRisk(data.al, data.stop);

        // ✅ RİSK FİLTRESİ
        if (risk <= MAX_RISK_PERCENT) {
          results.push({
            hisse,
            al: data.al,
            stop: data.stop,
            risk
          });
        }
      }

    } catch (e) {}
  }

  // Küçükten büyüğe sırala
  results.sort((a, b) => a.risk - b.risk);

  const now = new Date().toLocaleString("tr-TR");

  let mesaj = `<b>Guncel AL listesi</b>\n`;
  mesaj += `Tarama: ${now}\n`;
  mesaj += `Risk filtresi: <= ${MAX_RISK_PERCENT.toFixed(2)}%\n\n`;

  mesaj += `No Hisse     Alis     STOP     Risk%\n`;
  mesaj += `-----------------------------------\n`;

  results.forEach((r, i) => {
    mesaj += `${pad(i + 1, 2)} ${pad(r.hisse, 7)} ${pad(r.al.toFixed(2), 8, true)} ${pad(r.stop.toFixed(2), 8, true)} ${pad(r.risk.toFixed(2), 6, true)}\n`;
  });

  mesaj += `\nToplam: ${results.length}`;

  await sendTelegram(`<pre>${mesaj}</pre>`);

  // ✅ ERKEN ALIM (AŞIRI SATIM YAZISI KALDIRILDI)
  let earlyMsg = `<b>Erken Alım Sinyali</b>\n`;
  earlyMsg += `Tarama: ${now}\n`;
  earlyMsg += `Risk filtresi: <= ${MAX_RISK_PERCENT.toFixed(2)}%\n\n`;

  earlyMsg += `Uygun hisse bulunamadi.`;

  await sendTelegram(`<pre>${earlyMsg}</pre>`);

  await browser.close();
})();
