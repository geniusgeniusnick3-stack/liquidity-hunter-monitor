/**
 * DynamicUniverseManager (REQUIREMENTS §4, §5, §7, §8).
 *
 * Builds the monitored symbol set from the live Binance USDT-M perpetual
 * market instead of a hard-coded list:
 *
 *   all perpetuals
 *     → liquidity floor (LiquidityFilters.evaluateEligibility)
 *     → relative ranking (LiquidityFilters.rankMetrics)
 *     → hysteresis + core symbols
 *     → active watchlist
 *
 * The set is recomputed on a timer (`universe.refresh_hours`). Recomposition is
 * deliberate about churn: a symbol needs the `entry_min` standard to join but
 * only leaves once it drops below the `removal_min` standard, and core symbols
 * never leave. Both standards are plain configured numbers.
 *
 * Request economy: the whole-market endpoints (exchangeInfo, 24h tickers,
 * book tickers, mark prices) cost 4 calls for all ~770 symbols. Only symbols
 * that already clear the 24h floor get the two extra per-symbol calls
 * (7-day daily notionals + open interest), which keeps a refresh in the low
 * hundreds of requests rather than the thousands.
 */
import { logger } from "../logger.js";
import { loadConfig } from "../config/index.js";
import {
  fetchExchangeInfo,
  fetchAll24hTickers,
  fetchAllBookTickers,
  fetchAllFunding,
  fetchOpenInterest,
  fetchDailyQuoteVolumes,
  type FuturesSymbolInfo,
} from "../market/futures.js";
import { evaluateEligibility, rankMetrics } from "./LiquidityFilters.js";
import type { SymbolMetrics, UniverseSnapshot } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Bounded-concurrency map — keeps us well inside the fapi request budget. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });

  await Promise.all(workers);
  return results;
}

const PER_SYMBOL_CONCURRENCY = 5;

// ── Manager ─────────────────────────────────────────────────────────────────

export class DynamicUniverseManager {
  private snapshot: UniverseSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private isShutdown = false;

  /** Last computed watchlist, or [] before the first refresh. */
  getActiveSymbols(): string[] {
    return this.snapshot?.activeSymbols ?? [];
  }

  getSnapshot(): UniverseSnapshot | null {
    return this.snapshot;
  }

  getLastRefreshAt(): number | null {
    return this.snapshot?.computedAt ?? null;
  }

  /** Fetch a symbol's metrics and eligibility in one shot (used by /universe/symbol). */
  async explain(symbol: string): Promise<{ metrics: SymbolMetrics | null; decision: ReturnType<typeof evaluateEligibility> | null }> {
    const snap = this.snapshot;
    if (!snap) return { metrics: null, decision: null };
    const up = symbol.toUpperCase();
    return { metrics: snap.metrics[up] ?? null, decision: snap.decisions[up] ?? null };
  }

  /**
   * Recompute the universe from live market data.
   * Safe to call concurrently — a second caller joins the in-flight refresh.
   */
  async refresh(): Promise<UniverseSnapshot> {
    if (this.refreshing && this.snapshot) return this.snapshot;
    if (this.refreshing && !this.snapshot) {
      // First refresh already running; wait for it rather than duplicating load.
      while (this.refreshing) await new Promise((r) => setTimeout(r, 250));
      if (this.snapshot) return this.snapshot;
    }

    this.refreshing = true;
    const started = Date.now();

    try {
      const cfg = loadConfig();
      const elig = cfg.universe.eligibility;
      const eligibility = {
        medianVolume7d: {
          entryMin: elig.median_volume_7d.entry_min,
          removalMin: elig.median_volume_7d.removal_min,
        },
        volume24h: {
          entryMin: elig.volume_24h.entry_min,
          removalMin: elig.volume_24h.removal_min,
        },
        openInterest: {
          entryMin: elig.open_interest.entry_min,
          removalMin: elig.open_interest.removal_min,
        },
        maxSpreadBps: elig.max_spread_bps,
        minListingAgeDays: elig.min_listing_age_days,
      };

      // ── 1. Whole-market snapshots (4 requests total) ──
      const [perpetuals, tickers24h, books, funding] = await Promise.all([
        fetchExchangeInfo(),
        fetchAll24hTickers(),
        fetchAllBookTickers(),
        fetchAllFunding(),
      ]);

      const tickerBySymbol = new Map(tickers24h.map((t) => [t.symbol, t]));
      const bookBySymbol = new Map(books.map((b) => [b.symbol, b]));
      const markBySymbol = new Map(funding.map((f) => [f.symbol, f.markPrice]));

      const now = Date.now();

      // ── 2. Cheap metrics for every perpetual ──
      const base: SymbolMetrics[] = perpetuals.map((p: FuturesSymbolInfo) => {
        const t = tickerBySymbol.get(p.symbol);
        const b = bookBySymbol.get(p.symbol);
        return {
          symbol: p.symbol,
          baseAsset: p.baseAsset,
          quoteVolume24h: t ? t.quoteVolume : null,
          medianDailyVolume7d: null,
          openInterestUsd: null,
          spreadBps: b ? b.spreadBps : null,
          listingAgeDays: p.onboardDate
            ? Math.floor((now - p.onboardDate) / 86_400_000)
            : null,
          rank: null,
          score: null,
        };
      });

      // ── 3. Expensive metrics only for symbols that clear the 24h floor ──
      //
      // The floor here is the REMOVAL standard, not the entry one, and that
      // detail is load-bearing. An existing member is allowed to sit between
      // the two thresholds — e.g. 24h volume of 27M against entry 30M /
      // removal 25M. Shortlisting on the entry value alone would skip fetching
      // its 7-day volume and open interest, those would read as null, and
      // fail-closed would eject a member that is entitled to stay. Fetching on
      // the looser bound means every symbol that could still be a member has
      // the data needed to decide.
      const shortlistFloor = Math.min(eligibility.volume24h.entryMin, eligibility.volume24h.removalMin);
      const shortlisted = base.filter(
        (m) => m.quoteVolume24h !== null && m.quoteVolume24h >= shortlistFloor,
      );

      logger.info(
        { total: base.length, shortlisted: shortlisted.length, floorUsd: shortlistFloor },
        "Universe: fetching per-symbol metrics for shortlisted symbols",
      );

      const enriched = await mapLimited(shortlisted, PER_SYMBOL_CONCURRENCY, async (m) => {
        const [dailyVols, oi] = await Promise.all([
          fetchDailyQuoteVolumes(m.symbol, 7).catch((err) => {
            logger.debug({ symbol: m.symbol, err: String(err) }, "7d volumes unavailable");
            return null;
          }),
          fetchOpenInterest(m.symbol).catch((err) => {
            logger.debug({ symbol: m.symbol, err: String(err) }, "open interest unavailable");
            return null;
          }),
        ]);

        const markPrice = markBySymbol.get(m.symbol) ?? null;
        return {
          ...m,
          medianDailyVolume7d: dailyVols ? median(dailyVols) : null,
          openInterestUsd: oi && markPrice ? oi.openInterest * markPrice : null,
        };
      });

      const enrichedBySymbol = new Map(enriched.map((m) => [m.symbol, m]));
      const allMetrics = base.map((m) => enrichedBySymbol.get(m.symbol) ?? m);

      // ── 4. Floor + ranking ──
      //
      // Which standard applies depends on whether the symbol is already a
      // member, so the previous watchlist is read before the loop. This is the
      // hysteresis: incumbents are judged against the looser bound.
      const previousForEval = this.snapshot?.activeSymbols ?? [];
      const previousSet = new Set(previousForEval);

      const decisions: Record<string, ReturnType<typeof evaluateEligibility>> = {};
      const eligible: SymbolMetrics[] = [];

      for (const m of allMetrics) {
        const d = evaluateEligibility(m, eligibility, {
          isExistingMember: previousSet.has(m.symbol),
        });
        decisions[m.symbol] = d;
        if (d.eligible) eligible.push(m);
      }

      // Ranking is retained for DISPLAY ORDER and transparency only — it does
      // not decide membership, because there is no size cap to rank against.
      const ranked = rankMetrics(eligible);
      const rankBySymbol = new Map(ranked.map((m) => [m.symbol, m.rank ?? Number.MAX_SAFE_INTEGER]));

      // ── 5. Core symbols ──
      //
      // There is no hysteresis work left to do here. Incumbents were already
      // judged against the removal standard in step 4, so `eligible` contains
      // both the symbols that newly qualify and the members that are allowed to
      // stay. A second relaxed pass would be the same test run twice.
      //
      // The universe has NO size cap: 38 eligible means 38 symbols, 61 means
      // 61. Ranking orders the display and nothing else.
      const allSymbolSet = new Set(allMetrics.map((m) => m.symbol));
      const core = cfg.universe.core_symbols
        .map((s) => s.toUpperCase())
        .filter((s) => allSymbolSet.has(s));

      const previous = previousForEval;

      // No cap: core symbols plus everyone who satisfies the applicable standard.
      const active = [...new Set([...core, ...eligible.map((m) => m.symbol)])];

      // Stable presentation order: core first (config order), then by rank.
      const ordered = [...active].sort((a, b) => {
        const ai = core.indexOf(a);
        const bi = core.indexOf(b);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
        return (rankBySymbol.get(a) ?? Number.MAX_SAFE_INTEGER) - (rankBySymbol.get(b) ?? Number.MAX_SAFE_INTEGER);
      });

      const metricsBySymbol: Record<string, SymbolMetrics> = {};
      for (const m of allMetrics) metricsBySymbol[m.symbol] = m;
      // Attach the computed rank for transparency.
      for (const m of ranked) metricsBySymbol[m.symbol] = m;

      const snapshot: UniverseSnapshot = {
        computedAt: Date.now(),
        totalPerpetuals: allMetrics.length,
        eligibleCount: eligible.length,
        rankedCount: ranked.length,
        coreSymbols: core,
        activeSymbols: ordered,
        added: ordered.filter((s) => !previous.includes(s)),
        removed: previous.filter((s) => !ordered.includes(s)),
        metrics: metricsBySymbol,
        decisions,
      };

      this.snapshot = snapshot;

      logger.info(
        {
          ms: Date.now() - started,
          total: snapshot.totalPerpetuals,
          eligible: snapshot.eligibleCount,
          active: snapshot.activeSymbols.length,
          added: snapshot.added.length,
          removed: snapshot.removed.length,
        },
        "Universe refreshed",
      );

      return snapshot;
    } finally {
      this.refreshing = false;
    }
  }

  /** Start periodic recomputation. Performs an immediate first refresh. */
  start(): void {
    if (this.timer || this.isShutdown) return;
    const cfg = loadConfig();
    const intervalMs = cfg.universe.refresh_hours * 3_600_000;

    this.refresh().catch((err) => logger.error({ err }, "Initial universe refresh failed"));

    this.timer = setInterval(() => {
      this.refresh().catch((err) => logger.error({ err }, "Scheduled universe refresh failed"));
    }, intervalMs);

    logger.info({ refreshHours: cfg.universe.refresh_hours }, "DynamicUniverseManager started");
  }

  stop(): void {
    this.isShutdown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("DynamicUniverseManager stopped");
  }
}

export const universeManager = new DynamicUniverseManager();
