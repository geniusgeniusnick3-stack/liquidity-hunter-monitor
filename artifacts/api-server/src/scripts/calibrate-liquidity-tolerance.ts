/**
 * Calibration scan for the liquidity tolerance multiplier.
 *
 * The tolerance decides how far past a level price must trade before it counts
 * as "traded beyond". It must not be an arbitrary constant, so this script
 * measures the classification mix against REAL Binance USDT-M data across a
 * range of ATR multiples and prints the distribution.
 *
 * What to look for:
 *   - multiplier 0       → every hair-past-the-level flick counts (over-reports)
 *   - multiplier too big → genuine breaks get miscategorised as sweeps
 *   - the useful range is where BROKEN counts stabilise (the tiny-touch noise
 *     has been filtered out) but have not yet collapsed
 *
 * Run: NODE_ENV=production npx tsx artifacts/api-server/src/scripts/calibrate-liquidity-tolerance.ts
 */
import { SMC_CONFIG } from "../lib/smc/config.js";
import { analyzeLiquidity } from "../lib/smc/liquidity.js";
import { fetchKlines } from "../lib/market/futures.js";
import { calcATR } from "../lib/smc/atr.js";
import type { Candle } from "../lib/smc/types.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "DOGEUSDT", "XRPUSDT", "LINKUSDT", "AVAXUSDT"];
const TIMEFRAME = "4h";
const MULTIPLIERS = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];

interface Counts { swept: number; broken: number; touched: number; none: number; total: number; }

function emptyCounts(): Counts {
  return { swept: 0, broken: 0, touched: 0, none: 0, total: 0 };
}

async function main(): Promise<void> {
  console.log(`=== 取得 ${SYMBOLS.length} 個幣的 ${TIMEFRAME} 真實資料 ===`);

  const series = new Map<string, Candle[]>();
  const atrPct = new Map<string, number>();

  for (const sym of SYMBOLS) {
    const candles = await fetchKlines(sym, TIMEFRAME, 500);
    series.set(sym, candles);

    // ATR as a percentage of price — shows why a fixed % threshold cannot work.
    const atr = calcATR(candles, SMC_CONFIG.atrPeriodPerTf[TIMEFRAME] ?? 14);
    const last = candles[candles.length - 1]?.close ?? 0;
    const a = atr[atr.length - 1] ?? 0;
    atrPct.set(sym, last > 0 ? (a / last) * 100 : 0);
  }

  console.log("\n各幣的 ATR（14, 4H）佔價格百分比 — 顯示固定百分比為何不可行：");
  for (const [sym, pct] of [...atrPct.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sym.padEnd(12)} ${pct.toFixed(2)}%`);
  }
  const vals = [...atrPct.values()];
  const ratio = Math.max(...vals) / Math.min(...vals);
  console.log(`  → 最高與最低相差 ${ratio.toFixed(1)} 倍（單一固定百分比不可能同時適用）`);

  console.log("\n=== 各 multiplier 下的分類分布 ===");
  console.log("  mult     SWEPT  BROKEN  TOUCHED   NONE   總計   已被取走%   BROKEN佔比");

  const results: Array<{ mult: number; counts: Counts }> = [];

  for (const mult of MULTIPLIERS) {
    (SMC_CONFIG as { liquidityToleranceAtrMultiple: number }).liquidityToleranceAtrMultiple = mult;

    const counts = emptyCounts();
    for (const sym of SYMBOLS) {
      const candles = series.get(sym) ?? [];
      const res = analyzeLiquidity(candles, TIMEFRAME, "crypto");
      for (const p of res.pools) {
        counts.total++;
        if (p.interaction === "SWEPT") counts.swept++;
        else if (p.interaction === "BROKEN") counts.broken++;
        else if (p.interaction === "TOUCHED") counts.touched++;
        else counts.none++;
      }
    }

    const consumed = counts.swept + counts.broken;
    const consumedPct = counts.total ? (consumed / counts.total) * 100 : 0;
    const brokenShare = consumed ? (counts.broken / consumed) * 100 : 0;

    console.log(
      `  ${mult.toFixed(2).padStart(5)}  ` +
      `${String(counts.swept).padStart(6)}  ${String(counts.broken).padStart(6)}  ` +
      `${String(counts.touched).padStart(7)}  ${String(counts.none).padStart(5)}  ` +
      `${String(counts.total).padStart(6)}  ${consumedPct.toFixed(1).padStart(9)}%  ` +
      `${brokenShare.toFixed(1).padStart(9)}%`,
    );

    results.push({ mult, counts });
  }

  // Stability heuristic: the multiplier where BROKEN's share of consumed levels
  // stops falling sharply is where sub-noise flicks have been filtered out.
  console.log("\n=== 判讀 ===");
  const base = results.find((r) => r.mult === 0);
  if (base) {
    const baseBroken = base.counts.broken;
    for (const r of results) {
      if (r.mult === 0) continue;
      const delta = baseBroken - r.counts.broken;
      const pct = baseBroken ? (delta / baseBroken) * 100 : 0;
      console.log(`  mult ${r.mult.toFixed(2)}：BROKEN 由 ${baseBroken} 降至 ${r.counts.broken}（-${pct.toFixed(1)}%），SWEPT ${r.counts.swept}`);
    }
  }
  console.log("\n判準：選「BROKEN 已被顯著過濾、但尚未把真突破也吃掉」的倍數。");
}

main().catch((err) => {
  console.error("CALIBRATION FAILED:", err);
  process.exit(1);
});
