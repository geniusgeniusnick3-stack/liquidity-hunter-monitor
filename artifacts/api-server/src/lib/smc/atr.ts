/**
 * Average True Range — shared volatility measure.
 *
 * Extracted so structure, order blocks and liquidity all measure volatility the
 * same way. Previously this function was duplicated verbatim in `structure.ts`
 * and `order-blocks.ts`; liquidity classification now needs it too, and a third
 * copy would have meant three places to keep in sync.
 *
 * ATR is used here ONLY to scale tolerances (how much movement counts as real),
 * never to predict direction.
 */
import type { Candle } from "./types.js";

/**
 * Wilder-smoothed ATR, aligned index-for-index with `candles`.
 * Index 0 is always 0 (no previous close to compare against).
 */
export function calcATR(candles: Candle[], period: number): number[] {
  const atr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atr[i] = i < period ? tr : (atr[i - 1] * (period - 1) + tr) / period;
  }
  return atr;
}
