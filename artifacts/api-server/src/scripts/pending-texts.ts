/**
 * Print the TEXT of every pending alert for real symbols, in three languages.
 *
 * Verification tool for the notification wording: the pending texts are what a
 * Telegram/iMessage push actually contains, and printing them (instead of
 * sending them) is the only way to read them without spamming the channel.
 *
 * Usage: npx tsx src/scripts/pending-texts.ts [SYMBOLS] [TIMEFRAMES]
 */
import { runScan } from "../lib/scan/ScanEngine.js";
import type { Language } from "../lib/notify/i18n.js";

const symbols = (process.argv[2] ?? "BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,XRPUSDT,TAOUSDT").split(",");
const tfs = (process.argv[3] ?? "1h,4h").split(",");

const langs = (process.env.PT_LANGS ?? "zh-TW,zh-CN,en").split(",") as Language[];

for (const lang of langs) {
  process.env.NOTIFICATION_LANGUAGE = lang;
  for (const sym of symbols) {
    const r = await runScan({ symbols: [sym], timeframes: tfs, applyDedup: false });
    for (const p of r.pending) {
      console.log(`\n───── ${lang} ｜ ${sym} ｜ ${p.label} ─────`);
      console.log(p.text);
    }
  }
  delete process.env.NOTIFICATION_LANGUAGE;
}
