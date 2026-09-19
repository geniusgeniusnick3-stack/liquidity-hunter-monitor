/**
 * Smoke test for the dynamic universe (REQUIREMENTS §4, §5, §6, §7, §8).
 *
 * Verifies against LIVE Binance USDT-M data:
 *   1. the floor + ranking actually select a sane watchlist
 *   2. rejections are explainable (each failed filter is reported)
 *   3. hysteresis holds — a second refresh on the same market must not churn
 *
 * Run:
 *   NODE_ENV=production npx tsx artifacts/api-server/src/scripts/universe-smoke.ts
 */
import { universeManager } from "../lib/universe/DynamicUniverseManager.js";
import { loadConfig } from "../lib/config/index.js";
import type { SymbolMetrics } from "../lib/universe/types.js";

function usd(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return "n/a";
  return (v / 1e6).toFixed(digits) + "M";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log("=== 設定（config.yaml）===");
  console.log("  大小=動態（無上限）  exit_threshold_factor=" + cfg.universe.exit_threshold_factor);
  console.log("  core=" + cfg.universe.core_symbols.join(", "));
  console.log(
    "  filters: 24h>=$" + (cfg.universe.filters.min_quote_volume_24h_usd / 1e6).toFixed(0) + "M" +
    " | 7d中位>=$" + (cfg.universe.filters.min_median_daily_volume_7d_usd / 1e6).toFixed(0) + "M" +
    " | OI>=$" + (cfg.universe.filters.min_open_interest_usd / 1e6).toFixed(0) + "M" +
    " | spread<=" + cfg.universe.filters.max_spread_bps + "bps" +
    " | age>=" + cfg.universe.filters.min_listing_age_days + "d",
  );

  const t0 = Date.now();
  const snap = await universeManager.refresh();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("=== 第 1 次 refresh（" + secs + " 秒）===");
  console.log("  " + snap.totalPerpetuals + " 個永續 → 通過門檻 " + snap.eligibleCount + " 個 → 監控 " + snap.activeSymbols.length + " 個");

  console.log("");
  console.log("=== 監控清單 ===");
  let idx = 0;
  for (const s of snap.activeSymbols) {
    idx++;
    const m: SymbolMetrics | undefined = snap.metrics[s];
    const rank = m && m.rank !== null ? String(m.rank) : "-";
    const line =
      "  " + pad(String(idx), 2) + ". " + s.padEnd(14) +
      " rank=" + pad(rank, 3) +
      " 24h=" + pad(usd(m ? m.quoteVolume24h : null), 7) +
      " 7d中位=" + pad(usd(m ? m.medianDailyVolume7d : null), 7) +
      " OI=" + pad(usd(m ? m.openInterestUsd : null), 6) +
      " spread=" + pad((m && m.spreadBps !== null ? m.spreadBps.toFixed(2) : "n/a"), 5) + "bps" +
      " age=" + (m && m.listingAgeDays !== null ? m.listingAgeDays : "?") + "d";
    console.log(line);
  }

  // ── Explainability: why were plausible symbols excluded? ──
  const decisions = Object.values(snap.decisions);
  const rejected = decisions.filter((d) => !d.eligible);
  console.log("");
  console.log("=== 被排除 " + rejected.length + " 個 — 取 3 個有量的看理由 ===");
  const interesting = rejected.filter((d) => {
    const m = snap.metrics[d.symbol];
    return !!m && (m.quoteVolume24h ?? 0) > 5e6;
  }).slice(0, 3);

  for (const d of interesting) {
    const m = snap.metrics[d.symbol];
    console.log("  " + d.symbol + "（24h " + usd(m ? m.quoteVolume24h : null) + "）被排除：");
    for (const c of d.checks) {
      if (!c.passed) console.log("     ✗ " + c.detail);
    }
  }

  // ── Hysteresis: same market → no churn ──
  const t1 = Date.now();
  const snap2 = await universeManager.refresh();
  const secs2 = ((Date.now() - t1) / 1000).toFixed(1);
  console.log("");
  console.log("=== 第 2 次 refresh（" + secs2 + " 秒）— hysteresis 驗證 ===");
  console.log("  added=" + snap2.added.length + " removed=" + snap2.removed.length + "  ← 同一市場下應為 0/0");
  // Membership is what matters; presentation order can shift when ranks move
  // slightly between refreshes, so compare as sets and report order separately.
  const a1 = [...snap.activeSymbols].sort();
  const a2 = [...snap2.activeSymbols].sort();
  const sameMembers = JSON.stringify(a1) === JSON.stringify(a2);
  const sameOrder = JSON.stringify(snap2.activeSymbols) === JSON.stringify(snap.activeSymbols);
  console.log("  成員完全相同：" + sameMembers);
  console.log("  排序也完全相同：" + sameOrder + (sameMembers && !sameOrder ? "（成員一致、僅排序依 rank 微調）" : ""));

  const corePresent = cfg.universe.core_symbols.every((c) => snap.activeSymbols.includes(c));
  // No size cap is asserted any more: the universe size is dynamic by design, so
  // the checks are "non-empty", "every member is genuinely eligible or core",
  // and "stable across two consecutive refreshes".
  const allMembersJustified = snap.activeSymbols.every((s) =>
    snap.coreSymbols.includes(s) || snap.decisions[s]?.eligible === true,
  );
  const noFixedCap = !("active_size" in cfg.universe);
  const ok = snap.activeSymbols.length > 0
    && corePresent
    && allMembersJustified
    && noFixedCap
    && snap2.added.length === 0
    && snap2.removed.length === 0;

  console.log("");
  console.log("=== 驗收 ===");
  console.log("  core 全數在清單內：" + corePresent);
  console.log("  每個成員都合格或是 core：" + allMembersJustified);
  console.log("  無固定大小上限：" + noFixedCap);
  console.log("  連續兩次刷新穩定（added=0/removed=0）：" + (snap2.added.length === 0 && snap2.removed.length === 0));
  console.log(ok ? "  ✅ PASS" : "  ❌ FAIL");
}

main().catch((err) => {
  console.error("UNIVERSE SMOKE FAILED:", err);
  process.exit(1);
});
