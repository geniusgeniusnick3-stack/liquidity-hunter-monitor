/**
 * TelegramNotifier (REQUIREMENTS §14, §15, §16).
 *
 * Deliberately dumb transport: it formats nothing and decides nothing. It takes
 * a finished message and delivers it, reporting failure instead of throwing, so
 * a Telegram outage can never take down the scanner (§20: alerting must never
 * be able to stop market monitoring).
 *
 * Credentials come from the environment only (§14, §26) — never from source.
 */
import { logger } from "../logger.js";

const API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS || 10_000);
const MAX_ATTEMPTS = Number(process.env.TELEGRAM_MAX_ATTEMPTS || 3);

export interface TelegramSendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  attempts: number;
  retryAfterSeconds?: number;
}

export interface TelegramStatus {
  configured: boolean;
  enabled: boolean;
  /** Masked chat id — full value never leaves the process. */
  chatIdHint: string | null;
  sent: number;
  failed: number;
  lastSentAt: number | null;
  lastError: string | null;
}

function maskChatId(id: string): string {
  if (id.length <= 4) return "***";
  return id.slice(0, 2) + "***" + id.slice(-2);
}

export class TelegramNotifier {
  private sent = 0;
  private failed = 0;
  private lastSentAt: number | null = null;
  private lastError: string | null = null;

  private get token(): string | undefined {
    const t = process.env.TELEGRAM_BOT_TOKEN;
    return t && t.trim().length > 0 ? t.trim() : undefined;
  }

  private get chatId(): string | undefined {
    const c = process.env.TELEGRAM_CHAT_ID;
    return c && c.trim().length > 0 ? c.trim() : undefined;
  }

  /** True when both credentials are present. Does not imply alerts are on. */
  isConfigured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  /**
   * Deliver one message.
   *
   * `enabled` comes from config (config.yaml → telegram.enabled), so the
   * notifier can be fully wired up while silenced.
   */
  async send(text: string, options?: { enabled?: boolean; parseMode?: string }): Promise<TelegramSendResult> {
    const enabled = options?.enabled ?? true;
    if (!enabled) {
      logger.debug("Telegram disabled by config — message not sent");
      return { ok: false, skipped: true, attempts: 0 };
    }

    const token = this.token;
    const chatId = this.chatId;
    if (!token || !chatId) {
      this.lastError = "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set";
      logger.warn({ hasToken: Boolean(token), hasChatId: Boolean(chatId) }, "Telegram not configured — alert dropped");
      return { ok: false, error: this.lastError, attempts: 0 };
    }

    const url = `${API_BASE}/bot${token}/sendMessage`;
    let lastErr = "unknown error";
    let retryAfterSeconds: number | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: options?.parseMode ?? "Markdown",
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        });

        const body = await res.json().catch(() => null) as
          | { ok?: boolean; description?: string; parameters?: { retry_after?: number } }
          | null;

        // ── Rate limited: honour Telegram's own retry_after (§21) ──
        if (res.status === 429) {
          retryAfterSeconds = body?.parameters?.retry_after;
          lastErr = `429 rate limited${retryAfterSeconds ? `, retry after ${retryAfterSeconds}s` : ""}`;
          this.lastError = lastErr;
          logger.warn({ attempt, retryAfterSeconds }, "Telegram rate limited");
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, Math.min((retryAfterSeconds ?? 1) * 1000, 30_000)));
            continue;
          }
          this.failed++;
          return { ok: false, error: lastErr, attempts: attempt, retryAfterSeconds };
        }

        if (!res.ok || body?.ok === false) {
          lastErr = `HTTP ${res.status}: ${body?.description ?? "no description"}`;
          this.lastError = lastErr;
          // 4xx other than 429 will not succeed on retry.
          if (res.status >= 400 && res.status < 500) {
            this.failed++;
            logger.error({ status: res.status, description: body?.description }, "Telegram send rejected");
            return { ok: false, error: lastErr, attempts: attempt };
          }
        } else {
          this.sent++;
          this.lastSentAt = Date.now();
          this.lastError = null;
          logger.info({ chars: text.length, attempt }, "Telegram alert sent");
          return { ok: true, attempts: attempt };
        }
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        this.lastError = lastErr;
        logger.warn({ attempt, err: lastErr }, "Telegram transport error");
      } finally {
        clearTimeout(timer);
      }

      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      }
    }

    this.failed++;
    return { ok: false, error: lastErr, attempts: MAX_ATTEMPTS, retryAfterSeconds };
  }

  getStatus(enabled: boolean): TelegramStatus {
    const id = this.chatId;
    return {
      configured: this.isConfigured(),
      enabled,
      chatIdHint: id ? maskChatId(id) : null,
      sent: this.sent,
      failed: this.failed,
      lastSentAt: this.lastSentAt,
      lastError: this.lastError,
    };
  }
}

export const telegramNotifier = new TelegramNotifier();
