/**
 * Liquidity level lifetime — state-driven, never age-driven.
 *
 * Run: npx tsx artifacts/api-server/src/lib/smc/liquidity-lifetime.test.ts
 *
 * Covers the P0 correction that removed any notion of "a level older than N
 * days is stale":
 *
 *   Test 5   4H BSL formed 3 days ago, untouched        → still ACTIVE
 *   Test 6   4H BSL formed 12 days ago, untouched       → still ACTIVE
 *            (this is the one that fails if a 7-day expiry returns)
 *   Test 7   a 20-day-old level survives a restart      → reloaded as ACTIVE
 *   Test 8   a level already SWEPT                      → not reported active
 *   Test 9   a level already BROKEN                     → not reported active
 *
 * The engine is used as-is. Nothing here changes detection — the assertions are
 * about which levels the engine hands back and how persistence restores them.
 *
 * A level leaves the active set because price interacted with it (SWEPT,
 * BROKEN, TOUCHED), not because a calendar advanced.
 */
import { analyzeLiquidity } from "./liquidity.js";
import { LiquidityStore } from "../persistence/LiquidityStore.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candle } from "./types.js";

let passed = 0;
let failed = 0;

function ok(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

// ── Synthetic candles with a single deliberate swing high ───────────────────

// Candle.time is Unix seconds throughout the engine and SQLite ledger.
const SEC_4H = 4 * 3_600;
const CANDLES_PER_DAY_4H = 6;

/**
 * Build 4H candles whose only notable feature is one swing high `swingDaysAgo`
 * days back. Everything else stays ~20% below it, so the level is never
 * touched and its pivot cannot be confused with neighbouring bars.
 *
 * `touchAtEnd` optionally drives the final candle up through the level so the
 * SWEPT/BROKEN paths can be exercised on the same fixture.
 */
function candlesWithSwingHigh(
  swingDaysAgo: number,
  total: number = 500,
  opts: { touchAtEnd?: "sweep" | "break" } = {},
): { candles: Candle[]; swingPrice: number; swingTime: number } {
  const swingPrice = 100;
  const swingIndex = total - swingDaysAgo * CANDLES_PER_DAY_4H;
  const startTime = Math.floor(Date.now() / 1000) - total * SEC_4H;
  const candles: Candle[] = [];

  for (let i = 0; i < total; i++) {
    const time = startTime + i * SEC_4H;
    if (i === swingIndex) {
      candles.push({ time, open: 97, high: swingPrice, low: 96, close: 98, volume: 1_000 });
    } else {
      const base = 80;
      candles.push({
        time,
        open: base + (i % 3),
        high: base + 2,
        low: base - 2,
        close: base + 1,
        volume: 1_000 + i,
      });
    }
  }

  if (opts.touchAtEnd) {
    const i = total - 1;
    const time = startTime + i * SEC_4H;
    if (opts.touchAtEnd === "sweep") {
      // Trades beyond the level, closes back below it → SWEPT.
      candles[i] = { time, open: 98, high: 101, low: 97, close: 99, volume: 2_000 };
    } else {
      // Trades beyond, closes beyond → BROKEN.
      candles[i] = { time, open: 99, high: 102, low: 98, close: 101.5, volume: 2_000 };
    }
  }

  return { candles, swingPrice, swingTime: startTime + swingIndex * SEC_4H };
}

/** Find the pool at the swing price, if the engine reported one. */
function findSwingPool(candles: Candle[]) {
  const res = analyzeLiquidity(candles, "4h", "crypto");
  return res.pools.find((p) => Math.abs(p.price - 100) < 0.5) ?? null;
}

// ── Test 5 & 6: age alone does not expire a level ───────────────────────────

console.log("\n【Test 5】4H BSL 形成於 3 天前、未被觸及 → 仍為活躍");

{
  const { candles } = candlesWithSwingHigh(3);
  const pool = findSwingPool(candles);
  ok(pool !== null, "引擎仍偵測到該價位");
  ok(pool?.interaction === "NONE", `互動狀態為 NONE（未觸及）— 讀到 ${pool?.interaction}`);
  ok(pool?.wasSwept === false, "尚未被取走（wasSwept = false）");
}

console.log("\n【Test 6】4H BSL 形成於 12 天前、未被觸及 → 仍為活躍（>7 天不失效）");

{
  const { candles } = candlesWithSwingHigh(12);
  const pool = findSwingPool(candles);
  ok(pool !== null, "引擎仍偵測到 12 天前的價位（未被 7 天窗排除）");
  ok(
    pool?.interaction === "NONE",
    `12 天前的價位仍為 NONE — 沒有因為 age > 7 天變成 stale（讀到 ${pool?.interaction}）`,
  );
  ok(pool?.wasSwept === false, "尚未被取走");
}

console.log("\n【年齡掃描】同一價位在各種年齡下都存活");

{
  // If any age-based rule existed, some of these would disappear. They must all
  // survive untouched, because none of them was interacted with.
  const ages = [1, 3, 7, 8, 12, 20, 30, 45];
  const found: number[] = [];
  for (const age of ages) {
    const { candles } = candlesWithSwingHigh(age);
    const pool = findSwingPool(candles);
    if (pool && pool.interaction === "NONE") found.push(age);
  }
  ok(
    found.length === ages.length,
    `${ages.join("/")} 天前形成的價位全部存活（實際存活 ${found.length}/${ages.length}）`,
  );
}

// ── Test 7: persistence restores an old unresolved level ────────────────────

console.log("\n【Test 7】20 天前的價位，經持久化後仍以活躍狀態還原");

{
  const { candles, swingPrice, swingTime } = candlesWithSwingHigh(20);
  const pool = findSwingPool(candles);
  ok(pool !== null, "20 天前的價位被偵測到");

  // Use a real SQLite file, close it, and open it again. A JSON round trip or
  // in-memory map would not prove restart recovery. The production store itself
  // must demonstrate that age is not used as a cleanup rule.
  const dir = mkdtempSync(join(tmpdir(), "liquidity-lifetime-"));
  const dbPath = join(dir, "restart.db");
  const id = `TESTUSDT|4h|BSL|${swingTime}|${swingPrice}`;
  const storedAt = Math.floor(Date.now() / 1000);
  const first = new LiquidityStore(dbPath);
  first.upsertLevel({
    id,
    symbol: "TESTUSDT",
    timeframe: "4h",
    side: "BSL",
    price: swingPrice,
    formedAt: swingTime,
    source: "test swing high",
  });
  first.close();

  // Simulate the 20-day-old formation independently of now by updating only
  // the formation timestamp — not the state, and not the event fields.
  const ageDb = new (await import("node:sqlite")).DatabaseSync(dbPath);
  ageDb.prepare("UPDATE liquidity_levels SET formed_at = ? WHERE id = ?").run(
    swingTime,
    id,
  );
  ageDb.close();

  const second = new LiquidityStore(dbPath);
  const restored = second.getLevel(id);
  const active = second.nearestLevels("TESTUSDT", "4h", 90).above;
  second.close();
  rmSync(dir, { recursive: true, force: true });

  const ageDays = Math.floor((storedAt - swingTime) / 86_400);
  ok(ageDays >= 20, `資料庫中的價位年齡為 ${ageDays} 天（超過 7 天）`);
  ok(restored?.state === "ACTIVE", "SQLite 重開後仍還原為 ACTIVE");
  ok(active?.id === id, "重開後仍出現在未解決的 nearest level 中");
}

// ── Test 8 & 9: resolved levels are not restored as active ──────────────────

console.log("\n【Test 8】已 SWEPT 的舊價位 → 不得當作活躍");

{
  const { candles } = candlesWithSwingHigh(12, 500, { touchAtEnd: "sweep" });
  const pool = findSwingPool(candles);
  ok(pool !== null, "價位本身仍可被找到（歷史紀錄保留）");
  ok(pool?.interaction === "SWEPT", `互動狀態為 SWEPT（讀到 ${pool?.interaction}）`);
  ok(pool?.wasSwept === true, "已被取走（wasSwept = true）→ 不是活躍標的");
  ok(
    !(pool?.interaction === "NONE" && pool?.wasSwept === false),
    "不會被誤判為未解決的活躍價位",
  );
}

console.log("\n【Test 9】已 BROKEN 的舊價位 → 不得當作活躍");

{
  const { candles } = candlesWithSwingHigh(12, 500, { touchAtEnd: "break" });
  const pool = findSwingPool(candles);
  ok(pool !== null, "價位本身仍可被找到（歷史紀錄保留）");
  ok(pool?.interaction === "BROKEN", `互動狀態為 BROKEN（讀到 ${pool?.interaction}）`);
  ok(pool?.wasSwept === true, "已被取走（wasSwept = true）→ 不是活躍標的");
}

console.log("\n【對照】SWEPT 與 BROKEN 的判定本身不受本次修改影響");

{
  // Regression guard on the semantics the P0 patch must not have touched.
  const swept = findSwingPool(candlesWithSwingHigh(12, 500, { touchAtEnd: "sweep" }).candles);
  const broken = findSwingPool(candlesWithSwingHigh(12, 500, { touchAtEnd: "break" }).candles);
  ok(swept?.interaction === "SWEPT", "穿越後收回原側 → SWEPT");
  ok(broken?.interaction === "BROKEN", "穿越後收在對側 → BROKEN");
}

console.log("\n" + "─".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
