/**
 * Candle cache for continuous monitoring.
 *
 * A completed candle never changes, so re-downloading 500 bars of history on
 * every poll is pure waste. Each cache entry lives only until the NEXT candle
 * of that timeframe closes — after that the newest bar has changed and the
 * entry is stale by definition.
 *
 * This is what keeps ACTIVE mode from being "a naive loop that REST-downloads
 * every symbol every few seconds": within a candle period, repeated polls cost
 * zero requests, and a symbol is only re-fetched once its data can actually
 * have changed.
 */
import { fetchKlines } from "../market/futures.js";
import type { Candle } from "../smc/types.js";

/** Length of one candle, in milliseconds. */
export const TF_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

/** Epoch ms at which the currently-forming candle of `tf` will close. */
export function nextCandleClose(timeframe: string, now: number = Date.now()): number {
  const ms = TF_MS[timeframe];
  if (!ms) return now + 60_000;
  // Binance candles are aligned to the epoch, so this is exact.
  return (Math.floor(now / ms) + 1) * ms;
}

interface Entry {
  candles: Candle[];
  fetchedAt: number;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
}

export class CandleCache {
  private entries = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  private static key(symbol: string, timeframe: string): string {
    return `${symbol.toUpperCase()}|${timeframe}`;
  }

  /**
   * Candles for a symbol/timeframe, served from cache when the newest bar
   * cannot have changed yet.
   *
   * A limit larger than any cached value forces a refetch, so callers asking
   * for more history are never silently served a shorter array.
   */
  async get(symbol: string, timeframe: string, limit = 500): Promise<Candle[]> {
    const key = CandleCache.key(symbol, timeframe);
    const hit = this.entries.get(key);

    if (hit && Date.now() < hit.expiresAt && hit.candles.length >= limit) {
      this.hits++;
      return hit.candles;
    }

    this.misses++;
    const candles = await fetchKlines(symbol, timeframe, limit);

    // Expire when the forming candle closes — at that point the newest bar
    // changes and this entry is no longer current.
    this.entries.set(key, {
      candles,
      fetchedAt: Date.now(),
      expiresAt: nextCandleClose(timeframe),
    });

    return candles;
  }

  /** Drop entries that can no longer be valid, so memory does not creep. */
  prune(now: number = Date.now()): number {
    let removed = 0;
    for (const [k, v] of this.entries) {
      if (now >= v.expiresAt) {
        this.entries.delete(k);
        removed++;
      }
    }
    return removed;
  }

  getStats(): CacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size };
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/** One shared cache per process — the monitor is the only heavy consumer. */
export const candleCache = new CandleCache();
