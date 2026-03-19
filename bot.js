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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegram(text) {
  const api = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  await axios.post(api, {
    chat_id: CHAT_ID,
    text: `<pre>${escapeHtml(text)}</pre>`,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function autoScroll(page) {
  for (let i = 0; i < 50; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000));
    await sleep(500);
  }
}

async function extractRows(page) {
  return await page.evaluate(() => {
    function clean(t) {
      return String(t || "").replace(/\s+/g, " ").trim();
    }

    function getTicker(href) {
      const m = href.match(/Ticker=([A-Z]+)/);
      return m ? m[1] : null;
    }

    const rows = [];
    const trs = document.querySelectorAll("tr");

    trs.forEach(tr => {
      const link = tr.querySelector('a[href*="SignalPage"]');
      if (!link) return;

      const ticker = getTicker(link.href);
      const cells = Array.from(tr.querySelectorAll("td")).map(x => clean(x.innerText));

      if (cells.length >= 3) {
        rows.push({
          ticker,
          alis: cells[1],
          son: cells[2]
        });
      }
    });

    const seen = new Set();
    return rows.filter(r => {
      if (seen.has(r.ticker)) return false;
      seen.add(r.ticker);
      return true;
    });
  });
}

async function extractDetail(page, ticker) {
  await page.goto(`${DETAIL_URL}${ticker}`, { waitUntil: "networkidle2" });
  await sleep(1500);

  return await page.evaluate(() => {
    const txt = document.body.innerText;

    function pick(r) {
      const m = txt.match(r);
      return m ? m[1] : "-";
    }

    return {
      al: pick(/Al Seviyesi[:\s]*([0-9.,]+)/i),
      stop: pick(/Stop.*?([0-9.,]+)/i)
    };
  });
}

function calcRisk(alis, stop) {
  const a = parseFloat(String(alis).replace(",", "."));
  const s = parseFloat(String(stop).replace(",", "."));
  if (!a || !s) return null;
  return ((a - s) / a) * 100;
}

function buildTable(title, rows) {
  let t = `${title}\n\n`;
  t += `${pad("No",3,true)} ${pad("Hisse",6)} ${pad("Alis",9,true)} ${pad("STOP",9,true)} ${pad("Risk%",6,true)}\n`;
  t += "---------------------------------------------\n";

  rows.forEach((r,i)=>{
    t += `${pad(i+1,3,true)} ${pad(r.ticker,6)} ${pad(r.alis,9,true)} ${pad(r.son,9,true)} ${pad(r.risk.toFixed(2),6,true)}\n`;
  });

  t += `\nToplam: ${rows.length}`;
  return t;
}

function split(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 25) {
    out.push(rows.slice(i, i + 25));
  }
  return out;
}

async function run() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: "networkidle2" });

    await sleep(4000);
    await autoScroll(page);

    let rows = await extractRows(page);

    const dpage = await browser.newPage();

    for (const r of rows) {
      const d = await extractDetail(dpage, r.ticker);

      if (d.al !== "-") r.alis = d.al;
      if (d.stop !== "-") r.son = d.stop;

      r.risk = calcRisk(r.alis, r.son);
    }

    await dpage.close();

    // 🎯 FİLTRE + SIRALAMA
    rows = rows
      .filter(r => r.risk !== null)
      .filter(r => r.risk >= 0)
      .filter(r => r.risk <= 3)
      .sort((a,b) => a.risk - b.risk);

    if (!rows.length) {
      await sendTelegram("Filtreye uygun hisse yok");
      return;
    }

    // 🔥 TOP 5
    const top5 = rows.slice(0,5);
    await sendTelegram(buildTable("🔥 EN İYİ 5 HİSSE", top5));

    // 📊 TAM LİSTE
    const parts = split(rows);
    for (let i=0;i<parts.length;i++) {
      const title = i===0 ? "GUNCEL AL LISTESI" : "DEVAM";
      await sendTelegram(buildTable(title, parts[i]));
      await sleep(500);
    }

  } finally {
    await browser.close();
  }
}

run().catch(console.error);
