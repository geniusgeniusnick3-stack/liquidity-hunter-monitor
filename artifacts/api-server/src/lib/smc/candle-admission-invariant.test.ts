/**
 * Structural invariant: nothing hand-builds a candle outside the gate.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT
 * ------------------------------------
 * The admission gate only protects the paths that actually call it. Four review
 * rounds found the SAME defect class at a different location each time:
 * `buildReport`, then the scan's injectable source, then `CandleStore`'s write
 * path, then its second write path (`seedCandles`), then the forex producer.
 * Every individual fix was correct and every next door was found by a reviewer
 * rather than by us. Patching instances does not converge, so the class is
 * enforced mechanically here.
 *
 * THE RULE
 * --------
 *   Any file that builds a Candle-SHAPED literal must either
 *     (a) call `admitCandles()` — the shared gate, or
 *     (b) appear in EXEMPT below with a written reason.
 *
 * The detector is deliberately LOOSE (it flags anything with open/close/high/low
 * in one literal) because a narrow detector was tried first and MISSED two real
 * producers — `open: openVal` in the forex REST reader and `open:
 * parseFloat(k.o)` in the Binance WS reader. A check that looks green because it
 * never noticed the code is worse than no check. Over-flagging is therefore the
 * intended failure mode: it costs one auditable reason in EXEMPT, while a miss
 * costs a silent hole.
 *
 *   Plus: `CandleStore` must write its closed series in exactly ONE place. An
 *   invariant with two writers is only as strong as the weaker one, which is how
 *   the second write path went unnoticed.
 *
 * It reads source text rather than importing modules: the point is to catch code
 * that has not run yet.
 *
 * Run: npx tsx artifacts/api-server/src/lib/smc/candle-admission-invariant.test.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
const section = (t: string) => { console.log(""); console.log(`── ${t}`); };
const ok = (cond: boolean, what: string) => {
  if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}`); }
};

const SRC = path.resolve(import.meta.dirname, "../..");

/**
 * Files allowed to build a Candle-shaped literal WITHOUT calling the gate.
 *
 * Each entry needs a reason that says why no un-admitted candle can escape it.
 * Adding a new producer is a deliberate act: either gate it or justify it here.
 */
const EXEMPT: Record<string, string> = {
  "lib/smc/types.ts":
    "型別宣告本身，沒有製造任何 K 棒（偵測器看到介面欄位而誤判）。",
  "lib/mcp/tool-registry.ts":
    "只是把已通過關卡的 K 棒欄位複製成輸出物件，沒有引入新的外部數值。",
  "lib/mcp/tools/live-candles.ts":
    "顯示用途。它同時輸出 getSnapshot().currentCandle（尚未收盤那一根），" +
    "而那一根確實【沒有】經過准入——這是刻意的：准入只處理已收盤的棒子。" +
    "關鍵在於它不會被任何分析器讀取：現行程式中只有本檔（顯示）與 " +
    "forex-ws.ts（更新形成中的棒子本身）讀 currentCandle，沒有任何 SMC 分析呼叫吃它。",
  "scripts/verify-engine-manual.ts":
    "只是把 fetchKlines() 已通過關卡的 K 棒複製成比對用的 Bar 物件（第 92 行），" +
    "再交給 analyzeLiquidity()。數值並非從外部字串解析，來源端已過關卡。",
  "scripts/verify-vs-external.ts":
    "對外比對用的診斷腳本。它在這裡組的是【外部參考序列】(Bybit REST)，" +
    "用途是與本引擎的輸出比對；這批資料不會被 SMC 引擎消費，也沒有回傳給任何分析路徑。",
  "lib/realtime/binance-ws.ts":
    "組出的是 CandleUpdate（不是 Candle），且唯一去向是 candleStore.applyUpdate()，" +
    "而該函式會匯入 store 的唯一寫入函式 commit()，在那裡過關卡。沒有第二條路徑。",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Does this file build a Candle-shaped literal? Loose on purpose — see the header. */
function constructsCandle(src: string): boolean {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/\bopen:\s*\S/.test(lines[i])) continue;
    const window = lines.slice(Math.max(0, i - 3), i + 8).join("\n");
    const has = (k: string) => new RegExp(`\\b${k}:`).test(window);
    if (has("close") && (has("high") || has("low"))) return true;
  }
  return false;
}

// `scripts/` is included deliberately. The first version scanned only lib/ and
// routes/, and the review found a producer living outside that boundary — a scan
// whose scope is hand-picked will keep missing whatever sits just outside it.
const files = [
  ...walk(path.join(SRC, "lib")),
  ...walk(path.join(SRC, "routes")),
  ...walk(path.join(SRC, "scripts")),
];
const rel = (f: string) => f.slice(SRC.length + 1);

/**
 * Does this file actually USE the gate, or merely mention it?
 *
 * A bare `src.includes("admitCandles")` is satisfied by a comment, by an unused
 * import, or by an unrelated call elsewhere in the same file — the review called
 * this out and it was right: that proves a string, not a data flow. Requiring a
 * real import specifier AND a call expression at least ties the check to code
 * that would have to be deleted for the check to break.
 *
 * This is still textual, and textual checks have a ceiling — see the note at the
 * top about what would make it compiler-enforced instead.
 */
function usesGate(src: string): boolean {
  const imported = /import\s*\{[^}]*\badmitCandles\b[^}]*\}\s*from\s*"[^"]*candles\.js"/.test(src)
    || /import\s*\{[^}]*\badmitCandles\b[^}]*\}\s*from\s*"[^"]*smc\/candles[^"]*"/.test(src);
  const called = /\badmitCandles\s*\(/.test(src.replace(/^\s*\/\/.*$/gm, ""));
  return imported && called;
}

const flagged = files.filter((f) => constructsCandle(readFileSync(f, "utf8")));
const gated = flagged.filter((f) => usesGate(readFileSync(f, "utf8")));
const ungated = flagged.filter((f) => !usesGate(readFileSync(f, "utf8")));

// ───────────────────────────────────────────────────────────────────────────
section("R1 每個「製造 K 棒」的模組：過關卡，或具名豁免");
{
  ok(flagged.length > 0, `偵測器掃到 ${flagged.length} 個（非空才具意義）`);
  console.log(`       已過關卡：${gated.map(rel).join(", ") || "（無）"}`);
  console.log(`       未過關卡：${ungated.map(rel).join(", ") || "（無）"}`);

  const unaccounted = ungated.filter((f) => !(rel(f) in EXEMPT));
  ok(
    unaccounted.length === 0,
    unaccounted.length === 0
      ? "未過關卡的檔案全部有具名豁免理由"
      : `未過關卡且未豁免（新增製造端請過關卡或在此寫明理由）：${unaccounted.map(rel).join(", ")}`,
  );

  // 豁免理由不得是空的或樣板
  const thin = Object.entries(EXEMPT).filter(([, reason]) => reason.trim().length < 20);
  ok(thin.length === 0, thin.length === 0 ? "每個豁免理由都寫得出所以然" : `理由過短：${thin.map(([k]) => k).join(", ")}`);
}

// ───────────────────────────────────────────────────────────────────────────
section("R2 豁免清單不得腐化（沒有過期條目）");
{
  const stale = Object.keys(EXEMPT).filter((r) => {
    const full = path.join(SRC, r);
    // 檔案沒了，或已經不再製造 K 棒 → 這條豁免是死的，會讓下一個人以為這裡還沒被處理
    return !existsSync(full) || !constructsCandle(readFileSync(full, "utf8"));
  });
  ok(stale.length === 0, stale.length === 0 ? "沒有過期豁免" : `過期豁免（請刪除）：${stale.join(", ")}`);

  // 已過關卡的檔案不該同時被豁免 —— 兩份真相會漂移
  const both = gated.filter((f) => rel(f) in EXEMPT);
  ok(both.length === 0, both.length === 0 ? "沒有檔案同時『已過關卡』又『被豁免』" : `重複標記：${both.map(rel).join(", ")}`);
}

// ───────────────────────────────────────────────────────────────────────────
section("R3 CandleStore 的已收盤清單只有一個寫入點");
{
  const src = readFileSync(path.join(SRC, "lib/realtime/candle-store.ts"), "utf8");
  const writes = src.match(/this\.closed\.set\(/g) ?? [];
  ok(writes.length === 1, `this.closed.set( 出現 ${writes.length} 次（必須恰好 1 次）`);

  // "the write goes through the gate" has to be checked at the WRITE, not at the
  // file: a file-level keyword match would still pass if the gate lived in an
  // unrelated method. Slice out the enclosing class member and require both the
  // gate call and the refusal path inside it.
  const at = src.indexOf("this.closed.set(");
  const head = src.slice(0, at);
  const memberStart = Math.max(
    head.lastIndexOf("\n  private "), head.lastIndexOf("\n  public "), head.lastIndexOf("\n  protected "),
  );
  const member = src.slice(memberStart === 0 ? 0 : memberStart, src.indexOf("\n  }", at) + 4);
  ok(/\badmitCandles\s*\(/.test(member), "該寫入點所在的成員函式內呼叫了 admitCandles()");
  ok(/return false/.test(member), "該成員函式在「全部被拒」時會拒絕寫入（return false）");
  ok(usesGate(src), "該檔真的 import 並呼叫接納函式（非僅字串提及）");
}

// ───────────────────────────────────────────────────────────────────────────
section("R4 關卡本身仍拒絕它該拒絕的（否則 R1–R3 可以靠一個空函式通過）");
{
  const src = readFileSync(path.join(SRC, "lib/smc/candles.ts"), "utf8");
  for (const reason of ["not-finite", "non-positive", "ohlc-inconsistent", "time-not-increasing", "time-in-future"]) {
    ok(src.includes(reason), `關卡仍宣告拒絕原因 ${reason}`);
  }
  ok(src.includes('"unprovable"'), "仍保留「無法證明收盤」的來源處理");
}

console.log("");
console.log("─".repeat(72));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
