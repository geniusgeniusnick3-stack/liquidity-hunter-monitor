/**
 * Fixture candle source — replay a recorded set of candles instead of fetching.
 *
 * WHY THIS EXISTS
 * ---------------
 * The mode-parity gate compares two ENTRY POINTS (PASSIVE and ACTIVE) and has to
 * show they interpret the same market data identically. It used to do that by
 * running both against the live exchange, which made the gate depend on the
 * network AND on the market: on a quiet day neither run produced an event, so the
 * comparison matched two empty results and proved nothing. Widening the symbol
 * list only lowered the odds of that happening — it did not remove the dependency.
 *
 * With a recorded fixture both children are handed byte-identical input, with no
 * network involved, so "identical output" is a statement about the two entry
 * points rather than about what the market happened to be doing.
 *
 * The fixture is a recording, not a fabrication: see scripts/capture-parity-fixture.ts,
 * which stores real klines. Replay is therefore deterministic while still being
 * real market data.
 *
 * Format: { "<SYMBOL>|<timeframe>": Candle[] }
 */
import { readFileSync } from "node:fs";
import type { Candle } from "../smc/types.js";
import type { ClosureEvidence } from "../smc/candles.js";

export interface FixtureCandleSource {
  source: (symbol: string, timeframe: string, limit: number) => Promise<Candle[]>;
  /**
   * A recorded fixture is a snapshot of CLOSED bars, so it can prove closure —
   * but only when the recording itself excluded the forming bar, which the
   * capture script does by construction (it uses fetchKlines).
   */
  closure: ClosureEvidence;
  /** How many symbol/timeframe series the fixture actually contains. */
  seriesCount: number;
}

/** Env var naming the fixture file. Absent means "fetch live", the normal path. */
export const FIXTURE_ENV = "SMC_FIXTURE_CANDLES";

/**
 * Build a candle source from the fixture named by `FIXTURE_ENV`.
 *
 * Returns `undefined` when the variable is unset, so callers can spread the
 * result and leave production behaviour untouched.
 */
export function loadFixtureCandleSource(
  env: NodeJS.ProcessEnv = process.env,
): FixtureCandleSource | undefined {
  const path = env[FIXTURE_ENV];
  if (!path) return undefined;

  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, Candle[]>;
  const series = Object.keys(parsed);

  return {
    seriesCount: series.length,
    closure: "proven",
    source: async (symbol, timeframe, limit) => {
      const key = `${symbol.toUpperCase()}|${timeframe}`;
      const candles = parsed[key];
      // An absent series yields nothing rather than reaching for the network:
      // a fallback fetch here would quietly reintroduce the dependency this
      // module exists to remove.
      if (!candles) return [];
      return candles.slice(-limit);
    },
  };
}
