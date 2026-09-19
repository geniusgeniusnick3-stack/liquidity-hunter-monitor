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
console.log("  monitoring.active_batch_size  = " + c.monitoring.active_batch_size);
console.log("  universe 大小                 = 動態（無固定上限，通過門檻即納入）");
console.log("  universe.exit_threshold_factor= " + c.universe.exit_threshold_factor + "（退出門檻 = 進入 x 此值）");
console.log("  universe.core_symbols         = " + c.universe.core_symbols.join(", "));
console.log("  filters 24h 量門檻           = $" + (c.universe.filters.min_quote_volume_24h_usd / 1e6).toFixed(0) + "M");
console.log("  filters 7d 中位門檻          = $" + (c.universe.filters.min_median_daily_volume_7d_usd / 1e6).toFixed(0) + "M");
console.log("  filters OI 門檻              = $" + (c.universe.filters.min_open_interest_usd / 1e6).toFixed(0) + "M");
console.log("  filters 價差上限             = " + c.universe.filters.max_spread_bps + " bps");
console.log("  filters 上市天數門檻         = " + c.universe.filters.min_listing_age_days + " 天");
console.log("  liquidity.tolerance_atr_mult = " + c.liquidity.tolerance_atr_multiple);
console.log("  timeframes                   = " + c.timeframes.join(", "));
console.log("  scanner_timeframes           = " + c.scanner_timeframes.join(", "));
console.log("  alerts                       = " +
  Object.entries(c.alerts).filter(([, v]) => v).map(([k]) => k).join(", ") || "（全部關閉）");
console.log("  telegram.enabled             = " + c.telegram.enabled);
console.log("");
console.log("✅ 設定檔通過驗證");
