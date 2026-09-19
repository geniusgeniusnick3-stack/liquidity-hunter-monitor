# Liquidity Hunter — On-Demand SMC Liquidity Monitor

> **It scans when you ask.** No auto-trading, no unsolicited push, no account APIs.

> ### 繁體中文說明 ｜ [完整中文版 README.zh-TW.md](README.zh-TW.md)
>
> 這是一套**被動式**的 SMC（Smart Money Concepts）流動性監控系統。
> 你在 Telegram 下指令（例如 `/scan BTCUSDT`），它才掃描 Binance USDT-M 永續市場，
> 回報值得人工查看的價位事件。
>
> **它只描述價格與流動性價位互動的客觀事實，不做方向預測。**
> 最終的交易決策完全由使用者負責。
>
> - 不做自動交易、不下單、不管理部位
> - 不主動推播（不是 24/7 一直吵你）
> - **不需要交易所帳號 API**（只用公開市場資料）
> - 基於開源專案 GdotAiM/SMC-Liquidity-Hunter（MIT），保留其分析引擎

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

## Two monitoring modes (user's choice)

The system supports two operating modes that share **exactly one SMC analysis
engine**.

| | **PASSIVE (default)** | **ACTIVE (optional)** |
|---|---|---|
| In a sentence | "Tell me when I ask." | "Monitor for me and tell me when something happens." |
| Trigger | Your command | Background timer |
| Alerts | Replies to your query only | Proactive, on state transitions |
| Idle cost | **Zero** — no scanning, no requests | Acts only when a candle closes |
| Default | ✅ Yes | Must be enabled explicitly |

**ACTIVE is never enabled silently.** An untouched config is always PASSIVE, and
running the ACTIVE monitor while PASSIVE is selected is refused.

```yaml
monitoring:
  mode: passive        # passive | active
  active_poll_seconds: 60   # ACTIVE only
  active_concurrency: 12    # ACTIVE only
```

Or override without editing the file:

```bash
MONITORING_MODE=active npx tsx artifacts/api-server/src/scripts/monitor-loop.ts
```

`/mode` on Telegram reports the current mode.

### Why ACTIVE does not hammer the API

| Mechanism | Effect |
|---|---|
| **Candle-close driven** | Wakes every poll but only compares clocks. No new close → **zero requests** |
| **Candle cache** | Re-checking within a candle period does not re-download history |
| **Separated cadences** | Universe refresh (6h) is decoupled from market polling |
| **Bounded concurrency** | Work is spread, never fired as one burst of hundreds of calls |

### Shared engine (architectural guarantee)

```
market data → dynamic universe → shared SMC engine → shared event classification
                                        ↓
                            ┌───────────┴───────────┐
                        PASSIVE                   ACTIVE
                     user query              background monitor
                            └───────────┬───────────┘
                                        ↓
                                    Telegram
```

The ONLY difference between the modes is what triggers an analysis and whether
alerts are pushed. Market interpretation is identical — and that is enforced by
a runnable check, not by convention (see Verification below).

---

## Alert language

| Code | Language |
|---|---|
| `en` | English (**default**) |
| `zh-TW` | Traditional Chinese |
| `zh-CN` | Simplified Chinese |

**The default is English** — this is a public repository with an international
audience. Switch via config or the Telegram command if you prefer otherwise.

```yaml
notifications:
  language: en       # or zh-TW / zh-CN
```

Environment override (common aliases such as `zh_Hant`, `cn`, `en-US` accepted):

```bash
NOTIFICATION_LANGUAGE=en npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --send
```

ICT abbreviations (BSL / SSL / SWEPT / BROKEN) stay in English in every language
so they line up with TradingView and course material.

### Three ways to set it, in precedence order

| Priority | How | Use case |
|---|---|---|
| 1 (highest) | `NOTIFICATION_LANGUAGE` env var | Deployment-level, set by an operator |
| 2 | Telegram `/language zh-CN` | User switches at runtime, **no restart needed** |
| 3 | `notifications.language` in `config.yaml` | Installed default (`en`) |

A switch made by command is stored in the local database rather than written back
to config.yaml — that file may be read-only in a container, and rewriting it would
reformat the operator's comments.

⚠️ If the environment variable pins the language, `/language` will be overridden —
and the bot says so plainly ("recorded, but the env var takes precedence") rather
than appearing to succeed.

### Scope: everything the user can read

The setting covers **all** user-visible text, not only alert bodies:

| Category | Follows the language setting |
|---|---|
| Liquidity alerts (approaching / swept / broken) | ✅ |
| The `/scan` summary report | ✅ |
| Replies to `/help`, `/mode`, `/status`, `/language` | ✅ |
| Startup message, error notices | ✅ |
| ICT abbreviations (BSL / SSL / SWEPT / BROKEN) | ➖ always English, to match charts |

This is covered by tests: after a switch, each of the above must actually change,
and English output must contain no CJK characters.

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
| Purpose | Single-symbol web dashboard | Market-wide monitor (passive or active) |
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

Result: **528 → 58 eligible → all 58 included.**

There is no Top-50 or fixed Top-N cap. Ranking is retained for display and
diagnostics only; it must never exclude a symbol that passes eligibility.

**Threshold hysteresis** prevents churn: a newcomer uses `entry_min`, while an
existing member is removed only below the explicit `removal_min`. Removal values
are currently marked provisional/configurable, not claimed to be optimal.

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

- A price region (0.2% tolerance) handled **within the past week** suppresses
  duplicate events/notifications only
- **A liquidity level does not expire merely because of age**; an unresolved
  level remains available beyond seven days until a structural state resolves
  or invalidates it
- Unresolved levels the engine can no longer reach (index drifted out of scan
  range) are **restored from the ledger**, each one re-verified first
- Event/dedup retention and liquidity-level validity are separate concerns
- The ledger survives process restarts

### 5b. History depth and lifetime audit (measured, not assumed)

Removing a seven-day expiry was only half the correction. A full comparison
against the live ledger turned up **two real mechanisms that make an old level
disappear** — neither is a seven-day rule, but both have the same effect.

#### Mechanism one: the index drifts out of scan range

The pivot scan starts `windowSize` bars into the array, because a swing point
needs context on both sides. The candle window slides forward, so a level's index
drifts leftward; once it crosses that start the engine stops seeing it — while
the candle is still loaded.

Live case: `PENGUUSDT 1H BSL 0.009333`, sitting at index 18 of 499 (the scan
begins at 20), formed 20 days earlier.

#### Mechanism two: losing the score contest

The engine returns only the top 20 by score, and `score` carries a recency decay
(half-life 200 bars ≈ 8 days on 1H). Old levels get squeezed out — and consumed
levels compete for the same slots with a 1.5x boost, so a taken level can occupy
one a live level needed.

Live case: `BTWUSDT 1H BSL 0.38129`, 18 days old, valid and untouched, outside
the top 20.

#### The fix

| Mechanism | Approach |
|---|---|
| Score contest | Output selection now keeps **every unresolved level**, with consumed levels filling the remaining slots; freshly settled events are guaranteed a slot too |
| Index drift | **Restore from the ledger**, re-verifying each candidate with the engine's own classifier before trusting it |

Restoration does not trust the ledger blindly. A ledger row records last-known
state and cannot tell "still live" from "superseded", so every candidate is
re-checked against the candles: traded through → history; superseded by a more
extreme pivot → excluded; recorded price disagreeing with its candle → not used.
**None of those three is restored.**

Restored levels go through the **identical** downstream path — standing state,
persistence, same-area suppression, event detection, approach test. There is no
parallel route.

#### Window depth

| Timeframe | Loaded per scan | Equivalent depth |
|---|---|---|
| 1H | 500 candles | 20.8 days |
| 4H | 500 candles | 83.3 days |

#### Full comparison after the fix (45 symbols x 1H/4H)

| Measure | Number |
|---|---|
| Unresolved levels on record | 457 |
| Returned directly by the engine | 1,417 |
| Recovered from the ledger | 1 |
| **Still invisible to a scan** | **26** |

All 26 were superseded by a more extreme pivot — the existing structural
invalidation rule, working as intended.

| Cause | Count | Verdict |
|---|---|---|
| Superseded by a more extreme pivot | 26 | ✅ correct |
| Traded through but the event never reached the ledger | **0** | ✅ |
| Formed outside the window | **0** | ✅ |
| Recorded price disagreed with its candle | **0** | ✅ |

`candle-depth.test.ts` guards the depth: narrowing `SCAN_CANDLE_LIMIT` so it no
longer spans seven days fails the suite.

Reproduce:

```bash
# Per-symbol comparison, using the production restore path rather than a copy
npx tsx artifacts/api-server/src/scripts/measure-level-coverage.ts BTCUSDT,ETHUSDT 1h,4h

# One price: does the engine see it, does the ledger recover it, and if not why
npx tsx artifacts/api-server/src/scripts/explain-missing-level.ts BTCUSDT 1h 81181.8
```

### 6. On-demand query interface

**Design premise: the system never pushes unsolicited alerts.** It scans only
when asked, and replies to that one request.

| Command | Effect |
|---|---|
| `/scan` | Scan the whole tracked universe |
| `/scan BTCUSDT` | Scan one symbol |
| `/scan BTCUSDT 1h` | Scan one symbol on one timeframe |
| `/events` | Show what is live now (no re-scan) |
| `/status` | System state and configuration |
| `/mode` | Report the monitoring mode (PASSIVE / ACTIVE) |
| `/language` | Report the alert language |
| `/language zh-CN` | Switch alert language (**effective immediately, no restart**) |
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
npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --symbols BTCUSDT --timeframe 1h
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
  # No Top-N cap: every symbol that passes eligibility is included.
  eligibility:
    # Hysteresis: newcomers use entry_min; incumbents leave below removal_min.
    # Removal values are provisional/configurable, not claimed to be optimal.
    median_volume_7d:
      entry_min: 20000000         # 7D median volume: join threshold
      removal_min: 17000000       # 7D median volume: removal threshold (provisional)
    volume_24h:
      entry_min: 30000000         # 24h quote volume: join threshold
      removal_min: 25000000       # 24h quote volume: removal threshold (provisional)
    open_interest:
      entry_min: 5000000          # OI: join threshold
      removal_min: 4000000        # OI: removal threshold (provisional)

    # Hard gates: the same value is used for joining and removal.
    max_spread_bps: 10
    min_listing_age_days: 90

liquidity:
  atr_tolerance_multiplier: 0.10  # ATR tolerance multiplier
  approach_threshold_pct: 0.5     # approaching distance
  region_tolerance_pct: 0.2       # same-area tolerance
  # Event/notification suppression memory, NOT liquidity-level lifetime.
  region_lookback_days: 7

alert_thresholds:
  cooldown_minutes: 60            # Per-symbol cooldown
  dedup_window_hours: 24          # Dedup window
```

---

## Verification results

Two independent checks, neither relying on the project's own test suite.

### 1. Cross-venue candle comparison (Bybit as an independent source)

| Symbol | Candles compared | Median basis | 90th pct | Max |
|---|---|---|---|---|
| BTCUSDT 1H | 199 | 0.012% | 0.033% | 0.128% |
| TRXUSDT 1H | 199 | 0.044% | 0.065% | 0.304% |
| SUIUSDT 1H | 199 | 0.050% | 0.089% | 0.317% |

The check is on the **distribution** of differences, not on equality — two
venues legitimately trade at a small basis. Basis scales inversely with
liquidity (smallest on BTC, wider on thinner alts), matching market structure,
with no outliers.

Reproduce: `npx tsx artifacts/api-server/src/scripts/verify-vs-external.ts BTCUSDT 1h`

### 2. Independent recomputation of engine verdicts

Pivots and SWEPT / BROKEN were re-derived from raw candles by a separate
implementation and compared against the engine.

| Symbol | Levels checked | Agreement |
|---|---|---|
| BTCUSDT 1H | 17 | 100% |
| ETHUSDT 1H | 17 | 100% |
| SUIUSDT 1H | 16 | 100% |
| XLMUSDT 1H | 15 | 100% |
| TRXUSDT 4H | 15 | 100% |
| BTCUSDT 4H | 18 | 100% |
| ENAUSDT 4H | 16 | 100% |
| DOGEUSDT 4H | 20 | 100% |
| **Total** | **134** | **100%** |

Agreement covers not just the state but **which candle produced it**, level by level.

Reproduce: `npx tsx artifacts/api-server/src/scripts/verify-engine-manual.ts BTCUSDT 1h`

### 3. Mode parity (PASSIVE ≡ ACTIVE)

The architecture requires both modes to share one engine. That is enforced by a
runnable check rather than by convention:

| Layer | What is checked | Result |
|---|---|---|
| **Static** | Neither entry point may import the SMC engine or universe logic | ✅ Both only call the shared `runScan()` |
| **Behavioural** | For identical input, both paths must produce identical verdicts | ✅ 4 verdicts match exactly |
| **Safety** | Starting ACTIVE while PASSIVE is selected must be refused | ✅ Refused, monitor does not start |

Actual behavioural output (PASSIVE vs ACTIVE, character-for-character identical):

```
⊘ DOGEUSDT 1H SSL 0.07828 — same area 0.07842 SWEPT
⊘ TRXUSDT 1H SSL 0.33325 — same area 0.33317 BROKEN
⊘ TRXUSDT 1H SSL 0.33688 — same area 0.33724 SWEPT
⊘ XLMUSDT 1H SSL 0.17225 — same area 0.17253 SWEPT
```

Reproduce: `npx tsx artifacts/api-server/src/scripts/verify-mode-parity.ts`

---

### Why not TradingView

TradingView's chart is canvas-rendered and loads data dynamically, so candles
cannot be scraped. The two numeric checks above replace a visual diff — they are
stricter, because they verify numbers rather than a picture, and anyone can
re-run them.

---

## Known limitations (stated honestly)

| Limitation | Detail |
|---|---|
| TradingView cannot be diffed automatically | Its chart is canvas-rendered and loads data dynamically, so candles cannot be scraped. Replaced with two equivalent, stricter automated checks (below) |
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
