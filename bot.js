const puppeteer = require("puppeteer");
const axios = require("axios");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "BURAYA_BOT_TOKEN";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "BURAYA_CHAT_ID";

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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID || TOKEN === "BURAYA_BOT_TOKEN" || CHAT_ID === "BURAYA_CHAT_ID") {
    throw new Error("TOKEN veya CHAT_ID eksik.");
  }

  const MAX_LEN = 4000;
  const chunks = [];

  if (text.length <= MAX_LEN) {
    chunks.push(text);
  } else {
    let current = "";
    const lines = text.split("\n");

    for (const line of lines) {
      if ((current + line + "\n").length > MAX_LEN) {
        if (current.trim()) chunks.push(current);
        current = line + "\n";
      } else {
        current += line + "\n";
      }
    }
    if (current.trim()) chunks.push(current);
  }

  for (const chunk of chunks) {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: chunk,
      parse_mode: "HTML"
    });
    await sleep(1200);
  }
}

async function autoScroll(page) {
  let lastHeight = 0;
  let sameCount = 0;

  for (let i = 0; i < 30; i++) {
    const newHeight = await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 1200));
      return document.body.scrollHeight;
    });

    if (newHeight === lastHeight) {
      sameCount++;
      if (sameCount >= 3) break;
    } else {
      sameCount = 0;
      lastHeight = newHeight;
    }
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1000);
}

function parseNumber(value) {
  if (!value) return null;

  let s = String(value)
    .replace(/\s/g, "")
    .replace(/[^0-9,.-]/g, "");

  if (!s) return null;

  const commaCount = (s.match(/,/g) || []).length;
  const dotCount = (s.match(/\./g) || []).length;

  if (commaCount > 0 && dotCount > 0) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (commaCount > 0 && dotCount === 0) {
    s = s.replace(",", ".");
  }

  const num = parseFloat(s);
  return Number.isFinite(num) ? num : null;
}

async function getDetailData(browser, ticker) {
  const page = await browser.newPage();

  try {
    await page.goto(`${DETAIL_URL}${ticker}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await sleep(2500);

    const data = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";

      function pick(regexList) {
        for (const rgx of regexList) {
          const m = text.match(rgx);
          if (m && m[1]) return m[1].trim();
        }
        return null;
      }

      const alis = pick([
        /Al(?:ış)?(?:\s+Seviyesi)?\s*[:\-]?\s*([0-9.,]+)/i,
        /AL\s*[:\-]?\s*([0-9.,]+)/i
      ]);

      const stop = pick([
        /Stop(?:\s+Seviyesi)?\s*[:\-]?\s*([0-9.,]+)/i,
        /STOP\s*[:\-]?\s*([0-9.,]+)/i
      ]);

      return { alis, stop };
    });

    return data;
  } catch (err) {
    return { alis: null, stop: null };
  } finally {
    await page.close();
  }
}

function formatTable(title, rows, timeText) {
  let out = `<pre>${escapeHtml(title)}\n`;
  if (timeText) out += `${escapeHtml(timeText)}\n\n`;

  out +=
    `${pad("No", 3)} ${pad("Hisse", 7)} ${pad("Alis", 10, true)} ${pad("STOP", 9, true)} ${pad("Risk%", 6, true)}\n` +
    `${pad("---", 3)} ${pad("------", 7)} ${pad("----------", 10, true)} ${pad("---------", 9, true)} ${pad("------", 6, true)}\n`;

  rows.forEach((r, i) => {
    out +=
      `${pad(i + 1, 3, true)} ${pad(r.hisse, 7)} ${pad(r.alisText, 10, true)} ${pad(r.stopText, 9, true)} ${pad(r.riskText, 6, true)}\n`;
  });

  out += `\nToplam: ${rows.length}</pre>`;
  return out;
}

(async () => {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(3000);

    await autoScroll(page);

    const hisseList = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      const lines = text.split("\n").map(x => x.trim()).filter(Boolean);

      const result = [];
      const seen = new Set();

      for (const line of lines) {
        const m = line.match(/\b([A-ZÇĞİÖŞÜ]{2,10})\b/g);
        if (!m) continue;

        for (const item of m) {
          const hisse = item.trim().toUpperCase();

          if (
            hisse.length >= 2 &&
            hisse.length <= 10 &&
            !seen.has(hisse) &&
            ![
              "BIST",
              "IMKB",
              "AL",
              "SAT",
              "STOP",
              "RISK",
              "TR",
              "EN",
              "TL"
            ].includes(hisse)
          ) {
            seen.add(hisse);
            result.push(hisse);
          }
        }
      }

      return result;
    });

    if (!hisseList.length) {
      await sendTelegram("Bot hatası: Hisse listesi alınamadı.");
      return;
    }

    const results = [];

    for (const hisse of hisseList) {
      const detail = await getDetailData(browser, hisse);

      const alisNum = parseNumber(detail.alis);
      const stopNum = parseNumber(detail.stop);

      if (alisNum == null || stopNum == null) continue;
      if (stopNum >= alisNum) continue;

      const risk = ((alisNum - stopNum) / alisNum) * 100;

      results.push({
        hisse,
        alis: alisNum,
        stop: stopNum,
        risk,
        alisText: detail.alis,
        stopText: detail.stop,
        riskText: risk.toFixed(2)
      });

      await sleep(500);
    }

    results.sort((a, b) => a.risk - b.risk);

    const now = new Date();
    const timeText =
      `Tarama saati: ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    if (!results.length) {
      await sendTelegram(`<pre>Guncel AL listesi\n${timeText}\n\nUygun veri bulunamadi.</pre>`);
      return;
    }

    const PART_SIZE = 25;

    for (let i = 0; i < results.length; i += PART_SIZE) {
      const part = results.slice(i, i + PART_SIZE);
      const isFirst = i === 0;
      const title =
        results.length > PART_SIZE
          ? `Guncel AL listesi${isFirst ? "" : " (devam)"}`
          : "Guncel AL listesi";

      const message = formatTable(title, part, isFirst ? timeText : "");
      await sendTelegram(message);
    }

  } catch (err) {
    try {
      await sendTelegram(`Bot hatasi:\n${String(err.message || err)}`);
    } catch (_) {
      console.error("Telegram'a hata da gonderilemedi:", err);
    }
  } finally {
    if (browser) await browser.close();
  }
})();
