/**
 * Plain-language rendering of engine tokens.
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine's tokens (`BREAKOUT_ACCEPTED`, `BLOCKED`, `BOS`, `HL`, …) are the
 * right vocabulary for logs, JSON and cross-checking a decision later. They are
 * the WRONG vocabulary for a message a person reads on a phone. The first version
 * of the state block printed them straight through, so a recipient had to know
 * the engine to know whether the market was saying anything at all.
 *
 * So the tokens stay in the DATA and are removed from the MESSAGE. Every string
 * here is what a human reads instead. Two deliberate exceptions keep their
 * English form: `FVG` and `OB` — they are the terms actually used when talking
 * about these zones, and translating them made the message harder, not easier.
 *
 * One rule for all three languages: never print a raw token to a person.
 */
export type PlainLang = "zh-TW" | "zh-CN" | "en";

type Table = Record<string, string>;

/** BreakoutStatus → what it means for the reader. */
const BREAKOUT: Record<PlainLang, Table> = {
  // Every row states WHICH WAY, because "突破失敗" alone leaves the reader asking
  // whether price failed going up or failed going down — the two mean opposite
  // things. Rows with a fixed direction name it inline; BROKEN and
  // REVERSAL_CONFIRMED are one status used for either side, so they carry both
  // variants and the caller picks with `side`.
  "zh-TW": {
    NONE: "只是掃到，沒有突破",
    BROKEN_UP: "向上突破了，還沒站穩",
    BROKEN_DOWN: "向下跌破了，還沒站穩",
    BREAKOUT_ACCEPTED: "向上突破成立（價格站穩在上面）",
    BREAKOUT_FAILURE_WATCH: "向上突破失敗（衝上去又收回下面）",
    BREAKDOWN_ACCEPTED: "向下跌破成立（價格站穩在下面）",
    BREAKDOWN_FAILURE_WATCH: "向下跌破失敗（跌下去又收回上面）",
    REVERSAL_UP: "向上突破失敗，方向已經改變",
    REVERSAL_DOWN: "向下跌破失敗，方向已經改變",
  },
  "zh-CN": {
    NONE: "只是扫到，没有突破",
    BROKEN_UP: "向上突破了，还没站稳",
    BROKEN_DOWN: "向下跌破了，还没站稳",
    BREAKOUT_ACCEPTED: "向上突破成立（价格站稳在上面）",
    BREAKOUT_FAILURE_WATCH: "向上突破失败（冲上去又收回下面）",
    BREAKDOWN_ACCEPTED: "向下跌破成立（价格站稳在下面）",
    BREAKDOWN_FAILURE_WATCH: "向下跌破失败（跌下去又收回上面）",
    REVERSAL_UP: "向上突破失败，方向已经改变",
    REVERSAL_DOWN: "向下跌破失败，方向已经改变",
  },
  en: {
    NONE: "swept only — no breakout",
    BROKEN_UP: "broke upward, not yet decided",
    BROKEN_DOWN: "broke downward, not yet decided",
    BREAKOUT_ACCEPTED: "upward breakout held (price stayed above)",
    BREAKOUT_FAILURE_WATCH: "upward breakout failed (closed back below)",
    BREAKDOWN_ACCEPTED: "downward breakdown held (price stayed below)",
    BREAKDOWN_FAILURE_WATCH: "downward breakdown failed (closed back above)",
    REVERSAL_UP: "upward breakout failed, direction turned",
    REVERSAL_DOWN: "downward breakdown failed, direction turned",
  },
};

/** ShortStatus → the short read in words. */
const SHORT: Record<PlainLang, Table> = {
  "zh-TW": {
    NONE: "沒有可判斷的事件",
    BLOCKED: "不能看空",
    WATCH: "開始留意",
    ARMED: "等價格回踩",
    READY: "條件到位",
  },
  "zh-CN": {
    NONE: "没有可判断的事件",
    BLOCKED: "不能看空",
    WATCH: "开始留意",
    ARMED: "等价格回踩",
    READY: "条件到位",
  },
  en: {
    NONE: "nothing to judge",
    BLOCKED: "short blocked",
    WATCH: "watch",
    ARMED: "waiting for the pullback",
    READY: "conditions met",
  },
};

/** LiquidityInteraction → what price did. */
const INTERACTION: Record<PlainLang, Table> = {
  "zh-TW": { NONE: "沒動靜", TOUCHED: "碰到過", SWEPT: "只是掃到", BROKEN: "突破了" },
  "zh-CN": { NONE: "没动静", TOUCHED: "碰到过", SWEPT: "只是扫到", BROKEN: "突破了" },
  en: { NONE: "untouched", TOUCHED: "touched", SWEPT: "swept", BROKEN: "broken" },
};

const SIDE: Record<PlainLang, Table> = {
  "zh-TW": { BSL: "上方", SSL: "下方" },
  "zh-CN": { BSL: "上方", SSL: "下方" },
  en: { BSL: "above", SSL: "below" },
};

/** Structure events. The engine's own names are CHoCH / BOS. */
const STRUCTURE_KIND: Record<PlainLang, Table> = {
  "zh-TW": { BOS: "原趨勢持續", CHoCH: "原趨勢改變" },
  "zh-CN": { BOS: "原趋势持续", CHoCH: "原趋势改变" },
  en: { BOS: "prior trend carried on", CHoCH: "prior trend gave way" },
};

const DIRECTION: Record<PlainLang, Table> = {
  "zh-TW": { bullish: "翻多", bearish: "翻空" },
  "zh-CN": { bullish: "翻多", bearish: "翻空" },
  en: { bullish: "upward", bearish: "downward" },
};

const SWING: Record<PlainLang, Table> = {
  "zh-TW": { HH: "更高的高點", HL: "更高的低點", LH: "更低的高點", LL: "更低的低點" },
  "zh-CN": { HH: "更高的高点", HL: "更高的低点", LH: "更低的高点", LL: "更低的低点" },
  en: { HH: "higher high", HL: "higher low", LH: "lower high", LL: "lower low" },
};

const pick = (t: Record<PlainLang, Table>, lang: PlainLang, key: string, fallback: string): string =>
  t[lang]?.[key] ?? t.en[key] ?? fallback;

/**
 * A UNIX-second stamp on the reader's clock, chosen by the message language:
 * UTC+8 for both Chinese scripts (Taiwan and Beijing share it, neither has DST),
 * New York via Intl for English so daylight saving is handled rather than assumed.
 */
export function localStamp(sec: number, lang: PlainLang): string {
  const z = (n: number) => String(n).padStart(2, "0");
  if (lang === "en") {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(sec * 1000));
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hh = g("hour") === "24" ? "00" : g("hour");
    return `${g("month")}-${g("day")} ${hh}:${g("minute")}`;
  }
  const d = new Date(sec * 1000 + 8 * 3600 * 1000);
  return `${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`;
}

/** The zone as that language names it — shown beside every converted time. */
export function zoneName(lang: PlainLang): string {
  return lang === "en" ? "ET" : lang === "zh-CN" ? "北京" : "台灣";
}

export const plainBreakout = (
  status: string,
  lang: PlainLang,
  side: "up" | "down" = "up",
): string => {
  // BROKEN and REVERSAL_CONFIRMED are shared by both sides, so the side decides the
  // wording. Passing it explicitly beats reading the level's position: after a take
  // the level sits on the other side of price, which is exactly the confusion being
  // fixed here.
  const key =
    status === "BROKEN" ? (side === "up" ? "BROKEN_UP" : "BROKEN_DOWN")
    : status === "REVERSAL_CONFIRMED" ? (side === "up" ? "REVERSAL_UP" : "REVERSAL_DOWN")
    : status;
  return pick(BREAKOUT, lang, key, status);
};
export const plainShort = (status: string, lang: PlainLang): string =>
  pick(SHORT, lang, status, status);
export const plainInteraction = (i: string, lang: PlainLang): string =>
  pick(INTERACTION, lang, i, i);
export const plainSide = (s: string, lang: PlainLang): string =>
  pick(SIDE, lang, s, s);
export const plainStructureKind = (k: string, lang: PlainLang): string =>
  pick(STRUCTURE_KIND, lang, k, k);
export const plainDirection = (d: string, lang: PlainLang): string =>
  pick(DIRECTION, lang, d, d);
export const plainSwing = (l: string, lang: PlainLang): string =>
  pick(SWING, lang, l, l);

/**
 * The one-line answer the reader wants first: can I act, or not?
 *
 * Derived from the buy side first (it is the side a short read depends on), then
 * the sell side. Returns null when there is nothing to conclude, so the caller
 * can omit the line rather than print a vacuous one.
 */
export function plainConclusion(
  bsl: { status: string } | null,
  ssl: { status: string } | null,
  protectedLowBroken: boolean,
  shortStatus: string,
  lang: PlainLang,
  mssDirection?: string | null,
  mssSettled?: boolean,
): string | null {
  const accepted = (s: string | undefined) =>
    s === "BREAKOUT_ACCEPTED" || s === "BREAKDOWN_ACCEPTED";
  const failed = (s: string | undefined) =>
    s === "BREAKOUT_FAILURE_WATCH" || s === "BREAKDOWN_FAILURE_WATCH" || s === "REVERSAL_CONFIRMED";

  // Every branch below ends with the short-read. When that read is "nothing to
  // judge" the suffix is dropped: "weakening (defence line gave way) — nothing to
  // judge" states a finding and then denies one, in the same line.
  const tail: string = shortStatus === "NONE" ? "" : ` —— ${plainShort(shortStatus, lang)}`;

  // Why the picture is weakening, when it is. One list, so the sentence reads as
  // a reason rather than as two contradictory claims side by side.
  const weakenings: string[] = [];
  if (protectedLowBroken) {
    weakenings.push({ "zh-TW": "防守線失守", "zh-CN": "防守线失守", en: "defence line gave way" }[lang]);
    // Only a structure that turned AGAINST the breakout belongs in a list of
    // reasons it is weakening. A bullish structure alongside a broken defence line
    // is a mixed picture, not a weakening one — listing it here produced
    // "weakening (defence line gave way, structure turned up)", which reads as a
    // contradiction. The structure is already stated on its own line below.
    // Only a structure that has actually SETTLED can be cited as a reason. Citing
    // the direction regardless of confirmation produced "weakening (... structure
    // turned down)" directly above a line reading "structure: turned down (not
    // settled yet)" — the message contradicted itself two lines apart.
    if (mssSettled === true && mssDirection === "bearish") {
      weakenings.push({ "zh-TW": "結構翻空", "zh-CN": "结构翻空", en: "structure turned down" }[lang]);
    }
  }
  const why = weakenings.length > 0 ? `（${weakenings.join("、")}）` : "";
  const guarded = weakenings.length > 0
    ? { "zh-TW": "，但已轉弱", "zh-CN": "，但已转弱", en: ", but it is weakening" }[lang]
    : "";

  // The conclusion is the most-read line, so it names the direction too. "突破失敗"
  // alone left the reader asking whether price failed going up or going down — two
  // opposite situations described by the same words.
  if (bsl && failed(bsl.status)) {
    return {
      "zh-TW": `向上突破失敗${guarded}${why}${tail}`,
      "zh-CN": `向上突破失败${guarded}${why}${tail}`,
      en: `upward breakout failed${guarded}${why}${tail}`,
    }[lang];
  }
  // Mirror for the sell side. Without it a failed breakdown fell through to the
  // generic "nothing to judge" branch and the direction was lost entirely.
  if (ssl && failed(ssl.status)) {
    return {
      "zh-TW": `向下跌破失敗${guarded}${why}${tail}`,
      "zh-CN": `向下跌破失败${guarded}${why}${tail}`,
      en: `downward breakdown failed${guarded}${why}${tail}`,
    }[lang];
  }
  if (bsl && accepted(bsl.status)) {
    // Still holding the breakout, so the honest statement is "not defeated yet" —
    // but a defence line that has given way is a real change and the reader is told
    // it, instead of being told "buyers are in control" and left to notice the
    // contradiction two lines down.
    return weakenings.length > 0
      ? {
          "zh-TW": `多方還守著突破，但已轉弱${why} —— 現在還不能動作`,
          "zh-CN": `多方还守着突破，但已转弱${why} —— 现在还不能动作`,
          en: `buyers still hold the breakout, but it is weakening${why} — nothing to act on yet`,
        }[lang]
      : {
          "zh-TW": "多方還佔上風 —— 現在不能看空",
          "zh-CN": "多方还占上风 —— 现在不能看空",
          en: "buyers still in control — no short case yet",
        }[lang];
  }
  if (ssl && accepted(ssl.status)) {
    return {
      "zh-TW": "空方還佔上風 —— 現在不能看多",
      "zh-CN": "空方还占上风 —— 现在不能看多",
      en: "sellers still in control — no long case yet",
    }[lang];
  }

  // Everything else — a sweep with no close beyond, or nothing taken on either
  // side. There is still an answer worth giving ("nothing to judge yet"), and
  // omitting the line made some blocks start with a bullet while others started
  // with a conclusion, which reads as if something were missing.
  const taken = bsl ?? ssl;
  if (taken) {
    return {
      "zh-TW": `只是掃到，還沒有收盤突破${tail}`,
      "zh-CN": `只是扫到，还没有收盘突破${tail}`,
      en: `swept only, no close beyond yet${tail}`,
    }[lang];
  }
  return {
    "zh-TW": "這個時框沒有可判斷的事件",
    "zh-CN": "这个时间框没有可判断的事件",
    en: "nothing to judge on this timeframe",
  }[lang];
}

/** Fixed labels for the state block. Kept beside the token maps so one file owns
 *  every word a reader sees in that block. */
export function plainLabels(lang: PlainLang) {
  return {
    "zh-TW": {
      conclusion: "▸ 結論",
      facts: "其他事件",
      defenceLine: "多方防守線",
      structure: "結構",
      shortRead: "空方判讀",
      intact: "還守著",
      broken: "⚠️ 已被收盤跌破",
      dirUp: "翻多",
      dirDown: "翻空",
      mssConfirmed: "收盤已成立",
      mssPending: "還沒成立",
      disclaimer: "（描述現況，不是買賣指令）",
      above: "上方",
      below: "下方",
    },
    "zh-CN": {
      conclusion: "▸ 结论",
      facts: "其他事件",
      defenceLine: "多方防守线",
      structure: "结构",
      shortRead: "空方判读",
      intact: "还守着",
      broken: "⚠️ 已被收盘跌破",
      dirUp: "翻多",
      dirDown: "翻空",
      mssConfirmed: "收盘已成立",
      mssPending: "还没成立",
      disclaimer: "（描述现况，不是买卖指令）",
      above: "上方",
      below: "下方",
    },
    en: {
      conclusion: "▸ Conclusion",
      facts: "Other events",
      defenceLine: "Bullish defence line",
      structure: "Structure",
      shortRead: "Short",
      intact: "still holding",
      broken: "⚠️ closed through",
      dirUp: "upward",
      dirDown: "downward",
      mssConfirmed: "settled on a close",
      mssPending: "not settled yet",
      disclaimer: "(describes the present — not a trade instruction)",
      above: "Above",
      below: "Below",
    },
  }[lang];
}

/**
 * Rewrite the engine's fact lines in plain words.
 *
 * The engine emits facts as `<SIDE> <price> <INTERACTION>` and
 * `MSS <direction> at <time>`. That grammar is stable, so it is translated here
 * rather than by rebuilding the facts from scratch — the strings are the only
 * form the reply carries. Anything that does not match is passed through
 * untouched, so a new fact shape shows up verbatim instead of vanishing.
 */
/**
 * "2026-09-18 12:00" (UTC, as the engine stamps it) → the reader's own clock, with
 * the zone named: 台灣 for 繁中, 北京 for 簡中, New York (ET) for English.
 *
 * The zone follows the MESSAGE language, not the market: a reader told times in a
 * zone they do not live in has to convert every one of them by hand. Returns the
 * input untouched when it is not that exact shape, so an unexpected stamp shows the
 * raw value rather than a wrong one.
 */
function shiftUtcStampToLocal(stamp: string, lang: PlainLang): string {
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return stamp;
  const sec = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
  const s = localStamp(sec, lang);
  return lang === "en" ? `${s} ET` : lang === "zh-CN" ? `${s}（北京）` : `${s}（台灣）`;
}

export function plainFacts(facts: string[], lang: PlainLang, lastClose?: number): string[] {
  const l = plainLabels(lang);
  return facts.map((f) => {
    const mss = f.match(/^MSS\s+(bullish|bearish)\s+at\s+(.+)$/);
    if (mss) {
      const dir = plainDirection(mss[1], lang);
      // The engine stamps this one in UTC while every other time in the block is
      // Taiwan time, so the same message showed two clocks ("20:00" and
      // "2026-09-18 12:00" side by side). Shift it to match its neighbours.
      const when = shiftUtcStampToLocal(mss[2], lang);
      if (lang === "en") return `structure ${dir} (${when})`;
      // The word for "structure" differs between the two Chinese scripts — this
      // was hardcoded to the traditional form, so the simplified message carried
      // a traditional character. Caught by rendering the block end to end.
      const word = lang === "zh-CN" ? "结构" : "結構";
      return `${word}${dir}（${when}）`;
    }
    const lv = f.match(/^(BSL|SSL)\s+([0-9.]+)\s+(NONE|TOUCHED|SWEPT|BROKEN)$/);
    if (lv) {
      // Position relative to the CURRENT price, same rule as the level rows above —
      // otherwise the same level is called "above" in one line and "below" three
      // lines later, inside one message.
      const price = Number(lv[2]);
      const fallback = lv[1] === "BSL" ? l.above : l.below;
      const side = lastClose && price ? (price > lastClose ? l.above : l.below) : fallback;
      return lang === "en"
        ? `${side} ${lv[2]} ${plainInteraction(lv[3], lang)}`
        : `${side} ${lv[2]}：${plainInteraction(lv[3], lang)}`;
    }
    return f;
  });
}

/** The bits of a state block that decide whether it is worth a line at all. */
export interface StateShape {
  breakoutBsl: { status: string } | null;
  breakoutSsl: { status: string } | null;
  protectedLowBroken: boolean;
  mssConfirmed: boolean;
}

/** A side state that says more than "it was taken". */
const decided = (s: { status: string } | null): boolean =>
  s !== null && s.status !== "NONE";

/**
 * Is this block worth sending?
 *
 * A state block whose only content is "swept, no breakout" repeats what the event
 * list above already said. Measured on a live scan: 84 blocks were produced, and a
 * large share of them were exactly that — so the display cap kept hiding the
 * blocks that actually carried a decision. Filtering here is what lets the cap
 * matter less.
 */
export function stateWorthReporting(st: StateShape): boolean {
  return decided(st.breakoutBsl) || decided(st.breakoutSsl)
    || st.protectedLowBroken || st.mssConfirmed;
}

/**
 * How much a reader should care, highest first.
 *
 * The cap used to take the first N in SCAN order — which symbol happened to be
 * iterated first — so what got shown was luck rather than significance. This
 * ranks by how much has actually changed: a failed breakout (a reversal setup
 * forming) outranks a clean one, and an accepted breakout that has since lost its
 * defence line outranks one that has not.
 */
export function stateImportance(st: StateShape): number {
  const s = (x: { status: string } | null) => x?.status ?? "";
  let score = 0;

  if (s(st.breakoutBsl) === "BREAKOUT_FAILURE_WATCH" || s(st.breakoutBsl) === "REVERSAL_CONFIRMED") {
    score += 100;                       // the thing the layer exists to catch
  } else if (s(st.breakoutBsl) === "BREAKOUT_ACCEPTED") {
    score += st.protectedLowBroken ? 80 : 60;
  } else if (s(st.breakoutBsl) === "BROKEN") {
    score += 40;
  }

  if (s(st.breakoutSsl) === "BREAKDOWN_FAILURE_WATCH" || s(st.breakoutSsl) === "REVERSAL_CONFIRMED") {
    score += 95;
  } else if (s(st.breakoutSsl) === "BREAKDOWN_ACCEPTED") {
    score += 55;
  } else if (s(st.breakoutSsl) === "BROKEN") {
    score += 35;
  }

  if (st.mssConfirmed) score += 10;
  return score;
}
