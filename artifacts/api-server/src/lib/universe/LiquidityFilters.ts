/**
 * Liquidity filters and ranking (REQUIREMENTS §6, §7).
 *
 * Two separate steps, deliberately:
 *   1. `evaluateEligibility` — a hard floor. Below it a symbol is not
 *      tradeable-quality regardless of how it ranks.
 *   2. `rankMetrics` — a relative ordering among the survivors.
 *
 * The requirement is explicit that a single `volume > N` test is not
 * acceptable; the floor only decides *who is eligible*, ranking decides who is
 * watched.
 *
 * Missing data is treated as FAIL, not as a pass. A symbol whose open interest
 * or 7-day history could not be retrieved has not demonstrated liquidity, so it
 * stays out — consistent with the fail-closed policy used elsewhere in this
 * system.
 */
import type {
  SymbolMetrics,
  EligibilityConfig,
  FilterCheck,
  FilterDecision,
  EligibilityBasis,
} from "./types.js";

const fmtUsd = (v: number | null): string =>
  v === null ? "n/a" : `$${(v / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;

const fmtBps = (v: number | null): string =>
  v === null ? "n/a" : `${v.toFixed(2)} bps`;

// ── Eligibility floor ───────────────────────────────────────────────────────

/**
 * Decide whether a symbol belongs in the universe.
 *
 * The standard depends on whether the symbol is already a member:
 *
 *   not a member → every banded metric must clear `entryMin`
 *   already one  → a banded metric may sit anywhere above `removalMin`
 *
 * That asymmetry IS the hysteresis. Without it a symbol hovering at the entry
 * line would join on a good day, drop out the next, and rejoin — churning
 * membership and re-reporting the same levels.
 *
 * The two hard gates (`spread`, `age`) read the same at both ends on purpose:
 * see the note on EligibilityConfig in types.ts.
 *
 * Missing data fails, at both standards. A symbol whose open interest could not
 * be retrieved has not demonstrated liquidity, and the more lenient standard is
 * not a licence to guess.
 */
export function evaluateEligibility(
  m: SymbolMetrics,
  e: EligibilityConfig,
  options: { isExistingMember?: boolean } = {},
): FilterDecision {
  const isMember = options.isExistingMember ?? false;
  const basis: EligibilityBasis = isMember ? "removal" : "entry";
  const checks: FilterCheck[] = [];

  const push = (
    name: string,
    value: number | null,
    threshold: number,
    passed: boolean,
    detail: string,
  ) => checks.push({ name, passed, value, threshold, detail });

  /**
   * A banded metric: `>= threshold` where the threshold depends on the basis.
   * The detail string names which standard was applied, so a decision can be
   * read back without re-deriving it.
   */
  const pushBanded = (
    name: string,
    label: string,
    value: number | null,
    band: { entryMin: number; removalMin: number },
  ) => {
    const threshold = isMember ? band.removalMin : band.entryMin;
    const what = isMember ? "保留門檻" : "加入門檻";
    push(
      name,
      value,
      threshold,
      value !== null && value >= threshold,
      value === null
        ? `${label}不可得 → 視為不合格（fail-closed）`
        : `${label} ${fmtUsd(value)} / ${what} ${fmtUsd(threshold)}`,
    );
  };

  // 6.1 — 24h traded notional
  pushBanded("quote_volume_24h", "24h 名目量", m.quoteVolume24h, e.volume24h);

  // 6.2 — 7-day median (defeats a one-day pump)
  pushBanded("median_daily_volume_7d", "7 日中位量", m.medianDailyVolume7d, e.medianVolume7d);

  // 6.3 — open interest
  pushBanded("open_interest", "持倉量", m.openInterestUsd, e.openInterest);

  // 6.4 — bid/ask spread. Hard gate: a wider spread is worse execution, so it
  // is checked at one value whether the symbol is joining or staying.
  push(
    "spread_bps",
    m.spreadBps,
    e.maxSpreadBps,
    m.spreadBps !== null && m.spreadBps <= e.maxSpreadBps,
    m.spreadBps === null
      ? "買賣價差不可得 → 視為不合格（fail-closed）"
      : `價差 ${fmtBps(m.spreadBps)} / 上限 ${fmtBps(e.maxSpreadBps)}`,
  );

  // 6.5 — listing age. Hard gate: monotonic, so a band would never be used.
  push(
    "listing_age_days",
    m.listingAgeDays,
    e.minListingAgeDays,
    m.listingAgeDays !== null && m.listingAgeDays >= e.minListingAgeDays,
    m.listingAgeDays === null
      ? "上市日期不可得 → 視為不合格（fail-closed）"
      : `上市 ${m.listingAgeDays.toFixed(0)} 天 / 門檻 ${e.minListingAgeDays} 天`,
  );

  return { symbol: m.symbol, eligible: checks.every((c) => c.passed), checks, basis };
}

// ── Ranking ─────────────────────────────────────────────────────────────────

/**
 * Rank eligible symbols by a composite of liquidity measures.
 *
 * Rank-based rather than weight-summed so a single outlier (BTC's volume is
 * ~4,000x the median) cannot dominate. Each measure contributes an ordinary
 * 1..n rank; the score is the mean rank; ties break on 24h volume.
 *
 * Missing values rank last — they already failed eligibility, but ranking the
 * survivors defensively keeps this function safe to call on any input.
 */
export function rankMetrics(list: SymbolMetrics[]): SymbolMetrics[] {
  const n = list.length;
  if (n === 0) return [];

  // Higher is better for these three.
  const ascending = (sel: (m: SymbolMetrics) => number | null) => {
    const sorted = [...list].sort((a, b) => {
      const av = sel(a);
      const bv = sel(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
    const rank = new Map<string, number>();
    sorted.forEach((m, i) => rank.set(m.symbol, i + 1));
    return rank;
  };

  const volRank = ascending((m) => m.quoteVolume24h);
  const oiRank = ascending((m) => m.openInterestUsd);
  const medianRank = ascending((m) => m.medianDailyVolume7d);
  // Lower is better for spread → invert the selector's meaning by ranking on
  // the negated value so the same helper works.
  const spreadRank = ascending((m) => (m.spreadBps === null ? null : -m.spreadBps));

  const scored = list.map((m) => {
    const parts = [
      volRank.get(m.symbol) ?? n,
      oiRank.get(m.symbol) ?? n,
      medianRank.get(m.symbol) ?? n,
      spreadRank.get(m.symbol) ?? n,
    ];
    const score = parts.reduce((a, b) => a + b, 0) / parts.length;
    return { ...m, score };
  });

  scored.sort((a, b) => {
    const d = (a.score ?? n) - (b.score ?? n);
    if (Math.abs(d) > 1e-9) return d;
    return (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0);
  });

  return scored.map((m, i) => ({ ...m, rank: i + 1 }));
}
