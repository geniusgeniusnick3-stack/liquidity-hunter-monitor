/**
 * Language support tests.
 *
 * The critical property is not "does English work" but "does every language
 * stay descriptive". A translation that quietly becomes predictive in one
 * language is exactly the failure a single-language test suite cannot catch, so
 * the forbidden-vocabulary check runs against all three.
 */
import { formatApproaching, formatSweep, formatSweepGroup, formatStructure } from "./formatters.js";
import { SUPPORTED_LANGUAGES, normaliseLanguage, stringsFor, type Language } from "./i18n.js";

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ FAIL: ${label}`); }
}

function contains(haystack: string, needle: string, label?: string): void {
  ok(haystack.includes(needle), label ?? `包含「${needle}」`);
}

function excludes(haystack: string, needle: string, label?: string): void {
  ok(!haystack.includes(needle), label ?? `不出現「${needle}」`);
}

// ── 語言標籤正規化 ──────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("語言標籤正規化");
{
  ok(normaliseLanguage("zh-TW") === "zh-TW", "zh-TW → zh-TW");
  ok(normaliseLanguage("zh_TW") === "zh-TW", "zh_TW（底線）→ zh-TW");
  ok(normaliseLanguage("zh-Hant") === "zh-TW", "zh-Hant → zh-TW");
  ok(normaliseLanguage("tw") === "zh-TW", "tw → zh-TW");
  ok(normaliseLanguage("zh-CN") === "zh-CN", "zh-CN → zh-CN");
  ok(normaliseLanguage("zh-Hans") === "zh-CN", "zh-Hans → zh-CN");
  ok(normaliseLanguage("cn") === "zh-CN", "cn → zh-CN");
  ok(normaliseLanguage("zh") === "zh-CN", "zh（無地區）→ zh-CN");
  ok(normaliseLanguage("en") === "en", "en → en");
  ok(normaliseLanguage("en-US") === "en", "en-US → en");
  ok(normaliseLanguage("  EN  ") === "en", "大小寫與空白容忍");
  ok(normaliseLanguage("klingon") === null, "無法辨識 → null（呼叫端負責報錯）");
  ok(normaliseLanguage("") === null, "空字串 → null");
}

// ── 三種語言都能產出訊息 ────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("三語言訊息產生");
for (const lang of SUPPORTED_LANGUAGES) {
  const s = stringsFor(lang as Language);
  const appr = formatApproaching({
    symbol: "BTCUSDT", timeframe: "4h", side: "BSL", level: 81435.09,
    currentPrice: 81181.8, distancePct: 0.31, source: "2 次觸及｜london",
  }, lang as Language);
  const sweep = formatSweep({
    symbol: "BTCUSDT", timeframe: "4h", side: "SSL", level: 81000,
    extreme: 80780, close: 81210, broken: false,
  }, lang as Language);

  ok(appr.includes("BTCUSDT"), `[${lang}] 接近訊息含幣種`);
  ok(appr.includes("4H"), `[${lang}] 接近訊息含時框 4H`);
  ok(appr.includes("81,435.09"), `[${lang}] 接近訊息含價位`);
  ok(sweep.includes("BTCUSDT"), `[${lang}] 掃過訊息含幣種`);
  ok(sweep.includes(s.stateSwept), `[${lang}] 掃過訊息含狀態用語`);
}

// ── 禁止字眼：三語言都要乾淨 ────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("措辭紀律（三語言）");

const FORBIDDEN_ZH = [
  "假突破", "真突破", "反轉", "延續", "確認", "做多", "做空",
  "買進", "賣出", "進場", "停損", "停利", "訊號", "多頭", "空頭",
  "看漲", "看跌", "目標價", "建議",
];
const FORBIDDEN_CN = [
  "假突破", "真突破", "反转", "延续", "确认", "做多", "做空",
  "买进", "卖出", "进场", "止损", "止盈", "信号", "多头", "空头",
  "看涨", "看跌", "目标价", "建议",
];
const FORBIDDEN_EN = [
  "fake breakout", "real breakout", "reversal", "continuation",
  "confirmed", "confirmation", "buy signal", "sell signal", "entry",
  "stop loss", "take profit", "target price", "recommend", "bullish",
  "bearish", "long position", "short position",
];

const samples: Record<string, string[]> = { "zh-TW": [], "zh-CN": [], en: [] };
for (const lang of SUPPORTED_LANGUAGES) {
  const L = lang as Language;
  samples[L].push(formatApproaching({
    symbol: "BTCUSDT", timeframe: "1h", side: "SSL", level: 81181.8,
    currentPrice: 81420.5, distancePct: 0.29, source: "2 touches",
  }, L));
  samples[L].push(formatSweep({
    symbol: "BTCUSDT", timeframe: "4h", side: "BSL", level: 81000,
    extreme: 81400, close: 80900, broken: true,
  }, L));
  samples[L].push(formatSweepGroup({
    symbol: "BTCUSDT", timeframe: "4h", side: "BSL",
    levels: [81000, 81050], extreme: 81400, close: 80900, state: "BROKEN",
  }, L));
  samples[L].push(formatStructure({
    symbol: "BTCUSDT", timeframe: "1h", kind: "CHoCH", direction: "bearish",
    level: 81435.09, close: 80650.84,
  }, L));
}

for (const w of FORBIDDEN_ZH) {
  const hit = samples["zh-TW"].some((m) => m.includes(w));
  ok(!hit, `繁中不出現「${w}」`);
}
for (const w of FORBIDDEN_CN) {
  const hit = samples["zh-CN"].some((m) => m.includes(w));
  ok(!hit, `簡中不出現「${w}」`);
}
for (const w of FORBIDDEN_EN) {
  const hit = samples.en.some((m) => m.toLowerCase().includes(w));
  ok(!hit, `英文不出現「${w}」`);
}

// ── 簡繁必須真的是不同文字，不是同一份複製 ──────────────────────────────────

console.log("─".repeat(60));
console.log("繁中／簡中確實不同");
{
  const tw = stringsFor("zh-TW");
  const cn = stringsFor("zh-CN");
  ok(tw.approachingTitle !== cn.approachingTitle, "標題不同（流動性 vs 流动性）");
  ok(tw.stateSwept !== cn.stateSwept, "掃過 vs 扫过");
  ok(tw.sideBsl !== cn.sideBsl, "買方 vs 买方");
  ok(tw.labelTimeframe !== cn.labelTimeframe, "時框 vs 时间框");
  ok(cn.approachingTitle.includes("流动性"), "簡中用「流动性」");
  ok(tw.approachingTitle.includes("流動性"), "繁中用「流動性」");
}

// ── ICT 縮寫在所有語言都保留英文 ───────────────────────────────────────────

console.log("─".repeat(60));
console.log("ICT 縮寫三語言一致");
for (const lang of SUPPORTED_LANGUAGES) {
  const s = stringsFor(lang as Language);
  ok(s.sideBsl.includes("BSL"), `[${lang}] BSL 縮寫保留`);
  ok(s.sideSsl.includes("SSL"), `[${lang}] SSL 縮寫保留`);
  ok(s.stateSwept.includes("SWEPT"), `[${lang}] SWEPT 縮寫保留`);
  ok(s.stateBroken.includes("BROKEN"), `[${lang}] BROKEN 縮寫保留`);
}

// ── 多價位聚合訊息 ──────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("多價位聚合");
for (const lang of SUPPORTED_LANGUAGES) {
  const msg = formatSweepGroup({
    symbol: "BTCUSDT", timeframe: "4h", side: "BSL",
    levels: [81000, 81050, 81100], extreme: 81400, close: 80900, state: "BROKEN",
  }, lang as Language);
  ok(msg.includes("×3"), `[${lang}] 標題標示 ×3`);
  ok(msg.includes("3"), `[${lang}] 內文含數量`);
  // 三個價位都要列出，不能只留第一個
  ok(msg.includes("81,000") && msg.includes("81,050") && msg.includes("81,100"),
    `[${lang}] 三個價位全部列出`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
