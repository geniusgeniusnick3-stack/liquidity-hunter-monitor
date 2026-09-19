/**
 * Coverage measurement: does a scan see every unresolved level on record?
 *
 * Run: NODE_ENV=production npx tsx artifacts/api-server/src/scripts/measure-level-coverage.ts
 *
 * READ-ONLY. Writes nothing — no upsert, no setState.
 *
 * Why this exists: a level is only visible to a scan while its candle sits
 * inside the loaded window AND its index has not drifted past the point where
 * the engine starts looking for pivots. The ledger is the second chance for
 * anything that slips through both. This script says, in numbers, how often
 * each path is doing the work — and, more importantly, whether anything is
 * falling through both.
 *
 * It uses the production restore path rather than a copy of the logic. An audit
 * tool that reimplements what it is auditing can only confirm its own
 * assumptions.
 */
import { fetchKlines } from "../lib/market/futures.js";
import { analyzeLiquidity } from "../lib/smc/liquidity.js";
import { getLiquidityStore } from "../lib/persistence/LiquidityStore.js";
import { liquidityLevelId } from "../lib/events/Deduplicator.js";
import { restorePersistedLevels } from "../lib/scan/RestoredLevels.js";
import type { LiquiditySide } from "../lib/notify/formatters.js";

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
  let totalRecovered = 0;
  let totalUnseen = 0;

  const reasons: Record<string, number> = {};
  const unseenDetail: Array<{
    symbol: string; tf: string; price: number; reason: string; ageDays: number; state: string;
  }> = [];

  console.log(
    "symbol        tf  窗深天數  引擎回傳  帳本未解決  帳本補回  掃描看不到",
  );
  console.log("─".repeat(80));

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

      const res = analyzeLiquidity(candles, tf, "crypto");
      const engineIds = new Set(
        res.pools.map((p) =>
          liquidityLevelId(symbol, tf, (p.type === "SSL" ? "SSL" : "BSL") as LiquiditySide, p.time, p.price),
        ),
      );

      const persisted = store
        .listLevels(symbol, tf)
        .filter((l) => l.state === "ACTIVE" || l.state === "APPROACHING" || l.state === "TOUCHED");

      // Levels the engine cannot see, put through the same restore path a scan
      // uses. Restored ones are visible to a scan; the rest tell us why.
      const candidates = persisted.filter((l) => !engineIds.has(l.id));
      const outcome = restorePersistedLevels({
        candidates, candles, timeframe: tf, engineIds,
      });

      for (const s of outcome.skipped) {
        if (s.reason === "in-engine-output") continue; // not a candidate
        reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
        const l = candidates.find((c) => c.id === s.id);
        if (l && s.reason !== "superseded") {
          unseenDetail.push({
            symbol, tf, price: l.price, reason: s.reason,
            ageDays: Math.floor((nowSec - l.formedAt) / DAY), state: l.state,
          });
        }
      }

      const unseen = outcome.skipped.filter((s) => s.reason !== "in-engine-output").length;

      totalPersisted += persisted.length;
      totalEngine += engineIds.size;
      totalRecovered += outcome.restored.length;
      totalUnseen += unseen;

      console.log(
        `${symbol.padEnd(13)} ${tf.padEnd(4)} ${spanDays.padStart(8)} ${String(engineIds.size).padStart(9)} ` +
        `${String(persisted.length).padStart(11)} ${String(outcome.restored.length).padStart(9)} ` +
        `${String(unseen).padStart(11)}`,
      );
    }
  }

  console.log("─".repeat(80));
  console.log(
    `\n帳本未解決合計 ${totalPersisted}｜引擎直接回傳 ${totalEngine}｜` +
    `帳本補回 ${totalRecovered}｜掃描仍看不到 ${totalUnseen}`,
  );

  console.log(`\n掃描看不到的原因：`);
  console.log(`  已被更極端 pivot 取代（結構性失效，正確）：${reasons.superseded ?? 0}`);
  console.log(`  已穿越但事件未入帳（真漏報）：${reasons.consumed ?? 0}`);
  console.log(`  形成時間落在窗外（需要更深的歷史）：${reasons["formed-outside-window"] ?? 0}`);
  console.log(`  帳本價位與 K 線極值不符（無法核對）：${reasons["price-mismatch"] ?? 0}`);

  if (unseenDetail.length > 0) {
    console.log(`\n需要處理的案例（前 20 筆）：`);
    for (const u of unseenDetail.slice(0, 20)) {
      console.log(
        `  [${u.reason}] ${u.symbol} ${u.tf.toUpperCase()} ${u.price} — 年齡 ${u.ageDays} 天，帳本 ${u.state}`,
      );
    }
    console.log(`  …共 ${unseenDetail.length} 筆`);
  } else {
    console.log(`\n沒有需要處理的案例：掃描看得到每一個未解決價位。`);
  }

  console.log(
    `\n註：窗深＝${CANDLE_LIMIT} 根。1H ≈ ${(CANDLE_LIMIT / 24).toFixed(1)} 天、4H ≈ ${(CANDLE_LIMIT / 6).toFixed(1)} 天。`,
  );
}

main().catch((err) => {
  console.error("MEASURE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
