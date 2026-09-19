/**
 * Crypto market data for the SMC engine.
 *
 * SOURCE: Binance USDT-M perpetual futures — the GLOBAL market
 * (fapi.binance.com), fetched through `lib/market/futures.ts`.
 *
 * History: this module previously proxied Yahoo Finance under a "binance"
 * filename and carried a hard-coded 14-symbol mapping, which meant any symbol
 * outside that list failed (e.g. SUIUSDT → 404) and every candle came from a
 * different venue than the live feed. Both are removed — see REQUIREMENTS §3,
 * §4 and the P1 audit finding.
 *
 * Forex continues to use `fetchers/yahoo.ts`; nothing here is used by it.
 */
import { fetchKlines, fetchDailyCandles } from "../market/futures.js";
import type { Candle } from "../smc/types.js";

/** Default history depth fed to the SMC engine (matches smc/config maxCandles). */
const HISTORY_LIMIT = Number(process.env.CRYPTO_HISTORY_LIMIT || 500);
const DAILY_LIMIT = Number(process.env.CRYPTO_DAILY_LIMIT || 120);

/**
 * Candles for the requested timeframe, oldest → newest, forming candle excluded.
 *
 * Throws on unknown symbols so callers surface a real error instead of
 * silently analysing an empty array.
 */
export async function fetchBinanceCandles(symbol: string, timeframe: string): Promise<Candle[]> {
  const candles = await fetchKlines(symbol, timeframe, HISTORY_LIMIT);
  if (candles.length === 0) {
    throw new Error(`No futures candles returned for ${symbol} ${timeframe}`);
  }
  return candles;
}

/** Daily candles for the HTF bias input — same venue as the primary series. */
export async function fetchBinanceDailyCandles(symbol: string): Promise<Candle[]> {
  const candles = await fetchDailyCandles(symbol, DAILY_LIMIT);
  if (candles.length === 0) {
    throw new Error(`No daily futures candles returned for ${symbol}`);
  }
  return candles;
}
