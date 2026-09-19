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

/**
 * A metric with a band around it, both ends named explicitly.
 *
 * A symbol joins the universe above `entryMin`. An existing member is only
 * removed once it falls below `removalMin`. The gap absorbs the ordinary daily
 * wobble in these numbers so a symbol sitting near the line does not flicker in
 * and out of the universe.
 *
 * Both ends are plain numbers in config — no factor, no arithmetic at read
 * time. "What does it take to be removed?" should be answerable by looking.
 */
export interface HysteresisBand {
  entryMin: number;
  removalMin: number;
}

/**
 * Universe eligibility.
 *
 * The metrics that fluctuate carry a band; the two below do not, and the
 * distinction is deliberate:
 *
 *   maxSpreadBps      — a wider spread is worse execution. Granting room would
 *                       keep a symbol in the universe while it becomes costly
 *                       to trade, so it is checked at one value, both ways.
 *   minListingAgeDays — monotonic. A symbol that clears it keeps clearing it,
 *                       so a band would never be exercised.
 */
export interface EligibilityConfig {
  medianVolume7d: HysteresisBand;
  volume24h: HysteresisBand;
  openInterest: HysteresisBand;
  maxSpreadBps: number;
  minListingAgeDays: number;
}

/** How an evaluation was performed — entry standard or already-a-member standard. */
export type EligibilityBasis = "entry" | "removal";

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
  /**
   * Which standard was applied. "entry" for a symbol not currently a member,
   * "removal" for an existing one — the removal standard is the more lenient of
   * the two for banded metrics.
   */
  basis: EligibilityBasis;
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
