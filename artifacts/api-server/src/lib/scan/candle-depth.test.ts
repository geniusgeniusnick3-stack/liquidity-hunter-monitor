/**
 * Scan history depth — the guarantee behind "a level does not expire with age".
 *
 * Run: npx tsx artifacts/api-server/src/lib/scan/candle-depth.test.ts
 *
 * Removing a seven-day expiry is only half the correction. A level is visible
 * to a scan for exactly as long as it sits inside the candle window, so if the
 * window were shallower than the horizon the requirement talks about, unresolved
 * liquidity would still fall off the end — just without a rule saying so.
 *
 * This test turns that into something enforced: it converts SCAN_CANDLE_LIMIT
 * into days per timeframe and fails if the depth stops covering the horizon.
 * A silent change to the constant is a silent change to how far back liquidity
 * can be found, which is precisely the kind of thing that should break a test.
 */
import { readFileSync } from "node:fs";
import { SCAN_CANDLE_LIMIT } from "./ScanEngine.js";
import { TF_MS } from "../market/CandleCache.js";
import { loadConfig } from "../config/index.js";

let passed = 0;
let failed = 0;

function ok(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

const MS_PER_DAY = 86_400_000;

/** How many days of history `candles` bars of `timeframe` span. */
function spanDays(timeframe: string, candles: number = SCAN_CANDLE_LIMIT): number {
  const ms = TF_MS[timeframe];
  if (!ms) throw new Error(`unknown timeframe ${timeframe}`);
  return (candles * ms) / MS_PER_DAY;
}

/**
 * The floor the P0 correction establishes: an unresolved level must still be
 * discoverable well past one week. Anything shallower would reintroduce the
 * deletion-by-calendar the correction removed, only implicitly.
 */
const REQUIRED_MIN_SPAN_DAYS = 7;

/** The longest specific case the correction names: a 4H level 20 days old. */
const REQUIRED_4H_SPAN_DAYS = 20;

console.log("\n【窗深 → 可回溯天數】每次掃描載入的 K 線數，換算成天數");
console.log(`  SCAN_CANDLE_LIMIT = ${SCAN_CANDLE_LIMIT} 根\n`);
console.log("  時框    每根    窗深天數");
console.log("  " + "─".repeat(30));

const config = loadConfig();
const scanned = config.timeframes;

for (const tf of scanned) {
  const days = spanDays(tf);
  const ms = TF_MS[tf]!;
  const unit = ms >= MS_PER_DAY ? `${ms / MS_PER_DAY}天`
    : ms >= 3_600_000 ? `${ms / 3_600_000}小時`
    : `${ms / 60_000}分`;
  console.log(`  ${tf.padEnd(6)} ${unit.padStart(6)} ${days.toFixed(1).padStart(11)}`);
}

console.log("\n【涵蓋範圍】每個被掃描的時框都要超過最低保證");

for (const tf of scanned) {
  const days = spanDays(tf);
  ok(
    days >= REQUIRED_MIN_SPAN_DAYS,
    `${tf.toUpperCase()} 窗深 ${days.toFixed(1)} 天 ≥ ${REQUIRED_MIN_SPAN_DAYS} 天（未解決 level 不會因年齡消失）`,
  );
}

console.log("\n【P0 具名案例】4H 20 天前的 level 必須仍在窗內");

{
  const days = spanDays("4h");
  ok(
    days >= REQUIRED_4H_SPAN_DAYS,
    `4H 窗深 ${days.toFixed(1)} 天 ≥ ${REQUIRED_4H_SPAN_DAYS} 天（規格中「20 天前形成」的案例）`,
  );
}

console.log("\n【一致性】快取層不得比掃描層淺");

{
  // CandleCache.get defaults to 500 as well, and it refuses to serve a cached
  // array shorter than the limit asked for. If those two drift, ACTIVE mode
  // would analyse a shallower window than PASSIVE mode on the same timeframe —
  // the two modes would stop being the same analysis.
  const src = readFileSync(new URL("../market/CandleCache.ts", import.meta.url), "utf8");
  const m = src.match(/async get\(symbol: string, timeframe: string, limit = (\d+)\)/);
  const cacheDefault = m ? Number(m[1]) : null;
  ok(
    cacheDefault === SCAN_CANDLE_LIMIT,
    `CandleCache 預設 ${cacheDefault} 根 = SCAN_CANDLE_LIMIT ${SCAN_CANDLE_LIMIT} 根`,
  );
}

console.log("\n" + "─".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
