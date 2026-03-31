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
const TV_HOME_URL = "https://tr.tradingview.com/";

const RISK_LIMIT = 5;
const MAX_ROWS = 400;
const DETAIL_DELAY_MS = 800;
const TELEGRAM_DELAY_MS = 1500;

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

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let sameCount = 0;
      let lastHeight = document.body.scrollHeight;

      const timer = setInterval(() => {
        window.scrollBy(0, 900);

        const newHeight = document.body.scrollHeight;
        if (newHeight === lastHeight) {
          sameCount += 1;
        } else {
          sameCount = 0;
          lastHeight = newHeight;
        }

        if (sameCount >= 8) {
          clearInterval(timer);
          resolve();
        }
      }, 1200);
    });
  });
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

async function collectAllRows(page) {
  await page.goto(URL, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await sleep(5000);

  let merged = [];

  for (let i = 0; i < 3; i++) {
    await autoScroll(page);
    await sleep(2500);

    const part = await extractRows(page);
    const map = new Map();

    for (const item of [...merged, ...part]) {
      if (!item?.ticker) continue;
      if (!map.has(item.ticker)) {
        map.set(item.ticker, item);
      }
    }

    merged = Array.from(map.values());
  }

  return merged.slice(0, MAX_ROWS);
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
      const nodes = Array.from(
        document.querySelectorAll("button, [role='button'], a, span, div")
      );

      for (const el of nodes) {
        const txt = (
          (el.innerText || "") +
          " " +
          (el.getAttribute?.("aria-label") || "")
        )
          .toLowerCase()
          .trim();

        if (
          txt.includes("tamam") ||
          txt.includes("kapat") ||
          txt.includes("anladım") ||
          txt.includes("got it") ||
          txt.includes("close") ||
          txt.includes("ok") ||
          txt.includes("accept")
        ) {
          try {
            el.click();
          } catch {}
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
        txt.includes("geçersiz sembol") ||
        txt.includes("invalid symbol") ||
        txt.includes("bulunamadı") ||
        txt.includes("not found") ||
        txt.includes("sembol sadece tradingview'de bulunabilir") ||
        txt.includes("symbol is only available on tradingview")
      );
    });
  } catch {
    return true;
  }
}

async function clickByText(page, textList) {
  return await page.evaluate((textList) => {
    const normalize = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    const targets = textList.map(normalize);
    const nodes = Array.from(
      document.querySelectorAll("a, button, [role='button'], span, div")
    );

    for (const node of nodes) {
      const txt = normalize(node.innerText || node.getAttribute?.("aria-label") || "");
      if (!txt) continue;

      if (targets.some((t) => txt === t || txt.includes(t))) {
        try {
          node.click();
          return true;
        } catch {}
      }
    }

    return false;
  }, textList);
}

async function typeTickerIntoSearch(page, ticker) {
  const candidates = [
    'input[type="text"]',
    'input[placeholder*="Ara"]',
    'input[placeholder*="ara"]',
    'input[placeholder*="Search"]',
    'input[data-role="search"]',
    'input',
  ];

  for (const sel of candidates) {
    const el = await page.$(sel);
    if (!el) continue;

    try {
      await el.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await el.type(`BIST:${ticker}`, { delay: 80 });
      return true;
    } catch {}
  }

  return false;
}

async function chooseTickerFromResults(page, ticker) {
  const ok = await page.evaluate((ticker) => {
    const normalize = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    const want1 = normalize(`BIST:${ticker}`);
    const want2 = normalize(ticker);

    const nodes = Array.from(
      document.querySelectorAll("a, button, [role='button'], div, span")
    );

    for (const node of nodes) {
      const txt = normalize(node.innerText || "");
      if (!txt) continue;

      if (
        txt.includes(want1) ||
        txt === want2 ||
        txt.startsWith(`${want2} `) ||
        txt.includes(` ${want2} `)
      ) {
        try {
          node.click();
          return true;
        } catch {}
      }
    }

    return false;
  }, ticker);

  if (ok) return true;

  try {
    await page.keyboard.press("ArrowDown");
    await sleep(600);
    await page.keyboard.press("Enter");
    return true;
  } catch {
    return false;
  }
}

async function openSuperchartsAndSearch(page, ticker) {
  await page.goto(TV_HOME_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await sleep(5000);
  await dismissTradingViewPopups(page);
  await sleep(1500);

  const clickedProducts = await clickByText(page, ["Ürünler", "Urunler", "Products"]);
  if (!clickedProducts) {
    return false;
  }

  await sleep(1500);

  const clickedSupercharts = await clickByText(page, [
    "Süpergrafikler",
    "Supercharts",
    "Süper Grafikler",
  ]);
  if (!clickedSupercharts) {
    return false;
  }

  await sleep(5000);
  await dismissTradingViewPopups(page);
  await sleep(1500);

  const typed = await typeTickerIntoSearch(page, ticker);
  if (!typed) {
    return false;
  }

  await sleep(2500);

  const chosen = await chooseTickerFromResults(page, ticker);
  if (!chosen) {
    return false;
  }

  await sleep(7000);
  await dismissTradingViewPopups(page);
  await sleep(2000);

  return true;
}

async function captureTradingViewImage(browser, ticker, outFile) {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1440, height: 900 });

    let opened = await openSuperchartsAndSearch(page, ticker);

    if (!opened) {
      const fallbackUrl = `https://tr.tradingview.com/chart/?symbol=${encodeURIComponent(`BIST:${ticker}`)}`;

      await page.goto(fallbackUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await sleep(7000);
      await dismissTradingViewPopups(page);
      await sleep(1500);
    }

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
  } catch {
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
Risk: %${Number(row.risk).toFixed(2)}`;

  if (row.current) {
    caption += `\nGüncel: ${row.current}`;
  }

  if (row.change) {
    caption += `\nFark: %${row.change}`;
  }

  return caption;
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
      grafikUrl: row.grafikUrl ?? null,
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

async function run() {
  ensureDir(TEMP_DIR);

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
          console.log(
            `HATALI SAYI ${r.ticker} | alis=${alis} | stop=${stop}`
          );
          await sleep(DETAIL_DELAY_MS);
          continue;
        }

        if (s >= a) {
          console.log(
            `STOP ALISTAN BUYUK/EŞIT ${r.ticker} | alis=${a} | stop=${s}`
          );
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
          grafikUrl: null,
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
Risk: %${Number(row.risk).toFixed(2)}${row.current ? `\nGüncel: ${row.current}` : ""}${row.change ? `\nFark: %${row.change}` : ""}`;
          await sendTelegram(text);
        }

        await sleep(TELEGRAM_DELAY_MS);
      } catch (e) {
        console.log(`Grafik/telegram hata: ${row.ticker} - ${e.message}`);
      }
    }

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