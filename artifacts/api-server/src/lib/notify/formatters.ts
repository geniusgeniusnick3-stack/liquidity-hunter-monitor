/**
 * Alert message formatting (REQUIREMENTS §15).
 *
 * Wording rules the text must respect, in EVERY language:
 *
 *   - Never assert that stop orders exist. These are *potential* liquidity
 *     locations inferred from price structure — the text says so (§10).
 *   - A sweep/break is not a directional call. The text states which completed
 *     candle traded where, and stops there (§13, §7).
 *
 * Language is a user choice (zh-TW / zh-CN / en). The vocabulary lives in
 * ./i18n.ts so all three versions sit side by side and drift is visible;
 * this module only assembles layouts.
 *
 * Engine tokens (`BREAKOUT_ACCEPTED`, `BLOCKED`, `BOS`, `HL`, …) are NOT shown to
 * a reader. They stay in the JSON and the logs, where they are the right
 * vocabulary for checking a decision later; ./plain.ts turns them into words a
 * person can act on. Two exceptions keep their English acronym in every language
 * because they are the terms actually used for those zones: FVG and OB.
 */
import {
  stringsFor,
  uiFor,
  type Language,
  DEFAULT_LANGUAGE,
} from "./i18n.js";
import {
  plainBreakout, plainShort, plainConclusion, plainLabels, plainFacts, plainStructureKind, plainSide,
  localStamp, zoneName,
  stateWorthReporting, stateImportance, type PlainLang,
} from "./plain.js";

export type LiquiditySide = "BSL" | "SSL";
/**
 * A pool's own kind, including the merged equal-level variants. Defined here
 * rather than imported from the SMC layer, mirroring how `LiquiditySide` already
 * keeps this module independent of the engine.
 */
export type LiquidityLevelType = "BSL" | "SSL" | "EQH" | "EQL";

export interface ApproachingAlert {
  symbol: string;
  timeframe: string;
  side: LiquiditySide;
  level: number;
  /** Zone band around the level, when the level came from multiple touches. */
  zoneLow?: number;
  zoneHigh?: number;
  currentPrice: number;
  distancePct: number;
  /** e.g. "Equal High + Swing High" */
  source: string;
  /**
   * Set when the level is a merged equal-highs/lows pool, so the alert can say so.
   * Optional: callers that predate EQH/EQL keep working untouched.
   */
  poolType?: LiquidityLevelType;
}

export interface SweepAlert {
  symbol: string;
  timeframe: string;
  side: LiquiditySide;
  /** The liquidity level that was taken. */
  level: number;
  /** The extreme the wick reached beyond the level. */
  extreme: number;
  /** The close of the candle that did the sweep. */
  close: number;
  /** true = closed beyond the level (BROKEN), false = closed back inside (SWEPT). */
  broken: boolean;
}

export interface StructureAlert {
  symbol: string;
  timeframe: string;
  kind: "BOS" | "CHoCH";
  direction: "bullish" | "bearish";
  level: number;
  close: number;
}

export interface HealthHeartbeatAlert {
  activeSymbols: number;
  wsConnected: boolean;
  lastMarketDataAt: number;
  universeAgeMinutes: number;
  telegramSent: number;
  telegramFailed: number;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

const TF_LABEL: Record<string, string> = {
  "1m": "1M", "5m": "5M", "15m": "15M", "30m": "30M",
  "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W",
};

const tfLabel = (tf: string): string => TF_LABEL[tf] ?? tf.toUpperCase();

/**
 * Price formatting that keeps meaningful digits without trailing noise:
 *   0.8335 → "0.8335"    0.8318 → "0.8318"    81435.09 → "81,435.09"
 */
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

const p = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return trimZeros(n.toFixed(4));
  const s = Number(n.toPrecision(5)).toString();
  // Very small prices stringify in exponential form — render them plainly.
  return s.includes("e") ? trimZeros(n.toFixed(10)) : s;
};

const sideLabel = (side: LiquiditySide, lang: Language): string => {
  const s = stringsFor(lang);
  return side === "BSL" ? s.sideBsl : s.sideSsl;
};

/**
 * Marker for a merged equal-level pool (等高點 / 等低點).
 *
 * Deliberately language-independent and placeable anywhere: it is the one signal
 * in a wall of prices that says "this level was already tested twice". A scale is
 * the visual for "equal", and the surrounding words (等高點 / 等高点 / Equal
 * highs) say which side.
 */
const EQUAL_LEVEL_MARK = "⚖️";

/**
 * Emoji + localized name for a merged equal-level pool, or null for a plain
 * swing high/low.
 *
 * Null for BSL/SSL on purpose: the surrounding text already says which side the
 * level is on, so repeating it on every line is noise. An EQH/EQL says something
 * neither the heading nor the side token can — this price was tested more than
 * once.
 */
const equalLevelTag = (type: LiquidityLevelType | undefined, lang: Language): string | null => {
  const s = stringsFor(lang);
  if (type === "EQH") return `${EQUAL_LEVEL_MARK}${s.typeEqh}`;
  if (type === "EQL") return `${EQUAL_LEVEL_MARK}${s.typeEql}`;
  return null;
};

/** Join list items with the separator the language actually uses. */
const listJoin = (items: string[], lang: Language): string =>
  lang === "en" ? items.join(", ") : items.join("、");

// ── Liquidity approaching ───────────────────────────────────────────────────

export function formatApproaching(a: ApproachingAlert, lang: Language = DEFAULT_LANGUAGE): string {
  const s = stringsFor(lang);
  const tf = tfLabel(a.timeframe);

  // A merged equal-level pool says something the side token cannot: this price
  // has already been tested more than once.
  const merged = equalLevelTag(a.poolType, lang);
  const typeSuffix = merged ? ` ${merged}` : "";

  const zone = a.zoneLow !== undefined && a.zoneHigh !== undefined && a.zoneLow !== a.zoneHigh
    ? `${p(a.zoneLow)} – ${p(a.zoneHigh)}`
    : p(a.level);

  const rows = lang === "en"
    ? [
        s.approachingTitle,
        "",
        `${s.labelSymbol}: ${a.symbol}`,
        `${s.labelTimeframe}: ${tf}`,
        `${s.labelType}: ${sideLabel(a.side, lang)}${typeSuffix}`,
        `${s.labelZone}: ${zone}`,
        `${s.labelCurrentPrice}: ${p(a.currentPrice)}`,
        `${s.labelDistance}: ${a.distancePct.toFixed(2)}%`,
        `${s.labelSource}: ${a.source}`,
        "",
        s.approachingFooter,
      ]
    : [
        s.approachingTitle,
        "",
        `${s.labelSymbol}：${a.symbol}`,
        `${s.labelTimeframe}：${tf}`,
        `${s.labelType}：${sideLabel(a.side, lang)}${typeSuffix}`,
        `${s.labelZone}：${zone}`,
        `${s.labelCurrentPrice}：${p(a.currentPrice)}`,
        `${s.labelDistance}：${a.distancePct.toFixed(2)}%`,
        `${s.labelSource}：${a.source}`,
        "",
        s.approachingFooter,
      ];

  return rows.join("\n");
}

// ── Liquidity swept / broken ────────────────────────────────────────────────

export function formatSweep(input: SweepAlert, lang: Language = DEFAULT_LANGUAGE): string {
  const s = stringsFor(lang);
  const tf = tfLabel(input.timeframe);
  const state = input.broken ? s.stateBroken : s.stateSwept;
  // Was the RAW side token ("BSL"/"SSL"). A reader gets the words, not the code.
  const heading = `${tf} ${sideLabel(input.side, lang)} ${state}`;

  const beyond = s.beyond(input.side);
  const settled = s.settled(input.side, input.broken);
  const statement = s.statement({ beyond, settled, timeframe: tf, count: 1, side: input.side });
  const extremeLabel = input.side === "BSL" ? s.labelWickHigh : s.labelWickLow;

  const rows = lang === "en"
    ? [
        heading,
        "",
        `${s.labelSymbol}: ${input.symbol}`,
        `${s.labelLevel}: ${p(input.level)}`,
        `${extremeLabel}: ${p(input.extreme)}`,
        `${s.labelClose}: ${p(input.close)}`,
        "",
        statement,
      ]
    : [
        heading,
        "",
        `${s.labelSymbol}：${input.symbol}`,
        `${s.labelLevel}：${p(input.level)}`,
        `${extremeLabel}：${p(input.extreme)}`,
        `${s.labelClose}：${p(input.close)}`,
        "",
        statement,
      ];

  return rows.join("\n");
}

// ── Grouped sweep/break (several levels taken by the SAME candle) ───────────

/**
 * One message for several levels taken by the same candle.
 *
 * Why: adjacent swing highs a few ticks apart are *the same event* to a human,
 * but each is a distinct level to the engine. Announcing them separately reads
 * as spam (e.g. two levels in the same 4H candle). Grouping keeps one fact per
 * event without discarding information — every level is still listed.
 */
export function formatSweepGroup(
  input: {
    symbol: string;
    timeframe: string;
    side: LiquiditySide;
    levels: number[];
    /**
     * Kinds parallel to `levels`. Optional so older callers keep working; a
     * missing entry is read as a plain swing high/low.
     */
    levelTypes?: LiquidityLevelType[];
    extreme: number;
    close: number;
    /** Preferred form; `broken` is the legacy single-level flag. */
    state?: "SWEPT" | "BROKEN";
    broken?: boolean;
  },
  lang: Language = DEFAULT_LANGUAGE,
): string {
  const s = stringsFor(lang);
  const tf = tfLabel(input.timeframe);
  const broken = input.state ? input.state === "BROKEN" : (input.broken ?? false);
  const state = broken ? s.stateBroken : s.stateSwept;

  // Kinds travel parallel to the prices, so a merged equal-level pool can be
  // named here instead of looking like an ordinary swing. Keyed by price because
  // the same level can be reported more than once in one pass.
  const kindByPrice = new Map<number, LiquidityLevelType | undefined>();
  for (let i = 0; i < input.levels.length; i++) {
    const price = input.levels[i]!;
    if (!kindByPrice.has(price)) kindByPrice.set(price, input.levelTypes?.[i]);
  }
  const levels = [...kindByPrice.keys()].sort((a, b) => a - b);

  const heading = levels.length > 1
    ? `${tf} ${input.side} ${state} ×${levels.length}`
    : `${tf} ${input.side} ${state}`;

  const beyond = s.beyond(input.side);
  const settled = s.settled(input.side, broken);
  const statement = s.statement({
    beyond, settled, timeframe: tf, count: levels.length, side: input.side,
  });

  const extremeLabel = input.side === "BSL" ? s.labelWickHigh : s.labelWickLow;
  const levelLine = `${s.labelLevel}${lang === "en" ? ": " : "："}${listJoin(levels.map((l) => {
    const tag = equalLevelTag(kindByPrice.get(l), lang);
    return tag ? `${p(l)} ${tag}` : p(l);
  }), lang)}`;

  const sep = lang === "en" ? ": " : "：";
  const rows = [
    heading,
    "",
    `${s.labelSymbol}${sep}${input.symbol}`,
    levelLine,
    `${extremeLabel}${sep}${p(input.extreme)}`,
    `${s.labelClose}${sep}${p(input.close)}`,
    "",
    statement,
  ];

  return rows.join("\n");
}

// ── User-facing scan reply ─────────────────────────────────────────────────

/**
 * A level as shown in a single-symbol snapshot.
 * Mirrors ScanEngine.LevelSnapshot without importing from it.
 */
export interface ReplyLevel {
  price: number;
  side: LiquiditySide;
  state: string;
  taken: boolean;
  distancePct: number;
  interactionAt: number | null;
  /**
   * The pool's own kind. Optional so existing callers keep compiling; when it is
   * EQH/EQL the snapshot names the merged level instead of leaving the reader to
   * infer that this price was tested twice.
   */
  poolType?: LiquidityLevelType;
}

export interface ReplySnapshot {
  symbol: string;
  timeframe: string;
  currentPrice: number;
  levels: ReplyLevel[];
  /**
   * Post-interaction state, when the funnel investigated this symbol/timeframe.
   * Absent (or null) means nothing was taken within the screening window — not
   * that the market has no state.
   */
  marketState?: ReplyMarketState | null;
}

export interface ScanReplyInput {
  /** What was scanned, already humanised (e.g. "TRXUSDT 4H" or "all tracked symbols"). */
  scope: string;
  events: Array<{
    symbol: string;
    timeframe: string;
    side: LiquiditySide;
    state: "SWEPT" | "BROKEN";
    levels: number[];
    /** Kinds parallel to `levels`. Missing entries read as plain swings. */
    levelTypes?: LiquidityLevelType[];
  }>;
  approaches: Array<{
    symbol: string; timeframes: string[]; side: LiquiditySide;
    price: number; distancePct: number;
    poolType?: LiquidityLevelType;
  }>;
  historySkipped: Array<{
    symbol: string; timeframe: string; side: LiquiditySide;
    price: number;
    poolType?: LiquidityLevelType;
  }>;
  symbolCount: number;
  latestCandleTime: number;
  scanned: number;
  failures: number;
  /**
   * Full standing state. When present for a single symbol, the reply becomes a
   * snapshot instead of an event list — see formatScanReply.
   */
  snapshots?: ReplySnapshot[];
  /**
   * Depth results from a market-wide scan — only the symbol/timeframes where
   * something was actually taken and the state layer therefore ran. Rendered as
   * their own blocks, capped so a busy market cannot turn the reply into a wall.
   */
  marketStates?: ReplySymbolMarketState[];
}

/**
 * The answer to "is anything happening?" — not a run log.
 *
 * Deliberately separate from the operator summary printed by the CLI. An earlier
 * version reused that summary for the chat reply and leaked internal detail into
 * the conversation: dedup-state counters, a Node.js experimental-feature warning,
 * and lines like "Sent 0". None of it means anything to the person asking, and
 * it buries the actual answer.
 *
 * Kept short on purpose: the alert bodies carry the detail when there is any.
 */
export function formatScanReply(input: ScanReplyInput, lang: Language = DEFAULT_LANGUAGE): string {
  const s = stringsFor(lang);
  const t = uiFor(lang);
  const sep = lang === "en" ? " | " : "｜";

  const time = input.latestCandleTime
    ? new Date(input.latestCandleTime * 1000).toLocaleString("zh-TW", {
        timeZone: "Asia/Taipei", hour12: false,
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      })
    : "—";

  // Brackets and separators follow the language: full-width for Chinese, ASCII
  // for English. Mixing them is a small thing that reads as sloppy.
  const open = lang === "en" ? "(" : "（";
  const close = lang === "en" ? ")" : "）";
  const listSep = lang === "en" ? ", " : "、";

  const blocks: string[] = [`${t.replyTitle}${sep}${input.scope}`];

  // A single-symbol question deserves the standing picture, not a list of what
  // happened to be new. Reporting "no events" for a symbol with six live levels
  // is technically true and completely unhelpful.
  const snap = input.snapshots?.length === 1 ? input.snapshots[0] : undefined;
  if (snap) {
    return formatSnapshot(snap, blocks[0], t, s, lang, time);
  }

  if (input.events.length > 0) {
    const rows = [t.replyEventsHeading];
    for (const e of input.events) {
      // Kinds travel parallel to the prices. Dedupe by PRICE (a level can be
      // reported twice across the pass) while keeping the first kind that came
      // with it — a merged level must not be silently downgraded to a plain swing
      // just because the same price showed up once without a kind.
      const kindByPrice = new Map<number, LiquidityLevelType | undefined>();
      for (let i = 0; i < e.levels.length; i++) {
        const price = e.levels[i]!;
        if (!kindByPrice.has(price)) kindByPrice.set(price, e.levelTypes?.[i]);
      }
      const levels = [...kindByPrice.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([price, kind]) => {
          const tag = equalLevelTag(kind, lang);
          return tag ? `${p(price)} ${tag}` : p(price);
        })
        .join(listSep);
      const state = e.state === "BROKEN" ? s.stateBroken : s.stateSwept;
      // The raw "BSL"/"SSL" token belongs in the records and the JSON, never in a
      // message a person reads — this line was the one door it still came through,
      // and the approach line below it.
      rows.push(`  • ${e.symbol} ${e.timeframe.toUpperCase()} ${plainSide(e.side, lang as PlainLang)} ${state} ${levels}`);
    }
    blocks.push(rows.join("\n"));
  } else {
    blocks.push(t.replyNoEvents);
  }

  if (input.approaches.length > 0) {
    const rows = [t.replyApproachingHeading];
    for (const a of input.approaches.slice(0, 10)) {
      const tf = a.timeframes.map((x) => x.toUpperCase()).join("+");
      const tag = equalLevelTag(a.poolType, lang);
      rows.push(`  • ${a.symbol} ${tf} ${plainSide(a.side, lang as PlainLang)} ${p(a.price)}${open}${a.distancePct.toFixed(2)}%${close}${tag ? ` ${tag}` : ""}`);
    }
    if (input.approaches.length > 10) {
      rows.push(`  ${t.more(input.approaches.length - 10)}`);
    }
    blocks.push(rows.join("\n"));
  }

  // ── Post-interaction state ──
  //
  // Only for symbol/timeframes where something was actually taken, which the
  // funnel keeps to a handful out of the universe. Capped so a busy market
  // cannot bury the event list under state blocks.
  // Filtered first (a block that only repeats the event list is noise), then
  // ordered by significance rather than by scan order. The cap then hides the
  // least interesting blocks instead of whichever symbols happened to come last.
  const stateBlocks = (input.marketStates ?? [])
    .filter((m) => stateWorthReporting(m.state))
    .slice()
    .sort((a, b) => stateImportance(b.state) - stateImportance(a.state));
  if (stateBlocks.length > 0) {
    const maxBlocks = 10;
    for (const m of stateBlocks.slice(0, maxBlocks)) {
      blocks.push(formatMarketStateBlock(m.symbol, m.timeframe, m.state, lang));
    }
    if (stateBlocks.length > maxBlocks) {
      blocks.push(t.more(stateBlocks.length - maxBlocks));
    }
  }

  const footer = [t.replyFooter(input.symbolCount, time)];
  if (input.failures > 0) {
    footer.push(t.replyFailed(input.failures, input.scanned));
  }
  blocks.push(footer.join("\n"));

  return blocks.join("\n\n");
}

/**
 * The standing picture for one symbol/timeframe.
 *
 * Lists what is still in play above and below price, then what was recently
 * taken. Untaken levels come first because those are what a trader is watching;
 * taken levels are context.
 *
 * Distance is shown as a percentage of price rather than an absolute figure, so
 * the display works the same for BTC and for a sub-cent altcoin.
 */
function formatSnapshot(
  snap: ReplySnapshot,
  header: string,
  t: ReturnType<typeof uiFor>,
  s: ReturnType<typeof stringsFor>,
  lang: Language,
  candleTime: string,
): string {
  const sep = lang === "en" ? " | " : "｜";
  const colon = lang === "en" ? ": " : "：";
  const listSep = lang === "en" ? ", " : "、";

  const blocks: string[] = [
    header,
    `${t.snapCurrent} ${p(snap.currentPrice)}${sep}${snap.timeframe.toUpperCase()}`,
  ];

  const fmt = (l: ReplyLevel): string => {
    const state = l.taken ? t.snapTaken : (l.state === "TOUCHED" ? t.snapTouched : t.snapUntaken);
    // Absolute distance: the heading already says above/below, so a signed
    // number would be redundant and reads as an error at a glance.
    // A merged level carries its own name — the heading cannot say that this
    // price was tested more than once.
    const kind = equalLevelTag(l.poolType, lang);
    return `  ${p(l.price)}  ${t.snapDistance(Math.abs(l.distancePct))}  ${state}${kind ? `  ${kind}` : ""}`;
  };

  const live = snap.levels.filter((l) => !l.taken);
  const above = live.filter((l) => l.side === "BSL").sort((a, b) => a.price - b.price);
  const below = live.filter((l) => l.side === "SSL").sort((a, b) => b.price - a.price);

  if (above.length) {
    blocks.push([t.snapAbove, ...above.map(fmt)].join("\n"));
  }
  if (below.length) {
    blocks.push([t.snapBelow, ...below.map(fmt)].join("\n"));
  }
  if (!above.length && !below.length) {
    blocks.push(t.snapNone);
  }

  // Recent consumption, newest first — context for why some levels are absent.
  const taken = snap.levels
    .filter((l) => l.taken && l.interactionAt)
    .sort((a, b) => (b.interactionAt ?? 0) - (a.interactionAt ?? 0))
    .slice(0, 5);

  if (taken.length) {
    const rows = [t.snapTakenHeading];
    for (const l of taken) {
      const when = l.interactionAt
        ? new Date(l.interactionAt * 1000).toLocaleString("zh-TW", {
            timeZone: "Asia/Taipei", hour12: false,
            month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
          })
        : "—";
      const state = l.state === "BROKEN" ? s.stateBroken : s.stateSwept;
      rows.push(`  ${l.side} ${p(l.price)}  ${when}  ${state}`);
    }
    blocks.push(rows.join("\n"));
  }

  // The state block goes AFTER the level picture: the levels say where things
  // are, the state says what the recent takes left behind. Facts first, then the
  // reading — never the other way round.
  if (snap.marketState) {
    blocks.push(formatMarketStateBlock(snap.symbol, snap.timeframe, snap.marketState, lang));
  }

  blocks.push(t.replyFooter(1, candleTime));
  return blocks.join("\n\n");
}

// ── Market state block (post-interaction state) ──────────────────────────────

/**
 * The post-interaction state, as it appears in a report.
 *
 * A minimal mirror of `MarketState`, deliberately NOT imported: this module
 * renders text and stays independent of the analysis layer, exactly as
 * `ReplyLevel` mirrors `LevelSnapshot`.
 */
export interface ReplyMarketState {
  facts: string[];
  /**
   * Post-take state, per side.
   *
   * This used to be a single `breakoutSide`/`breakoutLevel`/`breakoutStatus`
   * triple, mirroring the engine's old "one primary take" shape. Both sides can
   * be live at once, so a single triple could only ever show one of them — and
   * the one it hid was whichever happened to lose the shared sort.
   */
  breakoutBsl: { level: number; status: string; interactionAt: number | null } | null;
  breakoutSsl: { level: number; status: string; interactionAt: number | null } | null;
  protectedLowPrice: number | null;
  protectedLowBroken: boolean;
  /** Broken and then reclaimed — the level is no longer a defence line. */
  protectedLowReclaimed?: boolean;
  /** When the defence line was closed through — a stale fact must not read as fresh. */
  protectedLowBrokenAt: number | null;
  mssDirection: string | null;
  mssConfirmed: boolean;
  /** When the structure actually turned. */
  mssBreakTime: number | null;
  /** The candle this judgement was made on. */
  asOf: number;
  lastClose: number;
  /** Still forming — the message must not call it closed. */
  formingLast?: boolean;
  shortStatus: string;
  shortReason: string;
}

export interface ReplySymbolMarketState {
  symbol: string;
  timeframe: string;
  state: ReplyMarketState;
}

/** Structural shape accepted from the analysis layer — see MarketState. */
/**
 * A take the market has already undone is not support or resistance any more —
 * price crossed back through the level, so there is nothing there to hold or cap
 * price. Such a level used to be printed, and the complaint was precise: "stop
 * reporting levels that have already failed".
 *
 * Only the REPORT drops it. `marketStateSummary` still publishes every status, so
 * the JSON and the API keep the full token set.
 */
function liveSide(
  s: { level: number; status: string; interactionAt?: number | null } | null | undefined,
): { level: number; status: string; interactionAt: number | null } | null {
  if (!s) return null;
  // A take the market has pushed back is KEPT. It is the standing evidence for the
  // MSS read: the level was taken and given up, which is what tells a reader price
  // failed there. Dropping every failure left the block with no level at all and
  // removed the basis for the short-side judgement.
  //
  // The defence line is a different matter — see `protectedLowReclaimed`: a swing
  // price has closed back through is not a defence line, and that one is dropped.
  return { level: s.level, status: s.status, interactionAt: s.interactionAt ?? null };
}

export function toReplyMarketState(state: {
  facts: string[];
  breakout: {
    bsl: { level: number; status: string; interactionAt?: number | null } | null;
    ssl: { level: number; status: string; interactionAt?: number | null } | null;
  };
  protectedLow: {
    price: number;
    broken: boolean;
    brokenAt?: number | null;
    reclaimed?: boolean;
  } | null;
  mss: { direction: string; confirmed: boolean; breakTime?: number | null } | null;
  asOf?: number;
  lastClose?: number;
  formingLast?: boolean;
  shortStatus: string;
  shortReason: string;
}): ReplyMarketState {
  return {
    facts: [...state.facts],
    breakoutBsl: liveSide(state.breakout.bsl),
    breakoutSsl: liveSide(state.breakout.ssl),
    protectedLowPrice: state.protectedLow?.price ?? null,
    protectedLowBroken: state.protectedLow?.broken ?? false,
    protectedLowBrokenAt: state.protectedLow?.brokenAt ?? null,
    protectedLowReclaimed: state.protectedLow?.reclaimed ?? false,
    mssDirection: state.mss?.direction ?? null,
    mssConfirmed: state.mss?.confirmed ?? false,
    mssBreakTime: state.mss?.breakTime ?? null,
    asOf: state.asOf ?? 0,
    lastClose: state.lastClose ?? 0,
    formingLast: state.formingLast === true,
    shortStatus: state.shortStatus,
    shortReason: state.shortReason,
  };
}

/**
 * Render the state as a three-layer block.
 *
 * The layers are kept visually separate on purpose, because blurring them is
 * exactly how a monitor starts reading like a forecast:
 *
 *   事實事件  what price did             (the engine's own finding)
 *   突破狀態  what that leaves behind    ACCEPTED / FAILURE WATCH / REVERSAL CONFIRMED
 *   空方判讀  what a human may infer     BLOCKED / WATCH / ARMED / READY
 *
 * Status TOKENS are not translated — they are the engine's vocabulary, they
 * appear in logs and in the JSON, and they must read identically everywhere.
 * Only the labels are localised.
 *
 * The closing line is not decoration: every status above is a description of the
 * evidence present, never a promise about price, and never an instruction.
 */
/**
 * Times are rendered by `localStamp` in plain.ts, in the zone the MESSAGE language
 * uses (台灣／北京／New York-ET). Keeping one implementation means the block, the fact
 * line and the conclusion cannot disagree about which clock they are on — and a
 * state block mixes facts of very different ages, so they all need a clock.
 */
/** Bar length per timeframe, so a stamp can name the bar's span, not just its start. */
const TF_SECONDS: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800,
};


/**
 * Mark a fact as old once it is more than a day behind the data. Under a day the
 * clock time alone is enough; past that, "13 days ago" is the part that matters.
 * `now` is the data time (`asOf`), not the wall clock, so the output is stable.
 */
function ageSuffix(at: number | null, now: number, lang: PlainLang): string {
  if (!at || !now || at > now) return "";
  const hours = (now - at) / 3_600;
  if (hours < 24) return "";
  const days = Math.floor(hours / 24);
  return lang === "en" ? ` (${days}d ago)` : `（${days} 天前）`;
}

/** "　09-21 16:00" — a trailing timestamp on a fact row. */
function whenLabel(at: number | null, now: number, lang: PlainLang): string {
  if (!at) return "";
  return lang === "en"
    ? `  [${localStamp(at, lang)}${ageSuffix(at, now, lang)}]`
    : `　${localStamp(at, lang)}${ageSuffix(at, now, lang)}`;
}

export function formatMarketStateBlock(
  symbol: string,
  timeframe: string,
  st: ReplyMarketState,
  lang: Language = DEFAULT_LANGUAGE,
): string {
  const t = uiFor(lang);
  const colon = lang === "en" ? ": " : "：";
  const sep = lang === "en" ? " | " : "｜";
  // English must not inherit the full-width brackets the Chinese scripts use.
  const op = lang === "en" ? " (" : "（";
  const cl = lang === "en" ? ")" : "）";
  const L = plainLabels(lang as PlainLang);
  const pl = lang as PlainLang;

  const heading = lang === "en"
    ? `${t.stateHeading} — ${symbol} ${timeframe.toUpperCase()}`
    : `【${t.stateHeading}】${symbol} ${timeframe.toUpperCase()}`;

  const rows: string[] = [heading];

  // Which candle this judgement was made on, with its close. Without it a reader
  // cannot tell a live reading from an hours-old one — and "the price is nothing
  // like my chart" is the only conclusion available.
  if (st.asOf > 0) {
    // Show the candle's SPAN, not just its opening stamp. "資料時間 20:00" read at
    // 21:25 looks like data two hours behind, when it is in fact the 20:00–21:00 bar
    // that closed 25 minutes ago — the raw fetch was never late. Naming the start
    // and the end removes the ambiguity instead of relying on the reader to know how
    // long a bar lasts.
    const barSeconds = TF_SECONDS[timeframe.toLowerCase()] ?? 3600;
    const zone = zoneName(pl);
    const start = localStamp(st.asOf, pl);
    const end = localStamp(st.asOf + barSeconds, pl).slice(-5);
    // Never call a forming bar closed. The label is the reader's only warning that
    // this reading can still change before the bar ends.
    const closedWord = st.formingLast
      ? (lang === "en" ? "forming" : lang === "zh-CN" ? "尚未收盘" : "尚未收盤")
      : (lang === "en" ? "closed" : lang === "zh-CN" ? "已收盘" : "已收盤");
    // Three-way like `closedWord` above: "Chinese" is not one language here, and a
    // two-way split silently hands Traditional wording to Simplified readers.
    const priceWord = st.formingLast
      ? (lang === "en" ? "now" : lang === "zh-CN" ? "现价" : "現價")
      : (lang === "en" ? "close" : "收");
    rows.push(
      lang === "en"
        ? `Bars: ${start}–${end} (${zone}), ${closedWord} — ${priceWord} ${p(st.lastClose)}`
        : `${lang === "zh-CN" ? "数据时间" : "資料時間"}${colon}${start}–${end}（${zone}，${closedWord}）　${priceWord} ${p(st.lastClose)}`,
    );
  }

  // The first line answers the only question that matters at a glance — can I act
  // on this or not. Everything under it is the supporting evidence.
  const conclusion = plainConclusion(
    st.breakoutBsl, st.breakoutSsl, st.protectedLowBroken, st.shortStatus, pl,
    st.mssDirection, st.mssConfirmed,
  );
  if (conclusion) {
    rows.push("");
    rows.push(`${L.conclusion}${colon}${conclusion}`);
  }

  rows.push("");
  // Levels, named so the number means something. Both sides render because both
  // can be live at once; showing one would hide a real state.
  // "Above" / "below" is where the level sits relative to the CURRENT price, not a
  // property of the side it was found on. Labelling a level by side alone printed
  // "above 82,282.8" for a level price had already risen 3.7% past — a label that
  // contradicts the only number next to it. A broken-through level becomes support,
  // so it belongs below.
  const sideWord = (level: number, fallback: string): string => {
    if (!st.lastClose) return fallback;
    return level > st.lastClose ? L.above : L.below;
  };
  if (st.breakoutBsl) {
    rows.push(
      `‧ ${sideWord(st.breakoutBsl.level, L.above)} ${p(st.breakoutBsl.level)}${colon}${plainBreakout(st.breakoutBsl.status, pl, "up")}` +
      whenLabel(st.breakoutBsl.interactionAt, st.asOf, pl),
    );
  }
  if (st.breakoutSsl) {
    rows.push(
      `‧ ${sideWord(st.breakoutSsl.level, L.below)} ${p(st.breakoutSsl.level)}${colon}${plainBreakout(st.breakoutSsl.status, pl, "down")}` +
      whenLabel(st.breakoutSsl.interactionAt, st.asOf, pl),
    );
  }
  // A reclaimed line is not shown at all: price has left it behind, and printing it
  // invited the reader to weigh a level the market already discarded.
  if (st.protectedLowPrice !== null && !st.protectedLowReclaimed) {
    rows.push(
      `‧ ${L.defenceLine} ${p(st.protectedLowPrice)}${colon}${st.protectedLowBroken ? L.broken : L.intact}` +
      whenLabel(st.protectedLowBrokenAt, st.asOf, pl),
    );
  }
  if (st.mssDirection) {
    const dir = st.mssDirection === "bullish" ? L.dirUp : L.dirDown;
    const state = st.mssConfirmed ? L.mssConfirmed : L.mssPending;
    rows.push(
      `‧ ${L.structure}${colon}${dir}${op}${state}${cl}` +
      whenLabel(st.mssConfirmed ? st.mssBreakTime : null, st.asOf, pl),
    );
  }
  // The engine's own shortReason is an English sentence, and it was identical in
  // every block. A reader gets the plain status instead; the conclusion above
  // already carries the "why".
  rows.push(`‧ ${L.shortRead}${colon}${plainShort(st.shortStatus, pl)}`);

  // Extra taken levels, in plain words — real events the bullets above do not
  // repeat. Only shown when there is more than one, so nothing is duplicated.
  const extra = st.facts.length > 1 ? plainFacts(st.facts, pl, st.lastClose) : [];
  if (extra.length > 0) {
    rows.push("");
    rows.push(`${L.facts}${colon}${extra.join(sep)}`);
  }

  rows.push("");
  rows.push(t.stateDisclaimer);

  return rows.join("\n");
}

// ── Structure events (OB / FVG / BOS / CHoCH — optional alert types) ────────

export function formatStructure(input: StructureAlert, lang: Language = DEFAULT_LANGUAGE): string {
  const tf = tfLabel(input.timeframe);

  // `input.kind` is the engine's CHoCH / BOS — never printed to a reader. The
  // EN branch below also uses this, so it is resolved before the split.
  const kind = plainStructureKind(input.kind, lang as PlainLang);
  const direction = input.direction === "bullish"
    ? (lang === "en" ? "structure shifted upward" : "向上")
    : (lang === "en" ? "structure shifted downward" : "向下");

  if (lang === "en") {
    return [
      `${tf} ${kind}`,
      "",
      `Symbol: ${input.symbol}`,
      `Timeframe: ${tf}`,
      `Event: ${kind} (${direction})`,
      `Broken level: ${p(input.level)}`,
      `Close: ${p(input.close)}`,
      "",
      "_A structure observation only, not a trade instruction._",
    ].join("\n");
  }

  // Keyed by locale rather than `en ? a : b`, because the non-English branch is
  // two languages, not one. Same shape plain.ts uses.
  const W = {
    "zh-TW": {
      title: "結構事件", symbol: "幣種", timeframe: "時框", level: "價位", close: "收盤",
      note: "_結構事件本身不代表任何交易指令。_",
    },
    "zh-CN": {
      title: "结构事件", symbol: "币种", timeframe: "时间框", level: "价位", close: "收盘",
      note: "_结构事件本身不代表任何交易指令。_",
    },
  }[lang === "zh-CN" ? "zh-CN" : "zh-TW"];

  return [
    `【${W.title}】${kind} ${direction}`,
    "",
    `${W.symbol}：${input.symbol}`,
    `${W.timeframe}：${tf}`,
    `${W.level}：${p(input.level)}`,
    `${W.close}：${p(input.close)}`,
    "",
    W.note,
  ].join("\n");
}

// ── Health heartbeat ───────────────────────────────────────────────────────

export function formatHealthHeartbeat(input: HealthHeartbeatAlert, lang: Language = DEFAULT_LANGUAGE): string {
  const ageSec = Math.round((Date.now() - input.lastMarketDataAt) / 1000);

  if (lang === "en") {
    return [
      "[Monitor Heartbeat]",
      "",
      `Tracked symbols: ${input.activeSymbols}`,
      `Connection: ${input.wsConnected ? "connected" : "disconnected"}`,
      `Last market data: ${ageSec}s ago`,
      `Universe age: ${input.universeAgeMinutes} min`,
      `Alerts sent/failed: ${input.telegramSent}/${input.telegramFailed}`,
    ].join("\n");
  }

  // Same locale-keyed shape as formatStructure above — the non-English branch is
  // two languages, not one. 「分鐘」/「分钟」 differ, so it cannot be shared.
  const W = {
    "zh-TW": {
      title: "【監控心跳】", symbols: "監控幣數", connection: "連線狀態",
      connected: "已連線", disconnected: "未連線", lastMarket: "最後行情",
      universe: "清單更新", minutesAgo: "分鐘前", alerts: "通知發送／失敗",
    },
    "zh-CN": {
      title: "【监控心跳】", symbols: "监控币数", connection: "连线状态",
      connected: "已连接", disconnected: "未连接", lastMarket: "最后行情",
      universe: "清单更新", minutesAgo: "分钟前", alerts: "通知发送／失败",
    },
  }[lang === "zh-CN" ? "zh-CN" : "zh-TW"];

  return [
    W.title,
    "",
    `${W.symbols}：${input.activeSymbols}`,
    `${W.connection}：${input.wsConnected ? W.connected : W.disconnected}`,
    `${W.lastMarket}：${ageSec} 秒前`,
    `${W.universe}：${input.universeAgeMinutes} ${W.minutesAgo}`,
    `${W.alerts}：${input.telegramSent}／${input.telegramFailed}`,
  ].join("\n");
}
