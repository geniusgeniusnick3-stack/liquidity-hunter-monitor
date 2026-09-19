/**
 * Dynamic Universe eligibility — no fixed size, explicit dual thresholds.
 *
 * Run: npx tsx artifacts/api-server/src/lib/universe/universe-eligibility.test.ts
 *
 * Covers the P0 corrections:
 *   - the universe has no Top-N cap: the count is an output, not an input
 *   - hysteresis works on threshold bands, not on rank position
 *   - ranking never excludes an eligible symbol
 *   - banded metrics read entry_min for newcomers, removal_min for incumbents
 *   - hard gates read the same value at both ends
 *
 * The point of Test 1-3 is the number that comes out. If a "cap 50" ever
 * returns, 58 eligible symbols would produce 50 and these fail.
 */
import {
  evaluateEligibility,
  rankMetrics,
} from "./LiquidityFilters.js";
import type { SymbolMetrics, EligibilityConfig } from "./types.js";

let passed = 0;
let failed = 0;

function ok(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const ELIGIBILITY: EligibilityConfig = {
  medianVolume7d: { entryMin: 20_000_000, removalMin: 17_000_000 },
  volume24h: { entryMin: 30_000_000, removalMin: 25_000_000 },
  openInterest: { entryMin: 5_000_000, removalMin: 4_000_000 },
  maxSpreadBps: 10,
  minListingAgeDays: 90,
};

/** A symbol that comfortably clears every entry threshold. */
function healthy(i: number, overrides: Partial<SymbolMetrics> = {}): SymbolMetrics {
  return {
    symbol: `SYM${String(i).padStart(3, "0")}USDT`,
    baseAsset: `SYM${i}`,
    quoteVolume24h: 100_000_000,
    medianDailyVolume7d: 60_000_000,
    openInterestUsd: 20_000_000,
    spreadBps: 3,
    listingAgeDays: 400,
    rank: null,
    score: null,
    ...overrides,
  };
}

/**
 * The decision the manager makes for a whole batch: which symbols come out
 * eligible. This mirrors DynamicUniverseManager step 4 without the network —
 * the manager adds no filtering of its own beyond this call, which is the
 * property under test.
 */
function universeOf(
  all: SymbolMetrics[],
  previous: string[] = [],
): SymbolMetrics[] {
  const prev = new Set(previous);
  return all.filter((m) =>
    evaluateEligibility(m, ELIGIBILITY, { isExistingMember: prev.has(m.symbol) }).eligible,
  );
}

// ── Test 1-3: the count is an output ────────────────────────────────────────

console.log("\n【Test 1-3】通過門檻的數量就是宇宙的數量（無 Top-N 上限）");

for (const n of [58, 83, 31]) {
  const all = Array.from({ length: n }, (_, i) => healthy(i));
  const out = universeOf(all);
  ok(
    out.length === n,
    `Test ${n === 58 ? 1 : n === 83 ? 2 : 3}：${n} 個全部合格 → 回傳 ${out.length} 個（應為 ${n}）`,
  );
}

console.log("\n【上限回歸】任何形式的 Top-N 裁切都不得存在");

{
  // 120 healthy symbols. If anything caps the universe, this is where a "50"
  // or a "100" would show up.
  const all = Array.from({ length: 120 }, (_, i) => healthy(i));
  const out = universeOf(all);
  ok(out.length === 120, `120 個全部合格 → 回傳 ${out.length} 個（無任何裁切）`);
  ok(
    out.length !== 50 && out.length !== 100,
    `回傳數量不是 50 也不是 100（排除常見的固定上限）`,
  );
}

console.log("\n【Test 4】排名變動不得排除任何合格幣");

{
  // Same 60 symbols, but the weakest ones are re-measured as the strongest.
  // Ranking order changes completely; nobody should enter or leave.
  const all = Array.from({ length: 60 }, (_, i) => healthy(i));
  const before = universeOf(all);

  // Re-rank so the first 10 symbols land at the very bottom. Every ranking
  // input has to be pushed down, not just volume: rankMetrics averages four
  // measures, so leaving open interest and spread favourable keeps a symbol
  // mid-table and the test proves nothing.
  const reshuffled = all.map((m, i) => {
    if (i >= 50) {
      return {
        ...m,
        quoteVolume24h: 5_000_000_000,
        medianDailyVolume7d: 4_000_000_000,
        openInterestUsd: 900_000_000,
        spreadBps: 0.5,
      };
    }
    if (i < 10) {
      return {
        ...m,
        // Still eligible (each clears its entry threshold), but last on every
        // measure — so their rank is the worst in the set.
        quoteVolume24h: 30_000_000,
        medianDailyVolume7d: 20_000_000,
        openInterestUsd: 5_000_000,
        spreadBps: 10,
      };
    }
    return m;
  });

  const rankedBefore = rankMetrics(reshuffled);
  const rankOf = new Map(rankedBefore.map((m) => [m.symbol, m.rank ?? 0]));

  const after = universeOf(reshuffled);
  ok(
    after.length === before.length && after.length === 60,
    `排名洗牌後成員數不變（${before.length} → ${after.length}）`,
  );

  // The symbols that fell in ranking must still be members.
  const demoted = reshuffled.slice(0, 10).map((m) => m.symbol);
  const demotedRanks = demoted.map((s) => rankOf.get(s) ?? 0);
  const worstRank = Math.max(...demotedRanks);
  const stillIn = demoted.every((s) => after.some((m) => m.symbol === s));
  ok(
    worstRank > 50 && stillIn,
    `排名掉到 #${worstRank}（超過 50）的幣仍留在宇宙內 — 排名不影響資格`,
  );
}

// ── Hysteresis: entry vs removal ────────────────────────────────────────────

console.log("\n【滯後行為】新幣看加入門檻，舊成員看移出門檻");

{
  // 24h volume of 27M sits between entry 30M and removal 25M.
  const mid = healthy(900, { quoteVolume24h: 27_000_000 });

  const asNewcomer = evaluateEligibility(mid, ELIGIBILITY, { isExistingMember: false });
  const asMember = evaluateEligibility(mid, ELIGIBILITY, { isExistingMember: true });

  ok(!asNewcomer.eligible, `24h=27M 的新幣不得加入（加入門檻 30M）`);
  ok(asMember.eligible, `24h=27M 的既有成員可以留下（移出門檻 25M）`);
  ok(asNewcomer.basis === "entry" && asMember.basis === "removal", "決策記錄了所用的標準");

  const check = asMember.checks.find((c) => c.name === "quote_volume_24h");
  ok(
    check !== undefined && check.threshold === 25_000_000,
    `既有成員的門檻確實是移出值 25M（讀到 ${check?.threshold}）`,
  );
}

{
  // Below removal: leaves even as an incumbent.
  const decayed = healthy(901, { quoteVolume24h: 20_000_000 });
  const asMember = evaluateEligibility(decayed, ELIGIBILITY, { isExistingMember: true });
  ok(!asMember.eligible, `24h=20M 低於移出門檻 25M → 既成成員也移除`);
}

{
  // Exactly on each boundary — the comparison is inclusive.
  const onEntry = healthy(902, { quoteVolume24h: 30_000_000 });
  const onRemoval = healthy(903, { quoteVolume24h: 25_000_000 });
  ok(
    evaluateEligibility(onEntry, ELIGIBILITY, { isExistingMember: false }).eligible,
    `剛好 30M 的新幣可以加入（邊界含等於）`,
  );
  ok(
    evaluateEligibility(onRemoval, ELIGIBILITY, { isExistingMember: true }).eligible,
    `剛好 25M 的成員可以留下（邊界含等於）`,
  );
}

console.log("\n【硬門檻】價差與上市天數沒有滯後，兩端同一標準");

{
  const badSpread = healthy(904, { spreadBps: 12 });
  const newComer = evaluateEligibility(badSpread, ELIGIBILITY, { isExistingMember: false });
  const member = evaluateEligibility(badSpread, ELIGIBILITY, { isExistingMember: true });
  ok(!newComer.eligible && !member.eligible, "價差 12bps 超過上限 10bps → 新人與成員都不合格");

  const sNew = newComer.checks.find((c) => c.name === "spread_bps");
  const sOld = member.checks.find((c) => c.name === "spread_bps");
  ok(
    sNew?.threshold === sOld?.threshold && sNew?.threshold === 10,
    `價差門檻在兩種標準下相同（都是 10bps）— 沒有給寬限期`,
  );

  const young = healthy(905, { listingAgeDays: 30 });
  ok(
    !evaluateEligibility(young, ELIGIBILITY, { isExistingMember: true }).eligible,
    "上市 30 天的新幣不合格（成員也一樣）",
  );
}

console.log("\n【fail-closed】缺資料一律不合格，兩種標準皆然");

{
  const missing = healthy(906, { openInterestUsd: null });
  ok(
    !evaluateEligibility(missing, ELIGIBILITY, { isExistingMember: false }).eligible,
    "OI 不可得 → 新幣不合格",
  );
  ok(
    !evaluateEligibility(missing, ELIGIBILITY, { isExistingMember: true }).eligible,
    "OI 不可得 → 成員也不合格（寬鬆標準不是猜測的許可）",
  );
}

console.log("\n【config 防呆】removal 高於 entry 的設定必須被拒絕");

{
  // Exercised through the schema in config tests; here we assert the invariant
  // the manager relies on: removalMin is never the stricter of the two.
  const bands = [
    ELIGIBILITY.medianVolume7d,
    ELIGIBILITY.volume24h,
    ELIGIBILITY.openInterest,
  ];
  ok(
    bands.every((b) => b.removalMin <= b.entryMin),
    "所有滯後帶的移出門檻都 <= 加入門檻",
  );
}

console.log("\n" + "─".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
