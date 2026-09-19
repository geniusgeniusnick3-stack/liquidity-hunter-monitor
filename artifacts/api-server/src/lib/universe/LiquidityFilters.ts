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
import type { SymbolMetrics, UniverseFilters, FilterCheck, FilterDecision } from "./types.js";

const fmtUsd = (v: number | null): string =>
  v === null ? "n/a" : `$${(v / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;

const fmtBps = (v: number | null): string =>
  v === null ? "n/a" : `${v.toFixed(2)} bps`;

// ── Eligibility floor ───────────────────────────────────────────────────────

export function evaluateEligibility(
  m: SymbolMetrics,
  f: UniverseFilters,
): FilterDecision {
  const checks: FilterCheck[] = [];

  const push = (
    name: string,
    value: number | null,
    threshold: number,
    passed: boolean,
    detail: string,
  ) => checks.push({ name, passed, value, threshold, detail });

  // 6.1 — 24h traded notional
  push(
    "quote_volume_24h",
    m.quoteVolume24h,
    f.minQuoteVolume24hUsd,
    m.quoteVolume24h !== null && m.quoteVolume24h >= f.minQuoteVolume24hUsd,
    `24h 名目量 ${fmtUsd(m.quoteVolume24h)} / 門檻 ${fmtUsd(f.minQuoteVolume24hUsd)}`,
  );

  // 6.2 — 7-day median (defeats a one-day pump)
  push(
    "median_daily_volume_7d",
    m.medianDailyVolume7d,
    f.minMedianDailyVolume7dUsd,
    m.medianDailyVolume7d !== null && m.medianDailyVolume7d >= f.minMedianDailyVolume7dUsd,
    m.medianDailyVolume7d === null
      ? "7 日中位量不可得 → 視為不合格（fail-closed）"
      : `7 日中位量 ${fmtUsd(m.medianDailyVolume7d)} / 門檻 ${fmtUsd(f.minMedianDailyVolume7dUsd)}`,
  );

  // 6.3 — open interest
  push(
    "open_interest",
    m.openInterestUsd,
    f.minOpenInterestUsd,
    m.openInterestUsd !== null && m.openInterestUsd >= f.minOpenInterestUsd,
    m.openInterestUsd === null
      ? "持倉量不可得 → 視為不合格（fail-closed）"
      : `OI ${fmtUsd(m.openInterestUsd)} / 門檻 ${fmtUsd(f.minOpenInterestUsd)}`,
  );

  // 6.4 — bid/ask spread
  push(
    "spread_bps",
    m.spreadBps,
    f.maxSpreadBps,
    m.spreadBps !== null && m.spreadBps <= f.maxSpreadBps,
    m.spreadBps === null
      ? "買賣價差不可得 → 視為不合格（fail-closed）"
      : `價差 ${fmtBps(m.spreadBps)} / 上限 ${fmtBps(f.maxSpreadBps)}`,
  );

  // 6.5 — listing age
  push(
    "listing_age_days",
    m.listingAgeDays,
    f.minListingAgeDays,
    m.listingAgeDays !== null && m.listingAgeDays >= f.minListingAgeDays,
    m.listingAgeDays === null
      ? "上市日期不可得 → 視為不合格（fail-closed）"
      : `上市 ${m.listingAgeDays.toFixed(0)} 天 / 門檻 ${f.minListingAgeDays} 天`,
  );

  return { symbol: m.symbol, eligible: checks.every((c) => c.passed), checks };
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
