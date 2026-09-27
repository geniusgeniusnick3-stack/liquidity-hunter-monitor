import type { Candle, SmcReport, DrawTarget, SmtDivergence, Market } from "./types.js";
import { analyzeStructure } from "./structure.js";
import { analyzeLiquidity } from "./liquidity.js";
import { analyzeOrderBlocks } from "./order-blocks.js";
import { analyzeFVG } from "./fvg.js";
import { analyzePdArray } from "./pd-array.js";
import { analyzeDailyBias } from "./daily-bias.js";
import { analyzeSMT } from "./smt.js";
import { analyzeMarketState, emptyMarketState } from "./market-state.js";
import { admitCandles, type ClosureEvidence } from "./candles.js";
import { SMC_CONFIG } from "./config.js";
import { loadConfig } from "../config/index.js";

/**
 * Is the market state layer switched on?
 *
 * `buildReport()` is reached from paths that never load `config.yaml` themselves
 * — MCP tools, REST routes, the realtime bridge, the backtest runner — so the
 * switch has to be read here rather than only in the scan engine.
 *
 * There is deliberately NO try/catch and NO fallback. The previous version
 * swallowed every config error and returned the engine default, which meant a
 * missing or malformed `config.yaml` silently switched the layer ON — the exact
 * opposite of an operator who had set `enabled: false`. Fail loud instead.
 *
 * `loadConfig()` throws on a missing file, malformed YAML or a schema violation,
 * and `index.ts` calls it during boot so a bad config stops the process at
 * startup rather than at the first report. A bare library call with no config
 * anywhere is a real error too, and now says so instead of guessing.
 */
function marketStateEnabled(): boolean {
  return loadConfig().market_state.enabled;
}

/**
 * The most recently TAKEN level whose take happened within `windowSeconds` of
 * the last completed candle.
 *
 * Three corrections over the code this replaced, each of which produced a wrong
 * narrative on real data:
 *
 *   1. It compares `interactionAt` — when price actually met the level — not
 *      `time`, which is when the level FORMED. A level formed three weeks ago
 *      and taken an hour ago is a one-hour-old event, and the old expression
 *      could never see it.
 *   2. It anchors on the last completed candle rather than `Date.now()`. Wall
 *      clock time made the narrative depend on when it was read, so identical
 *      candles produced different text and no test could pin the output down.
 *   3. It returns the LATEST take. `.find()` over an unordered pool array
 *      returned whichever pool happened to come first — a ranking artefact
 *      dressed up as recency.
 */
export function mostRecentTake<T extends { wasSwept: boolean; interactionAt: number | null }>(
  pools: T[],
  asOf: number,
  windowSeconds: number,
): T | null {
  const candidates = pools.filter(
    (p) => p.wasSwept && p.interactionAt !== null && asOf - p.interactionAt <= windowSeconds,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) =>
    (b.interactionAt ?? 0) > (a.interactionAt ?? 0) ? b : a,
  );
}

export interface BuildReportOptions {
  dailyCandles?: Candle[];
  correlatedCandles?: Candle[];
  primarySymbol?: string;
  correlatedSymbol?: string;
  market?: Market;
  timeframe?: string;
  /**
   * Compute the post-interaction market state layer (breakout acceptance /
   * failure, protected swing, confirmed MSS, short read). Defaults to true.
   *
   * Set false only for callers that run buildReport in a hot loop and never read
   * `report.marketState` — the field is still present, just empty, so the
   * report's shape does not change.
   */
  includeMarketState?: boolean;
  /**
   * What the caller can prove about the LAST bar it is handing over.
   *
   * Defaults to "unprovable" — fail-closed. An unprovable source loses its last
   * row rather than being trusted, because a bar that is still forming has a
   * "close" equal to the current price, which manufactures a state that then has
   * to be retracted. Callers whose candles come from Binance klines or the
   * closed-candle store can prove closure and should pass "proven".
   */
  closureEvidence?: ClosureEvidence;
}

// ── Session state inference ────────────────────────────────────────────────────

function getSessionHour(candles: Candle[]): number {
  return new Date(candles[candles.length - 1].time * 1000).getUTCHours();
}

/**
 * Derive a human-readable ICT session state from session time + structure context.
 * Possible states: Asian Range Formation, London Liquidity Sweep, London Expansion,
 * NY Open, NY Continuation, NY Retracement, PM Distribution, Late Session.
 */
function deriveSessionState(
  candles: Candle[],
  bias: string,
  trend: string,
  phase: string,
  pdBias: string,
): string {
  if (candles.length === 0) return "Unknown";
  const hour = getSessionHour(candles);

  if (hour >= 0 && hour < 6) {
    return "Asian Range Formation";
  }

  if (hour >= 6 && hour < 8) {
    // London-Asia overlap — prime sweep territory
    if (bias === "bullish" && pdBias === "discount") return "London Liquidity Sweep (Bullish Setup)";
    if (bias === "bearish" && pdBias === "premium")  return "London Liquidity Sweep (Bearish Setup)";
    return "London Open — Awaiting Sweep";
  }

  if (hour >= 8 && hour < 12) {
    if (phase === "expansion" && bias === "bullish") return "London Expansion — Bullish";
    if (phase === "expansion" && bias === "bearish") return "London Expansion — Bearish";
    if (phase === "manipulation")                    return "London Manipulation Sweep";
    if (trend === "ranging")                         return "London Consolidation";
    return "London Session Active";
  }

  if (hour >= 12 && hour < 14) {
    return "NY Open / London Close";
  }

  if (hour >= 14 && hour < 17) {
    if (phase === "continuation" && bias === "bullish") return "NY Continuation — Bullish";
    if (phase === "continuation" && bias === "bearish") return "NY Continuation — Bearish";
    if (pdBias === "discount" && bias === "bullish")    return "NY Retracement — Seeking Discount";
    if (pdBias === "premium"  && bias === "bearish")    return "NY Retracement — Seeking Premium";
    return "NY Session Active";
  }

  if (hour >= 17 && hour < 20) {
    return "PM Distribution";
  }

  return "Late / Off-Hours Session";
}

// ── Market narrative builder ───────────────────────────────────────────────────

function fmtPriceSimple(p: number): string {
  if (p >= 10000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}

/**
 * Build an institutional-quality market narrative for AI agents and UI.
 * Reads left-to-right: HTF context → session → structure event → entry context → objective.
 */
function buildMarketNarrative(
  report: Omit<SmcReport, "narrative" | "sessionState">,
): string {
  const parts: string[] = [];
  const bias  = report.structure.bias;
  const phase = report.structure.phase;

  // 1. Daily bias context
  if (report.dailyBias.bias !== "neutral") {
    parts.push(`Daily ${report.dailyBias.bias}.`);
  }

  // 2. Session state (we have it derived below but can infer here inline)
  const lastTs = report.candles[report.candles.length - 1]?.time ?? 0;
  const hour = new Date(lastTs * 1000).getUTCHours();
  if (hour >= 6 && hour < 8) {
    // Anchored on the take itself and on the last COMPLETED candle — see
    // mostRecentTake(). Wall-clock time and formation time both gave wrong
    // answers here.
    const recentSwept = mostRecentTake(
      report.liquidity.pools,
      lastTs,
      SMC_CONFIG.recentTakeWindowSeconds,
    );
    if (recentSwept) {
      parts.push(`London swept ${recentSwept.type}.`);
    }
  }

  // 3. Most recent structure event
  const lastBreak = report.structure.breaks[report.structure.breaks.length - 1];
  if (lastBreak) {
    const label = lastBreak.type === "BOS" ? "BOS" : "CHoCH";
    parts.push(`${label} ${lastBreak.direction} confirmed.`);
  }

  // 4. Price location context
  if (report.pdArray.currentBias !== "equilibrium") {
    const obContext = report.orderBlocks
      .filter(ob => ob.valid && !ob.isMitigated && ob.type === (bias === "bullish" ? "bullish" : "bearish"))
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (obContext) {
      const obDir = obContext.type === "bullish" ? "bullish" : "bearish";
      const hasFvg = obContext.hasFvg ? " with FVG confluence" : "";
      parts.push(
        `Price returned into ${obDir} order block${hasFvg} inside ${report.pdArray.currentBias}.`,
      );
    } else {
      parts.push(`Price in ${report.pdArray.currentBias} zone.`);
    }
  }

  // 5. SMT context
  if (report.smt.detected) {
    const smtDir = report.smt.type === "bullish_smt" ? "bullish" : "bearish";
    parts.push(`SMT divergence (${smtDir}) supports direction.`);
  }

  // 6. Nearest objective
  const topDraw = report.draw[0];
  if (topDraw) {
    parts.push(`Nearest objective: ${topDraw.type} at ${fmtPriceSimple(topDraw.price)}.`);
  }

  // 7. What the recent takes left behind (REQUIREMENTS: fact / state / read are
  //    kept apart — this sentence is the STATE and READ layers, and it is the
  //    only place the narrative says anything about a direction at all).
  if (report.marketState?.narrative) {
    parts.push(report.marketState.narrative);
  }

  return parts.filter(Boolean).join(" ");
}

// ── Confluence-based draw target scoring ─────────────────────────────────────

/**
 * Determine whether a nearby order block or FVG is confluent with a given price level.
 * Used to boost draw target scores beyond simple liquidity proximity.
 */
function confluenceBoost(
  price: number,
  orderBlocks: SmcReport["orderBlocks"],
  fvgs: SmcReport["fvg"],
  bias: string,
  pdBias: string,
  smt: SmcReport["smt"],
): { multiplier: number; evidence: string[] } {
  let multiplier = 1.0;
  const evidence: string[] = [];

  const obProximityPct = 0.005; // 0.5% proximity check
  const nearOB = orderBlocks.find(
    ob => ob.valid && !ob.isMitigated && Math.abs(ob.proximal - price) / price < obProximityPct,
  );
  if (nearOB) {
    multiplier += nearOB.confidence * 0.35;
    evidence.push(`✓ ${nearOB.type === "bullish" ? "Bullish" : "Bearish"} OB nearby`);
  }

  const nearFVG = fvgs.find(g => g.fillFraction < 0.5 && price >= g.bottom && price <= g.top);
  if (nearFVG) {
    multiplier += 0.20;
    evidence.push("✓ FVG confluence");
  }

  if (pdBias === "discount" && bias === "bullish") {
    multiplier += 0.10;
    evidence.push("✓ Discount zone (bullish)");
  } else if (pdBias === "premium" && bias === "bearish") {
    multiplier += 0.10;
    evidence.push("✓ Premium zone (bearish)");
  }

  if (smt.detected) {
    multiplier += 0.08;
    evidence.push("✓ SMT divergence");
  }

  return { multiplier, evidence };
}

// ── Main report builder ───────────────────────────────────────────────────────

export function buildReport(
  candles: Candle[],
  symbol: string,
  market: Market,
  timeframe: string,
  options: BuildReportOptions = {},
): SmcReport {
  // S1: the single admission gate — see candles.ts.
  //
  // Every source runs this before handing candles over, but buildReport() is
  // reachable from the MCP tools, the REST routes, the realtime bridge and the
  // backtest runner, so it is the last place an unusable bar could still reach a
  // PUBLISHED state. Running it a second time is idempotent: admitted candles
  // pass every check again.
  //
  // Closure is NOT assumed. Unknown provenance is treated as "possibly still
  // forming" and the gate drops the last row — the same rule the fetchers apply
  // to sources that cannot prove a close time.
  //
  // This default is fail-closed on purpose. The previous version declared
  // "proven" unconditionally, which meant the defence existed on paper while a
  // directly-passed forming bar was admitted in practice. Callers that genuinely
  // can prove closure say so explicitly via `closureEvidence`.
  const admission = admitCandles(candles, {
    closure: options.closureEvidence ?? "unprovable",
    nowSeconds: Date.now() / 1000,
    minCandles: 1,
  });
  if (admission.rejected.length > 0) {
    console.warn(
      `[smc] buildReport(${symbol} ${timeframe}) dropped ${admission.rejected.length} unusable candle(s): ` +
        admission.rejected
          .slice(0, 5)
          .map((r) => `#${r.index}:${r.reason}`)
          .join(", "),
    );
  }
  candles = admission.candles;

  // Guard against empty candle arrays — downstream code assumes at least one candle
  if (!candles || candles.length === 0) {
    return {
      symbol,
      market,
      timeframe,
      currentPrice: 0,
      generatedAt: Date.now() / 1000,
      candles: [],
      structure: {
        bias: "neutral",
        confidence: 0,
        trend: "ranging",
        pivots: [],
        breaks: [],
        phase: "unknown",
        narrative: "No candle data available.",
        evidence: [],
      },
      liquidity: {
        pools: [],
        nearestBSL: null,
        nearestSSL: null,
      },
      orderBlocks: [],
      fvg: [],
      pdArray: {
        currentBias: "equilibrium",
        zones: [],
        dealingRange: { high: 0, low: 0, timeframe },
        equilibrium: 0,
      },
      dailyBias: {
        bias: "neutral",
        strength: 0,
        consecutiveDays: 0,
        referencedSwing: null,
        evidence: [],
      },
      smt: {
        detected: false,
        type: null,
        confidence: 0,
        time: null,
        primarySymbol: symbol,
        correlatedSymbol: options.correlatedSymbol ?? null,
      },
      draw: [],
      narrative: "No candle data available for analysis.",
      sessionState: "No data",
      marketState: emptyMarketState(timeframe),
    };
  }

  const structure  = analyzeStructure(candles, timeframe);
  const fvg        = analyzeFVG(candles, market);
  const liquidity  = analyzeLiquidity(candles, timeframe, market);
  const orderBlocks = analyzeOrderBlocks(candles, fvg);
  const pdArray    = analyzePdArray(candles, timeframe);
  const dailyBias  = analyzeDailyBias(options.dailyCandles ?? []);

  // Apply HTF bias alignment to OB confidence (available here where bias is known)
  const bias = structure.bias !== "neutral" ? structure.bias : dailyBias.bias;
  for (const ob of orderBlocks) {
    if (ob.type === (bias === "bullish" ? "bullish" : "bearish")) {
      ob.confidence = Math.min(0.97, ob.confidence + 0.12);
      ob.confidenceFactors.unshift("✓ HTF bias aligned");
    } else if (bias !== "neutral") {
      ob.confidence = Math.max(0.05, ob.confidence - 0.15);
      ob.confidenceFactors.push("✗ Counter-trend OB");
    }
  }

  let smt: SmtDivergence = {
    detected: false,
    type: null,
    confidence: 0,
    time: null,
    primarySymbol: symbol,
    correlatedSymbol: options.correlatedSymbol ?? null,
  };

  if (options.correlatedCandles && options.correlatedCandles.length > 0 && options.correlatedSymbol) {
    smt = analyzeSMT(candles, options.correlatedCandles, symbol, options.correlatedSymbol);
  }

  const currentPrice = candles[candles.length - 1].close;

  // ── Post-interaction market state (see smc/market-state.ts) ────────────────
  //
  // Computed after the OB confidence pass above so the lifecycle annotations
  // describe the same order blocks the report publishes. Skippable via
  // options.includeMarketState for callers that run buildReport in a hot loop
  // and only consume the engine's own fields.
  //
  // Two ways to switch the layer off, and both must be honoured here: the
  // operational switch (config.yaml → market_state.enabled) and the explicit
  // per-call `includeMarketState: false`.
  const marketState = (options.includeMarketState === false || !marketStateEnabled())
    ? emptyMarketState(timeframe)
    : analyzeMarketState({
        candles,
        timeframe,
        liquidity: liquidity.pools,
        structure,
        fvg,
        orderBlocks,
        htfBias: dailyBias.bias,
      });

  // ── Build draw targets with confluence-boosted scoring ─────────────────────
  const draw: DrawTarget[] = [];

  if (liquidity.nearestBSL) {
    const pool      = liquidity.nearestBSL;
    const proximity = 1 / (1 + Math.abs(pool.price - currentPrice) / currentPrice * 100);
    const biasScore = bias === "bullish" ? 1.5 : 0.8;
    const baseScore = pool.score * proximity * biasScore;
    const { multiplier, evidence } = confluenceBoost(pool.price, orderBlocks, fvg, bias, pdArray.currentBias, smt);
    const ev = [`✓ BSL @ ${fmtPriceSimple(pool.price)}`, `Prob sweep: ${Math.round(pool.probabilityOfSweep * 100)}%`, ...evidence];
    draw.push({
      price: pool.price, type: "BSL", score: baseScore * multiplier,
      direction: "long", label: `Buy-side Liquidity @ ${pool.price.toFixed(5)}`,
      evidence: ev,
    });
  }

  if (liquidity.nearestSSL) {
    const pool      = liquidity.nearestSSL;
    const proximity = 1 / (1 + Math.abs(pool.price - currentPrice) / currentPrice * 100);
    const biasScore = bias === "bearish" ? 1.5 : 0.8;
    const baseScore = pool.score * proximity * biasScore;
    const { multiplier, evidence } = confluenceBoost(pool.price, orderBlocks, fvg, bias, pdArray.currentBias, smt);
    const ev = [`✓ SSL @ ${fmtPriceSimple(pool.price)}`, `Prob sweep: ${Math.round(pool.probabilityOfSweep * 100)}%`, ...evidence];
    draw.push({
      price: pool.price, type: "SSL", score: baseScore * multiplier,
      direction: "short", label: `Sell-side Liquidity @ ${pool.price.toFixed(5)}`,
      evidence: ev,
    });
  }

  const validOBs = orderBlocks.filter(ob => ob.valid && !ob.isMitigated).slice(-3);
  for (const ob of validOBs) {
    const direction = ob.type === "bullish" ? "long" : "short";
    const biasScore = (ob.type === "bullish" && bias === "bullish") ||
                      (ob.type === "bearish" && bias === "bearish") ? 1.3 : 0.7;
    const baseScore = ob.strength * ob.confidence * biasScore;
    const { multiplier, evidence } = confluenceBoost(ob.proximal, orderBlocks, fvg, bias, pdArray.currentBias, smt);
    draw.push({
      price: ob.proximal,
      type:  `${ob.type === "bullish" ? "Bullish" : "Bearish"} OB`,
      score: baseScore * multiplier,
      direction,
      label: `${ob.type === "bullish" ? "Bullish" : "Bearish"} OB @ ${ob.proximal.toFixed(5)}`,
      evidence: [
        `Conf: ${Math.round(ob.confidence * 100)}%`,
        ...ob.confidenceFactors.slice(0, 3),
        ...evidence,
      ],
    });
  }

  const unfilledFVGs = fvg.filter(g => g.fillFraction < 0.5).slice(-3);
  for (const gap of unfilledFVGs) {
    const midpoint  = (gap.top + gap.bottom) / 2;
    const direction = gap.type === "bullish" ? "long" : "short";
    const biasScore = gap.type === (bias === "bullish" ? "bullish" : "bearish") ? 1.15 : 0.7;
    const baseScore = 0.6 * biasScore;
    const { multiplier, evidence } = confluenceBoost(midpoint, orderBlocks, fvg, bias, pdArray.currentBias, smt);
    draw.push({
      price: midpoint,
      type:  `${gap.type === "bullish" ? "Bullish" : "Bearish"} FVG`,
      score: baseScore * multiplier,
      direction,
      label: `${gap.type === "bullish" ? "Bullish" : "Bearish"} FVG @ ${midpoint.toFixed(5)}`,
      evidence: [
        `Fill: ${Math.round(gap.fillFraction * 100)}%`,
        gap.isInversion ? "✓ Inversion FVG" : "",
        ...evidence,
      ].filter(Boolean),
    });
  }

  draw.sort((a, b) => b.score - a.score);

  const sessionState = deriveSessionState(
    candles, structure.bias, structure.trend, structure.phase, pdArray.currentBias,
  );

  const recentCandles = candles.slice(-100);

  // Build preliminary report (without narrative) to pass into narrative builder
  const partial = {
    symbol, market, timeframe, currentPrice,
    generatedAt: Date.now() / 1000,
    candles: recentCandles,
    structure, liquidity, orderBlocks, fvg, pdArray, dailyBias, smt,
    marketState,
    draw: draw.slice(0, 5),
  };

  const narrative = buildMarketNarrative(partial as SmcReport);

  return { ...partial, narrative, sessionState };
}
