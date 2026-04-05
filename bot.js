const axios = require("axios");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URL = "https://www.turkishbulls.com/SignalList.aspx?lang=tr&MarketSymbol=IMKB";

async function sendMessage(text) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
  });
}

async function run() {
  try {
    const res = await axios.get(URL);
    const html = res.data;

    const matches = [...html.matchAll(/SignalPage\.aspx\?lang=tr&Ticker=([^"]+)/g)];

    const tickers = [...new Set(matches.map(m => m[1]))];

    let text = "<b>📊 Turkishbulls Hisseler</b>\n\n";

    tickers.slice(0, 20).forEach((t, i) => {
      text += `${i + 1}. ${t}\n`;
    });

    await sendMessage(text);

    console.log("Gönderildi");
  } catch (err) {
    console.error(err);
  }
}

run();