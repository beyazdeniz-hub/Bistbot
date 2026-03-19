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
  if (!m) return "-";
  return m[0].replace(",", ".");
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

async function sendLongTelegramMessage(parts) {
  for (const part of parts) {
    await sendTelegramMessage(part);
    await sleep(1200);
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let stableCount = 0;
      let lastHeight = document.body.scrollHeight;

      const timer = setInterval(() => {
        window.scrollBy(0, 900);
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

      function onlyNumber(text) {
        const m = String(text || "").match(/-?\d+(?:[.,]\d+)?/);
        return m ? m[0] : "";
      }

      function scanNearby() {
        const els = Array.from(document.querySelectorAll("td, span, div, b, strong, font"));
        const arr = els
          .map(el => (el.innerText || "").replace(/\s+/g, " ").trim())
          .filter(Boolean);

        let al = "";
        let stop = "";

        for (let i = 0; i < arr.length; i++) {
          const t = arr[i].toLowerCase();

          if (!al && (t.includes("al seviyesi") || t.includes("alış seviyesi"))) {
            for (let j = i + 1; j <= i + 4 && j < arr.length; j++) {
              const n = onlyNumber(arr[j]);
              if (n) {
                al = n;
                break;
              }
            }
          }

          if (!stop && (t === "stop" || t.includes("stop seviyesi") || t.includes("zarar kes"))) {
            for (let j = i + 1; j <= i + 4 && j < arr.length; j++) {
              const n = onlyNumber(arr[j]);
              if (n) {
                stop = n;
                break;
              }
            }
          }
        }

        return { al, stop };
      }

      function byRegex(text, regexList) {
        for (const rgx of regexList) {
          const m = text.match(rgx);
          if (m && m[1]) return m[1].trim();
        }
        return "";
      }

      const near = scanNearby();

      const al =
        near.al ||
        byRegex(pageText, [
          /Al\s*Seviyesi\s*[:\-]?\s*([0-9.,]+)/i,
          /Alış\s*Seviyesi\s*[:\-]?\s*([0-9.,]+)/i
        ]);

      const stop =
        near.stop ||
        byRegex(pageText, [
          /Stop\s*Seviyesi\s*[:\-]?\s*([0-9.,]+)/i,
          /Stop\s*[:\-]?\s*([0-9.,]+)/i,
          /Zarar\s*Kes\s*[:\-]?\s*([0-9.,]+)/i
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

function buildTableLines(list) {
  const lines = [];
  lines.push(`${pad("No", 3)} ${pad("Hisse", 8, true)} ${pad("Al", 10)} ${pad("Stop", 10)}`);
  lines.push("-".repeat(36));

  list.forEach((item, i) => {
    lines.push(
      `${pad(i + 1, 3)} ${pad(item.ticker, 8, true)} ${pad(item.al, 10)} ${pad(item.stop, 10)}`
    );
  });

  lines.push("");
  lines.push(`Toplam: ${list.length}`);
  return lines;
}

function chunkLines(lines, maxLinesPerMessage = 25) {
  const chunks = [];
  for (let i = 0; i < lines.length; i += maxLinesPerMessage) {
    chunks.push(lines.slice(i, i + maxLinesPerMessage));
  }
  return chunks;
}

function buildMessageParts(title, now, list) {
  const lines = buildTableLines(list);
  const chunks = chunkLines(lines, 25);

  return chunks.map((chunk, index) => {
    const partNo = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : "";
    return `📊 <b>Turkishbulls Tarama</b>\n🕒 ${now}\n\n<b>${title}${partNo}</b>\n<pre>${chunk.join("\n")}</pre>`;
  });
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
          low.includes("al sinyali") ||
          low.includes(" buy ") ||
          low.startsWith("al ") ||
          low.includes(" al ");

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

      const allLinks = Array.from(
        document.querySelectorAll("a[href*='SignalPage.aspx?lang=tr&Ticker=']")
      );

      for (const a of allLinks) {
        const row = a.closest("tr");
        const rowText = txt(row || a);
        const low = rowText.toLowerCase();
        const ticker = findTickerFromLink(a) || findTickerInText(txt(a)) || findTickerInText(rowText);

        if (!ticker) continue;

        if (
          (low.includes("al sinyali") || low.includes(" buy ") || low.startsWith("al ") || low.includes(" al ")) &&
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

    const now = formatDateTR();
    const allParts = [];

    if (result.alList.length > 0) {
      allParts.push(...buildMessageParts("AL Sinyali Verenler", now, result.alList));
    } else {
      allParts.push(`📊 <b>Turkishbulls Tarama</b>\n🕒 ${now}\n\n❌ <b>AL sinyali veren hisse bulunamadı.</b>`);
    }

    if (result.earlyList.length > 0) {
      allParts.push(...buildMessageParts("Erken Alım Sinyali (Aşırı Satım)", now, result.earlyList));
    } else {
      allParts.push(`📊 <b>Turkishbulls Tarama</b>\n🕒 ${now}\n\nℹ️ <b>Aşırı satım listesinde hisse bulunamadı.</b>`);
    }

    await sendLongTelegramMessage(allParts);
  } catch (err) {
    console.error("Genel hata:", err);
    await sendTelegramMessage(`⚠️ Bot hata verdi:\n${err.message}`);
  } finally {
    await browser.close();
  }
}

scrape();
