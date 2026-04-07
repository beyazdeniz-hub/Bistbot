const puppeteer = require("puppeteer");
const { getInstalledBrowsers } = require("@puppeteer/browsers");
const axios = require("axios");
const os = require("os");
const path = require("path");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";
const DETAIL_URL = "https://www.turkishbulls.com/SignalPage.aspx?lang=tr&Ticker=";

const RISK_LIMIT = 5;
const TELEGRAM_CHUNK_SIZE = 25;
const DETAIL_DELAY_MS = 700;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad(value, width, right = false) {
  const s = String(value ?? "-").trim();
  if (s.length >= width) return s.slice(0, width);
  return right ? s.padStart(width, " ") : s.padEnd(width, " ");
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toNumber(value) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const num = parseFloat(normalized);
  return Number.isNaN(num) ? NaN : num;
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

async function sendTelegram(text, html = false) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik");
  }

  const payload = {
    chat_id: CHAT_ID,
    text: html ? text : text,
    disable_web_page_preview: true,
  };

  if (html) {
    payload.parse_mode = "HTML";
  }

  await axios.post(
    `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    payload,
    { timeout: 30000 }
  );
}

async function resolveChromePath() {
  const cacheDir =
    process.env.PUPPETEER_CACHE_DIR ||
    path.join(os.homedir(), ".cache", "puppeteer");

  const installed = await getInstalledBrowsers({ cacheDir });

  if (!installed.length) {
    throw new Error(`Kurulu Chrome bulunamadi. Cache klasoru: ${cacheDir}`);
  }

  const chromeCandidates = installed.filter((b) =>
    String(b.browser).toLowerCase().includes("chrome")
  );

  const selected =
    chromeCandidates[chromeCandidates.length - 1] ||
    installed[installed.length - 1];

  if (!selected || !selected.executablePath) {
    throw new Error("Chrome executablePath bulunamadi.");
  }

  console.log("Kullanilan browser:", selected.browser);
  console.log("Kullanilan buildId:", selected.buildId);
  console.log("Kullanilan executablePath:", selected.executablePath);

  return selected.executablePath;
}

async function safeGoto(page, url) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await sleep(3500);
}

async function getTickerCount(page) {
  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="SignalPage"]'));
    const set = new Set();

    for (const a of links) {
      const href = a.getAttribute("href") || a.href || "";
      const m = href.match(/Ticker=([A-Z]+)/i);
      if (m && m[1]) {
        set.add(m[1].toUpperCase());
      }
    }

    return set.size;
  });
}

async function forceInnerScrollables(page) {
  await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("*"));

    for (const el of nodes) {
      const style = window.getComputedStyle(el);
      const isScrollable =
        /(auto|scroll)/i.test(style.overflowY) &&
        el.scrollHeight > el.clientHeight + 50;

      if (isScrollable) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });
}

async function scrollToBottom(page) {
  let lastCount = 0;
  let stableRounds = 0;

  for (let round = 1; round <= 80; round++) {
    await page.evaluate(async () => {
      const doc = document.scrollingElement || document.documentElement || document.body;

      for (let i = 0; i < 8; i++) {
        const step = 1200;
        window.scrollBy(0, step);
        doc.scrollTop = doc.scrollTop + step;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    });

    await forceInnerScrollables(page);

    try {
      await page.keyboard.press("End");
    } catch (e) {}

    await sleep(1800);

    await page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, doc.scrollHeight);
      doc.scrollTop = doc.scrollHeight;
    });

    await forceInnerScrollables(page);
    await sleep(2000);

    const count = await getTickerCount(page);
    console.log(`Tur ${round} | ticker sayisi: ${count}`);

    if (count === lastCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
      lastCount = count;
    }

    if (stableRounds >= 4) {
      console.log("Yeni hisse gelmiyor, scroll tamamlandi.");
      break;
    }
  }

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, doc.scrollHeight);
      doc.scrollTop = doc.scrollHeight;
    });

    await forceInnerScrollables(page);
    await sleep(1800);
  }
}

async function collectTickers(page) {
  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="SignalPage"]'));
    const set = new Set();

    for (const a of links) {
      const href = a.getAttribute("href") || a.href || "";
      const match = href.match(/Ticker=([A-Z]+)/i);

      if (match && match[1]) {
        set.add(match[1].toUpperCase());
      }
    }

    return Array.from(set).sort((a, b) => a.localeCompare(b, "tr"));
  });
}

async function extractDetailLevels(detailPage, ticker) {
  await safeGoto(detailPage, `${DETAIL_URL}${ticker}`);

  return await detailPage.evaluate(() => {
    function clean(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    const bodyText = clean(document.body.innerText || "");

    function pick(regexList) {
      for (const regex of regexList) {
        const m = bodyText.match(regex);
        if (m && m[1]) {
          return m[1].trim();
        }
      }
      return "-";
    }

    const alSeviyesi = pick([
      /Alış\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Aliş\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Al\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /AL\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Alış[:\s]*([0-9.,]+)/i,
      /Al[:\s]*([0-9.,]+)/i,
    ]);

    const stoploss = pick([
      /Stoploss[:\s]*([0-9.,]+)/i,
      /Stop\s*Loss[:\s]*([0-9.,]+)/i,
      /Stoploss\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Stop\s*Loss\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Stop\s*Seviyesi[:\s]*([0-9.,]+)/i,
      /Stop[:\s]*([0-9.,]+)/i,
    ]);

    return {
      alSeviyesi,
      stoploss,
    };
  });
}

function buildTable(title, rows) {
  let text = `${title}\n\n`;
  text += `${pad("No", 3, true)} ${pad("Hisse", 6)} ${pad("Alis", 9, true)} ${pad("STOP", 9, true)} ${pad("Risk%", 6, true)}\n`;
  text += `${pad("---", 3)} ${pad("------", 6)} ${pad("---------", 9)} ${pad("---------", 9)} ${pad("------", 6)}\n`;

  rows.forEach((row, i) => {
    text += `${pad(i + 1, 3, true)} ${pad(row.ticker, 6)} ${pad(row.alis, 9, true)} ${pad(row.stop, 9, true)} ${pad(row.risk.toFixed(2), 6, true)}\n`;
  });

  text += `\nToplam: ${rows.length}`;
  return text;
}

function splitRowsForTelegram(title, rows, chunkSize = TELEGRAM_CHUNK_SIZE) {
  const messages = [];

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const chunkTitle = i === 0 ? title : `${title} (devam)`;
    messages.push(buildTable(chunkTitle, chunk));
  }

  return messages;
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
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    console.log("GitHub ayarlari eksik, upload atlandi:", remotePath);
    return null;
  }

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
      risk: row.risk.toFixed(2),
      current: null,
      change: null,
      grafikUrl: null,
    })),
  };
}

async function updateAppJsons(results, category) {
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

async function run() {
  const chromePath = await resolveChromePath();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200 });

    await safeGoto(page, URL);
    await scrollToBottom(page);

    const tickers = await collectTickers(page);

    console.log("Toplam hisse:", tickers.length);

    if (!tickers.length) {
      await sendTelegram("Bot hatasi:\nHisse listesi bos geldi.");
      return;
    }

    const detailPage = await browser.newPage();
    await detailPage.setViewport({ width: 1400, height: 2200 });

    const results = [];

    for (const ticker of tickers) {
      try {
        const detail = await extractDetailLevels(detailPage, ticker);

        const alisNum = toNumber(detail.alSeviyesi);
        const stopNum = toNumber(detail.stoploss);

        if (
          Number.isNaN(alisNum) ||
          Number.isNaN(stopNum) ||
          alisNum <= 0 ||
          stopNum >= alisNum
        ) {
          console.log(
            `ELENDI ${ticker} | alis=${detail.alSeviyesi} | stop=${detail.stoploss}`
          );
          await sleep(DETAIL_DELAY_MS);
          continue;
        }

        const risk = ((alisNum - stopNum) / alisNum) * 100;

        if (risk > RISK_LIMIT) {
          console.log(
            `RISK ELENDI ${ticker} | alis=${alisNum} | stop=${stopNum} | risk=${risk.toFixed(2)}`
          );
          await sleep(DETAIL_DELAY_MS);
          continue;
        }

        results.push({
          ticker,
          alis: detail.alSeviyesi,
          stop: detail.stoploss,
          risk,
        });

        console.log(
          `EKLENDI ${ticker} | alis=${detail.alSeviyesi} | stop=${detail.stoploss} | risk=${risk.toFixed(2)}`
        );
      } catch (e) {
        console.log(`Detay okunamadi ${ticker} | ${e.message}`);
      }

      await sleep(DETAIL_DELAY_MS);
    }

    await detailPage.close();

    results.sort((a, b) => a.risk - b.risk);

    if (!results.length) {
      await sendTelegram(`Risk <= ${RISK_LIMIT} uygun sinyal bulunamadi.`);
      return;
    }

    const messages = splitRowsForTelegram(
      `Risk <= ${RISK_LIMIT} Uygun Hisseler`,
      results
    );

    for (const message of messages) {
      await sendTelegram(`<pre>${escapeHtml(message)}</pre>`, true);
      await sleep(1200);
    }

    const category = getTimeCategory();
    await updateAppJsons(results, category);

    const summary =
      `NeuroTrade guncellendi.\n` +
      `Kategori: ${category}\n` +
      `Tarih: ${formatTurkeyDateTime()}\n` +
      `Toplam: ${results.length}`;

    await sendTelegram(summary);
  } finally {
    await browser.close();
  }
}

run().catch(async (err) => {
  console.log("BOT HATA:", err.message);

  try {
    await sendTelegram(`Bot hatasi:\n${err.message}`);
  } catch (e) {
    console.log("Telegram hata:", e.message);
  }
});
