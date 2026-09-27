import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { candleStore } from "../../realtime/candle-store.js";
import { buildReport } from "../../smc/report.js";
import { logger } from "../../logger.js";
import type { Market, Timeframe } from "../../smc/types.js";

const ALL_TFS: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"];

function detectMarket(symbol: string): Market {
  return symbol.includes("=X") ? "forex" : "crypto";
}

export function registerScanAllTool(server: FastMCP): void {
  server.addTool({
    name: "scan_all_timeframes",
    description:
      "Run full SMC analysis across all 7 timeframes (M1→W1) for a symbol. " +
      "Returns the multi-timeframe cascade: which timeframes are bullish/bearish, " +
      "alignment across TFs, and bias for each. Useful for top-down analysis " +
      "(HTF sets direction, LTF provides entry).",
    parameters: z.object({
      symbol: z.string().describe("Trading symbol"),
    }),
    execute: async ({ symbol }) => {
      const start = Date.now();
      try {
        const sym = symbol.toUpperCase();
        const market = detectMarket(sym);
        const results: Record<string, { bias: string; confidence: number; price: number; narrative: string; error?: string }> = {};
        let succeeded = 0;
        let failed = 0;

        for (const tf of ALL_TFS) {
          try {
            const candles = candleStore.getCandles(sym, tf);
            if (candles.length < 10) {
              results[tf] = { bias: "unknown", confidence: 0, price: 0, narrative: "", error: `${candles.length} candles (need ≥10)` };
              failed++;
              continue;
            }
            // candleStore.getCandles() returns only closed candles.
            const report = buildReport(candles, sym, market, tf, { closureEvidence: "proven" });
            results[tf] = {
              bias: report.structure.bias,
              confidence: Math.round(report.structure.confidence * 100) / 100,
              price: report.currentPrice,
              narrative: report.narrative,
            };
            succeeded++;
          } catch (err) {
            results[tf] = { bias: "error", confidence: 0, price: 0, narrative: "", error: String(err) };
            failed++;
          }
        }

        logger.info({ tool: "scan_all_timeframes", symbol, succeeded, failed, durationMs: Date.now() - start }, "MCP tool executed");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              symbol: sym,
              market,
              scannedTimeframes: ALL_TFS.length,
              succeeded,
              failed,
              results,
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ err, tool: "scan_all_timeframes", symbol }, "MCP tool failed");
        return { content: [{ type: "text", text: `Scan failed: ${err instanceof Error ? err.message : "Unknown error"}` }], isError: true };
      }
    },
  });
}
