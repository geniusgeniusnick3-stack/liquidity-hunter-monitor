/**
 * Cross-venue candle verification.
 *
 * Fetches the same symbol/timeframe from Binance USDT-M (what this project uses)
 * and from Bybit USDT perpetual (an independent venue), then compares OHLC
 * candle-by-candle.
 *
 * Why this approach: TradingView's chart is canvas-rendered and loads its data
 * dynamically, so it cannot be scraped for a line-by-line comparison. Comparing
 * against a second exchange's public API is a stronger check anyway — it
 * verifies the numbers rather than a picture, and anyone can reproduce it.
 *
 * What "correct" looks like: these are two independent markets, so a small basis
 * is expected and healthy. The test therefore reports the DISTRIBUTION of
 * differences. A large divergence would indicate a real data problem; a few
 * ticks of basis does not.
 *
 * Usage:
 *   npx tsx artifacts/api-server/src/scripts/verify-vs-external.ts BTCUSDT 1h
 */

const BYBIT_REST = "https://api.bybit.com/v5/market/kline";

interface Bar {
  time: number; // seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Bybit interval codes differ from Binance's. */
function bybitInterval(tf: string): string {
  const map: Record<string, string> = {
    "1m": "1", "5m": "5", "15m": "15", "30m": "30",
    "1h": "60", "4h": "240", "1d": "D", "1w": "W",
  };
  return map[tf] ?? "60";
}

function tfSeconds(tf: string): number {
  const map: Record<string, number> = {
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800,
  };
  return map[tf] ?? 3600;
}

async function fetchBybit(symbol: string, tf: string, limit: number): Promise<Bar[]> {
  const url = `${BYBIT_REST}?category=linear&symbol=${symbol}&interval=${bybitInterval(tf)}&limit=${Math.min(limit, 1000)}`;
  const res = await fetch(url);
  const json = (await res.json().catch(() => null)) as
    | { result?: { list?: string[][] }; retMsg?: string }
    | null;
  const rows: string[][] = json?.result?.list ?? [];
  if (!rows.length) {
    throw new Error(`Bybit 無資料：${symbol} ${tf} — ${json?.retMsg ?? "unknown"}`);
  }

  const nowSec = Date.now() / 1000;
  const bars = rows
    .map((r) => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }))
    // Drop the still-forming bar on both sides so the comparison is like-for-like.
    .filter((b) => b.time + tfSeconds(tf) <= nowSec);

  return bars.reverse(); // Bybit returns newest-first
}

function taipei(sec: number): string {
  return new Date(sec * 1000).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei", hour12: false,
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

(async () => {
  const symbol = (process.argv[2] ?? "BTCUSDT").toUpperCase();
  const tf = (process.argv[3] ?? "1h").toLowerCase();

  const { fetchKlines } = await import("../lib/market/futures.js");
  const ours: Bar[] = (await fetchKlines(symbol, tf, 200)).map((c) => ({
    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  }));
  const theirs = await fetchBybit(symbol, tf, 200);
  const mine = new Map(ours.map((b) => [b.time, b]));

  console.log(`=== ${symbol} ${tf.toUpperCase()} 跨交易所逐根比對 ===`);
  console.log(`  本專案（Binance 全球永續）：${ours.length} 根`);
  console.log(`  獨立來源（Bybit 永續）：    ${theirs.length} 根\n`);

  let compared = 0;
  let identical = 0;
  const worstDiffs: number[] = [];
  const largeGaps: string[] = [];

  for (const t of theirs) {
    const o = mine.get(t.time);
    if (!o) continue;
    compared++;

    let worst = 0;
    const parts: string[] = [];
    for (const k of ["open", "high", "low", "close"] as const) {
      const rel = Math.abs(o[k] - t[k]) / t[k];
      if (rel > worst) worst = rel;
      if (rel > 2e-3) parts.push(`${k.toUpperCase()}: ${o[k]} vs ${t[k]}`);
    }
    worstDiffs.push(worst);

    if (worst === 0) identical++;
    if (parts.length) largeGaps.push(`  ${taipei(t.time)}  ${parts.join("  ")}`);
  }

  worstDiffs.sort((a, b) => a - b);
  const q = (p: number) => worstDiffs[Math.min(worstDiffs.length - 1, Math.floor(worstDiffs.length * p))] * 100;

  console.log(`時間戳對得上的 K 線：       ${compared} 根`);
  console.log(`完全相同（零差異）：         ${identical} 根`);
  console.log(`差異 > 0.2%（跨市價差）：    ${largeGaps.length} 根`);
  console.log("");
  console.log(`跨交易所價差分布（每根取 OHLC 最大相對差）：`);
  console.log(`  中位數 ${q(0.5).toFixed(3)}%    90% 分位 ${q(0.9).toFixed(3)}%    最大 ${q(1).toFixed(3)}%`);

  if (largeGaps.length === 0) {
    console.log(`\n✅ 全部落在正常價差內 — 資料源可信`);
  } else {
    console.log(`\n差異最大的幾根（供檢視）：`);
    for (const g of largeGaps.slice(-5)) console.log(g);
  }

  console.log(`\n=== 最近 3 根並排（肉眼核對用）===`);
  for (const t of theirs.slice(-3)) {
    const o = mine.get(t.time);
    console.log(`  ${taipei(t.time)}`);
    console.log(`    Binance: O ${o?.open ?? "-"}  H ${o?.high ?? "-"}  L ${o?.low ?? "-"}  C ${o?.close ?? "-"}`);
    console.log(`    Bybit  : O ${t.open}  H ${t.high}  L ${t.low}  C ${t.close}`);
  }
})();
