/**
 * Restoring persisted levels the engine can no longer reach.
 *
 * Run: npx tsx artifacts/api-server/src/lib/scan/restored-levels.test.ts
 *
 * The engine's pivot scan starts `windowSize` bars into the array, so as the
 * candle window slides forward a level's index drifts leftward and eventually
 * crosses that boundary — at which point the engine stops reporting it even
 * though its candle is still loaded. Measured on live data: PENGUUSDT 1H BSL
 * 0.009333 sat at index 18 of 499 with the engine's output nowhere near its
 * 20-level limit.
 *
 * The ledger remembers such levels, which is what persistence is for. These
 * tests pin the other half of the contract: a ledger row must be RE-VERIFIED
 * against the candles before it is trusted, because a level the engine stopped
 * returning may equally have been superseded — and the ledger cannot tell the
 * two apart.
 */
import { analyzeLiquidity } from "../smc/liquidity.js";
import { restorePersistedLevels } from "./RestoredLevels.js";
import type { Candle } from "../smc/types.js";
import type { LiquidityLevel } from "../persistence/LiquidityStore.js";

let passed = 0;
let failed = 0;

function ok(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

// ── Fixture ─────────────────────────────────────────────────────────────────

const SEC_1H = 3_600;
const N = 500;
const START = 1_700_000_000;

/** A calm market: nothing ever approaches the deliberate pivot. */
function baseCandles(): Candle[] {
  return Array.from({ length: N }, (_, i) => ({
    time: START + i * SEC_1H,
    open: 90, high: 101, low: 80, close: 90, volume: 1_000,
  }));
}

/** Index at which the deliberate pivot sits — inside the window, but before
 *  the engine's scan start (windowSize = min(20, floor(500/4)) = 20). */
const PIVOT_IDX = 18;
const PIVOT_PRICE = 50;

function persistedLevel(overrides: Partial<LiquidityLevel> = {}): LiquidityLevel {
  return {
    id: `TESTUSDT|1h|SSL|${START + PIVOT_IDX * SEC_1H}|${PIVOT_PRICE}`,
    symbol: "TESTUSDT",
    timeframe: "1h",
    side: "SSL",
    price: PIVOT_PRICE,
    formedAt: START + PIVOT_IDX * SEC_1H,
    session: null,
    source: "1 次觸及",
    state: "ACTIVE",
    stateChangedAt: 0,
    firstSeenAt: 0,
    lastSeenAt: 0,
    sweptAt: null,
    sweepExtreme: null,
    brokenAt: null,
    invalidatedAt: null,
    touches: 1,
    ...overrides,
  };
}

console.log("\n【前提】引擎真的看不到這個價位");

{
  const candles = baseCandles();
  candles[PIVOT_IDX].low = PIVOT_PRICE;
  const res = analyzeLiquidity(candles, "1h", "crypto");
  const seen = res.pools.some((p) => Math.abs(p.price - PIVOT_PRICE) < 0.001);
  ok(!seen, `引擎未回傳第 ${PIVOT_IDX} 根的 pivot（掃描自第 20 根起）`);
  ok(res.pools.length < 20, `引擎輸出未達上限（${res.pools.length} < 20），所以不是被截斷造成`);
}

console.log("\n【還原】有效且未解決的價位 → 還原");

{
  const candles = baseCandles();
  candles[PIVOT_IDX].low = PIVOT_PRICE;
  const out = restorePersistedLevels({
    candidates: [persistedLevel()],
    candles,
    timeframe: "1h",
    engineIds: new Set(),
  });
  ok(out.restored.length === 1, `還原 1 筆（實際 ${out.restored.length}）`);
  const p = out.restored[0];
  ok(p?.price === PIVOT_PRICE, `價位正確 ${p?.price}`);
  ok(p?.type === "SSL" && p?.wasSwept === false, "型別 SSL、未被取走");
  ok(p?.time === START + PIVOT_IDX * SEC_1H, "形成時間沿用帳本，識別碼因此對得上");
}

console.log("\n【拒絕】已被更極端的 pivot 取代 → 不還原");

{
  const candles = baseCandles();
  candles[PIVOT_IDX].low = PIVOT_PRICE;
  candles[PIVOT_IDX + 5].low = PIVOT_PRICE - 5; // 更低的低點，緊接在後
  const out = restorePersistedLevels({
    candidates: [persistedLevel()], candles, timeframe: "1h", engineIds: new Set(),
  });
  ok(out.restored.length === 0, "不還原");
  ok(out.skipped[0]?.reason === "superseded", `原因為 superseded（實際 ${out.skipped[0]?.reason}）`);
}

console.log("\n【拒絕】形成後已被穿越 → 不還原（不會復活死掉的價位）");

{
  const candles = baseCandles();
  candles[PIVOT_IDX].low = PIVOT_PRICE;
  candles[200].low = PIVOT_PRICE - 5; // 遠在 ±20 根之外，但不影響「已被取走」的判定
  const out = restorePersistedLevels({
    candidates: [persistedLevel()], candles, timeframe: "1h", engineIds: new Set(),
  });
  ok(out.restored.length === 0, "不還原");
  ok(out.skipped[0]?.reason === "consumed", `原因為 consumed（實際 ${out.skipped[0]?.reason}）`);
}

console.log("\n【拒絕】形成時間落在窗外 → 不還原（無法驗證就不信任）");

{
  const candles = baseCandles();
  const out = restorePersistedLevels({
    candidates: [persistedLevel({ formedAt: START - 999_999 })],
    candles, timeframe: "1h", engineIds: new Set(),
  });
  ok(out.restored.length === 0, "不還原");
  ok(
    out.skipped[0]?.reason === "formed-outside-window",
    `原因為 formed-outside-window（實際 ${out.skipped[0]?.reason}）`,
  );
}

console.log("\n【去重】引擎已回傳的價位不得重複加入");

{
  const candles = baseCandles();
  const level = persistedLevel();
  const out = restorePersistedLevels({
    candidates: [level], candles, timeframe: "1h", engineIds: new Set([level.id]),
  });
  ok(out.restored.length === 0, "不重複加入");
  ok(out.skipped[0]?.reason === "in-engine-output", "原因為 in-engine-output");
}

console.log("\n【接觸狀態】價格進到區間但未穿越 → 還原為 TOUCHED");

{
  const candles = baseCandles();
  candles[PIVOT_IDX].low = PIVOT_PRICE;
  // ATR ≈ 21 on this fixture, so tolerance ≈ 2.1. A low of 51 reaches the zone
  // without trading beyond it.
  candles[150].low = PIVOT_PRICE + 1;
  const out = restorePersistedLevels({
    candidates: [persistedLevel()], candles, timeframe: "1h", engineIds: new Set(),
  });
  ok(out.restored.length === 1, "仍還原（觸及不等於被取走）");
  ok(out.restored[0]?.interaction === "TOUCHED", `互動狀態為 TOUCHED（實際 ${out.restored[0]?.interaction}）`);
  ok(out.restored[0]?.wasSwept === false, "未被取走");
}

console.log("\n【多筆】一次處理多個候選，各自獨立判定");

{
  const candles = baseCandles();
  candles[PIVOT_IDX].low = PIVOT_PRICE;

  const good = persistedLevel({ id: "good", formedAt: START + PIVOT_IDX * SEC_1H });
  const gone = persistedLevel({
    id: "gone",
    formedAt: START + PIVOT_IDX * SEC_1H,
    price: PIVOT_PRICE - 1,
  });

  const out = restorePersistedLevels({
    candidates: [good, gone], candles, timeframe: "1h", engineIds: new Set(),
  });
  ok(out.restored.length === 1 && out.restored[0]?.price === PIVOT_PRICE, "只還原有效的那一筆");
  ok(out.skipped.length === 1, "另一筆被拒絕");
  ok(
    out.skipped[0]?.reason === "price-mismatch",
    `拒絕原因為 price-mismatch：帳本價位與該根 K 線極值不符（實際 ${out.skipped[0]?.reason}）`,
  );
}

console.log("\n" + "─".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
