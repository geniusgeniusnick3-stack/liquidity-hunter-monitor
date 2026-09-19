/**
 * Configuration loader (REQUIREMENTS §25).
 *
 * All operational thresholds live in `config.yaml`, not in source code.
 * The file is located by walking up from the working directory, so the server
 * behaves the same whether it is started from the repo root, from
 * `artifacts/api-server`, or from a Docker image with the file mounted.
 *
 * Validation is strict and fails loudly at boot: a typo'd threshold must not
 * silently disable a liquidity filter.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { logger } from "../logger.js";
import { normaliseLanguage } from "../notify/i18n.js";

// ── Schema ──────────────────────────────────────────────────────────────────

const UniverseFiltersSchema = z.object({
  min_quote_volume_24h_usd: z.number().nonnegative(),
  min_median_daily_volume_7d_usd: z.number().nonnegative(),
  min_open_interest_usd: z.number().nonnegative(),
  max_spread_bps: z.number().nonnegative(),
  min_listing_age_days: z.number().nonnegative(),
});

const MonitoringModeSchema = z.enum(["passive", "active"]);

const ConfigSchema = z.object({
  monitoring: z.object({
    mode: MonitoringModeSchema,
    active_poll_seconds: z.number().positive(),
    active_concurrency: z.number().int().positive(),
  }),
  notifications: z.object({
    language: z.enum(["zh-TW", "zh-CN", "en"]),
  }),
  universe: z.object({
    refresh_hours: z.number().positive(),
    core_symbols: z.array(z.string().min(3)),
    // Hysteresis by threshold gap, not by rank — the universe has no fixed
    // size, so there is no rank position to anchor a buffer to.
    exit_threshold_factor: z.number().positive().max(1),
    filters: UniverseFiltersSchema,
  }),
  timeframes: z.array(z.string()).min(1),
  scanner_timeframes: z.array(z.string()).min(1),
  alerts: z.object({
    approaching: z.boolean(),
    sweep: z.boolean(),
    order_block: z.boolean(),
    fvg: z.boolean(),
    bos: z.boolean(),
    choch: z.boolean(),
  }),
  liquidity: z.object({
    tolerance_atr_multiple: z.number().nonnegative(),
    region_tolerance_pct: z.number().nonnegative(),
    region_lookback_days: z.number().positive(),
  }),
  alert_thresholds: z.object({
    approaching_distance_pct: z.number().positive(),
    broken_close_buffer_bps: z.number().nonnegative(),
    dedup_window_hours: z.number().positive(),
    cooldown_minutes: z.number().nonnegative(),
  }),
  telegram: z.object({
    enabled: z.boolean(),
    parse_mode: z.string(),
  }),
  scanner: z.object({
    min_candles_required: z.number().int().positive(),
  }),
  health: z.object({
    stale_data_seconds: z.number().positive(),
    heartbeat_minutes: z.number().nonnegative(),
  }),
  logging: z.object({
    level: z.string(),
    structured: z.boolean(),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

// ── Loading ─────────────────────────────────────────────────────────────────

const MAX_WALK_UP = 4;

export function findConfigPath(): string {
  const fromEnv = process.env.CONFIG_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`CONFIG_PATH points to a missing file: ${fromEnv}`);
    return fromEnv;
  }

  let dir = process.cwd();
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const candidate = path.join(dir, "config.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `config.yaml not found in ${process.cwd()} or any of ${MAX_WALK_UP} parent directories. ` +
    `Set CONFIG_PATH to override.`,
  );
}

let cached: AppConfig | null = null;

/** Load, validate and cache the configuration. */
export function loadConfig(options?: { force?: boolean }): AppConfig {
  if (cached && !options?.force) return cached;

  const file = findConfigPath();
  const raw = readFileSync(file, "utf8");

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(raw);
  } catch (err) {
    throw new Error(`config.yaml is not valid YAML (${file}): ${err instanceof Error ? err.message : err}`);
  }

  const result = ConfigSchema.safeParse(parsedYaml);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`config.yaml failed validation (${file}):\n${issues}`);
  }

  const cfg = result.data;

  // ── Monitoring mode override ──────────────────────────────────────────────
  //
  // MONITORING_MODE lets a deployment pick a mode without editing config.yaml,
  // which matters for containers where the file is mounted read-only. An invalid
  // value is rejected loudly rather than defaulted: silently falling back to
  // PASSIVE could leave an operator believing alerts are armed when they are
  // not, and silently falling back to ACTIVE would start traffic they did not
  // ask for.
  const envMode = process.env.MONITORING_MODE?.trim().toLowerCase();
  if (envMode) {
    const parsedMode = MonitoringModeSchema.safeParse(envMode);
    if (!parsedMode.success) {
      throw new Error(
        `MONITORING_MODE must be "passive" or "active", got "${process.env.MONITORING_MODE}". ` +
        `Refusing to guess — an unknown mode would mean an unknown monitoring posture.`,
      );
    }
    if (parsedMode.data !== cfg.monitoring.mode) {
      logger.info(
        { file: cfg.monitoring.mode, env: parsedMode.data },
        "MONITORING_MODE overrides config.yaml monitoring.mode",
      );
    }
    cfg.monitoring.mode = parsedMode.data;
  }

  // ── Alert language override ──────────────────────────────────────────────
  // Accepts the usual spellings (zh_Hant, tw, cn, en-US …) because users type
  // what they think the tag is. An unrecognised value is rejected rather than
  // silently defaulted, so nobody ends up reading a language they did not pick.
  const envLang = process.env.NOTIFICATION_LANGUAGE?.trim();
  if (envLang) {
    const normalised = normaliseLanguage(envLang);
    if (!normalised) {
      throw new Error(
        `NOTIFICATION_LANGUAGE "${envLang}" is not recognised. Use zh-TW, zh-CN or en ` +
        `(aliases like zh_Hant / zh-Hans / en-US are also accepted).`,
      );
    }
    if (normalised !== cfg.notifications.language) {
      logger.info(
        { file: cfg.notifications.language, env: normalised },
        "NOTIFICATION_LANGUAGE overrides config.yaml notifications.language",
      );
    }
    cfg.notifications.language = normalised;
  }

  if (cfg.monitoring.mode === "active") {
    logger.warn(
      { pollSeconds: cfg.monitoring.active_poll_seconds, concurrency: cfg.monitoring.active_concurrency },
      "ACTIVE monitoring mode enabled — proactive alerts will be sent",
    );
  }

  cached = cfg;
  logger.info(
    {
      file,
      monitoringMode: cfg.monitoring.mode,
      exitThresholdFactor: cfg.universe.exit_threshold_factor,
      timeframes: cfg.timeframes,
    },
    "Configuration loaded",
  );
  return cfg;
}

/** Test helper — drop the cache so the next loadConfig() re-reads the file. */
export function resetConfigCache(): void {
  cached = null;
}
