/**
 * Tests for the user-facing scan reply.
 *
 * The bug these exist to prevent: the chat reply once reused the CLI's operator
 * summary, so a user asking "anything happening?" received dedup counters, a
 * Node.js experimental-feature warning, and a bare "Sent 0". The answer was in
 * there somewhere, buried under output meant for whoever runs the service.
 *
 * So the tests assert two things: the reply says what the user needs, and it
 * contains nothing that only makes sense to an operator.
 */
import { formatScanReply } from "./formatters.js";
import type { Language } from "./i18n.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ FAIL: ${label}`); }
}

const now = Math.floor(Date.now() / 1000);

const empty = {
  scope: "TRXUSDT 4H",
  events: [] as Array<{ symbol: string; timeframe: string; side: "BSL" | "SSL"; state: "SWEPT" | "BROKEN"; levels: number[] }>,
  approaches: [] as Array<{ symbol: string; timeframes: string[]; side: "BSL" | "SSL"; price: number; distancePct: number }>,
  historySkipped: [] as Array<{ symbol: string; timeframe: string; side: "BSL" | "SSL"; price: number }>,
  symbolCount: 1,
  latestCandleTime: now,
  scanned: 1,
  failures: 0,
};

const busy = {
  ...empty,
  scope: "all tracked symbols",
  events: [
    { symbol: "XLMUSDT", timeframe: "4h", side: "BSL" as const, state: "SWEPT" as const, levels: [0.19864] },
    { symbol: "ONDOUSDT", timeframe: "4h", side: "BSL" as const, state: "BROKEN" as const, levels: [0.4279, 0.4288] },
  ],
  approaches: [
    { symbol: "DOGEUSDT", timeframes: ["1h", "4h"], side: "SSL" as const, price: 0.07828, distancePct: 0.31 },
  ],
  symbolCount: 55,
  scanned: 110,
};

const LANGS: Language[] = ["zh-TW", "zh-CN", "en"];

console.log("─".repeat(60));
console.log("回覆必須回答使用者的問題");

for (const lang of LANGS) {
  const quiet = formatScanReply(empty, lang);
  const loud = formatScanReply(busy, lang);

  ok(quiet.includes("TRXUSDT 4H"), `[${lang}] 顯示掃描範圍`);
  ok(quiet.length < 200, `[${lang}] 沒有事件時回覆簡短（${quiet.length} 字元）`);
  ok(loud.includes("XLMUSDT"), `[${lang}] 有事件時列出幣種`);
  ok(loud.includes("0.19864"), `[${lang}] 有事件時列出價位`);
  ok(loud.includes("0.4279") && loud.includes("0.4288"), `[${lang}] 多個價位全部列出`);
  ok(loud.includes("DOGEUSDT"), `[${lang}] 列出接近中的標的`);
}

console.log("─".repeat(60));
console.log("絕對不能洩漏營運細節（這是原本的 bug）");

// Strings that belong in the service log, never in a chat message.
const OPERATOR_ONLY = [
  "dedup", "Dedup", "去重", "去重狀態",
  "ExperimentalWarning", "node:", "trace-warnings",
  "Sent ", "sent ", "發送 1", "退出碼",
  "level\":", "pino", "hostname",
  "symbol/timeframe pairs", "組（幣×時框）",
];

for (const lang of LANGS) {
  for (const input of [empty, busy]) {
    const text = formatScanReply(input, lang);
    for (const junk of OPERATOR_ONLY) {
      ok(!text.includes(junk), `[${lang}] 不含營運細節「${junk}」`);
    }
  }
}

console.log("─".repeat(60));
console.log("標點必須跟隨語言");

{
  const zh = formatScanReply(busy, "zh-TW");
  const en = formatScanReply(busy, "en");

  ok(zh.includes("（0.31%）"), "中文用全角括號");
  ok(en.includes("(0.31%)"), "英文用半角括號");
  ok(!en.includes("（"), "英文不出現全角左括號");
  ok(!en.includes("）"), "英文不出現全角右括號");
  ok(!en.includes("、"), "英文不用中文頓號");
  ok(zh.includes("、"), "中文用頓號分隔價位");
  ok(!/[\u4e00-\u9fff]/.test(en), "英文回覆完全無中文字元");
}

console.log("─".repeat(60));
console.log("三語言確實不同");

{
  const texts = LANGS.map((l) => formatScanReply(busy, l));
  ok(new Set(texts).size === 3, "三語言產出三種不同回覆");
  ok(texts[0].includes("掃描完成"), "繁中標題");
  ok(texts[1].includes("扫描完成"), "簡中標題");
  ok(texts[2].includes("Scan complete"), "英文標題");
}

console.log("─".repeat(60));
console.log("讀取失敗時誠實揭露");

{
  const withFailures = { ...busy, failures: 3 };
  const text = formatScanReply(withFailures, "zh-TW");
  ok(text.includes("3"), "部分失敗時顯示失敗數量");
  ok(text.includes("110"), "同時顯示總數");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
