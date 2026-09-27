/**
 * Admission gate tests — the single door every candle source must pass through.
 *
 * WHAT THIS FILE IS DEFENDING
 * ---------------------------
 * 1. "Closed" is declared by provenance, never inferred from arithmetic. The old
 *    rule was `time + timeframeSeconds <= now`, which is not proof of anything:
 *    it dropped already-closed weekly bars until the following Monday. Assertion
 *    W1 below is the regression test for exactly that.
 * 2. Malformed rows are dropped by NAME, one at a time, and survivors are kept.
 *    A single bad row must not take the series with it, and it must not reach a
 *    division three functions deeper.
 * 3. Nothing non-finite can leave this gate.
 *
 * Run: npx tsx artifacts/api-server/src/lib/smc/candles.test.ts
 */
import type { Candle } from "./types.js";
import { admitCandles, type CandleRejectionReason } from "./candles.js";

// ── Tiny harness (same output contract as the other suites) ─────────────────
let passed = 0;
let failed = 0;
const section = (t: string) => { console.log(""); console.log(`── ${t}`); };
const eq = (a: unknown, b: unknown, what: string) => {
  if (Object.is(a, b)) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}\n         expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
};
const ok = (c: boolean, what: string) => {
  if (c) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}`); }
};

const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;
const T0 = 1_700_000_000; // fixed epoch — this file never reads the wall clock

const c = (time: number, open: number, high: number, low: number, close: number): Candle =>
  ({ time, open, high, low, close, volume: 1 });

/** A well-formed series of n bars starting at T0, spaced by `step`. */
const series = (n: number, step = HOUR, base = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => c(T0 + i * step, base + i, base + i + 1, base + i - 1, base + i + 0.5));

const NOW = T0 + 10 * HOUR;

// ═══════════════════════════════════════════════════════════════════════════
section("W1 已收盤的 K 棒不得被剔除（週線誤刪的回歸測試）");
// ═══════════════════════════════════════════════════════════════════════════
{
  // A weekly bar whose period OPENED one hour ago. Under the old arithmetic rule
  // (open + 604800 <= now) this bar was thrown away — even though the source has
  // already told us it closed. Weekly made the error worst: a Friday close was
  // withheld until Monday.
  const weekly = [c(T0, 100, 110, 95, 105), c(T0 + WEEK, 105, 108, 104, 107)];
  const nowJustAfterOpen = T0 + WEEK + HOUR;

  const proven = admitCandles(weekly, { closure: "proven", nowSeconds: nowJustAfterOpen, minCandles: 1 });
  eq(proven.candles.length, 2, "proven：剛開盤的週線照樣保留（來源說它收盤了）");
  eq(proven.rejected.length, 0, "proven：沒有東西被拒");

  // The same input from a source that cannot prove closure: the last row goes.
  const unprovable = admitCandles(weekly, { closure: "unprovable", nowSeconds: nowJustAfterOpen, minCandles: 1 });
  eq(unprovable.candles.length, 1, "unprovable：固定少最後一根");
  eq(unprovable.rejected.length, 0, "unprovable：那是剔除以外的處理，不算「被拒」");
}

// ═══════════════════════════════════════════════════════════════════════════
section("W2 逐筆剔除，且指名原因");
// ═══════════════════════════════════════════════════════════════════════════
{
  const rows: Candle[] = [
    c(T0 + 0 * HOUR, 100, 101, 99, 100.5),            // good
    c(T0 + 1 * HOUR, Number.NaN, 101, 99, 100.5),     // not-finite
    c(T0 + 2 * HOUR, 100, 101, 99, 100.5),            // good
    c(T0 + 3 * HOUR, 0, 101, 99, 100.5),              // non-positive
    c(T0 + 4 * HOUR, 100, 101, 99, 100.5),            // good
    c(T0 + 5 * HOUR, 100, 99, 98, 100.5),             // ohlc-inconsistent (high < low)
    c(T0 + 6 * HOUR, 100, 101, 99, 100.5),            // good
    c(T0 + 6 * HOUR, 100, 101, 99, 100.5),            // time-not-increasing (equal)
    c(T0 + 7 * HOUR, 100, 101, 99, 100.5),            // good
    c(T0 + 8 * HOUR, -5, 101, 99, 100.5),             // non-positive
    c(T0 + 9 * HOUR, 100, 101, 99, 100.5),            // good
    c(T0 + 10 * HOUR, 100, 101, 99, 100.5),           // time-in-future (time == now is fine)
    c(T0 + 11 * HOUR, 100, 101, 99, 100.5),           // time-in-future
  ];

  const a = admitCandles(rows, { closure: "proven", nowSeconds: NOW, minCandles: 1 });

  eq(a.candles.length, 7, "7 根合格存活（一個壞掉不帶走整串）");
  ok(a.candles.every((x) => Number.isFinite(x.open) && Number.isFinite(x.high)
    && Number.isFinite(x.low) && Number.isFinite(x.close) && x.low > 0),
    "存活者每個價格欄位都有限且為正");

  const reasons = (a.rejected.map((r) => r.reason) as CandleRejectionReason[]).sort();
  eq(reasons.join(","), "non-positive,non-positive,not-finite,ohlc-inconsistent,time-in-future,time-not-increasing",
    "每一個理由都被指名，沒有匿名丟棄");
  ok(!JSON.stringify(a).includes("NaN") && !JSON.stringify(a).includes("Infinity"),
    "輸出不含 NaN / Infinity");
}

// ═══════════════════════════════════════════════════════════════════════════
section("W3 邊界：時間恰好等於現在");
// ═══════════════════════════════════════════════════════════════════════════
{
  const exact = [c(T0, 100, 101, 99, 100.5), c(NOW, 100, 101, 99, 100.5)];
  const a = admitCandles(exact, { closure: "proven", nowSeconds: NOW, minCandles: 1 });
  eq(a.candles.length, 2, "time === now 不算未來，保留");
  eq(a.rejected.length, 0, "不因此被拒");
}

// ═══════════════════════════════════════════════════════════════════════════
section("W4 短序列：0 / 1 / 2 根");
// ═══════════════════════════════════════════════════════════════════════════
{
  eq(admitCandles([], { closure: "proven", nowSeconds: NOW, minCandles: 1 }).candles.length, 0,
    "空陣列 → 空，不炸");
  eq(admitCandles([], { closure: "unprovable", nowSeconds: NOW, minCandles: 1 }).candles.length, 0,
    "空陣列 + unprovable → 仍是空（不因少一根而變負）");

  const one = series(1);
  eq(admitCandles(one, { closure: "proven", nowSeconds: NOW, minCandles: 1 }).candles.length, 1, "1 根 → 1 根");
  eq(admitCandles(one, { closure: "unprovable", nowSeconds: NOW, minCandles: 1 }).candles.length, 0,
    "1 根 + unprovable → 0 根（誠實地沒有可用的收盤棒）");

  const two = series(2);
  eq(admitCandles(two, { closure: "unprovable", nowSeconds: NOW, minCandles: 1 }).candles.length, 1, "2 根 → 1 根");
}

// ═══════════════════════════════════════════════════════════════════════════
section("W5 usable 旗標：不足最低根數＝這組不可用");
// ═══════════════════════════════════════════════════════════════════════════
{
  const three = series(3);
  ok(admitCandles(three, { closure: "proven", nowSeconds: NOW, minCandles: 3 }).usable,
    "3 根、門檻 3 → 可用");
  ok(!admitCandles(three, { closure: "unprovable", nowSeconds: NOW, minCandles: 3 }).usable,
    "3 根少一根、門檻 3 → 不可用（呼叫端要據此具名記錄失敗，不是靜默繼續）");
  ok(!admitCandles(series(2), { closure: "proven", nowSeconds: NOW, minCandles: 3 }).usable,
    "2 根、門檻 3 → 不可用");
}

// ═══════════════════════════════════════════════════════════════════════════
section("W6 不讀壁鐘、不用週期長度");
// ═══════════════════════════════════════════════════════════════════════════
{
  // Same input, two very different "now" values, both far past the last bar:
  // byte-identical output. Nothing here consults a timeframe table.
  const s = series(5, DAY);
  const a = admitCandles(s, { closure: "proven", nowSeconds: NOW + 100 * DAY, minCandles: 1 });
  const b = admitCandles(s, { closure: "proven", nowSeconds: NOW + 100 * DAY + 1, minCandles: 1 });
  eq(JSON.stringify(a), JSON.stringify(b), "同一輸入 → 逐位元相同輸出");

  // A bar that closed ONE SECOND ago is kept when the source can prove it. The
  // old rule dropped it for every timeframe (since no period is shorter than a
  // second), which is the arithmetic this gate deliberately does not do.
  const fresh = [c(T0, 100, 101, 99, 100.5)];
  eq(admitCandles(fresh, { closure: "proven", nowSeconds: T0 + 1, minCandles: 1 }).candles.length, 1,
    "來源說收盤了 → 就算只過 1 秒也保留（證明沒有用週期長度推論）");
  eq(admitCandles(fresh, { closure: "proven", nowSeconds: T0 + 1, minCandles: 1 }).rejected.length, 0,
    "不因「看起來還沒到期」被拒");
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("");
console.log("─".repeat(72));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
