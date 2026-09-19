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
 * ICT terms keep their English acronym in parentheses in every language so they
 * line up with TradingView and course material.
 */
import {
  stringsFor,
  uiFor,
  type Language,
  DEFAULT_LANGUAGE,
} from "./i18n.js";

export type LiquiditySide = "BSL" | "SSL";

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

/** Join list items with the separator the language actually uses. */
const listJoin = (items: string[], lang: Language): string =>
  lang === "en" ? items.join(", ") : items.join("、");

// ── Liquidity approaching ───────────────────────────────────────────────────

export function formatApproaching(a: ApproachingAlert, lang: Language = DEFAULT_LANGUAGE): string {
  const s = stringsFor(lang);
  const tf = tfLabel(a.timeframe);

  const zone = a.zoneLow !== undefined && a.zoneHigh !== undefined && a.zoneLow !== a.zoneHigh
    ? `${p(a.zoneLow)} – ${p(a.zoneHigh)}`
    : p(a.level);

  const rows = lang === "en"
    ? [
        s.approachingTitle,
        "",
        `${s.labelSymbol}: ${a.symbol}`,
        `${s.labelTimeframe}: ${tf}`,
        `${s.labelType}: ${sideLabel(a.side, lang)}`,
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
        `${s.labelType}：${sideLabel(a.side, lang)}`,
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
  const heading = `${tf} ${input.side} ${state}`;

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
  const levels = [...new Set(input.levels)].sort((a, b) => a - b);

  const heading = levels.length > 1
    ? `${tf} ${input.side} ${state} ×${levels.length}`
    : `${tf} ${input.side} ${state}`;

  const beyond = s.beyond(input.side);
  const settled = s.settled(input.side, broken);
  const statement = s.statement({
    beyond, settled, timeframe: tf, count: levels.length, side: input.side,
  });

  const extremeLabel = input.side === "BSL" ? s.labelWickHigh : s.labelWickLow;
  const levelLine = `${s.labelLevel}${lang === "en" ? ": " : "："}${listJoin(levels.map((l) => p(l)), lang)}`;

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

export interface ScanReplyInput {
  /** What was scanned, already humanised (e.g. "TRXUSDT 4H" or "all tracked symbols"). */
  scope: string;
  events: Array<{ symbol: string; timeframe: string; side: LiquiditySide; state: "SWEPT" | "BROKEN"; levels: number[] }>;
  approaches: Array<{ symbol: string; timeframes: string[]; side: LiquiditySide; price: number; distancePct: number }>;
  historySkipped: Array<{ symbol: string; timeframe: string; side: LiquiditySide; price: number }>;
  symbolCount: number;
  latestCandleTime: number;
  scanned: number;
  failures: number;
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

  if (input.events.length > 0) {
    const rows = [t.replyEventsHeading];
    for (const e of input.events) {
      const levels = [...new Set(e.levels)].sort((a, b) => a - b).map((l) => p(l)).join(listSep);
      const state = e.state === "BROKEN" ? s.stateBroken : s.stateSwept;
      rows.push(`  • ${e.symbol} ${e.timeframe.toUpperCase()} ${e.side} ${state} ${levels}`);
    }
    blocks.push(rows.join("\n"));
  } else {
    blocks.push(t.replyNoEvents);
  }

  if (input.approaches.length > 0) {
    const rows = [t.replyApproachingHeading];
    for (const a of input.approaches.slice(0, 10)) {
      const tf = a.timeframes.map((x) => x.toUpperCase()).join("+");
      rows.push(`  • ${a.symbol} ${tf} ${a.side} ${p(a.price)}${open}${a.distancePct.toFixed(2)}%${close}`);
    }
    if (input.approaches.length > 10) {
      rows.push(`  ${t.more(input.approaches.length - 10)}`);
    }
    blocks.push(rows.join("\n"));
  }

  const footer = [t.replyFooter(input.symbolCount, time)];
  if (input.failures > 0) {
    footer.push(t.replyFailed(input.failures, input.scanned));
  }
  blocks.push(footer.join("\n"));

  return blocks.join("\n\n");
  if (input.failures > 0) {
    lines.push(t.replyFailed(input.failures, input.scanned));
  }

  return lines.join("\n");
}

// ── Structure events (OB / FVG / BOS / CHoCH — optional alert types) ────────

export function formatStructure(input: StructureAlert, lang: Language = DEFAULT_LANGUAGE): string {
  const tf = tfLabel(input.timeframe);

  if (lang === "en") {
    // Deliberately NOT "bullish/bearish": those read as a market view. The event
    // describes which way an existing structure level gave way, nothing more.
    const direction = input.direction === "bullish" ? "structure shifted upward" : "structure shifted downward";
    return [
      `${tf} ${input.kind}`,
      "",
      `Symbol: ${input.symbol}`,
      `Timeframe: ${tf}`,
      `Event: ${input.kind} (${direction})`,
      `Broken level: ${p(input.level)}`,
      `Close: ${p(input.close)}`,
      "",
      "_A structure observation only, not a trade instruction._",
    ].join("\n");
  }

  const direction = input.direction === "bullish" ? "向上" : "向下";
  return [
    `【結構事件】${input.kind} ${direction}`,
    "",
    `幣種：${input.symbol}`,
    `時框：${tf}`,
    `價位：${p(input.level)}`,
    `收盤：${p(input.close)}`,
    "",
    "_結構事件本身不代表任何交易指令。_",
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

  return [
    "【監控心跳】",
    "",
    `監控幣數：${input.activeSymbols}`,
    `連線狀態：${input.wsConnected ? "已連線" : "未連線"}`,
    `最後行情：${ageSec} 秒前`,
    `清單更新：${input.universeAgeMinutes} 分鐘前`,
    `通知發送／失敗：${input.telegramSent}／${input.telegramFailed}`,
  ].join("\n");
}
