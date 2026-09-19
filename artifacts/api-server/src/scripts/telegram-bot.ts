#!/usr/bin/env node
/**
 * Liquidity Hunter — on-demand scanner bot.
 *
 * PASSIVE by design: this process never scans on a schedule and never pushes
 * unsolicited alerts. It only listens for commands from the authorised chat,
 * scans when asked, and replies to that one request.
 *
 * Usage in Telegram:
 *   /scan                 → scan the whole active universe
 *   /scan BTCUSDT         → scan one symbol, all timeframes
 *   /scan BTCUSDT 1h      → scan one symbol, one timeframe
 *   /events               → what is currently live (no re-scan)
 *   /status               → ledger + last scan info
 *   /help                 → command list
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Walk up until we find the repo root (the directory holding .env), so this
// does not silently break when the script moves or gains a nesting level.
function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, ".env")) || existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const ROOT = findRoot(import.meta.dirname);
const ENV_PATH = resolve(ROOT, ".env");

// ── .env loading (no dependency on dotenv) ──
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch {
    /* .env optional if vars come from the environment */
  }
  return env;
}

const fileEnv = loadEnv();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? fileEnv.TELEGRAM_BOT_TOKEN ?? "";
const AUTH_CHAT_ID = (process.env.TELEGRAM_CHAT_ID ?? fileEnv.TELEGRAM_CHAT_ID ?? "").trim();

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN 未設定（請放在 .env）");
  process.exit(1);
}
if (!AUTH_CHAT_ID) {
  console.error("TELEGRAM_CHAT_ID 未設定 — 拒絕在未知頻道監聽指令");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

interface TgResponse {
  ok?: boolean;
  result?: any;
  description?: string;
}

async function tg(method: string, body: Record<string, unknown>): Promise<TgResponse | null> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as TgResponse | null;
  if (!json?.ok) {
    console.error(`Telegram ${method} 失敗:`, JSON.stringify(json?.description ?? json));
  }
  return json;
}

async function reply(text: string): Promise<void> {
  await tg("sendMessage", {
    chat_id: AUTH_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

import { parseCommand, HELP, type Command } from "./telegram-commands.js";

async function main(): Promise<void> {
  const me = await tg("getMe", {});
  console.log(`Bot 上線：@${me?.result?.username}（只回應 chat ${AUTH_CHAT_ID}）`);
  await reply("🟢 流動性獵人被動模式已啟動。\n輸入 /help 看指令。");

  let offset = 0;
  // Long polling: a passive bot can idle forever without generating traffic.
  for (;;) {
    try {
      const res = await fetch(`${API}/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offset, timeout: 50, allowed_updates: ["message"] }),
      });
      const json = (await res.json().catch(() => null)) as TgResponse | null;
      const updates: any[] = json?.result ?? [];

      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text) continue;

        const fromChat = String(msg.chat?.id ?? "");
        if (fromChat !== AUTH_CHAT_ID) {
          console.log(`忽略非授權來源 chat=${fromChat}`);
          continue;
        }

        const parsed = parseCommand(msg.text);
        console.log(`收到指令：${msg.text} → ${parsed.kind}`);
        await handle(parsed);
      }
    } catch (err) {
      console.error("輪詢錯誤（5 秒後重試）：", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function handle(parsed: Command): Promise<void> {
  switch (parsed.kind) {
    case "help":
      await reply(HELP);
      break;
    case "events":
      // Dry run: show what is live right now without sending anything.
      await runScanner([], true);
      break;
    case "status":
      await reply(await buildStatus());
      break;
    case "mode":
      await reply(await buildModeReport());
      break;
    case "scan": {
      const args = ["--send"];
      if (parsed.req?.symbol) args.push("--symbols", parsed.req.symbol);
      if (parsed.req?.timeframe) args.push("--timeframe", parsed.req.timeframe);
      const scope = parsed.req?.symbol
        ? `${parsed.req.symbol}${parsed.req.timeframe ? " " + parsed.req.timeframe.toUpperCase() : ""}`
        : "全部追蹤幣種";
      await reply(`🔍 開始掃描 ${scope}…`);
      await runScanner(args, true);
      break;
    }
    default:
      break;
  }
}

/**
 * Runs the scanner and returns its report text so the bot can answer in chat.
 * The scanner already prints a human-readable summary — we capture stdout and
 * forward it rather than duplicating the logic here.
 */
async function buildModeReport(): Promise<string> {
  const { loadConfig } = await import(resolve(ROOT, "artifacts/api-server/src/lib/config/index.js"));
  const cfg = loadConfig();
  const mode = cfg.monitoring.mode;

  const explanation = mode === "active"
    ? "背景持續監控中，有新事件會主動通知。"
    : "只在你下指令時掃描，不會主動通知。";

  return [
    `Monitoring Mode: ${mode.toUpperCase()}`,
    "",
    explanation,
    "",
    `分析時框：${cfg.timeframes.map((t: string) => t.toUpperCase()).join("、")}`,
    `通知語言：${cfg.notifications.language}`,
    "",
    "要切換模式：修改 config.yaml 的 monitoring.mode，或設定環境變數",
    "MONITORING_MODE=active / passive，然後重啟服務。",
  ].join("\n");
}

async function buildStatus(): Promise<string> {
  const { getLiquidityStore } = await import(
    resolve(ROOT, "artifacts/api-server/src/lib/persistence/LiquidityStore.js")
  );
  const { loadConfig } = await import(resolve(ROOT, "artifacts/api-server/src/lib/config/index.js"));
  const cfg = loadConfig();
  const store = getLiquidityStore();
  const stats = store.getStats();

  return [
    "【流動性獵人 — 系統狀態】",
    "",
    `模式：被動（只在你下指令時動作）`,
    `追蹤時框：${cfg.timeframes.map((t: string) => t.toUpperCase()).join("、")}`,
    `接近門檻：${cfg.liquidity.approach_threshold_pct}%`,
    `同區域記憶：${cfg.liquidity.region_lookback_days} 天內｜容忍度 ${cfg.liquidity.region_tolerance_pct}%`,
    "",
    `帳本：${stats.levels} 筆價位（${stats.activeLevels} 筆仍有效）`,
    `事件紀錄：${stats.events} 筆`,
    "",
    "系統不會主動通知。要掃描請輸入 /scan",
  ].join("\n");
}

async function runScanner(extraArgs: string[], echoToChat = false): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise<string>((done) => {
    const child = spawn(
      "npx",
      ["tsx", resolve(ROOT, "artifacts/api-server/src/scripts/live-snapshot.ts"), ...extraArgs],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "production" } },
    );

    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });

    child.on("close", async (code) => {
      if (code !== 0) out += `\n（掃描程序退出碼 ${code}）`;
      // Trim the log noise the scanner emits for operators, not traders.
      const cleaned = out
        .split("\n")
        .filter((l) => !/^\{"level":\d+/.test(l.trim()))
        .filter((l) => !l.includes("npm warn"))
        .join("\n")
        .trim();

      if (echoToChat) {
        // Telegram caps messages at 4096 chars.
        const body = cleaned.length > 3500 ? cleaned.slice(0, 3500) + "\n…（已截斷）" : cleaned;
        await reply(`<pre>${escapeHtml(body)}</pre>`);
      }
      done(cleaned);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

main().catch((err) => {
  console.error("致命錯誤：", err);
  process.exit(1);
});
