export const SMC_CONFIG = {
  atrPeriod: 14,
  pivotLookback: 5,
  /**
   * How far a bar must stand above (below) its neighbours to count as a swing high
   * (low), as a multiple of ATR.
   *
   * Do NOT lower this to match the common open-source implementations. The Python
   * `smc` package, the TradingView pivot indicators and Bill Williams fractals all
   * detect pure extrema with no tolerance — but they also hand the pivots to the
   * user, whereas here the same pivots drive a trend/bias inference. Measured on 40
   * ranging trials (pure noise, no trend at all), lowering this reads a trend into
   * the noise:
   *
   *     0     -> 63% of trials called trending
   *     0.1   -> 60%
   *     0.15  -> 57%
   *     0.2   -> 40%
   *     0.25  -> 33%
   *     0.35  ->  3%
   *     0.5   ->  0%
   *
   * There is no useful middle: the transition is a cliff, which means the value is
   * not a fine-tuned prominence filter but the thing keeping the bias stable. The
   * real limitation is that ONE pivot set serves two jobs — liquidity levels (want
   * sensitivity, to see the newest swing a report should quote) and structure/bias
   * (wants robustness). Splitting those is the fix; lowering this is not.
   */
  pivotNoiseAtrMultiple: 0.5,
  /**
   * How close two swing highs (or lows) must be, as an ATR multiple, to be
   * judged the SAME level — the equal-highs / equal-lows pass (EQH / EQL).
   *
   * Replaces the old `equalLevelThreshold: 0.001` (0.1% of price, fixed). That
   * key was declared but never read by anything, and a fixed percentage fails
   * for exactly the reason `liquidityToleranceAtrMultiple` documents: 0.1% is a
   * wide gap for BTC and rounding noise for a small-cap perp.
   *
   * Why it is not zero: two highs separated by a tick are the same level to a
   * reader, and treating them as two pools double-counts one liquidity area.
   * Why it is not large: past roughly a third of an ATR the pair stops looking
   * like the same level on a chart, and the merge would start inventing
   * structure that is not there.
   */
  equalLevelAtrMultiple: 0.25,

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
   * See liquidity.ts classifyLiquidityInteraction().
   *
   * NOTE: despite an earlier comment here claiming otherwise, this value is NOT
   * overridable from config.yaml. The runtime classifier reads this constant
   * directly (liquidity.ts, scan/RestoredLevels.ts); the YAML key
   * `liquidity.tolerance_atr_multiple` is only consulted by the
   * verify-engine-manual.ts audit script. Changing the engine's behaviour means
   * changing this number. Keeping the two in step is a manual, unenforced step —
   * stated here rather than papered over.
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

  /*
   * How recently a level must have been TAKEN for the narrative to call it a
   * fresh sweep, in seconds.
   *
   * Measured against the interaction candle, not the pool's formation time, and
   * against the last completed candle's timestamp rather than the wall clock —
   * see `mostRecentTake()` in report.ts. The previous implementation compared
   * wall-clock now against `pool.time` (when the level FORMED), so a level
   * formed weeks ago and taken an hour ago never qualified, and the same candle
   * data produced different narratives depending on when it was read.
   *
   * 4 hours is the London-session window the narrative uses it for.
   */
  recentTakeWindowSeconds: 4 * 3600,

  /*
   * ── Market state layer (see smc/market-state.ts) ────────────────────────────
   *
   * Thresholds used to judge what a take left behind: was the breakout
   * ACCEPTED, did it FAIL, is there a confirmed MSS, and what does the short
   * read look like.
   *
   * PROVISIONAL, and labelled as such. `liquidityToleranceAtrMultiple` above
   * was calibrated against a measured distribution of 139 live levels; no such
   * measurement exists for these yet, so they are chosen to be conservative
   * (a state change needs more than one candle of evidence) rather than fitted
   * to a particular market. Do not quote them as optimal.
   *
   * `screening_lookback_bars` is the funnel: only a level taken within this many
   * completed bars is judged at all, because acceptance needs candles to
   * accumulate — a take from one bar ago can only ever be a sweep so far.
   * Overridable at startup from config.yaml → market_state.screening_lookback_bars.
   */
  /*
   * Global master switch for the state layer, kept in sync with
   * config.yaml → market_state.enabled by the config loader.
   *
   * It lives HERE, not only in the loader, because `buildReport()` is called
   * from paths that never load config.yaml (MCP tools, REST routes, the realtime
   * bridge, the backtest runner). Before this existed, `enabled: false` only
   * silenced `runScan()` and every other caller carried on computing the layer —
   * so "set enabled to false to get the previous behaviour" was not true.
   */
  marketStateEnabled: true,

  marketState: {
    screening_lookback_bars: 24,
    /* Consecutive completed closes outside the level needed to call it accepted. */
    acceptance_bars: 2,
    /* Minimum ATR multiple beyond the level for a close to count as "outside". */
    breakout_atr_multiple: 0.10,
    /* Minimum ATR multiple beyond a protected swing for a break to count. */
    mss_break_atr_multiple: 0.10,
    /* Displacement floors on the candle that breaks the protected swing. */
    mss_min_body_ratio: 0.5,
    mss_min_body_atr_multiple: 0.6,
    /* Only an MSS this recent counts as the current read. */
    mss_lookback_bars: 24,
    /* ATR multiple used when deciding a gap/block was traded back into. */
    retest_tolerance_atr_multiple: 0.05,
  },
};
