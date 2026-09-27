# Liquidity Hunter — SMC 流动性监控

> 默认为被动查询模式；用户也可以明确启用主动监控模式。

> **你问，它才扫**（想让它在后台盯着，需要自行开启 ACTIVE 模式）。
> 不做自动交易，不使用账户 API。

> **English version: [README.md](README.md)**
> **繁體中文版：[README.zh-TW.md](README.zh-TW.md)**

一个 24/7 可用的 SMC（Smart Money Concepts）流动性监控系统，改造自开源项目
[`GdotAiM/SMC-Liquidity-Hunter`](https://github.com/GdotAiM/SMC-Liquidity-Hunter)，
把原本的单币网页仪表盘，改造成**在 Telegram 上查询**的全市场扫描器，
且可选配后台主动监控。

---

## 这个项目做什么

在 Binance USDT-M 永续市场的数百个交易对中，自动挑出流动性足够的标的，
用 SMC 引擎分析它们的 BSL / SSL 流动性，并在你下指令时（ACTIVE 模式下则在 K 线收盘时）
回报值得人工查看的价位事件。

**它只描述价格与流动性价位互动的客观事实，不做方向预测。**

| 它会说 | 它不会说 |
|---|---|
| “价格向上穿越这个 BSL，该根完成的 4H K 线收在流动性上方” | “突破了，要涨了” |
| “价格接近这个 SSL，距离 0.29%” | “这里可以进场” |

最终的方向判读与交易决策，完全由用户负责。

---

## 两种监控模式（用户自行选择）

系统支持两种运行模式，**共用完全相同的一套 SMC 分析引擎**。

| | **PASSIVE（默认）** | **ACTIVE（选用）** |
|---|---|---|
| 比喻 | “我问的时候告诉我” | “帮我盯着，有事告诉我” |
| 触发方式 | 你下指令才扫描 | 后台持续监控 |
| 通知 | 只回复你的查询 | 事件发生时主动通知 |
| 闲置成本 | **零**（不扫描、不调 API） | 每根 K 线收盘才动作 |
| 默认 | ✅ 是 | 需明确开启 |

**ACTIVE 不会被悄悄启动。** 配置没改就永远是 PASSIVE；在 PASSIVE 状态下执行 ACTIVE 的监控程序会被拒绝。

配置方式（`config.yaml`）：

```yaml
monitoring:
  mode: passive        # passive | active
  active_poll_seconds: 60   # ACTIVE 專用：多久醒來檢查一次
  active_concurrency: 12    # ACTIVE 專用：同時處理幾個請求
```

或者不用改文件，用环境变量覆盖：

```bash
MONITORING_MODE=active npx tsx artifacts/api-server/src/scripts/monitor-loop.ts
```

在 Telegram 用 `/mode` 可查询当前模式。

### 为什么 ACTIVE 不会拖垮 API

| 机制 | 说明 |
|---|---|
| **K 线收盘才扫描** | 每分钟醒来，但只做时间比对。没有新收盘的 K 线 → **零请求** |
| **K 线缓存** | 同一根 K 线期间重复检查不会重新下载历史 |
| **快慢分离** | 清单更新（6 小时）与行情监控节奏分开，不互相牵动 |
| **并发上限** | 逐批处理，避免一次打出上百个请求 |

### 共用引擎（架构保证）

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

两种模式**唯一区别**是“什么触发分析”与“是否主动发送”。
底层的市场判读**完全一致**——而且这件事有可执行的验收在把关（见下方）。

---

## 通知语言（三选一）

| 代码 | 语言 |
|---|---|
| `en` | 英文（**默认**） |
| `zh-TW` | 繁体中文 |
| `zh-CN` | 简体中文 |

**默认是英文**——这是公开项目，主要读者为国际用户。要改成中文，改配置或直接用 Telegram 指令。

```yaml
notifications:
  language: en       # 改為 zh-TW 或 zh-CN
```

环境变量覆盖（接受常见别名如 `zh_Hant`、`cn`、`en-US`）：

```bash
NOTIFICATION_LANGUAGE=zh-CN npx tsx artifacts/api-server/src/scripts/live-snapshot.ts --send
```

ICT 缩写（BSL／SSL／SWEPT／BROKEN）**在所有语言都保留英文**，方便对照 TradingView 与教材。

### 三种配置方式，优先级如下

| 优先 | 方式 | 适用 |
|---|---|---|
| 1（最高） | 环境变量 `NOTIFICATION_LANGUAGE` | 部署层级，管理员指定 |
| 2 | Telegram 指令 `/language zh-CN` | 用户即时切换，**不需重启** |
| 3 | `config.yaml` 的 `notifications.language` | 安装默认值（出厂为 `en` 英文） |

用户用指令切换时，配置会存入本机数据库（不是改 config.yaml——那个文件在容器里可能是只读的，而且改写会破坏你的注释）。

⚠️ 如果环境变量已经把语言钉住，用 `/language` 切换会被覆盖——这时机器人会**明白告诉你**“已记录，但环境变量优先级更高”，而不是假装成功。

### 覆盖范围：所有你看得到的文字

语言配置覆盖**全部**用户可见文字，不只是通知内容：

| 类别 | 是否跟随语言 |
|---|---|
| 流动性通知（接近／扫过／突破） | ✅ |
| `/scan` 的扫描摘要回报 | ✅ |
| `/help`、`/mode`、`/status`、`/language` 的响应 | ✅ |
| 启动消息、错误提示 | ✅ |
| ICT 缩写（BSL／SSL／SWEPT／BROKEN） | ➖ 固定英文（对照图表用） |

这一项有测试把关：切换语言后，上述每一类都必须实际改变，而且英文文案不得残留中文字符。

---

## 与上游项目的关系（血缘声明）

本项目基于 **[Ntloso Ngubeni](https://github.com/GdotAiM) 的
[SMC-Liquidity-Hunter](https://github.com/GdotAiM/SMC-Liquidity-Hunter)**（MIT License, © 2026）。

上游提供了一个设计良好的 SMC 分析引擎（结构、订单块、FVG、流动性、PD Array、SMT 等
共 8 个模块、302 项单元测试）。**本项目没有重写这套引擎**，而是在它之上补上
数据源、标的筛选、事件生命周期、持久化与查询接口。

| | 上游 | 本项目 |
|---|---|---|
| 用途 | 单一币种的网页分析仪表盘 | 跨全市场监控（被动查询／主动监控） |
| 数据源 | Binance US 现货 + Yahoo Finance fallback | Binance 全球 USDT-M 永续 |
| 标的清单 | 代码中硬编码 | 按流动性指标自动生成 |
| 流动性状态 | `wasSwept: true / false` | 七种状态 + ATR 容差 |
| 记忆 | 无（每次重算） | SQLite 账本，跨重启保留 |
| 通知 | 无 | Telegram —— PASSIVE 模式为随查随回，ACTIVE 模式为状态转变主动推送 |
| 网页仪表盘 | 有 | **维持原状，本项目不使用** |

---

## 我实现了什么

### 1. 数据源修正（最根本的一项）

上游同时使用 Binance **US** 现货端点与 Yahoo Finance fallback，在亚洲交易对上
几乎没有可用数据。

以 SUIUSDT 同一根 4H K 线为例：

| 来源 | 成交量 |
|---|---|
| Binance US（上游） | 24,925 |
| Binance 全球永续（本项目） | 54,594,665 |

差距 **2,190 倍**。改用全球 `fapi.binance.com` 后，该币由“查无数据”变成
499 根完整 K 线。

同时修掉一个真实缺陷：原本的 `getCandles()` 会把**尚未收盘的 K 线**一起返回，
导致 18 处调用点都用未完成的 K 线做判定。现在只返回已收盘的 K 线。

### 2. 流动性状态机

上游只有 `wasSwept: true / false`，且用精确浮点比较（`close > pool.price`）。

本项目扩展为七种状态，并引入 ATR 容差：

| 状态 | 含义 |
|---|---|
| `ACTIVE` | 尚未被触及 |
| `APPROACHING` | 接近中（仅早期提示） |
| `TOUCHED` | 已触及，但无确认 |
| `SWEPT` | 价格穿越价位，但该根**已收盘** K 线收回原侧 |
| `BROKEN` | 价格穿越价位，且该根**已收盘** K 线收在另一侧 |
| `INVALIDATED` | 已失效 |
| `PENDING_CONFIRMATION` | 未收盘 K 线的暂时状态 |

三个关键设计原则：

- **只用已收盘 K 线做最终判定**，未完成 K 线不进入最终分类
- **时间框一致性**：4H 的价位只能用已收盘的 4H K 线判定，低时间框不得覆盖
- **容差而非精确比对**：容差为 `ATR × 0.10`，经真实数据测量决定
  （BTC 的 4H ATR 约占价格 1.10%，SUI 约 2.70%——固定百分比不可行）

### 2b. 等高点／等低点（EQH / EQL）

上游把每个转折点各自算成一条水位，所以同一个价位被测试两次时，输出会出现两条几乎
重叠的线——那不是两个信息，是同一个信息被报了两遍。止损挂在**两次尝试的上方／下方**，
所以那个区域的流动性比单一转折点更厚。

本项目把同价位的转折点合并成一条，并在输出中标明：

| 项目 | 规则 |
|---|---|
| 判定条件 | 两个转折点价差 ≤ `ATR × 0.25`（按波动缩放，非固定百分比） |
| 水位价位 | 取**极值**（最高高点／最低低点）——止损相对于两次尝试的位置就在那里 |
| 判定起点 | 取**最后一个**转折点：形态要等市场第二次失败才成立 |
| 触及次数 | 每个成员各算一次，之后的触及再往上累加 |
| 审计 | 原始转折点的价位与时间全部保留在 `equalLevelMembers` |

两条硬规则：

- **已被取走的水位不参与配对**。如果第一个高点早就被扫掉，它的止损已经被吃掉了，
  再把它跟后面的高点配成一对，等于谎报那里有两层挂单——而且会把水位搬到插针尖端。
- **集群有界，不链式扩散**。成员一律与集群的**极值**比较，不是跟前一个成员比较，
  否则一串价格可以无限延伸成同一条水位。

> **用词**：繁体中文的 SMC 教材写“等高點／等低點”，简体中文写“等高点／等低点”。
> 两岸用词相同、只差字形，因此三语系字符串（`zh-TW` / `zh-CN` / `en`）都已对应加入。
> 其他术语则确实有差异（繁中“時框”对应简中“时间框”），翻译时请各自依照当地用法，不要互抄。

### 3. 动态标的筛选

不再硬编码清单。从全球 528 个 USDT 永续中，按实际分布校准阈值：

| 筛选条件 | 阈值 | 市场中位数 |
|---|---|---|
| 24 小时名义成交量 | ≥ $30M | $3.8M |
| 持仓量（OI） | ≥ $5M | $3.4M |
| 买卖价差 | ≤ 10 bps | 4.46 bps |
| 7 日中位成交量 | ≥ $20M | — |

结果：**528 → 58 个合格 → 58 个全部纳入**。

这些阈值是目前按 Binance USDT-M 市场实际分布校准出来的默认值，可自行调整，
不宣称对所有人都是最优值。

Universe 没有 Top 50 或任何 Top-N 上限。排名只用于显示与诊断，不能排除已通过资格的 symbol。

加入**阈值滞后机制**（Hysteresis）避免清单震荡：新 symbol 看 `entry_min`，
既有成员只有跌破明确的 `removal_min` 才移除。移除阈值目前标记为 provisional/configurable，
不是宣称最优值。

### 4. 事件去重（三层防护）

一个价位事件在短时间内可能被重复检测，本项目用三层处理：

| 层级 | 机制 | 作用 |
|---|---|---|
| 身份 | 两层 key（事件层 + 流动性层） | `APPROACHING → SWEPT` 视为同一事件，不重发 |
| 时间 | 冷却 60 分钟 / 去重窗 24 小时 | 同一币短期内只吵一次 |
| 显示 | 跨时间框聚合 | 同一价位在多个时间框各出现时，合并为一则 |

### 5. 持久化记忆

上游每次扫描都从当前窗口重新计算，**没有记忆**——已处理过的价位会被反复
当成新目标重报。

本项目使用 Node.js 内置 `node:sqlite`（无原生依赖），记录每个价位的生命周期：

- 同一价位区域（容差 0.2%）在一周内已被处理过 → 只抑制重复事件/通知
- **流动性 level 本身不因年龄过期**；未解决的 level 由结构状态维持，可超过 7 天
- 引擎看不到的未解决价位（索引漂移出扫描范围）→ **从账本还原**，且逐一重新验证
- 事件/去重记忆与 liquidity level 的有效期限是两套不同概念
- 记忆跨进程重启保留

### 5b. 历史深度与生命周期审计（实测，非推断）

移除“7 天过期”之后做了全量核对，结果发现**两个会让老价位消失的真实机制**——
都不是“7 天规则”，但效果一样。

#### 机制一：索引漂移出扫描范围

引擎找 pivot 是从窗内第 `windowSize` 根开始，因为一个转折点需要左右两侧的上下文。
K 线窗往前滚，老价位的索引就往左漂；一旦漂到起点之前，引擎就再也看不到它——
**即使那根 K 线还在窗内**。

实例：`PENGUUSDT 1H BSL 0.009333`，位于窗内第 18 根（引擎自第 20 根起），20 天前形成。

#### 机制二：分数排名竞争落败

引擎只返回“分数前 20 名”，而分数含年龄衰减（1H 半衰期 200 根 ≈ 8 天）。
老价位会在排名中被挤掉；已取走的价位还带 1.5 倍加成，会占走活跃价位的位置。

实例：`BTWUSDT 1H BSL 0.38129`，18 天前形成，有效且未穿越，却排不进前 20 名。

#### 修正

| 机制 | 做法 |
|---|---|
| 分数竞争 | 输出选择改为：**未解决的全部保留**，已取走的补满剩余名额；刚成交的事件也保证保留 |
| 索引漂移 | **从账本还原**，且每一笔都用引擎自己的分类器重新验证才采用 |

还原不是无条件相信账本。账本记的是“已知状态”，分不出“还活着”与“已被取代”，
所以每一笔候选都要重新核对：价格真的穿越了就当历史、被更极端 pivot 取代了就排除、
账本价位与该根 K 线极值不符就不采用——**这三种都不还原**。

还原的价位走**完全相同**的处理路径（快照、账本、同区域抑制、事件判定、接近判定），
没有旁路。

#### 窗深

| 时间框 | 每次加载 | 等效窗深 |
|---|---|---|
| 1H | 500 根 | 20.8 天 |
| 4H | 500 根 | 83.3 天 |

#### 修正后的全量核对（45 币 × 1H／4H）

| 项目 | 数字 |
|---|---|
| 账本未解决价位 | 457 |
| 引擎直接返回 | 1,417 |
| 账本补回 | 1 |
| **扫描仍看不到** | **26** |

那 26 笔的原因**全部**是“已被更极端 pivot 取代”——既有结构失效规则，正确行为。

| 原因 | 笔数 | 判定 |
|---|---|---|
| 已被更极端 pivot 取代 | 26 | ✅ 正确 |
| 已穿越但事件未入账（真漏报） | **0** | ✅ |
| 形成时间落在窗外 | **0** | ✅ |
| 账本价位与 K 线极值不符 | **0** | ✅ |

`candle-depth.test.ts` 守住窗深：`SCAN_CANDLE_LIMIT` 调小到覆盖不足 7 天就会测试失败。

复现：

```bash
# 逐幣核對（使用正式還原路徑，不重複實作）
npx tsx artifacts/api-server/src/scripts/measure-level-coverage.ts BTCUSDT,ETHUSDT 1h,4h

# 單一價位：引擎看不看得到、帳本有沒有補回、沒補回的原因
npx tsx artifacts/api-server/src/scripts/explain-missing-level.ts BTCUSDT 1h 81181.8
```

### 6. 被动式查询接口

**设计前提：系统不主动推送。** 只在用户下指令时扫描并回报。

| 指令 | 作用 |
|---|---|
| `/scan` | 扫描全部跟踪标的 |
| `/scan BTCUSDT` | 只扫描单一标的 |
| `/scan BTCUSDT 1h` | 只扫描单一标的的单一时间框 |
| `/events` | 查看当前状况（不重新扫描） |
| `/status` | 系统状态与配置值 |
| `/mode` | 查询监控模式（PASSIVE／ACTIVE） |
| `/language` | 查询通知语言 |
| `/language zh-CN` | 切换通知语言（**立即生效，不需重启**） |
| `/help` | 指令说明 |

机器人只响应已授权的聊天室，其他来源一律忽略；非指令的文字不会触发任何扫描。

---

## 市场状态 — 突破是站住了，还是失败了？

`SWEPT` 与 `BROKEN` 描述的是**单根**已收 K 棒：价格有没有穿越这个价位、这根收在哪一侧。那是事实，而且它刻意对后续发展保持沉默 —— 一个价位一旦 `BROKEN` 就永远是 `BROKEN`，因为扫描遇到第一次被取走就停住了。

于是真正该回答的问题被留下来没答：买方流动性被取走之后，市场是**接受**了突破，还是突破**失败**、开始累积反向的条件？

`lib/smc/market-state.ts` 只回答这件事，不多答。三层刻意分开：

| 层 | 回答什么 | 用词 |
|---|---|---|
| 事实 | 价格做了什么 | `SWEPT` `BROKEN` `TOUCHED` |
| 状态 | 这件事留下什么 | `BREAKOUT_ACCEPTED` `BREAKOUT_FAILURE_WATCH` `REVERSAL_CONFIRMED`（SSL 为镜像） |
| 判读 | 人可以据此推论什么 | `SHORT` `BLOCKED` `WATCH` `ARMED` `READY` |

单币查询会同时显示三层。**状态代码（token）不翻译** —— 那是引擎的词汇，在 log、JSON 与各语言之间必须读起来完全一致；只有标签本地化。

这一层**不会**做的事：

- **不会把“被扫”当成反转。** `SWEPT` 的价位从来没有收盘站到对侧，没有突破可以“接受”或“失败”。
- **不会把影线当成跌破。** 所有判断都来自**已收 K 棒的收盘价**。
- **不会把引擎的 `CHoCH` 当成做空确认。** `CHoCH` 只由 pivot 的顺序产生 —— 没有收盘、没有价位、没有位移 —— 所以它原封不动，另外新增一个定义严格的 confirmed MSS 并存。
- **不会把所有未填满的看跌 FVG 当信号。** 只有在 confirmed MSS **之后**形成、且尚未失效的区块才算数。
- **不下单。** 本项目没有任何下单路径。

### 两段式扫描（漏斗）

深入判断需要结构、缺口与订单块；而这些只有在**已经有东西被取走**之后才有意义。所以扫描第一段跑全市场，第二段只跑近期真的被取走的地方：

```
第一段  全部幣 × 全部時框   analyzeLiquidity()                便宜
閘門    hasRecentTake()      最近 24 根內有價位被取走
第二段  只跑通過者          結構 + FVG + OB + 狀態層          貴
```

这个窗口不是随便定的。突破的“接受”需要 K 棒累积：如果在被取走之后只隔一根就判断，每个价位都只可能是“刚被扫过”，`BREAKOUT_ACCEPTED` 根本不可能被观察到。

默认开启。`config.yaml → market_state.enabled: false` 可完全退回先前行为。

---

## 快速开始

### 需求

- Node.js 25+（需使用内置 `node:sqlite`）
- pnpm

### 安装

```bash
git clone <this-repo>
cd smc_monitor/upstream
pnpm install
```

### 配置

复制 `.env.example` 为 `.env`：

```bash
TELEGRAM_BOT_TOKEN=<你的 bot token>
TELEGRAM_CHAT_ID=<你的聊天室 id>
```

`config.yaml` 集中所有可调参数（时间框、阈值、冷却、容差），修改后不需改代码。

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

### 测试

**986 项断言通过、0 项失败**，覆盖全部 21 个测试文件：

```bash
for f in $(find artifacts/api-server/src -name "*.test.ts" | sort); do npx tsx "$f"; done
```

较大的几组，方便抽查：

```bash
npx tsx artifacts/api-server/src/lib/smc/market-state.test.ts             # 65
npx tsx artifacts/api-server/src/lib/smc/liquidity-interaction.test.ts    # 31
npx tsx artifacts/api-server/src/lib/smc/order-blocks.test.ts            # 100
npx tsx artifacts/api-server/src/lib/notify/formatters.test.ts            # 84
npx tsx artifacts/api-server/src/lib/persistence/liquidity-store.test.ts  # 43
npx tsx artifacts/api-server/src/scripts/telegram-bot.test.ts             # 22
```

> 本节先前写“全部测试：486 项（本项目新增 185 项 + 上游引擎 302 项）”。那个数字
> 与实际套件不符，拆分也无法复现。上面的数字是**实测**结果，且每次新增测试都要重新
> 量——所以这里把指令写出来，而不是要读者相信一个总数。

另外：CI 只跑 typecheck 与 build，**从未跑过这套测试**。这是真实的缺口，写出来而不是
含糊带过。

---

## 配置参数

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

## 验收结果

两项独立验收，都不依赖项目自己的测试套件。

### 一、跨交易所逐根比对（Bybit 为独立来源）

| 标的 | 比对 K 线 | 中位价差 | 90% 分位 | 最大 |
|---|---|---|---|---|
| BTCUSDT 1H | 199 根 | 0.012% | 0.033% | 0.128% |
| TRXUSDT 1H | 199 根 | 0.044% | 0.065% | 0.304% |
| SUIUSDT 1H | 199 根 | 0.050% | 0.089% | 0.317% |

比对的是**价差分布**而非要求完全相同——两个交易所本来就有合理 basis。
价差大小与流动性成反比（BTC 最小、冷门币稍大），符合市场结构，无异常值。

复现：`npx tsx artifacts/api-server/src/scripts/verify-vs-external.ts BTCUSDT 1h`

### 二、引擎判定独立重算

以另一套独立实现，从原始 K 线重新推算 pivot 与 SWEPT / BROKEN，再与引擎输出比对。

| 标的 | 验算价位数 | 一致 |
|---|---|---|
| BTCUSDT 1H | 17 | 100% |
| ETHUSDT 1H | 17 | 100% |
| SUIUSDT 1H | 16 | 100% |
| XLMUSDT 1H | 15 | 100% |
| TRXUSDT 4H | 15 | 100% |
| BTCUSDT 4H | 18 | 100% |
| ENAUSDT 4H | 16 | 100% |
| DOGEUSDT 4H | 20 | 100% |
| **合计** | **134** | **100%** |

不只状态一致，**连判定发生的那根 K 线时间也逐条相同**。

复现：`npx tsx artifacts/api-server/src/scripts/verify-engine-manual.ts BTCUSDT 1h`

### 三、模式一致性验收（PASSIVE ≡ ACTIVE）

架构上要求两种模式共用同一套引擎。这不是靠自律，而是靠一支可执行的检查把关：

| 层次 | 检查内容 | 结果 |
|---|---|---|
| **静态** | 两个入口文件都不得直接引用 SMC 引擎或选币逻辑 | ✅ 都只调用共用的 `runScan()` |
| **行为** | 相同输入下，两条路径的判定必须逐字相同 | ✅ 4 笔判定完全一致 |
| **安全** | PASSIVE 模式下启动 ACTIVE 监控必须被拒绝 | ✅ 拒绝且不会开始监控 |

行为比对的实测输出（左为 PASSIVE、右为 ACTIVE，内容逐字相同）：

```
⊘ DOGEUSDT 1H SSL 0.07828 — 同區域 0.07842 已於 2026/09/17 01:00 SWEPT
⊘ TRXUSDT 1H SSL 0.33325 — 同區域 0.33317 已於 2026/09/16 02:00 BROKEN
⊘ TRXUSDT 1H SSL 0.33688 — 同區域 0.33724 已於 2026/09/15 08:00 SWEPT
⊘ XLMUSDT 1H SSL 0.17225 — 同區域 0.17253 已於 2026/09/17 01:00 SWEPT
```

复现：`npx tsx artifacts/api-server/src/scripts/verify-mode-parity.ts`

---

### 为什么不是 TradingView

TradingView 的图表为 canvas 渲染、数据动态加载，无法逐根抓取数值，
因此改以上述两项**可复现的数值比对**取代视觉比对——这比看图更严格，
因为它验证数字而非图形，且任何人都能重跑。

---

## 已知限制（诚实说明）

| 限制 | 说明 |
|---|---|
| TradingView 无法自动化比对 | TradingView 图表为 canvas 渲染、数据动态加载，无法逐根抓取。改以两项等效且更严格的自动验收取代（见下表） |
| 网页仪表盘保持上游原状 | 未修改、未验证，本项目不使用；其 WebSocket 流式路径也不在本项目使用范围内 |
| 后台监控为明示选用 | **PASSIVE 是默认**，本身不持续扫描任何市场。**ACTIVE 为选用**：持续监控与主动推送，只在用户明确启用 ACTIVE 模式后才会开始 |
| 无 AI 分析集成 | 上游的 AI agent 功能未纳入本项目范围 |

## 明确不做的事（Non-Goals）

本项目**不做**以下任何一项：

- 自动交易 / 自动进场 / 自动出场
- 进场信号 / 止损 / 止盈 / 仓位大小计算
- 投资组合管理
- 交易所账号对接（**不需要任何 API key 或 secret**）

系统可在**完全没有 Binance 账号**的情况下完整运行，仅使用公开市场数据端点。

---

## 许可

MIT License，与上游相同。上游原始版权声明保留于 `LICENSE`。

原始项目：[`GdotAiM/SMC-Liquidity-Hunter`](https://github.com/GdotAiM/SMC-Liquidity-Hunter)
