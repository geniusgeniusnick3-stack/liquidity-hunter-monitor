export const SMC_CONFIG = {
  atrPeriod: 14,
  pivotLookback: 5,
  minTouches: 2,
  equalLevelThreshold: 0.001,

  obRequireFvg: true,
  fvgMinBodyRatio: 0.5,

  volumeSpikeMin: {
    crypto: 1.5,
    forex: 0,
  } as Record<string, number>,

  /* Per-timeframe pivot lookback — shorter TFs need tighter pivots */
  pivotLookbackPerTf: {
    "1m":  2,
    "5m":  2,
    "15m": 3,
    "1h":  5,
    "4h":  5,
    "1d":  5,
    "1w":  5,
  } as Record<string, number>,

  /* Per-timeframe ATR period — shorter TFs react faster */
  atrPeriodPerTf: {
    "1m":  6,
    "5m":  8,
    "15m": 10,
    "1h":  14,
    "4h":  14,
    "1d":  14,
    "1w":  14,
  } as Record<string, number>,

  /* Per-timeframe minimum touches for a liquidity pool to count */
  minTouchesPerTf: {
    "1m":  1,
    "5m":  1,
    "15m": 1,
    "1h":  2,
    "4h":  2,
    "1d":  2,
    "1w":  2,
  } as Record<string, number>,

  liquidityHalfLifeBars: {
    "1m":  80,
    "5m":  100,
    "15m": 120,
    "1h":  200,
    "4h":  200,
    "1d":  200,
    "1w":  100,
  } as Record<string, number>,

  sessionWeights: {
    asia:     1.3,
    london:   1.2,
    newYork:  1.2,
    overlap:  1.5,
    offHours: 0.8,
  },

  smaPeriod: 20,
  obLookForward: 3,
  maxCandles: 500,
  maxDailyCandles: 120,

  /*
   * Tolerance used when deciding how a COMPLETED candle interacted with a
   * liquidity level (SWEPT / BROKEN / TOUCHED), expressed as a multiple of ATR.
   *
   * Deliberately volatility-scaled rather than a fixed percentage: a 0.1% band
   * is enormous for BTC and noise-level for a small-cap perp. The engine already
   * scales pivot noise and impulse detection by ATR*0.5 (see structure.ts and
   * order-blocks.ts), so this follows the established convention.
   *
   * See liquidity.ts classifyLiquidityInteraction(). Overridable per run via
   * config.yaml → liquidity.tolerance_atr_multiple.
   *
   * CALIBRATED, not guessed. Measured ATR(14, 4H) ranges from 1.10% of price
   * (BTC) to 2.70% (SUI) across live majors — a 2.5x spread, which is why a
   * fixed percentage cannot work. A scan over 8 majors / 139 detected levels
   * (scripts/calibrate-liquidity-tolerance.ts) gave:
   *    0.00 / 0.02 → BROKEN 54   (no filtering — hair-past-the-level counts)
   *    0.05        → BROKEN 50   (-7.4%)
   *    0.10        → BROKEN 48   (-11.1%)  ← filtered most without eating real breaks
   *    0.20        → BROKEN 50   (starts deferring settlement to later candles)
   *    0.50        → BROKEN 38   (-29.6%, over-filtered)
   */
  liquidityToleranceAtrMultiple: 0.10,
};
