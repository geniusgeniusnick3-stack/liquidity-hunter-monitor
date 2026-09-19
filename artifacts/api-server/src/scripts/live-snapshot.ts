/**
 * PASSIVE-mode entry point: one scan, on demand.
 *
 * This script owns NO analysis logic. It calls the shared scan engine and
 * decides what to do with the result — which is the entire difference between
 * PASSIVE and ACTIVE. The ACTIVE monitor calls the same engine from
 * monitor-loop.ts.
 *
 * Usage:
 *   npx tsx artifacts/api-server/src/scripts/live-snapshot.ts
 *   npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --send
 *   npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --symbols BTCUSDT
 *   npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --symbols BTCUSDT --timeframe 1h
 *   npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --no-dedup   (debug)
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runScan } from "../lib/scan/ScanEngine.js";
import { telegramNotifier } from "../lib/notify/TelegramNotifier.js";
import { uiFor } from "../lib/notify/i18n.js";

(function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1).trim();
  }
})();

const args = process.argv.slice(2);
const shouldSend = args.includes("--send");
const noDedup = args.includes("--no-dedup");

const tfIdx = args.indexOf("--timeframe");
const onlyTimeframe = tfIdx !== -1 ? args[tfIdx + 1]?.toLowerCase() : undefined;

const symIdx = args.indexOf("--symbols");
const explicitSymbols = symIdx !== -1
  ? (args[symIdx + 1] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  : undefined;

function fmtTime(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

async function main(): Promise<void> {
  const result = await runScan({
    symbols: explicitSymbols,
    timeframes: onlyTimeframe ? [onlyTimeframe] : undefined,
    bypassDedup: noDedup,
    onLog: (m) => console.log(m),
  });

  // Everything the user reads follows the resolved language, including this
  // summary — not just the alert bodies. Otherwise switching to English yields a
  // half-translated conversation.
  const t = uiFor(result.language);

  console.log("");
  console.log("═".repeat(64));
  console.log(t.scanDone(result.scanned, result.failures));
  console.log(t.trackedSymbols(result.symbolCount));
  console.log(t.latestClosedCandle(fmtTime(result.latestCandleTime)));
  console.log("═".repeat(64));
  console.log("");
  console.log(t.eventsHeading(result.events.length));
  for (const g of result.events) {
    console.log(`  • ${g.symbol} ${g.timeframe.toUpperCase()} ${g.side} ${g.state} ×${g.levels.length} @ ${g.levels.join(", ")}`);
  }
  if (result.events.length === 0) console.log(`  ${t.none}`);

  console.log("");
  console.log(t.historyHeading(result.historySkipped.length));
  for (const h of result.historySkipped.slice(0, 15)) {
    const when = h.priorAt ? fmtTime(h.priorAt / 1000) : "—";
    console.log(`  ⊘ ${h.symbol} ${h.timeframe.toUpperCase()} ${h.side} ${h.price} — ${t.sameArea} ${h.priorPrice} ${t.wasOn} ${when} ${h.priorState}`);
  }
  if (result.historySkipped.length > 15) console.log(`  ${t.more(result.historySkipped.length - 15)}`);
  if (result.historySkipped.length === 0) console.log(`  ${t.none}`);

  console.log("");
  console.log(t.approachesHeading(result.approaches.length));
  for (const a of result.approaches.slice(0, 20)) {
    const tfLabel = a.timeframes.map((x) => x.toUpperCase()).join("+");
    console.log(`  • ${a.symbol} ${tfLabel} ${a.side} ${a.price}（${a.distancePct.toFixed(2)}%）`);
  }
  if (result.approaches.length > 20) console.log(`  ${t.more(result.approaches.length - 20)}`);
  if (result.approaches.length === 0) console.log(`  ${t.none}`);

  console.log("");
  console.log(t.pendingHeading(result.pending.length));
  for (const a of result.pending) console.log(`  • ${a.label}`);
  for (const s2 of result.suppressed) {
    const why = s2.reason === "cooldown_active" ? t.reasonCooldown : t.reasonAlreadySent;
    console.log(`  ⊘ ${s2.label} — ${why}`);
  }

  if (!shouldSend) {
    console.log("");
    console.log(t.dryRunNote);
    return;
  }

  console.log("");
  let sent = 0;
  let failed = 0;
  for (const alert of result.pending) {
    const ok = await telegramNotifier.send(alert.text);
    if (ok) {
      sent++;
      console.log(`  ✓ ${alert.label}`);
    } else {
      failed++;
      console.log(`  ✗ ${alert.label}`);
    }
  }
  console.log("");
  console.log(failed ? t.sentWithFailures(sent, failed) : t.sentCount(sent));
}

main().catch((err) => {
  console.error("掃描失敗：", err);
  process.exit(1);
});
