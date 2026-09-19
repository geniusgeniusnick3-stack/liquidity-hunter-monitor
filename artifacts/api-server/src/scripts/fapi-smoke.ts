/**
 * Smoke test for the USDT-M futures data layer (REQUIREMENTS §3).
 *
 * Verifies every public input the Dynamic Universe needs, then feeds real
 * futures candles through the UNMODIFIED SMC engine to prove the data layer
 * and the engine agree on the Candle contract.
 *
 * Run:
 *   NODE_ENV=production npx tsx artifacts/api-server/src/scripts/fapi-smoke.ts
 */
import {
  fetchKlines,
  fetchExchangeInfo,
  fetchAll24hTickers,
  fetchAllBookTickers,
  fetchAllFunding,
  fetchOpenInterest,
  getActiveBase,
} from "../lib/market/futures.js";
import { buildReport } from "../lib/smc/report.js";

const out = (s = "") => console.log(s);

async function main(): Promise<void> {
  out("=== 1. 永續合約清單（fapi/v1/exchangeInfo） ===");
  const info = await fetchExchangeInfo();
  out(`   USDT 永續交易中：${info.length} 個`);
  out(`   取樣：${info.slice(0, 8).map((x) => x.symbol).join(", ")}`);
  const withDate = info.filter((x) => x.onboardDate);
  out(`   有上市日期欄位：${withDate.length}/${info.length}`);
  if (withDate[0]?.onboardDate) {
    out(`   範例 ${withDate[0].symbol} 上市於 ${new Date(withDate[0].onboardDate!).toISOString().slice(0, 10)}`);
  }

  out("\n=== 2. 全市場 24h 成交量（一次請求） ===");
  const tickers = await fetchAll24hTickers();
  const sorted = [...tickers].sort((a, b) => b.quoteVolume - a.quoteVolume);
  out(`   ${tickers.length} 個 symbol`);
  out(`   量最大 5：${sorted.slice(0, 5).map((t) => `${t.symbol} ${(t.quoteVolume / 1e6).toFixed(0)}M`).join(" | ")}`);
  out(`   量最小 5：${sorted.slice(-5).map((t) => `${t.symbol} ${(t.quoteVolume / 1e6).toFixed(3)}M`).join(" | ")}`);

  out("\n=== 3. 買賣價差（一次請求） ===");
  const books = await fetchAllBookTickers();
  out(`   ${books.length} 個 symbol`);
  for (const s of ["BTCUSDT", "SUIUSDT"]) {
    const b = books.find((x) => x.symbol === s);
    if (b) out(`   ${s}: bid ${b.bidPrice} / ask ${b.askPrice} → ${b.spreadBps.toFixed(2)} bps`);
  }
  const spreads = books.map((b) => b.spreadBps).sort((a, b) => a - b);
  out(`   價差中位數 ${spreads[Math.floor(spreads.length / 2)].toFixed(2)} bps`);

  out("\n=== 4. 持倉量 OI + 資金費率 ===");
  const oi = await fetchOpenInterest("SUIUSDT");
  out(`   SUIUSDT OI = ${(oi.openInterest / 1e6).toFixed(1)}M 張 @ ${new Date(oi.time).toISOString()}`);
  const funding = await fetchAllFunding();
  const sf = funding.find((f) => f.symbol === "SUIUSDT");
  if (sf) out(`   SUIUSDT funding = ${(sf.lastFundingRate * 100).toFixed(4)}% / mark ${sf.markPrice}`);

  out("\n=== 5. 真實 K 線 → 未改動的 SMC 引擎 ===");
  for (const sym of ["BTCUSDT", "ETHUSDT", "SUIUSDT"]) {
    const candles = await fetchKlines(sym, "4h", 500);
    const daily = await fetchKlines(sym, "1d", 120);
    const zeroVol = candles.filter((c) => c.volume === 0).length;
    const gaps = candles.filter((c, i) => i > 0 && c.time - candles[i - 1].time !== 14_400).length;

    out(`\n   ${sym}`);
    out(`     4h K 線 ${candles.length} 根（成交量為 0：${zeroVol} 根；時間不連續：${gaps} 處）`);
    out(`     1d K 線 ${daily.length} 根`);

    if (candles.length < 50) { out("     ⚠️ 資料不足，跳過引擎"); continue; }

    const report = buildReport(candles, sym, "crypto", "4h", { dailyCandles: daily });
    out(`     價格 ${report.currentPrice}`);
    out(`     結構 ${report.structure.trend} / ${report.structure.bias}（信心 ${report.structure.confidence.toFixed(2)}）phase=${report.structure.phase}`);
    out(`     流動性池 ${report.liquidity.pools.length} 個 | OB ${report.orderBlocks.length} | FVG ${report.fvg.length} | draw ${report.draw.length}`);
    out(`     日線偏向 ${report.dailyBias.bias} | session ${report.sessionState}`);
  }

  out(`\n=== 使用中的端點：${getActiveBase()} ===`);
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
