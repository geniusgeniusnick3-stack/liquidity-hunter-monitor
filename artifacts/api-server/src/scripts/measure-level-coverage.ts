/**
 * Coverage measurement: are persisted unresolved levels still reaching a scan?
 *
 * Run: NODE_ENV=production npx tsx artifacts/api-server/src/scripts/measure-level-coverage.ts
 *
 * READ-ONLY. Calls the real engine and the real ledger but writes nothing — no
 * upsert, no setState. It answers one question with numbers instead of
 * reasoning: of the unresolved levels this system has on record, how many does
 * a live scan actually see?
 *
 * Why it matters: the ledger is the only memory of a level that has scrolled
 * out of the candle window. If a scan only ever reports what the engine returns
 * afresh, then a persisted level can be invisible to every future scan — which
 * is exactly the failure the P0 correction set out to remove, just arriving
 * through a different door.
 */
import { fetchKlines } from "../lib/market/futures.js";
import { analyzeLiquidity, classifyLiquidityInteraction } from "../lib/smc/liquidity.js";
import { SMC_CONFIG } from "../lib/smc/config.js";
import { calcATR } from "../lib/smc/atr.js";
import { getLiquidityStore } from "../lib/persistence/LiquidityStore.js";
import { liquidityLevelId } from "../lib/events/Deduplicator.js";
import type { Candle } from "../lib/smc/types.js";
import type { LiquiditySide } from "../lib/notify/formatters.js";

type MissingKind = "superseded" | "consumed" | "truncated" | "out-of-window";

/**
 * Why is a persisted level absent from the engine's output?
 *
 *   superseded    a more extreme pivot formed nearby, so this is no longer a
 *                 local extreme. Existing structural invalidation — correct.
 *   consumed      price traded through it after it formed, but the event never
 *                 reached the ledger. A real missed event.
 *   truncated     still valid, still untouched, simply outscored by the top-20
 *                 cut. A capacity limit, not a structural verdict.
 *   out-of-window formed before the candles we hold.
 */
function classifyMissing(
  level: { side: LiquiditySide; price: number; formedAt: number },
  candles: Candle[],
  timeframe: string,
): MissingKind {
  const idx = candles.findIndex((c) => c.time === level.formedAt);
  if (idx < 0) return "out-of-window";

  const isBuySide = level.side === "BSL";
  const pivot = isBuySide ? candles[idx].high : candles[idx].low;
  const windowSize = Math.min(20, Math.floor(candles.length / 4));

  for (let j = Math.max(0, idx - windowSize); j <= Math.min(idx + windowSize, candles.length - 1); j++) {
    if (j === idx) continue;
    const p = isBuySide ? candles[j].high : candles[j].low;
    if (isBuySide ? p >= pivot : p <= pivot) return "superseded";
  }

  const atr = calcATR(candles, SMC_CONFIG.atrPeriodPerTf[timeframe] ?? SMC_CONFIG.atrPeriod);
  for (let k = idx + 1; k < candles.length; k++) {
    const tol = Math.max((atr[k] ?? 0) * SMC_CONFIG.liquidityToleranceAtrMultiple, 0);
    const state = classifyLiquidityInteraction(pivot, isBuySide, candles[k], tol);
    if (state === "SWEPT" || state === "BROKEN") return "consumed";
  }

  return "truncated";
}

const SYMBOLS = (process.argv[2] ?? "BTCUSDT,ETHUSDT,SOLUSDT,TRXUSDT,XRPUSDT,SUIUSDT,XLMUSDT,DOGEUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase());
const TIMEFRAMES = (process.argv[3] ?? "1h,4h").split(",").map((s) => s.trim());

const CANDLE_LIMIT = 500;
const DAY = 86_400;

async function main(): Promise<void> {
  const store = getLiquidityStore();
  const nowSec = Math.floor(Date.now() / 1000);

  let totalPersisted = 0;
  let totalEngine = 0;
  let totalMissing = 0;
  const missingOld: Array<{ symbol: string; tf: string; price: number; ageDays: number; state: string }> = [];
  const kindCounts: Record<MissingKind, number> = {
    superseded: 0, consumed: 0, truncated: 0, "out-of-window": 0,
  };
  const noteworthy: Array<{
    symbol: string; tf: string; price: number; kind: MissingKind; ageDays: number; state: string;
  }> = [];

  console.log(
    "symbol        tf  窗內根數  窗涵蓋天數  引擎回傳  帳本未解決  引擎看不到  其中>7天",
  );
  console.log("─".repeat(94));

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      let candles;
      try {
        candles = await fetchKlines(symbol, tf, CANDLE_LIMIT);
      } catch {
        console.log(`${symbol.padEnd(13)} ${tf.padEnd(4)} 取 K 線失敗`);
        continue;
      }
      if (candles.length === 0) continue;

      const spanDays = ((candles[candles.length - 1].time - candles[0].time) / DAY).toFixed(1);

      // What the engine reports right now.
      const res = analyzeLiquidity(candles, tf, "crypto");
      const engineIds = new Set(
        res.pools.map((p) =>
          liquidityLevelId(symbol, tf, (p.type === "SSL" ? "SSL" : "BSL") as LiquiditySide, p.time, p.price),
        ),
      );

      // What the ledger holds and still considers unresolved.
      const persisted = store
        .listLevels(symbol, tf)
        .filter((l) => l.state === "ACTIVE" || l.state === "APPROACHING" || l.state === "TOUCHED");

      const missing = persisted.filter((l) => !engineIds.has(l.id));
      const missingOver7 = missing.filter((l) => (nowSec - l.formedAt) / DAY > 7);

      for (const l of missing) {
        const kind = classifyMissing(l, candles, tf);
        kindCounts[kind]++;
        if (kind === "truncated" || kind === "consumed") {
          noteworthy.push({
            symbol, tf, price: l.price, kind,
            ageDays: Math.floor((nowSec - l.formedAt) / DAY),
            state: l.state,
          });
        }
      }

      totalPersisted += persisted.length;
      totalEngine += engineIds.size;
      totalMissing += missing.length;

      for (const l of missingOver7) {
        missingOld.push({
          symbol,
          tf,
          price: l.price,
          ageDays: Math.floor((nowSec - l.formedAt) / DAY),
          state: l.state,
        });
      }

      console.log(
        `${symbol.padEnd(13)} ${tf.padEnd(4)} ${String(candles.length).padStart(8)} ` +
        `${spanDays.padStart(11)} ${String(engineIds.size).padStart(9)} ` +
        `${String(persisted.length).padStart(11)} ${String(missing.length).padStart(11)} ` +
        `${String(missingOver7.length).padStart(9)}`,
      );
    }
  }

  console.log("─".repeat(94));
  console.log(
    `\n帳本未解決合計 ${totalPersisted}｜引擎回傳合計 ${totalEngine}｜引擎看不到 ${totalMissing}`,
  );

  if (missingOld.length > 0) {
    console.log(`\n其中「>7 天且引擎看不到」的 level（前 25 筆）：`);
    for (const m of missingOld.slice(0, 25)) {
      console.log(
        `  ${m.symbol} ${m.tf.toUpperCase()} ${m.price} — 年齡 ${m.ageDays} 天，帳本狀態 ${m.state}`,
      );
    }
    console.log(`  …共 ${missingOld.length} 筆`);
  } else {
    console.log("\n沒有「>7 天且引擎看不到」的 level —— 目前窗深足以涵蓋帳本中的未解決價位。");
  }

  console.log(`\n引擎看不到的原因分類：`);
  console.log(
    `  已被更極端 pivot 取代（結構性失效，正確）：${kindCounts.superseded}`,
  );
  console.log(`  已穿越但事件未入帳（真漏報）：${kindCounts.consumed}`);
  console.log(`  有效、未穿越、被 top-20 分數截掉（容量限制）：${kindCounts.truncated}`);
  console.log(`  形成於窗外：${kindCounts["out-of-window"]}`);

  if (noteworthy.length > 0) {
    console.log(`\n需要處理的案例（前 20 筆）：`);
    for (const w of noteworthy.slice(0, 20)) {
      console.log(
        `  [${w.kind}] ${w.symbol} ${w.tf.toUpperCase()} ${w.price} — 年齡 ${w.ageDays} 天，帳本 ${w.state}`,
      );
    }
    console.log(`  …共 ${noteworthy.length} 筆`);
  }

  console.log(
    `\n註：窗深＝${CANDLE_LIMIT} 根。1H ≈ ${(CANDLE_LIMIT / 24).toFixed(1)} 天、4H ≈ ${(CANDLE_LIMIT / 6).toFixed(1)} 天。`,
  );
}

main().catch((err) => {
  console.error("MEASURE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
