/**
 * Binance USDT-M Futures (fapi) market data client.
 *
 * READ-ONLY BY DESIGN. This module only ever calls public market-data
 * endpoints. There is intentionally no import of any account/trade/order
 * endpoint, no API key handling, and no signing logic — see REQUIREMENTS §26.
 *
 * Endpoint docs: https://developers.binance.com/docs/derivatives/usds-margined-futures
 */
import axios, { type AxiosInstance } from "axios";
import type { Candle } from "../smc/types.js";
import { logger } from "../logger.js";

// ── Endpoints ───────────────────────────────────────────────────────────────
// Overridable for testing / mirrors. Mirrors the upstream "try in order"
// pattern but defaults to the global USDT-M futures market (REQUIREMENTS §3).

const FAPI_BASES = (process.env.BINANCE_FAPI_BASE
  ? [process.env.BINANCE_FAPI_BASE]
  : ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com"]);

export const FSTREAM_BASE = process.env.BINANCE_FSTREAM_BASE || "wss://fstream.binance.com";

const REQUEST_TIMEOUT_MS = Number(process.env.FAPI_TIMEOUT_MS || 15_000);
const MAX_RETRIES = Number(process.env.FAPI_MAX_RETRIES || 3);
const RETRY_BASE_DELAY_MS = 400;

// ── HTTP client ─────────────────────────────────────────────────────────────

let activeBase: string | null = null;

function clientFor(base: string): AxiosInstance {
  return axios.create({ baseURL: base, timeout: REQUEST_TIMEOUT_MS });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a public fapi path, walking the base list on network failure.
 * Retries only on transport errors / 5xx / 429 — a 4xx client error
 * (e.g. unknown symbol) is a real answer and is surfaced immediately.
 */
async function fapiGet<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  const ordered = activeBase
    ? [activeBase, ...FAPI_BASES.filter((b) => b !== activeBase)]
    : FAPI_BASES;

  let lastErr: unknown = null;

  for (const base of ordered) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await clientFor(base).get<T>(path, { params });
        activeBase = base;
        return res.data;
      } catch (err: unknown) {
        lastErr = err;
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;

        // Real answer from the API — do not retry, do not try other mirrors.
        if (status && status >= 400 && status < 500 && status !== 429) throw err;

        const retryable = status === undefined || status === 429 || status >= 500;
        if (!retryable) throw err;

        if (attempt < MAX_RETRIES - 1) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
          logger.debug({ path, base, attempt, delay, status }, "fapi request failed — retrying");
          await sleep(delay);
        }
      }
    }
    logger.warn({ path, base }, "fapi base exhausted — trying next mirror");
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`fapi request failed for ${path}`);
}

// ── Timeframe mapping ───────────────────────────────────────────────────────

const TF_TO_FAPI: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w",
};

export function isSupportedTimeframe(tf: string): boolean {
  return Object.prototype.hasOwnProperty.call(TF_TO_FAPI, tf);
}

// ── Klines ──────────────────────────────────────────────────────────────────

/** Raw kline row as returned by fapi/v1/klines. */
type KlineRow = [number, string, string, string, string, string, number, string, number, string, string, string];

/**
 * Fetch closed klines and map them into the engine's Candle shape.
 *
 * The in-progress (still forming) candle is always excluded so the SMC engine
 * only ever sees confirmed bars — this matches the upstream contract where
 * `buildReport` treats the last candle as closed.
 */
export async function fetchKlines(
  symbol: string,
  timeframe: string,
  limit = 500,
): Promise<Candle[]> {
  const interval = TF_TO_FAPI[timeframe];
  if (!interval) throw new Error(`Unsupported timeframe: ${timeframe}`);

  const rows = await fapiGet<KlineRow[]>("/fapi/v1/klines", {
    symbol: symbol.toUpperCase(),
    interval,
    limit,
  });

  if (!Array.isArray(rows)) throw new Error(`Unexpected klines payload for ${symbol}`);

  const nowMs = Date.now();
  const candles: Candle[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;

    const openTimeMs = Number(row[0]);
    const closeTimeMs = Number(row[6]);
    // Drop the forming candle.
    if (Number.isFinite(closeTimeMs) && closeTimeMs > nowMs) continue;

    const candle: Candle = {
      time: Math.floor(openTimeMs / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    };

    if (
      !Number.isFinite(candle.open) || !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) || !Number.isFinite(candle.close)
    ) {
      logger.warn({ symbol, timeframe, row }, "Skipping malformed kline");
      continue;
    }

    candles.push(candle);
  }

  return candles;
}

/**
 * Daily candles used for the HTF bias input. Fetched from the same futures
 * market so the bias and the structure never diverge across venues.
 */
export async function fetchDailyCandles(symbol: string, limit = 120): Promise<Candle[]> {
  return fetchKlines(symbol, "1d", limit);
}

/**
 * Quote-asset (USDT) traded notional for each of the last `days` COMPLETED
 * daily candles, oldest → newest.
 *
 * Used by the 7-day median liquidity filter (REQUIREMENTS §6.2): the risk being
 * guarded against is a single-day pump or news spike, which only the daily
 * notionals can reveal — the 24h ticker alone cannot.
 *
 * The still-forming daily candle is dropped so a half-finished day never drags
 * the median down.
 */
export async function fetchDailyQuoteVolumes(symbol: string, days = 7): Promise<number[]> {
  const rows = await fapiGet<KlineRow[]>("/fapi/v1/klines", {
    symbol: symbol.toUpperCase(),
    interval: "1d",
    limit: days + 1,
  });
  if (!Array.isArray(rows)) throw new Error(`Unexpected klines payload for ${symbol}`);

  const nowMs = Date.now();
  const out: number[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) continue;
    const closeTimeMs = Number(row[6]);
    if (Number.isFinite(closeTimeMs) && closeTimeMs > nowMs) continue; // forming day
    const quoteVol = Number(row[7]);
    if (Number.isFinite(quoteVol)) out.push(quoteVol);
  }
  return out.slice(-days);
}

// ── Universe inputs ─────────────────────────────────────────────────────────

export interface FuturesSymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  contractType: string;
  onboardDate: number | null;   // ms since epoch — used for listing-age filter
  pricePrecision: number;
  quantityPrecision: number;
}

interface ExchangeInfoResponse {
  symbols: Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    status: string;
    contractType: string;
    onboardDate?: number;
    pricePrecision?: number;
    quantityPrecision?: number;
  }>;
}

/** All actively trading perpetual contracts (REQUIREMENTS §4/§5). */
export async function fetchExchangeInfo(options?: {
  quoteAsset?: string;
}): Promise<FuturesSymbolInfo[]> {
  const data = await fapiGet<ExchangeInfoResponse>("/fapi/v1/exchangeInfo");
  if (!data || !Array.isArray(data.symbols)) {
    throw new Error("Unexpected exchangeInfo payload");
  }

  const quote = options?.quoteAsset ?? "USDT";

  return data.symbols
    .filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING" && s.quoteAsset === quote)
    .map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      status: s.status,
      contractType: s.contractType,
      onboardDate: s.onboardDate ?? null,
      pricePrecision: s.pricePrecision ?? 8,
      quantityPrecision: s.quantityPrecision ?? 8,
    }));
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  quoteVolume: number;      // 24h volume in quote (USDT) terms
  volume: number;           // 24h volume in base terms
  priceChangePercent: number;
  count: number;            // number of trades
}

interface Ticker24hRaw {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
  volume: string;
  priceChangePercent: string;
  count: number;
}

/** Whole-market 24h tickers in ONE request (avoids per-symbol rate limits). */
export async function fetchAll24hTickers(): Promise<Ticker24h[]> {
  const rows = await fapiGet<Ticker24hRaw[]>("/fapi/v1/ticker/24hr");
  if (!Array.isArray(rows)) throw new Error("Unexpected 24hr ticker payload");

  return rows.map((r) => ({
    symbol: r.symbol,
    lastPrice: Number(r.lastPrice),
    quoteVolume: Number(r.quoteVolume),
    volume: Number(r.volume),
    priceChangePercent: Number(r.priceChangePercent),
    count: Number(r.count),
  }));
}

export interface OpenInterestSnapshot {
  symbol: string;
  openInterest: number;     // contracts
  time: number;             // ms — when the exchange sampled it
}

export async function fetchOpenInterest(symbol: string): Promise<OpenInterestSnapshot> {
  const data = await fapiGet<{ symbol: string; openInterest: string; time: number }>(
    "/fapi/v1/openInterest",
    { symbol: symbol.toUpperCase() },
  );
  return { symbol: data.symbol, openInterest: Number(data.openInterest), time: data.time };
}

export interface BookTicker {
  symbol: string;
  bidPrice: number;
  askPrice: number;
  midPrice: number;
  spreadBps: number;        // (ask - bid) / mid * 10000
}

/** Whole-market best bid/ask in ONE request — powers the spread filter. */
export async function fetchAllBookTickers(): Promise<BookTicker[]> {
  const rows = await fapiGet<Array<{ symbol: string; bidPrice: string; askPrice: string }>>(
    "/fapi/v1/ticker/bookTicker",
  );
  if (!Array.isArray(rows)) throw new Error("Unexpected bookTicker payload");

  const out: BookTicker[] = [];
  for (const r of rows) {
    const bid = Number(r.bidPrice);
    const ask = Number(r.askPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) continue;
    const mid = (bid + ask) / 2;
    out.push({
      symbol: r.symbol,
      bidPrice: bid,
      askPrice: ask,
      midPrice: mid,
      spreadBps: ((ask - bid) / mid) * 10_000,
    });
  }
  return out;
}

export interface FundingSnapshot {
  symbol: string;
  markPrice: number;
  lastFundingRate: number;   // as a fraction, e.g. 0.0001 = 0.01%
  nextFundingTime: number;
}

/** Whole-market mark price + funding rate in ONE request. */
export async function fetchAllFunding(): Promise<FundingSnapshot[]> {
  const rows = await fapiGet<Array<{
    symbol: string; markPrice: string; lastFundingRate: string; nextFundingTime: number;
  }>>("/fapi/v1/premiumIndex");

  if (!Array.isArray(rows)) throw new Error("Unexpected premiumIndex payload");

  return rows.map((r) => ({
    symbol: r.symbol,
    markPrice: Number(r.markPrice),
    lastFundingRate: Number(r.lastFundingRate),
    nextFundingTime: Number(r.nextFundingTime),
  }));
}

// ── Introspection (used by the health monitor, REQUIREMENTS §23) ────────────

export function getActiveBase(): string | null {
  return activeBase;
}
