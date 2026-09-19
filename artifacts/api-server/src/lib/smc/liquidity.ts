import type {
  Candle, LiquidityPool, LiquidityResult, LiquidityInteraction, LiquidityInteractionCandle,
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

  for (let i = windowSize; i < n - 1; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;

    let isLocalHigh = true;
    let isLocalLow  = true;

    for (let j = i - windowSize; j <= Math.min(i + windowSize, n - 1); j++) {
      if (j === i) continue;
      if (candles[j].high >= hi) isLocalHigh = false;
      if (candles[j].low  <= lo) isLocalLow  = false;
    }

    const buildPool = (
      price: number,
      type: "BSL" | "SSL",
    ): LiquidityPool => {
      const isBuySide = type === "BSL";
      const session   = getSession(candles[i].time);
      const sessW     = getSessionWeight(session);
      const decay     = recencyDecay(i, n, halfLife);

      let touches   = 1;
      let interaction: LiquidityInteraction = "NONE";
      let interactionIdx: number | null = null;

      // Walk forward through COMPLETED candles only (the loop stops at n-1, and
      // callers must not append the forming candle — see classifyLiquidityInteraction).
      for (let k = i + 1; k < n; k++) {
        const tol = toleranceAt(k);
        const state = classifyLiquidityInteraction(price, isBuySide, candles[k], tol);

        // Touches are counted with the same tolerance so the notion of "reached
        // this level" is consistent with the classification above.
        if (state !== "NONE") touches++;

        // The FIRST time price trades beyond the level settles it: the level has
        // been taken and later candles cannot un-take it.
        if (isConsumed(state)) {
          interaction = state;
          interactionIdx = k;
          break;
        }
        // Remember contact, but keep looking for a genuine take.
        if (state === "TOUCHED" && interaction === "NONE") {
          interaction = "TOUCHED";
          interactionIdx = k;
        }
      }

      const consumed = isConsumed(interaction);
      // Display convention only: a level taken very recently is still "fresh"
      // in the narrative sense. (Was previously matched against the old, wrong
      // `wasSwept` meaning; now tracks genuine consumption.)
      const displacementFactor = consumed ? 1.5 : 1.0;
      const score = touches * decay * sessW * displacementFactor;

      const interactionCandle: LiquidityInteractionCandle | null =
        interactionIdx !== null
          ? {
              time: candles[interactionIdx].time,
              high: candles[interactionIdx].high,
              low: candles[interactionIdx].low,
              close: candles[interactionIdx].close,
            }
          : null;

      return {
        price,
        type,
        score,
        touches,
        wasSwept: consumed,
        sweptAt: consumed && interactionIdx !== null ? candles[interactionIdx].time : null,
        time: candles[i].time,
        index: i,
        session,
        probabilityOfSweep: consumed
          ? 0                                   // already taken — not a future target
          : estimateProbabilityOfSweep(price, currentPrice, touches, sessW, decay),
        interaction,
        interactionAt: interactionIdx !== null ? candles[interactionIdx].time : null,
        interactionCandle,
        tolerance: interactionIdx !== null ? toleranceAt(interactionIdx) : null,
      };
    };

    if (isLocalHigh) pools.push(buildPool(hi, "BSL"));
    if (isLocalLow)  pools.push(buildPool(lo, "SSL"));
  }

  const topPools      = selectReportedPools(pools, candles[n - 1]?.time ?? null);
  const activePools   = topPools.filter(p => !p.wasSwept);
  const bslPools      = activePools.filter(p => p.type === "BSL" && p.price > currentPrice);
  const sslPools      = activePools.filter(p => p.type === "SSL" && p.price < currentPrice);

  const nearestBSL = bslPools.sort((a, b) => a.price - b.price)[0] ?? null;
  const nearestSSL = sslPools.sort((a, b) => b.price - a.price)[0] ?? null;

  return { pools: topPools, nearestBSL, nearestSSL };
}
