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

/**
 * Current language, resolved the same way scans resolve it.
 *
 * Read per reply rather than cached at boot so a /language change is reflected
 * immediately in the bot's own messages, not only in the alerts it forwards.
 */
function currentLanguage(): Language {
  const store = getLiquidityStore();
  return resolveLanguage(
    loadConfig().notifications.language,
    () => store.getState<string>(LANGUAGE_OVERRIDE_KEY),
  ).language;
}

/** Interface strings for the language currently in effect. */
function ui() {
  return uiFor(currentLanguage());
}

async function reply(text: string): Promise<void> {
  await tg("sendMessage", {
    chat_id: AUTH_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

import { parseCommand, type Command } from "./telegram-commands.js";
import {
  resolveLanguage,
  normaliseLanguage,
  LANGUAGE_OVERRIDE_KEY,
  SUPPORTED_LANGUAGES,
  uiFor,
  type Language,
} from "../lib/notify/i18n.js";
import { getLiquidityStore } from "../lib/persistence/LiquidityStore.js";
import { loadConfig } from "../lib/config/index.js";

async function main(): Promise<void> {
  const me = await tg("getMe", {});
  console.log(`Bot 上線：@${me?.result?.username}（只回應 chat ${AUTH_CHAT_ID}）`);
  await reply(ui().botStarted);

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
      await reply(ui().helpText);
      break;
    case "events":
      // Show what is live right now without sending anything.
      await runScanner({ send: false, echoToChat: true });
      break;
    case "status":
      await reply(await buildStatus());
      break;
    case "mode":
      await reply(await buildModeReport());
      break;
    case "language":
      await reply(await handleLanguage(parsed.value));
      break;
    case "scan": {
      const scope = parsed.req?.symbol
        ? `${parsed.req.symbol}${parsed.req.timeframe ? " " + parsed.req.timeframe.toUpperCase() : ""}`
        : ui().replyScopeAll;
      await reply(ui().scanning(scope));
      await runScanner({
        symbols: parsed.req?.symbol ? [parsed.req.symbol] : undefined,
        timeframe: parsed.req?.timeframe,
        send: true,
        echoToChat: true,
      });
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
/**
 * Report or change the alert language.
 *
 * A change is written to the key-value store rather than to config.yaml: the
 * file may be read-only in a container, and rewriting YAML from a chat command
 * would reformat the operator's comments. Precedence is env var > this setting >
 * config default (see resolveLanguage), so a deployment that pins
 * NOTIFICATION_LANGUAGE still wins — and we say so, instead of appearing to
 * accept a change that will not take effect.
 */
async function handleLanguage(value?: string): Promise<string> {
  const cfg = loadConfig();
  const store = getLiquidityStore();

  const label: Record<Language, string> = {
    "zh-TW": "繁體中文",
    "zh-CN": "简体中文",
    en: "English",
  };

  const t = ui();

  if (!value) {
    const { language, source } = resolveLanguage(
      cfg.notifications.language,
      () => store.getState<string>(LANGUAGE_OVERRIDE_KEY),
    );
    const origin = source === "env"
      ? t.languageOriginEnv
      : source === "user"
        ? t.languageOriginUser
        : t.languageOriginConfig;

    return [
      t.languageLine(language, label[language]),
      "",
      `${origin}。`,
      "",
      t.switchWays,
    ].join("\n");
  }

  const normalised = normaliseLanguage(value);
  if (!normalised) {
    return t.unknownLanguage(value, SUPPORTED_LANGUAGES.join("、"));
  }

  store.putState(LANGUAGE_OVERRIDE_KEY, normalised);

  // If the environment pins the language, say so plainly rather than reporting a
  // change the user will not actually see.
  const envPinned = normaliseLanguage(process.env.NOTIFICATION_LANGUAGE ?? "");
  if (envPinned && envPinned !== normalised) {
    return t.languagePinned(normalised, envPinned);
  }

  // Reply in the NEW language — the user just asked for it, so answering in the
  // old one is the exact confusion this command exists to remove.
  return uiFor(normalised).languageSwitched(normalised, label[normalised]);
}

async function buildModeReport(): Promise<string> {
  const cfg = loadConfig();
  const t = ui();
  const mode = cfg.monitoring.mode;

  return [
    `Monitoring Mode: ${mode.toUpperCase()}`,
    "",
    mode === "active" ? t.modeReportActive : t.modeReportPassive,
    "",
    `${t.analysisTimeframes}：${cfg.timeframes.map((x: string) => x.toUpperCase()).join("、")}`,
    `${t.alertLanguage}：${currentLanguage()}`,
    "",
    t.modeSwitchHow,
  ].join("\n");
}

async function buildStatus(): Promise<string> {
  const cfg = loadConfig();
  const store = getLiquidityStore();
  const stats = store.getStats();

  const t = ui();
  const mode = cfg.monitoring.mode;

  return [
    `Monitoring Mode: ${mode.toUpperCase()}`,
    "",
    `${t.analysisTimeframes}：${cfg.timeframes.map((x: string) => x.toUpperCase()).join("、")}`,
    `${t.alertLanguage}：${currentLanguage()}`,
    "",
    `${t.trackedSymbols(stats.levels)}`,
    "",
    mode === "active" ? t.modeReportActive : t.modeReportPassive,
  ].join("\n");
}

/**
 * Run a scan and answer in chat.
 *
 * Calls the shared engine in-process rather than spawning the CLI and scraping
 * its stdout. An earlier version did the latter and forwarded the CLI's operator
 * summary verbatim, which meant users received internal chatter — dedup-state
 * counters, a Node.js experimental-feature warning, a line reading "Sent 0" —
 * wrapped around the one sentence they actually needed.
 *
 * The reply is now built by formatScanReply from the structured result, so the
 * chat answer and the operator log are separate concerns.
 */
async function runScanner(
  opts: { symbols?: string[]; timeframe?: string; send: boolean; echoToChat?: boolean },
): Promise<string> {
  const { runScan } = await import("../lib/scan/ScanEngine.js");
  const { formatScanReply } = await import("../lib/notify/formatters.js");
  const { telegramNotifier } = await import("../lib/notify/TelegramNotifier.js");

  const t = ui();

  const result = await runScan({
    symbols: opts.symbols,
    timeframes: opts.timeframe ? [opts.timeframe] : undefined,
    // Operator detail goes to the service log, never to the chat.
    onLog: (m) => console.log(`[scan] ${m}`),
  });

  if (opts.send) {
    for (const alert of result.pending) {
      await telegramNotifier.send(alert.text);
    }
  }

  const scope = opts.symbols?.length
    ? `${opts.symbols.join(", ")}${opts.timeframe ? " " + opts.timeframe.toUpperCase() : ""}`
    : t.replyScopeAll;

  const text = formatScanReply({
    scope,
    events: result.events,
    approaches: result.approaches,
    historySkipped: result.historySkipped,
    symbolCount: result.symbolCount,
    latestCandleTime: result.latestCandleTime,
    scanned: result.scanned,
    failures: result.failures,
  }, result.language);

  if (opts.echoToChat) {
    // Plain text, not a code block: this is a sentence for a person, not output.
    await reply(text);
  }
  return text;
}

main().catch((err) => {
  console.error("致命錯誤：", err);
  process.exit(1);
});
