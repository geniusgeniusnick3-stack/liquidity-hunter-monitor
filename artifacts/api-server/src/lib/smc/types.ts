export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StructurePoint {
  index: number;
  price: number;
  type: "HH" | "HL" | "LH" | "LL";
  confirmed: boolean;
  time: number;
}

export interface StructureBreak {
  index: number;
  price: number;
  type: "BOS" | "CHoCH";
  direction: "bullish" | "bearish";
  time: number;
}

export interface StructureResult {
  trend: "bullish" | "bearish" | "ranging";
  bias: "bullish" | "bearish" | "neutral";
  confidence: number;
  pivots: StructurePoint[];
  breaks: StructureBreak[];
  /** ICT market phase inferred from BOS/CHoCH patterns */
  phase: "accumulation" | "manipulation" | "expansion" | "distribution" | "continuation" | "unknown";
  /** Human-readable structure narrative */
  narrative: string;
  /** Evidence bullets that explain the bias/confidence */
  evidence: string[];
}

/**
 * How a COMPLETED candle interacted with a liquidity level.
 *
 * Purely DESCRIPTIVE. These states record what price did; they assert nothing
 * about what happens next. In particular:
 *
 *   SWEPT  — price traded beyond the level and the completed candle closed back
 *            on the original side. NOT a reversal signal, NOT a fake breakout.
 *   BROKEN — price traded beyond the level and the completed candle closed
 *            beyond it (acceptance). NOT a continuation signal.
 *
 * Any directional reading requires the human trader to bring their own
 * structure analysis (MSS, displacement, BOS/CHoCH).
 */
export type LiquidityInteraction = "NONE" | "TOUCHED" | "SWEPT" | "BROKEN";

/** The completed candle that produced an interaction — kept for auditability. */
export interface LiquidityInteractionCandle {
  time: number;
  high: number;
  low: number;
  close: number;
}

/** Pool kinds. EQH/EQL are the equal-level variants of BSL/SSL. */
export type LiquidityPoolType = "BSL" | "SSL" | "EQH" | "EQL";

/**
 * One of the swings that a merged equal-level pool is built from.
 *
 * Kept on the pool so a reader can see WHICH highs were judged equal, and by how
 * much they differed. Without it the pairing is invisible: the output says
 * "EQH @ 100.00" and the evidence for the judgement is gone.
 */
export interface EqualLevelMember {
  price: number;
  time: number;
  index: number;
}

export interface LiquidityPool {
  price: number;
  type: LiquidityPoolType;
  score: number;
  touches: number;
  /**
   * True once the level has been CONSUMED — i.e. interaction is SWEPT or
   * BROKEN. Retained under its original name for compatibility with report.ts,
   * but note it now means "taken", not "closed through" (the old meaning was
   * the opposite of the correct SWEPT definition).
   */
  wasSwept: boolean;
  sweptAt: number | null;
  time: number;
  index: number;
  session: string | null;
  /** 0–1 probability this pool will be swept in the near future */
  probabilityOfSweep: number;

  /** Descriptive interaction state of this level. */
  interaction: LiquidityInteraction;
  /** Time (seconds) of the completed candle that produced `interaction`. */
  interactionAt: number | null;
  /** OHLC of that candle, so downstream code can explain the classification. */
  interactionCandle: LiquidityInteractionCandle | null;
  /** Volatility-scaled tolerance used at classification time (auditability). */
  tolerance: number | null;

  /**
   * Present only on EQH/EQL pools: the swings that were judged to form the same
   * level, earliest first. Length >= 2. Absent on plain BSL/SSL pools.
   */
  equalLevelMembers?: EqualLevelMember[];
}

export interface LiquidityResult {
  pools: LiquidityPool[];
  nearestBSL: LiquidityPool | null;
  nearestSSL: LiquidityPool | null;
}

export interface OrderBlock {
  type: "bullish" | "bearish";
  proximal: number;
  distal: number;
  time: number;
  index: number;
  valid: boolean;
  isMitigated: boolean;
  isBreaker: boolean;
  strength: number;
  hasFvg: boolean;
  /** 0–1 institutional confidence in this OB */
  confidence: number;
  /** Factors that drove confidence up or down */
  confidenceFactors: string[];

  // ── Lifecycle (added by the market-state layer — see smc/market-state.ts) ──
  // Optional so `analyzeOrderBlocks()` keeps producing plain blocks; the state
  // layer returns ENRICHED COPIES rather than mutating the engine's own output.
  /** Formed after a confirmed MSS in the same direction as this block. */
  createdAfterMss?: boolean;
  /** Time of the first completed candle that traded back into the block. */
  firstRetestAt?: number | null;
  /** How many completed candles have traded back into the block. */
  retestCount?: number;
  /** Time the block was invalidated by a completed close through `distal`. */
  invalidatedAt?: number | null;
  /** Never retested and never invalidated. */
  isFresh?: boolean;
  /** A completed candle reacted away from the block after the first retest. */
  reactionConfirmed?: boolean;
}

export interface FairValueGap {
  type: "bullish" | "bearish";
  top: number;
  bottom: number;
  time: number;
  index: number;
  fillFraction: number;
  isInversion: boolean;

  // ── Lifecycle (added by the market-state layer — see smc/market-state.ts) ──
  // Optional so `analyzeFVG()` keeps producing plain gaps; the state layer
  // returns ENRICHED COPIES rather than mutating the engine's own output.
  /** Formed after a confirmed MSS in the same direction. */
  createdAfterMss?: boolean;
  /** Time of the first completed candle that traded back into the gap. */
  firstRetestAt?: number | null;
  /** How many completed candles have traded back into the gap. */
  retestCount?: number;
  /** Time the gap was invalidated by a completed close through its far edge. */
  invalidatedAt?: number | null;
  /** Never retested and never invalidated. */
  isFresh?: boolean;
  /** A completed candle reacted away from the gap after the first retest. */
  reactionConfirmed?: boolean;
}

export interface DealingRange {
  high: number;
  low: number;
  timeframe: string;
}

export interface PdZone {
  label: string;
  top: number;
  bottom: number;
  timeframe: string;
  type: "premium" | "discount" | "equilibrium";
}

export interface PdArrayResult {
  currentBias: "premium" | "discount" | "equilibrium";
  zones: PdZone[];
  dealingRange: DealingRange;
  equilibrium: number;
}

export interface DailyBiasResult {
  bias: "bullish" | "bearish" | "neutral";
  strength: number;
  consecutiveDays: number;
  referencedSwing: string | null;
  /** Evidence bullets explaining the daily bias */
  evidence: string[];
}

export interface SmtDivergence {
  detected: boolean;
  type: "bearish_smt" | "bullish_smt" | null;
  confidence: number;
  time: number | null;
  primarySymbol: string | null;
  correlatedSymbol: string | null;
}

export interface DrawTarget {
  price: number;
  type: string;
  score: number;
  direction: "long" | "short";
  label: string;
  /** Confluence factors that raised this target's ranking */
  evidence: string[];
}

export interface SmcReport {
  symbol: string;
  market: "crypto" | "forex";
  timeframe: string;
  currentPrice: number;
  generatedAt: number;
  candles: Candle[];
  structure: StructureResult;
  liquidity: LiquidityResult;
  orderBlocks: OrderBlock[];
  fvg: FairValueGap[];
  pdArray: PdArrayResult;
  dailyBias: DailyBiasResult;
  smt: SmtDivergence;
  draw: DrawTarget[];
  /** Full market narrative for AI agents and UI display */
  narrative: string;
  /** Current session state e.g. "London Expansion Bullish" */
  sessionState: string;
  /**
   * Post-interaction market state — breakout acceptance / failure, protected
   * swing, confirmed MSS and the descriptive short-status read.
   *
   * Separate from `liquidity` on purpose: `liquidity` records single-candle
   * FACTS (SWEPT / BROKEN), this records what those facts left behind. It is
   * still descriptive, and still not a trade instruction.
   */
  marketState: MarketState;
}

export type Market = "crypto" | "forex";
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

// ── Market state layer (REQUIREMENTS: descriptive, not predictive) ───────────
//
// Three deliberately separate layers, because blurring them is how a monitor
// starts sounding like a prediction:
//
//   FACT   what price did            SWEPT / BROKEN / FVG / MSS
//   STATE  what that leaves behind   ACCEPTED / FAILURE WATCH / REVERSAL CONFIRMED
//   READ   what a human may infer    SHORT BLOCKED / WATCH / ARMED / READY
//
// Everything here is derived from COMPLETED candles only. `SHORT READY` is a
// description of the market's own evidence — never a promise, never a target,
// and never a reason to place an order. This project places no orders.

export type BreakoutStatus =
  /** No taken level within the screening window — nothing to judge. */
  | "NONE"
  /** Beyond the level, but not yet accepted and not yet failed. */
  | "BROKEN"
  /** BSL taken and price has stayed outside it. */
  | "BREAKOUT_ACCEPTED"
  /** BSL taken, then a completed close returned inside the range. */
  | "BREAKOUT_FAILURE_WATCH"
  /** SSL taken and price has stayed outside it (mirror of BREAKOUT_ACCEPTED). */
  | "BREAKDOWN_ACCEPTED"
  /** SSL taken, then a completed close returned inside the range. */
  | "BREAKDOWN_FAILURE_WATCH"
  /** A failure watch plus a confirmed MSS in the reversal direction. */
  | "REVERSAL_CONFIRMED";

/**
 * Descriptive readiness of a SHORT read — the mirror image is deliberately not
 * published as a symmetric "long status": the engine reports what it can show,
 * and inventing the other half would be exactly the kind of guesswork this
 * layer exists to remove.
 */
export type ShortStatus =
  /** No taken buy-side level to judge. */
  | "NONE"
  /** Evidence actively contradicts a short read. */
  | "BLOCKED"
  /** Breakout is failing, but no confirmed bearish MSS yet. */
  | "WATCH"
  /** Failure + confirmed bearish MSS + displacement + a fresh bearish FVG/OB. */
  | "ARMED"
  /** ARMED, and price has retested that bearish FVG/OB without invalidating it. */
  | "READY";

/**
 * One side's post-take state.
 *
 * WHY THERE IS NO "PRIMARY" ANY MORE
 * ----------------------------------
 * There used to be a single `BreakoutState`, chosen by sorting every taken level
 * into one line and taking the first. That one winner then drove everything —
 * including the short read. So when a NEWER sell-side take appeared at the same
 * time as a slightly older but still in-window buy-side one, the sell-side take
 * won the sort and the short read collapsed to NONE, erasing a buy-side chain
 * that was still live.
 *
 * Each side now publishes its own state. There is at most one candidate per
 * side, so no cross-side ordering rule exists to leak into a judgement — the
 * whole class of bug is gone rather than tie-broken more carefully.
 *
 * `status` keeps the existing published tokens, but breadth follows the SIDE (a
 * BSL take yields BREAKOUT_*, an SSL take yields BREAKDOWN_*) and is derived, not
 * stored here.
 *
 * Deliberately NOT published: `formedAt`, `interactionAt`, `acceptedAt`,
 * `failedAt`. They are derivation inputs with no downstream reader — see the
 * blueprint's field/reader table. Add them back with a reader, not before.
 */
export interface SideState {
  level: number;
  /** When the level was taken (swept/broken) — the fact's own timestamp. */
  interactionAt: number | null;
  interaction: LiquidityInteraction;
  status: BreakoutStatus;
  /** Consecutive completed closes beyond the level, ending at the last candle. */
  closesBeyond: number;
  reason: string;
}

/**
 * Both sides at once — the shape `MarketState.breakout` publishes.
 *
 * A null side means "nothing was taken on that side within the screening
 * window", which is a different statement from "taken and nothing happened".
 * Keeping both sides present is what lets the report show a live buy-side state
 * and a sell-side state at the same time instead of picking one.
 */
export interface BreakoutPair {
  bsl: SideState | null;
  ssl: SideState | null;
}

export interface ProtectedSwing {
  type: "high" | "low";
  label: "HH" | "HL" | "LH" | "LL";
  index: number;
  price: number;
  time: number;
  broken: boolean;
  brokenIndex: number | null;
  brokenAt: number | null;
  /** The close that broke it. */
  brokenBy: number | null;
  /**
   * The market closed back on the original side after breaking it.
   *
   * A broken-and-reclaimed swing is not a defence line any more: it described a
   * level price has since left behind. Reporting it made the block cite a break
   * from weeks earlier as if it were current, while the chart showed price far
   * away on the other side. Such a swing must be treated as absent.
   */
  reclaimed: boolean;
  /** The close that reclaimed it. */
  reclaimedAt: number | null;
}

export interface MssDisplacement {
  body: number;
  range: number;
  bodyRatio: number;
  atrMultiple: number;
  qualifies: boolean;
}

/**
 * The gap/block the short read is anchored to.
 *
 * Published so the report can NAME the level ("Bearish FVG 78,200–78,500")
 * instead of only asserting a status. Without this the lifecycle fields had no
 * consumer at all and the reader could not see which zone the status referred
 * to.
 */
export interface ShortZoneRef {
  kind: "FVG" | "OB";
  top: number;
  bottom: number;
  /** Completed candles that have traded back into the zone. */
  retestCount: number;
  reactionConfirmed: boolean;
}

export interface ConfirmedMss {
  direction: "bullish" | "bearish";
  confirmed: boolean;
  /** The protected swing whose breach is being judged. */
  brokenLevel: number;
  brokenLevelTime: number;
  brokenLevelIndex: number;
  /** The completed candle that closed through it. */
  breakIndex: number | null;
  breakTime: number | null;
  breakClose: number | null;
  /** How far beyond the level the close went, as an ATR multiple. */
  breakAtrMultiple: number | null;
  displacement: MssDisplacement | null;
  /** Every requirement that is NOT met. Empty when `confirmed`. */
  blockers: string[];
  reason: string;
  evidence: string[];
}

/**
 * The state layer's full internal result.
 *
 * NOT the published surface. Everything that leaves this process goes through one
 * of two compact projections — `marketStateSummary()` (REST, MCP) or
 * `toReplyMarketState()` (Telegram) — and only the fields those two project have
 * a named reader. The rest is derivation state that exists to be consumed INSIDE
 * this module.
 *
 * Fields deliberately absent because nothing read them: `BreakoutState.evidence`,
 * and the single `breakout` triple that used to collapse both sides into one
 * winner. Add a field back with its reader, never before.
 */
export interface MarketState {
  /** Last completed candle this state was derived from. */
  asOf: number;
  /** Close of the last CLOSED candle — what the judgement was made on. */
  lastClose: number;
  /** The last candle is still forming — the bar the reader sees right now. */
  formingLast: boolean;
  timeframe: string;
  /** Factual events, e.g. "BSL 78500 BROKEN". */
  facts: string[];
  /** Post-take state, one entry per side. Neither side can erase the other. */
  breakout: BreakoutPair;
  /** Unbroken or broken — the bullish protected low a short read must clear. */
  protectedLow: ProtectedSwing | null;
  /** Most recent confirmed MSS in either direction. */
  mss: ConfirmedMss | null;
  shortStatus: ShortStatus;
  shortReason: string;
  /** The bearish zone the short read is anchored to, when there is one. */
  shortZone: ShortZoneRef | null;
  narrative: string;
  evidence: string[];
}
