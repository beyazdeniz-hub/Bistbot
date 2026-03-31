const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const RISK_LIMIT = 5;
const MAX_ROWS = 400;
const DETAIL_DELAY_MS = 800;
const TELEGRAM_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function formatTurkeyDateTime() {
  return new Date().toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTurkeyDateOnly() {
  return new Date().toLocaleDateString("tr-TR", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
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

async function getLivePrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}.IS`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data?.quoteResponse?.result?.[0]?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

async function scrollStep(page, step = 1200, waitMs = 900) {
  await page.evaluate((y) => {
    window.scrollBy(0, y);
  }, step);

  await sleep(waitMs);
}

async function scrollToBottomHard(page) {
  let lastHeight = 0;
  let stableRounds = 0;

  for (let i = 0; i < 25; i++) {
    const height = await page.evaluate(() => {
      return Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
    });

    await page.evaluate((h) => {
      window.scrollTo(0, h);
    }, height);

    await sleep(1500);

    const newHeight = await page.evaluate(() => {
      return Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
    });

    if (newHeight === lastHeight) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      lastHeight = newHeight;
    }

    if (stableRounds >= 4) break;
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
      const href = link?.href || "";
      const ticker =
        href.match(/Ticker=([A-Z]+)/)?.[1] ||
        (link?.innerText || "").trim().toUpperCase();

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
      if (!r?.ticker) return false;
      if (seen.has(r.ticker)) return false;
      seen.add(r.ticker);
      return true;
    });
  });
}

function mergeUniqueRows(...parts) {
  const map = new Map();

  for (const arr of parts) {
    for (const item of arr || []) {
      if (!item?.ticker) continue;
      if (!map.has(item.ticker)) {
        map.set(item.ticker, item);
      }
    }
  }

  return Array.from(map.values());
}

async function autoScrollAndCollect(page) {
  let merged = [];
  let lastCount = 0;
  let noGrowthRounds = 0;

  for (let round = 1; round <= 30; round++) {
    for (let s = 0; s < 4; s++) {
      await scrollStep(page, 1200, 1000);
    }

    await sleep(1800);

    const part = await extractRows(page);
    merged = mergeUniqueRows(merged, part);

    const count = merged.length;
    console.log(`Scroll turu ${round} | bulunan ticker: ${count}`);

    if (count > lastCount) {
      lastCount = count;
      noGrowthRounds = 0;
    } else {
      noGrowthRounds += 1;
    }

    if (noGrowthRounds >= 4) {
      console.log("Yeni ticker artışı durdu, son dip taraması yapılıyor...");
      break;
    }
  }

  await scrollToBottomHard(page);
  await sleep(2500);

  const finalPart = await extractRows(page);
  merged = mergeUniqueRows(merged, finalPart);

  console.log(`Final tarama sonrası toplam ticker: ${merged.length}`);

  return merged.slice(0, MAX_ROWS);
}

async function collectAllRows(page) {
  await page.goto(URL, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await sleep(5000);

  const rows = await autoScrollAndCollect(page);

  return rows.slice(0, MAX_ROWS);
}

async function extractDetailLevels(page, ticker) {
  await page.goto(`${DETAIL_URL}${ticker}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await sleep(2200);

  return await page.evaluate(() => {
    const text = (document.body.innerText || "").replace(/\u00a0/g, " ");

    const al =
      text.match(/Alış\s*Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Aliş\s*Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Al\s*Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/AL\s*Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Alış[:\s]*([0-9.,]+)/i)?.[1] ||
      null;

    const stop =
      text.match(/Stoploss\s*Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Stop\s*Loss\s*Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Stop\s*Seviyesi[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Stoploss[:\s]*([0-9.,]+)/i)?.[1] ||
      text.match(/Stop\s*Loss[:\s]*([0-9.,]+)/i)?.[1] ||
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

async function getGitHubJson(remotePath, fallback = null) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return fallback;

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${remotePath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      timeout: 20000,
    });

    const base64 = res.data?.content || "";
    const raw = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function uploadContentToGithub(remotePath, contentString, message) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return null;

  const content = Buffer.from(contentString, "utf8").toString("base64");
  const sha = await getExistingGitHubSha(remotePath);

  await axios.put(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${remotePath}`,
    {
      message,
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

  return true;
}

async function uploadJsonToGithub(remotePath, data, message) {
  return uploadContentToGithub(
    remotePath,
    JSON.stringify(data, null, 2),
    message
  );
}

function buildAppPayload(results, updatedAt) {
  return {
    updatedAt,
    signals: results.map((row) => ({
      ticker: row.ticker,
      alis: row.alis,
      stop: row.stop,
      risk: Number(row.risk).toFixed(2),
      current: row.current ?? null,
      change: row.change ?? null,
      grafikUrl: null,
    })),
  };
}

async function updateAppJsons(results, category) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    console.log("GitHub ayarları eksik, json dosyaları güncellenemedi.");
    return;
  }

  const updatedAt = formatTurkeyDateTime();
  const payload = buildAppPayload(results, updatedAt);

  await uploadJsonToGithub(
    "signals.json",
    payload,
    `update signals.json ${updatedAt}`
  );

  if (category === "seans") {
    await uploadJsonToGithub(
      "seans.json",
      payload,
      `update seans.json ${updatedAt}`
    );
  }

  if (category === "onay") {
    await uploadJsonToGithub(
      "onay.json",
      payload,
      `update onay.json ${updatedAt}`
    );

    const history = (await getGitHubJson("history.json", {})) || {};
    const today = formatTurkeyDateOnly();

    history[today] = {
      date: today,
      updatedAt,
      signals: payload.signals,
    };

    await uploadJsonToGithub(
      "history.json",
      history,
      `update history.json ${updatedAt}`
    );
  }
}

function buildSignalText(row) {
  let text =
`${row.ticker}
Alış: ${row.alis}
Stop: ${row.stop}
Risk: %${Number(row.risk).toFixed(2)}`;

  if (row.current) {
    text += `\nGüncel: ${row.current}`;
  }

  if (row.change) {
    text += `\nFark: %${row.change}`;
  }

  return text;
}

async function run() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });

    const rows = await collectAllRows(page);

    if (!rows.length) {
      await sendTelegram("Bot hatası: liste boş geldi.");
      return;
    }

    console.log(`Bulunan toplam satır: ${rows.length}`);

    const detailPage = await browser.newPage();
    await detailPage.setViewport({ width: 1400, height: 2200 });

    const results = [];

    for (const r of rows) {
      try {
        const detail = await extractDetailLevels(detailPage, r.ticker);

        const alis = detail.al;
        const stop = detail.stop;

        if (!alis || !stop) {
          console.log(
            `SEVIYE YOK ${r.ticker} | detail.al=${detail.al} | detail.stop=${detail.stop} | listAlis=${r.alis} | listSon=${r.son}`
          );
          await sleep(DETAIL_DELAY_MS);
          continue;
        }

        const a = toNumber(alis);
        const s = toNumber(stop);

        if (isNaN(a) || isNaN(s) || a <= 0) {
          console.log(`HATALI SAYI ${r.ticker} | alis=${alis} | stop=${stop}`);
          await sleep(DETAIL_DELAY_MS);
          continue;
        }

        if (s >= a) {
          console.log(`STOP ALISTAN BUYUK/EŞIT ${r.ticker} | alis=${a} | stop=${s}`);
          await sleep(DETAIL_DELAY_MS);
          continue;
        }

        const risk = ((a - s) / a) * 100;

        if (risk > RISK_LIMIT) {
          console.log(
            `RISK ELENDI ${r.ticker} | alis=${a} | stop=${s} | risk=${risk.toFixed(2)}`
          );
          await sleep(DETAIL_DELAY_MS);
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
        });

        console.log(
          `EKLENDI ${r.ticker} | alis=${a} | stop=${s} | risk=${risk.toFixed(2)}`
        );

        await sleep(DETAIL_DELAY_MS);
      } catch (e) {
        console.log(`Detay okunamadı: ${r.ticker} | ${e.message}`);
      }
    }

    await detailPage.close();

    results.sort((a, b) => Number(a.risk) - Number(b.risk));

    if (!results.length) {
      await sendTelegram(`Risk <= ${RISK_LIMIT} uygun sinyal bulunamadı.`);
      return;
    }

    for (const row of results) {
      try {
        await sendTelegram(buildSignalText(row));
        await sleep(TELEGRAM_DELAY_MS);
      } catch (e) {
        console.log(`Telegram hata: ${row.ticker} - ${e.message}`);
      }
    }

    const category = getTimeCategory();
    await updateAppJsons(results, category);

    let summary = `Sinyaller (${category})\n`;
    summary += `Tarama zamanı: ${formatTurkeyDateTime()}\n`;
    summary += `Risk limiti: %${RISK_LIMIT}\n\n`;

    for (const r of results) {
      summary += `${r.ticker} | ${r.alis} | ${r.stop} | %${Number(r.risk).toFixed(2)}\n`;
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