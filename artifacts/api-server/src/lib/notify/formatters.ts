/**
 * Alert message formatting (REQUIREMENTS §15).
 *
 * Messages are in Traditional Chinese; ICT terms keep their English acronym in
 * parentheses so they line up with TradingView / course material. Two rules the
 * wording must respect:
 *
 *   - Never assert that stop orders exist. These are *potential* liquidity
 *     locations inferred from price structure — the text says so (§10).
 *   - A sweep/break is not a directional call. The text states which completed
 *     candle traded where, and stops there (§13, §7).
 *
 * Forbidden vocabulary (enforced by automated tests): 假突破 / 真突破 / 反轉 /
 * 延續 / 確認 / 做多 / 做空 / 買進 / 賣出 / 訊號 / 多頭 / 空頭 / 準備進場,
 * plus their English equivalents.
 */

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

// ── Labels ──────────────────────────────────────────────────────────────────

const SIDE_LABEL: Record<LiquiditySide, string> = {
  BSL: "買方流動性（BSL）",
  SSL: "賣方流動性（SSL）",
};

const STATE_LABEL = {
  swept: "掃過（SWEPT）",
  broken: "突破（BROKEN）",
} as const;

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

const ZONE_WORD: Record<LiquiditySide, { up: string; down: string; backUp: string; backDown: string }> = {
  BSL: { up: "向上", down: "向下", backUp: "上方", backDown: "下方" },
  SSL: { up: "向下", down: "向上", backUp: "下方", backDown: "上方" },
};

// ── Liquidity approaching ───────────────────────────────────────────────────

export function formatApproaching(a: ApproachingAlert): string {
  const zone = a.zoneLow !== undefined && a.zoneHigh !== undefined && a.zoneLow !== a.zoneHigh
    ? `${p(a.zoneLow)} – ${p(a.zoneHigh)}`
    : p(a.level);

  return [
    "【流動性接近】",
    "",
    `幣種：${a.symbol}`,
    `時框：${tfLabel(a.timeframe)}`,
    `類型：${SIDE_LABEL[a.side]}`,
    `區間：${zone}`,
    `現價：${p(a.currentPrice)}`,
    `距離：${a.distancePct.toFixed(2)}%`,
    `來源：${a.source}`,
    "",
    "_依價格結構推得的潛在流動性位置。_",
  ].join("\n");
}

// ── Liquidity swept / broken ────────────────────────────────────────────────

export function formatSweep(s: SweepAlert): string {
  const tf = tfLabel(s.timeframe);
  const state = s.broken ? STATE_LABEL.broken : STATE_LABEL.swept;
  const heading = `${tf} ${s.side} ${state}`;

  // Direction of travel is expressed relative to the level, then where the
  // completed candle settled. Facts only — no implication about what follows.
  const beyond = s.side === "BSL" ? "向上穿越" : "向下跌破";
  const settled = s.broken
    ? (s.side === "BSL" ? "收在流動性區間上方" : "收在流動性區間下方")
    : (s.side === "BSL" ? "收回流動性區間下方" : "收回流動性區間上方");

  const statement = `價格${beyond} ${s.side}，該根完成的${tf} K 線${settled}。`;
  const extremeLabel = s.side === "BSL" ? "刺破高點" : "刺破低點";

  return [
    heading,
    "",
    `幣種：${s.symbol}`,
    `價位：${p(s.level)}`,
    `${extremeLabel}：${p(s.extreme)}`,
    `收盤：${p(s.close)}`,
    "",
    statement,
  ].join("\n");
}

// ── Grouped sweep/break (several levels taken by the SAME candle) ───────────

/**
 * One message for several levels taken by the same candle.
 *
 * Why: adjacent swing highs a few ticks apart are *the same event* to a human,
 * but each is a distinct level to the engine. Announcing them separately reads
 * as spam (e.g. ENAUSDT 0.18887 and 0.18997 in the same 4H candle). Grouping
 * keeps one fact per event without discarding information — every level is
 * still listed.
 */
export function formatSweepGroup(input: {
  symbol: string;
  timeframe: string;
  side: LiquiditySide;
  levels: number[];
  extreme: number;
  close: number;
  broken: boolean;
}): string {
  const tf = tfLabel(input.timeframe);
  const state = input.broken ? STATE_LABEL.broken : STATE_LABEL.swept;
  const levels = [...new Set(input.levels)].sort((a, b) => a - b);

  const heading = levels.length > 1
    ? `${tf} ${input.side} ${state} ×${levels.length}`
    : `${tf} ${input.side} ${state}`;

  const beyond = input.side === "BSL" ? "向上穿越" : "向下跌破";
  const settled = input.broken
    ? (input.side === "BSL" ? "收在流動性區間上方" : "收在流動性區間下方")
    : (input.side === "BSL" ? "收回流動性區間下方" : "收回流動性區間上方");

  const statement = levels.length > 1
    ? `價格${beyond} ${levels.length} 條 ${input.side}，該根完成的${tf} K 線${settled}。`
    : `價格${beyond} ${input.side}，該根完成的${tf} K 線${settled}。`;

  const extremeLabel = input.side === "BSL" ? "刺破高點" : "刺破低點";
  const levelLine = levels.length > 1
    ? `價位：${levels.map((l) => p(l)).join("、")}`
    : `價位：${p(levels[0])}`;

  return [
    heading,
    "",
    `幣種：${input.symbol}`,
    levelLine,
    `${extremeLabel}：${p(input.extreme)}`,
    `收盤：${p(input.close)}`,
    "",
    statement,
  ].join("\n");
}

// ── Structure events (optional, §16) ────────────────────────────────────────

export function formatStructure(s: StructureAlert): string {
  const direction = s.direction === "bullish" ? "向上" : "向下";
  return [
    `【結構事件】${s.kind} ${direction}`,
    "",
    `幣種：${s.symbol}`,
    `時框：${tfLabel(s.timeframe)}`,
    `價位：${p(s.level)}`,
    `收盤：${p(s.close)}`,
    "",
    "_結構事件本身不代表任何交易指令。_",
  ].join("\n");
}

/** Compact heartbeat used by the health monitor (§23). */
export function formatHealthHeartbeat(input: {
  activeSymbols: number;
  wsConnected: boolean;
  lastMarketDataAt: number | null;
  universeAgeMinutes: number | null;
  telegramSent: number;
  telegramFailed: number;
}): string {
  const age = input.lastMarketDataAt
    ? `${Math.round((Date.now() - input.lastMarketDataAt) / 1000)} 秒前`
    : "無資料";
  return [
    "【監控心跳】",
    "",
    `監控幣數：${input.activeSymbols}`,
    `連線狀態：${input.wsConnected ? "已連線" : "已斷線"}`,
    `最後行情：${age}`,
    `清單更新：${input.universeAgeMinutes === null ? "尚未更新" : `${input.universeAgeMinutes} 分鐘前`}`,
    `通知發送／失敗：${input.telegramSent}／${input.telegramFailed}`,
  ].join("\n");
}
