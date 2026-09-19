/**
 * Live liquidity snapshot — REAL market data, REAL engine, REAL events.
 *
 * Unlike notify-preview.ts (which uses invented sample numbers to demonstrate
 * message shape), this script fetches live Binance USDT-M candles for the
 * current watchlist, runs the actual SMC engine, and reports what genuinely
 * happened on the most recently CLOSED candle of each timeframe.
 *
 * Two protections against spam, both required by the spec:
 *
 *   §17 de-duplication — an event already announced is never announced again.
 *       State is PERSISTED (SQLite) so a restart does not re-announce the same
 *       candle. Without persistence a one-shot script would re-send everything
 *       on every run.
 *
 *   §18 cooldown — a symbol that just alerted stays quiet for a configured
 *       window, even if a different level triggers.
 *
 * Plus ONE grouping rule that the spec implies but does not spell out:
 * several adjacent levels taken by the SAME candle are ONE event. Announcing
 * ENAUSDT 0.18887 and 0.18997 separately reads as a duplicate even though both
 * are real levels.
 *
 * Run:
 *   NODE_ENV=production npx tsx artifacts/api-server/src/scripts/live-snapshot.ts
 *   NODE_ENV=production npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --send
 *   NODE_ENV=production npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --symbols BTCUSDT,ETHUSDT
 *   NODE_ENV=production npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --no-dedup   (debug)
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../lib/config/index.js";
import { fetchKlines } from "../lib/market/futures.js";
import { analyzeLiquidity } from "../lib/smc/liquidity.js";
import { formatApproaching, formatSweepGroup } from "../lib/notify/formatters.js";
import { telegramNotifier } from "../lib/notify/TelegramNotifier.js";
import { AlertDeduplicator, liquidityLevelId, type AlertIdentity } from "../lib/events/Deduplicator.js";
import { getLiquidityStore } from "../lib/persistence/LiquidityStore.js";
import type { LiquiditySide } from "../lib/notify/formatters.js";

(function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
})();

const args = process.argv.slice(2);
const shouldSend = args.includes("--send");
const noDedup = args.includes("--no-dedup");
const tfIdx = args.indexOf("--timeframe");
const onlyTimeframe = tfIdx !== -1 ? args[tfIdx + 1]?.toLowerCase() : undefined;
const symIdx = args.indexOf("--symbols");
const explicitSymbols = symIdx >= 0
  ? args[symIdx + 1]?.split(",").map((s) => s.trim().toUpperCase())
  : undefined;

function fmtTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/**
 * Several levels taken by ONE candle, collapsed into a single event.
 * `levels` keeps every level so nothing is lost — the message lists them.
 */
interface GroupedEvent {
  symbol: string;
  timeframe: string;
  side: LiquiditySide;
  state: "SWEPT" | "BROKEN";
  candleTime: number;
  levels: number[];
  extreme: number;
  close: number;
}

interface Approaching {
  symbol: string;
  timeframe: string;
  side: LiquiditySide;
  price: number;
  currentPrice: number;
  distancePct: number;
  source: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  // /scan SYMBOL 1h → honour an explicit single timeframe.
  const timeframes = onlyTimeframe ? [onlyTimeframe] : config.timeframes;
  const approachPct = config.alert_thresholds.approaching_distance_pct;

  // ── Dedup + cooldown (§17, §18), persisted across runs ──
  const store = getLiquidityStore();
  const dedup = new AlertDeduplicator(
    {
      dedupWindowHours: config.alert_thresholds.dedup_window_hours,
      cooldownMinutes: config.alert_thresholds.cooldown_minutes,
    },
    () => Date.now(),
  );
  const savedDedup = store.getState<ReturnType<AlertDeduplicator["exportState"]>>("dedup_state");
  if (savedDedup && !noDedup) {
    dedup.importState(savedDedup);
    console.log(`已載入去重狀態：${dedup.getStats().trackedEvents} 筆事件、${dedup.getStats().trackedLevels} 個價位`);
  }

  // ── Which symbols? ──
  let symbols: string[];
  if (explicitSymbols) {
    symbols = explicitSymbols;
    console.log(`使用指定幣種：${symbols.join(", ")}`);
  } else {
    console.log("載入動態監控清單（會呼叫 Binance 全市場端點，約需 10-30 秒）…");
    const { universeManager } = await import("../lib/universe/DynamicUniverseManager.js");
    const snap = await universeManager.refresh();
    symbols = snap.activeSymbols;
    console.log(`監控清單：${symbols.length} 個幣（${snap.eligibleCount} 個通過流動性門檻）`);
  }

  console.log("");
  console.log(`分析時框：${timeframes.join(", ")}｜接近門檻：${approachPct}%｜冷卻：${config.alert_thresholds.cooldown_minutes} 分`);

  // ── Scan ──
  const regionTolerancePct = config.liquidity.region_tolerance_pct;
  const regionLookbackDays = config.liquidity.region_lookback_days;
  const groupMap = new Map<string, GroupedEvent>();
  const approachingList: Approaching[] = [];
  /** Levels skipped because their price AREA was already handled (§11). */
  const historySkipped: Array<{
    symbol: string; timeframe: string; side: LiquiditySide; price: number;
    priorPrice: number; priorState: string; priorAt: number | null;
  }> = [];
  let scanned = 0;
  let failures = 0;
  let latestCandleTime = 0;

  for (const symbol of symbols) {
    for (const tf of timeframes) {
      try {
        const candles = await fetchKlines(symbol, tf, 500);
        if (candles.length < config.scanner.min_candles_required) continue;

        scanned++;
        const lastClosed = candles[candles.length - 1];
        latestCandleTime = Math.max(latestCandleTime, lastClosed.time);
        const currentPrice = lastClosed.close;
        const res = analyzeLiquidity(candles, tf, "crypto");

        for (const pool of res.pools) {
          const side: LiquiditySide = pool.type === "SSL" ? "SSL" : "BSL";
          const levelId = liquidityLevelId(symbol, tf, side, pool.time, pool.price);

          // ── Ledger write (§11): remember this level exists ──
          store.upsertLevel({
            id: levelId,
            symbol,
            timeframe: tf,
            side,
            price: pool.price,
            formedAt: pool.time,
            session: pool.session,
            source: `${pool.touches} 次觸及`,
            touches: pool.touches,
          });

          // If the engine has already settled this level, persist that verdict so
          // it survives restarts and is available to later scans.
          if (pool.wasSwept && pool.interactionAt !== null && pool.interactionCandle) {
            store.setState(
              levelId,
              pool.interaction === "BROKEN" ? "BROKEN" : "SWEPT",
              {
                sweptAt: pool.interaction === "SWEPT" ? pool.interactionAt * 1000 : undefined,
                sweepExtreme: side === "BSL" ? pool.interactionCandle.high : pool.interactionCandle.low,
                brokenAt: pool.interaction === "BROKEN" ? pool.interactionAt * 1000 : undefined,
              },
            );
          }

          // ── Same-area memory (§11) ──
          // A rolling-window pivot has no history, so an area handled days ago can
          // look brand new. If a level within `region_tolerance_pct` of this one
          // was already consumed, this is the same area to a human — don't
          // re-announce it as a fresh target.
          if (!pool.wasSwept) {
            const priorTaken = store.takenNear(symbol, tf, side, pool.price, regionTolerancePct, regionLookbackDays);
            if (priorTaken && priorTaken.id !== levelId) {
              historySkipped.push({
                symbol,
                timeframe: tf,
                side,
                price: pool.price,
                priorPrice: priorTaken.price,
                priorState: priorTaken.state,
                priorAt: priorTaken.sweptAt ?? priorTaken.brokenAt ?? priorTaken.stateChangedAt,
              });
              continue;
            }
          }

          // A genuine event: the interaction landed on the most recent
          // COMPLETED candle. Earlier candles are history, not news.
          const isEvent = pool.interactionAt === lastClosed.time
            && (pool.interaction === "SWEPT" || pool.interaction === "BROKEN");

          if (isEvent && pool.interactionCandle) {
            const key = `${symbol}|${tf}|${side}|${pool.interaction}|${lastClosed.time}`;
            const existing = groupMap.get(key);
            if (existing) {
              existing.levels.push(pool.price);
            } else {
              groupMap.set(key, {
                symbol, timeframe: tf, side,
                state: pool.interaction as "SWEPT" | "BROKEN",
                candleTime: lastClosed.time,
                levels: [pool.price],
                extreme: side === "BSL" ? pool.interactionCandle.high : pool.interactionCandle.low,
                close: pool.interactionCandle.close,
              });
            }
            continue;
          }

          // Approaching and still untaken.
          if (!pool.wasSwept) {
            const distancePct = Math.abs(pool.price - currentPrice) / currentPrice * 100;
            const onCorrectSide = side === "BSL" ? pool.price > currentPrice : pool.price < currentPrice;
            if (onCorrectSide && distancePct <= approachPct) {
              approachingList.push({
                symbol, timeframe: tf, side, price: pool.price,
                currentPrice, distancePct,
                source: `${pool.touches} 次觸及｜${pool.session ?? "未知時段"}`,
              });
            }
          }
        }
      } catch {
        failures++;
      }
    }
  }

  const groups = [...groupMap.values()];

  // ── Cross-timeframe collapse (§7 spirit: one fact, one message) ──
  // The same price is often a pivot on several timeframes at once (XRPUSDT
  // 1.4392 showed up on both 1H and 4H). To a human that is ONE observation, so
  // report the highest timeframe and note the others instead of sending twice.
  const approachMap = new Map<string, Approaching & { timeframes: string[] }>();
  for (const a of approachingList) {
    const bucket = Math.round(Math.log(a.price) / Math.log(1.002)); // 0.2% price buckets
    const key = `${a.symbol}|${a.side}|${bucket}`;
    const existing = approachMap.get(key);
    if (existing) {
      if (!existing.timeframes.includes(a.timeframe)) existing.timeframes.push(a.timeframe);
      // Keep the closest reading — that is the most informative one.
      if (a.distancePct < existing.distancePct) {
        existing.distancePct = a.distancePct;
        existing.currentPrice = a.currentPrice;
        existing.price = a.price;
      }
      continue;
    }
    approachMap.set(key, { ...a, timeframes: [a.timeframe] });
  }

  // Highest timeframe first in the label; the primary one drives the message.
  const TF_ORDER = ["1w", "1d", "4h", "1h", "30m", "15m", "5m", "1m"];
  const approaches = [...approachMap.values()].map((a) => {
    const sorted = [...a.timeframes].sort((x, y) => TF_ORDER.indexOf(x) - TF_ORDER.indexOf(y));
    return { ...a, timeframes: sorted, primary: sorted[0] };
  });

  console.log("");
  console.log("═".repeat(64));
  console.log(`掃描完成：${scanned} 組（幣×時框），失敗 ${failures} 組`);
  console.log(`最新一根已收盤的 K 線：${fmtTime(latestCandleTime)}（台灣時間）`);
  console.log("═".repeat(64));
  console.log("");
  console.log(`【剛發生的事件】${groups.length} 則（已把同一根 K 線的多個價位合併）`);
  for (const g of groups) {
    console.log(`  • ${g.symbol} ${g.timeframe.toUpperCase()} ${g.side} ${g.state} ×${g.levels.length} @ ${g.levels.join(", ")}`);
  }
  if (groups.length === 0) console.log("  無。");
  console.log("");
  console.log(`【同區域已處理過，不再重複報】${historySkipped.length} 筆（區域容忍度 ${regionTolerancePct}%｜回溯 ${regionLookbackDays} 天）`);
  for (const h of historySkipped.slice(0, 15)) {
    const when = h.priorAt ? fmtTime(h.priorAt / 1000) : "—";
    console.log(`  ⊘ ${h.symbol} ${h.timeframe.toUpperCase()} ${h.side} ${h.price} — 同區域 ${h.priorPrice} 已於 ${when} ${h.priorState}`);
  }
  if (historySkipped.length > 15) console.log(`  …其餘 ${historySkipped.length - 15} 筆`);
  if (historySkipped.length === 0) console.log("  無。");
  console.log("");
  console.log(`【接近中】${approaches.length} 則（距離 ≤ ${approachPct}%，已合併跨時框重複）`);
  for (const a of approaches.slice(0, 20)) {
    const tfLabel = a.timeframes.map((t) => t.toUpperCase()).join("+");
    console.log(`  • ${a.symbol} ${tfLabel} ${a.side} ${a.price}（距離 ${a.distancePct.toFixed(2)}%）`);
  }
  if (approaches.length > 20) console.log(`  …其餘 ${approaches.length - 20} 筆`);
  if (approaches.length === 0) console.log("  無。");

  // ── Apply §17/§18 before sending ──
  const toSend: Array<{ text: string; identity: AlertIdentity; label: string }> = [];

  for (const g of groups) {
    const identity: AlertIdentity = {
      symbol: g.symbol,
      timeframe: g.timeframe,
      eventType: `LIQUIDITY_${g.state}`,
      // The candle that did the taking IS the event identity — so a re-run on
      // the same candle is recognised as the same event, while a later candle
      // taking the same level is genuinely new.
      levelId: `${g.side}|${g.candleTime}|${[...g.levels].sort((a, b) => a - b).join(",")}`,
      state: g.state,
    };
    const decision = noDedup ? { send: true, reason: "new_event" as const } : dedup.shouldSend(identity);
    const label = `${g.symbol} ${g.timeframe.toUpperCase()} ${g.side} ${g.state} ×${g.levels.length}`;

    if (!decision.send) {
      const why = decision.reason === "cooldown_active"
        ? `冷卻中（剩 ${decision.cooldownRemainingSeconds} 秒）`
        : decision.reason === "duplicate_event"
          ? `已通知過（${Math.round((decision.duplicateAgeMs ?? 0) / 60000)} 分鐘前）`
          : decision.reason;
      console.log(`  ⊘ ${label} — ${why}`);
      continue;
    }

    toSend.push({
      text: formatSweepGroup({
        symbol: g.symbol, timeframe: g.timeframe, side: g.side,
        levels: g.levels, extreme: g.extreme, close: g.close, broken: g.state === "BROKEN",
      }),
      identity,
      label,
    });
  }

  // Approaching alerts share the same cooldown (§18) — one per symbol per window.
  for (const a of approaches) {
    const identity: AlertIdentity = {
      symbol: a.symbol,
      timeframe: a.primary,
      eventType: "LIQUIDITY_APPROACHING",
      // Identity covers every timeframe this price appears on, so the 1H/4H pair
      // of the same price is one alert, not two.
      levelId: `${a.side}|${a.price}|${[...a.timeframes].sort().join("+")}`,
      state: "APPROACHING",
    };
    const decision = noDedup ? { send: true, reason: "new_event" as const } : dedup.shouldSend(identity);
    const tfLabel = a.timeframes.map((t) => t.toUpperCase()).join("+");
    const label = `${a.symbol} ${tfLabel} ${a.side} 接近 ${a.price}`;
    if (!decision.send) {
      console.log(`  ⊘ ${label} — ${decision.reason === "cooldown_active" ? "冷卻中" : "已通知過"}`);
      continue;
    }
    const otherTfs = a.timeframes.filter((t) => t !== a.primary).map((t) => t.toUpperCase());
    toSend.push({
      text: formatApproaching({
        symbol: a.symbol, timeframe: a.primary, side: a.side, level: a.price,
        currentPrice: a.currentPrice, distancePct: a.distancePct,
        source: a.source + (otherTfs.length ? `｜亦出現於 ${otherTfs.join("、")}` : ""),
      }),
      identity,
      label,
    });
  }

  console.log("");
  console.log(`=== 通過去重／冷卻、待發送：${toSend.length} 則 ===`);
  for (const t of toSend) console.log(`  • ${t.label}`);

  if (!shouldSend) {
    console.log("");
    console.log("（演練模式：加上 --send 才會實際發送）");
    return;
  }
  if (!config.telegram.enabled) {
    console.log("\nTelegram 在 config.yaml 中是停用的，未發送。");
    return;
  }
  if (toSend.length === 0) {
    console.log("\n沒有需要發送的內容（全部已被去重或冷卻擋下）。");
    return;
  }

  console.log("");
  console.log("=== 發送 ===");
  for (const t of toSend) {
    const r = await telegramNotifier.send(t.text, { enabled: true, parseMode: config.telegram.parse_mode });
    console.log(`  ${r.ok ? "✓" : "✗"} ${t.label}${r.ok ? "" : ` — ${r.error}`}`);
    // Only a delivered alert counts as announced (§17).
    if (r.ok) dedup.record(t.identity);
    await new Promise((res) => setTimeout(res, 350));
  }

  // ── Persist dedup state so the next run (or a restart) stays quiet ──
  store.putState("dedup_state", dedup.exportState());
  console.log("");
  console.log(`去重狀態已儲存：${dedup.getStats().trackedEvents} 筆事件、${dedup.getStats().trackedLevels} 個價位`);
  console.log(`共發送 ${telegramNotifier.getStatus(true).sent} 則`);
  store.close();
}

main().catch((err) => {
  console.error("快照失敗：", err instanceof Error ? err.message : err);
  process.exit(1);
});
