# Liquidity Hunter — On-Demand SMC Liquidity Monitor

> **It scans when you ask.** No auto-trading, no unsolicited push, no account APIs.

An SMC (Smart Money Concepts) liquidity monitor for the Binance USDT-M perpetual
market, built on top of the open-source
[`GdotAiM/SMC-Liquidity-Hunter`](https://github.com/GdotAiM/SMC-Liquidity-Hunter).
The upstream single-symbol web dashboard was reworked into an **on-demand
market-wide scanner queried from Telegram**.

---

## What this does

It screens several hundred Binance USDT-M perpetual pairs, keeps the ones with
enough liquidity, analyses their BSL / SSL liquidity with the SMC engine, and —
**when you ask it to** — reports price events worth a human look.

**It describes how price interacted with a liquidity level. It does not predict direction.**

| It says | It does not say |
|---|---|
| "Price traded through this BSL; the completed 4H candle closed above it" | "Breakout — expect continuation" |
| "Price is approaching this SSL, 0.29% away" | "This is an entry" |

Every directional interpretation and every trading decision remains the user's
responsibility. See [Non-Goals](#non-goals).

---

## Relationship to the upstream project

This project builds on **[Ntloso Ngubeni](https://github.com/GdotAiM)'s
[SMC-Liquidity-Hunter](https://github.com/GdotAiM/SMC-Liquidity-Hunter)**
(MIT License, © 2026).

Upstream provides a well-built SMC analysis engine — structure, order blocks,
FVG, liquidity, PD arrays and SMT across 8 modules with 302 unit tests.
**This project does not rewrite that engine.** It adds the data feed, universe
selection, event lifecycle, persistence and a query interface around it.

| | Upstream | This project |
|---|---|---|
| Purpose | Single-symbol web dashboard | Market-wide on-demand query |
| Data source | Binance US spot + Yahoo Finance fallback | Binance global USDT-M perpetuals |
| Symbol list | Hard-coded in source | Derived from liquidity metrics |
| Liquidity state | `wasSwept: true / false` | Seven states + ATR tolerance |
| Memory | None (recomputed each run) | SQLite ledger, survives restarts |
| Alerts | None | Telegram (on demand) |
| Web dashboard | Yes | **Left as-is, unused by this project** |

---

## What was implemented

### 1. Data source correction (the most fundamental change)

Upstream used Binance **US** spot endpoints plus a Yahoo Finance fallback, which
left Asian pairs with almost no usable data.

Same 4H candle, SUIUSDT:

| Source | Volume |
|---|---|
| Binance US (upstream) | 24,925 |
| Binance global perpetual (this project) | 54,594,665 |

A **2,190×** difference. After switching to the global `fapi.binance.com`
endpoints, SUIUSDT went from "no data" to 499 complete candles.

A real defect was fixed at the same time: the original `getCandles()` also
returned the **still-forming candle**, so 18 call sites were classifying on an
incomplete bar. It now returns closed candles only.

### 2. Liquidity state machine

Upstream had a boolean `wasSwept` and compared floats exactly
(`close > pool.price`). This project defines seven states with an ATR tolerance:

| State | Meaning |
|---|---|
| `ACTIVE` | Not yet touched |
| `APPROACHING` | Getting close (early notice only) |
| `TOUCHED` | Reached, but unconfirmed |
| `SWEPT` | Traded through the level, but the **completed** candle closed back on the original side |
| `BROKEN` | Traded through the level and the **completed** candle closed beyond it |
| `INVALIDATED` | No longer valid |
| `PENDING_CONFIRMATION` | Temporary state while the candle is still forming |

Three governing rules:

- **Only completed candles may finalise a state.** Forming candles never do.
- **Timeframe consistency.** A 4H level is judged on completed 4H candles;
  lower timeframes may not override the higher-timeframe verdict.
- **Tolerance, not exact comparison.** Tolerance is `ATR × 0.10`, chosen by
  measuring real data (BTC's 4H ATR is ~1.10% of price, SUI's ~2.70% — a fixed
  percentage cannot work for both).

### 3. Dynamic universe

No hard-coded list. Thresholds are calibrated against the observed distribution
across all 528 global USDT perpetuals:

| Filter | Threshold | Market median |
|---|---|---|
| 24h notional volume | ≥ $30M | $3.8M |
| Open interest | ≥ $5M | $3.4M |
| Bid/ask spread | ≤ 10 bps | 4.46 bps |
| 7-day median volume | ≥ $20M | — |

Result: **528 → 58 eligible → top 50 selected.**

**Hysteresis** prevents churn: a symbol enters at top 50 and is only removed
once it falls outside top 70; existing members are protected. Two consecutive
refreshes produced `added=0 removed=0`.

### 4. Event de-duplication (three layers)

| Layer | Mechanism | Effect |
|---|---|---|
| Identity | Two-level key (event + liquidity) | `APPROACHING → SWEPT` is the same event, not a new one |
| Time | 60-minute cooldown, 24-hour dedup window | One symbol does not nag more than once per window |
| Display | Cross-timeframe collapse | The same price on 1H and 4H becomes one alert, not two |

### 5. Persistent memory

Upstream recomputed everything from the current window on each run, so it had
**no memory** — a level that had already been consumed would be re-reported as
a fresh target indefinitely.

This project uses Node's built-in `node:sqlite` (no native dependency) to track
each level's lifecycle:

- A price region (0.2% tolerance) already handled **within the past week**
  is not reported again
- History older than a week is treated as stale (crypto structure turns over
  on roughly a weekly cycle)
- The ledger survives process restarts

### 6. On-demand query interface

**Design premise: the system never pushes unsolicited alerts.** It scans only
when asked, and replies to that one request.

| Command | Effect |
|---|---|
| `/scan` | Scan the whole tracked universe |
| `/scan TRXUSDT` | Scan one symbol |
| `/scan TRXUSDT 1h` | Scan one symbol on one timeframe |
| `/events` | Show what is live now (no re-scan) |
| `/status` | System state and configuration |
| `/help` | Command list |

The bot answers the authorised chat only. Any other source is ignored, and
plain text never triggers a scan.

---

## Quick start

### Requirements

- Node.js 25+ (uses the built-in `node:sqlite`)
- pnpm

### Install

```bash
git clone <this-repo>
cd smc_monitor/upstream
pnpm install
```

### Configure

Copy `.env.example` to `.env`:

```bash
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your chat id>
```

All tunables live in `config.yaml` (timeframes, thresholds, cooldowns,
tolerances) — no code changes required.

### Run

```bash
# Start the on-demand bot
npx tsx artifacts/api-server/src/scripts/telegram-bot.ts

# Manual scan (dry run, prints only)
npx tsx artifacts/api-server/src/scripts/live-snapshot.ts

# Manual scan and send
npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --send

# Single symbol
npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --symbols TRXUSDT --timeframe 1h
```

### Tests

486 tests pass (185 added by this project + 302 upstream engine tests):

```bash
npx tsx artifacts/api-server/src/lib/smc/liquidity-interaction.test.ts   # 31
npx tsx artifacts/api-server/src/lib/events/deduplicator.test.ts          # 26
npx tsx artifacts/api-server/src/lib/notify/formatters.test.ts            # 84
npx tsx artifacts/api-server/src/lib/persistence/liquidity-store.test.ts  # 43
npx tsx artifacts/api-server/src/scripts/telegram-bot.test.ts             # 14
# plus the 7 upstream engine modules (302)
```

---

## Configuration

```yaml
timeframes: [1h, 4h]              # Analysis timeframes

universe:
  min_volume_24h_usd: 30000000    # 24h notional volume floor
  min_open_interest_usd: 5000000  # Open interest floor
  max_spread_bps: 10              # Spread ceiling
  active_size: 50                 # Tracked symbols
  removal_rank: 70                # Hysteresis: drop out only below this rank

liquidity:
  atr_tolerance_multiplier: 0.10  # ATR tolerance multiplier
  approach_threshold_pct: 0.5     # "Approaching" distance
  region_tolerance_pct: 0.2       # Same-region tolerance
  region_lookback_days: 7         # How far back "already handled" counts

alert_thresholds:
  cooldown_minutes: 60            # Per-symbol cooldown
  dedup_window_hours: 24          # Dedup window
```

---

## Known limitations (stated honestly)

| Limitation | Detail |
|---|---|
| **No manual TradingView cross-check yet** | Engine output is covered by 302 unit tests plus real-data validation, but has not been checked line-by-line against manually marked charts |
| Web dashboard left untouched | Unmodified and unverified; not used by this project. Its WebSocket streaming path is likewise out of scope |
| No scheduler by design | Passive query only — it does not push alerts on its own |
| No AI analysis integration | Upstream's AI agent features are out of scope |

## Non-Goals

This project deliberately does **none** of the following:

- Auto trading / automatic entry / automatic exit
- Entry signals, stop loss, take profit, position sizing
- Portfolio management
- Exchange account integration (**no API key or secret required**)

It runs fully without a Binance account, using public market data endpoints only.

---

## License

MIT, same as upstream. The original copyright notice is preserved in `LICENSE`.

Upstream: [`GdotAiM/SMC-Liquidity-Hunter`](https://github.com/GdotAiM/SMC-Liquidity-Hunter)
