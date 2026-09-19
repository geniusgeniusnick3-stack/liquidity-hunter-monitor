/**
 * Prints the chat reply for a given scan result, in every language.
 * Used to check what a user actually receives before it reaches Telegram.
 */
import { formatScanReply } from "../lib/notify/formatters.js";
import type { Language } from "../lib/notify/i18n.js";

// Case 1: nothing found (the common case — must stay short and readable)
const empty = {
  scope: "TRXUSDT 4H",
  events: [],
  approaches: [],
  historySkipped: [],
  symbolCount: 1,
  latestCandleTime: Math.floor(Date.now() / 1000),
  scanned: 1,
  failures: 0,
};

// Case 2: something happened
const busy = {
  scope: "all tracked symbols",
  events: [
    { symbol: "XLMUSDT", timeframe: "4h", side: "BSL" as const, state: "SWEPT" as const, levels: [0.19864] },
    { symbol: "ONDOUSDT", timeframe: "4h", side: "BSL" as const, state: "BROKEN" as const, levels: [0.4279, 0.4288] },
  ],
  approaches: [
    { symbol: "DOGEUSDT", timeframes: ["1h", "4h"], side: "SSL" as const, price: 0.07828, distancePct: 0.31 },
  ],
  historySkipped: [
    { symbol: "TRXUSDT", timeframe: "1h", side: "SSL" as const, price: 0.33688 },
  ],
  symbolCount: 55,
  latestCandleTime: Math.floor(Date.now() / 1000),
  scanned: 110,
  failures: 0,
};

for (const [label, input] of [["沒有事件（最常見）", empty], ["有事件", busy]] as const) {
  for (const lang of ["zh-TW", "zh-CN", "en"] as Language[]) {
    console.log("═".repeat(60));
    console.log(`  ${label} ｜ ${lang}`);
    console.log("═".repeat(60));
    console.log(formatScanReply(input, lang));
    console.log("");
  }
}
