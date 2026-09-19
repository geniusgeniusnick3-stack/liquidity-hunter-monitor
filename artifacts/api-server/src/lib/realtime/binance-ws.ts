import WebSocket from "ws";
import { logger } from "../logger.js";
import { candleStore, type CandleUpdate } from "./candle-store.js";
import { fetchKlines } from "../market/futures.js";
import type { Candle } from "../smc/types.js";

// ── Types ────────────────────────────────────────────────────────────────────────

interface BinanceKlineEvent {
  e: "kline";
  E: number;
  s: string;  // symbol, uppercase
  k: {
    t: number;   // kline start time (ms)
    T: number;   // kline close time (ms)
    s: string;   // symbol
    i: string;   // interval
    o: string;   // open
    c: string;   // close
    h: string;   // high
    l: string;   // low
    v: string;   // base asset volume
    n: number;   // number of trades
    x: boolean;  // is the kline closed (final)?
  };
}

/** Combined-stream envelope: every message arrives wrapped as {stream, data}. */
interface CombinedStreamMessage {
  stream: string;
  data: BinanceKlineEvent;
}

// Binance USDT-M futures streams — the GLOBAL market (REQUIREMENTS §3).
// Mirrors are listed in order; every one serves the same market, so switching
// a mirror changes only the route, never the data. Binance US endpoints were
// removed deliberately: fapi/fstream only.
const WS_STREAM_HOSTS = [
  "wss://fstream.binance.com",
  "wss://fstream1.binance.com",
];

const TF_TO_BINANCE: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m",
  "1h": "1h", "4h": "4h",
  "1d": "1d", "1w": "1w",
};

// ── Historical backfill ──────────────────────────────────────────────────────────

/**
 * Fetch historical closed klines for seeding the candle store.
 *
 * Delegates to the shared futures client so the WebSocket path and the REST
 * analysis path read the exact same market, with the same timeout/retry/mirror
 * policy. Returns [] on failure so subscriptions still proceed on live data.
 */
async function fetchHistoricalKlines(
  symbol: string,
  timeframe: string,
  limit = 300,
): Promise<Candle[]> {
  if (!TF_TO_BINANCE[timeframe]) return [];

  try {
    const candles = await fetchKlines(symbol, timeframe, limit);
    logger.info({ symbol, timeframe, count: candles.length }, "Historical futures klines fetched");
    return candles;
  } catch (err) {
    logger.warn(
      { symbol, timeframe, err: err instanceof Error ? err.message : String(err) },
      "Historical futures kline fetch failed — continuing with WS data only",
    );
    return [];
  }
}

// ── Manager ──────────────────────────────────────────────────────────────────────

class BinanceWsManager {
  private ws: WebSocket | null = null;
  /** All active symbols and their timeframes. Key = uppercase symbol. */
  private activeSymbols: Map<string, Set<string>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30_000;
  private isShutdown = false;
  private endpointIndex = 0;
  /** Last kline timestamp seen per symbol|tf — used by the health monitor (§23). */
  private lastMessageAt = 0;

  /**
   * Subscribe to real-time kline data for a symbol + timeframes.
   * Multiple symbols share a single WebSocket connection via combined streams.
   * Triggers historical backfill on first subscription for a symbol.
   */
  subscribe(symbol: string, timeframes: string[]): void {
    if (this.isShutdown) return;

    const sym = symbol.toUpperCase();
    const existing = this.activeSymbols.get(sym);
    const isNew = !existing || existing.size === 0;

    // Merge timeframes
    if (!existing) {
      this.activeSymbols.set(sym, new Set(timeframes));
    } else {
      for (const tf of timeframes) existing.add(tf);
    }

    // Reconnect with the expanded stream list
    this.reconnectDelay = 100; // short delay when adding symbols
    this.connect();

    // Backfill historical data for new symbols
    if (isNew) {
      for (const tf of timeframes) {
        fetchHistoricalKlines(sym, tf)
          .then((candles) => {
            if (candles.length > 0) candleStore.seedCandles(sym, tf, candles);
          })
          .catch((err) => {
            logger.warn({ err, symbol: sym, tf }, "Backfill failed, continuing with WS data only");
          });
      }
    }
  }

  /**
   * Unsubscribe a symbol (e.g., when last SSE client for that symbol disconnects).
   */
  unsubscribe(symbol: string): void {
    const sym = symbol.toUpperCase();
    this.activeSymbols.delete(sym);

    if (this.activeSymbols.size === 0) {
      this.disconnect();
    } else {
      // Reconnect without this symbol's streams
      this.connect();
    }
  }

  private connect(): void {
    if (this.isShutdown) return;

    // Build combined stream URL for all active symbols
    const streams: string[] = [];
    for (const [symbol, tfs] of this.activeSymbols) {
      for (const tf of tfs) {
        if (TF_TO_BINANCE[tf]) {
          streams.push(`${symbol.toLowerCase()}@kline_${TF_TO_BINANCE[tf]}`);
        }
      }
    }

    if (streams.length === 0) {
      logger.info("No active streams, skipping WS connect");
      return;
    }

    const base = WS_STREAM_HOSTS[this.endpointIndex % WS_STREAM_HOSTS.length];
    // Futures combined streams use the /stream?streams= form.
    const url = `${base}/stream?streams=${streams.join("/")}`;
    const symbols = [...this.activeSymbols.keys()];

    logger.info({ url, symbols, streamCount: streams.length }, "Binance futures WS connecting");

    // Close existing connection
    this.disconnect();

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info({ symbols, endpoint: base }, "Binance futures WS connected");
      this.reconnectDelay = 1000;
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const parsed = JSON.parse(data.toString()) as BinanceKlineEvent | CombinedStreamMessage;
        // Combined streams wrap the payload; accept both shapes so a
        // single-stream endpoint or a mirror quirk never silently drops data.
        const raw = "data" in parsed ? parsed.data : parsed;
        if (!raw || raw.e !== "kline") return;

        const k = raw.k;
        const tf = this.binanceTfToApp(k.i);
        if (!tf) return;

        const update: CandleUpdate = {
          symbol: k.s.toUpperCase(),
          timeframe: tf,
          time: Math.floor(k.t / 1000),
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
          isClosed: k.x,
        };

        this.lastMessageAt = Date.now();
        candleStore.applyUpdate(update);
      } catch {
        // skip malformed messages
      }
    });

    this.ws.on("close", (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, "Binance futures WS closed");
      this.ws = null;
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, endpoint: base }, "Binance futures WS error");

      if (msg.includes("451") && this.endpointIndex + 1 < WS_STREAM_HOSTS.length) {
        this.endpointIndex++;
        logger.info({ nextEndpoint: WS_STREAM_HOSTS[this.endpointIndex] }, "Switching Binance stream host due to 451");
        this.reconnectDelay = 100;
        this.scheduleReconnect();
        return;
      }

      this.ws?.close();
    });

    this.ws.on("unexpected-response", (_req, res) => {
      logger.error({ status: res.statusCode }, "Binance futures WS unexpected response");
      if (res.statusCode === 451 && this.endpointIndex + 1 < WS_STREAM_HOSTS.length) {
        this.endpointIndex++;
        logger.info({ nextEndpoint: WS_STREAM_HOSTS[this.endpointIndex] }, "Switching Binance stream host due to 451");
        this.reconnectDelay = 100;
        this.scheduleReconnect();
      }
    });
  }

  /** Graceful shutdown */
  shutdown(): void {
    this.isShutdown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.disconnect();
    logger.info("Binance futures WS manager shut down");
  }

  private disconnect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.isShutdown || this.activeSymbols.size === 0) return;
    if (this.reconnectTimer) return;

    logger.info({ delay: this.reconnectDelay }, "Scheduling Binance futures WS reconnect");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isShutdown && this.activeSymbols.size > 0) {
        this.connect();
      }
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private binanceTfToApp(interval: string): string | null {
    for (const [appTf, binTf] of Object.entries(TF_TO_BINANCE)) {
      if (binTf === interval) return appTf;
    }
    return null;
  }

  /** Connection + freshness state for the health monitor (REQUIREMENTS §23). */
  getConnectionStatus(): { connected: boolean; symbols: number; streams: number; lastMessageAt: number } {
    const symbols = [...this.activeSymbols.keys()];
    let streams = 0;
    for (const tfs of this.activeSymbols.values()) streams += tfs.size;
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      symbols: symbols.length,
      streams,
      lastMessageAt: this.lastMessageAt,
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────────

export const binanceWs = new BinanceWsManager();
