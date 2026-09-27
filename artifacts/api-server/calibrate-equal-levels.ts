/**
 * Calibration: how wide should the EQH/EQL pairing tolerance be?
 *
 * Runs the REAL engine over real Binance data at several multiples and reports
 * how many merged levels reach the reported output. Run from artifacts/api-server:
 *   npx tsx calibrate-equal-levels.ts
 */
import { SMC_CONFIG } from "./src/lib/smc/config.js";
import { analyzeLiquidity } from "./src/lib/smc/liquidity.js";
import type { Candle } from "./src/lib/smc/types.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "XRPUSDT", "SUIUSDT", "ARBUSDT", "1000PEPEUSDT"];
const TFS = ["1h", "4h"];

async function klines(symbol: string, interval: string): Promise<Candle[]> {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=500`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol} ${interval}: ${text.slice(0, 200)}`);
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON for ${symbol} ${interval}: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(j)) throw new Error(`unexpected shape for ${symbol} ${interval}: ${text.slice(0, 200)}`);
  return (j as unknown[][]).map((k) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
    volume: Number(k[5]),
  })) as Candle[];
}

const data: Array<{ sym: string; tf: string; candles: Candle[] }> = [];
for (const sym of SYMBOLS) {
  for (const tf of TFS) {
    data.push({ sym, tf, candles: await klines(sym, tf) });
  }
}
console.log(`載入 ${data.length} 組資料（${SYMBOLS.length} 幣 x ${TFS.length} 時框，各 500 根）\n`);

const multiples = [0.05, 0.1, 0.15, 0.2, 0.25, 0.35, 0.5];
console.log("k(ATR倍)   報告水位數  EQH  EQL  合併後   原B/S 被合併掉的");
for (const k of multiples) {
  (SMC_CONFIG as unknown as { equalLevelAtrMultiple: number }).equalLevelAtrMultiple = k;
  let reported = 0, eqh = 0, eql = 0;
  for (const d of data) {
    const res = analyzeLiquidity(d.candles, d.tf, "crypto");
    reported += res.pools.length;
    eqh += res.pools.filter((p) => p.type === "EQH").length;
    eql += res.pools.filter((p) => p.type === "EQL").length;
  }
  // merged-away count = how many BSL/SSL would have existed without merging
  (SMC_CONFIG as unknown as { equalLevelAtrMultiple: number }).equalLevelAtrMultiple = 0;
  let unmerged = 0;
  for (const d of data) {
    const res = analyzeLiquidity(d.candles, d.tf, "crypto");
    unmerged += res.pools.length;
  }
  console.log(
    `k=${k.toFixed(2)}      ${String(reported).padStart(4)}     ${String(eqh).padStart(3)}  ${String(eql).padStart(3)}`
    + `   ${String(eqh + eql).padStart(4)}    ${String(unmerged).padStart(4)}   ${String(unmerged - reported).padStart(4)}`,
  );
}

// One worked example, at the current config value, so the pairing is visible.
(SMC_CONFIG as unknown as { equalLevelAtrMultiple: number }).equalLevelAtrMultiple = 0.25;
const sample = data.find((d) => d.sym === "BTCUSDT" && d.tf === "4h")!;
const res = analyzeLiquidity(sample.candles, sample.tf, "crypto");
const merged = res.pools.filter((p) => p.type === "EQH" || p.type === "EQL");
console.log(`\n例：BTCUSDT 4H — 報告 ${res.pools.length} 條，其中等價 ${merged.length} 條`);
for (const p of merged.slice(0, 3)) {
  const m = p.equalLevelMembers ?? [];
  console.log(
    `  ${p.type} @ ${p.price}  touches=${p.touches}  members=${m.length}`
    + ` (${m.map((x) => x.price).join(" / ")})`,
  );
}
