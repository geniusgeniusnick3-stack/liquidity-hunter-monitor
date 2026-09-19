/**
 * Explain why a persisted level is not being returned by the engine.
 *
 * Run: NODE_ENV=production npx tsx artifacts/api-server/src/scripts/explain-missing-level.ts BTWUSDT 1h 0.38129
 *
 * READ-ONLY. The ledger remembers a level as ACTIVE until it is seen to be
 * consumed, so a row can outlive the engine's interest in that pivot. When a
 * measurement turns up such a row, the honest next step is to find out WHY the
 * engine dropped it rather than assume the worst:
 *
 *   SUPERSEDED  a higher high formed within the pivot window, so this price is
 *               no longer a local extreme. Existing structural invalidation —
 *               the pivot stopped being a pivot. Expected, not a bug.
 *   CONSUMED    price traded beyond the level after it formed, but the level
 *               was not in the engine's output at the time, so the ledger never
 *               learned. Would mean a real gap in the event pipeline.
 *   TRUNCATED   the pivot is still valid but scored outside the top-20 cut.
 *
 * The distinction matters: the first is correct behaviour, the second is a
 * genuine missed event, and the third is a capacity limit.
 */
import { fetchKlines } from "../lib/market/futures.js";
import { analyzeLiquidity, classifyLiquidityInteraction } from "../lib/smc/liquidity.js";
import { SMC_CONFIG } from "../lib/smc/config.js";
import { calcATR } from "../lib/smc/atr.js";
import { getLiquidityStore } from "../lib/persistence/LiquidityStore.js";

const symbol = (process.argv[2] ?? "").toUpperCase();
const timeframe = process.argv[3] ?? "1h";
const price = Number(process.argv[4]);

if (!symbol || !Number.isFinite(price)) {
  console.error("用法: explain-missing-level.ts <SYMBOL> <TIMEFRAME> <PRICE>");
  process.exit(1);
}

const DAY = 86_400;
const LIMIT = 500;

async function main(): Promise<void> {
  const store = getLiquidityStore();
  const candles = await fetchKlines(symbol, timeframe, LIMIT);
  const n = candles.length;
  const nowSec = Math.floor(Date.now() / 1000);

  console.log(`\n=== ${symbol} ${timeframe.toUpperCase()} — 價位 ${price} ===\n`);

  // ── 帳本紀錄 ──
  const rows = store.listLevels(symbol, timeframe).filter((l) => Math.abs(l.price - price) < price * 0.001);
  if (rows.length === 0) {
    console.log("帳本中找不到鄰近價位。");
    return;
  }
  const level = rows[0];
  const ageDays = ((nowSec - level.formedAt) / DAY).toFixed(1);
  console.log(`帳本：狀態 ${level.state}｜形成於 ${new Date(level.formedAt * 1000).toISOString()}｜年齡 ${ageDays} 天`);
  console.log(`      側別 ${level.side}｜觸及 ${level.touches} 次｜來源 ${level.source ?? "—"}`);

  // ── 窗內是否可見這個 pivot ──
  const formedIdx = candles.findIndex((c) => c.time === level.formedAt);
  if (formedIdx < 0) {
    console.log(`\n形成時間落在窗內之外（窗起點 ${new Date(candles[0].time * 1000).toISOString()}）。`);
    console.log("→ 屬於窗深不足，需要更深的歷史或持久化狀態。");
    return;
  }
  console.log(`\n形成位置：窗內第 ${formedIdx} 根 / 共 ${n} 根`);

  const windowSize = Math.min(20, Math.floor(n / 4));
  // A BSL pivot is a candle HIGH; an SSL pivot is a candle LOW. Taking the
  // wrong one silently compares against a price the level never was.
  const isBuySide = level.side === "BSL";
  const pivotPrice = isBuySide ? candles[formedIdx].high : candles[formedIdx].low;
  const levelPrice = pivotPrice;

  console.log(
    `pivot 價位：${pivotPrice}（帳本 ${level.price}｜差 ${(Math.abs(pivotPrice - level.price) / level.price * 100).toFixed(3)}%）`,
  );

  // ── 檢查一：是否仍是局部極值（既有結構失效規則）──
  // Mirrors the engine's own window test: a BSL pivot must be the highest high
  // nearby, an SSL pivot the lowest low.
  let superseded: { idx: number; price: number; deltaBars: number } | null = null;
  for (let j = Math.max(0, formedIdx - windowSize); j <= Math.min(formedIdx + windowSize, n - 1); j++) {
    if (j === formedIdx) continue;
    const p = isBuySide ? candles[j].high : candles[j].low;
    const worse = isBuySide ? p >= pivotPrice : p <= pivotPrice;
    if (!worse) continue;
    const deltaBars = j - formedIdx;
    const extremeMeasured = isBuySide ? p > (superseded?.price ?? -Infinity) : p < (superseded?.price ?? Infinity);
    if (!superseded || extremeMeasured) superseded = { idx: j, price: p, deltaBars };
  }

  if (superseded) {
    const kind = isBuySide ? "高點" : "低點";
    const rel = isBuySide ? "更高的高點" : "更低的低點";
    console.log(
      `\n✗ 不再是局部${kind}：第 ${superseded.idx} 根（${superseded.deltaBars >= 0 ? "+" : ""}${superseded.deltaBars} 根）${kind} ${superseded.price} vs pivot ${pivotPrice}`,
    );
    console.log(`→ 判定：SUPERSEDED（既有結構失效）——出現${rel}，這根 pivot 已不是 pivot，引擎忽略它是正確行為。`);
  } else {
    console.log(`\n✓ 仍是局部極值（±${windowSize} 根內，${isBuySide ? "最高" : "最低"} ${pivotPrice}）`);
  }

  // ── 檢查二：形成後價格是否已穿越（真正的漏報）──
  const atrPeriod = SMC_CONFIG.atrPeriodPerTf[timeframe] ?? SMC_CONFIG.atrPeriod;
  const atr = calcATR(candles, atrPeriod);
  const tolMultiple = SMC_CONFIG.liquidityToleranceAtrMultiple;

  let consumed: { idx: number; state: string; time: number } | null = null;
  for (let k = formedIdx + 1; k < n; k++) {
    const tol = Math.max((atr[k] ?? 0) * tolMultiple, 0);
    const state = classifyLiquidityInteraction(levelPrice, isBuySide, candles[k], tol);
    if (state === "SWEPT" || state === "BROKEN") {
      consumed = { idx: k, state, time: candles[k].time };
      break;
    }
  }

  if (consumed) {
    console.log(`\n⚠ 形成後價格已穿越：第 ${consumed.idx} 根（${new Date(consumed.time * 1000).toISOString()}）判定 ${consumed.state}`);
    console.log("→ 帳本若仍為 ACTIVE，表示這次穿越發生時該 level 不在引擎輸出中，事件沒被記錄。");
  } else {
    console.log(`\n✓ 形成後價格從未穿越（未解決，且未觸發 SWEPT/BROKEN）`);
  }

  // ── 檢查三：引擎目前是否回傳 ──
  const res = analyzeLiquidity(candles, timeframe, "crypto");
  const returned = res.pools.some((p) => Math.abs(p.price - levelPrice) < levelPrice * 0.001);
  console.log(`\n引擎目前回傳此價位：${returned ? "是" : "否"}`);
  console.log(`引擎回傳池數 ${res.pools.length}（上限 ${20}）${res.pools.length >= 20 ? " ← 已達上限，可能有價位被分數截掉" : ""}`);

  if (!returned && superseded) {
    console.log("\n結論：引擎不報它是因為它已被更極端的 pivot 取代（結構性失效），不是年齡或深度問題。");
  } else if (!returned && !superseded && consumed) {
    console.log("\n結論：這是真正的漏報 —— 價位有效且已被穿越，但事件未進入帳本。需要修管线。");
  } else if (!returned && !superseded && !consumed) {
    console.log("\n結論：價位有效、未穿越，卻不在引擎輸出中 → 疑似被 top-20 分數上限截掉。");
  } else if (returned && !superseded) {
    console.log("\n結論：引擎有回傳，帳本與引擎一致。");
  }
}

main().catch((err) => {
  console.error("EXPLAIN FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
