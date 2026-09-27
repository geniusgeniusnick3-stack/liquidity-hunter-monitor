/**
 * Verifies the architectural contract: PASSIVE and ACTIVE must not have
 * separate analysis logic.
 *
 * Two independent checks:
 *
 *   1. STATIC — neither entry point may import market-interpretation code
 *      (the SMC engine, liquidity classification, universe filters). If either
 *      grows its own analysis, this fails.
 *
 *   2. BEHAVIOURAL — for identical input, both modes must produce identical
 *      output. The scripts are actually executed and their per-symbol results
 *      compared, rather than assuming shared code implies shared behaviour.
 *
 * Run:
 *   npx tsx artifacts/api-server/src/scripts/verify-mode-parity.ts
 */
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SRC = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(import.meta.dirname, "../../../..");

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ FAIL: ${label}`); }
}

console.log("═".repeat(64));
console.log("模式一致性驗收：PASSIVE 與 ACTIVE 必須共用同一套分析邏輯");
console.log("═".repeat(64));

// ── 1. 靜態檢查：入口檔不得自行實作分析 ─────────────────────────────────────

console.log("");
console.log("【1】靜態檢查 — 入口檔是否直接呼叫分析邏輯");

const PASSIVE = path.join(SRC, "scripts/live-snapshot.ts");
const ACTIVE = path.join(SRC, "scripts/monitor-loop.ts");

/** Imports that would mean an entry point owns analysis of its own. */
const ANALYSIS_IMPORTS = [
  "smc/liquidity",
  "analyzeLiquidity",
  "smc/structure",
  "smc/order-blocks",
  "universe/LiquidityFilters",
  "evaluateEligibility",
];

for (const [name, file] of [["PASSIVE (live-snapshot)", PASSIVE], ["ACTIVE (monitor-loop)", ACTIVE]] as const) {
  const src = readFileSync(file, "utf8");
  const offenders = ANALYSIS_IMPORTS.filter((imp) => src.includes(imp));
  ok(offenders.length === 0,
    `${name} 不直接引用分析邏輯${offenders.length ? `（發現：${offenders.join(", ")}）` : ""}`);
  ok(src.includes("runScan"),
    `${name} 呼叫共用的 runScan()`);
}

// ── 2. 行為檢查：相同輸入必須產生相同輸出 ───────────────────────────────────

console.log("");
console.log("【2】行為檢查 — 相同輸入是否產生相同輸出");

const TF = "1h";

/**
 * Compare the ENTIRE universe rather than one symbol.
 *
 * A single symbol may legitimately produce nothing, and "0 rows == 0 rows" is a
 * vacuous match. Scanning everything guarantees the comparison has real rows on
 * both sides — and it is the case that actually matters, since that is how both
 * modes run in production.
 */

/**
 * Pull the result rows out of a run's stdout.
 *
 * Only the rows that state a finding are compared — never the surrounding
 * headings, counts or formatting. Two modes agreeing on "there are 2 events"
 * proves nothing; agreeing on WHICH symbol, timeframe, side and state proves
 * the underlying interpretation matched.
 */
function normalise(output: string): string {
  return output
    .split("\n")
    .filter((l) => /^\s*[•⊘]/.test(l))
    .map((l) => l.replace(/\s+/g, " ").trim())
    .sort()
    .join("\n");
}

/**
 * Run a child process and KEEP ITS EXIT CODE.
 *
 * The previous version returned stdout+stderr only, so a child that crashed was
 * indistinguishable from one that ran cleanly — and two crashes would have
 * "agreed" with each other just as happily as two clean runs. Every child's
 * status is now carried out to the caller and checked; any non-zero fails the
 * gate. See the blueprint's "deterministic verification entry point".
 */
function run(cmd: string[], env: Record<string, string>): { out: string; code: number } {
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "production", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out: String(out), code: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

// A fixed symbol set keeps this fast, but it has to be WIDE ENOUGH to actually
// produce events: three hand-picked symbols go quiet on a calm market, and an
// empty comparison proves nothing either way. Ten majors is still quick and makes
// a content-free run far less likely — and when it does happen the gate now says
// so explicitly instead of passing, with a distinct exit code so a caller can
// tell "nothing to compare" from "the two modes disagree". Overridable with
// PARITY_SYMBOLS, which is what the INCOMPLETE message tells an operator to do.
const SAMPLE = process.env.PARITY_SYMBOLS
  ?? "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT";

/**
 * A private, empty SQLite ledger for one child run.
 *
 * Both entry points share ONE ledger, and that ledger is what produces the
 * "same area" suppression lines. Pointed at the live ledger the check happened to
 * pass, because the history was already there and both runs read the same rows.
 * Pointed at an empty one it FAILS — and the failure is not a difference in
 * interpretation: the first child seeds the history the second child then
 * reports, so the two outputs diverge on execution ORDER alone. Observed on a
 * clean checkout: PASSIVE 2 rows, ACTIVE 6 rows.
 *
 * A gate that flips on ledger state is not measuring what it claims to measure,
 * so each child gets its own empty ledger. That removes ledger state as a
 * variable and leaves only the question being asked: do the two entry points
 * interpret the same market data the same way?
 *
 * The live ledger is never touched — the path is overridden per child process,
 * never in this one.
 */
function isolatedLedgerPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "parity-ledger-")), "liquidity.db");
}
/**
 * The recorded input both children receive.
 *
 * The gate compares two ENTRY POINTS, so what it must hold fixed is the market
 * data. Fetching it live made the result depend on the network and on whether the
 * market happened to produce an event that minute — a quiet day matched two empty
 * results and proved nothing. The fixture removes both dependencies: identical
 * bytes in, and no exchange call at all. See scripts/capture-parity-fixture.ts.
 */
const FIXTURE = path.resolve(import.meta.dirname, "../../fixtures/parity_candles.json");
if (!existsSync(FIXTURE)) {
  console.log(`  ✗ INCOMPLETE — 找不到固定資料 ${FIXTURE}`);
  console.log("    先跑 npx tsx artifacts/api-server/src/scripts/capture-parity-fixture.ts 錄一份。");
  process.exit(2);
}
const fixtureSeries = Object.keys(JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>);
console.log(`  以固定資料（${fixtureSeries.length} 個序列，不連網）分別執行兩條路徑…`);

const passiveRun = run(
  ["npx", "tsx", "artifacts/api-server/src/scripts/live-snapshot.ts",
   "--symbols", SAMPLE, "--timeframe", TF, "--no-dedup"],
  { SQLITE_PATH: isolatedLedgerPath(), SMC_FIXTURE_CANDLES: FIXTURE },
);

const activeRun = run(
  ["npx", "tsx", "artifacts/api-server/src/scripts/monitor-loop.ts",
   "--once", "--dry-run", "--symbols", SAMPLE, "--timeframe", TF],
  { MONITORING_MODE: "active", SQLITE_PATH: isolatedLedgerPath(), SMC_FIXTURE_CANDLES: FIXTURE },
);

// A crashed child must never be able to "agree" with another crashed child.
ok(passiveRun.code === 0, `PASSIVE 子程序正常結束（exit ${passiveRun.code}）`);
ok(activeRun.code === 0, `ACTIVE 子程序正常結束（exit ${activeRun.code}）`);

const passiveRows = normalise(passiveRun.out);
const activeRows = normalise(activeRun.out);

console.log("");
console.log("  PASSIVE 結果：");
for (const r of passiveRows.split("\n").filter(Boolean)) console.log(`    ${r}`);
if (!passiveRows) console.log("    （無 BTCUSDT 相關列）");
console.log("  ACTIVE 結果：");
for (const r of activeRows.split("\n").filter(Boolean)) console.log(`    ${r}`);
if (!activeRows) console.log("    （無 BTCUSDT 相關列）");

console.log("");
const rowCount = passiveRows.split("\n").filter(Boolean).length;

/**
 * A comparison that never happened is neither a pass nor a difference in
 * interpretation, and it must not be reported as one. When the sample produces no
 * events there is nothing to compare, so this run is INCOMPLETE: it exits 2, a
 * code of its own, so a caller cannot mistake it for a green light.
 */
const incomplete = rowCount === 0;
if (incomplete) {
  console.log("");
  console.log("  ✗ INCOMPLETE — 樣本沒有產生任何事件，比對沒有發生。");
  console.log("    這不是通過，也不是判定不一致；請換一組樣本或等市況有事件再跑。");
}
ok(!incomplete, `比對樣本非空（${rowCount} 列）— 空結果的一致不具意義`);
ok(passiveRows === activeRows,
  `相同輸入的判定完全一致（${rowCount} 列）`);

// ── 3. ACTIVE 未經明確開啟時必須拒絕執行 ───────────────────────────────────

console.log("");
console.log("【3】安全檢查 — ACTIVE 不得被靜默啟動");

const refused = run(
  ["npx", "tsx", "artifacts/api-server/src/scripts/monitor-loop.ts", "--once"],
  { MONITORING_MODE: "passive" },
);
// Here a NON-zero exit is the expected outcome, so only the message is checked.
ok(refused.out.includes("must") || refused.out.includes("必須") || refused.out.includes("不是 \"active\"") || refused.out.includes("not \"active\""),
  "PASSIVE 模式下啟動 monitor-loop 會被拒絕");
ok(!refused.out.includes("ACTIVE 監控已啟動"),
  "被拒絕時不會開始監控");

console.log("");
console.log("═".repeat(64));
console.log(`  ${passed} 項通過，${failed} 項失敗${incomplete ? "（本次為 INCOMPLETE）" : ""}`);
console.log("═".repeat(64));
// 2 = 未完成（比對沒有發生）；1 = 真的判定不一致。兩者不可混用。
if (incomplete) process.exit(2);
if (failed > 0) process.exit(1);
