/**
 * Configuration sanity check — run after editing config.yaml.
 *
 * Fails loudly if the file cannot be found, is not valid YAML, or violates the
 * schema, so a typo'd threshold can never silently disable a filter at runtime.
 *
 * Run: NODE_ENV=production npx tsx artifacts/api-server/src/scripts/check-config.ts
 */
import { loadConfig, findConfigPath } from "../lib/config/index.js";

const file = findConfigPath();
console.log("config 檔案：" + file);

const c = loadConfig();

console.log("");
console.log("=== 關鍵設定 ===");
console.log("  universe.refresh_hours        = " + c.universe.refresh_hours);
console.log("  monitoring.mode               = " + c.monitoring.mode + "（passive=被動查詢 / active=背景監控）");
console.log("  monitoring.active_poll_seconds= " + c.monitoring.active_poll_seconds);
console.log("  monitoring.active_concurrency = " + c.monitoring.active_concurrency);
const el = c.universe.eligibility;
const m = (v: number) => "$" + (v / 1e6).toFixed(0) + "M";
const band = (e: number, r: number) => m(e) + " 加入 / " + m(r) + " 移出";

console.log("  universe 大小                 = 動態（無上限，通過門檻即全部納入）");
console.log("  universe.core_symbols         = " + c.universe.core_symbols.join(", "));
console.log("");
console.log("  ── 帶滯後的門檻（新幣看「加入」，已納入者看「移出」）──");
console.log("  24h 名目量                    = " + band(el.volume_24h.entry_min, el.volume_24h.removal_min));
console.log("  7d 中位量                     = " + band(el.median_volume_7d.entry_min, el.median_volume_7d.removal_min));
console.log("  持倉量 OI                     = " + band(el.open_interest.entry_min, el.open_interest.removal_min));
console.log("");
console.log("  ── 硬門檻（無滯後，加入與移出同一標準）──");
console.log("  買賣價差上限                  = " + el.max_spread_bps + " bps");
console.log("  上市天數                      = " + el.min_listing_age_days + " 天");
console.log("  liquidity.tolerance_atr_mult = " + c.liquidity.tolerance_atr_multiple);
console.log("  timeframes                   = " + c.timeframes.join(", "));
console.log("  scanner_timeframes           = " + c.scanner_timeframes.join(", "));
console.log("  alerts                       = " +
  Object.entries(c.alerts).filter(([, v]) => v).map(([k]) => k).join(", ") || "（全部關閉）");
console.log("  telegram.enabled             = " + c.telegram.enabled);
console.log("");
console.log("✅ 設定檔通過驗證");
