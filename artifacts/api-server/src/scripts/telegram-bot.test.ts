/**
 * Tests for Telegram command parsing.
 * The bot is PASSIVE: it must ignore anything that is not a known command from
 * the authorised chat, and it must never trigger a scan by accident.
 */
import { parseCommand } from "./telegram-commands.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

console.log("指令解析");

/** Narrow to the scan variant before touching `req`. */
function scanOf(text: string) {
  const c = parseCommand(text);
  return c.kind === "scan" ? c.req : undefined;
}

ok(parseCommand("/scan").kind === "scan", "/scan → 掃描");
ok(scanOf("/scan BTCUSDT")?.symbol === "BTCUSDT", "/scan BTCUSDT → 指定幣種");
ok(scanOf("/scan btcusdt")?.symbol === "BTCUSDT", "幣種一律轉大寫");
ok(scanOf("/scan BTCUSDT 1h")?.timeframe === "1h", "/scan 幣種 時框 → 指定時框");
ok(scanOf("/scan@outsidetest_bot BTCUSDT")?.symbol === "BTCUSDT", "群組訊息帶 @bot 後綴仍可解析");
ok(parseCommand("/events").kind === "events", "/events → 看現況");
ok(parseCommand("/status").kind === "status", "/status → 系統狀態");
ok(parseCommand("/mode").kind === "mode", "/mode → 監控模式");
ok(parseCommand("/mode@outsidetest_bot").kind === "mode", "/mode 帶 @bot 後綴仍可解析");
ok(parseCommand("/help").kind === "help", "/help → 說明");
ok(parseCommand("/start").kind === "help", "/start → 說明");

// 被動的關鍵：不是指令就完全不理會，絕不觸發掃描
ok(parseCommand("你好").kind === "ignore", "普通文字 → 忽略（不觸發掃描）");
ok(parseCommand("").kind === "ignore", "空訊息 → 忽略");
ok(parseCommand("/unknown").kind === "ignore", "未知指令 → 忽略");
ok(parseCommand("scan").kind === "ignore", "沒有斜線 → 忽略");
ok(parseCommand("/scanner").kind === "ignore", "相似但不同的指令 → 忽略");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
