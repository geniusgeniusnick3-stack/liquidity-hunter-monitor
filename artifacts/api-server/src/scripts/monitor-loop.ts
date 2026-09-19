/**
 * ACTIVE-mode background monitor.
 *
 * "Monitor for me and tell me when something happens."
 *
 * This process owns NO analysis logic. It calls the same runScan() engine that
 * PASSIVE mode calls from a Telegram command; the only differences are that a
 * timer triggers the scan and that the resulting alerts are pushed rather than
 * echoed back to a waiting command.
 *
 * Scheduling discipline (so this is not "a naive loop that REST-downloads every
 * symbol every few seconds"):
 *
 *   - It wakes every `monitoring.active_poll_seconds`, but waking costs nothing:
 *     the first thing it does is compare wall-clock time against the last candle
 *     close it has seen. If no monitored timeframe has closed since the previous
 *     pass, it goes straight back to sleep with ZERO exchange requests.
 *
 *   - Candle data comes from the shared CandleCache, so within a candle period
 *     repeated polls reuse the same bars instead of re-downloading history.
 *
 *   - Universe membership is refreshed on its own slower cadence
 *     (`universe.refresh_hours`), decoupled from the market poll. Membership
 *     changes slowly; price does not.
 *
 *   - Work per scan is spread with a bounded concurrency limit.
 *
 * Refuses to run unless monitoring.mode is "active", so it cannot be started by
 * accident and begin sending alerts nobody asked for.
 *
 * Usage:
 *   MONITORING_MODE=active npx tsx artifacts/api-server/src/scripts/monitor-loop.ts
 *   ... --once      run a single pass and exit (for testing)
 *   ... --dry-run   detect and log, but never send
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../lib/config/index.js";
import { runScan } from "../lib/scan/ScanEngine.js";
import { candleCache, nextCandleClose, TF_MS } from "../lib/market/CandleCache.js";
import { telegramNotifier } from "../lib/notify/TelegramNotifier.js";
import { uiFor } from "../lib/notify/i18n.js";
import { logger } from "../lib/logger.js";

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
const once = args.includes("--once");
const dryRun = args.includes("--dry-run");

// Optional scope narrowing. Mainly used to prove that ACTIVE and PASSIVE produce
// identical output for identical input, but also handy for monitoring a single
// symbol without building a whole universe.
const symIdx = args.indexOf("--symbols");
const explicitSymbols = symIdx !== -1
  ? (args[symIdx + 1] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  : undefined;

const tfIdx = args.indexOf("--timeframe");
const explicitTimeframes = tfIdx !== -1
  ? [(args[tfIdx + 1] ?? "").toLowerCase()].filter(Boolean)
  : undefined;

/** Same format as the PASSIVE script, so the two modes are diffable. */
function fmtTaipei(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Refuse to run in PASSIVE mode. Starting a continuous monitor has to be a
  // deliberate act; silently interpreting "no mode set" as "monitor everything"
  // is exactly the failure this guard exists to prevent.
  if (config.monitoring.mode !== "active") {
    console.error(
      `監控模式目前是 "${config.monitoring.mode}"，不是 "active"。\n` +
      `ACTIVE 模式必須明確開啟（不會預設啟動）：\n` +
      `  在 config.yaml 設定 monitoring.mode: active\n` +
      `  或使用環境變數 MONITORING_MODE=active`,
    );
    process.exit(1);
  }

  const timeframes = explicitTimeframes ?? config.timeframes;
  const pollMs = config.monitoring.active_poll_seconds * 1000;

  logger.warn(
    { timeframes, pollSeconds: config.monitoring.active_poll_seconds, dryRun },
    "ACTIVE 監控已啟動 — 將發送主動通知",
  );

  // Last candle close we have already analysed, per timeframe. Zero means
  // "nothing seen yet", which forces one scan on startup.
  const lastSeen = new Map<string, number>();
  for (const tf of timeframes) lastSeen.set(tf, 0);

  let running = false;
  let passes = 0;
  let scans = 0;

  const doPass = async (): Promise<void> => {
    if (running) return;                     // never overlap passes
    running = true;
    passes++;

    try {
      const now = Date.now();

      // ── The cheap check that keeps idle cost at zero ──
      // A timeframe is due only if its most recent close is newer than the last
      // one we analysed. Nothing has closed → no requests, no scan.
      const due = timeframes.filter((tf) => {
        const ms = TF_MS[tf];
        if (!ms) return false;
        const lastClose = Math.floor(now / ms) * ms;   // close of the previous candle
        return lastClose > (lastSeen.get(tf) ?? 0);
      });

      if (due.length === 0) {
        logger.debug({ passes }, "沒有新的已收盤 K 線 — 本輪不掃描（零請求）");
        if (once) {
          console.log("沒有新的已收盤 K 線，無事可做。");
        }
        return;
      }

      // ── A scan is warranted ──
      // Always evaluate every configured timeframe when any of them rolled over:
      // alerts are judged per timeframe, and analysing only the one that closed
      // would make the outcome depend on poll timing.
      const before = candleCache.getStats();
      logger.info({ due, timeframes }, "偵測到已收盤 K 線 — 開始掃描");

      const result = await runScan({
        timeframes,
        symbols: explicitSymbols,
        // Push delivery: suppress events already reported, so a background
        // monitor does not interrupt about the same level over and over.
        applyDedup: true,
        // active_concurrency caps how many symbol/timeframe requests are in flight
        // at once, which is what keeps a large universe inside rate limits.
        concurrency: config.monitoring.active_concurrency,
        candleSource: (symbol, tf, limit) => candleCache.get(symbol, tf, limit),
        onLog: (m) => logger.info({}, m),
      });
      scans++;

      const after = candleCache.getStats();
      logger.info(
        {
          scanned: result.scanned,
          failures: result.failures,
          symbols: result.symbolCount,
          events: result.events.length,
          approaches: result.approaches.length,
          historySkipped: result.historySkipped.length,
          pending: result.pending.length,
          suppressed: result.suppressed.length,
          cacheHits: after.hits - before.hits,
          cacheMisses: after.misses - before.misses,
        },
        "掃描完成",
      );

      // Mark these closes as handled only AFTER a successful pass, so a thrown
      // error retries on the next tick instead of silently skipping a candle.
      for (const tf of timeframes) {
        const ms = TF_MS[tf];
        if (!ms) continue;
        const lastClose = Math.floor(now / ms) * ms;
        if (lastClose > (lastSeen.get(tf) ?? 0)) lastSeen.set(tf, lastClose);
      }

      if (result.latestCandleTime) {
        logger.info({ latestCandle: fmtTaipei(result.latestCandleTime) }, "最新已收盤 K 線");
      }

      // ── Human-readable summary (before any early return, so --once always prints) ── Deliberately identical in shape to the PASSIVE
      // script's output: the two modes must be comparable line for line, and
      // verify-mode-parity.ts depends on that to prove they agree.
      if (once) {
        const t = uiFor(result.language);
        console.log("");
        console.log(t.scanDone(result.scanned, result.failures));
        console.log(t.trackedSymbols(result.symbolCount));
        console.log("");
        console.log(t.eventsHeading(result.events.length));
        for (const g of result.events) {
          console.log(`  • ${g.symbol} ${g.timeframe.toUpperCase()} ${g.side} ${g.state} ×${g.levels.length} @ ${g.levels.join(", ")}`);
        }
        if (result.events.length === 0) console.log(`  ${t.none}`);
        console.log("");
        console.log(t.historyHeading(result.historySkipped.length));
        for (const h of result.historySkipped) {
          const when = h.priorAt ? fmtTaipei(h.priorAt / 1000) : "—";
          console.log(`  ⊘ ${h.symbol} ${h.timeframe.toUpperCase()} ${h.side} ${h.price} — ${t.sameArea} ${h.priorPrice} ${t.wasOn} ${when} ${h.priorState}`);
        }
        if (result.historySkipped.length === 0) console.log(`  ${t.none}`);
        console.log("");
        console.log(t.approachesHeading(result.approaches.length));
        for (const a of result.approaches) {
          const tfLabel = a.timeframes.map((x) => x.toUpperCase()).join("+");
          console.log(`  • ${a.symbol} ${tfLabel} ${a.side} ${a.price}（${a.distancePct.toFixed(2)}%）`);
        }
        if (result.approaches.length === 0) console.log(`  ${t.none}`);
        console.log("");
        console.log(t.pendingHeading(result.pending.length));
        for (const a of result.pending) console.log(`  • ${a.label}`);
        for (const s2 of result.suppressed) {
          const why = s2.reason === "cooldown_active" ? t.reasonCooldown : t.reasonAlreadySent;
          console.log(`  ⊘ ${s2.label} — ${why}`);
        }
      }

      // ── Transmit ──
      if (result.pending.length === 0) {
        logger.info({}, "沒有需要發送的通知");
        return;
      }

      if (dryRun) {
        logger.warn({ count: result.pending.length }, "演練模式：不發送");
        return;
      }

      let sent = 0;
      let failed = 0;
      for (const alert of result.pending) {
        const ok = await telegramNotifier.send(alert.text);
        if (ok) sent++;
        else failed++;
      }
      logger.info({ sent, failed }, failed ? "部分通知發送失敗" : "通知已發送");

      // Housekeeping: drop cache entries that can no longer be current.
      const pruned = candleCache.prune();
      if (pruned) logger.debug({ pruned }, "清理過期 K 線快取");
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "監控週期發生錯誤（將於下一輪重試）");
    } finally {
      running = false;
    }
  };

  await doPass();
  if (once) {
    return;
  }

  // Heartbeat: log cache effectiveness periodically so it is visible whether the
  // cache is actually absorbing polls rather than silently missing.
  const heartbeat = setInterval(() => {
    const s = candleCache.getStats();
    logger.info(
      { passes, scans, cacheHits: s.hits, cacheMisses: s.misses, cachedSymbols: s.entries },
      "監控心跳",
    );
  }, 15 * 60_000);

  const timer = setInterval(() => { void doPass(); }, pollMs);

  const shutdown = (signal: string): void => {
    logger.warn({ signal }, "收到停止訊號，正在關閉監控");
    clearInterval(timer);
    clearInterval(heartbeat);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info({ pollSeconds: config.monitoring.active_poll_seconds }, "進入監控迴圈");
}

main().catch((err) => {
  console.error("監控啟動失敗：", err);
  process.exit(1);
});
