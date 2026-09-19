/**
 * Alert message strings, in the three languages the system supports.
 *
 * Why a table rather than a translation library: the alert vocabulary is small,
 * fixed, and safety-relevant. Every phrase here is deliberately descriptive, and
 * keeping all three languages side by side makes it obvious when one drifts into
 * predictive wording that the others do not use.
 *
 * Sentences that reorder between languages are functions rather than templates,
 * because Chinese and English do not assemble clauses the same way.
 */

export type Language = "zh-TW" | "zh-CN" | "en";

export const SUPPORTED_LANGUAGES: readonly Language[] = ["zh-TW", "zh-CN", "en"] as const;
export const DEFAULT_LANGUAGE: Language = "zh-TW";

export function isSupportedLanguage(value: string): value is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Accept the aliases people actually type, and normalise to a canonical tag.
 * `zh-Hant` / `zh_TW` / `tw` all mean the same thing to a user.
 */
export function normaliseLanguage(input: string): Language | null {
  const v = input.trim().toLowerCase().replace(/_/g, "-");
  if (v === "zh-tw" || v === "zh-hant" || v === "tw" || v === "zh-hk" || v === "zh-mo") return "zh-TW";
  if (v === "zh-cn" || v === "zh-hans" || v === "cn" || v === "zh" || v === "zh-sg") return "zh-CN";
  if (v === "en" || v === "en-us" || v === "en-gb") return "en";
  return null;
}

export interface AlertStrings {
  // ── approaching ──
  approachingTitle: string;
  approachingFooter: string;
  labelSymbol: string;
  labelTimeframe: string;
  labelType: string;
  labelZone: string;
  labelCurrentPrice: string;
  labelDistance: string;
  labelSource: string;

  // ── sides / states ──
  sideBsl: string;
  sideSsl: string;
  stateSwept: string;
  stateBroken: string;

  // ── sweep / broken ──
  labelLevel: string;
  labelWickHigh: string;
  labelWickLow: string;
  labelClose: string;
  /** "價格向上穿越" / "价格向上穿越" / "Price traded up through" */
  beyond: (side: "BSL" | "SSL") => string;
  /** "收在流動性區間上方" and friends. */
  settled: (side: "BSL" | "SSL", broken: boolean) => string;
  /** Assemble the closing statement for one or several levels. */
  statement: (opts: {
    beyond: string;
    settled: string;
    timeframe: string;
    count: number;
    side: "BSL" | "SSL";
  }) => string;
  /** "亦出現於 1H、4H" / "also on ..." */
  alsoOn: (timeframes: string) => string;
  /** "2 次觸及" / "2 touches" */
  touches: (n: number) => string;
  unknownSession: string;
}

const ZH_TW: AlertStrings = {
  approachingTitle: "【流動性接近】",
  approachingFooter: "_依價格結構推得的潛在流動性位置。_",
  labelSymbol: "幣種",
  labelTimeframe: "時框",
  labelType: "類型",
  labelZone: "區間",
  labelCurrentPrice: "現價",
  labelDistance: "距離",
  labelSource: "來源",

  sideBsl: "買方流動性（BSL）",
  sideSsl: "賣方流動性（SSL）",
  stateSwept: "掃過（SWEPT）",
  stateBroken: "突破（BROKEN）",

  labelLevel: "價位",
  labelWickHigh: "刺破高點",
  labelWickLow: "刺破低點",
  labelClose: "收盤",
  beyond: (side) => (side === "BSL" ? "向上穿越" : "向下跌破"),
  settled: (side, broken) => {
    if (side === "BSL") return broken ? "收在流動性區間上方" : "收回流動性區間下方";
    return broken ? "收在流動性區間下方" : "收回流動性區間上方";
  },
  statement: ({ beyond, settled, timeframe, count, side }) =>
    count > 1
      ? `價格${beyond} ${count} 條 ${side}，該根完成的${timeframe} K 線${settled}。`
      : `價格${beyond} ${side}，該根完成的${timeframe} K 線${settled}。`,
  alsoOn: (tfs) => `亦出現於 ${tfs}`,
  touches: (n) => `${n} 次觸及`,
  unknownSession: "未知時段",
};

const ZH_CN: AlertStrings = {
  approachingTitle: "【流动性接近】",
  approachingFooter: "_依价格结构推得的潜在流动性位置。_",
  labelSymbol: "币种",
  labelTimeframe: "时间框",
  labelType: "类型",
  labelZone: "区间",
  labelCurrentPrice: "现价",
  labelDistance: "距离",
  labelSource: "来源",

  sideBsl: "买方流动性（BSL）",
  sideSsl: "卖方流动性（SSL）",
  stateSwept: "扫过（SWEPT）",
  stateBroken: "突破（BROKEN）",

  labelLevel: "价位",
  labelWickHigh: "刺破高点",
  labelWickLow: "刺破低点",
  labelClose: "收盘",
  beyond: (side) => (side === "BSL" ? "向上穿越" : "向下跌破"),
  settled: (side, broken) => {
    if (side === "BSL") return broken ? "收在流动性区间上方" : "收回流动性区间下方";
    return broken ? "收在流动性区间下方" : "收回流动性区间上方";
  },
  statement: ({ beyond, settled, timeframe, count, side }) =>
    count > 1
      ? `价格${beyond} ${count} 条 ${side}，该根完成的${timeframe} K 线${settled}。`
      : `价格${beyond} ${side}，该根完成的${timeframe} K 线${settled}。`,
  alsoOn: (tfs) => `亦出现于 ${tfs}`,
  touches: (n) => `${n} 次触及`,
  unknownSession: "未知时段",
};

const EN: AlertStrings = {
  approachingTitle: "[Liquidity Approaching]",
  approachingFooter: "_A potential liquidity level derived from price structure._",
  labelSymbol: "Symbol",
  labelTimeframe: "Timeframe",
  labelType: "Type",
  labelZone: "Zone",
  labelCurrentPrice: "Price",
  labelDistance: "Distance",
  labelSource: "Source",

  sideBsl: "Buy-Side Liquidity (BSL)",
  sideSsl: "Sell-Side Liquidity (SSL)",
  stateSwept: "Swept (SWEPT)",
  stateBroken: "Broken (BROKEN)",

  labelLevel: "Level",
  labelWickHigh: "Wick high",
  labelWickLow: "Wick low",
  labelClose: "Close",
  beyond: (side) => (side === "BSL" ? "traded up through" : "traded down through"),
  settled: (side, broken) => {
    if (side === "BSL") return broken ? "closed above the liquidity zone" : "closed back below the liquidity zone";
    return broken ? "closed below the liquidity zone" : "closed back above the liquidity zone";
  },
  statement: ({ beyond, settled, timeframe, count, side }) =>
    count > 1
      ? `Price ${beyond} ${count} ${side} levels; the completed ${timeframe} candle ${settled}.`
      : `Price ${beyond} the ${side}; the completed ${timeframe} candle ${settled}.`,
  alsoOn: (tfs) => `also on ${tfs}`,
  touches: (n) => `${n} touch${n === 1 ? "" : "es"}`,
  unknownSession: "unknown session",
};

export const STRINGS: Record<Language, AlertStrings> = {
  "zh-TW": ZH_TW,
  "zh-CN": ZH_CN,
  en: EN,
};

export function stringsFor(language: Language): AlertStrings {
  return STRINGS[language] ?? STRINGS[DEFAULT_LANGUAGE];
}
