const puppeteer = require("puppeteer");
const axios = require("axios");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad(value, width, right = false) {
  const s = String(value ?? "-").trim();
  if (s.length >= width) return s.slice(0, width);
  return right ? s.padEnd(width, " ") : s.padStart(width, " ");
}

function cleanText(v) {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function normalizePrice(v) {
  if (!v) return "-";
  let s = cleanText(v);

  const m = s.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return s || "-";

  s = m[0].replace(",", ".");
  return s;
}

function formatDateTR() {
  return new Date().toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul"
  });
}

async function sendTelegramMessage(text) {
  if (!TOKEN || !CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik.");
    return;
  }

  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  try {
    await axios.post(url, {
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML"
    });
    console.log("Telegram mesajı gönderildi.");
  } catch (err) {
    console.error("Telegram gönderim hatası:", err.response?.data || err.message);
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      let distance = 800;
      let stableCount = 0;
      let lastHeight = document.body.scrollHeight;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;

        const newHeight = document.body.scrollHeight;

        if (newHeight === lastHeight) {
          stableCount += 1;
        } else {
          stableCount = 0;
          lastHeight = newHeight;
        }

        if (stableCount >= 6) {
          clearInterval(timer);
          window.scrollTo(0, document.body.scrollHeight);
          resolve();
        }
      }, 700);
    });
  });
}

async function readDetailData(browser, ticker) {
  const detailPage = await browser.newPage();

  try {
    await detailPage.goto(`${DETAIL_URL}${ticker}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await sleep(2500);

    const detail = await detailPage.evaluate(() => {
      const pageText = document.body ? document.body.innerText : "";

      function getByRegex(text, regexList) {
        for (const rgx of regexList) {
          const m = text.match(rgx);
          if (m && m[1]) return m[1].trim();
        }
        return "";
      }

      function findValueNearKeywords() {
        const candidates = [];

        const allEls = Array.from(document.querySelectorAll("td, span, div, b, strong, font"));
        for (const el of allEls) {
          const txt = (el.innerText || "").replace(/\s+/g, " ").trim();
          if (!txt) continue;
          candidates.push(txt);
        }

        let al = "";
        let stop = "";

        for (let i = 0; i < candidates.length; i++) {
          const t = candidates[i].toLowerCase();

          if (!al && (t.includes("al seviyesi") || t === "al" || t.includes("alış seviyesi"))) {
            for (let j = i; j <= i + 3 && j < candidates.length; j++) {
              const m = candidates[j].match(/-?\d+(?:[.,]\d+)?/);
              if (m) {
                al = m[0];
                break;
              }
            }
          }

          if (!stop && (t.includes("stop") || t.includes("zarar kes"))) {
            for (let j = i; j <= i + 3 && j < candidates.length; j++) {
              const m = candidates[j].match(/-?\d+(?:[.,]\d+)?/);
              if (m) {
                stop = m[0];
                break;
              }
            }
          }
        }

        return { al, stop };
      }

      const near = findValueNearKeywords();

      let al =
        near.al ||
        getByRegex(pageText, [
          /Al\s*Seviyesi[:\s]*([0-9.,]+)/i,
          /Alış\s*Seviyesi[:\s]*([0-9.,]+)/i,
          /\bAL[:\s]*([0-9.,]+)/i
        ]);

      let stop =
        near.stop ||
        getByRegex(pageText, [
          /Stop[:\s]*([0-9.,]+)/i,
          /Zarar\s*Kes[:\s]*([0-9.,]+)/i,
          /\bSTOP[:\s]*([0-9.,]+)/i
        ]);

      return { al, stop };
    });

    return {
      al: normalizePrice(detail.al),
      stop: normalizePrice(detail.stop)
    };
  } catch (err) {
    console.log(`${ticker} detay okunamadı:`, err.message);
    return { al: "-", stop: "-" };
  } finally {
    await detailPage.close();
  }
}

async function scrape() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await sleep(3000);
    await autoScroll(page);
    await sleep(2000);

    const result = await page.evaluate(() => {
      function txt(el) {
        return (el?.innerText || el?.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
      }

      function findTickerInText(text) {
        const m = text.match(/\b[A-ZÇĞİÖŞÜ]{3,10}\b/g);
        return m ? m[0] : "";
      }

      function findTickerFromLink(a) {
        const href = a?.getAttribute("href") || "";
        const m = href.match(/Ticker=([A-Z0-9ÇĞİÖŞÜ]+)/i);
        return m ? m[1].toUpperCase() : "";
      }

      const allRows = Array.from(document.querySelectorAll("tr"));
      const alList = [];
      const earlyList = [];
      const seenAl = new Set();
      const seenEarly = new Set();

      for (const row of allRows) {
        const rowText = txt(row);
        if (!rowText) continue;

        const low = rowText.toLowerCase();
        const links = Array.from(row.querySelectorAll("a"));

        let ticker = "";
        for (const a of links) {
          ticker = findTickerFromLink(a) || findTickerInText(txt(a)) || ticker;
          if (ticker) break;
        }
        if (!ticker) ticker = findTickerInText(rowText);

        if (!ticker) continue;

        const isBuy =
          low.includes("al") ||
          low.includes("buy") ||
          low.includes("al sinyali");

        const isOversold =
          low.includes("aşırı satım") ||
          low.includes("asiri satim") ||
          low.includes("oversold");

        if (isBuy && !seenAl.has(ticker)) {
          seenAl.add(ticker);
          alList.push({ ticker });
        }

        if (isOversold && !seenEarly.has(ticker) && !seenAl.has(ticker)) {
          seenEarly.add(ticker);
          earlyList.push({ ticker });
        }
      }

      if (alList.length === 0) {
        const allLinks = Array.from(document.querySelectorAll("a[href*='SignalPage.aspx?lang=tr&Ticker=']"));
        for (const a of allLinks) {
          const row = a.closest("tr");
          const rowText = txt(row || a);
          const low = rowText.toLowerCase();
          const ticker = findTickerFromLink(a) || findTickerInText(txt(a)) || findTickerInText(rowText);

          if (!ticker) continue;

          if (
            (low.includes("al") || low.includes("buy") || low.includes("al sinyali")) &&
            !seenAl.has(ticker)
          ) {
            seenAl.add(ticker);
            alList.push({ ticker });
          }

          if (
            (low.includes("aşırı satım") || low.includes("asiri satim") || low.includes("oversold")) &&
            !seenEarly.has(ticker) &&
            !seenAl.has(ticker)
          ) {
            seenEarly.add(ticker);
            earlyList.push({ ticker });
          }
        }
      }

      return { alList, earlyList };
    });

    console.log("Bulunan AL listesi:", result.alList);
    console.log("Bulunan ERKEN listesi:", result.earlyList);

    for (const item of result.alList) {
      const detail = await readDetailData(browser, item.ticker);
      item.al = detail.al;
      item.stop = detail.stop;
      await sleep(700);
    }

    for (const item of result.earlyList) {
      const detail = await readDetailData(browser, item.ticker);
      item.al = detail.al;
      item.stop = detail.stop;
      await sleep(700);
    }

    let message = `📊 <b>Turkishbulls Tarama</b>\n🕒 ${formatDateTR()}\n\n`;

    if (result.alList.length > 0) {
      message += `<b>AL Sinyali Verenler</b>\n`;
      message += `<pre>`;
      message += `${pad("Hisse", 10, true)} ${pad("Al", 10)} ${pad("Stop", 10)}\n`;
      message += `${"-".repeat(32)}\n`;

      for (const item of result.alList) {
        message += `${pad(item.ticker, 10, true)} ${pad(item.al, 10)} ${pad(item.stop, 10)}\n`;
      }

      message += `</pre>\n`;
    } else {
      message += `❌ Şu anda AL sinyali veren hisse bulunamadı.\n\n`;
    }

    if (result.earlyList.length > 0) {
      message += `\n<b>Erken Alım Sinyali (Aşırı Satım)</b>\n`;
      message += `<pre>`;
      message += `${pad("Hisse", 10, true)} ${pad("Al", 10)} ${pad("Stop", 10)}\n`;
      message += `${"-".repeat(32)}\n`;

      for (const item of result.earlyList) {
        message += `${pad(item.ticker, 10, true)} ${pad(item.al, 10)} ${pad(item.stop, 10)}\n`;
      }

      message += `</pre>`;
    }

    await sendTelegramMessage(message);
  } catch (err) {
    console.error("Genel hata:", err);
    await sendTelegramMessage(`⚠️ Bot hata verdi:\n${err.message}`);
  } finally {
    await browser.close();
  }
}

scrape();
