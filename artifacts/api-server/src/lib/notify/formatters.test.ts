/**
 * Tests for alert message formatting — Traditional Chinese vocabulary
 * (REQUIREMENTS §15, §27).
 *
 * Run: npx tsx artifacts/api-server/src/lib/notify/formatters.test.ts
 *
 * These assert Chinese wording, so every call names the language explicitly
 * instead of relying on the default. When the shipped default changed from
 * zh-TW to en, tests that omitted the argument silently started checking
 * English output against Chinese expectations — 36 failures that said nothing
 * about the code and everything about the tests. Naming the language removes
 * that coupling.
 */
import {
  formatApproaching as formatApproachingRaw,
  formatSweep as formatSweepRaw,
  formatSweepGroup as formatSweepGroupRaw,
  formatStructure as formatStructureRaw,
  formatHealthHeartbeat as formatHealthHeartbeatRaw,
  type ApproachingAlert,
  type SweepAlert,
  type StructureAlert,
  type HealthHeartbeatAlert,
} from "./formatters.js";

/** Language under test — this file verifies Chinese wording. */
const ZH = "zh-TW" as const;

const formatApproaching = (i: ApproachingAlert) => formatApproachingRaw(i, ZH);
const formatSweep = (i: SweepAlert) => formatSweepRaw(i, ZH);
const formatStructure = (i: StructureAlert) => formatStructureRaw(i, ZH);
const formatHealthHeartbeat = (i: HealthHeartbeatAlert) => formatHealthHeartbeatRaw(i, ZH);

let passed = 0;
let failed = 0;

function ok(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function contains(haystack: string, needle: string, label?: string): void {
  ok(haystack.includes(needle), label ?? `包含「${needle}」`);
}

function excludes(haystack: string, needle: string, label?: string): void {
  ok(!haystack.includes(needle), label ?? `不得包含「${needle}」`);
}

// ── 流動性接近 ───────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("【流動性接近】");
{
  const a: ApproachingAlert = {
    symbol: "SUIUSDT",
    timeframe: "4h",
    side: "BSL",
    level: 0.8342,
    zoneLow: 0.8335,
    zoneHigh: 0.8345,
    currentPrice: 0.8318,
    distancePct: 0.29,
    source: "等高等 + 波段高點",
  };
  const msg = formatApproaching(a);

  contains(msg, "【流動性接近】", "中文標題");
  contains(msg, "幣種：SUIUSDT");
  contains(msg, "時框：4H", "時框以中文顯示");
  contains(msg, "類型：上方流動性", "流動性類型中文化，且不帶 BSL 代號");
  contains(msg, "區間：0.8335 – 0.8345", "區間帶正確");
  contains(msg, "現價：0.8318");
  contains(msg, "距離：0.29%");
  contains(msg, "來源：等高等 + 波段高點");
  contains(msg, "潛在流動性位置", "明示為「潛在」，非既成事實（§10）");

  // SSL 必須標成「賣方」，絕不能顯示成「買方」——曾疑似出現標籤錯置
  const sslMsg = formatApproaching({ ...a, side: "SSL", level: 0.33688, zoneLow: 0.3368, zoneHigh: 0.3369 });
  contains(sslMsg, "類型：下方流動性", "SSL 標示為下方流動性");
  excludes(sslMsg, "上方流動性", "SSL 不得被標成上方流動性");
  contains(msg, "類型：上方流動性", "BSL 標示為上方流動性");
  excludes(msg, "下方流動性", "BSL 不得被標成下方流動性");

  // 英文殘留檢查：標籤不應還是英文
  excludes(msg, "Symbol:", "欄位標籤已中文化");
  excludes(msg, "Timeframe:", "欄位標籤已中文化");
  excludes(msg, "Current Price:", "欄位標籤已中文化");
}

// ── 掃過 / 突破 ─────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("掃過（SWEPT）／突破（BROKEN）");
{
  const swept: SweepAlert = {
    symbol: "SUIUSDT", timeframe: "4h", side: "BSL",
    level: 100, extreme: 100.5, close: 99.8, broken: false,
  };
  const msg = formatSweep(swept);
  contains(msg, "4H 上方流動性 只是掃到", "標題＝時框＋方位＋狀態（白話，無代號）");
  contains(msg, "價格向上穿越上方流動性，該根完成的4H K 線收回流動性區間下方。",
    "描述句：穿越方向與收盤位置都說清楚");
  contains(msg, "刺破高點：100.5", "BSL 用「刺破高點」");
  contains(msg, "收盤：99.8");
  excludes(msg, "BROKEN", "不誤標為 BROKEN");

  const broken: SweepAlert = { ...swept, extreme: 101, close: 100.8, broken: true };
  const msg2 = formatSweep(broken);
  contains(msg2, "4H 上方流動性 突破了");
  contains(msg2, "價格向上穿越上方流動性，該根完成的4H K 線收在流動性區間上方。");
  excludes(msg2, "SWEPT", "不誤標為 SWEPT");

  const ssl: SweepAlert = { ...swept, side: "SSL", extreme: 99.5, close: 100.2 };
  const msg3 = formatSweep(ssl);
  contains(msg3, "4H 下方流動性 只是掃到", "SSL 標題");
  contains(msg3, "價格向下跌破下方流動性，該根完成的4H K 線收回流動性區間上方。",
    "SSL 方向與收盤位置正確（對稱邏輯）");
  contains(msg3, "刺破低點：99.5", "SSL 用「刺破低點」");

  const sslBroken: SweepAlert = { ...ssl, extreme: 99, close: 99.2, broken: true };
  contains(formatSweep(sslBroken), "價格向下跌破下方流動性，該根完成的4H K 線收在流動性區間下方。",
    "SSL BROKEN 描述正確");
}

// ── 措辭紀律（§7）────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("措辭紀律：不得預測方向、不得暗示交易");
{
  const swept: SweepAlert = {
    symbol: "SUIUSDT", timeframe: "4h", side: "BSL",
    level: 100, extreme: 100.5, close: 99.8, broken: false,
  };
  const broken: SweepAlert = { ...swept, extreme: 101, close: 100.8, broken: true };
  const ssl: SweepAlert = { ...swept, side: "SSL", extreme: 99.5, close: 100.2 };

  const msgs = [formatSweep(swept), formatSweep(broken), formatSweep(ssl)];
  const approaching = formatApproaching({
    symbol: "SUIUSDT", timeframe: "4h", side: "BSL", level: 100,
    currentPrice: 99.6, distancePct: 0.4, source: "波段高點",
  });
  const all = [...msgs, approaching];

  // 中文禁用詞（方向推論、交易指令、確認語氣）
  const forbiddenZh = [
    "假突破", "真突破", "反轉", "反彈", "延續", "確認", "已確認",
    "做多", "做空", "買進", "賣出", "進場", "出場", "加碼", "停損", "停利",
    "訊號", "多頭", "空頭", "看漲", "看跌", "趨勢會持續", "準備做空", "準備做多",
    "目標價", "建議",
  ];
  for (const word of forbiddenZh) {
    ok(all.every((m) => !m.includes(word)), `不得出現「${word}」`);
  }

  // 英文禁用詞（避免中英夾雜時漏掉）
  const forbiddenEn = [
    "fake breakout", "false breakout", "reversal", "continuation",
    "confirmed", "bullish", "bearish", "prepare to", "signal",
  ];
  for (const word of forbiddenEn) {
    ok(all.every((m) => !m.includes(word)), `不得出現「${word}」`);
  }

  // 必須明示是以「完成的」K 線判定（§3、§4）
  ok(msgs.every((m) => m.includes("完成的")), "三則皆明示以「完成的」K 線判定");
  ok(msgs.every((m) => m.includes("4H")), "三則皆標示所屬時框");
}

// ── 時框標籤 ────────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("時框中文標籤");
{
  const base: SweepAlert = {
    symbol: "BTCUSDT", timeframe: "1h", side: "BSL",
    level: 81435, extreme: 81500, close: 81400, broken: false,
  };
  contains(formatSweep({ ...base, timeframe: "1h" }), "1H 上方流動性", "1h → 1H");
  contains(formatSweep({ ...base, timeframe: "4h" }), "4H 上方流動性", "4h → 4H");
  contains(formatSweep({ ...base, timeframe: "15m" }), "15M 上方流動性", "15m → 15M");
  contains(formatSweep({ ...base, timeframe: "1d" }), "1D 上方流動性", "1d → 1D");
}

// ── 數字格式 ────────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("數字格式");
{
  const btc = formatSweep({
    symbol: "BTCUSDT", timeframe: "1h", side: "BSL",
    level: 81435.09, extreme: 81500.5, close: 80950.25, broken: false,
  });
  contains(btc, "81,435.09", "大額價位加千分位");
  contains(btc, "81,500.5", "刺破高點亦加千分位");

  const small = formatSweep({
    symbol: "SUIUSDT", timeframe: "4h", side: "BSL",
    level: 0.8342, extreme: 0.8358, close: 0.8334, broken: false,
  });
  contains(small, "價位：0.8342", "小數不加多餘尾零");
  excludes(small, "0.83420", "不出現假精度");
}

// ── 結構事件（§16）──────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("【結構事件】");
{
  const msg = formatStructure({
    symbol: "BTCUSDT", timeframe: "1h", kind: "CHoCH", direction: "bearish",
    level: 81435.09, close: 80650.84,
  });
  contains(msg, "【結構事件】原趨勢改變 向下", "中文標題與方向（代號已翻白話）");
  contains(msg, "幣種：BTCUSDT");
  contains(msg, "時框：1H");
  contains(msg, "價位：81,435.09");
  contains(msg, "不代表任何交易指令", "明示非交易指令");
}

// ── 心跳（§23）─────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("【監控心跳】");
{
  const msg = formatHealthHeartbeat({
    activeSymbols: 50,
    wsConnected: true,
    lastMarketDataAt: Date.now() - 12_000,
    universeAgeMinutes: 8,
    telegramSent: 3,
    telegramFailed: 0,
  });
  contains(msg, "【監控心跳】");
  contains(msg, "監控幣數：50");
  contains(msg, "連線狀態：已連線");
  contains(msg, "最後行情：12 秒前");
  contains(msg, "清單更新：8 分鐘前");
  contains(msg, "通知發送／失敗：3／0");
}

// ── Merged equal-level pools must be NAMED, and only when merged ────────────

console.log("─".repeat(60));
console.log("合併水位（等高等低）的標記");

{
  const base = {
    symbol: "DOGEUSDT", timeframe: "1h", side: "BSL" as const, level: 0.07828,
    currentPrice: 0.07804, distancePct: 0.31, source: "3 次觸及｜asia",
  };

  excludes(formatApproaching(base), "⚖️", "一般水位不帶標記");

  const merged = formatApproaching({ ...base, poolType: "EQH" });
  contains(merged, "⚖️等高點（EQH）", "合併水位在「類型」標出等高點");
  contains(merged, "上方流動性", "原本的側別字樣保留");

  contains(formatApproachingRaw({ ...base, poolType: "EQL" }, "en"), "⚖️Equal lows (EQL)", "英文版 Equal lows");
  contains(formatApproachingRaw({ ...base, poolType: "EQH" }, "zh-CN"), "⚖️等高点（EQH）", "簡中版 等高点");
}

{
  // Two levels settled by one candle; only the second is a merged pool.
  const group = formatSweepGroupRaw({
    symbol: "TAOUSDT", timeframe: "4h", side: "BSL" as const, state: "SWEPT" as const,
    levels: [0.4279, 0.4288], levelTypes: ["BSL" as const, "EQH" as const],
    extreme: 0.4301, close: 0.4255,
  }, ZH);
  contains(group, "0.4288 ⚖️等高點（EQH）", "價位列只在合併的那個價位標記");
  excludes(group, "0.4279 ⚖️", "同群組的一般價位不被標記");
}

{
  // Callers that predate the kinds: no crash, no invented mark.
  const legacy = formatSweepGroupRaw({
    symbol: "TAOUSDT", timeframe: "4h", side: "BSL" as const, state: "SWEPT" as const,
    levels: [0.4279], extreme: 0.4301, close: 0.4255,
  }, ZH);
  excludes(legacy, "⚖️", "沒有型別時不標記（相容舊呼叫端）");
  contains(legacy, "0.4279", "沒有型別時價位照常列出");
}

// ── zh-CN must never receive Traditional wording ───────────────────────────
//
// Every non-English branch used to be a two-way `en ? a : b` split, which handed
// Traditional words to Simplified readers (現價 / 監控心跳 / 分鐘前 …). These
// checks scan the rendered string for Traditional-only forms, so a new two-way
// split anywhere in an alert body fails here instead of shipping.

console.log("─".repeat(60));
console.log("簡中版不得出現繁體字");

/** Traditional forms whose Simplified counterpart these alerts use instead. */
const TRADITIONAL_ONLY = [
  "價", "監", "連", "線", "幣", "種", "時", "構", "結", "盤", "發", "鐘", "頭",
  "數", "訊", "據", "態", "觸", "現", "這", "還", "個", "實", "體", "點", "買",
  "賣", "對", "錯", "開", "關", "說", "問", "題", "標", "準",
];

function noTraditional(text: string, label: string): void {
  const found = [...new Set([...text].filter((c) => TRADITIONAL_ONLY.includes(c)))];
  ok(found.length === 0, found.length === 0 ? label : `${label}（發現繁體字：${found.join("")}）`);
}

{
  const CN = "zh-CN" as const;

  const structure = formatStructureRaw({
    symbol: "BTCUSDT", timeframe: "1h", kind: "CHoCH", direction: "bearish",
    level: 81435.09, close: 80650.84,
  }, CN);
  noTraditional(structure, "結構警報 zh-CN 不含繁體");
  contains(structure, "【结构事件】", "結構警報 zh-CN 標題用簡體");
  contains(structure, "时间框：1H", "結構警報 zh-CN 用「时间框」");
  contains(structure, "结构事件本身不代表任何交易指令", "結構警報 zh-CN 免責句簡體");

  const heartbeat = formatHealthHeartbeatRaw({
    activeSymbols: 149, wsConnected: true, lastMarketDataAt: Date.now() - 12_000,
    universeAgeMinutes: 8, telegramSent: 3, telegramFailed: 0,
  }, CN);
  noTraditional(heartbeat, "心跳 zh-CN 不含繁體");
  contains(heartbeat, "【监控心跳】", "心跳 zh-CN 標題用簡體");
  contains(heartbeat, "8 分钟前", "心跳 zh-CN 用「分钟前」");

  const approaching = formatApproachingRaw({
    symbol: "DOGEUSDT", timeframe: "1h", side: "BSL", level: 0.07828,
    poolType: "EQH", currentPrice: 0.07804, distancePct: 0.31, source: "3 次触及｜asia",
  }, CN);
  noTraditional(approaching, "接近警報 zh-CN 不含繁體");
  contains(approaching, "⚖️等高点（EQH）", "接近警報 zh-CN 標出等高点");

  const sweep = formatSweepGroupRaw({
    symbol: "TAOUSDT", timeframe: "4h", side: "BSL", state: "SWEPT",
    levels: [0.4279, 0.4288], levelTypes: ["BSL", "EQH"],
    extreme: 0.4301, close: 0.4255,
  }, CN);
  noTraditional(sweep, "掃到警報 zh-CN 不含繁體");
  contains(sweep, "⚖️等高点（EQH）", "掃到警報 zh-CN 標出等高点");

  // The English branch must not carry any Chinese at all.
  const en = formatHealthHeartbeatRaw({
    activeSymbols: 149, wsConnected: true, lastMarketDataAt: Date.now() - 12_000,
    universeAgeMinutes: 8, telegramSent: 3, telegramFailed: 0,
  }, "en");
  ok(!/[一-龥]/.test(en), "心跳 en 完全不含中文");
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
