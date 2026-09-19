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

  console.log("");
  console.log("═".repeat(64));
  console.log(`掃描完成：${result.scanned} 組（幣×時框），失敗 ${result.failures} 組`);
  console.log(`追蹤幣種：${result.symbolCount} 個`);
  console.log(`最新一根已收盤的 K 線：${fmtTime(result.latestCandleTime)}（台灣時間）`);
  console.log("═".repeat(64));
  console.log("");
  console.log(`【剛發生的事件】${result.events.length} 則（已把同一根 K 線的多個價位合併）`);
  for (const g of result.events) {
    console.log(`  • ${g.symbol} ${g.timeframe.toUpperCase()} ${g.side} ${g.state} ×${g.levels.length} @ ${g.levels.join(", ")}`);
  }
  if (result.events.length === 0) console.log("  無。");

  console.log("");
  console.log(`【同區域已處理過，不再重複報】${result.historySkipped.length} 筆`);
  for (const h of result.historySkipped.slice(0, 15)) {
    const when = h.priorAt ? fmtTime(h.priorAt / 1000) : "—";
    console.log(`  ⊘ ${h.symbol} ${h.timeframe.toUpperCase()} ${h.side} ${h.price} — 同區域 ${h.priorPrice} 已於 ${when} ${h.priorState}`);
  }
  if (result.historySkipped.length > 15) console.log(`  …其餘 ${result.historySkipped.length - 15} 筆`);
  if (result.historySkipped.length === 0) console.log("  無。");

  console.log("");
  console.log(`【接近中】${result.approaches.length} 則（已合併跨時框重複）`);
  for (const a of result.approaches.slice(0, 20)) {
    const tfLabel = a.timeframes.map((t) => t.toUpperCase()).join("+");
    console.log(`  • ${a.symbol} ${tfLabel} ${a.side} ${a.price}（距離 ${a.distancePct.toFixed(2)}%）`);
  }
  if (result.approaches.length > 20) console.log(`  …其餘 ${result.approaches.length - 20} 筆`);
  if (result.approaches.length === 0) console.log("  無。");

  console.log("");
  console.log(`=== 通過去重／冷卻、待發送：${result.pending.length} 則 ===`);
  for (const a of result.pending) console.log(`  • ${a.label}`);
  for (const s2 of result.suppressed) {
    const why = s2.reason === "cooldown_active" ? "冷卻中" : "已通知過";
    console.log(`  ⊘ ${s2.label} — ${why}`);
  }

  if (!shouldSend) {
    console.log("");
    console.log("（演練模式：加上 --send 才會實際發送）");
    return;
  }

  console.log("");
  console.log("=== 發送 ===");
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
  console.log(`共發送 ${sent} 則${failed ? `，失敗 ${failed} 則` : ""}`);
}

main().catch((err) => {
  console.error("掃描失敗：", err);
  process.exit(1);
});
