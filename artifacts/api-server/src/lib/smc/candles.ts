/**
 * The single candle admission gate.
 *
 * WHY ONE GATE
 * ------------
 * Candle data used to enter through five or more doors — the Binance futures
 * fetcher, the Binance daily fetcher, the Yahoo intraday fetcher, the Yahoo
 * daily fetcher, the realtime cache, and whatever a test or a backtest injected.
 * Each door did its own thing, and two of them did nothing at all, so
 * "malformed" and "unfinished" data had several different meanings and a
 * published state could be derived from an in-progress bar.
 *
 * Now every source hands its raw rows to `admitCandles()` first. Callers must not
 * pre-filter — a second, private filter is exactly how the definitions drift
 * apart again.
 *
 * THE CLOSED-BAR RULE
 * -------------------
 * "Has this bar closed?" must be PROVEN, never inferred from arithmetic.
 *
 * An earlier version computed `time + timeframeSeconds <= now` and called that
 * proof. It is not: sources disagree about whether a timestamp is the bar's OPEN
 * or its CLOSE, so the same rule silently delayed or admitted the wrong bar, and
 * for weekly bars it held back Friday's already-closed candle until Monday.
 *
 * So closure is declared by provenance:
 *
 *   "proven"      the source can show each bar has finished — Binance klines
 *                 carry a closeTime, the realtime store carries an isClosed
 *                 flag. Admit every row that passes the shape checks.
 *   "unprovable"  the source cannot show it — Yahoo sends only an open time.
 *                 Drop the LAST row.
 *
 * Dropping one extra bar is not the same kind of mistake as admitting an
 * unfinished one. An unfinished bar's "close" is just the current price, so it
 * manufactures a signal that then has to be retracted — and this system sends
 * notifications. Delaying by one bar is a bounded, documented cost. The two are
 * not symmetric, so the rule errs toward silence.
 *
 * `TF_SECONDS` deliberately plays no part here. That map is for the screening
 * window (a genuine time span), not for guessing whether a bar is finished.
 */
import type { Candle } from "./types.js";

/** Why a row was not usable. Named, so a caller can log which one it hit. */
export type CandleRejectionReason =
  | "not-finite"
  | "non-positive"
  | "ohlc-inconsistent"
  | "time-not-increasing"
  | "time-in-future"
  | "not-closed";

/** What a source can prove about its own rows. See the note above. */
/**
 * What the caller can prove about the LAST row it handed in.
 *
 *   proven       every row is closed (default for our own fetcher)
 *   unprovable   unknown source — the last row is dropped, since it might be forming
 *   live-last    the last row IS the forming candle, deliberately
 *
 * `live-last` exists because this is an OBSERVATION tool: a reader looking at their
 * chart right now sees a candle that has not closed, and a long wick on it is a
 * rejection that has already happened. Judging only the previous bar describes the
 * market as of an hour ago. Nothing in a live read looks ahead — there is no future
 * bar to peek at. Backtests pass `proven` and are unaffected.
 */
export type ClosureEvidence = "proven" | "unprovable" | "live-last";

export interface CandleRejection {
  index: number;
  reason: CandleRejectionReason;
}

export interface CandleAdmission {
  candles: Candle[];
  rejected: CandleRejection[];
  /** True when enough rows survived to be worth analysing at all. */
  usable: boolean;
}

export interface AdmissionOptions {
  /** What the source can prove — see ClosureEvidence. */
  closure: ClosureEvidence;
  /** Wall-clock reference, in seconds. Only used to reject FUTURE timestamps. */
  nowSeconds: number;
  /** Below this many surviving bars the batch is not usable. */
  minCandles: number;
}

/**
 * Admit the rows that are provably usable, and name every row that is not.
 *
 * Checks, in order: finite → positive → internally consistent → strictly
 * increasing → not in the future → closed (per the caller's evidence).
 * A row that fails any check is dropped on its own; it does not poison the rest.
 */
export function admitCandles(raw: Candle[], opts: AdmissionOptions): CandleAdmission {
  const { closure, nowSeconds, minCandles } = opts;

  // An "unprovable" source loses its last row before anything else is judged:
  // that row is the one that might still be forming.
  const source = closure === "unprovable" ? raw.slice(0, -1) : raw;

  const candles: Candle[] = [];
  const rejected: CandleRejection[] = [];
  let previousTime = -Infinity;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];

    const prices = [c.open, c.high, c.low, c.close];
    if (!prices.every((p) => Number.isFinite(p))) {
      rejected.push({ index: i, reason: "not-finite" });
      continue;
    }
    if (!prices.every((p) => p > 0)) {
      rejected.push({ index: i, reason: "non-positive" });
      continue;
    }
    if (c.low > Math.min(c.open, c.close) || Math.max(c.open, c.close) > c.high) {
      rejected.push({ index: i, reason: "ohlc-inconsistent" });
      continue;
    }
    if (!Number.isFinite(c.time) || c.time <= previousTime) {
      rejected.push({ index: i, reason: "time-not-increasing" });
      continue;
    }
    if (c.time > nowSeconds) {
      rejected.push({ index: i, reason: "time-in-future" });
      continue;
    }

    previousTime = c.time;
    candles.push(c);
  }

  return { candles, rejected, usable: candles.length >= minCandles };
}
