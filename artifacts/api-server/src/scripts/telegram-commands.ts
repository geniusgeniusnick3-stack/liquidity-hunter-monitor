/**
 * Telegram command parsing for the Liquidity Hunter bot.
 *
 * Kept free of side effects so it can be unit-tested without starting a bot:
 * the bot is PASSIVE, so "did we correctly ignore this?" is the safety-critical
 * question, not just "did we parse the happy path?".
 */

export interface ScanRequest {
  symbol?: string;
  timeframe?: string;
}

export type Command =
  | { kind: "scan"; req: ScanRequest }
  | { kind: "events" }
  | { kind: "status" }
  | { kind: "mode" }
  | { kind: "language"; value?: string }
  | { kind: "help" }
  | { kind: "ignore" };

export function parseCommand(raw: string): Command {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "ignore" };

  const parts = text.split(/\s+/);
  // Telegram appends @botname in groups (/scan@my_bot) — strip it before matching.
  const cmd = (parts[0] ?? "").toLowerCase().replace(/@.*$/, "");

  switch (cmd) {
    case "/scan": {
      const symbol = parts[1]?.toUpperCase();
      const timeframe = parts[2]?.toLowerCase();
      return { kind: "scan", req: { symbol, timeframe } };
    }
    case "/events":
      return { kind: "events" };
    case "/status":
      return { kind: "status" };
    case "/language": {
      // /language          → report current
      // /language zh-CN    → switch
      const value = parts[1]?.trim();
      return { kind: "language", value };
    }
    case "/mode":
      // Read-only in V1: switching modes at runtime would mean starting or
      // stopping a background monitor from inside a message handler, which is
      // a lot of moving parts for the benefit. /mode reports; changing it is a
      // config edit plus restart.
      return { kind: "mode" };
    case "/help":
    case "/start":
      return { kind: "help" };
    default:
      // Anything else is ignored — a passive bot must never scan by accident.
      return { kind: "ignore" };
  }
}

/**
 * Kept only as a fallback for callers that have no language context (the test
 * suite). The bot renders help from i18n so it follows the user's language.
 */
export const HELP_FALLBACK = `【流動性獵人 — 指令】

/scan — 掃描全部（目前追蹤的幣）
/scan BTCUSDT — 只掃這個幣
/scan BTCUSDT 1h — 只掃這個幣的這個時框
/events — 看現在有什麼（不重新掃描）
/status — 系統狀態
/mode — 目前的監控模式
/language — 查詢通知語言
/language zh-TW — 切換為繁體中文
/language zh-CN — 切換為簡體中文
/language en — 切換為英文
/help — 這個說明

監控模式：
  PASSIVE（預設）— 你下指令才動作，不會主動通知
  ACTIVE — 背景持續監控，有新事件會主動通知

ACTIVE 必須由使用者明確開啟（config.yaml 或環境變數），不會自動啟動。`;
