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

// ── Interface text ──────────────────────────────────────────────────────────
//
// Alert bodies are only half of what a user reads. Command replies and scan
// summaries are the other half, and leaving those hard-coded in one language
// means switching the setting produces a half-translated conversation.

export interface UiStrings {
  // scan summary
  dedupLoaded: (events: number, levels: number) => string;
  explicitSymbols: (list: string) => string;
  universeLoaded: (count: number, eligible: number) => string;
  scanDone: (pairs: number, failures: number) => string;
  trackedSymbols: (n: number) => string;
  latestClosedCandle: (when: string) => string;
  eventsHeading: (n: number) => string;
  historyHeading: (n: number) => string;
  approachesHeading: (n: number) => string;
  pendingHeading: (n: number) => string;
  none: string;
  more: (n: number) => string;
  dryRunNote: string;
  sentCount: (n: number) => string;
  sentWithFailures: (n: number, failed: number) => string;
  reasonCooldown: string;
  reasonAlreadySent: string;
  sameArea: string;
  wasOn: string;

  // command replies
  helpText: string;
  scanning: (scope: string) => string;
  botStarted: string;
  unknownLanguage: (value: string, supported: string) => string;
  languageSwitched: (code: string, label: string) => string;
  languagePinned: (code: string, envLang: string) => string;
  languageLine: (code: string, label: string) => string;
  languageOriginEnv: string;
  languageOriginUser: string;
  languageOriginConfig: string;
  switchWays: string;
  modeReportActive: string;
  modeReportPassive: string;
  analysisTimeframes: string;
  alertLanguage: string;
  modeSwitchHow: string;

  // ── User-facing scan reply ──
  // Deliberately separate from the operator-facing summary: a user asking
  // "is anything happening?" needs an answer, not a run log.
  replyTitle: string;
  replyScopeAll: string;
  replyNoEvents: string;
  replyEventsHeading: string;
  replyHistoryHeading: string;
  replyApproachingHeading: string;
  replyFooter: (symbols: number, candle: string) => string;
  replyFailed: (failed: number, pairs: number) => string;

  // ── Single-symbol snapshot ──
  // Shown when the user asks about one symbol: the standing picture rather than
  // a list of new events.
  snapCurrent: string;
  snapAbove: string;
  snapBelow: string;
  snapTaken: string;
  snapUntaken: string;
  snapTouched: string;
  snapDistance: (pct: number) => string;
  snapNone: string;
  snapTakenHeading: string;
}

const UI_ZH_TW: UiStrings = {
  dedupLoaded: (e, l) => `已載入去重狀態：${e} 筆事件、${l} 個價位`,
  explicitSymbols: (list) => `使用指定幣種：${list}`,
  universeLoaded: (c, e) => `監控清單：${c} 個幣（${e} 個通過流動性門檻）`,
  scanDone: (p, f) => `掃描完成：${p} 組（幣×時框），失敗 ${f} 組`,
  trackedSymbols: (n) => `追蹤幣種：${n} 個`,
  latestClosedCandle: (w) => `最新一根已收盤的 K 線：${w}（台灣時間）`,
  eventsHeading: (n) => `【剛發生的事件】${n} 則（已把同一根 K 線的多個價位合併）`,
  historyHeading: (n) => `【同區域已處理過，不再重複報】${n} 筆`,
  approachesHeading: (n) => `【接近中】${n} 則（已合併跨時框重複）`,
  pendingHeading: (n) => `=== 通過去重／冷卻、待發送：${n} 則 ===`,
  none: "無。",
  more: (n) => `…其餘 ${n} 筆`,
  dryRunNote: "（演練模式：加上 --send 才會實際發送）",
  sentCount: (n) => `共發送 ${n} 則`,
  sentWithFailures: (n, f) => `共發送 ${n} 則，失敗 ${f} 則`,
  reasonCooldown: "冷卻中",
  reasonAlreadySent: "已通知過",
  sameArea: "同區域",
  wasOn: "已於",

  helpText: `【流動性獵人 — 指令】

/scan — 掃描全部（目前追蹤的幣）
/scan BTCUSDT — 只掃這個幣
/scan BTCUSDT 1h — 只掃這個幣的這個時框
/events — 看現在有什麼（不重新掃描）
/status — 系統狀態
/mode — 目前的監控模式
/language — 查詢通知語言
/language zh-TW — 切換為繁體中文
/language zh-CN — 切換為簡體中文
/language en — 切換為英文
/help — 這個說明

監控模式：
  PASSIVE（預設）— 你下指令才動作，不會主動通知
  ACTIVE — 背景持續監控，有新事件會主動通知

ACTIVE 必須由使用者明確開啟，不會自動啟動。`,

  scanning: (scope) => `🔍 開始掃描 ${scope}…`,
  botStarted: "🟢 流動性獵人被動模式已啟動。\n輸入 /help 看指令。",
  unknownLanguage: (v, s) => `無法辨識的語言：「${v}」\n\n支援：${s}\n（也接受 zh_Hant、cn、en-US 等常見寫法）`,
  languageSwitched: (c, l) => `✅ 通知語言已切換為 ${c}（${l}）\n\n下一則通知即生效，不需要重啟。`,
  languagePinned: (c, e) => `已記錄為 ${c}，但環境變數 NOTIFICATION_LANGUAGE=${e} 的優先序更高。\n\n實際發送的通知仍會是環境變數指定的語言。\n要真正切換，請調整環境變數後重啟服務。`,
  languageLine: (c, l) => `Language: ${c}（${l}）`,
  languageOriginEnv: "由環境變數 NOTIFICATION_LANGUAGE 指定",
  languageOriginUser: "由你在此設定的",
  languageOriginConfig: "由 config.yaml 的預設值",
  switchWays: "切換方式：\n/language zh-TW — 繁體中文\n/language zh-CN — 简体中文\n/language en — English",
  modeReportActive: "背景持續監控中，有新事件會主動通知。",
  modeReportPassive: "只在你下指令時掃描，不會主動通知。",
  analysisTimeframes: "分析時框",
  alertLanguage: "通知語言",
  modeSwitchHow: "要切換模式：修改 config.yaml 的 monitoring.mode，或設定環境變數\nMONITORING_MODE=active / passive，然後重啟服務。",

  replyTitle: "掃描完成",
  replyScopeAll: "全部追蹤幣種",
  replyNoEvents: "目前沒有事件。",
  replyEventsHeading: "目前的事件：",
  replyHistoryHeading: "這個價位近期已處理過，不重複報：",
  replyApproachingHeading: "接近中：",
  replyFooter: (s, c) => `追蹤 ${s} 個幣｜最新 K 線 ${c}`,
  replyFailed: (f, p) => `（其中 ${f}／${p} 組讀取失敗）`,

  snapCurrent: "現價",
  snapAbove: "上方流動性（BSL）",
  snapBelow: "下方流動性（SSL）",
  snapTaken: "已取走",
  snapUntaken: "未觸及",
  snapTouched: "已觸及",
  snapDistance: (p) => `距 ${p.toFixed(2)}%`,
  snapNone: "（無）",
  snapTakenHeading: "近期已取走：",
};

const UI_ZH_CN: UiStrings = {
  dedupLoaded: (e, l) => `已载入去重状态：${e} 笔事件、${l} 个价位`,
  explicitSymbols: (list) => `使用指定币种：${list}`,
  universeLoaded: (c, e) => `监控清单：${c} 个币（${e} 个通过流动性门槛）`,
  scanDone: (p, f) => `扫描完成：${p} 组（币×时间框），失败 ${f} 组`,
  trackedSymbols: (n) => `追踪币种：${n} 个`,
  latestClosedCandle: (w) => `最新一根已收盘的 K 线：${w}（台湾时间）`,
  eventsHeading: (n) => `【刚发生的事件】${n} 则（已把同一根 K 线的多个价位合并）`,
  historyHeading: (n) => `【同区域已处理过，不再重复报】${n} 笔`,
  approachesHeading: (n) => `【接近中】${n} 则（已合并跨时间框重复）`,
  pendingHeading: (n) => `=== 通过去重／冷却、待发送：${n} 则 ===`,
  none: "无。",
  more: (n) => `…其余 ${n} 笔`,
  dryRunNote: "（演练模式：加上 --send 才会实际发送）",
  sentCount: (n) => `共发送 ${n} 则`,
  sentWithFailures: (n, f) => `共发送 ${n} 则，失败 ${f} 则`,
  reasonCooldown: "冷却中",
  reasonAlreadySent: "已通知过",
  sameArea: "同区域",
  wasOn: "已于",

  helpText: `【流动性猎人 — 指令】

/scan — 扫描全部（目前追踪的币）
/scan BTCUSDT — 只扫这个币
/scan BTCUSDT 1h — 只扫这个币的这个时间框
/events — 看现在有什么（不重新扫描）
/status — 系统状态
/mode — 目前的监控模式
/language — 查询通知语言
/language zh-TW — 切换为繁体中文
/language zh-CN — 切换为简体中文
/language en — 切换为英文
/help — 这个说明

监控模式：
  PASSIVE（预设）— 你下指令才动作，不会主动通知
  ACTIVE — 背景持续监控，有新事件会主动通知

ACTIVE 必须由使用者明确开启，不会自动启动。`,

  scanning: (scope) => `🔍 开始扫描 ${scope}…`,
  botStarted: "🟢 流动性猎人被动模式已启动。\n输入 /help 看指令。",
  unknownLanguage: (v, s) => `无法辨识的语言：「${v}」\n\n支援：${s}\n（也接受 zh_Hant、cn、en-US 等常见写法）`,
  languageSwitched: (c, l) => `✅ 通知语言已切换为 ${c}（${l}）\n\n下一则通知即生效，不需要重启。`,
  languagePinned: (c, e) => `已记录为 ${c}，但环境变数 NOTIFICATION_LANGUAGE=${e} 的优先序更高。\n\n实际发送的通知仍会是环境变数指定的语言。\n要真正切换，请调整环境变数后重启服务。`,
  languageLine: (c, l) => `Language: ${c}（${l}）`,
  languageOriginEnv: "由环境变数 NOTIFICATION_LANGUAGE 指定",
  languageOriginUser: "由你在此设定的",
  languageOriginConfig: "由 config.yaml 的预设值",
  switchWays: "切换方式：\n/language zh-TW — 繁體中文\n/language zh-CN — 简体中文\n/language en — English",
  modeReportActive: "背景持续监控中，有新事件会主动通知。",
  modeReportPassive: "只在你下指令时扫描，不会主动通知。",
  analysisTimeframes: "分析时间框",
  alertLanguage: "通知语言",
  modeSwitchHow: "要切换模式：修改 config.yaml 的 monitoring.mode，或设定环境变数\nMONITORING_MODE=active / passive，然后重启服务。",

  replyTitle: "扫描完成",
  replyScopeAll: "全部追踪币种",
  replyNoEvents: "目前没有事件。",
  replyEventsHeading: "目前的事件：",
  replyHistoryHeading: "这个价位近期已处理过，不重复报：",
  replyApproachingHeading: "接近中：",
  replyFooter: (s, c) => `追踪 ${s} 个币｜最新 K 线 ${c}`,
  replyFailed: (f, p) => `（其中 ${f}／${p} 组读取失败）`,

  snapCurrent: "现价",
  snapAbove: "上方流动性（BSL）",
  snapBelow: "下方流动性（SSL）",
  snapTaken: "已取走",
  snapUntaken: "未触及",
  snapTouched: "已触及",
  snapDistance: (p) => `距 ${p.toFixed(2)}%`,
  snapNone: "（无）",
  snapTakenHeading: "近期已取走：",
};

const UI_EN: UiStrings = {
  dedupLoaded: (e, l) => `Dedup state loaded: ${e} events, ${l} levels`,
  explicitSymbols: (list) => `Using specified symbols: ${list}`,
  universeLoaded: (c, e) => `Universe: ${c} symbols (${e} cleared the liquidity floors)`,
  scanDone: (p, f) => `Scan complete: ${p} symbol/timeframe pairs, ${f} failed`,
  trackedSymbols: (n) => `Tracked symbols: ${n}`,
  latestClosedCandle: (w) => `Latest closed candle: ${w} (Taipei time)`,
  eventsHeading: (n) => `[Events just triggered] ${n} (levels settled by the same candle are merged)`,
  historyHeading: (n) => `[Same area already handled — not repeated] ${n}`,
  approachesHeading: (n) => `[Approaching] ${n} (cross-timeframe duplicates merged)`,
  pendingHeading: (n) => `=== Passed dedup/cooldown, ready to send: ${n} ===`,
  none: "None.",
  more: (n) => `…${n} more`,
  dryRunNote: "(dry run: add --send to actually transmit)",
  sentCount: (n) => `Sent ${n}`,
  sentWithFailures: (n, f) => `Sent ${n}, ${f} failed`,
  reasonCooldown: "in cooldown",
  reasonAlreadySent: "already notified",
  sameArea: "same area",
  wasOn: "on",

  helpText: `[Liquidity Hunter — Commands]

/scan — scan everything currently tracked
/scan BTCUSDT — scan one symbol
/scan BTCUSDT 1h — scan one symbol on one timeframe
/events — show what is live now (no re-scan)
/status — system state
/mode — current monitoring mode
/language — show the alert language
/language zh-TW — switch to Traditional Chinese
/language zh-CN — switch to Simplified Chinese
/language en — switch to English
/help — this message

Monitoring modes:
  PASSIVE (default) — acts only when you ask; no unsolicited alerts
  ACTIVE — runs in the background and pushes alerts on new events

ACTIVE must be enabled explicitly. It never starts on its own.`,

  scanning: (scope) => `🔍 Scanning ${scope}…`,
  botStarted: "🟢 Liquidity Hunter passive mode is running.\nSend /help for commands.",
  unknownLanguage: (v, s) => `Unrecognised language: "${v}"\n\nSupported: ${s}\n(zh_Hant, cn, en-US and similar spellings are also accepted)`,
  languageSwitched: (c, l) => `✅ Alert language switched to ${c} (${l})\n\nTakes effect on the next alert. No restart needed.`,
  languagePinned: (c, e) => `Recorded as ${c}, but the NOTIFICATION_LANGUAGE=${e} environment variable takes precedence.\n\nAlerts will still be sent in the environment's language.\nChange the environment variable and restart to switch for real.`,
  languageLine: (c, l) => `Language: ${c} (${l})`,
  languageOriginEnv: "set by the NOTIFICATION_LANGUAGE environment variable",
  languageOriginUser: "set by you here",
  languageOriginConfig: "the default from config.yaml",
  switchWays: "Switch with:\n/language zh-TW — Traditional Chinese\n/language zh-CN — Simplified Chinese\n/language en — English",
  modeReportActive: "Monitoring in the background; new events are pushed.",
  modeReportPassive: "Scans only when you ask. Nothing is pushed.",
  analysisTimeframes: "Timeframes",
  alertLanguage: "Alert language",
  modeSwitchHow: "To switch: set monitoring.mode in config.yaml, or set the environment\nvariable MONITORING_MODE=active / passive, then restart the service.",

  replyTitle: "Scan complete",
  replyScopeAll: "all tracked symbols",
  replyNoEvents: "No events right now.",
  replyEventsHeading: "Current events:",
  replyHistoryHeading: "Already handled in this area recently (not repeated):",
  replyApproachingHeading: "Approaching:",
  replyFooter: (s, c) => `Tracking ${s} symbols | Latest candle ${c}`,
  replyFailed: (f, p) => `(${f} of ${p} pairs failed to load)`,

  snapCurrent: "Price",
  snapAbove: "Liquidity above (BSL)",
  snapBelow: "Liquidity below (SSL)",
  snapTaken: "taken",
  snapUntaken: "untaken",
  snapTouched: "touched",
  snapDistance: (p) => `${p.toFixed(2)}% away`,
  snapNone: "(none)",
  snapTakenHeading: "Recently taken:",
};

export const UI: Record<Language, UiStrings> = {
  "zh-TW": UI_ZH_TW,
  "zh-CN": UI_ZH_CN,
  en: UI_EN,
};

export function uiFor(language: Language): UiStrings {
  return UI[language] ?? UI[DEFAULT_LANGUAGE];
}

export function stringsFor(language: Language): AlertStrings {
  return STRINGS[language] ?? STRINGS[DEFAULT_LANGUAGE];
}

/** Key under which a user-selected language is stored in the key-value store. */
export const LANGUAGE_OVERRIDE_KEY = "notification_language";

/**
 * Decide which language to actually use.
 *
 * Precedence, highest first:
 *   1. NOTIFICATION_LANGUAGE environment variable — deployment-level, and the
 *      operator running the process should win over a chat command.
 *   2. A language the user picked at runtime with /language, stored in the
 *      key-value store so it survives restarts.
 *   3. `notifications.language` from config.yaml — the installed default.
 *
 * `readOverride` is injected rather than imported so this module stays free of
 * persistence dependencies and can be unit-tested without a database.
 */
export function resolveLanguage(
  configLanguage: Language,
  readOverride: () => string | null,
): { language: Language; source: "env" | "user" | "config" } {
  const envRaw = process.env.NOTIFICATION_LANGUAGE?.trim();
  if (envRaw) {
    const envLang = normaliseLanguage(envRaw);
    if (envLang) return { language: envLang, source: "env" };
  }

  const stored = readOverride();
  if (stored) {
    const userLang = normaliseLanguage(stored);
    if (userLang) return { language: userLang, source: "user" };
  }

  return { language: configLanguage, source: "config" };
}
