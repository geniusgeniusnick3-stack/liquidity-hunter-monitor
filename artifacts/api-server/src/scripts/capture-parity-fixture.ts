/**
 * Record a candle fixture for the mode-parity gate.
 *
 * The fixture is a RECORDING of real klines, not invented data: the gate needs a
 * non-empty, reproducible market so that "PASSIVE and ACTIVE agree" is a statement
 * about the two entry points rather than about what the market happened to be
 * doing that minute.
 *
 * Run once (re-run only to refresh the recording):
 *   npx tsx artifacts/api-server/src/scripts/capture-parity-fixture.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fetchKlines } from "../lib/market/futures.js";
import type { Candle } from "../lib/smc/types.js";

const SYMBOLS = (process.env.PARITY_SYMBOLS
  ?? "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT")
  .split(",").map((s) => s.trim()).filter(Boolean);

const TIMEFRAME = process.env.PARITY_TIMEFRAME ?? "1h";
const LIMIT = 500;

/**
 * Drop this many bars from the END of the recording.
 *
 * A recording is only useful as a gate if the market in it produced something to
 * compare: on a calm stretch both entry points report nothing, and two empty
 * results agree with each other trivially. The most recent bar is therefore NOT
 * automatically the right place to end a recording — this lets the fixture stop
 * at a moment that actually has an event, which is a normal way to choose a
 * fixture and is still real recorded data.
 */
const DROP_LAST = Number(process.env.PARITY_FIXTURE_DROP_LAST ?? 0);

const OUT = path.resolve(import.meta.dirname, "../../fixtures/parity_candles.json");

async function main(): Promise<void> {
  const fixture: Record<string, Candle[]> = {};

  for (const symbol of SYMBOLS) {
    try {
      // fetchKlines already drops the forming bar (it carries a close time per
      // row), so every recorded bar is a closed one — which is what lets the
      // replay declare "proven" closure honestly.
      const fetched = await fetchKlines(symbol, TIMEFRAME, LIMIT);
      const candles = DROP_LAST > 0 ? fetched.slice(0, -DROP_LAST) : fetched;
      fixture[`${symbol}|${TIMEFRAME}`] = candles;
      console.log(`${symbol} ${TIMEFRAME}: ${candles.length} 根，最後一根 ${candles.at(-1)?.time}`);
    } catch (err) {
      console.log(`${symbol}: 取得失敗 — ${err instanceof Error ? err.message : err}`);
    }
  }

  const series = Object.keys(fixture).length;
  if (series === 0) {
    console.error("沒有任何序列被錄下 —— 不寫檔（避免產生一個空 fixture 讓閘門假通過）");
    process.exit(1);
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(fixture), "utf8");
  console.log(`\n寫入 ${OUT}（${series} 個序列）`);
}

await main();
