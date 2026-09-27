/**
 * Candle store — admission at the single write point.
 *
 * WHAT THIS DEFENDS
 * -----------------
 * The store's closed series is fed straight to analyzeStructure() /
 * analyzeLiquidity() by the MCP tools, WITHOUT passing through runScan() or
 * buildReport(). So if a malformed row could be archived here, it reached an
 * analyser unchecked and the admission gate elsewhere was decorative for that
 * path. These assertions go red if the write path stops gating.
 *
 * Run: npx tsx artifacts/api-server/src/lib/realtime/candle-store.test.ts
 */
import { CandleStore, type CandleUpdate } from "./candle-store.js";

let passed = 0;
let failed = 0;
const section = (t: string) => { console.log(""); console.log(`── ${t}`); };
const eq = (a: unknown, b: unknown, what: string) => {
  if (Object.is(a, b)) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}\n         expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
};
const ok = (cond: boolean, what: string) => {
  if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}`); }
};

const T0 = 1_700_000_000;
const update = (over: Partial<CandleUpdate> = {}): CandleUpdate => ({
  symbol: "BTCUSDT", timeframe: "1h", time: T0,
  open: 100, high: 101, low: 99, close: 100.5, volume: 1,
  isClosed: true, ...over,
});

// ───────────────────────────────────────────────────────────────────────────
section("S1 合格的一根要收下");
{
  const store = new CandleStore();
  store.applyUpdate(update());
  eq(store.getCandles("BTCUSDT", "1h").length, 1, "寫入成功");
}

// ───────────────────────────────────────────────────────────────────────────
section("S2 壞掉的一根必須被拒，且不得進到已收盤清單");
{
  const cases: Array<[string, Partial<CandleUpdate>]> = [
    ["零價（會當除數）", { open: 0 }],
    ["負價", { low: -5 }],
    ["NaN", { close: Number.NaN }],
    ["Infinity", { high: Number.POSITIVE_INFINITY }],
    ["OHLC 不一致（high < low）", { high: 98, low: 99 }],
  ];

  for (const [label, over] of cases) {
    const store = new CandleStore();
    store.applyUpdate(update(over));
    eq(store.getCandles("BTCUSDT", "1h").length, 0, `拒收：${label}`);

    // 也不能殘留成「還沒收盤」的那一根 —— 那會讓 getCandlesWithForming() 把它交出去。
    eq(store.getCandlesWithForming("BTCUSDT", "1h").length, 0, `不得殘留：${label}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
section("S3 被拒的那一根不得觸發 candleClosed（否則監聽者拿到我們剛拒的資料）");
{
  const store = new CandleStore();
  let fired = 0;
  store.on("candleClosed", () => { fired++; });

  store.applyUpdate(update());
  store.applyUpdate(update({ time: T0 + 3600, open: 0 }));
  eq(fired, 1, "只有合格那一根觸發了事件");
}

// ───────────────────────────────────────────────────────────────────────────
section("S4 壞資料不得影響已存在的好資料");
{
  const store = new CandleStore();
  store.applyUpdate(update());
  store.applyUpdate(update({ time: T0 + 3600, close: Number.NaN }));
  store.applyUpdate(update({ time: T0 + 7200 }));

  const kept = store.getCandles("BTCUSDT", "1h");
  eq(kept.length, 2, "好的兩根留下，壞的那根沒進來");
  eq(kept[0].time, T0, "第一根時間不變");
  eq(kept[1].time, T0 + 7200, "第二根是後寫入的那根好資料");
}

// ───────────────────────────────────────────────────────────────────────────
section("S5 回補路徑（seedCandles）走同一道關卡");
{
  // This door is why guarding only applyUpdate() was not enough: it is a second
  // way into `closed`, and the invariant is only as strong as the weaker door.
  const store = new CandleStore();

  store.seedCandles("BTCUSDT", "1h", [
    { time: T0, open: 100, high: 101, low: 99, close: 100.5, volume: 1 },
    { time: T0 + 3600, open: 0, high: 101, low: 99, close: 100.5, volume: 1 },        // 零價
    { time: T0 + 7200, open: 100, high: 101, low: 99, close: Number.NaN, volume: 1 },// NaN
    { time: T0 + 10800, open: 100, high: 98, low: 99, close: 100.5, volume: 1 },     // OHLC 不一致
    { time: T0 + 14400, open: 100, high: 101, low: 99, close: 100.5, volume: 1 },    // 好的
  ]);

  const got = store.getCandles("BTCUSDT", "1h");
  eq(got.length, 2, "回補：只有合格的兩根進來");
  eq(got.map((c) => c.time).join(","), `${T0},${T0 + 14400}`, "回補：進來的正是那兩根好的");
  ok(got.every((c) => Number.isFinite(c.close) && c.low > 0), "回補：進來的每根都有限且為正");
}

// ───────────────────────────────────────────────────────────────────────────
section("S6 回補不得覆寫即時串流已定案的棒子");
{
  const store = new CandleStore();
  store.applyUpdate(update({ close: 100.5 }));
  // 同一時間、不同內容（例如回補來源算出的舊值）
  store.seedCandles("BTCUSDT", "1h", [
    { time: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 },
  ]);
  const got = store.getCandles("BTCUSDT", "1h");
  eq(got.length, 1, "同時間不重複");
  eq(got[0].close, 100.5, "即時串流定案的那根沒有被回補覆寫");
}

// ───────────────────────────────────────────────────────────────────────────
section("S7 即時路徑：同一根重複定案以最新為準");
{
  const store = new CandleStore();
  store.applyUpdate(update({ close: 100.5 }));
  // 必須是「合法」的替換值，否則會被關卡擋掉而測不到 replace 語意
  // （第一版寫 close: 111.5 但 high: 101，等於開高低收不一致 → 被正確拒收）。
  store.applyUpdate(update({ close: 100.9 }));
  const got = store.getCandles("BTCUSDT", "1h");
  eq(got.length, 1, "同一根不重複累積");
  eq(got[0].close, 100.9, "以最新那次為準（replaceExisting）");
}

console.log("");
console.log("─".repeat(72));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
