/**
 * Dynamic Universe types (REQUIREMENTS §4, §5, §6, §7, §12).
 */

/** Raw liquidity measurements for one perpetual, all in comparable units. */
export interface SymbolMetrics {
  symbol: string;
  baseAsset: string;

  /** 24h traded notional in USDT (quote volume). */
  quoteVolume24h: number | null;
  /** Median of the last 7 daily candles' notional, in USDT. Guards against a single-day pump (§6.2). */
  medianDailyVolume7d: number | null;
  /** Open interest converted to USDT notional (contracts x mark price). */
  openInterestUsd: number | null;
  /** (ask - bid) / mid * 10000. */
  spreadBps: number | null;
  /** Days since the perpetual was listed. */
  listingAgeDays: number | null;

  /** 1-based liquidity rank among eligible symbols; null until ranked. */
  rank: number | null;
  /** Composite rank score — lower is more liquid. See rankMetrics(). */
  score: number | null;
}

export interface UniverseFilters {
  minQuoteVolume24hUsd: number;
  minMedianDailyVolume7dUsd: number;
  minOpenInterestUsd: number;
  maxSpreadBps: number;
  minListingAgeDays: number;
}

/** One filter's outcome, kept for explainability (why a symbol was excluded). */
export interface FilterCheck {
  name: string;
  passed: boolean;
  value: number | null;
  threshold: number;
  detail: string;
}

export interface FilterDecision {
  symbol: string;
  eligible: boolean;
  checks: FilterCheck[];
}

/** A full universe computation — everything needed to audit one refresh. */
export interface UniverseSnapshot {
  computedAt: number;
  totalPerpetuals: number;
  eligibleCount: number;
  rankedCount: number;

  coreSymbols: string[];
  activeSymbols: string[];
  added: string[];
  removed: string[];

  metrics: Record<string, SymbolMetrics>;
  decisions: Record<string, FilterDecision>;
}
