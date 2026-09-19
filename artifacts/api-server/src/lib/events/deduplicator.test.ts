/**
 * Tests for alert de-duplication and cooldown (REQUIREMENTS §17, §18, §27).
 *
 * Run: npx tsx artifacts/api-server/src/lib/events/deduplicator.test.ts
 */
import {
  AlertDeduplicator,
  liquidityLevelId,
  alertKey,
  levelKey,
  stateToken,
  type AlertIdentity,
} from "./Deduplicator.js";

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

// ── Helpers ─────────────────────────────────────────────────────────────────

let clock = 1_700_000_000_000;
const now = () => clock;
const advance = (ms: number) => { clock += ms; };

const DEFAULTS = { dedupWindowHours: 24, cooldownMinutes: 60 };

const levelId = liquidityLevelId("SUIUSDT", "4h", "BSL", 1_789_776_000, 0.8342);

const approaching: AlertIdentity = {
  symbol: "SUIUSDT", timeframe: "4h", eventType: "LIQUIDITY_APPROACHING",
  levelId, state: "APPROACHING",
};

const swept: AlertIdentity = {
  symbol: "SUIUSDT", timeframe: "4h", eventType: "LIQUIDITY_SWEEP",
  levelId, state: "SWEPT",
};

// ── Level identity stability ────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("Level identity");
{
  const a = liquidityLevelId("SUIUSDT", "4h", "BSL", 1_789_776_000, 0.8342);
  const b = liquidityLevelId("SUIUSDT", "4h", "BSL", 1_789_776_000, 0.8342);
  ok(a === b, "identical level inputs produce identical id (stable across refreshes)");
  ok(a !== liquidityLevelId("SUIUSDT", "1h", "BSL", 1_789_776_000, 0.8342), "timeframe is part of the id");
  ok(a !== liquidityLevelId("SUIUSDT", "4h", "SSL", 1_789_776_000, 0.8342), "side is part of the id");
  ok(alertKey(approaching).includes("LIQUIDITY_APPROACHING"), "§17 alert key includes event type");
  // The second identity layer must NOT include the event type, otherwise
  // APPROACHING and SWEPT can never be recognised as the same level.
  ok(!levelKey(approaching).includes("LIQUIDITY_APPROACHING"), "level key is event-type independent");
  ok(stateToken(approaching) !== stateToken(swept), "different states produce different tokens");
}

// ── §17 De-duplication ──────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("§17 De-duplication — same event must not be re-announced");
{
  clock = 1_700_000_000_000;
  const d = new AlertDeduplicator(DEFAULTS, now);

  eq(d.shouldSend(approaching).reason, "new_event", "first sighting is sent");
  d.record(approaching);

  eq(d.shouldSend(approaching).reason, "duplicate_event", "immediate repeat is suppressed");

  advance(30 * 60_000); // 30 min
  eq(d.shouldSend(approaching).reason, "duplicate_event", "still suppressed inside the dedup window");

  advance(23 * 3_600_000 + 30 * 60_000); // now well past 24h
  eq(d.shouldSend(approaching).reason, "new_event", "re-announced once the dedup window expires");
}

// ── §17 State transition ────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("§17 State transition — APPROACHING → SWEPT is a new announcement");
{
  clock = 1_700_000_000_000;
  const d = new AlertDeduplicator(DEFAULTS, now);

  d.record(approaching);
  advance(5 * 60_000);

  // A transition inside the cooldown window must still be held back (§18).
  const held = d.shouldSend(swept);
  eq(held.reason, "cooldown_active", "transition inside cooldown is held");
  ok((held.cooldownRemainingSeconds ?? 0) > 0, "cooldown remaining is reported");

  advance(60 * 60_000); // past the 60-minute cooldown
  eq(d.shouldSend(swept).reason, "state_changed", "transition fires after the cooldown lapses");

  d.record(swept);
  eq(d.shouldSend(swept).reason, "duplicate_event", "the SWEPT announcement itself is not repeated");
  eq(d.shouldSend(approaching).reason, "duplicate_event", "returning to the old state does not re-announce");
}

// ── §18 Cooldown ────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("§18 Cooldown — price oscillating in a zone must not spam");
{
  clock = 1_700_000_000_000;
  const d = new AlertDeduplicator({ dedupWindowHours: 24, cooldownMinutes: 60 }, now);

  // Three different levels near the same symbol, all new events.
  const l1: AlertIdentity = { ...approaching, levelId: liquidityLevelId("SUIUSDT", "4h", "BSL", 1, 1.0) };
  const l2: AlertIdentity = { ...approaching, levelId: liquidityLevelId("SUIUSDT", "4h", "BSL", 2, 1.01) };
  const l3: AlertIdentity = { ...approaching, levelId: liquidityLevelId("SUIUSDT", "4h", "BSL", 3, 1.02) };

  eq(d.shouldSend(l1).reason, "new_event", "first level alerts");
  d.record(l1);

  eq(d.shouldSend(l2).reason, "cooldown_active", "second distinct level suppressed by cooldown");
  eq(d.shouldSend(l3).reason, "cooldown_active", "third distinct level suppressed by cooldown");

  advance(61 * 60_000);
  eq(d.shouldSend(l2).reason, "new_event", "alerts resume after the cooldown");
}

// ── Cooldown is per symbol ──────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("Cooldown isolation");
{
  clock = 1_700_000_000_000;
  const d = new AlertDeduplicator(DEFAULTS, now);

  d.record(approaching); // SUIUSDT
  const otherSymbol: AlertIdentity = {
    ...approaching,
    symbol: "ETHUSDT",
    levelId: liquidityLevelId("ETHUSDT", "4h", "BSL", 1, 3000),
  };
  eq(d.shouldSend(otherSymbol).reason, "new_event", "a different symbol is unaffected by cooldown");
}

// ── Pruning and persistence ─────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("Pruning and restart recovery");
{
  clock = 1_700_000_000_000;
  const d = new AlertDeduplicator(DEFAULTS, now);
  d.record(approaching);
  eq(d.getStats().trackedEvents, 1, "one event tracked");

  advance(25 * 3_600_000);
  eq(d.prune(), 1, "prune removes entries past the dedup window");
  eq(d.getStats().trackedEvents, 0, "memory released");

  // Restart recovery: a fresh instance restored from state must still suppress.
  clock = 1_700_000_000_000;
  const d2 = new AlertDeduplicator(DEFAULTS, now);
  d2.record(approaching);
  const exported = d2.exportState();

  const d3 = new AlertDeduplicator(DEFAULTS, now);
  d3.importState(exported);
  eq(d3.shouldSend(approaching).reason, "duplicate_event", "state survives a restart (no duplicate on reboot)");
  eq(exported.events.length, 1, "exported state carries the event");
  eq(exported.levels.length, 1, "exported state carries the level");
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
