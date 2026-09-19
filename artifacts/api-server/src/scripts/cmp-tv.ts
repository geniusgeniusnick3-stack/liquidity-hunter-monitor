/**
 * Side-by-side comparison helper.
 *
 * Prints recent candles and detected liquidity pools for one symbol/timeframe so
 * the output can be checked line-by-line against a TradingView chart of the same
 * market (BINANCE:<SYMBOL>.P). Used to satisfy the "verify against TradingView"
 * acceptance step rather than asserting the engine is correct on test evidence
 * alone.
 */
import { fetchKlines } from "../lib/market/futures.js";
import { analyzeLiquidity } from "../lib/smc/liquidity.js";

const symbol = (process.argv[2] ?? "TRXUSDT").toUpperCase();
const tf = (process.argv[3] ?? "1h").toLowerCase();

function taipei(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei", hour12: false,
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

(async () => {
  const candles = await fetchKlines(symbol, tf, 500);

  console.log(`=== ${symbol} ${tf.toUpperCase()} 最近 6 根已收盤 K 線（台灣時間）===`);
  for (const c of candles.slice(-6)) {
    console.log(
      `  ${taipei(c.time)}  O ${c.open}  H ${c.high}  L ${c.low}  C ${c.close}  Vol ${c.volume}`,
    );
  }

  const res = analyzeLiquidity(candles, tf, "crypto");
  console.log("");
  console.log(`=== 引擎偵測到的流動性價位 ===`);
  const pools = [...res.pools].sort((a, b) => b.price - a.price);
  for (const p of pools) {
    const state = p.interaction ?? (p.wasSwept ? "SWEPT" : "ACTIVE");
    console.log(
      `  ${p.type}  ${p.price}  形成於 ${taipei(p.time)}  觸及 ${p.touches} 次  狀態 ${state}`,
    );
  }
  console.log(`  （共 ${pools.length} 條）`);
})();
