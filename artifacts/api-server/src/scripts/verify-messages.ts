/**
 * Prints the exact text every alert template produces, for eyeball review.
 *
 * Useful when a screenshot is ambiguous (e.g. 買方/賣方 hard to read at small
 * sizes) — run this and compare the real strings.
 *
 * Run: NODE_ENV=production npx tsx artifacts/api-server/src/scripts/verify-messages.ts
 */
import { formatApproaching, formatSweep, formatStructure, formatHealthHeartbeat } from "../lib/notify/formatters.js";

const cases: Array<[string, string]> = [
  ["BSL 接近", formatApproaching({
    symbol: "BNBUSDT", timeframe: "1h", side: "BSL", level: 770.76,
    currentPrice: 768.54, distancePct: 0.29, source: "1 次觸及｜london",
  })],
  ["SSL 接近", formatApproaching({
    symbol: "TRXUSDT", timeframe: "1h", side: "SSL", level: 0.33688,
    currentPrice: 0.33785, distancePct: 0.29, source: "2 次觸及｜london",
  })],
  ["BSL 掃過", formatSweep({
    symbol: "TAOUSDT", timeframe: "1h", side: "BSL",
    level: 269.51, extreme: 272.57, close: 268.2, broken: false,
  })],
  ["BSL 突破", formatSweep({
    symbol: "ENAUSDT", timeframe: "4h", side: "BSL",
    level: 0.18887, extreme: 0.19598, close: 0.19127, broken: true,
  })],
  ["SSL 掃過", formatSweep({
    symbol: "TRXUSDT", timeframe: "4h", side: "SSL",
    level: 0.33, extreme: 0.3288, close: 0.3321, broken: false,
  })],
  ["SSL 突破", formatSweep({
    symbol: "TRXUSDT", timeframe: "4h", side: "SSL",
    level: 0.33, extreme: 0.3288, close: 0.3295, broken: true,
  })],
  ["結構事件", formatStructure({
    symbol: "BTCUSDT", timeframe: "1h", kind: "CHoCH", direction: "bearish",
    level: 81435.09, close: 80650.84,
  })],
  ["監控心跳", formatHealthHeartbeat({
    activeSymbols: 50, wsConnected: true, lastMarketDataAt: Date.now() - 12_000,
    universeAgeMinutes: 8, telegramSent: 9, telegramFailed: 0,
  })],
];

for (const [label, text] of cases) {
  console.log("═".repeat(60));
  console.log(`【${label}】`);
  console.log("─".repeat(60));
  console.log(text);
  console.log("");
}

console.log("═".repeat(60));
console.log("檢查重點：");
console.log("  • BSL 一律顯示「買方流動性（BSL）」");
console.log("  • SSL 一律顯示「賣方流動性（SSL）」");
console.log("  • 兩個不能互相錯置");
