import axios from "axios";
import type { Candle } from "../smc/types.js";
import { SMC_CONFIG } from "../smc/config.js";
import { admitCandles } from "../smc/candles.js";

const TF_MAP: Record<string, { interval: string; range: string; aggregate?: number }> = {
  "1m":  { interval: "1m",  range: "5d" },
  "5m":  { interval: "5m",  range: "30d" },
  "15m": { interval: "15m", range: "45d" },
  "1h":  { interval: "1h",  range: "60d" },
  "4h":  { interval: "1h",  range: "120d", aggregate: 4 },
  "1d":  { interval: "1d",  range: "1y" },
  "1w":  { interval: "1wk", range: "5y" },
};

function aggregateCandles(candles: Candle[], n: number): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i + n - 1 < candles.length; i += n) {
    const group = candles.slice(i, i + n);
    result.push({
      time:   group[0].time,
      open:   group[0].open,
      high:   Math.max(...group.map(c => c.high)),
      low:    Math.min(...group.map(c => c.low)),
      close:  group[group.length - 1].close,
      volume: group.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

async function fetchYahooRaw(symbol: string, interval: string, range: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const response = await axios.get(url, {
    params: { interval, range, includePrePost: false },
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; LiquidityHunter/1.0)",
    },
    timeout: 15000,
  });

  const chart = response.data?.chart?.result?.[0];
  if (!chart) throw new Error(`No chart data for ${symbol}`);

  const timestamps: number[] = chart.timestamp ?? [];
  const quote = chart.indicators?.quote?.[0] ?? {};
  const opens: number[]   = quote.open   ?? [];
  const highs: number[]   = quote.high   ?? [];
  const lows: number[]    = quote.low    ?? [];
  const closes: number[]  = quote.close  ?? [];
  const volumes: number[] = quote.volume ?? [];

  return timestamps
    .map((t, i) => ({
      time:   t,
      open:   opens[i]   ?? 0,
      high:   highs[i]   ?? 0,
      low:    lows[i]    ?? 0,
      close:  closes[i]  ?? 0,
      volume: volumes[i] ?? 0,
    }))
    .filter(c => c.close > 0 && c.high > 0 && c.low > 0);
}

export async function fetchYahooCandles(symbol: string, timeframe: string): Promise<Candle[]> {
  const cfg = TF_MAP[timeframe] ?? TF_MAP["4h"];
  const raw = await fetchYahooRaw(symbol, cfg.interval, cfg.range);

  const candles = cfg.aggregate ? aggregateCandles(raw, cfg.aggregate) : raw;
  const sliced = candles.slice(-SMC_CONFIG.maxCandles);

  // Yahoo hands back the in-progress bar as the last element and sends only an
  // OPEN timestamp, so it cannot PROVE which of its rows have finished. That is
  // the "unprovable" case in candles.ts: the gate drops the last row instead of
  // guessing from the timeframe length. Guessing used to hold Friday's closed
  // weekly bar back until Monday.
  return admitCandles(sliced, {
    closure: "unprovable",
    nowSeconds: Math.floor(Date.now() / 1000),
    minCandles: 1,
  }).candles;
}

export async function fetchYahooDailyCandles(symbol: string): Promise<Candle[]> {
  const raw = await fetchYahooRaw(symbol, "1d", "6mo");
  // Same "unprovable" closure as the intraday path above: Yahoo does not send a
  // close time, so the last daily row is dropped rather than computed away.
  return admitCandles(raw.slice(-SMC_CONFIG.maxDailyCandles), {
    closure: "unprovable",
    nowSeconds: Math.floor(Date.now() / 1000),
    minCandles: 1,
  }).candles;
}
