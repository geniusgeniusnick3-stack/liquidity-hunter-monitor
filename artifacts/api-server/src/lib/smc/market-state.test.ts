/**
 * Market state layer tests — the "what did that take leave behind?" question.
 *
 * Two kinds of case deliberately coexist here:
 *
 *   END-TO-END  (cases 1–3)  real candles through the real engine
 *                            (analyzeLiquidity → analyzeStructure → analyzeFVG →
 *                            analyzeOrderBlocks → analyzeMarketState), so the
 *                            wiring is exercised, not just the functions.
 *
 *   CONTRACT    (cases 4–9)  real candles, but the structure/pool inputs are
 *                            built by hand. Pivot detection has its own tests;
 *                            steering it with synthetic candles to hit a precise
 *                            MSS shape would test the pivot finder, not this
 *                            layer. The contract being checked here is "given
 *                            these pivots and these candles, is the MSS
 *                            confirmed?".
 *
 * Every case is deterministic: no Date.now(), no network, fixed timestamps.
 *
 * REQUIRED cases (from the brief):
 *   1  BSL swept, close back inside            → SWEPT, shortStatus ≠ READY
 *   2  BSL broken and held                     → ACCEPTED, BLOCKED
 *   3  BSL broken then closed back inside      → FAILURE_WATCH, WATCH
 *   4  protected HL closed through + displace  → confirmed bearish MSS
 *   5  bearish MSS, no retest of bearish FVG   → ARMED, never READY
 *   6  bearish FVG retested and rejected       → READY
 *   7  wick through, close did not             → MSS not confirmed
 *   8  forming candle / wall clock             → state cannot depend on them
 *   9  long/short mirror                       → symmetric verdicts
 *  10  PASSIVE ≡ ACTIVE                        → shared path, one engine
 *
 * Run: npx tsx artifacts/api-server/src/lib/smc/market-state.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  Candle, StructureResult, StructurePoint, LiquidityPool, FairValueGap, OrderBlock,
} from "./types.js";
import {
  analyzeMarketState,
  evaluateBreakout,
  evaluateMss,
  findProtectedSwing,
  evaluateShortStatus,
  annotateFvgs,
  atrFor,
  recentTakeCandidates,
  DEFAULT_MARKET_STATE_CONFIG,
  hasRecentTake,
  type MarketStateConfig,
} from "./market-state.js";
import { formatMarketStateBlock } from "../notify/formatters.js";
import { admitCandles } from "./candles.js";
import { analyzeLiquidity } from "./liquidity.js";
import { analyzeStructure } from "./structure.js";
import { analyzeFVG } from "./fvg.js";
import { analyzeOrderBlocks } from "./order-blocks.js";
import { mostRecentTake } from "./report.js";

let passed = 0;
let failed = 0;

function ok(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function eq<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function section(title: string): void {
  console.log("");
  console.log("─".repeat(72));
  console.log(title);
  console.log("─".repeat(72));
}

// ── Fixed-time candle builders (no wall clock anywhere) ─────────────────────

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z
const HOUR = 3600;
const TF = "1h";

type Row = [number, number, number, number]; // open, high, low, close

function makeCandles(rows: Row[]): Candle[] {
  return rows.map((r, i) => ({
    time: T0 + i * HOUR, open: r[0], high: r[1], low: r[2], close: r[3], volume: 1000,
  }));
}

/** `n` identical, quiet bars — no pivots, minimal ATR contribution. */
function flats(n: number, r: Row = [100, 100.6, 99.4, 100]): Row[] {
  return Array.from({ length: n }, () => [...r] as Row);
}

/** `n` bars all based on `base` — a clean, ascending leg. */
function row(n: number, base: number): Row[] {
  return Array.from({ length: n }, () => [base, base + 0.5, base - 0.5, base] as Row);
}

// A buy-side level at 105 that a completed candle closes back inside of.
const BSL_105: Row = [100, 105, 99.4, 100];

function liquidityOf(candles: Candle[]) {
  return analyzeLiquidity(candles, TF, "crypto");
}

function fullState(candles: Candle[], cfg?: Partial<MarketStateConfig>) {
  const liquidity = liquidityOf(candles);
  const structure = analyzeStructure(candles, TF);
  const fvg = analyzeFVG(candles, "crypto");
  const orderBlocks = analyzeOrderBlocks(candles, fvg);
  return analyzeMarketState({
    candles, timeframe: TF, liquidity: liquidity.pools, structure, fvg, orderBlocks, config: cfg,
  });
}

// ── Hand-built engine inputs, for the contract cases ────────────────────────

function structureWith(
  candles: Candle[],
  pivots: Array<{ index: number; price: number; type: StructurePoint["type"] }>,
  bias: StructureResult["bias"] = "bullish",
): StructureResult {
  return {
    trend: bias === "bullish" ? "bullish" : "bearish",
    bias,
    confidence: 0.7,
    pivots: pivots.map((p) => ({
      index: p.index, price: p.price, type: p.type, confirmed: true, time: candles[p.index].time,
    })),
    breaks: [],
    phase: "unknown",
    narrative: "",
    evidence: [],
  };
}

function pool(
  price: number,
  type: "BSL" | "SSL",
  interaction: LiquidityPool["interaction"],
  interactionIdx: number,
  candles: Candle[],
  formedIdx = 10,
): LiquidityPool {
  const ic = candles[interactionIdx];
  return {
    price, type, score: 1, touches: 2,
    wasSwept: interaction === "SWEPT" || interaction === "BROKEN",
    sweptAt: interaction === "SWEPT" ? ic.time : null,
    time: candles[formedIdx].time,
    index: formedIdx,
    session: null,
    probabilityOfSweep: 0,
    interaction,
    interactionAt: interaction === "NONE" ? null : ic.time,
    interactionCandle: interaction === "NONE" ? null : { time: ic.time, high: ic.high, low: ic.low, close: ic.close },
    tolerance: 0,
  };
}

function fvgAt(
  index: number, type: "bullish" | "bearish", top: number, bottom: number, candles: Candle[],
): FairValueGap {
  return { type, top, bottom, time: candles[index].time, index, fillFraction: 0, isInversion: false };
}

console.log("═".repeat(72));
/**
 * A series that produces every leg the ARMED/READY boundary needs:
 *
 *   idx 20–21  BSL 105 broken, then held → accepted
 *   idx 22     a completed close back inside → breakout failure, and the same
 *              candle closes decisively through the protected higher low at
 *              100.2 with a dominant body → confirmed bearish MSS
 *   idx 23     a bearish gap above the market, formed after the MSS
 *
 * Indices 24+ are the caller's to vary. That single difference is what separates
 * "not retested yet" (ARMED) from "retested and rejected" (READY).
 */
function failedBreakoutSeries(tail: Row[]): Candle[] {
  return makeCandles([
    ...flats(5),                                     // 0–4
    [99.5, 100, 98, 99.8],                           // 5   LL
    ...row(6, 101),                                  // 6–11
    [101, 101.5, 100.2, 101.2],                      // 12  HL 100.2
    ...row(7, 104),                                  // 13–19
    [104.5, 105.8, 104, 105.5],                      // 20  BSL 105 被突破
    [105.5, 105.9, 105.1, 105.7],                    // 21  站穩 → 接受成立
    [105.4, 105.6, 99, 99.5],                        // 22  跌回內側，並跌破 HL
    [99.5, 112, 99, 111],                            // 23  bearish FVG 形成
    ...tail,                                         // 24+
  ]);
}

console.log("市場狀態層驗收：突破接受／失敗、protected swing、confirmed MSS、做空狀態");
console.log("═".repeat(72));

// ═══════════════════════════════════════════════════════════════════════════
section("【1】BSL 被掃，但收盤回到原側 → SWEPT，做空狀態不得變成 READY");
// ═══════════════════════════════════════════════════════════════════════════
{
  const candles = makeCandles([
    ...flats(10),                                    // 0–9
    BSL_105,                                         // 10  BSL 105
    ...flats(9),                                     // 11–19
    [100, 106, 99, 101],                             // 20  穿越 105，收盤 101 回到下方
    ...flats(9),                                     // 21–29
  ]);

  const liq = liquidityOf(candles);
  const bsl = liq.pools.find((p) => p.type === "BSL" && Math.abs(p.price - 105) < 1e-9);

  ok(bsl !== undefined, "引擎在 105 偵測到 BSL");
  eq(bsl?.interaction, "SWEPT", "引擎判定為 SWEPT（穿越後收回原側）");
  ok(bsl?.interactionAt === candles[20].time, "互動時間 = 第 20 根已收 K 棒");

  const state = fullState(candles);
  eq(state.breakout.bsl?.status, "NONE", "突破狀態：NONE（從未收盤站上，無突破可接受或失敗）");
  ok(state.shortStatus !== "READY", "做空狀態不得為 READY");
  eq(state.shortStatus, "BLOCKED", "做空狀態為 BLOCKED（單純被掃不是反轉證據）");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【2】BSL 被突破，後續收盤站穩 → BREAKOUT_ACCEPTED，做空 BLOCKED");
// ═══════════════════════════════════════════════════════════════════════════
{
  const above: Row = [107, 107.5, 106.5, 107];
  const candles = makeCandles([
    ...flats(10),
    BSL_105,
    ...flats(9),
    [100, 106, 99.9, 105.5],                         // 20  收盤 105.5 > 105 + tol → BROKEN
    [105.5, 107, 105.2, 106.5],                      // 21
    [106.5, 107.5, 106, 107],                        // 22
    ...flats(7, above),                              // 23–29 全部收在外側
  ]);

  const liq = liquidityOf(candles);
  const bsl = liq.pools.find((p) => p.type === "BSL" && Math.abs(p.price - 105) < 1e-9);
  eq(bsl?.interaction, "BROKEN", "引擎判定為 BROKEN");

  const state = fullState(candles);
  eq(state.breakout.bsl?.status, "BREAKOUT_ACCEPTED", "突破狀態：BREAKOUT_ACCEPTED");
  ok((state.breakout.bsl?.closesBeyond ?? 0) >= 2, `連續收在外側根數 ${state.breakout.bsl?.closesBeyond} >= 2`);
  eq(state.shortStatus, "BLOCKED", "做空狀態：BLOCKED（多頭突破仍被接受）");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【3】BSL 突破後重新跌回區間 → BREAKOUT_FAILURE_WATCH，做空 WATCH");
// ═══════════════════════════════════════════════════════════════════════════
{
  const inside: Row = [103, 103.5, 102, 103];
  const candles = makeCandles([
    ...flats(10),
    BSL_105,
    ...flats(9),
    [100, 106, 99.9, 105.5],                         // 20  突破
    [105.5, 107, 105.2, 106.5],                      // 21  站穩（接受成立）
    [106.5, 106.8, 102.5, 103],                      // 22  收盤跌回 105 下方 → 失敗
    ...flats(7, inside),                             // 23–29 維持在下方
  ]);

  const state = fullState(candles);
  eq(state.breakout.bsl?.status, "BREAKOUT_FAILURE_WATCH", "突破狀態：BREAKOUT_FAILURE_WATCH");
  // `failedAt` is no longer published — it is a derivation input with no
  // downstream reader (see the blueprint's field/reader table). What IS
  // observable after a failure is that price is no longer outside: the trailing
  // run of closes beyond the level is zero.
  eq(state.breakout.bsl?.closesBeyond, 0, "失敗後：結尾連續收在外側根數為 0");
  eq(state.shortStatus, "WATCH", "做空狀態：WATCH（突破失敗，但尚無 confirmed bearish MSS）");
  ok(state.shortStatus !== "READY", "不得直接跳到 READY");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【4】收盤跌破 protected higher low 且有位移 → confirmed bearish MSS");
// ═══════════════════════════════════════════════════════════════════════════
{
  // Protected HL at 100.2 (index 12); the candle at index 20 closes at 96.5,
  // well through it, with a dominant body.
  const candles = makeCandles([
    ...flats(5),                                     // 0–4
    [99.5, 100, 98, 99.8],                           // 5   LL（先前的低點）
    ...row(6, 100),                                  // 6–11
    [101, 101.5, 100.2, 101.2],                      // 12  HL 100.2（要守的較高低點）
    ...row(7, 102),                                  // 13–19
    [101.5, 101.8, 96, 96.5],                        // 20  收盤 96.5 跌破 100.2，實體主導
    ...flats(9, [96.5, 96.8, 95, 96]),               // 21–29
  ]);

  const structure = structureWith(candles, [
    { index: 3, price: 100.6, type: "HH" },
    { index: 5, price: 98, type: "LL" },
    { index: 9, price: 100.6, type: "HH" },
    { index: 12, price: 100.2, type: "HL" },
  ]);

  const atr = atrFor(candles, TF);
  const protectedLow = findProtectedSwing(structure.pivots, candles, atr, "HL", 0.10);
  ok(protectedLow !== null, "找到 bullish protected low");
  eq(protectedLow?.price, 100.2, "protected low = 100.2");
  eq(protectedLow?.broken, true, "已被收盤跌破");
  ok(protectedLow?.brokenAt === candles[20].time, "跌破時間 = 第 20 根");

  const mss = evaluateMss(candles, atr, structure, protectedLow, null, DEFAULT_MARKET_STATE_CONFIG, "bearish");
  eq(mss?.confirmed, true, "confirmed bearish MSS = true");
  eq(mss?.blockers, [], "沒有未達成的條件");
  ok((mss?.breakAtrMultiple ?? 0) > 0, `突破幅度 ${mss?.breakAtrMultiple?.toFixed(2)}x ATR`);
  ok(mss?.displacement?.qualifies === true, `位移條件達成（body/range ${mss?.displacement?.bodyRatio.toFixed(2)}）`);
}

// ═══════════════════════════════════════════════════════════════════════════
section("【5】有 bearish MSS 但尚未回踩 bearish FVG → ARMED，不得變成 READY");
// ═══════════════════════════════════════════════════════════════════════════
{
  const candles = failedBreakoutSeries([
    [111, 111.5, 105, 106],                          // 24
    ...flats(5, [100, 100.5, 99.5, 100]),            // 25–29 從未回到 FVG 區
  ]);

  const liquidity = [pool(105, "BSL", "BROKEN", 20, candles)];
  const structure = structureWith(candles, [
    { index: 5, price: 100.6, type: "HH" },
    { index: 12, price: 100.2, type: "HL" },
  ]);
  // Gaps formed at/after the MSS break, never traded back into.
  const fvgs = [fvgAt(23, "bearish", 112, 108.5, candles)];

  const state = analyzeMarketState({
    candles, timeframe: TF, liquidity, structure, fvg: fvgs, orderBlocks: [],
    htfBias: "bullish",
  });

  ok(state.breakout.bsl !== null, "判讀對象為買方側（BSL）");
  eq(state.breakout.bsl?.status, "REVERSAL_CONFIRMED", "突破狀態：失敗 + 已確認反轉 MSS → REVERSAL_CONFIRMED");
  ok(state.mss !== null, "有 MSS 物件");

  const annotated = annotateFvgs(fvgs, candles, atrFor(candles, TF), state.mss, DEFAULT_MARKET_STATE_CONFIG);
  ok(annotated[0]?.createdAfterMss === true, "FVG 標記 createdAfterMss = true");
  eq(annotated[0]?.retestCount, 0, "尚未被回踩");
  eq(annotated[0]?.isFresh, true, "isFresh = true");

  // Drive the read directly with the enriched gaps, so the assertion is about
  // the ARMED/READY boundary and nothing else.
  const read = evaluateShortStatus({
    bsl: state.breakout.bsl, mss: state.mss, protectedLow: state.protectedLow,
    fvgLifecycle: annotated, obLifecycle: [], htfBias: "bullish",
  });
  eq(read.status, "ARMED", "做空狀態：ARMED（未回踩，所以還不是 READY）");
  ok(read.status !== "READY", "不得變成 READY");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【6】回踩 bearish FVG 且反應失敗（向下離開） → READY");
// ═══════════════════════════════════════════════════════════════════════════
{
  const candles = failedBreakoutSeries([
    [111, 111.5, 105, 106],                          // 24
    [106, 109, 105.5, 108],                          // 25  進入 FVG 區（第一次回踩）
    [108, 108.4, 100, 100.5],                        // 26  向下離開 → 反應確認
    ...flats(3, [100.5, 100.8, 99.8, 100.2]),        // 27–29
  ]);

  const liquidity = [pool(105, "BSL", "BROKEN", 20, candles)];
  const structure = structureWith(candles, [
    { index: 5, price: 100.6, type: "HH" },
    { index: 12, price: 100.2, type: "HL" },
  ]);
  const fvgs = [fvgAt(23, "bearish", 112, 108.5, candles)];

  const state = analyzeMarketState({
    candles, timeframe: TF, liquidity, structure, fvg: fvgs, orderBlocks: [],
    htfBias: "bullish",
  });

  const annotated = annotateFvgs(fvgs, candles, atrFor(candles, TF), state.mss, DEFAULT_MARKET_STATE_CONFIG);
  ok((annotated[0]?.retestCount ?? 0) >= 1, `已回踩 ${annotated[0]?.retestCount} 次`);
  eq(annotated[0]?.reactionConfirmed, true, "反應確認（向下離開 FVG）");
  eq(annotated[0]?.invalidatedAt, null, "未失效");

  const read = evaluateShortStatus({
    bsl: state.breakout.bsl, mss: state.mss, protectedLow: state.protectedLow,
    fvgLifecycle: annotated, obLifecycle: [], htfBias: "bullish",
  });
  eq(read.status, "READY", "做空狀態：READY");
  ok(!/guarantee|profit|will fall|一定會跌|保證/i.test(read.reason), "理由文字不含保證／預測字眼");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【7】只有影線跌破，收盤沒有 → 不得判定 confirmed MSS");
// ═══════════════════════════════════════════════════════════════════════════
{
  const candles = makeCandles([
    ...flats(12),
    [101, 101.5, 100.2, 101.2],                      // 12  HL 100.2
    ...flats(7, [102, 102.5, 101.5, 102]),
    [102, 102.4, 97, 101.8],                         // 20  影線刺破 100.2，收盤 101.8 在上方
    ...flats(9, [101.8, 102, 101, 101.5]),
  ]);

  const structure = structureWith(candles, [
    { index: 3, price: 100.6, type: "HH" },
    { index: 12, price: 100.2, type: "HL" },
  ]);
  const atr = atrFor(candles, TF);
  const protectedLow = findProtectedSwing(structure.pivots, candles, atr, "HL", 0.10);

  eq(protectedLow?.broken, false, "protected low 未被收盤跌破（僅影線）");
  const mss = evaluateMss(candles, atr, structure, protectedLow, null, DEFAULT_MARKET_STATE_CONFIG, "bearish");
  eq(mss?.confirmed, false, "confirmed bearish MSS = false");
  ok(
    (mss?.blockers ?? []).some((b) => b.includes("no completed close beyond")),
    `未達成原因明確：${mss?.blockers?.[0]}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
section("【8】未完成 K 棒／牆上時鐘 → 正式市場狀態不得依賴它們");
// ═══════════════════════════════════════════════════════════════════════════
{
  const candles = makeCandles([
    ...flats(10), BSL_105, ...flats(9),
    [100, 106, 99.9, 105.5], [105.5, 107, 105.2, 106.5], [106.5, 107.5, 106, 107],
    ...flats(7, [107, 107.5, 106.5, 107]),
  ]);

  const a = fullState(candles);
  const b = fullState(candles);
  eq(JSON.stringify(a), JSON.stringify(b), "同樣輸入產生逐位元相同的狀態（決定性，無牆上時鐘）");

  // Truncating to the last COMPLETED bar must give the state of that bar — i.e.
  // a later, still-forming bar cannot retroactively change history.
  const cut = candles.slice(0, 22);
  const atCut = fullState(cut);
  const atCutAgain = fullState(cut.concat()); // same array contents
  eq(JSON.stringify(atCut), JSON.stringify(atCutAgain), "截斷到第 22 根後仍可重現");

  // Feeding an *extra* bar must not rewrite the verdict that existed without it.
  const withExtra = fullState(candles.concat(makeCandles([[107, 107.5, 106.5, 107]]).map((c) => ({ ...c, time: candles[candles.length - 1].time + HOUR }))));
  ok(
    withExtra.breakout.bsl?.status === "BREAKOUT_ACCEPTED",
    "多一根同樣站穩的 K 棒，接受狀態維持 ACCEPTED（不會被撤銷）",
  );

  // Static: this module must never consult the wall clock. Comments are stripped
  // first — the module's own doc comment mentions `Date.now()` while explaining
  // that it avoids it, and a naive scan would flag that sentence.
  const raw = readFileSync(path.resolve(import.meta.dirname, "market-state.ts"), "utf8");
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  ok(!/Date\.now\s*\(/.test(code), "market-state.ts 的程式碼（去掉註解）不含 Date.now()");
  ok(!/\bnew Date\(\s*\)/.test(code), "也不以無參數 new Date() 取當前時間");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【9】多空鏡像 → 判定對稱");
// ═══════════════════════════════════════════════════════════════════════════
{
  const AXIS = 100;

  // Bearish side: BSL 105 broken and held.
  const bearish = makeCandles([
    ...flats(10), BSL_105, ...flats(9),
    [100, 106, 99.9, 105.5], [105.5, 107, 105.2, 106.5], [106.5, 107.5, 106, 107],
    ...flats(7, [107, 107.5, 106.5, 107]),
  ]);

  // Mirror every price through AXIS and swap high/low — an SSL breakdown that
  // is geometrically identical.
  const mirrored: Candle[] = bearish.map((c) => ({
    time: c.time,
    open: 2 * AXIS - c.open,
    high: 2 * AXIS - c.low,
    low: 2 * AXIS - c.high,
    close: 2 * AXIS - c.close,
    volume: c.volume,
  }));

  const bullState = fullState(bearish);
  const bearState = fullState(mirrored);

  // The mirror is a SELL-side take, so it lands on the sell side instead of
  // being "the primary". Pinning BOTH sides is strictly more than the old
  // single-winner assertion checked.
  eq(bullState.breakout.bsl?.status, "BREAKOUT_ACCEPTED", "原方向：買方側 BREAKOUT_ACCEPTED");
  eq(bullState.breakout.ssl, null, "原方向：賣方側沒有事件");
  eq(bearState.breakout.ssl?.status, "BREAKDOWN_ACCEPTED", "鏡像：賣方側 BREAKDOWN_ACCEPTED");
  eq(bearState.breakout.bsl, null, "鏡像：買方側沒有事件");

  // And the failure leg mirrors too.
  const bearishFail = makeCandles([
    ...flats(10), BSL_105, ...flats(9),
    [100, 106, 99.9, 105.5], [105.5, 107, 105.2, 106.5], [106.5, 106.8, 102.5, 103],
    ...flats(7, [103, 103.5, 102, 103]),
  ]);
  const mirroredFail = bearishFail.map((c) => ({
    time: c.time,
    open: 2 * AXIS - c.open, high: 2 * AXIS - c.low,
    low: 2 * AXIS - c.high, close: 2 * AXIS - c.close, volume: c.volume,
  }));

  eq(fullState(bearishFail).breakout.bsl?.status, "BREAKOUT_FAILURE_WATCH", "原方向失敗：買方側 BREAKOUT_FAILURE_WATCH");
  eq(fullState(mirroredFail).breakout.ssl?.status, "BREAKDOWN_FAILURE_WATCH", "鏡像失敗：賣方側 BREAKDOWN_FAILURE_WATCH");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【10】PASSIVE ≡ ACTIVE → 同一條路徑、同一套判定");
// ═══════════════════════════════════════════════════════════════════════════
{
  const SRC = path.resolve(import.meta.dirname, "..", "..");
  const PASSIVE = path.join(SRC, "scripts/live-snapshot.ts");
  const ACTIVE = path.join(SRC, "scripts/monitor-loop.ts");

  for (const [name, file] of [["PASSIVE (live-snapshot)", PASSIVE], ["ACTIVE (monitor-loop)", ACTIVE]] as const) {
    const src = readFileSync(file, "utf8");
    ok(!src.includes("market-state"), `${name} 不自行引用市場狀態層`);
    ok(!src.includes("analyzeLiquidity") && !src.includes("analyzeStructure"),
      `${name} 不自行引用任何分析邏輯`);
    ok(src.includes("runScan"), `${name} 呼叫共用 runScan()`);
  }

  // The state layer is computed INSIDE runScan, which is the single shared
  // entry point both modes call — so parity is structural, not hoped for.
  const scanSrc = readFileSync(path.join(SRC, "lib/scan/ScanEngine.ts"), "utf8");
  ok(scanSrc.includes("analyzeMarketState"), "狀態層在 ScanEngine（共用路徑）內計算");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【11】漏斗閘門：只有近期被取走的幣種才進第二輪");
// ═══════════════════════════════════════════════════════════════════════════
{
  const candles = makeCandles(flats(30));
  const last = candles[candles.length - 1].time;
  const cfg = DEFAULT_MARKET_STATE_CONFIG;

  // Indices are counted back from the end: 27 = 2 bars ago, 2 = 27 bars ago.
  const twoAgo = [pool(105, "BSL", "BROKEN", 27, candles)];
  const longAgo = [pool(105, "BSL", "BROKEN", 2, candles)];
  const none = [pool(105, "BSL", "NONE", 28, candles)];

  eq(hasRecentTake(twoAgo, candles, TF, cfg), true, "2 根前被破 → 在 24 根窗口內，進入第二輪");
  eq(hasRecentTake(longAgo, candles, TF, cfg), false, "27 根前被破 → 超出 24 根窗口，不進入");
  eq(hasRecentTake(none, candles, TF, cfg), false, "未被取走 → 不進入");
  eq(hasRecentTake([], candles, TF, cfg), false, "沒有價位 → 不進入");

  // The window is TIME based, so a gap in the candles cannot stretch it.
  eq(hasRecentTake(twoAgo, candles, TF, { ...cfg, screening_lookback_bars: 1 }), false,
    "窗口縮到 1 根 → 2 根前的事件被排除");

  // A take stamped in the FUTURE is bad data, not a recent event. The gate used
  // to accept it (it only checked the upper bound) while the depth analysis then
  // failed to find the candle and returned null — the gate said yes and the
  // answer was silence.
  const future = pool(105, "BSL", "BROKEN", 29, candles);
  const futureAt = candles[29].time + 10 * HOUR;
  const withFuture = [{ ...future, interactionAt: futureAt }];

  eq(hasRecentTake(withFuture, candles, TF, cfg), false, "未來時間戳 → 閘門不通過");
  eq(recentTakeCandidates(withFuture, candles, TF, cfg).length, 0, "未來時間戳不是候選");
  eq(JSON.stringify(evaluateBreakout(withFuture, candles, TF, cfg).breakout),
    JSON.stringify({ bsl: null, ssl: null }),
    "第二段同樣兩側皆空 —— 閘門與深入判斷一致（過去不一致）");
  ok(last < futureAt, "（前提）該時間戳確實在最後一根 K 棒之後");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【12】report.ts 的『最近被取走』判斷：用互動時間，不是形成時間");
// ═══════════════════════════════════════════════════════════════════════════
{
  const candles = makeCandles(flats(30));
  const last = candles[candles.length - 1].time;
  const window = 4 * 3600;

  // (a) Formed long ago, taken recently → MUST count as recent.
  const formedLongAgoTakenNow = {
    wasSwept: true,
    interactionAt: last - 3600,          // one bar ago
    time: last - 30 * 24 * HOUR,         // formed a month ago
  };
  ok(mostRecentTake([formedLongAgoTakenNow], last, window) !== null,
    "很久以前形成、最近才被取走 → 判定為最近事件");

  // (b) Formed recently, taken long ago → must NOT count.
  const formedRecentlyTakenLongAgo = {
    wasSwept: true,
    interactionAt: last - 30 * 24 * HOUR, // taken a month ago
    time: last - 3600,                    // formed one bar ago
  };
  eq(mostRecentTake([formedRecentlyTakenLongAgo], last, window), null,
    "最近形成、很久以前被取走 → 不得判為最近事件");

  // (c) Never triggered → cannot be a recent event, whatever its formation time.
  const untouched = { wasSwept: false, interactionAt: null, time: last - 60 };
  eq(mostRecentTake([untouched], last, window), null, "未被觸發的價位不得當成最近事件");

  // (d) The LATEST take wins, not whichever pool happens to sit first in the array.
  const older = { wasSwept: true, interactionAt: last - 7200, time: last - 100 };
  const newer = { wasSwept: true, interactionAt: last - 600, time: last - 100 };
  eq(mostRecentTake([older, newer], last, window)?.interactionAt, last - 600,
    "回傳的是最近一次互動，不是陣列中第一個符合條件的");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【13】形成中 K 棒：不得改變正式市場狀態");
// ═══════════════════════════════════════════════════════════════════════════
//
// Closed-bar rules moved out of this module and into the single admission gate
// (candles.ts). `analyzeMarketState()` now trusts its input, because a second
// filter here is what produced the old "open time + period length" guess — and
// that guess held back already-CLOSED weekly bars until Monday.
//
// These assertions still discriminate: if the gate ever stops dropping the
// forming bar, `gated` flips and both the equality and the inequality below go
// red. Both sides call production code — the gate's output is fed straight in.
{
  const accepted: Row = [107, 107.5, 106.5, 107];
  const base = makeCandles([
    ...flats(10), BSL_105, ...flats(9),
    [100, 106, 99.9, 105.5], [105.5, 107, 105.2, 106.5], [106.5, 107.5, 106, 107],
    ...flats(7, accepted),
  ]);
  const liq = liquidityOf(base);
  const structure = analyzeStructure(base, TF);
  const fvg = analyzeFVG(base, "crypto");

  const before = fullState(base);
  eq(before.breakout.bsl?.status, "BREAKOUT_ACCEPTED", "基準狀態：BREAKOUT_ACCEPTED");

  // A still-forming bar that WOULD flip the verdict if it were counted — its
  // "close" is just the current price, which is why an unfinished bar must never
  // reach the state layer.
  const formingTime = base[base.length - 1].time + HOUR;
  const forming: Candle = { time: formingTime, open: 107, high: 107.2, low: 100, close: 101, volume: 1 };
  const withForming = [...base, forming];
  const now = formingTime + 60;

  // (a) The closed-candle contract lives in ONE place now.
  const admitted = admitCandles(withForming, { closure: "unprovable", nowSeconds: now, minCandles: 1 });
  eq(admitted.candles.length, base.length, "unprovable 來源：閘門剔掉最後一根");

  const gated = analyzeMarketState({
    candles: admitted.candles, timeframe: TF, liquidity: liq.pools, structure, fvg, orderBlocks: [],
  });
  eq(gated.breakout.bsl?.status, before.breakout.bsl?.status,
    "經過閘門 → 未收盤 K 棒不影響狀態");

  // (b) Discrimination: hand the SAME data in ungated and the state really does
  // flip. Without this, (a) could pass because the bar happens to be harmless.
  const ungated = analyzeMarketState({
    candles: withForming, timeframe: TF, liquidity: liq.pools, structure, fvg, orderBlocks: [],
  });
  ok(ungated.breakout.bsl?.status !== "BREAKOUT_ACCEPTED",
    "（鑑別力）未經閘門時，同一根形成中 K 棒確實會翻掉狀態 —— 證明閘門有作用");

  // (c) The source knows better than we do. A source that can PROVE closure
  // keeps every bar — no arithmetic, so no already-closed bar is ever thrown
  // away. This is the regression test for the weekly/daily mis-drop.
  const proven = admitCandles(base, { closure: "proven", nowSeconds: now, minCandles: 1 });
  eq(proven.candles.length, base.length,
    "proven 來源：已收盤的 K 棒一根都不會被剔（不靠週期長度推論）");
  eq(proven.rejected.length, 0, "proven 來源：沒有東西被拒");

  // (d) The documented cost of an unprovable source: exactly one bar, always.
  eq(admitCandles(base, { closure: "unprovable", nowSeconds: now, minCandles: 1 }).candles.length,
    base.length - 1,
    "unprovable 來源：固定少一根（誠實的已知限制，不是誤刪）");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【14】同根 K 棒同時取走 BSL 與 SSL：判定與陣列順序無關");
// ═══════════════════════════════════════════════════════════════════════════
{
  const above: Row = [107, 107.5, 106.5, 107];
  const candles = makeCandles([
    ...flats(10), BSL_105, ...flats(9),
    [100, 106, 99, 105.5], [105.5, 107, 105.2, 106.5], [106.5, 107.5, 106, 107],
    ...flats(7, above),
  ]);
  const cfg = DEFAULT_MARKET_STATE_CONFIG;
  const bsl = pool(105, "BSL", "BROKEN", 20, candles);
  const ssl = pool(99.5, "SSL", "BROKEN", 20, candles);

  const forward = recentTakeCandidates([bsl, ssl], candles, TF, cfg);
  const reversed = recentTakeCandidates([ssl, bsl], candles, TF, cfg);

  eq(forward.map((c) => c.pool.type), reversed.map((c) => c.pool.type),
    "候選順序與輸入陣列順序無關");
  eq(forward[0]?.pool.type, "BSL", "同分時以 BSL 為主（空方判讀所依據的那一側）");
  eq(forward.length, 2, "兩側都保留 —— facts 不會因 tie-break 而漏掉事件");

  const a = evaluateBreakout([bsl, ssl], candles, TF, cfg);
  const b = evaluateBreakout([ssl, bsl], candles, TF, cfg);
  // There is no longer a "primary". Both sides are produced, and this is the
  // regression test for the bug where a NEWER sell-side take won a shared sort
  // and collapsed the buy-side read to NONE while the buy-side chain was live.
  eq(JSON.stringify(a.breakout), JSON.stringify(b.breakout),
    "兩側狀態與陣列順序無關（逐位元相同）");
  ok(a.breakout.bsl !== null, "買方側有狀態 —— 不會被較新的賣方側蓋掉");
  ok(a.breakout.ssl !== null, "賣方側也有狀態");
  eq(a.facts.length, 2, "兩個事實事件都出現在 facts");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【15】已回踩但未拒絕 → ARMED，理由不得說「尚未回踩」");
// ═══════════════════════════════════════════════════════════════════════════
{
  // Geometry matters here, and the obvious arrangement does not work: if the
  // bearish gap sits ABOVE the broken level, any retest of it also re-accepts
  // the breakout, so "retested but not rejected" cannot coexist with "failed".
  // The level is therefore placed well above both the failure close and the gap.
  //
  //   idx 20–21  BSL 120 broken and held → accepted
  //   idx 22     close 99.5 → breakout failed, and through the protected HL 100.2
  //              with a dominant body → confirmed bearish MSS
  //   idx 23     bearish FVG 95–99, below the market
  //   idx 25     first retest (trades back up into the gap), no rejection
  const candles = makeCandles([
    ...flats(5),                                     // 0–4
    [99.5, 100, 98, 99.8],                           // 5   LL
    ...row(6, 101),                                  // 6–11
    [101, 101.5, 100.2, 101.2],                      // 12  HL 100.2
    ...row(7, 104),                                  // 13–19
    [104.5, 121, 104, 120.5],                        // 20  BSL 120 突破
    [120.5, 121.5, 120, 121],                        // 21  站穩 → 接受
    [121, 121.5, 99, 99.5],                          // 22  跌回內側 + 跌破 HL
    [99.5, 100, 96.5, 98.5],                         // 23  產生 bearish FVG
    [98.5, 99, 97, 98.2],                            // 24
    [98.2, 98.8, 96.5, 98],                          // 25  第一次回踩（未向下離開）
    ...flats(4, [98, 98.4, 97, 97.8]),               // 26–29
  ]);

  const state = analyzeMarketState({
    candles, timeframe: TF,
    liquidity: [pool(120, "BSL", "BROKEN", 20, candles)],
    structure: structureWith(candles, [
      { index: 5, price: 100.6, type: "HH" },
      { index: 12, price: 100.2, type: "HL" },
    ]),
    fvg: [fvgAt(23, "bearish", 99, 95, candles)],
    orderBlocks: [],
    htfBias: "bullish",
  });

  eq(state.breakout.bsl?.status, "REVERSAL_CONFIRMED",
    "（前提）突破失敗 + 已確認反轉 MSS → REVERSAL_CONFIRMED");

  // The enriched list is no longer returned on the state object (nothing outside
  // this module read it), so the test derives it the same way the module does.
  const z = annotateFvgs(
    [fvgAt(23, "bearish", 99, 95, candles)], candles,
    atrFor(candles, TF), state.mss, DEFAULT_MARKET_STATE_CONFIG,
  )[0];
  ok((z?.retestCount ?? 0) >= 1, `已回踩 ${z?.retestCount} 次`);
  eq(z?.reactionConfirmed, false, "尚未出現拒絕");
  eq(z?.isFresh, false, "已被回踩 → 不再是 fresh 區塊（isFresh 與「合格」是兩件事）");

  eq(state.shortStatus, "ARMED", "狀態：ARMED");
  ok(/retested/.test(state.shortReason), `理由說明已回踩：${state.shortReason}`);
  ok(!/not been retested/.test(state.shortReason), "理由不得謊稱「尚未回踩」");
  ok(state.shortZone !== null, "報告帶出所依據的區塊（有消費端，不是死欄位）");
  eq(state.shortZone?.kind, "FVG", "區塊種類：FVG");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【16】report.ts 修正的鑑別力：舊算式必須在這些輸入上出錯");
// ═══════════════════════════════════════════════════════════════════════════
{
  // The expression this replaced, reproduced here so the assertion is about
  // BEHAVIOUR rather than about a missing export. (The first version of this
  // suite only failed to load against the old file, which is not a red test —
  // it is no test at all.)
  const oldRecentSwept = (
    pools: Array<{ wasSwept: boolean; time: number; interactionAt: number }>,
    nowMs: number,
    window = 14400,
  ) => pools.find((p) => p.wasSwept && (nowMs / 1000 - p.time) < window) ?? null;

  const candles = makeCandles(flats(30));
  const last = candles[candles.length - 1].time;
  const window = 4 * 3600;

  // (a) formed long ago, taken recently. The old expression could never see it.
  const formedLongAgo = { wasSwept: true, time: last - 30 * 24 * HOUR, interactionAt: last - 3600 };
  eq(oldRecentSwept([formedLongAgo], last * 1000), null,
    "舊算式：只看形成時間 → 漏掉「久前形成、最近取走」（錯誤）");
  ok(mostRecentTake([formedLongAgo], last, window) !== null, "新算式：正確判為最近事件");

  // (b) formed recently, taken long ago. The old expression wrongly accepted it.
  const takenLongAgo = { wasSwept: true, time: last - 3600, interactionAt: last - 30 * 24 * HOUR };
  ok(oldRecentSwept([takenLongAgo], last * 1000) !== null,
    "舊算式：形成時間很新 → 誤判為最近事件（錯誤）");
  eq(mostRecentTake([takenLongAgo], last, window), null, "新算式：正確排除");

  // (c) ordering — the old expression returned the FIRST match in array order.
  const p1 = { wasSwept: true, time: last - 600, interactionAt: last - 7200 };
  const p2 = { wasSwept: true, time: last - 300, interactionAt: last - 600 };
  eq(oldRecentSwept([p1, p2], last * 1000)?.interactionAt, last - 7200,
    "舊算式：回傳陣列第一筆（較舊的那筆）");
  eq(mostRecentTake([p1, p2], last, window)?.interactionAt, last - 600,
    "新算式：回傳最近一次互動");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【17】共用路徑的決定性：同一份固定 K 棒 → 逐位元相同（不需網路）");
// ═══════════════════════════════════════════════════════════════════════════
{
  const { runScan } = await import("../scan/ScanEngine.js");
  const fixture = makeCandles(flats(60));
  const source = async (_symbol: string, _tf: string): Promise<Candle[]> => fixture;

  const a = await runScan({
    symbols: ["AAAUSDT"], timeframes: [TF], candleSource: source, applyDedup: false,
  });
  const b = await runScan({
    symbols: ["AAAUSDT"], timeframes: [TF], candleSource: source, applyDedup: false,
  });

  eq(a.scanned, b.scanned, "兩次掃描處理的組合數相同");
  eq(JSON.stringify(a.marketStates), JSON.stringify(b.marketStates),
    "marketStates 逐位元相同（決定性，無網路依賴）");
  eq(a.marketStates.length, 1, "指定幣種時即使沒有近期取走也會深入（直接提問不該回空）");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【18】報告區塊三語言：標籤齊全，且 zh-CN 不得混入繁體");
// ═══════════════════════════════════════════════════════════════════════════
{
  const { formatMarketStateBlock, toReplyMarketState } = await import("../notify/formatters.js");
  const { UI } = await import("../notify/i18n.js");

  const sample = toReplyMarketState({
    facts: ["BSL 78500 BROKEN"],
    breakout: {
      bsl: { level: 78500, status: "BREAKOUT_FAILURE_WATCH" },
      ssl: null,
    },
    protectedLow: { price: 76200, broken: true },
    mss: { direction: "bearish", confirmed: true },
    shortStatus: "ARMED",
    shortReason: "zone retested, no rejection yet",
  });

  for (const lang of ["zh-TW", "zh-CN", "en"] as const) {
    const block = formatMarketStateBlock("BTCUSDT", "1h", sample, lang);
    const t = UI[lang];
    ok(block.includes(t.stateHeading), `[${lang}] 含標題`);
    ok(block.includes("▸") && block.includes("‧"), `[${lang}] 含結論行與依據列`);
    // Policy inverted: the engine token stays in the JSON, never in the message.
    ok(!block.includes("BREAKOUT_FAILURE_WATCH"), `[${lang}] 引擎代號不得出現在訊息裡`);
    ok(block.includes(t.stateDisclaimer), `[${lang}] 含「非交易指令」結語`);
    // No forward-looking promise anywhere in the rendered block.
    ok(
      !/guarantee|profit|will fall|recommend|一定會跌|保證|建議進場/i.test(block),
      `[${lang}] 不含保證／預測／建議字眼`,
    );
  }

  // Language purity of the NEW strings. Deliberately excludes language NAMES
  // (繁體中文 / 简体中文), which are written in their own script on purpose so a
  // reader can recognise the option they are choosing.
  const cnBlock = formatMarketStateBlock("BTCUSDT", "1h", sample, "zh-CN");
  const traditionalOnly = "態場護點結構轉讀認確資訊實應";
  const leaked = [...traditionalOnly].filter((ch) => cnBlock.includes(ch));
  eq(leaked, [], `zh-CN 區塊不含繁體專用字（洩漏：${leaked.join("") || "無"}）`);
}

// ═══════════════════════════════════════════════════════════════════════════
section("【19】關閉開關：空狀態，且關不掉的是哪一條路徑");
// ═══════════════════════════════════════════════════════════════════════════
{
  const { buildReport } = await import("./report.js");
  const { loadConfig } = await import("../config/index.js");

  const candles = makeCandles([
    ...flats(10), BSL_105, ...flats(9),
    [100, 106, 99.9, 105.5], [105.5, 107, 105.2, 106.5], [106.5, 107.5, 106, 107],
    ...flats(7, [107, 107.5, 106.5, 107]),
  ]);

  const on = buildReport(candles, "BTCUSDT", "crypto", TF, { closureEvidence: "proven" });
  ok(on.marketState.breakout.bsl !== null || on.marketState.breakout.ssl !== null,
    "開啟時：marketState 至少有一側的狀態");

  const off = buildReport(candles, "BTCUSDT", "crypto", TF, { includeMarketState: false, closureEvidence: "proven" });
  eq(JSON.stringify(off.marketState.breakout), JSON.stringify({ bsl: null, ssl: null }),
    "關閉時：兩側皆空");
  eq(off.marketState.shortStatus, "NONE", "關閉時：shortStatus 為 NONE");
  eq(off.marketState.facts, [], "關閉時：facts 為空");
  ok("marketState" in off, "關閉時欄位仍存在（空值，不是拿掉欄位）");
  ok(off.liquidity.pools.length === on.liquidity.pools.length,
    "關閉狀態層不影響既有引擎輸出（liquidity 完全相同）");
  eq(off.structure.bias, on.structure.bias, "關閉狀態層不影響 structure");

  // The operational switch is read from config.yaml inside buildReport, so it
  // reaches the MCP / REST / realtime / backtest callers too — not only runScan.
  // Pinned statically: an in-process flip is not observable because the config
  // is cached, and pretending otherwise would be a test that proves nothing.
  eq(loadConfig().market_state.enabled, true, "config.yaml 目前為 enabled: true");
  const repoSrc = readFileSync(path.resolve(import.meta.dirname, "report.ts"), "utf8");
  ok(repoSrc.includes("loadConfig().market_state.enabled"),
    "buildReport 直接讀 config.yaml 的開關（靜態釘住這條接線）");
  ok(repoSrc.includes("marketStateEnabled()"),
    "並以此函式為唯一判斷來源");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【20】MCP／REST 投影：狀態層有真正的下游讀者");
// ═══════════════════════════════════════════════════════════════════════════
{
  const { marketStateSummary } = await import("./market-state.js");
  const { buildReport } = await import("./report.js");

  const candles = makeCandles([
    ...flats(10), BSL_105, ...flats(9),
    [100, 106, 99.9, 105.5], [105.5, 107, 105.2, 106.5], [106.5, 106.8, 102.5, 103],
    ...flats(7, [103, 103.5, 102, 103]),
  ]);

  const report = buildReport(candles, "BTCUSDT", "crypto", TF, { closureEvidence: "proven" });
  const summary = marketStateSummary(report.marketState);

  ok("facts" in summary && Array.isArray(summary.facts), "投影含 facts（事實層）");
  eq(summary.breakout.bsl?.status, "BREAKOUT_FAILURE_WATCH", "投影含買方側突破狀態");
  ok(typeof summary.breakout.bsl?.reason === "string", "投影含突破理由");
  ok("shortStatus" in summary, "投影含做空狀態");
  ok("mss" in summary, "投影含 MSS 欄位");
  ok("protectedLow" in summary, "投影含 protected swing");
  ok("evidence" in summary, "投影含解釋清單");
  eq(JSON.parse(JSON.stringify(summary)), summary, "投影可安全序列化（無 undefined／函式）");

  // `BreakoutState.evidence` used to be declared and never written — an
  // always-empty array reads as "we checked and found nothing" when the truth is
  // "nothing ever fills this". Removed rather than left as decoration.
  ok(!JSON.stringify(summary.breakout).includes("\"evidence\""),
    "突破狀態不再帶那個永遠空著的 evidence 欄位");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【21】再次接受會清掉先前的失敗（失敗不是鎖死狀態）");
// ═══════════════════════════════════════════════════════════════════════════
{
  const candles = makeCandles([
    ...flats(10), BSL_105, ...flats(9),
    [100, 106, 99.9, 105.5],                        // 20 突破
    [105.5, 107, 105.2, 106.5],                     // 21 接受
    [106.5, 106.8, 102.5, 103],                     // 22 收盤跌回 → 失敗
    ...flats(2, [103, 103.5, 102, 103]),            // 23–24 仍在內側
    [103, 107.5, 102.5, 107],                       // 25 重新收在外側
    ...flats(4, [107, 107.5, 106.5, 107]),          // 26–29 連續維持外側
  ]);

  const state = fullState(candles);
  eq(state.breakout.bsl?.status, "BREAKOUT_ACCEPTED",
    "先失敗、後又連續收在外側 → 回到 ACCEPTED（失敗可被後續接受清掉）");
  ok((state.breakout.bsl?.closesBeyond ?? 0) >= 1,
    "結尾連續收在外側根數 >= 1");
  ok(state.shortStatus !== "READY",
    "重新接受之後，做空判讀不得維持在 READY");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【22】設定檔缺失或損壞 → 大聲失敗（不得靜默用預設）");
// ═══════════════════════════════════════════════════════════════════════════
{
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  // NOT `.pathname` — this path contains non-ASCII characters, and `.pathname`
  // hands back a percent-encoded string, so the probe's import (and CONFIG_PATH)
  // would silently point at nothing. That produced a green-looking pass for the
  // wrong reason until the control group below caught it.
  const { fileURLToPath } = await import("node:url");

  const here = fileURLToPath(new URL("./", import.meta.url));
  const goodConfig = fileURLToPath(new URL("../../../../../config.yaml", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "smc-cfg-"));

  // The probe does the smallest thing that reaches the switch: build a report.
  // If the switch resolves silently the probe prints and exits 0 — which is the
  // behaviour under test.
  const probe = join(dir, "probe.ts");
  writeFileSync(
    probe,
    [
      `import { buildReport } from ${JSON.stringify(here + "report.js")};`,
      `const t = 1_700_000_000;`,
      `const c = [0, 1, 2, 3].map((i) => ({ time: t + i * 3600, open: 100, high: 101, low: 99, close: 100.5, volume: 1 }));`,
      `buildReport(c, "BTCUSDT", "crypto", "1h", { closureEvidence: "proven" });`,
      `console.log("SWITCH_RESOLVED_WITHOUT_ERROR");`,
    ].join("\n"),
    "utf8",
  );

  const run = (env: Record<string, string>): { code: number; out: string } => {
    try {
      const out = execFileSync("npx", ["tsx", probe], {
        encoding: "utf8", env: { ...process.env, ...env }, stdio: "pipe",
      });
      return { code: 0, out: String(out) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  const broken = join(dir, "broken.yaml");
  writeFileSync(broken, "market_state: [this is not: valid\n  : :\n", "utf8");

  const damaged = run({ CONFIG_PATH: broken });
  ok(damaged.code !== 0, "設定檔損壞 → 非零結束（不是靜默繼續）");
  ok(!damaged.out.includes("SWITCH_RESOLVED_WITHOUT_ERROR"), "損壞時不會走到「已解析」那一步");

  const missing = run({ CONFIG_PATH: join(dir, "does-not-exist.yaml") });
  ok(missing.code !== 0, "設定檔缺失 → 非零結束");
  ok(!missing.out.includes("SWITCH_RESOLVED_WITHOUT_ERROR"), "缺失時不會走到「已解析」那一步");

  // Control. Without this, the two assertions above would also pass if the probe
  // were broken for an unrelated reason — a green light that proves nothing.
  const good = run({ CONFIG_PATH: goodConfig });
  eq(good.code, 0, "控制組：設定檔正常時可解析");
  ok(good.out.includes("SWITCH_RESOLVED_WITHOUT_ERROR"), "控制組：確實走完那一步");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【23】最後一根才突破、還沒定案 → BROKEN（不得冒充 NONE）");
// ═══════════════════════════════════════════════════════════════════════════
//
// The regression that reached a reader: a level price had just closed through was
// published as status NONE, and NONE is rendered "swept only, no breakout" — the
// opposite of what the chart showed. Cause: runAcceptance() returns only
// ACCEPTED / FAILURE / NONE, so a FRESH break fell into NONE, whose documented
// meaning is "nothing to judge". The type already had BROKEN for this case; the
// engine simply never emitted it. No test covered a break on the final candle,
// which is why it survived until a live scan surfaced the contradiction.
{
  const breakBar: Row = [100, 106, 99.9, 105.5];
  const candles = makeCandles([
    ...flats(10), BSL_105, ...flats(19, [103, 103.5, 102, 103]), breakBar,
  ]);
  const cfg = DEFAULT_MARKET_STATE_CONFIG;

  // 突破就發生在最後一根 → 只有 1 根收在外側，未達 acceptance_bars
  const brokenLast = evaluateBreakout(
    [pool(105, "BSL", "BROKEN", candles.length - 1, candles)], candles, TF, cfg,
  );
  eq(brokenLast.breakout.bsl?.interaction, "BROKEN", "（前提）引擎判定這條已突破");
  eq(brokenLast.breakout.bsl?.status, "BROKEN", "剛突破未定案 → BROKEN");
  ok(brokenLast.breakout.bsl?.status !== "NONE",
    "不得回報 NONE —— NONE 的定義是「沒有東西可判斷」");

  // 對照：真的「只是掃到」才可以是 NONE
  const sweptOnly = evaluateBreakout(
    [pool(105, "BSL", "SWEPT", candles.length - 1, candles)], candles, TF, cfg,
  );
  eq(sweptOnly.breakout.bsl?.status, "NONE", "（對照組）只是掃到 → NONE");
  eq(sweptOnly.breakout.bsl?.interaction, "SWEPT", "（對照組）interaction 為 SWEPT");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【24】破過又收復的防守線 → 當它不存在（不得再報）");
// ═══════════════════════════════════════════════════════════════════════════
//
// A live report cited "defence line 81.505 — closed through" for a price that had
// long since rallied 13% above it. Marking it "(11 days ago)" was not enough: a
// level the market has already left behind must not be offered as support at all.
// The line is still reported while it holds, and while it is broken AND price is
// still on the broken side — only a break the market has undone disappears.
{
  const flatAtr = (n: number) => new Array(n).fill(0.5);
  const PIVOT = 100;

  const build = (rows: Row[]) => makeCandles(rows);
  const pivotAt = (candles: ReturnType<typeof makeCandles>, idx: number) => ([{
    index: idx, price: PIVOT, type: "HL" as const, confirmed: true, time: candles[idx].time,
  }]);

  // 破了之後站回上方 → 已收復
  const reclaimed = build([
    ...flats(5, [102, 102.5, 101.5, 102]),
    [100, 100.5, 99.5, 100],
    ...flats(3, [102, 102.5, 101.5, 102]),
    [97, 97, 94.5, 95],              // 收破（低於 100 − tol）
    [104, 106.5, 103.5, 106],        // 收復（高於 100 + tol）
    [106, 106.5, 105.5, 106],
  ]);
  const sw1 = findProtectedSwing(pivotAt(reclaimed, 5), reclaimed, flatAtr(reclaimed.length), "HL", 1);
  eq(sw1?.broken, true, "（前提）確實被跌破過");
  eq(sw1?.reclaimed, true, "站回上方 → 標記為已收復");
  eq(sw1?.reclaimedAt !== null, true, "收復時間有記錄");

  // 破了之後一直在下方 → 仍是有效的（空方）事實
  const stillBroken = build([
    ...flats(5, [102, 102.5, 101.5, 102]),
    [100, 100.5, 99.5, 100],
    ...flats(3, [102, 102.5, 101.5, 102]),
    [97, 97, 94.5, 95],
    ...flats(3, [94, 94.5, 93.5, 94]),
  ]);
  const sw2 = findProtectedSwing(pivotAt(stillBroken, 5), stillBroken, flatAtr(stillBroken.length), "HL", 1);
  eq(sw2?.broken, true, "仍在下方 → 仍然是已跌破");
  eq(sw2?.reclaimed, false, "沒有收復");

  // 從未跌破 → 防守線還在
  const intact = build([
    ...flats(5, [102, 102.5, 101.5, 102]),
    [100, 100.5, 99.5, 100],
    ...flats(6, [103, 103.5, 102.5, 103]),
  ]);
  const sw3 = findProtectedSwing(pivotAt(intact, 5), intact, flatAtr(intact.length), "HL", 1);
  eq(sw3?.broken, false, "未跌破 → 防守線有效");
  eq(sw3?.reclaimed, false, "未跌破不會標記收復");

  // 回報端：收復的線不得出現在區塊裡
  const block = formatMarketStateBlock("HYPEUSDT", "1h", {
    facts: ["BSL 94.593 BROKEN"],
    breakoutBsl: null,
    breakoutSsl: null,
    protectedLowPrice: 81.505,
    protectedLowBroken: true,
    protectedLowBrokenAt: reclaimed[reclaimed.length - 1].time - 86400 * 11,
    protectedLowReclaimed: true,
    mssDirection: null,
    mssConfirmed: false,
    mssBreakTime: null,
    asOf: reclaimed[reclaimed.length - 1].time,
    lastClose: 94.074,
    shortStatus: "WATCH",
    shortReason: "x",
  } as never, "zh-TW");
  ok(!block.includes("81.505"), "已收復的防守線不得出現在訊息裡");
  ok(!block.includes("防守線"), "整行都不該出現");

  // 對照組：沒收復就要報
  const block2 = formatMarketStateBlock("HYPEUSDT", "1h", {
    facts: ["BSL 94.593 BROKEN"],
    breakoutBsl: null,
    breakoutSsl: null,
    protectedLowPrice: 81.505,
    protectedLowBroken: true,
    protectedLowBrokenAt: reclaimed[reclaimed.length - 1].time - 3600,
    protectedLowReclaimed: false,
    mssDirection: null,
    mssConfirmed: false,
    mssBreakTime: null,
    asOf: reclaimed[reclaimed.length - 1].time,
    lastClose: 80.0,
    shortStatus: "WATCH",
    shortReason: "x",
  } as never, "zh-TW");
  ok(block2.includes("81.505"), "（對照組）未收復的防守線要照報");
}

// ═══════════════════════════════════════════════════════════════════════════
section("【25】查詢當下那根：長下影線 = 向下跌破失敗");
// ═══════════════════════════════════════════════════════════════════════════
//
// A reader looks at the candle in front of them. If it is falling and has left a
// long lower wick, price was pushed down and bought straight back — the downward
// push failed. Judging only completed bars describes the market as of an hour ago.
// Observation tool, so there is no future bar to peek at; backtests never set this.
{
  const cfg = DEFAULT_MARKET_STATE_CONFIG;
  const base = [...flats(20, [100, 100.5, 99.5, 100])];

  // 下跌 + 下影線佔 89%（跟 TRXUSDT 那根一樣）
  const wickDown = makeCandles([
    ...base,
    [100, 100.1, 96.0, 97.0],        // 開100 收97 低96 → 下影線 1.0 / 全長 4.1 = 24%
  ]);
  const longWick = makeCandles([
    ...base,
    [100, 100.16, 96.0, 99.0],       // 下影線 3.0 / 全長 4.16 = 72%
  ]);

  const off = evaluateBreakout([], longWick, TF, cfg, { formingLast: false });
  eq(off.breakout.ssl, null, "沒開 formingLast → 規則不作用（回測不受影響）");

  const on = evaluateBreakout([], longWick, TF, cfg, { formingLast: true });
  eq(on.breakout.ssl?.status, "BREAKDOWN_FAILURE_WATCH", "下跌＋長下影線 → 向下跌破失敗");
  eq(on.breakout.ssl?.level, 96.0, "關卡就是影線的最低點");

  const mild = evaluateBreakout([], wickDown, TF, cfg, { formingLast: true });
  ok(mild.breakout.ssl?.status !== "BREAKDOWN_FAILURE_WATCH",
    "下影線不夠長（24%）→ 不算（不得把普通下跌當成失敗）");

  // 對稱：上漲 + 長上影線 → 向上突破失敗
  const upWick = makeCandles([
    ...base,
    [100, 104.0, 99.84, 101.0],      // 上影線 3.0 / 全長 4.16 = 72%
  ]);
  const up = evaluateBreakout([], upWick, TF, cfg, { formingLast: true });
  eq(up.breakout.bsl?.status, "BREAKOUT_FAILURE_WATCH", "上漲＋長上影線 → 向上突破失敗");
  eq(up.breakout.bsl?.level, 104.0, "關卡就是影線的最高點");
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("");
console.log("─".repeat(72));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
