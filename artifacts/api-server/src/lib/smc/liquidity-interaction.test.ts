/**
 * Liquidity interaction classification tests.
 *
 * Covers the REQUIRED cases:
 *   BSL: A) high 100.5 / close 99.8 → SWEPT
 *        B) high 101   / close 100.8 → BROKEN
 *        C) high < level             → not reached
 *        D) touching but unconfirmed → TOUCHED, never finalized on a forming bar
 *   SSL: A) low 99.5 / close 100.2 → SWEPT
 *        B) low 99   / close 99.2  → BROKEN
 *   Timeframe: a 4H level is settled by the completed 4H candle, never by
 *              lower-timeframe closes.
 *
 * Run: npx tsx artifacts/api-server/src/lib/smc/liquidity-interaction.test.ts
 */
import { classifyLiquidityInteraction } from "./liquidity.js";
import { analyzeLiquidity } from "./liquidity.js";
import { CandleStore } from "../realtime/candle-store.js";
import type { Candle } from "./types.js";

let passed = 0;
let failed = 0;

function ok(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function eq<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); failed++; }
}

function candle(open: number, high: number, low: number, close: number, time = 1_700_000_000): Candle {
  return { time, open, high, low, close, volume: 1000 };
}

// ── BSL ─────────────────────────────────────────────────────────────────────

console.log("─".repeat(64));
console.log("BSL = 100（買方流動性在上方）");
{
  // Case A — traded beyond, closed back on the original side.
  const a = candle(100, 100.5, 99.4, 99.8);
  eq(classifyLiquidityInteraction(100, true, a, 0), "SWEPT",
    "Case A: High 100.5 / Close 99.8 → SWEPT");

  // Case B — traded beyond AND accepted beyond.
  const b = candle(100, 101, 99.9, 100.8);
  eq(classifyLiquidityInteraction(100, true, b, 0), "BROKEN",
    "Case B: High 101 / Close 100.8 → BROKEN");

  // Case C — never reached the level.
  const c = candle(98, 99.9, 97.5, 99.2);
  eq(classifyLiquidityInteraction(100, true, c, 0), "NONE",
    "Case C: High 99.9 < 100 → NONE（未觸及）");

  // Case D — reached the zone, never traded beyond it → contact only.
  // ("Has not closed yet" is a different guard, covered by the forming-candle
  //  section below: an unfinished bar never reaches the engine at all.)
  const d = candle(99.5, 100, 99.0, 99.9);
  eq(classifyLiquidityInteraction(100, true, d, 0), "TOUCHED",
    "Case D: 觸及 zone 但未穿越 → TOUCHED（未定案）");

  // A high that DOES trade beyond, however slightly, is no longer mere contact.
  eq(classifyLiquidityInteraction(100, true, candle(99.5, 100.2, 99.0, 99.9), 0), "SWEPT",
    "High 100.2 已穿越 → SWEPT（不是 TOUCHED）");

  // A candle whose high exactly equals the level is contact, not a sweep.
  eq(classifyLiquidityInteraction(100, true, candle(99.5, 100, 99, 99.9), 0), "TOUCHED",
    "High 恰好 = 100 → TOUCHED（不算穿越）");
}

// ── SSL ─────────────────────────────────────────────────────────────────────

console.log("─".repeat(64));
console.log("SSL = 100（賣方流動性在下方）");
{
  // Case A — traded below, closed back above.
  const a = candle(100.5, 100.8, 99.5, 100.2);
  eq(classifyLiquidityInteraction(100, false, a, 0), "SWEPT",
    "Case A: Low 99.5 / Close 100.2 → SWEPT");

  // Case B — traded below and accepted below.
  const b = candle(100.2, 100.3, 99, 99.2);
  eq(classifyLiquidityInteraction(100, false, b, 0), "BROKEN",
    "Case B: Low 99 / Close 99.2 → BROKEN");

  // Contact without trading beyond (low must not go below the level).
  eq(classifyLiquidityInteraction(100, false, candle(100.4, 100.6, 100, 100.1), 0), "TOUCHED",
    "Low 100 觸及但未穿越 → TOUCHED");

  // Symmetry: the SSL cases must mirror the BSL cases exactly.
  eq(classifyLiquidityInteraction(100, false, a, 0), classifyLiquidityInteraction(100, true, candle(100, 100.5, 99.4, 99.8), 0),
    "SSL 與 BSL 邏輯對稱");
}

// ── Tolerance (§5: no exact floating-point comparison) ──────────────────────

console.log("─".repeat(64));
console.log("容忍度：微小穿越不得成為 BROKEN");
{
  // The spec's example: a close a hair past the level is not acceptance.
  const hair = candle(100, 100.01, 99.9, 100.00001);
  ok(classifyLiquidityInteraction(100, true, hair, 0) === "BROKEN",
    "無容忍度時，100.00001 會被判 BROKEN（這就是要修掉的行為）");
  ok(classifyLiquidityInteraction(100, true, hair, 0.05) !== "BROKEN",
    "有 ATR 容忍度時，100.00001 不再是 BROKEN");
  eq(classifyLiquidityInteraction(100, true, hair, 0.05), "TOUCHED",
    "…而是 TOUCHED（只是碰到 zone）");

  // Tolerance must not swallow a genuine break.
  const real = candle(100, 101, 99.9, 100.8);
  eq(classifyLiquidityInteraction(100, true, real, 0.05), "BROKEN",
    "真正的突破不受容忍度影響，仍為 BROKEN");

  // Tolerance must not turn a genuine sweep into a break.
  const sweep = candle(100, 100.5, 99.4, 99.8);
  eq(classifyLiquidityInteraction(100, true, sweep, 0.05), "SWEPT",
    "真正的掃過不受容忍度影響，仍為 SWEPT");
}

// ── Timeframe consistency ───────────────────────────────────────────────────

console.log("─".repeat(64));
console.log("時框一致性：4H 的流動性由完成的 4H K 線定案");
{
  // A 4H level at 100. Within the 4H period, 15m candles traded up to 101 and
  // closed at 100.5 — but the completed 4H candle closed at 99.5.
  const fourHourBar = candle(100, 101, 99.2, 99.5);
  eq(classifyLiquidityInteraction(100, true, fourHourBar, 0), "SWEPT",
    "15m 曾收在 100.5，但 4H 收 99.5 → SWEPT（不是 BROKEN）");

  // The same scenario evaluated on the 15m bar gives a DIFFERENT answer, which
  // is exactly why the owning timeframe must do the classifying.
  const fifteenMinBar = candle(100, 101, 100.2, 100.5);
  eq(classifyLiquidityInteraction(100, true, fifteenMinBar, 0), "BROKEN",
    "同一段行情在 15m 上確實是 BROKEN — 但那個判定不能用來定案 4H 的狀態");
}

// ── Integration: analyzeLiquidity produces the descriptive fields ───────────

console.log("─".repeat(64));
console.log("整合：analyzeLiquidity 產出互動欄位（真實管線）");
{
  // Build a 4H series with a clear swing high at 100, then a candle that wicks
  // through it and closes back below.
  // NOTE ON FIXTURE GEOMETRY: analyzeLiquidity only promotes a swing high to a
  // pool when it is the highest high within +/- windowSize bars. The sweep must
  // therefore sit FARTHER than windowSize from the high — otherwise the sweeping
  // bar's own high disqualifies the pivot and no pool is ever produced.
  //
  // With n = 40, windowSize = min(20, 40/4) = 10, so the high is placed at
  // index 15 and the sweep at index 30 (15 bars apart).
  const candles: Candle[] = [];
  const base = 1_700_000_000;
  const H4 = 14_400;

  // Indices 0-14: quiet drift up toward the high
  for (let i = 0; i < 15; i++) {
    const px = 90 + i * 0.05;
    candles.push({ time: base + i * H4, open: px, high: px + 0.3, low: px - 0.3, close: px + 0.1, volume: 1000 });
  }
  // Index 15: the swing high at 100
  candles.push({ time: base + 15 * H4, open: 93, high: 100, low: 92.8, close: 94, volume: 1500 });
  // Indices 16-29: trading below, never exceeding 95
  for (let i = 16; i < 30; i++) {
    candles.push({ time: base + i * H4, open: 94, high: 95, low: 92, close: 93, volume: 1000 });
  }
  // Index 30: wick through 100, close back below → SWEPT
  candles.push({ time: base + 30 * H4, open: 95, high: 100.5, low: 94.5, close: 99.2, volume: 2000 });
  // Indices 31-39: continue below
  for (let i = 31; i < 40; i++) {
    candles.push({ time: base + i * H4, open: 99, high: 99.5, low: 96, close: 97, volume: 1000 });
  }

  const res = analyzeLiquidity(candles, "4h", "crypto");
  const pool = res.pools.find((p) => Math.abs(p.price - 100) < 1e-9);

  ok(pool !== undefined, "找到 100 的流動性池");
  if (pool) {
    eq(pool.type, "BSL", "型別為 BSL");
    eq(pool.interaction, "SWEPT", "刺破 100 後收回 → interaction = SWEPT");
    ok(pool.wasSwept === true, "wasSwept = true（此 level 已被取走）");
    ok(pool.interactionAt !== null, "記錄了發生互動的 K 線時間");
    ok(pool.interactionCandle !== null, "保留了該 K 線的 OHLC 供稽核");
    eq(pool.interactionCandle?.close, 99.2, "稽核資料的收盤價正確");
    eq(pool.probabilityOfSweep, 0, "已被取走的 level 不列為未來目標");
    ok(pool.tolerance !== null && pool.tolerance >= 0, "記錄了當時使用的容忍度");
  }

  // A level that is only ever approached must NOT be marked consumed.
  const far = res.pools.find((p) => p.price > 100.5);
  if (far) {
    ok(far.interaction === "NONE" || far.interaction === "TOUCHED",
      "未被取走的 level 不會被標成 SWEPT/BROKEN");
    ok(far.wasSwept === false, "未被取走的 level wasSwept = false");
  }
}

// ── Forming candle must never reach the engine ──────────────────────────────

console.log("─".repeat(64));
console.log("未完成的 K 線不得進入引擎");
{
  const store = new CandleStore();
  const base = 1_700_000_000;
  const H4 = 14_400;

  // Two closed bars seeded, then a forming (incomplete) bar.
  store.seedCandles("TESTUSDT", "4h", [
    { time: base, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
    { time: base + H4, open: 100.5, high: 102, low: 100, close: 101, volume: 1000 },
  ]);
  store.applyUpdate({
    symbol: "TESTUSDT", timeframe: "4h", time: base + 2 * H4,
    open: 101, high: 105, low: 100.5, close: 104.5, volume: 500, isClosed: false,
  });

  const closed = store.getCandles("TESTUSDT", "4h");
  eq(closed.length, 2, "getCandles() 只回傳已完成的 K 線（排除形成中的）");
  eq(closed[closed.length - 1].close, 101, "最後一根是已完成的收盤價，不是即時價");

  const withForming = store.getCandlesWithForming("TESTUSDT", "4h");
  eq(withForming.length, 3, "getCandlesWithForming() 才包含形成中的 K 線");
  eq(withForming[withForming.length - 1].close, 104.5, "形成中的 K 線仍是即時價");

  eq(store.getSnapshot("TESTUSDT", "4h").currentCandle?.close, 104.5,
    "getSnapshot().currentCandle 仍可單獨取得即時價（顯示用途）");
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log("─".repeat(64));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
