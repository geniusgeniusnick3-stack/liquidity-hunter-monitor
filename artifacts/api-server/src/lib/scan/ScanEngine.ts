/**
 * Shared scan engine.
 *
 * ONE implementation of the pipeline both monitoring modes must use:
 *
 *   market data → dynamic universe → SMC engine → event classification → alerts
 *
 * PASSIVE and ACTIVE differ ONLY in what triggers a scan and whether the
 * resulting alerts are pushed to the user. Neither mode owns any analysis
 * logic: this module is the single place where liquidity events are derived,
 * persisted, de-duplicated and rendered into alert text.
 *
 *   PASSIVE  → user command  → runScan() → reply to that command
 *   ACTIVE   → timer          → runScan() → push proactive alerts
 *
 * If a change to market interpretation is ever needed, it belongs here (or in
 * the SMC engine) and both modes inherit it automatically.
 */
import { loadConfig } from "../config/index.js";
import { fetchKlines } from "../market/futures.js";
import { admitCandles, type ClosureEvidence } from "../smc/candles.js";
import type { Candle } from "../smc/types.js";
import { analyzeLiquidity } from "../smc/liquidity.js";
import type { LiquidityPool } from "../smc/types.js";
import { analyzeStructure } from "../smc/structure.js";
import { analyzeFVG } from "../smc/fvg.js";
import { analyzeOrderBlocks } from "../smc/order-blocks.js";
import {
  analyzeMarketState,
  hasRecentTake,
  DEFAULT_MARKET_STATE_CONFIG,
  type MarketStateConfig,
} from "../smc/market-state.js";
import type { MarketState } from "../smc/types.js";
import { restorePersistedLevels } from "./RestoredLevels.js";
import { formatApproaching, formatSweepGroup, type LiquiditySide } from "../notify/formatters.js";
import { AlertDeduplicator, liquidityLevelId, type AlertIdentity } from "../events/Deduplicator.js";
import { getLiquidityStore } from "../persistence/LiquidityStore.js";
import { resolveLanguage, stringsFor, LANGUAGE_OVERRIDE_KEY, type Language } from "../notify/i18n.js";

// ── Result shapes ───────────────────────────────────────────────────────────

export interface ScanEvent {
  symbol: string;
  timeframe: string;
  side: LiquiditySide;
  state: "SWEPT" | "BROKEN";
  /** Every level settled by the same candle — collapsed into one alert. */
  levels: number[];
  /**
   * The pool kind behind each entry in `levels`, positionally parallel.
   *
   * `side` collapses EQH→BSL and EQL→SSL, so by the time a level reaches the
   * message layer a merged equal-level pool is indistinguishable from a plain
   * swing. The kinds travel alongside the prices for that reason: the report has
   * to be able to say "this one was tested twice".
   */
  levelTypes: LiquidityPool["type"][];
  candleTime: number;
  extreme: number;
  close: number;
}

export interface ScanApproach {
  symbol: string;
  /** All timeframes where this price is a live level, highest first. */
  timeframes: string[];
  /** The highest timeframe — drives the message wording. */
  primary: string;
  side: LiquiditySide;
  price: number;
  currentPrice: number;
  distancePct: number;
  source: string;
  /**
   * The pool kind (BSL/SSL/EQH/EQL). `side` collapses the merged variants, so
   * without this the message layer cannot tell the reader that the approaching
   * level is one that has already been tested twice.
   */
  poolType: LiquidityPool["type"];
}

export interface ScanHistorySkip {
  symbol: string;
  timeframe: string;
  side: LiquiditySide;
  price: number;
  poolType: LiquidityPool["type"];
  priorPrice: number;
  priorState: string;
  priorAt: number | null;
}

/**
 * An alert ready to be delivered.
 *
 * When `applyDedup` is false (the passive-query case) this is every current
 * finding, not only the ones that are new since last time.
 */
export interface PendingAlert {
  text: string;
  identity: AlertIdentity;
  label: string;
}

/**
 * One level as it currently stands, for a single-symbol query.
 *
 * A market-wide scan reports events (what just happened). A single-symbol query
 * needs the opposite: the standing picture — every level still in play plus the
 * recent history. Reporting "no events" for a symbol with six live levels above
 * and below price answers a question nobody asked.
 */
export interface LevelSnapshot {
  price: number;
  side: LiquiditySide;
  state: string;
  /** true = already consumed (SWEPT/BROKEN). */
  taken: boolean;
  /** Distance from current price, in percent; negative if below. */
  distancePct: number;
  formedAt: number;
  interactionAt: number | null;
  touches: number;
  /**
   * The pool's own kind (BSL/SSL/EQH/EQL). `side` collapses EQH→BSL and EQL→SSL
   * because every consumer asks by side; this keeps the distinction that the
   * merge produced, so a reply can name a merged level.
   */
  poolType: LiquidityPool["type"];
}

export interface SymbolSnapshot {
  symbol: string;
  timeframe: string;
  currentPrice: number;
  levels: LevelSnapshot[];
  /**
   * Post-interaction market state for this symbol/timeframe.
   *
   * Null in two cases: the layer is switched off in config, or the funnel
   * stopped here (nothing was taken within the screening window, so there is no
   * state to describe — not "no state exists", just "nothing worth judging").
   */
  marketState: MarketState | null;
}

/** The state layer for one symbol/timeframe, as returned from a scan. */
export interface SymbolMarketState {
  symbol: string;
  timeframe: string;
  state: MarketState;
}

export interface ScanResult {
  events: ScanEvent[];
  approaches: ScanApproach[];
  historySkipped: ScanHistorySkip[];
  /** Alerts that survived dedup/cooldown and are safe to send. */
  pending: PendingAlert[];
  /** Alerts suppressed by dedup/cooldown, for logging. */
  suppressed: Array<{ label: string; reason: string }>;
  scanned: number;
  failures: number;
  latestCandleTime: number;
  symbolCount: number;
  eligibleCount: number;
  /** Language actually used, after env/user/config resolution. */
  language: Language;
  /**
   * Full standing state per symbol/timeframe.
   *
   * Populated only when the scan is narrow (an explicit symbol list), because
   * carrying 55 symbols x 2 timeframes of levels would be a lot of data for a
   * market-wide summary that does not display it.
   */
  snapshots: SymbolSnapshot[];
  /**
   * Stage-2 results — one entry per symbol/timeframe that passed the funnel.
   *
   * Populated whether or not the caller asked for snapshots, because a
   * market-wide query wants the states even though it does not want a hundred
   * level lists.
   */
  marketStates: SymbolMarketState[];
}

export interface ScanOptions {
  /** Restrict to specific symbols (user asked for one). Defaults to the universe. */
  symbols?: string[];
  /** Restrict to specific timeframes. Defaults to config.timeframes. */
  timeframes?: string[];
  /** Progress/log sink. PASSIVE prints it; ACTIVE logs it. */
  onLog?: (message: string) => void;
  /**
   * Apply de-duplication and cooldown to the resulting alerts.
   *
   * Only for PUSH delivery. De-duplication exists to stop the system from
   * interrupting someone about the same event twice — that concern applies to a
   * background monitor pushing alerts, and NOT to a person who just asked a
   * question.
   *
   * A passive query is answered with the current state, full stop. "No new
   * events" is the wrong answer to "what is happening right now?" when three
   * levels are sitting there live, merely because they were reported earlier.
   *
   * Defaults to false: suppressing output must be opted into, never inherited.
   */
  applyDedup?: boolean;
  /** Alias kept so existing debug callers keep working. */
  bypassDedup?: boolean;
  /**
   * Where candles come from. Defaults to a direct fetch.
   *
   * ACTIVE mode injects a cache-backed loader so that polling more often than
   * candles close costs nothing; PASSIVE mode leaves it alone because a manual
   * query should always hit the exchange.
   */
  candleSource?: (symbol: string, timeframe: string, limit: number) => Promise<Candle[]>;
  /**
   * What the candle source can prove about its own last bar.
   *
   * A custom `candleSource` is an UNKNOWN source from this module's point of
   * view, so it defaults to "unprovable" — the gate drops its last row. A caller
   * that knows its source returns only closed bars says so explicitly. The
   * default fetch path is Binance klines, which carries a close time per row, so
   * it can prove closure. See `lib/smc/candles.ts`.
   */
  candleClosure?: ClosureEvidence;
  /**
   * How many symbol/timeframe pairs to analyse at once.
   *
   * This is the knob that keeps a large universe inside exchange rate limits:
   * raising it finishes a scan sooner at the cost of burstier traffic. ACTIVE
   * mode passes monitoring.active_concurrency; PASSIVE leaves it at the default
   * because a one-off query has no reason to be conservative.
   */
  concurrency?: number;
}

// ── Timeframe display order ─────────────────────────────────────────────────

const TF_ORDER = ["1w", "1d", "4h", "1h", "30m", "15m", "5m", "1m"];

/**
 * History depth per analysis, in candles.
 *
 * This number is load-bearing for liquidity lifetime, because there is no
 * age-based expiry: a level is visible to a scan only while it sits inside this
 * window, so the window IS the horizon. At 500 bars that is ~20.8 days on 1H
 * and ~83 days on 4H — both comfortably past the seven-day figure that must
 * never expire a level.
 *
 * Measured against the live ledger: of 591 unresolved levels on record, zero
 * fall outside this window on their own timeframe. Nothing older is being lost.
 *
 * Shrinking it would silently shorten how far back unresolved liquidity can be
 * found, so candle-depth.test.ts asserts the resulting spans in days rather
 * than trusting this comment.
 */
export const SCAN_CANDLE_LIMIT = 500;

// ── The scan ────────────────────────────────────────────────────────────────

/**
 * Run one full scan and return everything derived from it.
 *
 * Callers decide what to DO with the result — this function never sends
 * anything itself, which is what keeps the two modes on identical analysis.
 */
export async function runScan(options: ScanOptions = {}): Promise<ScanResult> {
  const log = options.onLog ?? (() => {});
  const config = loadConfig();
  // Language resolution happens per scan, not once at boot, so a /language
  // change takes effect on the very next scan instead of requiring a restart.
  const store = getLiquidityStore();
  const { language } = resolveLanguage(
    config.notifications.language,
    () => store.getState<string>(LANGUAGE_OVERRIDE_KEY),
  );

  const timeframes = options.timeframes?.length ? options.timeframes : config.timeframes;
  const approachPct = config.alert_thresholds.approaching_distance_pct;
  // The live scan keeps the forming candle: the reader's chart shows it, and a
  // wick on it is a rejection that has already happened. See ClosureEvidence.
  const getCandles = options.candleSource ?? ((s: string, t: string, l: number) =>
    fetchKlines(s, t, l, true));
  const candleClosure: ClosureEvidence =
    options.candleClosure ?? (options.candleSource ? "unprovable" : "live-last");

  // ── Dedup + cooldown (§17, §18), persisted across runs ──
  const dedup = new AlertDeduplicator(
    {
      dedupWindowHours: config.alert_thresholds.dedup_window_hours,
      cooldownMinutes: config.alert_thresholds.cooldown_minutes,
    },
    () => Date.now(),
  );
  // Dedup is push-delivery machinery. A passive query does not consult it at
  // all, so it neither suppresses output nor advances the stored state — asking
  // a question must not change what the background monitor will report later.
  const useDedup = options.applyDedup === true && options.bypassDedup !== true;

  const savedDedup = store.getState<ReturnType<AlertDeduplicator["exportState"]>>("dedup_state");
  if (savedDedup && useDedup) {
    dedup.importState(savedDedup);
  }

  // ── Which symbols? ──
  let symbols: string[];
  let eligibleCount = 0;
  if (options.symbols?.length) {
    symbols = options.symbols;
  } else {
    const { universeManager } = await import("../universe/DynamicUniverseManager.js");
    const snap = await universeManager.refresh();
    symbols = snap.activeSymbols;
    eligibleCount = snap.eligibleCount;
  }

  // Internal progress notes. These go to the operator's log, not to the user —
  // the user-facing reply is built separately (see formatScanReply) so debug
  // detail never leaks into a chat message.
  if (savedDedup && useDedup) {
    log(`dedup state: ${dedup.getStats().trackedEvents} events / ${dedup.getStats().trackedLevels} levels loaded`);
  }
  if (options.symbols?.length) {
    log(`symbols: ${symbols.join(", ")}`);
  } else {
    log(`universe: ${symbols.length} symbols (${eligibleCount} eligible)`);
  }

  const regionTolerancePct = config.liquidity.region_tolerance_pct;
  const regionLookbackDays = config.liquidity.region_lookback_days;

  // ── Stage-2 configuration ──
  //
  // The funnel is deliberate. Stage 1 answers "was anything taken?" for the
  // whole universe and costs one liquidity analysis per pair. Everything stage 2
  // adds — structure, gaps, blocks — is only meaningful once something WAS
  // taken, so it runs for those pairs and nowhere else. On a market-wide scan
  // that is typically a handful out of ~110.
  //
  // `explicitScope` matters because a caller who named a symbol has already
  // said which one they care about; answering "nothing recent was taken" with an
  // empty state would be unhelpful when they asked a direct question.
  const marketStateEnabled = config.market_state.enabled;
  const marketStateConfig: MarketStateConfig = {
    ...DEFAULT_MARKET_STATE_CONFIG,
    screening_lookback_bars: config.market_state.screening_lookback_bars,
  };
  const explicitScope = Boolean(options.symbols?.length);

  const groupMap = new Map<string, ScanEvent>();
  // Only worth gathering when the caller asked about specific symbols.
  const wantSnapshots = Boolean(options.symbols?.length);
  const snapshots: SymbolSnapshot[] = [];
  const marketStatesRaw: SymbolMarketState[] = [];
  const approachingRaw: ScanApproach[] = [];
  const historySkipped: ScanHistorySkip[] = [];
  let scanned = 0;
  let failures = 0;
  let latestCandleTime = 0;

  // Flatten to one work item per symbol/timeframe, then process with bounded
  // concurrency. Sequential was fine for a handful of symbols but leaves a
  // 50+ symbol universe needlessly slow.
  const pairs: Array<{ symbol: string; tf: string }> = [];
  for (const symbol of symbols) {
    for (const tf of timeframes) pairs.push({ symbol, tf });
  }

  const concurrency = Math.max(1, options.concurrency ?? 5);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= pairs.length) return;
      const { symbol, tf } = pairs[i];
      // Which phase blew up, for the catch below. Without it a failure is a bare
      // count and the operator cannot tell a network problem from a bad candle
      // from a state-layer fault.
      let stage = "fetch";
      try {
        // The gate runs here as well as inside the fetchers, because a custom
        // `candleSource` bypasses them entirely. That path used to hand raw rows
        // straight to analyzeLiquidity() AND to the `currentPrice` divisor below,
        // so a zero price reached a division. One gate, every door.
        const fetched = await getCandles(symbol, tf, SCAN_CANDLE_LIMIT);
        const admission = admitCandles(fetched, {
          closure: candleClosure,
          nowSeconds: Date.now() / 1000,
          minCandles: config.scanner.min_candles_required,
        });
        if (admission.rejected.length > 0) {
          log(
            `${symbol} ${tf}: 准入關卡剔除 ${admission.rejected.length} 根 — ` +
              admission.rejected.slice(0, 3).map((r) => `#${r.index}:${r.reason}`).join(", "),
          );
        }
        const candles = admission.candles;
        if (!admission.usable) continue;

        scanned++;
        stage = "liquidity";
        const lastClosed = candles[candles.length - 1];
        latestCandleTime = Math.max(latestCandleTime, lastClosed.time);
        const currentPrice = lastClosed.close;
        const res = analyzeLiquidity(candles, tf, "crypto");

        // Standing state for this symbol/timeframe, gathered alongside the event
        // detection so a single-symbol query can show the whole picture.
        const levels: LevelSnapshot[] = [];

        // One handler for every level this pass considers — engine-detected or
        // restored from the ledger. Two sources, one path: the standing state,
        // the ledger write, same-area suppression, event detection and the
        // approach test are identical for both, so a restored level cannot
        // drift into behaving differently from a detected one.
        const seenLevelIds = new Set<string>();

        const handlePool = (pool: LiquidityPool): void => {
          const side: LiquiditySide = pool.type === "SSL" ? "SSL" : "BSL";
          const levelId = liquidityLevelId(symbol, tf, side, pool.time, pool.price);
          seenLevelIds.add(levelId);

          if (wantSnapshots) {
            levels.push({
              price: pool.price,
              side,
              state: pool.interaction,
              taken: pool.wasSwept,
              distancePct: (pool.price - currentPrice) / currentPrice * 100,
              formedAt: pool.time,
              interactionAt: pool.interactionAt,
              touches: pool.touches,
              poolType: pool.type,
            });
          }

          // Ledger write (§11): remember this level exists.
          store.upsertLevel({
            id: levelId,
            symbol,
            timeframe: tf,
            side,
            price: pool.price,
            formedAt: pool.time,
            session: pool.session,
            // Localised, not hardcoded: this string is read by the user, and a
            // Simplified or English reader must not get Traditional wording.
            source: stringsFor(language).touches(pool.touches),
            touches: pool.touches,
          });

          // Persist the engine's verdict so it survives restarts.
          if (pool.wasSwept && pool.interactionAt !== null && pool.interactionCandle) {
            store.setState(
              levelId,
              pool.interaction === "BROKEN" ? "BROKEN" : "SWEPT",
              {
                sweptAt: pool.interaction === "SWEPT" ? pool.interactionAt * 1000 : undefined,
                sweepExtreme: side === "BSL" ? pool.interactionCandle.high : pool.interactionCandle.low,
                brokenAt: pool.interaction === "BROKEN" ? pool.interactionAt * 1000 : undefined,
              },
            );
          }

          // ── Same-area memory (§11) ──
          // A rolling-window pivot has no history, so an area handled days ago
          // can look brand new. Suppress the re-announcement.
          if (!pool.wasSwept) {
            const priorTaken = store.takenNear(
              symbol, tf, side, pool.price, regionTolerancePct, regionLookbackDays,
            );
            if (priorTaken && priorTaken.id !== levelId) {
              historySkipped.push({
                symbol, timeframe: tf, side, price: pool.price,
                poolType: pool.type,
                priorPrice: priorTaken.price,
                priorState: priorTaken.state,
                priorAt: priorTaken.sweptAt ?? priorTaken.brokenAt ?? priorTaken.stateChangedAt,
              });
              return;
            }
          }

          // A genuine event: the interaction landed on the most recent
          // COMPLETED candle. Earlier candles are history, not news.
          const isEvent = pool.interactionAt === lastClosed.time
            && (pool.interaction === "SWEPT" || pool.interaction === "BROKEN");

          if (isEvent && pool.interactionCandle) {
            const key = `${symbol}|${tf}|${side}|${pool.interaction}|${lastClosed.time}`;
            const existing = groupMap.get(key);
            if (existing) {
              existing.levels.push(pool.price);
              existing.levelTypes.push(pool.type);
            } else {
              groupMap.set(key, {
                symbol, timeframe: tf, side,
                state: pool.interaction as "SWEPT" | "BROKEN",
                candleTime: lastClosed.time,
                levels: [pool.price],
                levelTypes: [pool.type],
                extreme: side === "BSL" ? pool.interactionCandle.high : pool.interactionCandle.low,
                close: pool.interactionCandle.close,
              });
            }
            return;
          }

          // Approaching and still untaken.
          if (!pool.wasSwept) {
            const distancePct = Math.abs(pool.price - currentPrice) / currentPrice * 100;
            const onCorrectSide = side === "BSL" ? pool.price > currentPrice : pool.price < currentPrice;
            if (onCorrectSide && distancePct <= approachPct) {
              approachingRaw.push({
                symbol, side, price: pool.price,
                poolType: pool.type,
                timeframes: [tf], primary: tf,
                currentPrice, distancePct,
                // Localised for the same reason as the snapshot's source line.
                source: `${stringsFor(language).touches(pool.touches)}｜${pool.session ?? stringsFor(language).unknownSession}`,
              });
            }
          }
        };

        for (const pool of res.pools) handlePool(pool);

        // ── Levels the engine can no longer see ──
        //
        // The pivot scan begins `windowSize` bars into the array, so a level's
        // index drifting past that boundary as the window slides forward takes
        // it out of the engine's reach even though its candle is still loaded.
        // The ledger remembers it; this re-verifies it against the candles
        // before trusting it (see RestoredLevels).
        //
        // Unresolved rows only: a level already SWEPT or BROKEN is history, and
        // a fresh take on it would arrive through the engine's own output.
        const candidates = store
          .listLevels(symbol, tf)
          .filter((l) => l.state === "ACTIVE" || l.state === "APPROACHING" || l.state === "TOUCHED");

        stage = "restore";
        const restore = restorePersistedLevels({
          candidates,
          candles,
          timeframe: tf,
          engineIds: seenLevelIds,
        });
        for (const pool of restore.restored) handlePool(pool);

        if (restore.restored.length > 0) {
          log(`restored ${restore.restored.length} level(s) beyond the engine's reach for ${symbol} ${tf}`);
        }

        // ── Stage 2: depth, only for what passed the funnel ──
        //
        // Everything below is the answer to "did the market accept that take, or
        // is it failing?" — which is meaningless until something has been taken.
        // Running it for all ~110 pairs would triple the analysis cost per scan
        // to describe levels that were never touched.
        stage = "market-state";

        // The gate must see EVERY level this pass handled, not only the engine's
        // own output. A level restored from the ledger and taken recently is
        // exactly the case the section above exists for — gating it out would
        // silently drop it from the state layer while it still appeared in the
        // level list, which is the worst of both.
        const allPools = [...res.pools, ...restore.restored];

        let marketState: MarketState | null = null;
        const investigate =
          marketStateEnabled &&
          (explicitScope || hasRecentTake(allPools, candles, tf, marketStateConfig));

        if (investigate) {
          const structure = analyzeStructure(candles, tf);
          const fvg = analyzeFVG(candles, "crypto");
          const orderBlocks = analyzeOrderBlocks(candles, fvg);
          marketState = analyzeMarketState({
            candles,
            timeframe: tf,
            liquidity: allPools,
            structure,
            fvg,
            orderBlocks,
            config: marketStateConfig,
            // `live-last` means the final row is the candle still forming. Passing it
            // lets the state layer read the bar the reader is watching (see the wick
            // rule in evaluateBreakout). A backtest source reports `proven` and this
            // stays false.
            formingLast: candleClosure === "live-last",
          });
          marketStatesRaw.push({ symbol, timeframe: tf, state: marketState });
        } else if (marketStateEnabled) {
          log(`stage 2 skipped for ${symbol} ${tf} — nothing taken within the screening window`);
        }

        if (wantSnapshots) {
          snapshots.push({ symbol, timeframe: tf, currentPrice, levels, marketState });
        }
      } catch (err) {
        failures++;
        // Named, never silently counted. Stage 2 widened the surface this catch
        // covers, so "failures: 3" with no further detail stopped being enough
        // to operate from.
        log(
          `FAILED ${symbol} ${tf} at stage=${stage} — ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pairs.length) }, () => worker()),
  );

  // ── Cross-timeframe collapse: one price, one message ──
  // The same level is often a pivot on several timeframes at once. To a human
  // that is ONE observation, so report the highest timeframe and note the rest.
  const approachMap = new Map<string, ScanApproach>();
  for (const a of approachingRaw) {
    const bucket = Math.round(Math.log(a.price) / Math.log(1.002)); // 0.2% buckets
    const key = `${a.symbol}|${a.side}|${bucket}`;
    const existing = approachMap.get(key);
    if (existing) {
      if (!existing.timeframes.includes(a.primary)) existing.timeframes.push(a.primary);
      if (a.distancePct < existing.distancePct) {
        existing.distancePct = a.distancePct;
        existing.currentPrice = a.currentPrice;
        existing.price = a.price;
      }
      continue;
    }
    approachMap.set(key, { ...a, timeframes: [a.primary] });
  }

  const approaches = [...approachMap.values()].map((a) => {
    const sorted = [...a.timeframes].sort((x, y) => TF_ORDER.indexOf(x) - TF_ORDER.indexOf(y));
    return { ...a, timeframes: sorted, primary: sorted[0] };
  });

  const events = [...groupMap.values()];

  // ── Apply §17/§18 ──
  const pending: PendingAlert[] = [];
  const suppressed: Array<{ label: string; reason: string }> = [];

  for (const g of events) {
    const identity: AlertIdentity = {
      symbol: g.symbol,
      timeframe: g.timeframe,
      eventType: `LIQUIDITY_${g.state}`,
      levelId: `${g.side}|${g.levels.slice().sort((x, y) => x - y).join("+")}`,
      state: g.state,
    };
    const decision = useDedup ? dedup.shouldSend(identity) : { send: true, reason: "no_dedup" as const };
    const label = `${g.symbol} ${g.timeframe.toUpperCase()} ${g.side} ${g.state} ×${g.levels.length}`;
    if (!decision.send) {
      suppressed.push({ label, reason: decision.reason });
      continue;
    }
    pending.push({
      text: formatSweepGroup({
        symbol: g.symbol, timeframe: g.timeframe, side: g.side, state: g.state,
        levels: g.levels, levelTypes: g.levelTypes, extreme: g.extreme, close: g.close,
      }, language),
      identity,
      label,
    });
  }

  for (const a of approaches) {
    const identity: AlertIdentity = {
      symbol: a.symbol,
      timeframe: a.primary,
      eventType: "LIQUIDITY_APPROACHING",
      levelId: `${a.side}|${a.price}|${[...a.timeframes].sort().join("+")}`,
      state: "APPROACHING",
    };
    const decision = useDedup ? dedup.shouldSend(identity) : { send: true, reason: "no_dedup" as const };
    const tfLabel = a.timeframes.map((t) => t.toUpperCase()).join("+");
    const label = `${a.symbol} ${tfLabel} ${a.side} 接近 ${a.price}`;
    if (!decision.send) {
      suppressed.push({ label, reason: decision.reason });
      continue;
    }
    const otherTfs = a.timeframes.filter((t) => t !== a.primary).map((t) => t.toUpperCase());
    // Localised, and the list separator follows the locale: a full-width 、 inside
    // an English message is as wrong as Traditional wording inside a Simplified
    // one. `alsoOn` already exists in all three string sets.
    const alsoOn = otherTfs.length
      ? `${language === "en" ? " | " : "｜"}${stringsFor(language).alsoOn(otherTfs.join(language === "en" ? ", " : "、"))}`
      : "";
    pending.push({
      text: formatApproaching({
        symbol: a.symbol, timeframe: a.primary, side: a.side, level: a.price,
        poolType: a.poolType,
        currentPrice: a.currentPrice, distancePct: a.distancePct,
        source: a.source + alsoOn,
      }, language),
      identity,
      label,
    });
  }

  // Only persist when this run actually consulted dedup, otherwise a passive
  // query would overwrite the monitor's memory with a state it never used.
  if (useDedup) {
    store.putState("dedup_state", dedup.exportState());
  }

  return {
    events,
    approaches,
    historySkipped,
    pending,
    suppressed,
    scanned,
    failures,
    latestCandleTime,
    symbolCount: symbols.length,
    eligibleCount,
    language,
    snapshots,
    marketStates: marketStatesRaw,
  };
}
