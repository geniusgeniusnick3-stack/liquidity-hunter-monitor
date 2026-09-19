/**
 * Restore persisted levels the engine can no longer see.
 *
 * Why this exists
 * ---------------
 * The pivot scan starts at `windowSize` bars into the array, because a swing
 * high needs context on both sides. The candle window slides forward, so a
 * level's index drifts leftward as it ages; once it crosses that boundary the
 * engine stops considering it — while the candle is still in the window.
 *
 * Measured: PENGUUSDT 1H BSL 0.009333 sat at index 18 of 499 and was therefore
 * invisible, with the engine's output nowhere near its 20-level limit. Nothing
 * was wrong with the level; it had simply aged out of the scan's reach.
 *
 * The ledger already knows about that level, which is exactly what the
 * persistence requirement is for: an unresolved level must not have to be
 * rediscovered from candles. But a ledger row cannot be trusted blindly — a
 * level the engine stops returning may equally have been superseded, and the
 * ledger has no way to say which. So every candidate is RE-VERIFIED against the
 * candles before it is restored, using the engine's own classifier and its own
 * window rule. Anything that turns out to have been taken or superseded is left
 * out, and the ledger's own record decides nothing on its own.
 *
 * Restored levels are handed back as ordinary LiquidityPool objects so they
 * flow through the identical downstream path — standing state, persistence,
 * event detection, approaching distance. There is no parallel route for them.
 */
import type { Candle, LiquidityPool } from "../smc/types.js";
import { classifyLiquidityInteraction } from "../smc/liquidity.js";
import { SMC_CONFIG } from "../smc/config.js";
import { calcATR } from "../smc/atr.js";
import type { LiquidityLevel } from "../persistence/LiquidityStore.js";

/** Why a candidate was not restored — kept for logging and for the audit tools. */
export type RestoreSkipReason =
  | "in-engine-output"
  | "formed-outside-window"
  | "price-mismatch"
  | "superseded"
  | "consumed";

export interface RestoreOutcome {
  /** Levels that are still live and should be treated exactly like engine pools. */
  restored: LiquidityPool[];
  /** Candidates that were checked and rejected, with the reason. */
  skipped: Array<{ id: string; reason: RestoreSkipReason }>;
}

/**
 * Re-verify a persisted level against the candles.
 *
 * Two ways a level stops being a live target, both already expressed by the
 * engine's own rules:
 *
 *   superseded  a more extreme pivot formed within the window after it, so this
 *               bar is no longer a local extreme. Only the RIGHT side is checked,
 *               and that is sufficient rather than lazy: the candles to the left
 *               are fixed history that already satisfied the condition when the
 *               level was first detected, and new bars cannot change them.
 *
 *   consumed    price traded beyond it on a completed candle, so it was taken.
 *               The walk uses the same per-candle ATR tolerance as detection,
 *               so a hair past the level does not count as acceptance.
 */
function reverify(
  level: LiquidityLevel,
  candles: Candle[],
  windowSize: number,
  toleranceAt: (k: number) => number,
): { ok: true; pool: LiquidityPool } | { ok: false; reason: RestoreSkipReason; consumedAt?: number; extreme?: number; close?: number } {
  const formedIdx = candles.findIndex((c) => c.time === level.formedAt);
  if (formedIdx < 0) return { ok: false, reason: "formed-outside-window" };

  const isBuySide = level.side === "BSL";
  const candleExtreme = isBuySide ? candles[formedIdx].high : candles[formedIdx].low;

  // The recorded price must be the candle's own extreme at that time. A pivot IS
  // its bar's high (BSL) or low (SSL), and historical bars do not change, so a
  // disagreement means the row cannot be reconciled — and quietly using either
  // number would report a level at a price the ledger never recorded.
  if (Math.abs(candleExtreme - level.price) > Math.abs(level.price) * 1e-6) {
    return { ok: false, reason: "price-mismatch" };
  }

  const price = level.price;

  // ── Superseded? (right side only — see the note above) ──
  for (let j = formedIdx + 1; j <= Math.min(formedIdx + windowSize, candles.length - 1); j++) {
    const p = isBuySide ? candles[j].high : candles[j].low;
    if (isBuySide ? p >= price : p <= price) return { ok: false, reason: "superseded" };
  }

  // ── Consumed? Walk forward with the engine's own classifier ──
  let interaction: LiquidityPool["interaction"] = "NONE";
  let interactionIdx: number | null = null;
  let touches = Math.max(1, level.touches);

  for (let k = formedIdx + 1; k < candles.length; k++) {
    const state = classifyLiquidityInteraction(price, isBuySide, candles[k], toleranceAt(k));
    if (state !== "NONE") touches++;

    if (state === "SWEPT" || state === "BROKEN") {
      return {
        ok: false,
        reason: "consumed",
        consumedAt: candles[k].time,
        extreme: isBuySide ? candles[k].high : candles[k].low,
        close: candles[k].close,
      };
    }
    if (state === "TOUCHED" && interaction === "NONE") {
      interaction = "TOUCHED";
      interactionIdx = k;
    }
  }

  const interactionCandle =
    interactionIdx !== null
      ? {
          time: candles[interactionIdx].time,
          high: candles[interactionIdx].high,
          low: candles[interactionIdx].low,
          close: candles[interactionIdx].close,
        }
      : null;

  return {
    ok: true,
    pool: {
      price,
      type: isBuySide ? "BSL" : "SSL",
      // Not ranked. `score` is an ordering device for the engine's own output
      // limit; a restored level is reported because it is unresolved, not
      // because it won a ranking contest.
      score: 0,
      touches,
      wasSwept: false,
      sweptAt: null,
      time: level.formedAt,
      index: formedIdx,
      session: level.session,
      // Upstream derives this from session weights and recency decay. Those are
      // engine internals, and this project does not use the field (it feeds the
      // upstream dashboard's draw-target ranking). Zero rather than a plausible
      // invented number.
      probabilityOfSweep: 0,
      interaction,
      interactionAt: interactionIdx !== null ? candles[interactionIdx].time : null,
      interactionCandle,
      tolerance: interactionIdx !== null ? toleranceAt(interactionIdx) : null,
    },
  };
}

/**
 * Persisted levels that the engine did not return but which are still live.
 *
 * `engineIds` is what the engine DID return, so those are never re-added and the
 * two sources cannot double-count.
 */
export function restorePersistedLevels(params: {
  candidates: LiquidityLevel[];
  candles: Candle[];
  timeframe: string;
  engineIds: Set<string>;
}): RestoreOutcome {
  const { candidates, candles, timeframe, engineIds } = params;
  const n = candles.length;
  if (n === 0) return { restored: [], skipped: candidates.map((c) => ({ id: c.id, reason: "formed-outside-window" })) };

  const atrPeriod = SMC_CONFIG.atrPeriodPerTf[timeframe] ?? SMC_CONFIG.atrPeriod;
  const atr = calcATR(candles, atrPeriod);
  const mult = SMC_CONFIG.liquidityToleranceAtrMultiple;
  const toleranceAt = (k: number): number => Math.max((atr[k] ?? 0) * mult, 0);
  const windowSize = Math.min(20, Math.floor(n / 4));

  const restored: LiquidityPool[] = [];
  const skipped: RestoreOutcome["skipped"] = [];

  for (const level of candidates) {
    if (engineIds.has(level.id)) {
      skipped.push({ id: level.id, reason: "in-engine-output" });
      continue;
    }
    const verdict = reverify(level, candles, windowSize, toleranceAt);
    if (verdict.ok) restored.push(verdict.pool);
    else skipped.push({ id: level.id, reason: verdict.reason });
  }

  return { restored, skipped };
}
