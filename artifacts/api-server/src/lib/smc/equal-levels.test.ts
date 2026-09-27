/**
 * Tests for equal highs / equal lows (EQH / EQL).
 *
 * Run: npx tsx artifacts/api-server/src/lib/smc/equal-levels.test.ts
 *
 * Fixture design notes:
 *  - The backdrop is deliberately NON-periodic. A repeating pattern creates many
 *    exactly-equal highs/lows of its own, which now merge — the test would then
 *    be measuring the backdrop instead of the planted pair.
 *  - Planted prices are either far inside the ATR-scaled tolerance (0.1 apart)
 *    or far outside it (5.0 apart), so the exact ATR cannot flip the outcome.
 *  - Where a level must survive as a swing, the bar that breaks it is placed
 *    more than `windowSize` away: a breaker inside the window disqualifies the
 *    pivot itself, and no level is ever produced.
 */
import { analyzeLiquidity } from "./liquidity.js";
import type { Candle } from "./types.js";

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

const H4 = 14_400;
const BASE = 1_700_000_000;

const bar = (i: number, open: number, high: number, low: number, close: number): Candle =>
  ({ time: BASE + i * H4, open, high, low, close, volume: 1000 }) as Candle;

/**
 * Non-periodic backdrop: a slow drift with an irrational-frequency wobble, so no
 * two bars share a high or a low unless a test plants them.
 */
function quiet(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const px = 90 + Math.sin(i * 1.7) * 0.4 + (i % 3) * 0.017;
    out.push(bar(i, px, px + 0.3, px - 0.3, px));
  }
  return out;
}

/** Rising backdrop: every low is higher than the last, so the ONLY sell-side levels are planted ones. */
function rising(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const px = 90 + i * 0.25 + Math.sin(i * 1.3) * 0.2;
    out.push(bar(i, px, px + 0.25, px - 0.25, px));
  }
  return out;
}

const spikeHigh = (c: Candle[], i: number, high: number, close: number): void => {
  c[i] = bar(i, high - 2, high, high - 3, close);
};
const spikeLow = (c: Candle[], i: number, low: number, close: number): void => {
  c[i] = bar(i, low + 2, low + 3, low, close);
};

// ── Two highs at the same price ─────────────────────────────────────────────

console.log("─".repeat(60));
console.log("EQH: two highs a tick apart");
{
  const c = quiet(60);                       // windowSize = min(20, 15) = 15
  spikeHigh(c, 20, 100.0, 98);               // first attempt
  spikeHigh(c, 40, 100.1, 98);               // second attempt, never taken
  const res = analyzeLiquidity(c, "4h", "crypto");
  const merged = res.pools.filter((p) => p.type === "EQH");

  eq(merged.length, 1, "the pair is reported as ONE EQH pool");
  eq(merged[0]?.price, 100.1, "level sits at the EXTREME of the pair (highest high)");
  eq(merged[0]?.equalLevelMembers?.map((m) => m.price), [100.0, 100.1], "members carry both prices, earliest first");
  eq(merged[0]?.time, BASE + 40 * H4, "level is judged from the SECOND swing (the one that confirmed it)");
  ok((merged[0]?.touches ?? 0) >= 2, `touches counts both attempts (got ${merged[0]?.touches})`);
  eq(res.pools.filter((p) => p.type === "BSL" && p.price >= 100).length, 0, "the two BSL pools were replaced, not duplicated");
}

// ── Two highs at exactly the same price ─────────────────────────────────────

console.log("─".repeat(60));
console.log("EQH: two highs at the IDENTICAL price");
{
  const c = quiet(60);
  spikeHigh(c, 20, 100.0, 98);
  spikeHigh(c, 40, 100.0, 98);
  const res = analyzeLiquidity(c, "4h", "crypto");
  const merged = res.pools.filter((p) => p.type === "EQH");

  eq(merged.length, 1, "identical highs are NOT both discarded (the old `>=` behaviour)");
  eq(merged[0]?.equalLevelMembers?.length, 2, "both identical highs are members");
}

// ── Highs too far apart ─────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("Highs far apart are left alone");
{
  const c = quiet(60);
  spikeHigh(c, 20, 100.0, 98);
  spikeHigh(c, 40, 105.0, 103);
  const res = analyzeLiquidity(c, "4h", "crypto");

  eq(res.pools.filter((p) => p.type === "EQH").length, 0, "no EQH is invented across a 5.0 gap");
  eq(res.pools.filter((p) => p.type === "BSL").length, 2, "both highs remain separate BSL levels");
}

// ── Equal lows ──────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("EQL: two lows a tick apart");
{
  const c = quiet(60);
  spikeLow(c, 20, 80.0, 82);
  spikeLow(c, 40, 79.9, 82);
  const res = analyzeLiquidity(c, "4h", "crypto");
  const merged = res.pools.filter((p) => p.type === "EQL");

  eq(merged.length, 1, "the pair is reported as ONE EQL pool");
  eq(merged[0]?.price, 79.9, "level sits at the EXTREME of the pair (lowest low)");
  eq(merged[0]?.equalLevelMembers?.length, 2, "both swings are members");
}

// ── A taken level must not pair with a later one ────────────────────────────

console.log("─".repeat(60));
console.log("Guard: an already-taken level never pairs");
{
  const c = quiet(100);                      // windowSize = min(20, 25) = 20
  spikeHigh(c, 25, 100.0, 98);               // a real swing high...
  c[50] = bar(50, 99, 106, 98.5, 105.5);     // ...26 bars later it is taken: wick AND close beyond
  spikeHigh(c, 80, 100.05, 98);              // a fresh, untaken high near the old price

  const res = analyzeLiquidity(c, "4h", "crypto");
  const taken = res.pools.find((p) => Math.abs(p.price - 100.0) < 1e-6);

  eq(res.pools.filter((p) => p.type === "EQH").length, 0, "the taken level is not paired with the later high");
  ok(taken !== undefined, "the taken 100.0 level is still reported");
  eq(taken?.wasSwept, true, "and it is reported as taken");
  ok(res.pools.some((p) => p.type === "BSL" && Math.abs(p.price - 100.05) < 1e-6), "the later high stays its own level");
}

// ── Three highs in one area ─────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("Cluster of three");
{
  const c = quiet(100);
  // Indices must be >= windowSize (20 here) to be scanned at all, and > 20
  // apart so each spike stays the highest bar inside its own window.
  spikeHigh(c, 25, 100.0, 98);
  spikeHigh(c, 50, 100.05, 98);
  spikeHigh(c, 80, 100.1, 98);
  const res = analyzeLiquidity(c, "4h", "crypto");
  const merged = res.pools.filter((p) => p.type === "EQH");

  eq(merged.length, 1, "three highs in the same area become one pool");
  eq(merged[0]?.equalLevelMembers?.length, 3, "all three are members");
  eq(merged[0]?.price, 100.1, "extreme is the highest of the three");
}

// ── Bounded clustering, not chained ─────────────────────────────────────────

console.log("─".repeat(60));
console.log("Chaining is refused");
{
  // 100.0 / 100.4 / 100.8: single-linkage would chain all three into one level.
  const c = quiet(100);
  spikeHigh(c, 25, 100.0, 98);
  spikeHigh(c, 50, 100.4, 98);
  spikeHigh(c, 80, 100.8, 98);
  const res = analyzeLiquidity(c, "4h", "crypto");
  const sizes = res.pools
    .filter((p) => p.type === "EQH")
    .map((p) => p.equalLevelMembers?.length ?? 0);

  ok(sizes.length === 0 || Math.max(...sizes) < 3,
    `the three are not chained into a single level (cluster sizes: ${JSON.stringify(sizes)})`);
}

// ── The nearest-level search understands the new types ──────────────────────

console.log("─".repeat(60));
console.log("nearestSSL can be a merged level");
{
  // Rising backdrop → the only sell-side liquidity in the series is the pair.
  const c = rising(60);
  spikeLow(c, 20, 88.0, 89.5);
  spikeLow(c, 40, 87.9, 89.5);
  const res = analyzeLiquidity(c, "4h", "crypto");

  ok(res.nearestSSL !== null, "a merged EQL is considered as sell-side liquidity");
  eq(res.nearestSSL?.type, "EQL", "and it is returned as the nearest level below price");
  eq(res.nearestSSL?.price, 87.9, "the merged extreme, not either raw swing taken alone");
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
