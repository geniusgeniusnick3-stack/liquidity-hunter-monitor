import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { candleStore } from "../../realtime/candle-store.js";
import { buildReport } from "../../smc/report.js";
import { marketStateSummary } from "../../smc/market-state.js";
import { fetchBinanceDailyCandles } from "../../fetchers/binance.js";
import { fetchYahooDailyCandles } from "../../fetchers/yahoo.js";
import { logger } from "../../logger.js";
import type { Market } from "../../smc/types.js";

function detectMarket(symbol: string): Market {
  return symbol.includes("=X") ? "forex" : "crypto";
}

export function registerFullReportTool(server: FastMCP): void {
  server.addTool({
    name: "build_full_report",
    description:
      "Build a complete SMC analysis report for a symbol across all 8 dimensions: " +
      "structure, liquidity, order blocks, fair value gaps, PD array, daily bias, " +
      "SMT divergence, and draw targets. Includes auto-generated market narrative " +
      "and session state. This is a composite — use for full analysis; use individual " +
      "tools for targeted queries.",
    parameters: z.object({
      symbol: z.string().describe("Trading symbol"),
      timeframe: z.enum(["1m","5m","15m","1h","4h","1d","1w"]),
    }),
    execute: async ({ symbol, timeframe }) => {
      const start = Date.now();
      try {
        const sym = symbol.toUpperCase();
        const market = detectMarket(sym);
        const candles = candleStore.getCandles(sym, timeframe);
        if (candles.length < 10) {
          return { content: [{ type: "text", text: `Insufficient candle data for ${sym} ${timeframe} (${candles.length} candles)` }] };
        }

        let dailyCandles;
        try {
          dailyCandles = market === "crypto"
            ? await fetchBinanceDailyCandles(sym)
            : await fetchYahooDailyCandles(sym);
        } catch { /* fallback */ }

        // candleStore.getCandles() returns only closed candles.
        const report = buildReport(candles, sym, market, timeframe, {
          dailyCandles,
          closureEvidence: "proven",
        });
        logger.info({ tool: "build_full_report", symbol, timeframe, durationMs: Date.now() - start }, "MCP tool executed");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              symbol: report.symbol,
              market: report.market,
              timeframe: report.timeframe,
              currentPrice: report.currentPrice,
              narrative: report.narrative,
              sessionState: report.sessionState,
              structure: {
                trend: report.structure.trend,
                bias: report.structure.bias,
                confidence: Math.round(report.structure.confidence * 100) / 100,
                phase: report.structure.phase,
                evidence: report.structure.evidence,
                breaks: report.structure.breaks.slice(-5).map(b => ({
                  type: b.type, direction: b.direction, price: b.price,
                })),
              },
              liquidity: {
                nearestBSL: report.liquidity.nearestBSL ? {
                  price: report.liquidity.nearestBSL.price,
                  score: Math.round(report.liquidity.nearestBSL.score * 100) / 100,
                  probSweep: Math.round(report.liquidity.nearestBSL.probabilityOfSweep * 100) / 100,
                } : null,
                nearestSSL: report.liquidity.nearestSSL ? {
                  price: report.liquidity.nearestSSL.price,
                  score: Math.round(report.liquidity.nearestSSL.score * 100) / 100,
                  probSweep: Math.round(report.liquidity.nearestSSL.probabilityOfSweep * 100) / 100,
                } : null,
              },
              orderBlocks: report.orderBlocks
                .filter(o => o.valid && !o.isMitigated)
                .slice(0, 5)
                .map(o => ({
                  type: o.type, proximal: o.proximal, distal: o.distal,
                  confidence: Math.round(o.confidence * 100) / 100,
                  isBreaker: o.isBreaker, hasFvg: o.hasFvg,
                })),
              fvg: report.fvg.filter(g => g.fillFraction < 0.5).slice(0, 5).map(g => ({
                type: g.type, top: g.top, bottom: g.bottom,
                fillPercent: Math.round(g.fillFraction * 100),
              })),
              pdArray: {
                currentBias: report.pdArray.currentBias,
                equilibrium: report.pdArray.equilibrium,
              },
              dailyBias: {
                bias: report.dailyBias.bias,
                strength: Math.round(report.dailyBias.strength * 100) / 100,
                consecutiveDays: report.dailyBias.consecutiveDays,
              },
              smt: { detected: report.smt.detected, type: report.smt.type },
              // Post-interaction state (breakout acceptance / failure, protected
              // swing, confirmed MSS, short read). Previously this tool mapped a
              // subset of the report and silently dropped the field.
              marketState: marketStateSummary(report.marketState),
              topDraws: report.draw.slice(0, 3).map(d => ({
                type: d.type, price: d.price, direction: d.direction,
                score: Math.round(d.score * 100) / 100, label: d.label,
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ err, tool: "build_full_report", symbol, timeframe }, "MCP tool failed");
        return { content: [{ type: "text", text: `Full report failed: ${err instanceof Error ? err.message : "Unknown error"}` }], isError: true };
      }
    },
  });
}
