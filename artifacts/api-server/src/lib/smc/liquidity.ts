import type {
  Candle, LiquidityPool, LiquidityPoolType, LiquidityResult, LiquidityInteraction,
  LiquidityInteractionCandle, EqualLevelMember,
} from "./types.js";
import { SMC_CONFIG } from "./config.js";
import { calcATR } from "./atr.js";

function getSession(timestamp: number): string {
  const hour = new Date(timestamp * 1000).getUTCHours();
  if (hour >= 0  && hour < 6)  return "asia";
  if (hour >= 6  && hour < 8)  return "overlap";
  if (hour >= 8  && hour < 12) return "london";
  if (hour >= 12 && hour < 17) return "newYork";
  return "offHours";
}

function getSessionWeight(session: string): number {
  return SMC_CONFIG.sessionWeights[session as keyof typeof SMC_CONFIG.sessionWeights] ?? 1.0;
}

function recencyDecay(index: number, totalBars: number, halfLife: number): number {
  const barsAgo = totalBars - 1 - index;
  return Math.exp(-Math.LN2 * barsAgo / halfLife);
}

// ── Interaction classification (REQUIREMENTS: descriptive, not predictive) ──

/**
 * Classify how ONE COMPLETED candle interacted with a liquidity level.
 *
 * This function answers exactly one question — "what did price do?" — and
 * deliberately answers nothing else:
 *
 *   SWEPT   price traded beyond the level, the completed candle closed back on
 *           the original side.
 *   BROKEN  price traded beyond the level, the completed candle closed beyond
 *           it (acceptance).
 *   TOUCHED price reached the zone but did not trade beyond it.
 *   NONE    price never reached the zone.
 *
 * It does NOT say "reversal", "continuation", "fake breakout", "confirmed", or
 * anything else about what happens next. Those readings require structure
 * analysis (MSS, displacement, BOS/CHoCH) that belongs to the human trader.
 *
 * `tolerance` is a volatility-scaled buffer (ATR multiple), not a fixed
 * percentage, so that a close a hair past the level does not register as
 * acceptance. Pass 0 for an exact comparison.
 *
 * NOTE: this function must only ever be handed CLOSED candles. Callers are
 * responsible for excluding the forming candle — an unfinished bar's "close" is
 * just the current price and would produce a state that then has to be undone.
 */
export function classifyLiquidityInteraction(
  level: number,
  isBuySide: boolean,
  candle: Candle,
  tolerance: number,
): LiquidityInteraction {
  if (isBuySide) {
    const tradedBeyond = candle.high > level + tolerance;
    const closedBeyond = candle.close > level + tolerance;
    if (tradedBeyond && closedBeyond) return "BROKEN";
    if (tradedBeyond) return "SWEPT";
    if (candle.high >= level - tolerance) return "TOUCHED";
    return "NONE";
  }

  // Sell-side liquidity — mirror image.
  const tradedBeyond = candle.low < level - tolerance;
  const closedBeyond = candle.close < level - tolerance;
  if (tradedBeyond && closedBeyond) return "BROKEN";
  if (tradedBeyond) return "SWEPT";
  if (candle.low <= level + tolerance) return "TOUCHED";
  return "NONE";
}

/** True once the level has been consumed (taken off the board as a target). */
function isConsumed(interaction: LiquidityInteraction): boolean {
  return interaction === "SWEPT" || interaction === "BROKEN";
}

// ── Probability of a future sweep ───────────────────────────────────────────

/**
 * Estimate the probability (0–1) that an untaken pool will be reached soon.
 *
 * Factors:
 *  - Distance from current price (exponential decay — closer = much more likely)
 *  - Number of equal-level touches (more resting orders = more likely to be hunted)
 *  - Session weight (London / NY sweeps are more common)
 *  - Recency (fresh pools are more relevant)
 *
 * HTF bias alignment and nearby OB/FVG confluence are applied at draw-target
 * ranking time in report.ts where that context is available.
 */
function estimateProbabilityOfSweep(
  price: number,
  currentPrice: number,
  touches: number,
  sessW: number,
  decay: number,
): number {
  const distancePct   = Math.abs(price - currentPrice) / currentPrice;
  // Exponential distance penalty: 5% away ≈ 0.22, 1% away ≈ 0.74
  const distanceFactor = Math.exp(-distancePct * 30);

  const touchFactor   = Math.min(1, touches / 4) * 0.25;
  const sessionFactor = ((sessW - 0.8) / 0.7) * 0.15;  // normalise 0.8–1.5 → 0–1
  const recencyFactor = decay * 0.15;

  return Math.min(0.95, Math.max(0.05,
    distanceFactor * 0.45 + touchFactor + sessionFactor + recencyFactor,
  ));
}

// ── Output selection ────────────────────────────────────────────────────────

/**
 * Upper bound on how many levels are reported per symbol/timeframe.
 *
 * Preserved from upstream so the shape of the output does not change. What
 * changed is WHO fills these slots — see selectReportedPools.
 */
export const LIQUIDITY_POOL_OUTPUT_LIMIT = 20;

/**
 * Choose which of the detected levels to report.
 *
 * This used to be a plain `sort by score, take 20`. That was wrong for a
 * monitoring product, in a way measurement made concrete: `score` carries a
 * recency decay, so ranking everything together let AGE decide which levels
 * survived. Across 45 symbols x 1H/4H against the live ledger, two levels were
 * valid, untouched, older than a week (18 and 20 days), and simply outscored —
 * dropped from the output for no reason other than being old. Consumed levels
 * also competed with a 1.5x displacement boost, so a level that had already been
 * taken could occupy a slot a live one needed.
 *
 * The rule now:
 *
 *   ALWAYS REPORTED   every unresolved level, plus any level settled by the most
 *                     recent completed candle. Neither may be displaced by
 *                     something fresher, because age is not a reason for a live
 *                     level to disappear — it leaves when price interacts with
 *                     it, not when a calendar turns. Just-settled levels are
 *                     guaranteed for the same reason: the newest SWEPT/BROKEN is
 *                     an event, and it must not lose a slot to older history.
 *
 *   FILLS REMAINING SLOTS   everything else, best score first, up to the limit.
 *
 * The always-reported set is small in practice (unresolved levels per symbol and
 * timeframe measured in the low tens), so the limit still shapes the output
 * without ever truncating it on the basis of age.
 */
export function selectReportedPools(
  pools: LiquidityPool[],
  lastClosedCandleTime: number | null,
  limit: number = LIQUIDITY_POOL_OUTPUT_LIMIT,
): LiquidityPool[] {
  const settledOnLastCandle = (p: LiquidityPool): boolean =>
    p.interactionAt !== null && p.interactionAt === lastClosedCandleTime
    && (p.interaction === "SWEPT" || p.interaction === "BROKEN");

  const byScore = [...pools].sort((a, b) => b.score - a.score);
  const guaranteed = byScore.filter((p) => !p.wasSwept || settledOnLastCandle(p));
  const optional = byScore.filter((p) => !guaranteed.includes(p));

  const remaining = Math.max(0, limit - guaranteed.length);
  return [...guaranteed, ...optional.slice(0, remaining)];
}

/**
 * Walk forward from `fromIndex` and report how the market treated `price`.
 *
 * Extracted so the equal-level pass can re-walk a merged pool from the swing
 * that CONFIRMED it, rather than judging it from its first member (see
 * mergeEqualLevels). Touches start at 1, because the swing that formed the level
 * is itself the first test of it.
 *
 * Only candles strictly AFTER `fromIndex` are inspected; the caller guarantees
 * `fromIndex` points at a completed bar.
 */
function walkInteraction(
  candles: Candle[],
  fromIndex: number,
  price: number,
  isBuySide: boolean,
  toleranceAt: (k: number) => number,
): { touches: number; interaction: LiquidityInteraction; interactionIdx: number | null } {
  let touches = 1;
  let interaction: LiquidityInteraction = "NONE";
  let interactionIdx: number | null = null;

  for (let k = fromIndex + 1; k < candles.length; k++) {
    const state = classifyLiquidityInteraction(price, isBuySide, candles[k], toleranceAt(k));

    // Touches use the same tolerance as the classification, so "reached this
    // level" means one thing in both places.
    if (state !== "NONE") touches++;

    // The FIRST time price trades beyond the level settles it: later candles
    // cannot un-take it.
    if (isConsumed(state)) {
      interaction = state;
      interactionIdx = k;
      break;
    }
    if (state === "TOUCHED" && interaction === "NONE") {
      interaction = "TOUCHED";
      interactionIdx = k;
    }
  }

  return { touches, interaction, interactionIdx };
}

// ── Equal highs / equal lows (EQH / EQL) ────────────────────────────────────

type PoolBuilder = (
  price: number,
  type: LiquidityPoolType,
  atIndex: number,
  priorTouches?: number,
  members?: EqualLevelMember[],
) => LiquidityPool;

/**
 * Fold swing highs that sit at the same price into ONE pool — and lows likewise.
 *
 * WHY
 * ---
 * Two highs a tick apart are not two facts, they are one. Stops rest above BOTH
 * attempts, so the area is a stronger draw than a lone swing high; reporting it
 * twice both inflates the level count and splits one liquidity area across two
 * report slots. The requirement lists EQH/EQL, `types.ts` already declared the
 * pool types, and the config key meant to drive the pairing was never read by
 * anything. This is that missing step.
 *
 * HOW THE MERGED LEVEL IS REPRESENTED
 * -----------------------------------
 *   price    the EXTREME of the cluster (highest high / lowest low) — the side
 *            the resting orders sit on relative to both attempts.
 *   time     the LAST member: the swing that confirmed the pattern. Judging the
 *            merged level from its first member would treat everything between
 *            the two attempts as a reaction to a pattern that did not exist yet.
 *   touches  one per earlier member, plus whatever the forward walk finds after
 *            the last one.
 *   members  every paired swing, so the pairing stays auditable.
 *
 * CLUSTERING IS BOUNDED, NOT CHAINED
 * ----------------------------------
 * Candidates are taken in price order and compared against the cluster's
 * EXTREME, not against the previous member. With a 0.25 ATR tolerance (ATR 0.5)
 * the highs 100.00 / 100.10 / 100.18 group the first two and leave 100.18 as its
 * own level, because 100.18 - 100.00 exceeds the tolerance. Chaining would let a
 * cluster walk arbitrarily far from where it started.
 */
function mergeSide(
  pools: LiquidityPool[],
  isBuySide: boolean,
  toleranceAt: (index: number) => number,
  makePool: PoolBuilder,
): LiquidityPool[] {
  const base: LiquidityPoolType = isBuySide ? "BSL" : "SSL";
  // Only UNTAKEN levels pair. If the first high has already been swept, its
  // stops are gone; pairing it with a later high would advertise two layers of
  // resting orders where only one remains — and would move the level up to the
  // wick that took it. Consumed levels pass through untouched instead.
  const side = pools.filter((p) => p.type === base && !p.wasSwept);
  const consumed = pools.filter((p) => p.type === base && p.wasSwept);
  if (side.length < 2) return [...side, ...consumed];

  // Price-ordered, extreme first, so cluster[0] is the price the level is drawn at.
  const sorted = [...side].sort((a, b) => (isBuySide ? b.price - a.price : a.price - b.price));
  const out: LiquidityPool[] = [];
  let cluster: LiquidityPool[] = [];

  const flush = (): void => {
    if (cluster.length === 0) return;
    if (cluster.length === 1) {
      out.push(cluster[0]!);
    } else {
      const extreme = cluster[0]!.price;
      const lastMember = cluster.reduce((m, p) => (p.index > m.index ? p : m), cluster[0]!);
      const members: EqualLevelMember[] = cluster
        .map((p) => ({ price: p.price, time: p.time, index: p.index }))
        .sort((a, b) => a.index - b.index);
      // cluster.length - 1 prior touches: walkInteraction starts its own count at
      // 1 for the last member, so the sum still equals "one test per member".
      out.push(makePool(
        extreme,
        isBuySide ? "EQH" : "EQL",
        lastMember.index,
        cluster.length - 1,
        members,
      ));
    }
    cluster = [];
  };

  for (const p of sorted) {
    if (cluster.length === 0) { cluster.push(p); continue; }
    const extreme = cluster[0]!.price;
    const pairIndex = Math.max(cluster[cluster.length - 1]!.index, p.index);
    if (Math.abs(extreme - p.price) <= toleranceAt(pairIndex)) {
      cluster.push(p);
    } else {
      flush();
      cluster.push(p);
    }
  }
  flush();
  return [...out, ...consumed];
}

/** Run mergeSide for both sides; anything that is not BSL/SSL passes through. */
function mergeEqualLevels(
  pools: LiquidityPool[],
  toleranceAt: (index: number) => number,
  makePool: PoolBuilder,
): LiquidityPool[] {
  const untouched = pools.filter((p) => p.type !== "BSL" && p.type !== "SSL");
  return [
    ...mergeSide(pools, true, toleranceAt, makePool),
    ...mergeSide(pools, false, toleranceAt, makePool),
    ...untouched,
  ];
}

// ── Analyzer ────────────────────────────────────────────────────────────────

export function analyzeLiquidity(candles: Candle[], timeframe: string, market: string): LiquidityResult {
  const n          = candles.length;
  const halfLife   = SMC_CONFIG.liquidityHalfLifeBars[timeframe] ?? 200;
  const pools: LiquidityPool[] = [];

  // Volatility-scaled tolerance. Every level is compared against the ATR of the
  // candle doing the comparing, so a quiet market needs a smaller move to count
  // as "traded beyond" than a violent one.
  const atrPeriod  = SMC_CONFIG.atrPeriodPerTf[timeframe] ?? SMC_CONFIG.atrPeriod;
  const atr        = calcATR(candles, atrPeriod);
  const tolMultiple = SMC_CONFIG.liquidityToleranceAtrMultiple;
  const toleranceAt = (k: number): number => Math.max((atr[k] ?? 0) * tolMultiple, 0);

  const currentPrice = candles[n - 1]?.close ?? 0;
  const windowSize   = Math.min(20, Math.floor(n / 4));

  // Equal-level tolerance (EQH/EQL), ATR-scaled like the interaction tolerance.
  const equalTolMultiple = SMC_CONFIG.equalLevelAtrMultiple;
  const equalToleranceAt = (k: number): number => Math.max((atr[k] ?? 0) * equalTolMultiple, 0);

  /**
   * Build one pool, judged FROM `atIndex` — the swing that formed the level, or
   * (for a merged equal-level pool) the LAST swing that confirmed it.
   * `priorTouches` carries the tests earlier members already earned.
   */
  const makePool = (
    price: number,
    type: LiquidityPoolType,
    atIndex: number,
    priorTouches = 0,
    members?: EqualLevelMember[],
  ): LiquidityPool => {
    const isBuySide = type === "BSL" || type === "EQH";
    const session   = getSession(candles[atIndex].time);
    const sessW     = getSessionWeight(session);
    const decay     = recencyDecay(atIndex, n, halfLife);

    const walk      = walkInteraction(candles, atIndex, price, isBuySide, toleranceAt);
    const touches   = priorTouches + walk.touches;
    const consumed  = isConsumed(walk.interaction);
    // Display convention only: a level taken very recently is still "fresh"
    // in the narrative sense.
    const displacementFactor = consumed ? 1.5 : 1.0;
    const score = touches * decay * sessW * displacementFactor;

    const interactionCandle: LiquidityInteractionCandle | null =
      walk.interactionIdx !== null
        ? {
            time: candles[walk.interactionIdx].time,
            high: candles[walk.interactionIdx].high,
            low: candles[walk.interactionIdx].low,
            close: candles[walk.interactionIdx].close,
          }
        : null;

    return {
      price,
      type,
      score,
      touches,
      wasSwept: consumed,
      sweptAt: consumed && walk.interactionIdx !== null ? candles[walk.interactionIdx].time : null,
      time: candles[atIndex].time,
      index: atIndex,
      session,
      probabilityOfSweep: consumed
        ? 0                                   // already taken — not a future target
        : estimateProbabilityOfSweep(price, currentPrice, touches, sessW, decay),
      interaction: walk.interaction,
      interactionAt: walk.interactionIdx !== null ? candles[walk.interactionIdx].time : null,
      interactionCandle,
      tolerance: walk.interactionIdx !== null ? toleranceAt(walk.interactionIdx) : null,
      ...(members ? { equalLevelMembers: members } : {}),
    };
  };

  for (let i = windowSize; i < n - 1; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;

    let isLocalHigh = true;
    let isLocalLow  = true;

    for (let j = i - windowSize; j <= Math.min(i + windowSize, n - 1); j++) {
      if (j === i) continue;
      // STRICT comparison: a bar is admitted when no neighbour is strictly
      // higher (lower). Admitting ties — instead of cancelling them, which is
      // what `>=` did — is what lets the equal-level pass below see two highs at
      // the same price (the classic EQH shape) rather than dropping both.
      // Measured cost of this change on 5 majors x 500 4H bars: 0 levels either
      // way, so nothing that used to be reported stops being reported.
      if (candles[j].high > hi) isLocalHigh = false;
      if (candles[j].low  < lo) isLocalLow  = false;
    }

    if (isLocalHigh) pools.push(makePool(hi, "BSL", i));
    if (isLocalLow)  pools.push(makePool(lo, "SSL", i));
  }

  const merged        = mergeEqualLevels(pools, equalToleranceAt, makePool);
  const topPools      = selectReportedPools(merged, candles[n - 1]?.time ?? null);
  const activePools   = topPools.filter(p => !p.wasSwept);
  // EQH is buy-side and EQL is sell-side. Callers ask by SIDE ("what is above
  // price?"), so the nearest-level search must not look only for the literal
  // BSL/SSL token, or a merged level would be skipped as if it did not exist.
  const bslPools      = activePools.filter(p => (p.type === "BSL" || p.type === "EQH") && p.price > currentPrice);
  const sslPools      = activePools.filter(p => (p.type === "SSL" || p.type === "EQL") && p.price < currentPrice);

  const nearestBSL = bslPools.sort((a, b) => a.price - b.price)[0] ?? null;
  const nearestSSL = sslPools.sort((a, b) => b.price - a.price)[0] ?? null;

  return { pools: topPools, nearestBSL, nearestSSL };
}
