/**
 * What gets reported, in what order, and how a long message survives the API.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three separate problems showed up on one live scan:
 *
 *   1. 84 state blocks were produced, but the display cap was 5 — and it took the
 *      first five in SCAN order, so what a reader saw was whichever symbols
 *      happened to be iterated first.
 *   2. Most of those 84 said only "swept, no breakout", which the event list
 *      above had already reported. Repeating it pushed the real findings out.
 *   3. Nothing guarded the 4096-character API limit, so simply raising the cap
 *      would have made the whole report fail to send rather than shorten it.
 *
 * Run: npx tsx artifacts/api-server/src/lib/notify/plain.test.ts
 */
import { stateWorthReporting, stateImportance } from "./plain.js";
import { splitForTelegram } from "./TelegramNotifier.js";
import { formatMarketStateBlock } from "./formatters.js";
import { plainBreakout, plainConclusion, localStamp } from "./plain.js";
import { formatScanReply } from "./formatters.js";

let passed = 0;
let failed = 0;
const section = (t: string) => { console.log(""); console.log(`── ${t}`); };
const eq = (a: unknown, b: unknown, what: string) => {
  if (Object.is(a, b)) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}\n         expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
};
const ok = (c: boolean, what: string) => {
  if (c) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}`); }
};

const st = (o: Partial<{ bsl: string | null; ssl: string | null; low: boolean; mss: boolean }>) => ({
  breakoutBsl: o.bsl === undefined || o.bsl === null ? null : { status: o.bsl },
  breakoutSsl: o.ssl === undefined || o.ssl === null ? null : { status: o.ssl },
  protectedLowBroken: o.low ?? false,
  mssConfirmed: o.mss ?? false,
});

// ───────────────────────────────────────────────────────────────────────────
section("1 只重複事件清單的區塊不報（濾掉「只是掃到」）");
{
  eq(stateWorthReporting(st({ bsl: "NONE" })), false, "純掃過 → 不報（事件清單已報過）");
  eq(stateWorthReporting(st({ bsl: "NONE", ssl: "NONE" })), false, "兩側都只是掃到 → 不報");
  eq(stateWorthReporting(st({})), false, "什麼都沒有 → 不報");

  eq(stateWorthReporting(st({ bsl: "BREAKOUT_ACCEPTED" })), true, "突破成立 → 報");
  eq(stateWorthReporting(st({ bsl: "BREAKOUT_FAILURE_WATCH" })), true, "突破失敗 → 報");
  eq(stateWorthReporting(st({ bsl: "BROKEN" })), true, "突破了還沒站穩 → 報");
  eq(stateWorthReporting(st({ bsl: "NONE", low: true })), true,
    "只掃到但防守線失守 → 報（有資訊）");
  eq(stateWorthReporting(st({ bsl: "NONE", mss: true })), true,
    "只掃到但結構已成立 → 報（有資訊）");
  eq(stateWorthReporting(st({ bsl: "NONE", ssl: "BREAKDOWN_ACCEPTED" })), true, "賣方側成立 → 報");
}

// ───────────────────────────────────────────────────────────────────────────
section("2 依輕重排序，不是依掃描順序");
{
  const swept = stateImportance(st({ bsl: "NONE" }));
  const broken = stateImportance(st({ bsl: "BROKEN" }));
  const accepted = stateImportance(st({ bsl: "BREAKOUT_ACCEPTED" }));
  const acceptedBroken = stateImportance(st({ bsl: "BREAKOUT_ACCEPTED", low: true }));
  const failure = stateImportance(st({ bsl: "BREAKOUT_FAILURE_WATCH" }));

  ok(failure > acceptedBroken, "突破失敗 > 成立但防守失守（最該看的排最前）");
  ok(acceptedBroken > accepted, "成立但失守 > 乾淨的成立");
  ok(accepted > broken, "成立 > 只有突破");
  ok(broken > swept, "突破 > 只是掃到");
  ok(stateImportance(st({ bsl: "BREAKOUT_FAILURE_WATCH", mss: true })) > failure,
    "同一狀態下，結構已成立者更前面");

  // 反向（賣方）也要能排前面，不能只認買方
  ok(stateImportance(st({ ssl: "BREAKDOWN_ACCEPTED" })) > swept, "賣方側成立也會往前排");
}

// ───────────────────────────────────────────────────────────────────────────
section("3 長訊息分段，且不得超過 API 上限");
{
  eq(splitForTelegram("short").length, 1, "短訊息不切");

  const line = "【市場狀態】BTCUSDT 1H\n\n▸ 結論：多方還佔上風 —— 現在不能看空\n\n";
  const long = line.repeat(200);                       // 遠超 4000
  const chunks = splitForTelegram(long);

  ok(chunks.length > 1, `長訊息被切成 ${chunks.length} 段`);
  ok(chunks.every((c) => c.length <= 4000), "每一段都在上限之內");
  ok(chunks.every((c) => c.length > 0), "沒有空段（不會造成無限迴圈）");
  ok(chunks.join("").replace(/\s/g, "") === long.replace(/\s/g, ""),
    "切完接回來內容不遺失（忽略被裁掉的空白）");
  ok(chunks.every((c) => !c.startsWith("\n")), "每段不以換行開頭");

  // 完全沒有換行的長字串也要能切，不能卡住
  const noBreaks = "x".repeat(9500);
  const hard = splitForTelegram(noBreaks);
  ok(hard.length >= 3 && hard.every((c) => c.length <= 4000), "沒有換行時仍能硬切且不超限");
}

// ───────────────────────────────────────────────────────────────────────────
section("4 事實要標時間，過期的事實要說自己過期");
{
  // 2026-09-22 06:00 UTC = 台灣 14:00。全程以「秒」為單位 —— 這個檔案就是為了
  // 擋住毫秒/秒混用而存在：混用不會報錯，只會把 09-22 印成 01-22。
  const asOf = Date.UTC(2026, 8, 22, 6, 0) / 1000;
  const DAY = 86_400;

  const base = {
    facts: ["BSL 94.593 BROKEN", "BSL 96.079 SWEPT"],
    breakoutBsl: { level: 94.593, status: "BREAKOUT_FAILURE_WATCH", interactionAt: asOf - 3600 },
    breakoutSsl: null,
    protectedLowPrice: 81.505,
    protectedLowBroken: true,
    protectedLowBrokenAt: asOf - 11 * DAY,
    mssDirection: "bearish",
    mssConfirmed: false,
    mssBreakTime: null,
    asOf,
    lastClose: 94.074,
    shortStatus: "WATCH",
    shortReason: "x",
  };
  const out = formatMarketStateBlock("HYPEUSDT", "1h", base as never, "zh-TW");

  ok(out.includes("09-22 14:00"), `資料時間用台灣時間且日期正確（不是 01-22）→ ${out.split("\n")[1]}`);
  ok(out.includes("收 94.074"), "資料行帶最後收盤價");
  // asOf 06:00 UTC 減一小時 = 05:00 UTC = 台灣 13:00，同一天
  ok(out.includes("09-22 13:00"), "突破時間標出（09-22 13:00 台灣）");
  ok(out.includes("11 天前"), "11 天前的防守線失守 → 標明過期");
  ok(!out.includes("01-22"), "不得出現毫秒/秒混用造成的 1970 年份");
}

// ───────────────────────────────────────────────────────────────────────────
section("5 上方/下方要照「現在的價格」算，不是照線的種類");
{
  // Live report called a level "above 82,282.8" while price sat 3.7% ABOVE it —
  // a broken-through resistance is support, and it belongs below.
  const asOf = Date.UTC(2026, 8, 22, 7, 0) / 1000;
  const base = {
    facts: ["BSL 82283 BROKEN", "SSL 80533 SWEPT"],
    breakoutBsl: { level: 82282.8, status: "BREAKOUT_ACCEPTED", interactionAt: asOf - 3600 },
    breakoutSsl: null,
    protectedLowPrice: null,
    protectedLowBroken: false,
    protectedLowBrokenAt: null,
    mssDirection: null,
    mssConfirmed: false,
    mssBreakTime: null,
    asOf,
    lastClose: 85324.7,
    shortStatus: "NONE",
    shortReason: "x",
  };

  const belowIt = formatMarketStateBlock("BTCUSDT", "1h", base as never, "zh-TW");
  ok(belowIt.includes("下方 82,282.8"), "價格在線上方 → 該線標「下方」");
  ok(!/上方 82,282\.8/.test(belowIt), "不得再稱它「上方」");
  ok(belowIt.includes("下方 82283"), "事實行同一條線也用「下方」（同一則訊息不得自相矛盾）");
  ok(!/上方 82283/.test(belowIt), "事實行不得寫「上方」");

  // 價格跌到線下方 → 同一條線變成「上方」（仍在上面的阻力）
  const aboveIt = formatMarketStateBlock("BTCUSDT", "1h", { ...base, lastClose: 80000 } as never, "zh-TW");
  ok(aboveIt.includes("上方 82,282.8"), "價格在線下方 → 該線標「上方」");

  // 沒有收盤價時，退回原本的側別寫法（不得當掉）
  const noClose = formatMarketStateBlock("BTCUSDT", "1h", { ...base, lastClose: 0 } as never, "zh-TW");
  ok(noClose.includes("82,282.8"), "沒有收盤價時仍要輸出該行");
}

// ───────────────────────────────────────────────────────────────────────────
section("6 資料時間要寫成「幾點到幾點、已收盤」，不能只寫開始時間");
{
  // "資料時間 20:00" read at 21:25 looks like data two hours behind, when it is the
  // 20:00–21:00 bar that closed 25 minutes ago. The raw fetch was never late — the
  // label was. Naming the span removes the ambiguity.
  const asOf = Date.UTC(2026, 8, 22, 12, 0) / 1000;   // 台灣 20:00
  const base = {
    facts: ["BSL 82283 BROKEN", "SSL 80533 SWEPT"],
    breakoutBsl: null, breakoutSsl: null,
    protectedLowPrice: null, protectedLowBroken: false, protectedLowBrokenAt: null,
    mssDirection: null, mssConfirmed: false, mssBreakTime: null,
    asOf, lastClose: 85993.6, shortStatus: "NONE", shortReason: "x",
  };
  const h1 = formatMarketStateBlock("BTCUSDT", "1h", base as never, "zh-TW");
  ok(h1.includes("20:00–21:00"), "1H：標出 20:00–21:00 這個區間");
  ok(h1.includes("已收盤"), "明講已收盤");
  const h4 = formatMarketStateBlock("BTCUSDT", "4h", base as never, "zh-TW");
  ok(h4.includes("20:00–24:00") || h4.includes("20:00–00:00"),
    `4H：標出四小時區間（得到：${(h4.split("\n")[1] || "").trim()}）`);
  const weird = formatMarketStateBlock("BTCUSDT", "7x", base as never, "zh-TW");
  ok(!weird.includes("NaN"), "未知週期不得出現 NaN");
}

// ───────────────────────────────────────────────────────────────────────────
section("7 突破要講清楚方向；時間要跟隨語言");
{
  // "突破失敗" alone does not say whether price failed going up or going down.
  ok(plainBreakout("BREAKOUT_FAILURE_WATCH", "zh-TW").startsWith("向上突破失敗"), "買方失敗 → 向上突破失敗");
  ok(plainBreakout("BREAKDOWN_FAILURE_WATCH", "zh-TW").startsWith("向下跌破失敗"), "賣方失敗 → 向下跌破失敗");
  ok(plainBreakout("BREAKOUT_ACCEPTED", "zh-TW").startsWith("向上突破成立"), "買方成立 → 向上突破成立");
  ok(plainBreakout("BREAKDOWN_ACCEPTED", "zh-TW").startsWith("向下跌破成立"), "賣方成立 → 向下跌破成立");
  ok(plainBreakout("BROKEN", "zh-TW", "up").startsWith("向上"), "未定案(買方) → 向上");
  ok(plainBreakout("BROKEN", "zh-TW", "down").startsWith("向下"), "未定案(賣方) → 向下");
  ok(plainBreakout("BREAKOUT_FAILURE_WATCH", "en").includes("upward"), "英文也講方向");

  // 結論（最顯眼那行）也必須有方向
  const c1 = plainConclusion({ status: "BREAKOUT_FAILURE_WATCH" }, null, false, "WATCH", "zh-TW");
  ok(!!c1 && c1.startsWith("向上突破失敗"), `結論帶方向（得到：${c1}）`);
  const c2 = plainConclusion(null, { status: "BREAKDOWN_FAILURE_WATCH" }, false, "NONE", "zh-TW");
  ok(!!c2 && c2.startsWith("向下跌破失敗"), `賣方結論也要有（得到：${c2}）`);

  // 時區跟隨「訊息語言」，不是市場
  const sec = Date.UTC(2026, 8, 22, 12, 0) / 1000;      // 台灣 20:00 = 紐約 08:00
  eq(localStamp(sec, "zh-TW"), "09-22 20:00", "繁中 → 台灣時間");
  eq(localStamp(sec, "zh-CN"), "09-22 20:00", "簡中 → 北京時間（同 UTC+8）");
  eq(localStamp(sec, "en"), "09-22 08:00", "英文 → 紐約時間（夏令時 UTC-4）");

  const base = {
    facts: ["BSL 82283 BROKEN", "SSL 80533 SWEPT"],
    breakoutBsl: { level: 82282.8, status: "BREAKOUT_FAILURE_WATCH", interactionAt: sec },
    breakoutSsl: null,
    protectedLowPrice: null, protectedLowBroken: false, protectedLowBrokenAt: null,
    mssDirection: "bearish", mssConfirmed: true, mssBreakTime: sec,
    asOf: sec, lastClose: 85993.6, shortStatus: "WATCH", shortReason: "x",
  };
  const tw = formatMarketStateBlock("BTCUSDT", "1h", base as never, "zh-TW");
  const cn = formatMarketStateBlock("BTCUSDT", "1h", base as never, "zh-CN");
  const en = formatMarketStateBlock("BTCUSDT", "1h", base as never, "en");
  ok(tw.includes("（台灣，已收盤）"), "繁中標台灣");
  ok(cn.includes("（北京，已收盘）"), "簡中標北京");
  ok(cn.includes("数据时间"), "簡中不得混用繁體「資料時間」");
  ok(en.includes("(ET)"), "英文標 ET");
  ok(!en.includes("（") && !en.includes("）"), "英文不得出現全形括號");
  ok(en.includes("upward breakout failed"), "英文結論也講方向");
}

// ───────────────────────────────────────────────────────────────────────────
section("8 還沒收盤的 K 棒不准寫「已收盤」");
{
  const asOf = Date.UTC(2026, 8, 22, 15, 0) / 1000;   // 台灣 23:00
  const base = {
    facts: ["BSL 82283 BROKEN", "SSL 80533 SWEPT"],
    breakoutBsl: { level: 82282.8, status: "BREAKOUT_ACCEPTED", interactionAt: asOf },
    breakoutSsl: null,
    protectedLowPrice: null, protectedLowBroken: false, protectedLowBrokenAt: null,
    mssDirection: null, mssConfirmed: false, mssBreakTime: null,
    asOf, lastClose: 34108, shortStatus: "NONE", shortReason: "x",
  };
  const live = formatMarketStateBlock("TRXUSDT", "1h", { ...base, formingLast: true } as never, "zh-TW");
  ok(live.includes("尚未收盤"), "當下那根 → 標「尚未收盤」");
  ok(live.includes("現價"), "當下那根 → 價格標「現價」而不是「收」");
  ok(!live.includes("已收盤"), "不得同時說它已收盤");

  const done = formatMarketStateBlock("TRXUSDT", "1h", { ...base, formingLast: false } as never, "zh-TW");
  ok(done.includes("已收盤"), "已收盤的仍標已收盤");

  const en = formatMarketStateBlock("TRXUSDT", "1h", { ...base, formingLast: true } as never, "en");
  ok(en.includes("forming"), "英文標 forming");
  ok(en.includes("now"), "英文用 now");
}

// ───────────────────────────────────────────────────────────────────────────
section("9 訊息不得露出 BSL／SSL；結論不得自相矛盾");
{
  // The event list was the last door the raw codes came through.
  const reply = formatScanReply({
    scope: "all",
    events: [
      { symbol: "BCHUSDT", timeframe: "4h", side: "BSL", state: "BROKEN", levels: [306.23] },
      { symbol: "LSKUSDT", timeframe: "1h", side: "SSL", state: "SWEPT", levels: [0.324] },
    ],
    approaches: [{ symbol: "TRXUSDT", timeframes: ["1h"], side: "BSL", price: 0.34922, distancePct: 0.25 }],
    historySkipped: [], symbolCount: 75, latestCandleTime: Date.UTC(2026, 8, 22, 15, 0) / 1000,
    scanned: 75, failures: 0,
  }, "zh-TW");
  ok(!/\bBSL\b/.test(reply), "事件清單不得出現 BSL");
  ok(!/\bSSL\b/.test(reply), "事件清單不得出現 SSL");
  ok(reply.includes("上方 突破了 306.23"), "BSL 要翻成「上方」");
  ok(reply.includes("下方 只是掃到 0.324"), "SSL 要翻成「下方」");

  // A conclusion that names a finding must not end with "nothing to judge".
  const c = plainConclusion(null, { status: "BREAKDOWN_FAILURE_WATCH" }, true, "NONE", "zh-TW");
  ok(!!c && c.startsWith("向下跌破失敗"), `結論要有方向（得到：${c}）`);
  ok(!!c && !c.includes("沒有可判斷的事件"), "有結論時不得再接「沒有可判斷的事件」");
}

console.log("");
console.log("─".repeat(72));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
