/**
 * Tool Registry — maps tool names directly to their execute functions.
 *
 * This bypasses FastMCP internals for the MCP-aware agent endpoint.
 * The same functions are also registered with FastMCP for external MCP clients.
 */

import { z } from "zod";
import { candleStore } from "../realtime/candle-store.js";
import { analyzeStructure } from "../smc/structure.js";
import { analyzeLiquidity } from "../smc/liquidity.js";
import { analyzeOrderBlocks } from "../smc/order-blocks.js";
import { analyzeFVG } from "../smc/fvg.js";
import { analyzePdArray } from "../smc/pd-array.js";
import { analyzeDailyBias } from "../smc/daily-bias.js";
import { analyzeSMT } from "../smc/smt.js";
import { buildReport } from "../smc/report.js";
import { marketStateSummary } from "../smc/market-state.js";
import { fetchBinanceDailyCandles } from "../fetchers/binance.js";
import { fetchYahooDailyCandles } from "../fetchers/yahoo.js";
import type { Market, Timeframe } from "../smc/types.js";

const ALL_TFS: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"];

function detectMarket(symbol: string): Market {
  return symbol.includes("=X") ? "forex" : "crypto";
}

type ToolFn = (args: Record<string, unknown>) => Promise<string>;

export const toolRegistry = new Map<string, ToolFn>();

// ── analyze_structure ────────────────────────────────────────────────────────

toolRegistry.set("analyze_structure", async (args) => {
  const symbol = (args.symbol as string).toUpperCase();
  const timeframe = args.timeframe as string;
  const candles = candleStore.getCandles(symbol, timeframe);
  if (candles.length < 10) return JSON.stringify({ error: `Only ${candles.length} candles for ${symbol} ${timeframe}` });
  const r = analyzeStructure(candles, timeframe);
  return JSON.stringify({
    symbol, timeframe, trend: r.trend, bias: r.bias,
    confidence: Math.round(r.confidence * 100) / 100, phase: r.phase,
    recentBreaks: r.breaks.slice(-5).map(b => ({ type: b.type, direction: b.direction, price: b.price })),
    narrative: r.narrative, evidence: r.evidence,
  });
});

// ── analyze_liquidity ────────────────────────────────────────────────────────

toolRegistry.set("analyze_liquidity", async (args) => {
  const symbol = (args.symbol as string).toUpperCase();
  const timeframe = args.timeframe as string;
  const candles = candleStore.getCandles(symbol, timeframe);
  if (candles.length < 10) return JSON.stringify({ error: "Insufficient candles" });
  const mkt = detectMarket(symbol);
  const r = analyzeLiquidity(candles, timeframe, mkt);
  return JSON.stringify({
    symbol, timeframe, currentPrice: candles[candles.length - 1].close,
    nearestBSL: r.nearestBSL ? { price: r.nearestBSL.price, score: Math.round(r.nearestBSL.score * 100) / 100, probSweep: Math.round(r.nearestBSL.probabilityOfSweep * 100) / 100 } : null,
    nearestSSL: r.nearestSSL ? { price: r.nearestSSL.price, score: Math.round(r.nearestSSL.score * 100) / 100, probSweep: Math.round(r.nearestSSL.probabilityOfSweep * 100) / 100 } : null,
    activePools: r.pools.filter(p => !p.wasSwept).slice(0, 8).map(p => ({ type: p.type, price: p.price, probSweep: Math.round(p.probabilityOfSweep * 100) / 100 })),
  });
});

// ── analyze_order_blocks ─────────────────────────────────────────────────────

toolRegistry.set("analyze_order_blocks", async (args) => {
  const symbol = (args.symbol as string).toUpperCase();
  const timeframe = args.timeframe as string;
  const candles = candleStore.getCandles(symbol, timeframe);
  if (candles.length < 10) return JSON.stringify({ error: "Insufficient candles" });
  const mkt = detectMarket(symbol);
  const fvg = analyzeFVG(candles, mkt);
  const obs = analyzeOrderBlocks(candles, fvg);
  return JSON.stringify({
    symbol, timeframe,
    activeOBs: obs.filter(o => o.valid && !o.isMitigated).map(o => ({
      type: o.type, proximal: o.proximal, distal: o.distal,
      confidence: Math.round(o.confidence * 100) / 100,
      isBreaker: o.isBreaker, hasFvg: o.hasFvg, factors: o.confidenceFactors,
    })),
    breakerCount: obs.filter(o => o.isBreaker).length,
  });
});

// ── analyze_fvg ──────────────────────────────────────────────────────────────

toolRegistry.set("analyze_fvg", async (args) => {
  const symbol = (args.symbol as string).toUpperCase();
  const timeframe = args.timeframe as string;
  const candles = candleStore.getCandles(symbol, timeframe);
  if (candles.length < 10) return JSON.stringify({ error: "Insufficient candles" });
  const mkt = detectMarket(symbol);
  const fvgs = analyzeFVG(candles, mkt);
  return JSON.stringify({
    symbol, timeframe,
    unfilledGaps: fvgs.filter(g => g.fillFraction < 0.5).slice(-10).map(g => ({
      type: g.type, top: g.top, bottom: g.bottom, fillPercent: Math.round(g.fillFraction * 100), isInversion: g.isInversion,
    })),
  });
});

// ── analyze_pd_array ─────────────────────────────────────────────────────────

toolRegistry.set("analyze_pd_array", async (args) => {
  const symbol = (args.symbol as string).toUpperCase();
  const timeframe = args.timeframe as string;
  const candles = candleStore.getCandles(symbol, timeframe);
  if (candles.length < 10) return JSON.stringify({ error: "Insufficient candles" });
  const r = analyzePdArray(candles, timeframe);
  return JSON.stringify({
    symbol, timeframe, currentBias: r.currentBias, equilibrium: r.equilibrium,
    dealingRange: { high: r.dealingRange.high, low: r.dealingRange.low },
  });
});

// ── get_daily_bias ───────────────────────────────────────────────────────────

toolRegistry.set("get_daily_bias", async (args) => {
  const symbol = (args.symbol as string).toUpperCase();
  const mkt = detectMarket(symbol);
  const daily = mkt === "crypto" ? await fetchBinanceDailyCandles(symbol) : await fetchYahooDailyCandles(symbol);
  const r = analyzeDailyBias(daily);
  return JSON.stringify({
    symbol, bias: r.bias, strength: Math.round(r.strength * 100) / 100,
    consecutiveDays: r.consecutiveDays, evidence: r.evidence,
  });
});

// ── detect_smt ───────────────────────────────────────────────────────────────

toolRegistry.set("detect_smt", async (args) => {
  const pSym = (args.primarySymbol as string).toUpperCase();
  const cSym = (args.correlatedSymbol as string).toUpperCase();
  const tf = args.timeframe as string;
  const pCandles = candleStore.getCandles(pSym, tf);
  const cCandles = candleStore.getCandles(cSym, tf);
  if (pCandles.length < 10 || cCandles.length < 10) return JSON.stringify({ error: "Insufficient candles" });
  const r = analyzeSMT(pCandles, cCandles, pSym, cSym);
  return JSON.stringify({
    primarySymbol: pSym, correlatedSymbol: cSym, timeframe: tf,
    detected: r.detected, type: r.type,
    confidence: r.detected ? Math.round(r.confidence * 100) / 100 : 0,
  });
});

// ── get_draw_targets ─────────────────────────────────────────────────────────

toolRegistry.set("get_draw_targets", async (args) => {
  const symbol = (args.symbol as string).toUpperCase();
  const timeframe = args.timeframe as string;
  const candles = candleStore.getCandles(symbol, timeframe);
  if (candles.length < 10) return JSON.stringify({ error: "Insufficient candles" });
  const mkt = detectMarket(symbol);
  const r = buildReport(candles, symbol, mkt, timeframe, { closureEvidence: "proven" });
  return JSON.stringify({
    symbol, timeframe, currentPrice: r.currentPrice,
    targets: r.draw.slice(0, 5).map(d => ({
      type: d.type, price: d.price, direction: d.direction, score: Math.round(d.score * 100) / 100, label: d.label,
    })),
  });
});

// ── build_full_report ────────────────────────────────────────────────────────

toolRegistry.set("build_full_report", async (args) => {
  const symbol = (args.symbol as string).toUpperCase();
  const timeframe = args.timeframe as string;
  const candles = candleStore.getCandles(symbol, timeframe);
  if (candles.length < 10) return JSON.stringify({ error: "Insufficient candles" });
  const mkt = detectMarket(symbol);
  let daily;
  try { daily = mkt === "crypto" ? await fetchBinanceDailyCandles(symbol) : await fetchYahooDailyCandles(symbol); } catch { /* fallback */ }
  const r = buildReport(candles, symbol, mkt, timeframe, { dailyCandles: daily, closureEvidence: "proven" });
  return JSON.stringify({
    symbol: r.symbol, market: r.market, timeframe: r.timeframe, currentPrice: r.currentPrice,
    narrative: r.narrative, sessionState: r.sessionState,
    structure: { trend: r.structure.trend, bias: r.structure.bias, confidence: Math.round(r.structure.confidence * 100) / 100, phase: r.structure.phase },
    liquidity: {
      nearestBSL: r.liquidity.nearestBSL ? { price: r.liquidity.nearestBSL.price, probSweep: Math.round(r.liquidity.nearestBSL.probabilityOfSweep * 100) / 100 } : null,
      nearestSSL: r.liquidity.nearestSSL ? { price: r.liquidity.nearestSSL.price, probSweep: Math.round(r.liquidity.nearestSSL.probabilityOfSweep * 100) / 100 } : null,
    },
    topDraws: r.draw.slice(0, 3).map(d => ({ type: d.type, price: d.price, direction: d.direction, score: Math.round(d.score * 100) / 100 })),
    dailyBias: r.dailyBias.bias,
    smtDetected: r.smt.detected,
    // Post-interaction state. Present but previously unpublished here: the REST
    // route returned the whole report while this tool mapped a subset, so MCP
    // consumers never saw a field the report had been carrying.
    marketState: marketStateSummary(r.marketState),
  });
});

// ── get_live_candles ─────────────────────────────────────────────────────────

toolRegistry.set("get_live_candles", async (args) => {
  const symbol = (args.symbol as string).toUpperCase();
  const timeframe = (args.timeframe as string) || "4h";
  const limit = Math.min((args.limit as number) || 20, 300);
  const candles = candleStore.getCandles(symbol, timeframe);
  return JSON.stringify({
    symbol, timeframe, totalCandles: candles.length,
    candles: candles.slice(-limit).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
  });
});

// ── scan_all_timeframes ──────────────────────────────────────────────────────

toolRegistry.set("scan_all_timeframes", async (args) => {
  const symbol = (args.symbol as string).toUpperCase();
  const mkt = detectMarket(symbol);
  const results: Record<string, { bias: string; confidence: number; price: number }> = {};
  for (const tf of ALL_TFS) {
    try {
      const candles = candleStore.getCandles(symbol, tf);
      if (candles.length < 10) { results[tf] = { bias: "unknown", confidence: 0, price: 0 }; continue; }
      const r = buildReport(candles, symbol, mkt, tf, { closureEvidence: "proven" });
      results[tf] = { bias: r.structure.bias, confidence: Math.round(r.structure.confidence * 100) / 100, price: r.currentPrice };
    } catch { results[tf] = { bias: "error", confidence: 0, price: 0 }; }
  }
  return JSON.stringify({ symbol, market: mkt, results });
});
