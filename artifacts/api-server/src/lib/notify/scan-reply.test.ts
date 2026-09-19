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

console.log("─".repeat(60));
console.log("單幣查詢必須顯示完整現況，不是「沒有事件」");

{
  // A real TRXUSDT 4H picture: six live levels, price in the middle of them.
  const snapshot = {
    symbol: "TRXUSDT",
    timeframe: "4h",
    currentPrice: 0.33792,
    levels: [
      { price: 0.33986, side: "BSL" as const, state: "NONE", taken: false, distancePct: 0.574, interactionAt: null },
      { price: 0.34402, side: "BSL" as const, state: "NONE", taken: false, distancePct: 1.804, interactionAt: null },
      { price: 0.35355, side: "BSL" as const, state: "NONE", taken: false, distancePct: 4.625, interactionAt: null },
      { price: 0.3308, side: "SSL" as const, state: "NONE", taken: false, distancePct: -2.107, interactionAt: null },
      { price: 0.32095, side: "SSL" as const, state: "TOUCHED", taken: false, distancePct: -5.02, interactionAt: null },
      { price: 0.32075, side: "SSL" as const, state: "TOUCHED", taken: false, distancePct: -5.08, interactionAt: null },
      { price: 0.33448, side: "SSL" as const, state: "BROKEN", taken: true, distancePct: -1.02, interactionAt: 1757980800 },
    ],
  };

  for (const lang of LANGS) {
    const text = formatScanReply({ ...empty, scope: "TRXUSDT 4H", snapshots: [snapshot] }, lang);

    // The regression: this used to read "no events" for this exact symbol.
    ok(!text.includes("沒有事件") && !text.includes("没有事件") && !text.includes("No events"),
      `[${lang}] 不再回答「沒有事件」`);

    // Every live level is listed.
    for (const lvl of ["0.33986", "0.34402", "0.35355", "0.3308", "0.32095", "0.32075"]) {
      ok(text.includes(lvl), `[${lang}] 列出活躍價位 ${lvl}`);
    }

    // Above / below are separated, and price is shown.
    ok(text.includes("0.33792"), `[${lang}] 顯示現價`);

    // Distance is absolute — a signed number under a "below" heading reads wrong.
    ok(!text.includes("-2.11") && !text.includes("-5.02"),
      `[${lang}] 距離不顯示負號（方向由標題表達）`);

    // Recent consumption is shown as context.
    ok(text.includes("0.33448"), `[${lang}] 列出近期已取走的價位`);

    // And the whole point: a repeat is identical.
    const again = formatScanReply({ ...empty, scope: "TRXUSDT 4H", snapshots: [snapshot] }, lang);
    ok(text === again, `[${lang}] 再次查詢結果完全相同`);
  }

  // Market-wide (no snapshot) keeps the short event-style reply.
  const wide = formatScanReply({ ...busy, snapshots: [] }, "zh-TW");
  ok(wide.length < 400, "全市場查詢維持精簡");

  // More than one snapshot → fall back to the event list.
  const two = formatScanReply({ ...empty, snapshots: [snapshot, snapshot] }, "zh-TW");
  ok(two.length > 0, "多個幣時不使用單幣快照模式");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
