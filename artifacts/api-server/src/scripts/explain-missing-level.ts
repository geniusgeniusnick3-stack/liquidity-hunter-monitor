/**
 * Explain what a scan does with one specific persisted level.
 *
 * Run: NODE_ENV=production npx tsx artifacts/api-server/src/scripts/explain-missing-level.ts PENGUUSDT 1h 0.009333
 *
 * READ-ONLY. Answers "why is this price not showing up?" with the production
 * verdict rather than a second opinion: the level goes through the same restore
 * path a scan uses, and whatever that returns is the answer.
 *
 * The extra columns are context, not a rival judgement — where the level sits in
 * the window, and whether anything more extreme formed nearby.
 *
 * Verdicts:
 *   visible      the engine returns it directly
 *   recovered    the engine cannot see it, but the ledger restores it — a scan
 *                does report this level
 *   superseded   a more extreme pivot formed nearby, so this is no longer a
 *                pivot. Existing structural invalidation; correct to ignore.
 *   consumed     price traded through it. It is history, not a live target.
 *   unverifiable formed outside the window, or the row disagrees with its candle
 */
import { fetchKlines } from "../lib/market/futures.js";
import { analyzeLiquidity } from "../lib/smc/liquidity.js";
import { getLiquidityStore } from "../lib/persistence/LiquidityStore.js";
import { liquidityLevelId } from "../lib/events/Deduplicator.js";
import { restorePersistedLevels } from "../lib/scan/RestoredLevels.js";
import type { LiquiditySide } from "../lib/notify/formatters.js";

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
  const nowSec = Math.floor(Date.now() / 1000);
  const n = candles.length;

  console.log(`\n=== ${symbol} ${timeframe.toUpperCase()} — 價位 ${price} ===\n`);

  const rows = store.listLevels(symbol, timeframe).filter((l) => Math.abs(l.price - price) < price * 0.001);
  if (rows.length === 0) {
    console.log("帳本中找不到鄰近價位。");
    return;
  }

  const level = rows[0];
  console.log(`帳本：狀態 ${level.state}｜側別 ${level.side}｜觸及 ${level.touches} 次`);
  console.log(
    `形成於 ${new Date(level.formedAt * 1000).toISOString()}｜年齡 ${((nowSec - level.formedAt) / DAY).toFixed(1)} 天`,
  );

  const idx = candles.findIndex((c) => c.time === level.formedAt);
  const windowSize = Math.min(20, Math.floor(n / 4));
  const engineScanStartsAt = windowSize;

  if (idx >= 0) {
    console.log(`\n窗內位置：第 ${idx} 根 / 共 ${n} 根（引擎自第 ${engineScanStartsAt} 根起找 pivot）`);
    if (idx < engineScanStartsAt) {
      console.log(`→ 索引已漂到掃描起點之前，引擎不會再看見它。這正是帳本要接手的情況。`);
    }
  } else {
    console.log(`\n形成時間不在窗內（窗起點 ${new Date(candles[0].time * 1000).toISOString()}）。`);
  }

  const res = analyzeLiquidity(candles, timeframe, "crypto");
  const engineIds = new Set(
    res.pools.map((p) =>
      liquidityLevelId(symbol, timeframe, (p.type === "SSL" ? "SSL" : "BSL") as LiquiditySide, p.time, p.price),
    ),
  );

  const visibleToEngine = engineIds.has(level.id);
  console.log(
    `\n引擎直接回傳：${visibleToEngine ? "是" : "否"}（輸出 ${res.pools.length} 池，上限 20）`,
  );

  if (visibleToEngine) {
    console.log("\n判定：visible —— 掃描直接看得到，帳本與引擎一致。");
    return;
  }

  const outcome = restorePersistedLevels({
    candidates: [level], candles, timeframe, engineIds,
  });

  if (outcome.restored.length === 1) {
    console.log("\n判定：recovered —— 引擎看不到，但帳本補回，掃描仍會報這個價位。");
    return;
  }

  const reason = outcome.skipped[0]?.reason ?? "unknown";
  const explain: Record<string, string> = {
    superseded: "已出現更極端的 pivot，這根已不是 pivot（既有結構失效規則，正確忽略）。",
    consumed: "形成後價格已穿越，屬於歷史，不再是活躍標的。",
    "formed-outside-window": "形成時間落在窗外，無法核對，因此不還原（需要更深的歷史）。",
    "price-mismatch": "帳本價位與該根 K 線極值不符，無法核對，因此不還原。",
  };
  console.log(`\n判定：${reason} —— ${explain[reason] ?? "未知原因"}`);
}

main().catch((err) => {
  console.error("EXPLAIN FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
