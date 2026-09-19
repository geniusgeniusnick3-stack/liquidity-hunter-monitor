/**
 * Tests for alert message formatting — 中文版 (REQUIREMENTS §15, §27).
 *
 * Run: npx tsx artifacts/api-server/src/lib/notify/formatters.test.ts
 */
import {
  formatApproaching,
  formatSweep,
  formatStructure,
  formatHealthHeartbeat,
  type ApproachingAlert,
  type SweepAlert,
} from "./formatters.js";

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
  contains(msg, "類型：買方流動性（BSL）", "流動性類型中文化並保留縮寫");
  contains(msg, "區間：0.8335 – 0.8345", "區間帶正確");
  contains(msg, "現價：0.8318");
  contains(msg, "距離：0.29%");
  contains(msg, "來源：等高等 + 波段高點");
  contains(msg, "潛在流動性位置", "明示為「潛在」，非既成事實（§10）");

  // SSL 必須標成「賣方」，絕不能顯示成「買方」——曾疑似出現標籤錯置
  const sslMsg = formatApproaching({ ...a, side: "SSL", level: 0.33688, zoneLow: 0.3368, zoneHigh: 0.3369 });
  contains(sslMsg, "類型：賣方流動性（SSL）", "SSL 標示為賣方流動性");
  excludes(sslMsg, "買方流動性（SSL）", "SSL 不得被標成買方流動性");
  contains(msg, "類型：買方流動性（BSL）", "BSL 標示為買方流動性");
  excludes(msg, "賣方流動性（BSL）", "BSL 不得被標成賣方流動性");

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
  contains(msg, "4H BSL 掃過（SWEPT）", "標題＝時框＋方向＋狀態（中文）");
  contains(msg, "價格向上穿越 BSL，該根完成的4H K 線收回流動性區間下方。",
    "描述句：穿越方向與收盤位置都說清楚");
  contains(msg, "刺破高點：100.5", "BSL 用「刺破高點」");
  contains(msg, "收盤：99.8");
  excludes(msg, "BROKEN", "不誤標為 BROKEN");

  const broken: SweepAlert = { ...swept, extreme: 101, close: 100.8, broken: true };
  const msg2 = formatSweep(broken);
  contains(msg2, "4H BSL 突破（BROKEN）");
  contains(msg2, "價格向上穿越 BSL，該根完成的4H K 線收在流動性區間上方。");
  excludes(msg2, "SWEPT", "不誤標為 SWEPT");

  const ssl: SweepAlert = { ...swept, side: "SSL", extreme: 99.5, close: 100.2 };
  const msg3 = formatSweep(ssl);
  contains(msg3, "4H SSL 掃過（SWEPT）", "SSL 標題");
  contains(msg3, "價格向下跌破 SSL，該根完成的4H K 線收回流動性區間上方。",
    "SSL 方向與收盤位置正確（對稱邏輯）");
  contains(msg3, "刺破低點：99.5", "SSL 用「刺破低點」");

  const sslBroken: SweepAlert = { ...ssl, extreme: 99, close: 99.2, broken: true };
  contains(formatSweep(sslBroken), "價格向下跌破 SSL，該根完成的4H K 線收在流動性區間下方。",
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
  contains(formatSweep({ ...base, timeframe: "1h" }), "1H BSL", "1h → 1H");
  contains(formatSweep({ ...base, timeframe: "4h" }), "4H BSL", "4h → 4H");
  contains(formatSweep({ ...base, timeframe: "15m" }), "15M BSL", "15m → 15M");
  contains(formatSweep({ ...base, timeframe: "1d" }), "1D BSL", "1d → 1D");
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
  contains(msg, "【結構事件】CHoCH 向下", "中文標題與方向");
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

// ── Summary ─────────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
