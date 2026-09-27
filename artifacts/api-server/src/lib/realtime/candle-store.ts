import { EventEmitter } from "events";
import { logger } from "../logger.js";
import type { Candle } from "../smc/types.js";
import { admitCandles } from "../smc/candles.js";

// ── Types ────────────────────────────────────────────────────────────────────────

export interface CandleUpdate {
  symbol: string;
  timeframe: string;
  time: number;       // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;  // true = kline finalized, false = still forming
}

export interface CandleSnapshot {
  symbol: string;
  timeframe: string;
  candles: Candle[];           // closed candles + current forming candle
  currentCandle: Candle | null; // the currently-forming candle (same as last if isClosed=false)
  updatedAt: number;           // unix ms
}

type StoreKey = string; // `${symbol}|${timeframe}`

// ── Store ────────────────────────────────────────────────────────────────────────

export class CandleStore extends EventEmitter {
  /** Closed candles per symbol|timeframe (sorted by time ascending) */
  private closed: Map<StoreKey, Candle[]> = new Map();

  /** Currently-forming (open) candle per symbol|timeframe */
  private openCandle: Map<StoreKey, Candle> = new Map();

  /** Max closed candles to retain per stream */
  private maxCandles = 500;

  /** Track active symbols for status reporting */
  private activeSymbols: Set<string> = new Set();

  // ── Apply an update from the WebSocket ──────────────────────────────────────

  applyUpdate(update: CandleUpdate): void {
    const key = this.key(update.symbol, update.timeframe);
    const candle = this.toCandle(update);
    this.activeSymbols.add(update.symbol);

    if (update.isClosed) {
      // Kline finalized — move from open → closed
      this.openCandle.delete(key);

      // Replace-or-append, through the store's single writer.
      if (!this.commit(key, [candle], { replaceExisting: true })) {
        // Refused at admission. The write is skipped AND "candleClosed" is not
        // emitted: firing it on a row we just rejected would hand a listener
        // exactly the data the gate exists to keep out.
        return;
      }

      this.emit("candleClosed", { symbol: update.symbol, timeframe: update.timeframe, candle });
    } else {
      // Kline still forming
      this.openCandle.set(key, candle);
      this.emit("candleUpdate", { symbol: update.symbol, timeframe: update.timeframe, candle });
    }
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  /** Get all candles for a symbol/timeframe (closed + current open) */
  /**
   * CLOSED candles only, oldest → newest.
   *
   * This is the series the SMC engine consumes, and the engine assumes its last
   * element is a FINISHED bar (pivot confirmation, sweep/break classification and
   * "did the candle close back inside" all depend on it).
   *
   * Previously this returned the forming candle as the last element, which meant
   * every one of the ~18 engine call sites was silently analysing an unfinished
   * bar — a live price masquerading as a close. Callers that genuinely want the
   * unfinished bar must use getCandlesWithForming() or read currentCandle.
   */
  getCandles(symbol: string, timeframe: string): Candle[] {
    return this.closed.get(this.key(symbol, timeframe)) ?? [];
  }

  /**
   * Closed candles plus the currently-forming one, for display/liveness only.
   * Do NOT feed this to the SMC engine.
   */
  getCandlesWithForming(symbol: string, timeframe: string): Candle[] {
    const key = this.key(symbol, timeframe);
    const closed = this.closed.get(key) ?? [];
    const open = this.openCandle.get(key);
    if (!open) return closed;

    // Guard against the forming candle already having been archived as closed.
    const lastClosed = closed[closed.length - 1];
    if (lastClosed && lastClosed.time === open.time) return closed;

    return [...closed, open];
  }

  /** Get a complete snapshot for a symbol/timeframe */
  getSnapshot(symbol: string, timeframe: string): CandleSnapshot {
    const key = this.key(symbol, timeframe);
    return {
      symbol,
      timeframe,
      candles: this.getCandles(symbol, timeframe),
      currentCandle: this.openCandle.get(key) ?? null,
      updatedAt: Date.now(),
    };
  }

  /** Get all active symbols currently being tracked */
  getActiveSymbols(): string[] {
    return [...this.activeSymbols];
  }

  /** Check if we have any data for a symbol */
  hasData(symbol: string): boolean {
    for (const [key] of this.closed) {
      if (key.startsWith(`${symbol}|`)) return true;
    }
    for (const [key] of this.openCandle) {
      if (key.startsWith(`${symbol}|`)) return true;
    }
    return false;
  }

  /** Clear all data for a specific symbol (e.g., when switching symbols) */
  clearSymbol(symbol: string): void {
    const prefix = `${symbol}|`;
    for (const key of this.closed.keys()) {
      if (key.startsWith(prefix)) this.closed.delete(key);
    }
    for (const key of this.openCandle.keys()) {
      if (key.startsWith(prefix)) this.openCandle.delete(key);
    }
    this.activeSymbols.delete(symbol);
  }

  /**
   * Bulk-load historical closed candles for a symbol/timeframe.
   * Used to backfill from REST API before the WebSocket stream starts.
   * Deduplicates against existing candles by time.
   */
  seedCandles(symbol: string, timeframe: string, candles: Candle[]): void {
    if (candles.length === 0) return;

    const key = this.key(symbol, timeframe);
    const before = (this.closed.get(key) ?? []).length;

    // Same writer as the live path. This entry point is why guarding only
    // applyUpdate() was not enough: it is a SECOND door into `closed` (REST
    // backfill for forex), so the invariant "nothing malformed reaches `closed`"
    // was only as strong as the weaker of the two doors. The gate now lives
    // behind a single function that both doors call.
    this.commit(key, candles, { replaceExisting: false });
    this.activeSymbols.add(symbol);

    const after = (this.closed.get(key) ?? []).length;
    logger.info({
      symbol,
      timeframe,
      added: after - before,
      total: after,
    }, "Candle store seeded from historical backfill");
  }

  /**
   * The ONLY function that writes to `closed`. Both doors call it.
   *
   * Runs the shared admission gate (see lib/smc/candles.ts) on every incoming
   * row before anything is archived, then merges. `replaceExisting` distinguishes
   * the two callers: the live path replaces a bar it has seen before (a
   * finalised kline supersedes any earlier copy), while a REST backfill only
   * fills gaps and must not overwrite what the live stream already settled.
   *
   * Closure is "proven" by construction at both doors: the live path only sets
   * `isClosed` once the provider finalised the bar, and the backfill reads
   * finished history.
   *
   * Returns false when NOTHING was admitted, so the caller can skip its
   * downstream effects (the live path must not emit `candleClosed`).
   */
  private commit(
    key: string,
    incoming: Candle[],
    opts: { replaceExisting: boolean },
  ): boolean {
    const admission = admitCandles(incoming, {
      closure: "proven",
      nowSeconds: Date.now() / 1000,
      minCandles: 0,
    });
    if (admission.rejected.length > 0) {
      logger.warn(
        { key, rejected: admission.rejected.slice(0, 5) },
        "Candle store rejected row(s) at admission",
      );
    }
    if (admission.candles.length === 0) return false;

    const closedList = this.closed.get(key) ?? [];
    for (const c of admission.candles) {
      const idx = closedList.findIndex((x) => x.time === c.time);
      if (idx >= 0) {
        if (opts.replaceExisting) closedList[idx] = c;
      } else {
        closedList.push(c);
      }
    }

    closedList.sort((a, b) => a.time - b.time);
    while (closedList.length > this.maxCandles) closedList.shift();
    this.closed.set(key, closedList);
    return true;
  }

  /** Return a report of what's being tracked */
  getStatus(): Record<string, { closedCount: number; hasOpen: boolean; latestTime?: number }> {
    const status: Record<string, { closedCount: number; hasOpen: boolean; latestTime?: number }> = {};
    const allKeys = new Set([...this.closed.keys(), ...this.openCandle.keys()]);
    for (const key of allKeys) {
      const closed = this.closed.get(key) ?? [];
      const open = this.openCandle.get(key);
      status[key] = {
        closedCount: closed.length,
        hasOpen: !!open,
        latestTime: open?.time ?? closed[closed.length - 1]?.time,
      };
    }
    return status;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private key(symbol: string, timeframe: string): StoreKey {
    return `${symbol}|${timeframe}`;
  }

  private toCandle(u: CandleUpdate): Candle {
    return {
      time: u.time,
      open: u.open,
      high: u.high,
      low: u.low,
      close: u.close,
      volume: u.volume,
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────────

export const candleStore = new CandleStore();
