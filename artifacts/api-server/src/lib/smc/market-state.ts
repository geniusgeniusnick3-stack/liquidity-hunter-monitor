/**
 * Post-interaction market state layer.
 *
 * WHY THIS EXISTS
 * ---------------
 * `analyzeLiquidity()` answers one question per level, about ONE completed
 * candle: did price trade beyond this level and where did that candle close?
 * That yields SWEPT and BROKEN, and it is deliberately blind to what happens
 * next — a level that is BROKEN stays BROKEN forever, because the walk stops at
 * the first take.
 *
 * That blindness is correct for what it measures, and useless for the question a
 * trader actually has after a buy-side level goes: did the market ACCEPT the
 * breakout, or did the breakout FAIL and start building the case for the other
 * direction? A single candle cannot answer that. Only the candles after it can.
 *
 * So this module adds exactly one thing: it reads the engine's own outputs
 * (liquidity pools, structure pivots, FVG, order blocks) plus the same candle
 * array, and derives a STATE from the candles the engine already classified.
 *
 * It is not a second engine. It never re-detects a level, never re-classifies an
 * interaction, and never invents a pivot. It composes.
 *
 * THREE LAYERS, KEPT APART ON PURPOSE
 * -----------------------------------
 *   FACT   what price did            SWEPT / BROKEN / FVG / MSS   (from the engine)
 *   STATE  what that leaves behind   ACCEPTED / FAILURE WATCH / REVERSAL CONFIRMED
 *   READ   what a human may infer    SHORT BLOCKED / WATCH / ARMED / READY
 *
 * Mixing the layers is how a monitor starts sounding like a forecast. Nothing
 * here predicts a price. `SHORT READY` means "the evidence a short read needs is
 * now present" — not "price will fall", and not "place an order". This project
 * has no order path at all.
 *
 * COMPLETED CANDLES ONLY
 * ----------------------
 * Every judgement here is made from candle CLOSES. Wicks alone never move a
 * state. The forming candle is excluded upstream (see market/futures.ts
 * fetchKlines and realtime/candle-store.ts getCandles), and this module assumes
 * `candles[candles.length - 1]` is the most recent COMPLETED bar — the same
 * contract `analyzeLiquidity()` and `buildReport()` already rely on.
 */
import type {
  Candle,
  LiquidityPool,
  StructurePoint,
  StructureResult,
  FairValueGap,
  OrderBlock,
  BreakoutPair,
  BreakoutStatus,
  SideState,
  ProtectedSwing,
  MssDisplacement,
  ConfirmedMss,
  MarketState,
  ShortStatus,
  ShortZoneRef,
} from "./types.js";
import { calcATR } from "./atr.js";
import { SMC_CONFIG } from "./config.js";

// ── Thresholds ──────────────────────────────────────────────────────────────

/**
 * Every threshold this layer uses, so behaviour is configurable rather than
 * baked in — the same convention `config.yaml` follows for the rest of the
 * engine.
 *
 * These values are PROVISIONAL and configurable, not claimed to be optimal.
 * They were chosen to be conservative (a state change needs more than one
 * candle of evidence) rather than fitted to a particular market. Unlike
 * `liquidityToleranceAtrMultiple`, which was calibrated against a measured
 * distribution of 139 live levels, no such calibration exists for this layer
 * yet — and saying otherwise would be a guess dressed up as a measurement.
 */
export interface MarketStateConfig {
  /** Only levels taken within this many completed bars are judged at all. */
  screening_lookback_bars: number;
  /** Consecutive completed closes beyond the level needed for acceptance. */
  acceptance_bars: number;
  /** Minimum ATR multiple beyond the level for a close to count as "outside". */
  breakout_atr_multiple: number;
  /** Minimum ATR multiple beyond a protected swing for a break to count. */
  mss_break_atr_multiple: number;
  /** Minimum body/range on the breaking candle (displacement). */
  mss_min_body_ratio: number;
  /** Minimum body/ATR on the breaking candle (displacement). */
  mss_min_body_atr_multiple: number;
  /** Only an MSS this recent counts as the current one. */
  mss_lookback_bars: number;
  /** ATR multiple used when deciding a gap/block was traded back into. */
  retest_tolerance_atr_multiple: number;
}

/**
 * Single source of truth is `SMC_CONFIG.marketState` (lib/smc/config.ts), the
 * same place the rest of the engine's thresholds live — see the note there on
 * why these numbers are provisional rather than calibrated.
 */
export const DEFAULT_MARKET_STATE_CONFIG: MarketStateConfig = { ...SMC_CONFIG.marketState };

// ── Small helpers ───────────────────────────────────────────────────────────

function fmt(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p >= 10000) return p.toFixed(0);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

function isBuySide(side: "BSL" | "SSL"): boolean {
  return side === "BSL";
}

/** ATR series aligned index-for-index with `candles`, using the same period the
 *  liquidity engine uses for this timeframe — a state layer that measured
 *  volatility differently from the classifier it reads would be incoherent. */
export function atrFor(candles: Candle[], timeframe: string): number[] {
  const period = SMC_CONFIG.atrPeriodPerTf[timeframe] ?? SMC_CONFIG.atrPeriod;
  return calcATR(candles, period);
}

/** Index of the completed candle with this open time, or -1. */
function indexOfTime(candles: Candle[], time: number | null): number {
  if (time === null) return -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time === time) return i;
  }
  return -1;
}

/** Seconds per timeframe, for turning a bar-count window into a time window. */
export const TF_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

/** One taken level that is recent enough to be judged. */
export interface TakeCandidate {
  pool: LiquidityPool;
  /** Index in `candles` of the candle that produced the take. */
  index: number;
  /** Seconds between the take and the last completed candle. Always >= 0. */
  ageSeconds: number;
}

/**
 * The ONE definition of "a take worth judging".
 *
 * The funnel gate and the depth analysis both call this — they used to
 * implement the same rule twice, which let them disagree: `hasRecentTake()` did
 * not check the lower bound, so a take stamped in the FUTURE counted as recent
 * while `evaluateBreakout()` then failed to find a matching candle and returned
 * null. The gate said yes and the analysis said nothing, with no error anywhere.
 *
 * Three things it enforces that the duplicated versions did not:
 *
 *   `indexOfTime() >= 0`   the interaction candle must actually be in the array
 *   `ageSeconds >= 0`      a future timestamp is not "recent", it is bad data
 *   `ageSeconds <= window` the screening window, in TIME (never bar counts —
 *                          illiquid alts have gaps, and bar arithmetic would
 *                          silently reach further back than the reader expects)
 *
 * Returned in a deterministic order so that no caller can inherit an
 * array-order dependency: most recent first, then a genuine close-beyond before
 * a sweep, then buy-side before sell-side (the published read is the short one,
 * so the buy-side event is the one that must be visible).
 */
export function recentTakeCandidates(
  pools: LiquidityPool[],
  candles: Candle[],
  timeframe: string,
  cfg: MarketStateConfig,
): TakeCandidate[] {
  const n = candles.length;
  if (n === 0) return [];
  const lastTime = candles[n - 1].time;
  const tfSeconds = TF_SECONDS[timeframe] ?? 0;
  const windowSeconds = cfg.screening_lookback_bars * tfSeconds;

  const out: TakeCandidate[] = [];
  for (const pool of pools) {
    if (!pool.wasSwept || pool.interactionAt === null) continue;
    const index = indexOfTime(candles, pool.interactionAt);
    if (index < 0) continue;
    const ageSeconds = lastTime - pool.interactionAt;
    if (ageSeconds < 0) continue;
    if (windowSeconds > 0 && ageSeconds > windowSeconds) continue;
    out.push({ pool, index, ageSeconds });
  }

  return out.sort((a, b) => {
    if (a.ageSeconds !== b.ageSeconds) return a.ageSeconds - b.ageSeconds;
    const aBroken = a.pool.interaction === "BROKEN" ? 0 : 1;
    const bBroken = b.pool.interaction === "BROKEN" ? 0 : 1;
    if (aBroken !== bBroken) return aBroken - bBroken;
    const aSide = a.pool.type === "BSL" ? 0 : 1;
    const bSide = b.pool.type === "BSL" ? 0 : 1;
    if (aSide !== bSide) return aSide - bSide;
    return a.pool.price - b.pool.price;
  });
}

/**
 * Was any level taken recently enough to be worth investigating in depth?
 *
 * This is the funnel gate. It is a thin wrapper over `recentTakeCandidates()`
 * precisely so the cheap pre-check and the depth check can never disagree about
 * what "recent" means.
 */
export function hasRecentTake(
  pools: LiquidityPool[],
  candles: Candle[],
  timeframe: string,
  cfg: MarketStateConfig,
): boolean {
  return recentTakeCandidates(pools, candles, timeframe, cfg).length > 0;
}

/**
 * Does price, at candle `k`, sit clearly outside `level` on the breakout side?
 *
 * Tolerance is volatility-scaled and per-candle, matching the engine's own
 * classifier. A hair past the level is not acceptance.
 */
function closeBeyond(level: number, buySide: boolean, c: Candle, tol: number): boolean {
  return buySide ? c.close > level + tol : c.close < level - tol;
}

/** A completed close back on the ORIGINAL side of the level. */
function closeBackInside(level: number, buySide: boolean, c: Candle): boolean {
  return buySide ? c.close < level : c.close > level;
}

/**
 * A gap/block's price band, whichever shape it is.
 *
 * Gaps carry `top`/`bottom`; order blocks carry `proximal` (the near edge price
 * reacts to first) and `distal` (the far edge, i.e. the invalidation side). The
 * two are normalised here so the short read can talk about either without
 * caring which it holds.
 */
function zoneBand(z: FairValueGap | OrderBlock): { top: number; bottom: number } {
  if ("top" in z && "bottom" in z) return { top: z.top, bottom: z.bottom };
  const ob = z as OrderBlock;
  return {
    top: Math.max(ob.proximal, ob.distal),
    bottom: Math.min(ob.proximal, ob.distal),
  };
}

/** The published reference to a zone — see ShortZoneRef. */
function zoneRef(z: FairValueGap | OrderBlock): ShortZoneRef {
  const band = zoneBand(z);
  return {
    kind: "top" in z && "bottom" in z ? "FVG" : "OB",
    top: band.top,
    bottom: band.bottom,
    retestCount: z.retestCount ?? 0,
    reactionConfirmed: z.reactionConfirmed === true,
  };
}

/** Human-readable name for a zone, so a status can point at a level. */
function zoneLabel(z: FairValueGap | OrderBlock): string {
  const band = zoneBand(z);
  return `${zoneRef(z).kind} ${fmt(band.bottom)}–${fmt(band.top)}`;
}

// ── Breakout acceptance / failure ───────────────────────────────────────────

interface AcceptanceRun {
  status: BreakoutStatus;
  closesBeyond: number;
  acceptedAt: number | null;
  failedAt: number | null;
}

/**
 * Replay the completed closes that followed a take, and classify where the
 * level stands now.
 *
 * State machine, one completed candle at a time, starting at the candle that
 * produced the take:
 *
 *   beyond  (close clearly outside)     → extend the acceptance run
 *   inside  (close back on the old side) → acceptance run resets, and a level
 *                                          that had been taken is now a FAILURE
 *   between (neither)                    → indecision: neither extends nor
 *                                          resets the run
 *
 * A failure is not permanent. If price closes outside again for
 * `acceptance_bars` candles, the level reads as ACCEPTED once more — because
 * that is what the candles then say. The state is always a statement about the
 * LATEST close, never a verdict frozen at the moment of the break.
 */
function runAcceptance(
  candles: Candle[],
  startIdx: number,
  level: number,
  buySide: boolean,
  tolAt: (k: number) => number,
  acceptanceBars: number,
): AcceptanceRun {
  let beyond = 0;
  let accepted = false;
  let acceptedAt: number | null = null;
  let failedAt: number | null = null;

  for (let k = startIdx; k < candles.length; k++) {
    const c = candles[k];
    if (closeBeyond(level, buySide, c, tolAt(k))) {
      beyond++;
      if (beyond >= acceptanceBars) {
        accepted = true;
        acceptedAt = c.time;
        // Re-acceptance clears a prior failure: the candles now say the level
        // is held again, so the earlier failure is history.
        failedAt = null;
      }
      continue;
    }
    if (closeBackInside(level, buySide, c)) {
      beyond = 0;
      accepted = false;
      // The FIRST close back inside is the failure — that is the candle that
      // failed the breakout, and reporting the most recent inside close instead
      // would date the failure to whatever candle happened to be last.
      if (failedAt === null) failedAt = c.time;
    }
  }

  const status: BreakoutStatus = failedAt !== null
    ? (buySide ? "BREAKOUT_FAILURE_WATCH" : "BREAKDOWN_FAILURE_WATCH")
    : accepted
      ? (buySide ? "BREAKOUT_ACCEPTED" : "BREAKDOWN_ACCEPTED")
      : "NONE";

  // `closesBeyond` is the TRAILING run ending at the last candle — how many
  // consecutive completed closes are outside right now.
  let trailing = 0;
  for (let k = candles.length - 1; k >= startIdx; k--) {
    if (closeBeyond(level, buySide, candles[k], tolAt(k))) trailing++;
    else break;
  }

  return { status, closesBeyond: trailing, acceptedAt, failedAt };
}

/**
 * Which taken level, if any, is worth judging — and what state it is in.
 *
 * A level qualifies when the engine settled it (SWEPT or BROKEN) within the
 * screening window. The window exists because a take from three months ago says
 * nothing about now, while a take from one candle ago can only be a sweep so
 * far — acceptance needs candles to accumulate.
 *
 * Note that a SWEPT level yields status NONE by construction: price never
 * closed beyond it, so there is no breakout to accept or fail. That is exactly
 * the requested behaviour — a sweep alone is not a reversal.
 */
export interface BreakoutEvaluation {
  /** Per-side post-take state. Neither side can erase the other. */
  breakout: BreakoutPair;
  /**
   * Every recent take, newest first, as fact lines.
   *
   * The FACT layer must not lose events to a tie-break, so this still lists them
   * all even though the judged state is now per side.
   */
  facts: string[];
}

/**
 * The post-take state of EACH side, computed independently.
 *
 * Candidate selection is delegated entirely to `recentTakeCandidates()`, so this
 * function and the gate cannot disagree. Within a side the candidate list is
 * already newest-first, so "the newest take on this side" is the first match —
 * and because there is only ever one candidate per side, there is no cross-side
 * tie-break left to get wrong. That is the point of the change: a newer sell-side
 * take used to win a SHARED sort and collapse the buy-side read to NONE while the
 * buy-side chain was still live.
 *
 * Note that a SWEPT level yields status NONE by construction: price never closed
 * beyond it, so there is no breakout to accept or fail. A sweep alone is not a
 * reversal.
 */
export function evaluateBreakout(
  pools: LiquidityPool[],
  candles: Candle[],
  timeframe: string,
  cfg: MarketStateConfig,
  opts: { formingLast?: boolean } = {},
): BreakoutEvaluation {
  const n = candles.length;
  const none: BreakoutPair = { bsl: null, ssl: null };
  if (n === 0) return { breakout: none, facts: [] };

  const atr = atrFor(candles, timeframe);
  const tolAt = (k: number): number =>
    Math.max((atr[k] ?? 0) * cfg.breakout_atr_multiple, 0);

  const candidates = recentTakeCandidates(pools, candles, timeframe, cfg);

  const facts = candidates.map(({ pool }) =>
    `${pool.type === "SSL" ? "SSL" : "BSL"} ${fmt(pool.price)} ${pool.interaction}`,
  );

  const lastClose = candles[candles.length - 1].close;

  const build = (want: "BSL" | "SSL"): SideState | null => {
    // The level that matters is the one NEAREST the current price, not the most
    // recently touched. A take 60% away describes a market that has since moved on;
    // quoting it as "above" beside today's price invites a comparison that means
    // nothing. Nearest first — the invalidation rules below decide if it stands.
    const mine = candidates.filter(
      ({ pool }) => (pool.type === "SSL" ? "SSL" : "BSL") === want,
    );
    if (mine.length === 0) return null;
    const cand = mine.reduce((best, x) =>
      Math.abs(x.pool.price - lastClose) < Math.abs(best.pool.price - lastClose) ? x : best,
    );

    const buySide = isBuySide(want);
    const broken = cand.pool.interaction === "BROKEN";
    const run = broken
      ? runAcceptance(candles, cand.index, cand.pool.price, buySide, tolAt, cfg.acceptance_bars)
      : {
          status: "NONE" as BreakoutStatus,
          closesBeyond: 0,
          acceptedAt: null,
          failedAt: null,
        };

    // A level that closed beyond but is neither accepted nor failed yet is NOT
    // "NONE". NONE means "nothing to judge" — it is what a SWEPT level yields.
    // The type already declares BROKEN for exactly this case ("Beyond the level,
    // but not yet accepted and not yet failed"), yet runAcceptance() only ever
    // returns ACCEPTED / FAILURE / NONE, so a FRESH break was published as NONE.
    // The visible consequence: a level price had just broken was reported to a
    // reader as "swept only, no breakout" — the opposite of what happened.
    const status: BreakoutStatus = broken && run.status === "NONE" ? "BROKEN" : run.status;

    return {
      level: cand.pool.price,
      interaction: cand.pool.interaction,
      interactionAt: cand.pool.interactionAt ?? null,
      status,
      closesBeyond: run.closesBeyond,
      reason: describeBreakout(want, run, broken),
    };
  };

  // ── The candle forming RIGHT NOW ────────────────────────────────────────────
  // Everything above judges completed bars. A reader, though, looks at the candle
  // in front of them: if it is falling and has left a long lower wick, price was
  // pushed down and bought straight back — the downward push failed, and that is
  // what the chart shows at this instant. Symmetrically for a long upper wick on a
  // rising candle. The wick's own extreme becomes the level, because that is where
  // the rejection happened.
  //
  // Only applied when the caller says the last candle is still forming: on a
  // completed bar the wick is already reflected in the level states above, and a
  // backtest must never read a bar that is still moving.
  const wickState = (want: "BSL" | "SSL"): SideState | null => {
    if (!opts.formingLast || candles.length === 0) return null;
    const k = candles[candles.length - 1];
    const range = k.high - k.low;
    if (!(range > 0)) return null;
    const lowerWick = Math.min(k.open, k.close) - k.low;
    const upperWick = k.high - Math.max(k.open, k.close);
    if (want === "SSL" && k.close < k.open && lowerWick / range > 0.5) {
      return {
        level: k.low,
        interaction: "SWEPT",
        interactionAt: k.time,
        status: "BREAKDOWN_FAILURE_WATCH",
        closesBeyond: 0,
        reason: "the forming candle fell into this level and was bought straight back (long lower wick)",
      };
    }
    if (want === "BSL" && k.close > k.open && upperWick / range > 0.5) {
      return {
        level: k.high,
        interaction: "SWEPT",
        interactionAt: k.time,
        status: "BREAKOUT_FAILURE_WATCH",
        closesBeyond: 0,
        reason: "the forming candle pushed into this level and was sold straight back (long upper wick)",
      };
    }
    return null;
  };

  return { breakout: { bsl: wickState("BSL") ?? build("BSL"), ssl: wickState("SSL") ?? build("SSL") }, facts };
}

function describeBreakout(
  side: "BSL" | "SSL",
  run: AcceptanceRun,
  broken: boolean,
): string {
  const up = side === "BSL";
  const word = up ? "breakout" : "breakdown";
  switch (run.status) {
    case "BREAKOUT_ACCEPTED":
      return `${word} accepted — price has held outside on ${run.closesBeyond} completed close(s)`;
    case "BREAKDOWN_ACCEPTED":
      return `${word} accepted — price has held outside on ${run.closesBeyond} completed close(s)`;
    case "BREAKOUT_FAILURE_WATCH":
    case "BREAKDOWN_FAILURE_WATCH":
      return `${word} failure watch — a completed close returned to the original side`;
    default:
      return broken
        ? "closed beyond the level, but not yet accepted and not yet failed"
        : "swept only — price never closed beyond the level";
  }
}

// ── Protected swing ─────────────────────────────────────────────────────────

/**
 * The most recent valid protected swing of one kind.
 *
 * `HL` is a bullish protected low: the last higher low an uptrend is defending.
 * `LH` is the bearish mirror. "Valid" means no completed candle has closed
 * through it — a wick through is not a break, for the same reason a wick is not
 * acceptance anywhere else in this codebase.
 *
 * Note this reads `StructureResult.pivots`, not `StructureResult.breaks`. The
 * engine's BOS/CHoCH events are generated from pivot ORDER alone and are not
 * tied to any close, so they cannot answer "was this swing actually broken?" —
 * only the candles can.
 */
export function findProtectedSwing(
  pivots: StructurePoint[],
  candles: Candle[],
  atr: number[],
  label: "HL" | "LH",
  breakAtrMultiple: number,
): ProtectedSwing | null {
  const n = candles.length;
  if (n === 0) return null;

  let candidate: StructurePoint | null = null;
  for (let i = pivots.length - 1; i >= 0; i--) {
    if (pivots[i].type === label && pivots[i].index < n) {
      candidate = pivots[i];
      break;
    }
  }
  if (!candidate) return null;

  const isLow = label === "HL";
  for (let k = candidate.index + 1; k < n; k++) {
    const tol = Math.max((atr[k] ?? 0) * breakAtrMultiple, 0);
    const broke = isLow
      ? candles[k].close < candidate.price - tol
      : candles[k].close > candidate.price + tol;
    if (broke) {
      // A break that the market has since undone is not a defence line any more —
      // it is a level price has left behind, and reporting it puts a fact from
      // weeks ago next to today's chart as though the two agreed. Look for the
      // first close back on the original side and mark the swing reclaimed.
      let reclaimedAt: number | null = null;
      for (let m = k + 1; m < n; m++) {
        const t2 = Math.max((atr[m] ?? 0) * breakAtrMultiple, 0);
        const back = isLow
          ? candles[m].close > candidate.price + t2
          : candles[m].close < candidate.price - t2;
        if (back) {
          reclaimedAt = candles[m].time;
          break;
        }
      }
      return {
        type: isLow ? "low" : "high",
        label,
        index: candidate.index,
        price: candidate.price,
        time: candidate.time,
        broken: true,
        brokenIndex: k,
        brokenAt: candles[k].time,
        brokenBy: candles[k].close,
        reclaimed: reclaimedAt !== null,
        reclaimedAt,
      };
    }
  }

  return {
    type: isLow ? "low" : "high",
    label,
    index: candidate.index,
    price: candidate.price,
    time: candidate.time,
    broken: false,
    brokenIndex: null,
    brokenAt: null,
    brokenBy: null,
    reclaimed: false,
    reclaimedAt: null,
  };
}

// ── Confirmed MSS ───────────────────────────────────────────────────────────

function displacementOf(c: Candle, atrValue: number, cfg: MarketStateConfig): MssDisplacement {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const bodyRatio = range > 0 ? body / range : 0;
  const atrMultiple = atrValue > 0 ? body / atrValue : 0;
  return {
    body,
    range,
    bodyRatio,
    atrMultiple,
    qualifies:
      bodyRatio >= cfg.mss_min_body_ratio &&
      atrMultiple >= cfg.mss_min_body_atr_multiple,
  };
}

/**
 * A CONFIRMED MSS — deliberately not the engine's CHoCH.
 *
 * `structure.breaks` produces a bearish CHoCH the moment a lower-high pivot
 * exists. That is a structural OBSERVATION and it is kept exactly as it is; it
 * requires no close, no level, and no displacement, so using it as a short
 * confirmation would be reading far more into it than it says.
 *
 * A confirmed MSS requires ALL of:
 *   1. bullish structure existed before the level being defended
 *   2. a valid bullish protected low (a higher low) exists
 *   3. a COMPLETED candle closed beyond it
 *   4. the close went beyond it by more than an ATR tolerance
 *   5. that candle showed displacement — body/range and body/ATR floors
 *
 * Every unmet requirement is reported in `blockers`, so a rejection explains
 * itself instead of leaving the reader to guess which gate it failed.
 */
export function evaluateMss(
  candles: Candle[],
  atr: number[],
  structure: StructureResult,
  protectedLow: ProtectedSwing | null,
  protectedHigh: ProtectedSwing | null,
  cfg: MarketStateConfig,
  direction: "bullish" | "bearish",
): ConfirmedMss | null {
  const n = candles.length;
  if (n === 0) return null;

  const bearish = direction === "bearish";
  const swing = bearish ? protectedLow : protectedHigh;
  if (!swing) return null;

  const blockers: string[] = [];
  const evidence: string[] = [];

  // 1. Was there structure of the opposite kind for this to reverse?
  const priorKind = bearish ? "bullish" : "bearish";
  const hadPriorStructure = structure.pivots.some(
    (p) =>
      p.index < swing.index &&
      (bearish ? p.type === "HH" || p.type === "HL" : p.type === "LL" || p.type === "LH"),
  );
  if (!hadPriorStructure) blockers.push(`no prior ${priorKind} structure before this swing`);
  else evidence.push(`✓ prior ${priorKind} structure existed`);

  // 2. The swing itself must be real (it exists — we got here).
  evidence.push(
    `✓ protected ${bearish ? "low" : "high"} ${fmt(swing.price)} at ${new Date(swing.time * 1000).toISOString()}`,
  );

  // 3. A completed close beyond it.
  const breakIdx = swing.brokenIndex;
  if (breakIdx === null) {
    blockers.push("no completed close beyond the protected swing (a wick alone is not a break)");
    return {
      direction,
      confirmed: false,
      brokenLevel: swing.price,
      brokenLevelTime: swing.time,
      brokenLevelIndex: swing.index,
      breakIndex: null,
      breakTime: null,
      breakClose: null,
      breakAtrMultiple: null,
      displacement: null,
      blockers,
      reason: blockers[0],
      evidence,
    };
  }

  const breaking = candles[breakIdx];
  const swingTol = Math.max((atr[breakIdx] ?? 0) * cfg.mss_break_atr_multiple, 0);
  const distance = bearish
    ? swing.price - breaking.close
    : breaking.close - swing.price;
  const atrMultiple = (atr[breakIdx] ?? 0) > 0 ? distance / atr[breakIdx] : 0;

  // Recency: an MSS from long ago is history, not the current read.
  const ageBars = n - 1 - breakIdx;
  if (ageBars > cfg.mss_lookback_bars) {
    blockers.push(`the break is ${ageBars} bars old (limit ${cfg.mss_lookback_bars})`);
  }

  // 4. Break magnitude beyond the ATR tolerance.
  if (distance <= swingTol) {
    blockers.push("the close did not clear the swing by more than the ATR tolerance");
  } else {
    evidence.push(`✓ close ${fmt(breaking.close)} cleared the swing by ${atrMultiple.toFixed(2)}x ATR`);
  }

  // 5. Displacement on the breaking candle.
  const displacement = displacementOf(breaking, atr[breakIdx] ?? 0, cfg);
  if (!displacement.qualifies) {
    blockers.push(
      `no displacement (body/range ${displacement.bodyRatio.toFixed(2)} vs ${cfg.mss_min_body_ratio}, body/ATR ${displacement.atrMultiple.toFixed(2)} vs ${cfg.mss_min_body_atr_multiple})`,
    );
  } else {
    evidence.push(
      `✓ displacement (body/range ${displacement.bodyRatio.toFixed(2)}, body/ATR ${displacement.atrMultiple.toFixed(2)})`,
    );
  }

  const confirmed = blockers.length === 0;

  return {
    direction,
    confirmed,
    brokenLevel: swing.price,
    brokenLevelTime: swing.time,
    brokenLevelIndex: swing.index,
    breakIndex: breakIdx,
    breakTime: breaking.time,
    breakClose: breaking.close,
    breakAtrMultiple: atrMultiple,
    displacement,
    blockers,
    reason: confirmed
      ? `${bearish ? "bearish" : "bullish"} MSS confirmed — completed close ${fmt(breaking.close)} through protected ${bearish ? "low" : "high"} ${fmt(swing.price)}`
      : blockers.join("; "),
    evidence,
  };
}

// ── FVG / OB lifecycle ──────────────────────────────────────────────────────

interface LifecycleFields {
  createdAfterMss: boolean;
  firstRetestAt: number | null;
  retestCount: number;
  invalidatedAt: number | null;
  isFresh: boolean;
  reactionConfirmed: boolean;
}

/**
 * Walk the candles after a gap/block formed and record what happened to it.
 *
 * The two thresholds that matter for a directional read are kept distinct:
 *
 *   invalidatedAt      a completed close went THROUGH the far edge — the zone
 *                      no longer stands
 *   reactionConfirmed  after being retested, a completed close left the zone on
 *                      the expected side — the zone was defended
 *
 * A reaction is only credited after a retest, so a zone that price never came
 * back to cannot claim one.
 */
function lifecycle(
  startIdx: number,
  candles: Candle[],
  atr: number[],
  cfg: MarketStateConfig,
  bearishZone: boolean,
  zoneTop: number,
  zoneBottom: number,
  mss: ConfirmedMss | null,
): LifecycleFields {
  const n = candles.length;
  const tolAt = (k: number): number =>
    Math.max((atr[k] ?? 0) * cfg.retest_tolerance_atr_multiple, 0);

  let firstRetestIdx: number | null = null;
  let retestCount = 0;
  let invalidatedIdx: number | null = null;
  let reactionIdx: number | null = null;

  // A three-candle gap is only complete at i+2, so nothing before that can
  // retest it.
  for (let k = Math.max(startIdx + 2, 1); k < n; k++) {
    const c = candles[k];
    const tol = tolAt(k);

    if (invalidatedIdx === null) {
      const through = bearishZone ? c.close > zoneTop + tol : c.close < zoneBottom - tol;
      if (through) invalidatedIdx = k;
    }

    const touched = c.high >= zoneBottom - tol && c.low <= zoneTop + tol;
    if (touched) {
      retestCount++;
      if (firstRetestIdx === null) firstRetestIdx = k;
    }

    // Reaction is judged only after the first retest, and only while the zone
    // still stands.
    if (
      reactionIdx === null &&
      firstRetestIdx !== null &&
      k > firstRetestIdx &&
      invalidatedIdx === null
    ) {
      const left = bearishZone ? c.close < zoneBottom - tol : c.close > zoneTop + tol;
      if (left) reactionIdx = k;
    }
  }

  return {
    createdAfterMss:
      mss !== null && mss.confirmed && mss.breakIndex !== null && startIdx > mss.breakIndex,
    firstRetestAt: firstRetestIdx !== null ? candles[firstRetestIdx].time : null,
    retestCount,
    invalidatedAt: invalidatedIdx !== null ? candles[invalidatedIdx].time : null,
    isFresh: retestCount === 0 && invalidatedIdx === null,
    reactionConfirmed: reactionIdx !== null,
  };
}

export function annotateFvgs(
  fvgs: FairValueGap[],
  candles: Candle[],
  atr: number[],
  mss: ConfirmedMss | null,
  cfg: MarketStateConfig,
): FairValueGap[] {
  return fvgs.map((g) => ({
    ...g,
    ...lifecycle(g.index, candles, atr, cfg, g.type === "bearish", g.top, g.bottom, mss),
  }));
}

export function annotateOrderBlocks(
  obs: OrderBlock[],
  candles: Candle[],
  atr: number[],
  mss: ConfirmedMss | null,
  cfg: MarketStateConfig,
): OrderBlock[] {
  return obs.map((ob) => ({
    ...ob,
    ...lifecycle(
      ob.index,
      candles,
      atr,
      cfg,
      ob.type === "bearish",
      ob.distal,
      ob.proximal,
      mss,
    ),
  }));
}

// ── Short status ────────────────────────────────────────────────────────────

interface ShortReadInput {
  /** The BUY-side state, and only that. The sell side cannot change a short read. */
  bsl: SideState | null;
  mss: ConfirmedMss | null;
  protectedLow: ProtectedSwing | null;
  fvgLifecycle: FairValueGap[];
  obLifecycle: OrderBlock[];
  /** Higher-timeframe bias, when the caller knows it. Falls back to structure. */
  htfBias: "bullish" | "bearish" | "neutral";
}

/**
 * The descriptive short read.
 *
 * Precedence is READY > ARMED > WATCH > BLOCKED > NONE, and the ordering is the
 * point: BLOCKED is the default state of the world, and it takes a specific
 * sequence of evidence to move out of it. Nothing here is a recommendation, and
 * none of it can place an order — no order path exists in this project.
 *
 * A fresh bearish zone is one formed AFTER the confirmed MSS and not yet
 * invalidated. Requiring that is what stops the layer from treating every
 * unfilled bearish FVG in the window as a short signal.
 */
export function evaluateShortStatus(
  input: ShortReadInput,
): { status: ShortStatus; reason: string; zone?: ShortZoneRef | null } {
  const { bsl, mss, protectedLow, fvgLifecycle, obLifecycle, htfBias } = input;

  // The short read is a BUY-side question and is handed the buy side alone.
  // It used to read a single shared "primary" take, so a newer sell-side take
  // could win the sort and collapse this to NONE while a live buy-side chain was
  // still on the books. Per-side state removes that path entirely.
  if (!bsl) {
    return { status: "NONE", reason: "no buy-side liquidity taken within the screening window" };
  }

  const bearishMss = mss !== null && mss.confirmed && mss.direction === "bearish";
  // A REVERSAL_CONFIRMED status is a failure watch that has since been paired
  // with a confirmed reversal MSS — see analyzeMarketState. It is strictly MORE
  // evidence than a plain failure, so it must not fall through to BLOCKED just
  // because the label changed.
  const failed =
    bsl.status === "BREAKOUT_FAILURE_WATCH" ||
    bsl.status === "REVERSAL_CONFIRMED";
  const accepted = bsl.status === "BREAKOUT_ACCEPTED";

  /**
   * Zones that may carry a short read: bearish, formed AFTER the confirmed MSS,
   * and not invalidated.
   *
   * Note what this predicate does NOT say. It does not say "fresh". A zone that
   * has already been retested, and did not reject, is still here — and treating
   * it as fresh made the ARMED explanation claim "that zone has not been
   * retested yet" about a zone that plainly had been. Freshness is its own
   * question and is asked separately, below.
   */
  const eligibleZones = [
    ...fvgLifecycle.filter(
      (g) => g.type === "bearish" && g.createdAfterMss === true && g.invalidatedAt === null,
    ),
    ...obLifecycle.filter(
      (ob) => ob.type === "bearish" && ob.createdAfterMss === true && ob.invalidatedAt === null,
    ),
  ];

  const reacted = eligibleZones.filter(
    (z) => (z.retestCount ?? 0) >= 1 && z.reactionConfirmed === true,
  );
  const retestedAwaitingReaction = eligibleZones.filter(
    (z) => (z.retestCount ?? 0) >= 1 && z.reactionConfirmed !== true,
  );
  const untouched = eligibleZones.filter((z) => z.isFresh === true);

  const armed = failed && bearishMss && eligibleZones.length > 0;

  // READY — an ARMED setup whose retest held. Checked first because it is
  // strictly more evidence than ARMED, not a different state.
  if (armed) {
    const held = reacted[0];
    if (held) {
      return {
        status: "READY",
        zone: zoneRef(held),
        reason: `breakout failed, bearish MSS confirmed, and the ${zoneLabel(held)} was retested without invalidating and was rejected`,
      };
    }

    // ARMED, explained by which of the two genuinely different situations it is.
    const pending = retestedAwaitingReaction[0] ?? untouched[0] ?? eligibleZones[0];
    const why = retestedAwaitingReaction.length > 0
      ? "the zone has been retested but has not rejected yet"
      : "the zone has not been retested yet";
    return {
      status: "ARMED",
      zone: zoneRef(pending),
      reason: `breakout failed with a confirmed bearish MSS and a bearish ${zoneLabel(pending)}, but ${why}`,
    };
  }

  if (failed) {
    if (!bearishMss) {
      return { status: "WATCH", reason: "price closed back inside after the break, but no confirmed bearish MSS yet" };
    }
    return { status: "WATCH", reason: "bearish MSS confirmed, but no bearish FVG or order block has formed since it and remained valid" };
  }

  if (accepted) {
    return { status: "BLOCKED", reason: "bullish breakout remains accepted — price has held above the level" };
  }

  if (htfBias === "bullish") {
    return { status: "BLOCKED", reason: "higher-timeframe bias is still bullish" };
  }

  if (protectedLow && !protectedLow.broken) {
    return {
      status: "BLOCKED",
      reason: `the bullish protected low at ${fmt(protectedLow.price)} has not been closed through`,
    };
  }

  if (bsl.interaction === "SWEPT") {
    return {
      status: "BLOCKED",
      reason: "buy-side liquidity was swept only — price never closed beyond the level, so there is no reversal evidence",
    };
  }

  return {
    status: "BLOCKED",
    reason: "no reversal evidence — the level was taken but the market has not rejected it or shifted structure",
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface AnalyzeMarketStateInput {
  /** Completed candles. The last element is treated as the most recent close. */
  candles: Candle[];
  timeframe: string;
  /** Engine output — Stage 1. */
  liquidity: LiquidityPool[];
  structure: StructureResult;
  fvg: FairValueGap[];
  orderBlocks: OrderBlock[];
  /** Higher-timeframe bias when known (e.g. daily). Defaults to structure bias. */
  htfBias?: "bullish" | "bearish" | "neutral";
  config?: Partial<MarketStateConfig>;
  /**
   * The last candle is still forming. Only the live path sets this: it lets the
   * judgement include the candle a reader sees on their chart right now (a long
   * wick on it is a rejection that has already happened). Backtests must leave it
   * unset — reading a bar that is still moving is exactly the look-ahead the engine
   * refuses.
   */
  formingLast?: boolean;
}

/** Empty state, for the no-candle case and for callers that switch the layer off. */
export function emptyMarketState(timeframe: string, asOf = 0): MarketState {
  return {
    asOf,
    lastClose: 0,
    formingLast: false,
    timeframe,
    facts: [],
    breakout: { bsl: null, ssl: null },
    protectedLow: null,
    mss: null,
    shortStatus: "NONE",
    shortReason: "no data",
    shortZone: null,
    narrative: "",
    evidence: [],
  };
}

/**
 * Compact, transport-safe projection of the state layer.
 *
 * Exists because the layer was reachable from exactly one place (the Telegram
 * scan) while `SmcReport.marketState` was being returned by the REST routes and
 * the MCP tools too — those consumers received a field they never surfaced. This
 * is the shape both now publish, so `blockers`, `facts` and the lifecycle-derived
 * zone reference have a real downstream reader instead of being write-only.
 */
export function marketStateSummary(state: MarketState) {
  const b = state.breakout;
  const side = (s: SideState | null) =>
    s
      ? {
          level: s.level,
          status: s.status,
          interaction: s.interaction,
          interactionAt: s.interactionAt ?? null,
          closesBeyond: s.closesBeyond,
          reason: s.reason,
        }
      : null;
  const m = state.mss;
  return {
    facts: state.facts,
    breakout: { bsl: side(b.bsl), ssl: side(b.ssl) },
    protectedLow: state.protectedLow
      ? {
          price: state.protectedLow.price,
          broken: state.protectedLow.broken,
          brokenAt: state.protectedLow.brokenAt ?? null,
          reclaimed: state.protectedLow.reclaimed,
        }
      : null,
    mss: m
      ? {
          direction: m.direction,
          confirmed: m.confirmed,
          breakTime: m.breakTime ?? null,
          blockers: m.blockers,
          reason: m.reason,
        }
      : null,
    shortStatus: state.shortStatus,
    shortReason: state.shortReason,
    shortZone: state.shortZone,
    evidence: state.evidence,
  };
}

/**
 * Derive the whole state layer for one symbol/timeframe.
 *
 * Pure and deterministic: no `Date.now()`, no I/O, no randomness. The same
 * candles always produce the same state, which is what makes the layer testable
 * and what keeps PASSIVE and ACTIVE in agreement.
 */
export function analyzeMarketState(input: AnalyzeMarketStateInput): MarketState {
  const cfg: MarketStateConfig = { ...DEFAULT_MARKET_STATE_CONFIG, ...(input.config ?? {}) };
  const { timeframe, liquidity, structure, fvg, orderBlocks } = input;

  // The closed-candle contract is enforced at the DATA BOUNDARY — see
  // admitCandles() in candles.ts, which every source must pass through. This
  // function deliberately does not re-check it: two filters with two different
  // definitions is exactly how the old "open time + period length" guess crept
  // in, and that guess held back already-closed weekly bars. Input here is
  // already admitted.
  const candles = input.candles;

  const n = candles.length;
  if (n === 0) return emptyMarketState(timeframe);

  const asOf = candles[n - 1].time;
  const lastClose = candles[n - 1].close;
  const atr = atrFor(candles, timeframe);
  const htfBias = input.htfBias ?? structure.bias;

  const evaluation = evaluateBreakout(liquidity, candles, timeframe, cfg, {
    formingLast: input.formingLast === true,
  });
  const breakout = evaluation.breakout;

  const protectedLow = findProtectedSwing(
    structure.pivots, candles, atr, "HL", cfg.mss_break_atr_multiple,
  );
  // A reclaimed swing is not a defence line any more. Only the REPORTED state drops
  // it — the engine's own lifecycle logic keeps reading the swing it always did, so
  // this stays a reporting rule and cannot quietly move the judgement.
  const protectedLowLive = protectedLow && !protectedLow.reclaimed ? protectedLow : null;

  const protectedHigh = findProtectedSwing(
    structure.pivots, candles, atr, "LH", cfg.mss_break_atr_multiple,
  );

  const bearishMss = evaluateMss(
    candles, atr, structure, protectedLow, protectedHigh, cfg, "bearish",
  );
  const bullishMss = evaluateMss(
    candles, atr, structure, protectedLow, protectedHigh, cfg, "bullish",
  );

  // The one that matters is the confirmed one; a confirmed break always wins
  // over an unconfirmed one, and among confirmed ones the more recent break is
  // the current read.
  const mss = pickMss(bearishMss, bullishMss);

  const fvgLifecycle = annotateFvgs(fvg, candles, atr, mss, cfg);
  const obLifecycle = annotateOrderBlocks(orderBlocks, candles, atr, mss, cfg);

  // The short read is a BUY-side question, so it is handed the buy side alone —
  // see evaluateShortStatus.
  const read = evaluateShortStatus({
    bsl: breakout.bsl, mss, protectedLow, fvgLifecycle, obLifecycle, htfBias,
  });

  // A failed buy-side breakout plus a confirmed bearish reversal MSS is the
  // strongest read this layer can publish, so it is named rather than left
  // implicit. It is a BUY-side label: no symmetric long read is published, so
  // the sell side is never relabelled.
  const finalBreakout: BreakoutPair =
    breakout.bsl !== null &&
    breakout.bsl.status === "BREAKOUT_FAILURE_WATCH" &&
    mss !== null &&
    mss.confirmed &&
    mss.direction === "bearish"
      ? { ...breakout, bsl: { ...breakout.bsl, status: "REVERSAL_CONFIRMED" } }
      : breakout;

  // FACT layer: every recent take, taken straight from the evaluator so that a
  // tie-break can never erase an event from the record, plus the structure shift.
  const facts: string[] = [...evaluation.facts];
  if (mss && mss.confirmed) {
    facts.push(`MSS ${mss.direction} at ${mss.breakTime !== null ? isoDate(mss.breakTime) : "—"}`);
  }

  const evidence: string[] = [];
  // Both sides, because both can be live at once. Nothing here picks a "primary".
  if (finalBreakout.bsl) evidence.push(finalBreakout.bsl.reason);
  if (finalBreakout.ssl) evidence.push(finalBreakout.ssl.reason);
  if (protectedLowLive) {
    evidence.push(
      protectedLowLive.broken
        ? `✓ bullish protected low ${fmt(protectedLowLive.price)} was closed through`
        : `• bullish protected low ${fmt(protectedLowLive.price)} intact`,
    );
  }
  if (mss) evidence.push(...mss.evidence);
  if (mss && !mss.confirmed) evidence.push(`✗ MSS not confirmed: ${mss.reason}`);
  if (!mss && protectedLowLive) {
    evidence.push("✗ no confirmed MSS — no completed close through the protected swing");
  }

  return {
    asOf,
    lastClose,
    formingLast: input.formingLast === true,
    timeframe,
    facts,
    breakout: finalBreakout,
    protectedLow: protectedLowLive,
    mss,
    shortStatus: read.status,
    shortReason: read.reason,
    shortZone: read.zone ?? null,
    narrative: buildStateNarrative(finalBreakout, protectedLowLive, mss, read),
    evidence,
  };
}

function pickMss(a: ConfirmedMss | null, b: ConfirmedMss | null): ConfirmedMss | null {
  if (a && a.confirmed) {
    if (b && b.confirmed) {
      return (a.breakIndex ?? -1) >= (b.breakIndex ?? -1) ? a : b;
    }
    return a;
  }
  if (b && b.confirmed) return b;
  return a ?? b;
}

function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * One sentence per layer, in the order a human reads them: what happened, what
 * state that leaves, what it does and does not license.
 *
 * Deliberately free of any forward-looking verb. The engine describes; it does
 * not forecast, and it does not instruct.
 */
function buildStateNarrative(
  breakout: BreakoutPair,
  protectedLow: ProtectedSwing | null,
  mss: ConfirmedMss | null,
  read: { status: ShortStatus; reason: string },
): string {
  const parts: string[] = [];
  // Both sides, in a fixed order. Both can be live at once, so there is no
  // "primary" to report and no ordering question to answer.
  if (breakout.bsl) {
    const s = breakout.bsl;
    parts.push(`BSL ${fmt(s.level)} ${s.interaction}; ${s.reason}.`);
  }
  if (breakout.ssl) {
    const s = breakout.ssl;
    parts.push(`SSL ${fmt(s.level)} ${s.interaction}; ${s.reason}.`);
  }
  if (protectedLow) {
    parts.push(
      protectedLow.broken
        ? `Protected higher low ${fmt(protectedLow.price)} was closed through.`
        : `Protected higher low ${fmt(protectedLow.price)} still holds.`,
    );
  }
  if (mss && mss.confirmed) parts.push(`${mss.reason}.`);
  parts.push(`Short read: ${read.status} — ${read.reason}.`);
  parts.push("Descriptive only; not a trade instruction.");
  return parts.join(" ");
}
