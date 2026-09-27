import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { candleStore } from "../../realtime/candle-store.js";
import { buildReport } from "../../smc/report.js";
import { logger } from "../../logger.js";
import type { Market } from "../../smc/types.js";

function detectMarket(symbol: string): Market {
  return symbol.includes("=X") ? "forex" : "crypto";
}

export function registerDrawTargetsTool(server: FastMCP): void {
  server.addTool({
    name: "get_draw_targets",
    description:
      "Get ranked Draw on Liquidity (DOL) targets for a symbol. Each target is scored " +
      "by proximity to current price, bias alignment, and confluence factors " +
      "(nearby OBs, FVGs, PD zone, SMT divergence). Returns top 5 targets sorted by score.",
    parameters: z.object({
      symbol: z.string().describe("Trading symbol"),
      timeframe: z.enum(["1m","5m","15m","1h","4h","1d","1w"]),
    }),
    execute: async ({ symbol, timeframe }) => {
      try {
        const sym = symbol.toUpperCase();
        const market = detectMarket(sym);
        const candles = candleStore.getCandles(sym, timeframe);
        if (candles.length < 10) {
          return { content: [{ type: "text", text: `Insufficient candle data for ${sym} ${timeframe}` }] };
        }

        // candleStore.getCandles() returns only closed candles.
        const report = buildReport(candles, sym, market, timeframe, { closureEvidence: "proven" });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              symbol: sym, timeframe, market,
              currentPrice: report.currentPrice,
              targets: report.draw.slice(0, 5).map(d => ({
                type: d.type,
                price: d.price,
                direction: d.direction,
                score: Math.round(d.score * 100) / 100,
                label: d.label,
                evidence: d.evidence,
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ err, tool: "get_draw_targets", symbol, timeframe }, "MCP tool failed");
        return { content: [{ type: "text", text: `Draw target analysis failed: ${err instanceof Error ? err.message : "Unknown error"}` }], isError: true };
      }
    },
  });
}
