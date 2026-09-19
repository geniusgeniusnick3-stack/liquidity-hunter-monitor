# Liquidity Hunter — 被動式 SMC 流動性監控

> **你問，它才掃。** 不做自動交易，不做主動推播，不使用帳號 API。

一個 24/7 可用的 SMC（Smart Money Concepts）流動性監控系統，改造自開源專案
[`GdotAiM/SMC-Liquidity-Hunter`](https://github.com/GdotAiM/SMC-Liquidity-Hunter)，
把原本的單幣網頁儀表板，改造成**在 Telegram 上按需查詢**的全市場掃描器。

---

## 這個專案做什麼

在 Binance USDT-M 永續市場的數百個交易對中，自動挑出流動性足夠的標的，
用 SMC 引擎分析它們的 BSL / SSL 流動性，並在你下指令時回報值得人工查看的價位事件。

**它只描述價格與流動性價位互動的客觀事實，不做方向預測。**

| 它會說 | 它不會說 |
|---|---|
| 「價格向上穿越這個 BSL，該根完成的 4H K 線收在流動性上方」 | 「突破了，要漲了」 |
| 「價格接近這個 SSL，距離 0.29%」 | 「這裡可以進場」 |

最終的方向判讀與交易決策，完全由使用者負責。

---

## 與上游專案的關係（血緣聲明）

本專案基於 **[Ntloso Ngubeni](https://github.com/GdotAiM) 的
[SMC-Liquidity-Hunter](https://github.com/GdotAiM/SMC-Liquidity-Hunter)**（MIT License, © 2026）。

上游提供了一個設計良好的 SMC 分析引擎（結構、訂單塊、FVG、流動性、PD Array、SMT 等
共 8 個模組、302 項單元測試）。**本專案沒有重寫這套引擎**，而是在它之上補上
資料源、標的選擇、事件生命週期、持久化與查詢介面。

| | 上游 | 本專案 |
|---|---|---|
| 用途 | 單一幣種的網頁分析儀表板 | 跨全市場的被動式查詢 |
| 資料源 | Binance US 現貨 + Yahoo Finance fallback | Binance 全球 USDT-M 永續 |
| 標的清單 | 程式碼中硬編碼 | 依流動性指標自動產生 |
| 流動性狀態 | `wasSwept: true / false` | 七種狀態 + ATR 容忍度 |
| 記憶 | 無（每次重算） | SQLite 帳本，跨重啟保留 |
| 通知 | 無 | Telegram（被動查詢） |
| 網頁儀表板 | 有 | **維持原狀，本專案不使用** |

---

## 我實作了什麼

### 1. 資料源修正（最根本的一項）

上游同時使用 Binance **US** 現貨端點與 Yahoo Finance fallback，在亞洲交易對上
幾乎沒有可用資料。

以 SUIUSDT 同一根 4H K 線為例：

| 來源 | 成交量 |
|---|---|
| Binance US（上游） | 24,925 |
| Binance 全球永續（本專案） | 54,594,665 |

差距 **2,190 倍**。改用全球 `fapi.binance.com` 後，該幣由「查無資料」變成
499 根完整 K 線。

同時修掉一個真實缺陷：原本的 `getCandles()` 會把**尚未收盤的 K 線**一起回傳，
導致 18 處呼叫點都用未完成的 K 線做判定。現在只回傳已收盤的 K 線。

### 2. 流動性狀態機

上游只有 `wasSwept: true / false`，且用精確浮點比較（`close > pool.price`）。

本專案擴充為七種狀態，並引入 ATR 容忍度：

| 狀態 | 意義 |
|---|---|
| `ACTIVE` | 尚未被觸及 |
| `APPROACHING` | 接近中（僅早期提示） |
| `TOUCHED` | 已觸及，但無確認 |
| `SWEPT` | 價格穿越價位，但該根**已收盤** K 線收回原側 |
| `BROKEN` | 價格穿越價位，且該根**已收盤** K 線收在另一側 |
| `INVALIDATED` | 已失效 |
| `PENDING_CONFIRMATION` | 未收盤 K 線的暫時狀態 |

三個關鍵設計原則：

- **只用已收盤 K 線做最終判定**，未完成 K 線不進入最終分類
- **時框一致性**：4H 的價位只能用已收盤的 4H K 線判定，低時框不得覆蓋
- **容忍度而非精確比對**：容忍度為 `ATR × 0.10`，經真實資料量測決定
  （BTC 的 4H ATR 約佔價格 1.10%，SUI 約 2.70%——固定百分比不可行）

### 3. 動態標的選擇

不再硬編碼清單。從全球 528 個 USDT 永續中，依實際分布校準門檻：

| 篩選條件 | 門檻 | 市場中位數 |
|---|---|---|
| 24 小時名目成交量 | ≥ $30M | $3.8M |
| 持倉量（OI） | ≥ $5M | $3.4M |
| 買賣價差 | ≤ 10 bps | 4.46 bps |
| 7 日中位成交量 | ≥ $20M | — |

結果：**528 → 58 個合格 → 取前 50**。

加入**滯後機制**（Hysteresis）避免清單震盪：前 50 名進入，掉出前 70 名才移除，
舊成員受保護。連續兩次刷新結果為 `added=0 removed=0`。

### 4. 事件去重（三層防護）

一個價位事件在短時間內可能被重複偵測，本專案用三層處理：

| 層級 | 機制 | 作用 |
|---|---|---|
| 身分 | 兩層 key（事件層 + 流動性層） | `APPROACHING → SWEPT` 視為同一事件，不重發 |
| 時間 | 冷卻 60 分鐘 / 去重窗 24 小時 | 同一幣短期內只吵一次 |
| 顯示 | 跨時框聚合 | 同一價位在多個時框各出現時，合併為一則 |

### 5. 持久化記憶

上游每次掃描都從當前視窗重新計算，**沒有記憶**——已處理過的價位會被反覆
當成新目標重報。

本專案使用 Node.js 內建 `node:sqlite`（無原生依賴），記錄每個價位的生命週期：

- 同一價位區域（容忍度 0.2%）在一週內已被處理過 → 不再重複提示
- 超過一週的歷史視為過期（加密市場結構約以週為週期輪替）
- 記憶跨程序重啟保留

### 6. 被動式查詢介面

**設計前提：系統不主動推播。** 只在使用者下指令時掃描並回報。

| 指令 | 作用 |
|---|---|
| `/scan` | 掃描全部追蹤標的 |
| `/scan TRXUSDT` | 只掃單一標的 |
| `/scan TRXUSDT 1h` | 只掃單一標的的單一時框 |
| `/events` | 檢視目前狀況（不重新掃描） |
| `/status` | 系統狀態與設定值 |
| `/help` | 指令說明 |

機器人只回應授權的聊天室，其他來源一律忽略；非指令的文字不會觸發任何掃描。

---

## 快速開始

### 需求

- Node.js 25+（需使用內建 `node:sqlite`）
- pnpm

### 安裝

```bash
git clone <this-repo>
cd smc_monitor/upstream
pnpm install
```

### 設定

複製 `.env.example` 為 `.env`：

```bash
TELEGRAM_BOT_TOKEN=<你的 bot token>
TELEGRAM_CHAT_ID=<你的聊天室 id>
```

`config.yaml` 集中所有可調參數（時框、門檻、冷卻、容忍度），修改後不需改程式碼。

### 使用

```bash
# 啟動被動查詢機器人
npx tsx artifacts/api-server/src/scripts/telegram-bot.ts

# 手動掃描（不發送，僅顯示）
npx tsx artifacts/api-server/src/scripts/live-snapshot.ts

# 手動掃描並發送
npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --send

# 只掃單一標的
npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --symbols TRXUSDT --timeframe 1h
```

### 測試

```bash
# 全部測試：486 項
npx tsx artifacts/api-server/src/lib/smc/liquidity-interaction.test.ts
npx tsx artifacts/api-server/src/lib/events/deduplicator.test.ts
npx tsx artifacts/api-server/src/lib/notify/formatters.test.ts
npx tsx artifacts/api-server/src/lib/persistence/liquidity-store.test.ts
npx tsx artifacts/api-server/src/scripts/telegram-bot.test.ts
# 加上上游原有的 7 個引擎模組測試（302 項）
```

---

## 設定參數

```yaml
timeframes: [1h, 4h]              # 分析時框

universe:
  min_volume_24h_usd: 30000000    # 24h 名目量門檻
  min_open_interest_usd: 5000000  # 持倉量門檻
  max_spread_bps: 10              # 價差上限
  active_size: 50                 # 追蹤標的數
  removal_rank: 70                # 滯後：掉出此名次才移除

liquidity:
  atr_tolerance_multiplier: 0.10  # ATR 容忍度倍數
  approach_threshold_pct: 0.5     # 接近門檻
  region_tolerance_pct: 0.2       # 同區域判定容忍度
  region_lookback_days: 7         # 同區域記憶回溯天數

alert_thresholds:
  cooldown_minutes: 60            # 同幣冷卻
  dedup_window_hours: 24          # 去重窗
```

---

## 驗收結果

兩項獨立驗收，都不依賴專案自己的測試套件。

### 一、跨交易所逐根比對（Bybit 為獨立來源）

| 標的 | 比對 K 線 | 中位價差 | 90% 分位 | 最大 |
|---|---|---|---|---|
| BTCUSDT 1H | 199 根 | 0.012% | 0.033% | 0.128% |
| TRXUSDT 1H | 199 根 | 0.044% | 0.065% | 0.304% |
| SUIUSDT 1H | 199 根 | 0.050% | 0.089% | 0.317% |

比對的是**價差分布**而非要求完全相同——兩個交易所本來就有合理 basis。
價差大小與流動性成反比（BTC 最小、冷門幣稍大），符合市場結構，無異常值。

複現：`npx tsx artifacts/api-server/src/scripts/verify-vs-external.ts TRXUSDT 1h`

### 二、引擎判定獨立重算

以另一套獨立實作，從原始 K 線重新推算 pivot 與 SWEPT / BROKEN，再與引擎輸出比對。

| 標的 | 驗算價位數 | 一致 |
|---|---|---|
| BTCUSDT 1H | 17 | 100% |
| ETHUSDT 1H | 17 | 100% |
| SUIUSDT 1H | 16 | 100% |
| XLMUSDT 1H | 15 | 100% |
| TRXUSDT 4H | 15 | 100% |
| BTCUSDT 4H | 18 | 100% |
| ENAUSDT 4H | 16 | 100% |
| DOGEUSDT 4H | 20 | 100% |
| **合計** | **134** | **100%** |

不只狀態一致，**連判定發生的那根 K 線時間也逐條相同**。

複現：`npx tsx artifacts/api-server/src/scripts/verify-engine-manual.ts TRXUSDT 1h`

### 為什麼不是 TradingView

TradingView 的圖表為 canvas 渲染、資料動態載入，無法逐根抓取數值，
因此改以上述兩項**可複現的數值比對**取代視覺比對——這比看圖更嚴格，
因為它驗證數字而非圖形，且任何人都能重跑。

---

## 已知限制（誠實說明）

| 限制 | 說明 |
|---|---|
| TradingView 無法自動化比對 | TradingView 圖表為 canvas 渲染、資料動態載入，無法逐根抓取。改以兩項等效且更嚴格的自動驗收取代（見下表） |
| 網頁儀表板上游原狀 | 未修改、未驗證，本專案不使用；其 WebSocket 串流路徑亦不在本專案使用範圍 |
| 未做自動化排程 | 依設計為被動查詢，不主動推播 |
| 無 AI 分析整合 | 上游的 AI agent 功能未納入本專案範圍 |

## 明確不做的事（Non-Goals）

本專案**不做**以下任何一項：

- 自動交易 / 自動進場 / 自動出場
- 進場訊號 / 停損 / 停利 / 部位大小計算
- 投資組合管理
- 交易所帳號串接（**不需要任何 API key 或 secret**）

系統可在**完全沒有 Binance 帳號**的情況下完整運作，僅使用公開市場資料端點。

---

## 授權

MIT License，與上游相同。上游原始版權宣告保留於 `LICENSE`。

原始專案：[`GdotAiM/SMC-Liquidity-Hunter`](https://github.com/GdotAiM/SMC-Liquidity-Hunter)
