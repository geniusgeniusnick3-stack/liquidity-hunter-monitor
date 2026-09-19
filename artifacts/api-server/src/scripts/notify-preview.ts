/**
 * Notify preview — sends the REAL alert formats through the REAL notifier.
 *
 * Exists to prove the delivery path end-to-end (formatters → TelegramNotifier →
 * your bot → your group) rather than trusting that each piece works in
 * isolation. The numbers below are a representative sample so the message shape
 * can be reviewed before live events start arriving.
 *
 * Run: NODE_ENV=production npx tsx artifacts/api-server/src/scripts/notify-preview.ts
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { telegramNotifier } from "../lib/notify/TelegramNotifier.js";
import { formatApproaching, formatSweep } from "../lib/notify/formatters.js";
import { loadConfig } from "../lib/config/index.js";

// The project deliberately does not depend on dotenv — load .env by hand.
(function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
})();

const config = loadConfig();
const enabled = config.telegram.enabled;
const parseMode = config.telegram.parse_mode;

console.log("=== 設定檢查 ===");
console.log("  telegram.enabled   = " + enabled);
console.log("  parse_mode         = " + parseMode);
console.log("  token 已設定       = " + Boolean(process.env.TELEGRAM_BOT_TOKEN));
console.log("  chat id 已設定     = " + Boolean(process.env.TELEGRAM_CHAT_ID));
console.log("");

const messages = [
  formatApproaching({
    symbol: "SUIUSDT",
    timeframe: "4h",
    side: "BSL",
    level: 0.8342,
    zoneLow: 0.8335,
    zoneHigh: 0.8345,
    currentPrice: 0.8318,
    distancePct: 0.29,
    source: "等高等 + 波段高點",
  }),
  formatSweep({
    symbol: "SUIUSDT",
    timeframe: "4h",
    side: "BSL",
    level: 0.8342,
    extreme: 0.8358,
    close: 0.8334,
    broken: false,
  }),
  formatSweep({
    symbol: "SUIUSDT",
    timeframe: "4h",
    side: "SSL",
    level: 0.8100,
    extreme: 0.8012,
    close: 0.8045,
    broken: true,
  }),
];

let sent = 0;
let failedCount = 0;

for (const [i, msg] of messages.entries()) {
  console.log(`--- 第 ${i + 1} 則 ---`);
  console.log(msg);
  console.log("");

  const result = await telegramNotifier.send(msg, { enabled, parseMode });
  if (result.ok) {
    sent++;
    console.log(`✓ 已送出（第 ${result.attempts} 次嘗試）`);
  } else if (result.skipped) {
    console.log("⊘ 略過（config.yaml 的 telegram.enabled = false）");
  } else {
    failedCount++;
    console.error(`✗ 失敗：${result.error}`);
  }
  console.log("");
  if (i < messages.length - 1) await new Promise((r) => setTimeout(r, 400));
}

console.log("=== 結果 ===");
console.log(JSON.stringify(telegramNotifier.getStatus(enabled), null, 2));
console.log(`送出 ${sent} 則，失敗 ${failedCount} 則`);
