# Liquidity Hunter — 被動式 SMC 流動性監控

> **你問，它才掃。** 不做自動交易，不做主動推播，不使用帳號 API。

> **English version: [README.md](README.md)**

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

## 兩種監控模式（使用者自行選擇）

系統支援兩種運作模式，**共用完全相同的一套 SMC 分析引擎**。

| | **PASSIVE（預設）** | **ACTIVE（選用）** |
|---|---|---|
| 比喻 | 「我問的時候告訴我」 | 「幫我盯著，有事告訴我」 |
| 觸發方式 | 你下指令才掃描 | 背景持續監控 |
| 通知 | 只回覆你的查詢 | 事件發生時主動通知 |
| 閒置成本 | **零**（不掃描、不打 API） | 每根 K 線收盤才動作 |
| 預設 | ✅ 是 | 需明確開啟 |

**ACTIVE 不會被悄悄啟動。** 設定沒改就永遠是 PASSIVE；在 PASSIVE 狀態下執行 ACTIVE 的監控程式會被拒絕。

設定方式（`config.yaml`）：

```yaml
monitoring:
  mode: passive        # passive | active
  active_poll_seconds: 60   # ACTIVE 專用：多久醒來檢查一次
  active_concurrency: 12    # ACTIVE 專用：同時處理幾個請求
```

或不需要改檔案，用環境變數覆寫：

```bash
MONITORING_MODE=active npx tsx artifacts/api-server/src/scripts/monitor-loop.ts
```

在 Telegram 用 `/mode` 可查詢目前模式。

### 為什麼 ACTIVE 不會拖垮 API

| 機制 | 說明 |
|---|---|
| **K 線收盤才掃描** | 每分鐘醒來，但只做時間比對。沒有新收盤的 K 線 → **零請求** |
| **K 線快取** | 同一根 K 線期間重複檢查不會重新下載歷史 |
| **快慢分離** | 清單更新（6 小時）與行情監控節奏分開，不互相牽動 |
| **併發上限** | 逐批處理，避免一次打出上百個請求 |

### 共用引擎（架構保證）

```
市場資料 → 動態選幣 → 共用的 SMC 引擎 → 共用的事件分類
                                          ↓
                              ┌───────────┴───────────┐
                          PASSIVE                  ACTIVE
                         使用者查詢              背景監控
                              └───────────┬───────────┘
                                          ↓
                                      Telegram
```

兩種模式**唯一差別**是「什麼觸發分析」與「是否主動發送」。
底層的市場判讀**完全一致**——而且這件事有可執行的驗收在把關（見下方）。

---

## 通知語言（三選一）

| 代碼 | 語言 |
|---|---|
| `en` | 英文（**預設**） |
| `zh-TW` | 繁體中文 |
| `zh-CN` | 簡體中文 |

**預設是英文**——這是公開專案，主要讀者為國際使用者。要改成中文，改設定或直接用 Telegram 指令。

```yaml
notifications:
  language: en       # 改為 zh-TW 或 zh-CN
```

環境變數覆寫（接受常見別名如 `zh_Hant`、`cn`、`en-US`）：

```bash
NOTIFICATION_LANGUAGE=zh-CN npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --send
```

ICT 縮寫（BSL／SSL／SWEPT／BROKEN）**在所有語言都保留英文**，方便對照 TradingView 與教材。

### 三種設定方式，優先序如下

| 優先 | 方式 | 適用 |
|---|---|---|
| 1（最高） | 環境變數 `NOTIFICATION_LANGUAGE` | 部署層級，管理者指定 |
| 2 | Telegram 指令 `/language zh-CN` | 使用者即時切換，**不需重啟** |
| 3 | `config.yaml` 的 `notifications.language` | 安裝預設值（出廠為 `en` 英文） |

使用者用指令切換時，設定會存入本機資料庫（不是改 config.yaml——那個檔案在容器裡可能是唯讀的，而且改寫會破壞你的註解）。

⚠️ 如果環境變數已經把語言釘住，用 `/language` 切換會被覆蓋——這時機器人會**明白告訴你**「已記錄，但環境變數優先序更高」，而不是假裝成功。

### 涵蓋範圍：所有你看得到的文字

語言設定涵蓋**全部**使用者可見文字，不只是通知內容：

| 類別 | 是否跟隨語言 |
|---|---|
| 流動性通知（接近／掃過／突破） | ✅ |
| `/scan` 的掃描摘要回報 | ✅ |
| `/help`、`/mode`、`/status`、`/language` 的回應 | ✅ |
| 啟動訊息、錯誤提示 | ✅ |
| ICT 縮寫（BSL／SSL／SWEPT／BROKEN） | ➖ 固定英文（對照圖表用） |

這一項有測試在把關：切換語言後，上述每一類都必須實際改變，而且英文文案不得殘留中文字元。

---

## 與上游專案的關係（血緣聲明）

本專案基於 **[Ntloso Ngubeni](https://github.com/GdotAiM) 的
[SMC-Liquidity-Hunter](https://github.com/GdotAiM/SMC-Liquidity-Hunter)**（MIT License, © 2026）。

上游提供了一個設計良好的 SMC 分析引擎（結構、訂單塊、FVG、流動性、PD Array、SMT 等
共 8 個模組、302 項單元測試）。**本專案沒有重寫這套引擎**，而是在它之上補上
資料源、標的選擇、事件生命週期、持久化與查詢介面。

| | 上游 | 本專案 |
|---|---|---|
| 用途 | 單一幣種的網頁分析儀表板 | 跨全市場監控（被動查詢／主動監控） |
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

結果：**528 → 58 個合格 → 58 個全部納入**。

Universe 沒有 Top 50 或任何 Top-N 上限。排名只用於顯示與診斷，不能排除已通過資格的 symbol。

加入**門檻滯後機制**（Hysteresis）避免清單震盪：新 symbol 看 `entry_min`，
既有成員只有跌破明確的 `removal_min` 才移除。移出門檻目前標記為 provisional/configurable，
不是宣稱最佳值。

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

- 同一價位區域（容忍度 0.2%）在一週內已被處理過 → 只抑制重複事件/通知
- **流動性 level 本身不因年齡過期**；未解決的 level 由結構狀態維持，可超過 7 天
- 引擎看不到的未解決價位（索引漂移出掃描範圍）→ **從帳本還原**，且逐一重新驗證
- 事件/去重記憶與 liquidity level 的有效期限是兩套不同概念
- 記憶跨程序重啟保留

### 5b. 歷史深度與生命週期審計（實測，非推論）

移除「7 天過期」之後做了全量核對，結果發現**兩個會讓老價位消失的真實機制**——
都不是「7 天規則」，但效果一樣。

#### 機制一：索引漂移出掃描範圍

引擎找 pivot 是從窗內第 `windowSize` 根開始，因為一個轉折點需要左右兩側的上下文。
K 線窗往前滾，老價位的索引就往左漂；一旦漂到起點之前，引擎就再也看不到它——
**即使那根 K 線還在窗內**。

實例：`PENGUUSDT 1H BSL 0.009333`，位於窗內第 18 根（引擎自第 20 根起），20 天前形成。

#### 機制二：分數排名競爭落敗

引擎只回傳「分數前 20 名」，而分數含年齡衰減（1H 半衰期 200 根 ≈ 8 天）。
老價位會在排名中被擠掉；已取走的價位還帶 1.5 倍加成，會佔走活躍價位的位置。

實例：`BTWUSDT 1H BSL 0.38129`，18 天前形成，有效且未穿越，卻排不進前 20 名。

#### 修正

| 機制 | 做法 |
|---|---|
| 分數競爭 | 輸出選擇改為：**未解決的全部保留**，已取走的補滿剩餘名額；剛成交的事件也保證保留 |
| 索引漂移 | **從帳本還原**，且每一筆都用引擎自己的分類器重新驗證才採用 |

還原不是無條件相信帳本。帳本記的是「已知狀態」，分不出「還活著」與「已被取代」，
所以每一筆候選都要重新核對：價格真的穿越了就當歷史、被更極端 pivot 取代了就排除、
帳本價位與該根 K 線極值不符就不採用——**這三種都不還原**。

還原的價位走**完全相同**的處理路徑（快照、帳本、同區域抑制、事件判定、接近判定），
沒有旁路。

#### 窗深

| 時框 | 每次載入 | 等效窗深 |
|---|---|---|
| 1H | 500 根 | 20.8 天 |
| 4H | 500 根 | 83.3 天 |

#### 修正後的全量核對（45 幣 × 1H／4H）

| 項目 | 數字 |
|---|---|
| 帳本未解決價位 | 457 |
| 引擎直接回傳 | 1,417 |
| 帳本補回 | 1 |
| **掃描仍看不到** | **26** |

那 26 筆的原因**全部**是「已被更極端 pivot 取代」——既有結構失效規則，正確行為。

| 原因 | 筆數 | 判定 |
|---|---|---|
| 已被更極端 pivot 取代 | 26 | ✅ 正確 |
| 已穿越但事件未入帳（真漏報） | **0** | ✅ |
| 形成時間落在窗外 | **0** | ✅ |
| 帳本價位與 K 線極值不符 | **0** | ✅ |

`candle-depth.test.ts` 守住窗深：`SCAN_CANDLE_LIMIT` 調小到涵蓋不足 7 天就會測試失敗。

複現：

```bash
# 逐幣核對（使用正式還原路徑，不重複實作）
npx tsx artifacts/api-server/src/scripts/measure-level-coverage.ts BTCUSDT,ETHUSDT 1h,4h

# 單一價位：引擎看不看得到、帳本有沒有補回、沒補回的原因
npx tsx artifacts/api-server/src/scripts/explain-missing-level.ts BTCUSDT 1h 81181.8
```

### 6. 被動式查詢介面

**設計前提：系統不主動推播。** 只在使用者下指令時掃描並回報。

| 指令 | 作用 |
|---|---|
| `/scan` | 掃描全部追蹤標的 |
| `/scan BTCUSDT` | 只掃單一標的 |
| `/scan BTCUSDT 1h` | 只掃單一標的的單一時框 |
| `/events` | 檢視目前狀況（不重新掃描） |
| `/status` | 系統狀態與設定值 |
| `/mode` | 查詢監控模式（PASSIVE／ACTIVE） |
| `/language` | 查詢通知語言 |
| `/language zh-CN` | 切換通知語言（**立即生效，不需重啟**） |
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
npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --symbols BTCUSDT --timeframe 1h
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
  # 沒有 Top-N 上限；所有符合 eligibility 的 symbol 全部納入。
  eligibility:
    # 帶滯後：新 symbol 要過 entry；既有成員跌破 removal 才移出。
    # removal 值目前是 provisional/configurable，不宣稱最佳值。
    median_volume_7d:
      entry_min: 20000000         # 7D 中位量：加入門檻
      removal_min: 17000000       # 7D 中位量：移出門檻（provisional）
    volume_24h:
      entry_min: 30000000         # 24h 名目量：加入門檻
      removal_min: 25000000       # 24h 名目量：移出門檻（provisional）
    open_interest:
      entry_min: 5000000          # OI：加入門檻
      removal_min: 4000000        # OI：移出門檻（provisional）

    # 硬門檻：加入與移出使用同一個值。
    max_spread_bps: 10
    min_listing_age_days: 90

liquidity:
  atr_tolerance_multiplier: 0.10  # ATR 容忍度倍數
  approach_threshold_pct: 0.5     # 接近門檻
  region_tolerance_pct: 0.2       # 同區域判定容忍度
  # 這是「事件/通知抑制」記憶，不是 liquidity level 的生命期限。
  region_lookback_days: 7

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

複現：`npx tsx artifacts/api-server/src/scripts/verify-vs-external.ts BTCUSDT 1h`

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

複現：`npx tsx artifacts/api-server/src/scripts/verify-engine-manual.ts BTCUSDT 1h`

### 三、模式一致性驗收（PASSIVE ≡ ACTIVE）

架構上要求兩種模式共用同一套引擎。這不是靠自律，而是靠一支可執行的檢查把關：

| 層次 | 檢查內容 | 結果 |
|---|---|---|
| **靜態** | 兩個入口檔都不得直接引用 SMC 引擎或選幣邏輯 | ✅ 都只呼叫共用的 `runScan()` |
| **行為** | 相同輸入下，兩條路徑的判定必須逐字相同 | ✅ 4 筆判定完全一致 |
| **安全** | PASSIVE 模式下啟動 ACTIVE 監控必須被拒絕 | ✅ 拒絕且不會開始監控 |

行為比對的實際輸出（左為 PASSIVE、右為 ACTIVE，內容逐字相同）：

```
⊘ DOGEUSDT 1H SSL 0.07828 — 同區域 0.07842 已於 2026/09/17 01:00 SWEPT
⊘ TRXUSDT 1H SSL 0.33325 — 同區域 0.33317 已於 2026/09/16 02:00 BROKEN
⊘ TRXUSDT 1H SSL 0.33688 — 同區域 0.33724 已於 2026/09/15 08:00 SWEPT
⊘ XLMUSDT 1H SSL 0.17225 — 同區域 0.17253 已於 2026/09/17 01:00 SWEPT
```

複現：`npx tsx artifacts/api-server/src/scripts/verify-mode-parity.ts`

---

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
