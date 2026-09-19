/**
 * Tests for the persistent liquidity ledger (REQUIREMENTS §11, §12, §27).
 *
 * The point of this module is survival across restarts, so the tests use a real
 * file on disk and re-open it — an in-memory-only assertion would prove nothing.
 *
 * Run: npx tsx artifacts/api-server/src/lib/persistence/liquidity-store.test.ts
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiquidityStore, type LiquidityLevel } from "./LiquidityStore.js";
import { liquidityLevelId } from "../events/Deduplicator.js";

let passed = 0;
let failed = 0;

function ok(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function eq<T>(actual: T, expected: T, label: string): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); failed++; }
}

const dir = mkdtempSync(path.join(tmpdir(), "liqstore-"));
const dbPath = path.join(dir, "liquidity.db");

const BSL_ID = liquidityLevelId("SUIUSDT", "4h", "BSL", 1_789_776_000, 0.8342);
const SSL_ID = liquidityLevelId("SUIUSDT", "4h", "SSL", 1_788_782_400, 0.6705);

const bsl = {
  id: BSL_ID, symbol: "SUIUSDT", timeframe: "4h", side: "BSL" as const,
  price: 0.8342, formedAt: 1_789_776_000, session: "newYork",
  source: "Equal High + Swing High",
};
const ssl = {
  id: SSL_ID, symbol: "SUIUSDT", timeframe: "4h", side: "SSL" as const,
  price: 0.6705, formedAt: 1_788_782_400, session: "asia",
  source: "Swing Low",
};

// ── Insert / idempotent update ──────────────────────────────────────────────
console.log("─".repeat(60));
console.log("Insert and re-detection");
let store = new LiquidityStore(dbPath);
{
  const first = store.upsertLevel(bsl);
  ok(first.inserted, "first sighting inserts the level");
  eq(first.level.state, "ACTIVE", "new levels start ACTIVE");
  ok(existsSync(dbPath), "database file created on disk");

  // The engine re-detects the same pivot on every analysis window.
  const again = store.upsertLevel(bsl);
  ok(!again.inserted, "re-detection does not duplicate the level");
  eq(store.getStats().levels, 1, "still exactly one stored level");
  ok(again.level.firstSeenAt === first.level.firstSeenAt, "first_seen_at is preserved across re-detection");
}

// ── §11: state must survive re-detection ────────────────────────────────────
console.log("─".repeat(60));
console.log("§11 State survives re-detection");
{
  store.upsertLevel(ssl);
  store.setState(SSL_ID, "SWEPT", { sweptAt: Date.now(), sweepExtreme: 0.6688 });

  // Fresh analysis window re-reports the same pivot; it must NOT reset to ACTIVE.
  const reDetected = store.upsertLevel(ssl);
  eq(reDetected.level.state, "SWEPT", "a swept level is not reset by re-detection");
  ok(reDetected.level.sweptAt !== null, "sweep timestamp retained");
  eq(reDetected.level.sweepExtreme, 0.6688, "sweep extreme retained");
}

// ── §12 lifecycle ───────────────────────────────────────────────────────────
console.log("─".repeat(60));
console.log("§12 Lifecycle transitions");
{
  store.setState(BSL_ID, "APPROACHING");
  eq(store.getLevel(BSL_ID)?.state, "APPROACHING", "ACTIVE → APPROACHING");

  store.setState(BSL_ID, "TOUCHED");
  eq(store.getLevel(BSL_ID)?.state, "TOUCHED", "APPROACHING → TOUCHED");

  // §13: a wick through the level that closes back inside is SWEPT, not BROKEN.
  store.setState(BSL_ID, "SWEPT", { sweptAt: Date.now(), sweepExtreme: 0.8358 });
  const swept = store.getLevel(BSL_ID);
  eq(swept?.state, "SWEPT", "wick through, close inside → SWEPT");
  ok(swept?.brokenAt === null, "SWEPT is not recorded as BROKEN");

  store.setState(BSL_ID, "BROKEN", { brokenAt: Date.now() });
  const broken = store.getLevel(BSL_ID);
  eq(broken?.state, "BROKEN", "close beyond → BROKEN");
  ok(broken?.sweptAt !== null, "the earlier sweep record is preserved alongside BROKEN");
}

// ── §11: old levels are not aged out ────────────────────────────────────────
console.log("─".repeat(60));
console.log("§11 Old-but-valid levels are retained");
{
  // A very old 4H swing high still ACTIVE.
  const oldId = liquidityLevelId("SUIUSDT", "4h", "BSL", 1_785_456_000, 0.9100);
  store.upsertLevel({
    id: oldId, symbol: "SUIUSDT", timeframe: "4h", side: "BSL",
    price: 0.9100, formedAt: 1_785_456_000, session: "london", source: "Swing High",
  });
  const levels = store.listLevels("SUIUSDT", "4h");
  ok(levels.some((l) => l.id === oldId), "a level formed ~10 days ago is still listed");

  const ageDays = (Date.now() / 1000 - 1_785_456_000) / 86_400;
  ok(ageDays > 7, `its age is ${ageDays.toFixed(1)} days — beyond any naive time cut-off`);

  store.setState(oldId, "INVALIDATED");
  const afterInvalidate = store.listLevels("SUIUSDT", "4h");
  ok(!afterInvalidate.some((l) => l.id === oldId), "explicitly invalidated levels drop out");
  ok(store.listLevels("SUIUSDT", "4h", { includeInvalidated: true }).some((l) => l.id === oldId),
    "…but remain queryable for history");
}

// ── 同區域記憶的時間窗（region_lookback_days）──────────────────────────────
console.log("─".repeat(60));
console.log("同區域記憶：只看一週內的處理紀錄");
{
  // A level consumed 3 days ago → still counts as "this area was handled".
  const recentId = liquidityLevelId("TESTUSDT", "1h", "SSL", 1_700_000_000, 10.00);
  store.upsertLevel({
    id: recentId, symbol: "TESTUSDT", timeframe: "1h", side: "SSL",
    price: 10.00, formedAt: 1_700_000_000, session: "asia", source: "測試",
  });
  store.setState(recentId, "SWEPT", { sweptAt: Date.now() - 3 * 86_400_000, sweepExtreme: 9.98 });

  const found7 = store.takenNear("TESTUSDT", "1h", "SSL", 10.005, 0.2, 7);
  ok(found7 !== null, "3 天前處理過的區域 → 7 天窗內認得出來");
  eq(found7?.price, 10.00, "回報的是先前那條的價位");

  // A level consumed 30 days ago → OUTSIDE the weekly cycle, must NOT suppress.
  const oldId = liquidityLevelId("TESTUSDT", "1h", "SSL", 1_699_000_000, 20.00);
  store.upsertLevel({
    id: oldId, symbol: "TESTUSDT", timeframe: "1h", side: "SSL",
    price: 20.00, formedAt: 1_699_000_000, session: "asia", source: "測試",
  });
  store.setState(oldId, "SWEPT", { sweptAt: Date.now() - 30 * 86_400_000, sweepExtreme: 19.98 });

  ok(store.takenNear("TESTUSDT", "1h", "SSL", 20.005, 0.2, 7) === null,
    "30 天前處理過的區域 → 7 天窗外，不再壓制（市場結構已換一輪）");
  ok(store.takenNear("TESTUSDT", "1h", "SSL", 20.005, 0.2, 90) !== null,
    "同一筆在 90 天窗下仍認得出來（證明是時間窗生效，不是資料遺失）");

  // Adjacent but outside tolerance → different area.
  ok(store.takenNear("TESTUSDT", "1h", "SSL", 10.50, 0.2, 7) === null,
    "價位差距超過容忍度 → 視為不同區域");

  // 尚未被取走的 level 不算數
  const liveId = liquidityLevelId("TESTUSDT", "1h", "SSL", 1_700_100_000, 30.00);
  store.upsertLevel({
    id: liveId, symbol: "TESTUSDT", timeframe: "1h", side: "SSL",
    price: 30.00, formedAt: 1_700_100_000, session: "asia", source: "測試",
  });
  ok(store.takenNear("TESTUSDT", "1h", "SSL", 30.005, 0.2, 7) === null,
    "只是存在、還沒被取走的 level 不會壓制新目標");

  // 不同方向不算同一區
  const bslId = liquidityLevelId("TESTUSDT", "1h", "BSL", 1_700_000_000, 10.00);
  store.upsertLevel({
    id: bslId, symbol: "TESTUSDT", timeframe: "1h", side: "BSL",
    price: 10.00, formedAt: 1_700_000_000, session: "asia", source: "測試",
  });
  store.setState(bslId, "BROKEN", { brokenAt: Date.now() - 86_400_000 });
  eq(store.takenNear("TESTUSDT", "1h", "BSL", 10.005, 0.2, 7)?.price, 10.00,
    "BSL 與 SSL 分開判定（同價位不同方向不算同一區）");
}

// ── Nearest-level queries ───────────────────────────────────────────────────
console.log("─".repeat(60));
console.log("Nearest untaken levels");
{
  // By this point every earlier level is swept, broken or invalidated, so add
  // one clean ACTIVE level for the search to find.
  const freshId = liquidityLevelId("SUIUSDT", "4h", "BSL", 1_789_000_000, 0.8800);
  store.upsertLevel({
    id: freshId, symbol: "SUIUSDT", timeframe: "4h", side: "BSL",
    price: 0.8800, formedAt: 1_789_000_000, session: "newYork", source: "Swing High",
  });

  const { above, below } = store.nearestLevels("SUIUSDT", "4h", 0.8000);
  ok(above !== null && above.price > 0.8, "found an active level above price");
  ok(below === null, "swept/broken/invalidated levels are excluded from the search");
  eq(above?.price, 0.88, "nearest untaken level above is the active 0.88 high");
}

// ── Alert log, kv state ─────────────────────────────────────────────────────
console.log("─".repeat(60));
console.log("Alert log and key/value state");
{
  store.logAlert({
    eventKey: "SUIUSDT|4h|LIQUIDITY_SWEEP|" + BSL_ID,
    symbol: "SUIUSDT", timeframe: "4h", eventType: "LIQUIDITY_SWEEP",
    levelId: BSL_ID, state: "SWEPT", sentAt: Date.now(), message: "BSL SWEPT ...",
  });
  eq(store.recentAlerts(5).length, 1, "alert logged");
  eq(store.recentAlerts(5)[0].state, "SWEPT", "alert carries its state");

  // Same event key updates rather than duplicating.
  store.logAlert({
    eventKey: "SUIUSDT|4h|LIQUIDITY_SWEEP|" + BSL_ID,
    symbol: "SUIUSDT", timeframe: "4h", eventType: "LIQUIDITY_SWEEP",
    levelId: BSL_ID, state: "BROKEN", sentAt: Date.now(), message: "BSL BROKEN ...",
  });
  eq(store.recentAlerts(10).length, 1, "re-logging the same event key updates in place");
  eq(store.recentAlerts(10)[0].state, "BROKEN", "…to the latest state");

  store.putState("dedup", { trackedEvents: 3, levelKeys: ["a", "b"] });
  eq(store.getState<{ trackedEvents: number }>("dedup")?.trackedEvents, 3, "kv state round-trips");
  eq(store.getState("missing-key"), null, "missing kv key returns null");

  store.recordEvent("ws_reconnect", { attempt: 2 });
  eq(store.recentEvents(5).length, 1, "runtime event recorded");
}

// ── Restart recovery: the whole point ───────────────────────────────────────
console.log("─".repeat(60));
console.log("Restart recovery");
{
  const before = store.getStats();
  store.close();

  const reopened = new LiquidityStore(dbPath);
  const after = reopened.getStats();

  eq(after.levels, before.levels, "levels survive a restart");
  eq(after.alerts, before.alerts, "alert log survives a restart");
  eq(reopened.getLevel(SSL_ID)?.state, "SWEPT", "level state survives a restart");
  eq(reopened.getLevel(BSL_ID)?.state, "BROKEN", "latest state survives a restart");
  eq(reopened.getState<{ trackedEvents: number }>("dedup")?.trackedEvents, 3, "kv state survives a restart");

  // Pruning only trims the operational trail, never levels (§11).
  const removed = reopened.pruneRuntimeEvents(0);
  ok(removed >= 1, "prune removes aged runtime events");
  eq(reopened.getStats().levels, after.levels, "pruning never deletes liquidity levels");

  reopened.close();
}

rmSync(dir, { recursive: true, force: true });

console.log("─".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
