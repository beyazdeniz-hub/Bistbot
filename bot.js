const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const TEMP_DIR = "tmp_charts";
const TV_BASE_URL = "https://tr.tradingview.com/chart/Ui8NJlOz/";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toNumber(value) {
  const n = Number(String(value ?? "").replace(",", ".").replace(/[^\d.-]/g, ""));
  return isNaN(n) ? NaN : n;
}

function getTurkeyNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Istanbul" })
  );
}

function getTimeCategory() {
  const hour = getTurkeyNow().getHours();
  if (hour === 21) return "onay";
  if (hour >= 9 && hour <= 18) return "seans";
  return "diger";
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik");
  }

  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
  });
}

async function sendTelegramPhoto(filePath, caption) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik");
  }

  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  form.append("photo", fs.createReadStream(filePath));
  form.append("caption", caption);

  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
  });
}

async function getLivePrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}.IS`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data?.quoteResponse?.result?.[0]?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

async function extractRows(page) {
  return await page.evaluate(() => {
    const rows = [];
    const trs = Array.from(document.querySelectorAll("tr")).filter((tr) =>
      tr.querySelector('a[href*="SignalPage"]')
    );

    for (const tr of trs) {
      const link = tr.querySelector('a[href*="SignalPage"]');
      const ticker = link?.href.match(/Ticker=([A-Z]+)/)?.[1];
      if (!ticker) continue;

      const cells = Array.from(tr.querySelectorAll("td")).map((x) =>
        (x.innerText || "").trim()
      );

      rows.push({
        ticker,
        alis: cells[1] || "",
        son: cells[2] || "",
      });
    }

    const seen = new Set();
    return rows.filter((r) => {
      if (seen.has(r.ticker)) return false;
      seen.add(r.ticker);
      return true;
    });
  });
}

async function extractDetailLevels(page, ticker) {
  await page.goto(`${DETAIL_URL}${ticker}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await sleep(2000);

  return await page.evaluate(() => {
    const text = document.body.innerText || "";

    const al =
      text.match(/Al Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/AL Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      null;

    const stop =
      text.match(/Stoploss[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Stop Loss[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Stop[:\s]*([0-9.,]+)/i)?.[1] ||
      null;

    return { al, stop };
  });
}

async function getExistingGitHubSha(remotePath) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return null;

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${remotePath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      timeout: 20000,
    });

    return res.data?.sha || null;
  } catch {
    return null;
  }
}

async function uploadFileToGithub(localPath, remotePath) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return null;

  const content = fs.readFileSync(localPath, "base64");
  const sha = await getExistingGitHubSha(remotePath);

  await axios.put(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${remotePath}`,
    {
      message: `chart upload: ${remotePath}`,
      content,
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      timeout: 30000,
    }
  );

  return `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GITHUB_BRANCH}/${remotePath}`;
}

async function dismissTradingViewPopups(page) {
  try {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
      for (const b of buttons) {
        const t = ((b.innerText || "") + " " + (b.getAttribute("aria-label") || "")).toLowerCase();
        if (
          t.includes("tamam") ||
          t.includes("close") ||
          t.includes("kapat") ||
          t.includes("ok") ||
          t.includes("anladım") ||
          t.includes("got it")
        ) {
          try {
            b.click();
          } catch (e) {}
        }
      }
    });
  } catch {}
}

async function isTradingViewInvalid(page) {
  try {
    return await page.evaluate(() => {
      const txt = (document.body.innerText || "").toLowerCase();
      return (
        txt.includes("sembol sadece tradingview'de bulunabilir") ||
        txt.includes("symbol is only available on tradingview") ||
        txt.includes("geçersiz sembol") ||
        txt.includes("invalid symbol") ||
        txt.includes("bulunamadı")
      );
    });
  } catch {
    return true;
  }
}

async function captureTradingViewImage(browser, ticker, outFile) {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1400, height: 900 });

    const tvUrl = `${TV_BASE_URL}?symbol=${encodeURIComponent(`BIST:${ticker}`)}`;

    await page.goto(tvUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await sleep(8000);
    await dismissTradingViewPopups(page);
    await sleep(2000);

    const invalid = await isTradingViewInvalid(page);
    if (invalid) {
      return false;
    }

    await page.screenshot({
      path: outFile,
      type: "png",
      fullPage: false,
    });

    return true;
  } catch (e) {
    return false;
  } finally {
    await page.close();
  }
}

async function generateChart(row, folder, browser) {
  ensureDir(TEMP_DIR);

  const finalFile = path.join(TEMP_DIR, `${row.ticker}.png`);
  const ok = await captureTradingViewImage(browser, row.ticker, finalFile);

  if (!ok || !fs.existsSync(finalFile)) {
    return { file: null, grafikUrl: null, usedReal: false };
  }

  const remote = `charts/${folder}/${row.ticker}.png`;
  const grafikUrl = await uploadFileToGithub(finalFile, remote);

  return { file: finalFile, grafikUrl, usedReal: true };
}

function buildCaption(row) {
  let caption =
`${row.ticker}
Alış: ${row.alis}
Stop: ${row.stop}
Risk: %${row.risk.toFixed(2)}`;

  if (row.current) {
    caption += `\nGüncel: ${row.current}`;
  }

  if (row.change) {
    caption += `\nFark: %${row.change}`;
  }

  return caption;
}

async function run() {
  ensureDir(TEMP_DIR);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });

    await page.goto(URL, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await sleep(5000);

    const rows = await extractRows(page);

    if (!rows.length) {
      await sendTelegram("Bot hatası: liste boş geldi.");
      return;
    }

    const detailPage = await browser.newPage();
    await detailPage.setViewport({ width: 1400, height: 2200 });

    const results = [];

    for (const r of rows) {
      try {
        const detail = await extractDetailLevels(detailPage, r.ticker);

        const alis = detail.al || r.alis;
        const stop = detail.stop || r.son;

        const a = toNumber(alis);
        const s = toNumber(stop);

        if (isNaN(a) || isNaN(s) || s >= a || a <= 0) {
          continue;
        }

        const risk = ((a - s) / a) * 100;
        if (risk > 3) {
          continue;
        }

        const live = await getLivePrice(r.ticker);
        let change = null;

        if (live && !isNaN(live)) {
          change = (((live - a) / a) * 100).toFixed(2);
        }

        results.push({
          ticker: r.ticker,
          alis,
          stop,
          risk,
          current: live ? Number(live).toFixed(2) : null,
          change,
          grafikUrl: null,
        });

        await sleep(300);
      } catch (e) {
        console.log(`Detay okunamadı: ${r.ticker}`);
      }
    }

    await detailPage.close();

    if (!results.length) {
      await sendTelegram("Risk <= 3 uygun sinyal bulunamadı.");
      return;
    }

    const category = getTimeCategory();

    for (const row of results) {
      try {
        const { file, grafikUrl, usedReal } = await generateChart(row, category, browser);
        row.grafikUrl = grafikUrl || null;

        if (usedReal && file) {
          const caption = buildCaption(row);
          await sendTelegramPhoto(file, caption);
        } else {
          const text =
`${row.ticker}
Alış: ${row.alis}
Stop: ${row.stop}
Risk: %${row.risk.toFixed(2)}${row.current ? `\nGüncel: ${row.current}` : ""}${row.change ? `\nFark: %${row.change}` : ""}`;
          await sendTelegram(text);
        }

        await sleep(1500);
      } catch (e) {
        console.log(`Grafik/telegram hata: ${row.ticker} - ${e.message}`);
      }
    }

    let summary = `Sinyaller (${category})\n\n`;
    for (const r of results) {
      summary += `${r.ticker} | ${r.alis} | ${r.stop} | %${r.risk.toFixed(2)}\n`;
    }
    summary += `\nToplam: ${results.length}`;

    await sendTelegram(summary);
  } finally {
    await browser.close();
  }
}

run().catch(async (err) => {
  console.log("BOT HATA:", err.message);
  try {
    await sendTelegram(`Bot hatası:\n${err.message}`);
  } catch (e) {
    console.log("Telegram hata gönderimi başarısız:", e.message);
  }
});