/**
 * Telegram setup helper (REQUIREMENTS §14).
 *
 * Walks through wiring the alert channel to YOUR bot and YOUR group:
 *
 *   1. reads TELEGRAM_BOT_TOKEN from .env (or prompts for it, hidden)
 *   2. verifies it with getMe
 *   3. lists every chat the bot can currently see (via getUpdates)
 *   4. lets you pick the group, writes TELEGRAM_CHAT_ID into .env
 *   5. optionally fires a test alert
 *
 * The token is never echoed to the terminal and never logged. It is written only
 * to .env, which is gitignored.
 *
 * Usage:
 *   npx tsx artifacts/api-server/src/scripts/telegram-setup.ts          # interactive
 *   npx tsx artifacts/api-server/src/scripts/telegram-setup.ts --list    # just list chats
 *   npx tsx artifacts/api-server/src/scripts/telegram-setup.ts --set -1001234567890
 *   npx tsx artifacts/api-server/src/scripts/telegram-setup.ts --test    # send a test alert
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ENV_PATH = path.resolve(process.cwd(), ".env");
const API = "https://api.telegram.org";

interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

// ── .env handling (preserves comments and ordering) ─────────────────────────

function readEnv(): string {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`找不到 ${ENV_PATH} — 請先從 .env.example 複製一份`);
  }
  return readFileSync(ENV_PATH, "utf8");
}

function getValue(raw: string, key: string): string {
  const line = raw.split("\n").find((l) => l.trim().startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).trim();
}

/** Replace an existing KEY= line in place, or append the key if absent. */
function setValue(raw: string, key: string, value: string): string {
  const lines = raw.split("\n");
  let replaced = false;
  const out = lines.map((l) => {
    if (l.trim().startsWith(`${key}=`) && !replaced) {
      replaced = true;
      return `${key}=${value}`;
    }
    return l;
  });
  if (!replaced) out.push(`${key}=${value}`);
  return out.join("\n");
}

// ── Prompting ───────────────────────────────────────────────────────────────

function ask(query: string, options?: { hidden?: boolean }): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (options?.hidden) {
      // Echo everything except the typed characters, so the secret never lands
      // in the terminal buffer or a scrollback log.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(query)) process.stdout.write(s);
      };
    }
    rl.question(query, (answer) => {
      rl.close();
      if (options?.hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// ── Telegram API ────────────────────────────────────────────────────────────

async function tg(token: string, method: string, body?: unknown): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<{ ok: boolean; result?: unknown; description?: string }>;
}

function describeChat(c: TgChat): string {
  const label = c.title ?? [c.first_name, c.last_name].filter(Boolean).join(" ") ?? c.username ?? "(無名稱)";
  const kind =
    c.type === "group" || c.type === "supergroup" ? "群組"
      : c.type === "channel" ? "頻道"
        : c.type === "private" ? "私訊"
          : c.type;
  return `${kind}｜${label}｜id=${c.id}`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantList = args.includes("--list");
  const wantTest = args.includes("--test");
  const setIdx = args.indexOf("--set");
  const explicitChatId = setIdx >= 0 ? args[setIdx + 1] : undefined;

  let raw = readEnv();
  let token = getValue(raw, "TELEGRAM_BOT_TOKEN") || process.env.TELEGRAM_BOT_TOKEN || "";

  if (!token) {
    console.log("未在 .env 找到 TELEGRAM_BOT_TOKEN。");
    console.log("請貼上 @BotFather 給你的 token（輸入時不會顯示在螢幕上）：");
    token = await ask("token: ", { hidden: true });
    if (!token) {
      console.error("沒有 token，結束。");
      process.exit(1);
    }
    raw = setValue(raw, "TELEGRAM_BOT_TOKEN", token);
    writeFileSync(ENV_PATH, raw, { mode: 0o600 });
    console.log("✓ token 已寫入 .env（權限 600）");
  }

  // 1. Verify the token
  const me = await tg(token, "getMe");
  if (!me.ok) {
    console.error(`✗ token 驗證失敗：${me.description ?? "未知錯誤"}`);
    console.error("  請確認 token 正確，或重新向 @BotFather 取得。");
    process.exit(1);
  }
  const bot = me.result as { username?: string; first_name?: string };
  console.log(`✓ token 有效 — bot：@${bot.username}（${bot.first_name}）`);

  // 2. Find chats the bot can see
  const updates = await tg(token, "getUpdates");
  if (!updates.ok) {
    console.error(`✗ getUpdates 失敗：${updates.description ?? "未知錯誤"}`);
    process.exit(1);
  }

  const chats = new Map<number, TgChat>();
  for (const u of (updates.result as Array<Record<string, { chat?: TgChat }>>) ?? []) {
    const evt = u.message ?? u.channel_post ?? u.my_chat_member ?? u.edited_message;
    if (evt?.chat) chats.set(evt.chat.id, evt.chat);
  }

  if (chats.size === 0) {
    console.log("");
    console.log("⚠️ 目前看不到任何對話。請依序完成：");
    console.log("   1. 在 Telegram 建立（或選擇）一個群組");
    console.log(`   2. 把 @${bot.username} 加入該群組`);
    console.log("   3. 在群組裡隨便發一句話（例如：hi）");
    console.log("   4. 重新執行這支腳本");
    if (wantList) process.exit(0);
    process.exit(1);
  }

  console.log("");
  console.log("=== bot 目前看得到的對話 ===");
  const list = [...chats.values()];
  list.forEach((c, i) => console.log(`  [${i + 1}] ${describeChat(c)}`));

  // 3. Resolve the target chat id
  let chatId = explicitChatId ?? getValue(raw, "TELEGRAM_CHAT_ID");

  if (!chatId && !wantList) {
    const groups = list.filter((c) => c.type === "group" || c.type === "supergroup");
    if (groups.length === 1 && list.length === 1) {
      chatId = String(groups[0].id);
      console.log("");
      console.log(`只找到一個群組，自動選用：${describeChat(groups[0])}`);
    } else {
      console.log("");
      const answer = await ask(`要發到哪一個？輸入編號（1-${list.length}）或直接貼 chat id：`);
      const idx = Number(answer);
      chatId = Number.isInteger(idx) && idx >= 1 && idx <= list.length
        ? String(list[idx - 1].id)
        : answer;
    }
  }

  if (chatId && !wantList) {
    raw = readEnv();
    raw = setValue(raw, "TELEGRAM_CHAT_ID", chatId);
    writeFileSync(ENV_PATH, raw, { mode: 0o600 });
    const target = list.find((c) => String(c.id) === String(chatId));
    console.log(`✓ TELEGRAM_CHAT_ID 已寫入 .env → ${chatId}${target ? `（${describeChat(target)}）` : ""}`);
  }

  if (wantList) {
    process.exit(0);
  }

  // 4. Optional test alert
  const resolved = chatId ? String(chatId) : getValue(raw, "TELEGRAM_CHAT_ID");
  if (resolved) {
    const doTest = wantTest || (await ask("要現在發一則測試訊息嗎？(y/N): ")).toLowerCase().startsWith("y");
    if (doTest) {
      const sent = await tg(token, "sendMessage", {
        chat_id: resolved,
        text: "Liquidity Hunter 測試訊息\n\n如果你看到這則，通知管道已設定完成。",
        disable_web_page_preview: true,
      });
      if (sent.ok) console.log("✓ 測試訊息已送出，請檢查那個群組");
      else console.error(`✗ 發送失敗：${sent.description ?? "未知錯誤"}\n  （若 bot 剛加入群組，請確認它有發言權限）`);
    }
  }

  console.log("");
  console.log("完成。之後系統會用這組 token 發送到這個對話。");
  console.log("提醒：.env 已被 .gitignore 排除，請勿把內容貼到任何對話或截圖中。");
}

main().catch((err) => {
  console.error("設定失敗：", err instanceof Error ? err.message : err);
  process.exit(1);
});
