/**
 * Verifies that a passive query is repeatable.
 *
 * The property under test: asking the same question twice returns the same
 * answer. Deduplication exists so a background monitor does not interrupt with
 * the same event repeatedly — it must NOT make a manual query return less the
 * second time. "No events" is the wrong reply to "what is happening?" when
 * levels are sitting there live and were merely reported earlier.
 *
 * Run:
 *   npx tsx artifacts/api-server/src/scripts/verify-query-repeatable.ts
 */
import { runScan } from "../lib/scan/ScanEngine.js";
import { formatScanReply } from "../lib/notify/formatters.js";
import { uiFor } from "../lib/notify/i18n.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ FAIL: ${label}`); }
}

const SYMBOLS = ["XLMUSDT", "TRXUSDT", "DOGEUSDT"];

async function reply(): Promise<{ text: string; events: number; approaches: number; lang: string }> {
  const r = await runScan({ symbols: SYMBOLS, timeframes: ["1h", "4h"], applyDedup: false });
  return {
    lang: r.language,
    text: formatScanReply({
      scope: "test symbols",
      events: r.events, approaches: r.approaches, historySkipped: r.historySkipped,
      symbolCount: r.symbolCount, latestCandleTime: r.latestCandleTime,
      scanned: r.scanned, failures: r.failures,
    }, r.language),
    events: r.events.length,
    approaches: r.approaches.length,
  };
}

console.log("═".repeat(64));
console.log("被動查詢必須可重複：連續問兩次，答案必須相同");
console.log("═".repeat(64));
console.log(`  標的：${SYMBOLS.join(", ")}`);

const first = await reply();
const second = await reply();
const third = await reply();

console.log("");
console.log("  第 1 次的回覆：");
for (const l of first.text.split("\n")) console.log(`    ${l}`);
console.log("");
console.log(`  第 2 次：${second.events} 事件 / ${second.approaches} 接近`);
console.log(`  第 3 次：${third.events} 事件 / ${third.approaches} 接近`);

console.log("");
ok(first.events === second.events && second.events === third.events,
  `事件數三次相同（${first.events}）`);
ok(first.approaches === second.approaches && second.approaches === third.approaches,
  `接近數三次相同（${first.approaches}）`);
ok(first.text === second.text && second.text === third.text,
  "回覆內容逐字相同（沒有因為問過而變少）");

// If there are events, every repeat must list them too — never degrade into a
// "nothing to report" reply merely because they were shown before.
// The assertion uses the language's own heading, not a hard-coded string: the
// language is whatever the user selected, and a test that assumes one would
// break the moment they pick another.
if (first.events > 0) {
  const heading = uiFor(first.lang as Parameters<typeof uiFor>[0]).replyEventsHeading;
  ok(second.text.includes(heading), `第二次查詢仍然列出事件（heading: ${heading}）`);
  ok(third.text.includes(heading), "第三次查詢仍然列出事件");
  ok(second.text.includes("XLMUSDT"), "第二次仍列出幣種");
}

console.log("");
console.log("═".repeat(64));
console.log(`  ${passed} 項通過，${failed} 項失敗`);
console.log("═".repeat(64));
if (failed > 0) process.exit(1);
