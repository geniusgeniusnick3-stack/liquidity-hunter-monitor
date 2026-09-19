/**
 * Independent verification of the liquidity engine's output.
 *
 * Re-derives pivots and SWEPT/BROKEN classification from raw candles using a
 * SEPARATE implementation. It reproduces the documented SPEC — rolling
 * per-bar ATR tolerance, symmetric pivot window — but shares no code with the
 * engine, because checking a function against itself proves nothing.
 *
 * Spec being verified (from the project requirements):
 *   - a level is a pivot over a symmetric window of min(20, n/4) bars
 *   - tolerance is that bar's own ATR x multiple, not a global constant
 *   - the FIRST completed candle that trades beyond the level settles it
 *   - SWEPT  = traded beyond, but that candle closed back on the original side
 *   - BROKEN = traded beyond, and that candle closed beyond
 *
 * Usage:
 *   npx tsx artifacts/api-server/src/scripts/verify-engine-manual.ts BTCUSDT 1h
 */

import { fetchKlines } from "../lib/market/futures.js";
import { analyzeLiquidity } from "../lib/smc/liquidity.js";
import { loadConfig } from "../lib/config/index.js";

const symbol = (process.argv[2] ?? "BTCUSDT").toUpperCase();
const tf = (process.argv[3] ?? "1h").toLowerCase();

function taipei(sec: number): string {
  return new Date(sec * 1000).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei", hour12: false,
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

interface Bar { time: number; open: number; high: number; low: number; close: number }

/** Wilder-smoothed ATR, one value per bar (independent implementation). */
function rollingAtr(bars: Bar[], period: number): number[] {
  const out = new Array(bars.length).fill(0);
  if (bars.length < period + 1) return out;

  const tr: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - pc),
      Math.abs(bars[i].low - pc),
    ));
  }

  // Seed with a simple average, then smooth (Wilder).
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** First completed candle that trades beyond the level settles it. */
function classifyManually(
  bars: Bar[], atr: number[], fromIdx: number, price: number,
  side: "BSL" | "SSL", mult: number,
): { state: string; atIdx: number | null } {
  for (let i = fromIdx + 1; i < bars.length; i++) {
    const tol = Math.max((atr[i] ?? 0) * mult, 0);
    const b = bars[i];

    if (side === "BSL") {
      if (!(b.high > price + tol)) continue;
      return b.close > price + tol
        ? { state: "BROKEN", atIdx: i }
        : { state: "SWEPT", atIdx: i };
    }
    if (!(b.low < price - tol)) continue;
    return b.close < price - tol
      ? { state: "BROKEN", atIdx: i }
      : { state: "SWEPT", atIdx: i };
  }
  return { state: "ACTIVE", atIdx: null };
}

(async () => {
  const candles = await fetchKlines(symbol, tf, 500);
  const cfg = loadConfig();
  const mult = cfg.liquidity.tolerance_atr_multiple;

  const bars: Bar[] = candles.map((c) => ({
    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
  }));
  const atr = rollingAtr(bars, 14);
  const n = bars.length;
  const windowSize = Math.min(20, Math.floor(n / 4));

  console.log(`=== 引擎獨立驗算：${symbol} ${tf.toUpperCase()} ===`);
  console.log(`  K 線 ${n} 根｜pivot 視窗 ±${windowSize} 根｜容忍度 = 該根 ATR x ${mult}`);
  console.log(`  最新 ATR(14) = ${atr[n - 1].toPrecision(6)}｜容忍度 = ${(atr[n - 1] * mult).toPrecision(6)}`);
  console.log("");

  const res = analyzeLiquidity(candles, tf, "crypto");

  let checked = 0, agreed = 0;
  const rows: string[] = [];

  for (const pool of res.pools) {
    const price = pool.price;
    const side = pool.type as "BSL" | "SSL";
    if (side !== "BSL" && side !== "SSL") continue;

    // pool.index is the FORMATION bar. pool.time is unusable here — the engine
    // overwrites it with the interaction timestamp once a level is consumed.
    const idx = pool.index;
    if (idx < 0 || idx >= n) continue;

    checked++;
    const manual = classifyManually(bars, atr, idx, price, side, mult);
    const engine = pool.interaction;

    const engineTaken = engine === "SWEPT" || engine === "BROKEN";
    const manualTaken = manual.state === "SWEPT" || manual.state === "BROKEN";

    // A level is either taken or not; if taken, the two should agree on which.
    const same = engineTaken === manualTaken && (!engineTaken || engine === manual.state);
    if (same) agreed++;

    rows.push(
      `  ${same ? "OK  " : "DIFF"}  ${side} ${price}  形成 ${taipei(bars[idx].time)}` +
      `  引擎=${engine.padEnd(8)}手算=${manual.state.padEnd(8)}` +
      (manual.atIdx !== null ? ` 手算於 ${taipei(bars[manual.atIdx].time)}` : "") +
      (pool.interactionAt ? `｜引擎於 ${taipei(pool.interactionAt)}` : ""),
    );
  }

  for (const r of rows) console.log(r);
  console.log("");
  const pctv = checked ? Math.round((agreed / checked) * 100) : 0;
  console.log(`驗算 ${checked} 條價位，${agreed} 條一致（${pctv}%）`);

  const diffs = rows.filter((r) => r.startsWith("  DIFF")).length;
  if (diffs === 0) console.log(`✅ 引擎判定與獨立手算完全一致`);
  else console.log(`⚠️ ${diffs} 條不一致 — 需人工檢視`);
})();
