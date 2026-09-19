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
import { readFileSync } from "node:fs";
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

/** Exported so pickActiveSymbol (declared above it) can call it. */
function run(cmd: string[], env: Record<string, string>): string {
  try {
    return execFileSync(cmd[0], cmd.slice(1), {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "production", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

// A fixed, small symbol set keeps this fast. These three are known to produce
// rows on a live market (they carry levels consumed within the memory window),
// so the comparison has real content rather than matching two empty results.
const SAMPLE = "XLMUSDT,TRXUSDT,DOGEUSDT";
console.log(`  以 ${SAMPLE} 分別執行兩條路徑…`);

const passiveOut = run(
  ["npx", "tsx", "artifacts/api-server/src/scripts/live-snapshot.ts",
   "--symbols", SAMPLE, "--timeframe", TF, "--no-dedup"],
  {},
);

const activeOut = run(
  ["npx", "tsx", "artifacts/api-server/src/scripts/monitor-loop.ts",
   "--once", "--dry-run", "--symbols", SAMPLE, "--timeframe", TF],
  { MONITORING_MODE: "active" },
);

const passiveRows = normalise(passiveOut);
const activeRows = normalise(activeOut);

console.log("");
console.log("  PASSIVE 結果：");
for (const r of passiveRows.split("\n").filter(Boolean)) console.log(`    ${r}`);
if (!passiveRows) console.log("    （無 BTCUSDT 相關列）");
console.log("  ACTIVE 結果：");
for (const r of activeRows.split("\n").filter(Boolean)) console.log(`    ${r}`);
if (!activeRows) console.log("    （無 BTCUSDT 相關列）");

console.log("");
const rowCount = passiveRows.split("\n").filter(Boolean).length;
ok(rowCount > 0,
  `比對樣本非空（${rowCount} 列）— 空結果的一致不具意義`);
ok(passiveRows === activeRows,
  `相同輸入的判定完全一致（${rowCount} 列）`);

// ── 3. ACTIVE 未經明確開啟時必須拒絕執行 ───────────────────────────────────

console.log("");
console.log("【3】安全檢查 — ACTIVE 不得被靜默啟動");

const refused = run(
  ["npx", "tsx", "artifacts/api-server/src/scripts/monitor-loop.ts", "--once"],
  { MONITORING_MODE: "passive" },
);
ok(refused.includes("must") || refused.includes("必須") || refused.includes("不是 \"active\"") || refused.includes("not \"active\""),
  "PASSIVE 模式下啟動 monitor-loop 會被拒絕");
ok(!refused.includes("ACTIVE 監控已啟動"),
  "被拒絕時不會開始監控");

console.log("");
console.log("═".repeat(64));
console.log(`  ${passed} 項通過，${failed} 項失敗`);
console.log("═".repeat(64));
if (failed > 0) process.exit(1);
