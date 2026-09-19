/**
 * Liquidity inspector — dumps everything the engine sees for one symbol/timeframe.
 *
 * Exists to answer questions like "did the engine notice that 9/15 break?" without
 * guessing: it lists every detected pool with its price, formation time, current
 * interaction state, WHICH candle produced that state, and the tolerance used.
 *
 * Run: NODE_ENV=production npx tsx artifacts/api-server/src/scripts/inspect-liquidity.ts BTCUSDT 1h
 */
import { fetchKlines } from "../lib/market/futures.js";
import { analyzeLiquidity } from "../lib/smc/liquidity.js";
import { SMC_CONFIG } from "../lib/smc/config.js";
import { calcATR } from "../lib/smc/atr.js";

const symbol = (process.argv[2] ?? "BTCUSDT").toUpperCase();
const timeframe = process.argv[3] ?? "1h";

function fmt(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

async function main(): Promise<void> {
  const candles = await fetchKlines(symbol, timeframe, 500);
  const atr = calcATR(candles, SMC_CONFIG.atrPeriodPerTf[timeframe] ?? SMC_CONFIG.atrPeriod);
  const atrPct = (atr[atr.length - 1] / candles[candles.length - 1].close) * 100;

  console.log(`=== ${symbol} ${timeframe.toUpperCase()} ==="`);
  console.log(`K 線 ${candles.length} 根：${fmt(candles[0].time)} ~ ${fmt(candles[candles.length - 1].time)}（台灣時間）`);
  console.log(`最後收盤 ${candles[candles.length - 1].close}｜ATR(${SMC_CONFIG.atrPeriodPerTf[timeframe] ?? 14}) = ${atrPct.toFixed(2)}% 價格`);
  console.log(`容忍度倍數 ${SMC_CONFIG.liquidityToleranceAtrMultiple} → 約 ${(atrPct * SMC_CONFIG.liquidityToleranceAtrMultiple).toFixed(3)}% 價格`);
  console.log(`pivot window = ${Math.min(20, Math.floor(candles.length / 4))} 根`);
  console.log("");

  const res = analyzeLiquidity(candles, timeframe, "crypto");
  console.log(`偵測到 ${res.pools.length} 條流動性（引擎只回傳分數前 20 名）`);
  console.log("─".repeat(100));
  console.log(
    "價位".padEnd(12) + "類型".padEnd(6) + "形成時間".padEnd(14) +
    "互動".padEnd(10) + "發生於".padEnd(14) + "已被取走".padEnd(10) + "觸及",
  );
  console.log("─".repeat(100));

  for (const p of [...res.pools].sort((a, b) => b.price - a.price)) {
    console.log(
      String(p.price).padEnd(12) +
      p.type.padEnd(6) +
      fmt(p.time).padEnd(14) +
      p.interaction.padEnd(10) +
      (p.interactionAt ? fmt(p.interactionAt) : "—").padEnd(14) +
      (p.wasSwept ? "是" : "否").padEnd(10) +
      String(p.touches),
    );
  }

  console.log("");
  console.log("=== 最近 12 根已完成的 K 線 ===");
  for (const c of candles.slice(-12)) {
    console.log(`  ${fmt(c.time)}  O${c.open} H${c.high} L${c.low} C${c.close}`);
  }
}

main().catch((err) => {
  console.error("INSPECT FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
