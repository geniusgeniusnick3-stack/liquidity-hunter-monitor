/**
 * Prints the single-symbol reply for a real symbol, in all three languages.
 * Used to confirm what a user sees for /scan SYMBOL TF before it ships.
 */
import { runScan } from "../lib/scan/ScanEngine.js";
import { formatScanReply } from "../lib/notify/formatters.js";
import type { Language } from "../lib/notify/i18n.js";

const symbol = (process.argv[2] ?? "TRXUSDT").toUpperCase();
const tf = (process.argv[3] ?? "4h").toLowerCase();

for (const lang of ["zh-TW", "zh-CN", "en"] as Language[]) {
  process.env.NOTIFICATION_LANGUAGE = lang;
  const r = await runScan({ symbols: [symbol], timeframes: [tf], applyDedup: false });
  process.env.NOTIFICATION_LANGUAGE = "";
  delete process.env.NOTIFICATION_LANGUAGE;

  console.log("═".repeat(62));
  console.log(`  ${symbol} ${tf.toUpperCase()}  ｜  ${lang}`);
  console.log("═".repeat(62));
  console.log(formatScanReply({
    scope: `${symbol} ${tf.toUpperCase()}`,
    events: r.events, approaches: r.approaches, historySkipped: r.historySkipped,
    symbolCount: r.symbolCount, latestCandleTime: r.latestCandleTime,
    scanned: r.scanned, failures: r.failures, snapshots: r.snapshots,
  }, lang));
  console.log("");
}
