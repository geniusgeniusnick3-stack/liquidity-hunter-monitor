/**
 * Persistent liquidity ledger (REQUIREMENTS §11, §12).
 *
 * §11 is explicit that a liquidity level must NOT disappear just because it
 * formed a long time ago: a 4H swing high from ten days back stays tracked as
 * long as the rules still consider it valid. That means levels need identity and
 * memory that outlive a single analysis run — an in-memory map loses the whole
 * history on every restart, which is exactly what the upstream project did.
 *
 * §12 defines the lifecycle:
 *
 *   ACTIVE       level exists, price is nowhere near it
 *   APPROACHING  price has come within the configured distance
 *   TOUCHED      price traded into the zone but did not commit beyond it
 *   SWEPT        wick traded beyond the level, close returned inside  ← the
 *                "liquidity grab" the operator cares about (§13)
 *   BROKEN       close beyond the level — consumed, a different event entirely
 *   INVALIDATED  structure moved on and the level no longer means anything
 *
 * SWEPT and BROKEN are deliberately distinct: §13 warns against classifying
 * every price poke through a level as a reversal signal.
 *
 * Storage is `node:sqlite` (built into Node 22+, stable in the Node 25 runtime
 * this project targets). No native dependency, so the esbuild bundle stays a
 * single file and the Docker image needs no build toolchain.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";

export type LiquidityState =
  | "ACTIVE"
  | "APPROACHING"
  | "TOUCHED"
  /** Price traded beyond the level but the owning candle has not closed yet, so
   *  SWEPT/BROKEN cannot be finalized. Never a terminal state. */
  | "PENDING_CONFIRMATION"
  | "SWEPT"
  | "BROKEN"
  | "INVALIDATED";

export type LiquiditySide = "BSL" | "SSL";
/** Local alias used in query signatures (same union, clearer intent). */
type LiabilitySideAlias = LiquiditySide;

export interface LiquidityLevel {
  /** Stable id: symbol|timeframe|side|formedAt|price — see liquidityLevelId(). */
  id: string;
  symbol: string;
  timeframe: string;
  side: LiquiditySide;
  price: number;
  /** Formation time of the pivot, in SECONDS (matches the engine's Candle.time). */
  formedAt: number;
  session: string | null;
  /** Human explanation, e.g. "Equal High + Swing High". */
  source: string | null;
  state: LiquidityState;
  stateChangedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  sweptAt: number | null;
  sweepExtreme: number | null;
  brokenAt: number | null;
  invalidatedAt: number | null;
  touches: number;
}

export interface AlertLogRow {
  eventKey: string;
  symbol: string;
  timeframe: string;
  eventType: string;
  levelId: string;
  state: string;
  sentAt: number;
  message: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS liquidity_levels (
  id               TEXT PRIMARY KEY,
  symbol           TEXT NOT NULL,
  timeframe        TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('BSL','SSL')),
  price            REAL NOT NULL,
  formed_at        INTEGER NOT NULL,
  session          TEXT,
  source           TEXT,
  state            TEXT NOT NULL,
  state_changed_at INTEGER NOT NULL,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  swept_at         INTEGER,
  sweep_extreme    REAL,
  broken_at        INTEGER,
  invalidated_at   INTEGER,
  touches          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_levels_symbol_tf ON liquidity_levels (symbol, timeframe);
CREATE INDEX IF NOT EXISTS idx_levels_state     ON liquidity_levels (state);
CREATE INDEX IF NOT EXISTS idx_levels_formed    ON liquidity_levels (formed_at);
CREATE INDEX IF NOT EXISTS idx_levels_seen      ON liquidity_levels (last_seen_at);

CREATE TABLE IF NOT EXISTS alert_log (
  event_key  TEXT PRIMARY KEY,
  symbol     TEXT NOT NULL,
  timeframe  TEXT NOT NULL,
  event_type TEXT NOT NULL,
  level_id   TEXT NOT NULL,
  state      TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  message    TEXT
);

CREATE INDEX IF NOT EXISTS idx_alert_symbol ON alert_log (symbol, sent_at);

CREATE TABLE IF NOT EXISTS kv_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT
);
`;

interface LevelDbRow {
  id: string; symbol: string; timeframe: string; side: string; price: number;
  formed_at: number; session: string | null; source: string | null;
  state: string; state_changed_at: number; first_seen_at: number; last_seen_at: number;
  swept_at: number | null; sweep_extreme: number | null; broken_at: number | null;
  invalidated_at: number | null; touches: number;
}

function fromDb(r: LevelDbRow): LiquidityLevel {
  return {
    id: r.id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    side: r.side as LiquiditySide,
    price: r.price,
    formedAt: r.formed_at,
    session: r.session,
    source: r.source,
    state: r.state as LiquidityState,
    stateChangedAt: r.state_changed_at,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    sweptAt: r.swept_at,
    sweepExtreme: r.sweep_extreme,
    brokenAt: r.broken_at,
    invalidatedAt: r.invalidated_at,
    touches: r.touches,
  };
}

export class LiquidityStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    // WAL keeps a long-running reader from blocking the scanner's writes.
    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    logger.info({ dbPath }, "Liquidity store ready");
  }

  // ── Levels ────────────────────────────────────────────────────────────────

  /**
   * Insert a level if unseen, otherwise refresh its last-seen time and touches.
   *
   * Deliberately does NOT overwrite `state`: a level that has already been swept
   * must not be reset to ACTIVE just because the engine re-detected the same
   * pivot in a fresh analysis window. State only moves forward through
   * `setState()`. This is what makes §11's persistence meaningful.
   */
  upsertLevel(level: {
    id: string; symbol: string; timeframe: string; side: LiquiditySide;
    price: number; formedAt: number; session?: string | null;
    source?: string | null; touches?: number;
  }): { inserted: boolean; level: LiquidityLevel } {
    const now = Date.now();
    const existing = this.getLevel(level.id);

    if (!existing) {
      this.db.prepare(`
        INSERT INTO liquidity_levels
          (id, symbol, timeframe, side, price, formed_at, session, source, state,
           state_changed_at, first_seen_at, last_seen_at, touches)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
      `).run(
        level.id, level.symbol, level.timeframe, level.side, level.price,
        level.formedAt, level.session ?? null, level.source ?? null,
        now, now, now, level.touches ?? 1,
      );
      const created = this.getLevel(level.id);
      if (!created) throw new Error(`failed to read back inserted level ${level.id}`);
      return { inserted: true, level: created };
    }

    this.db.prepare(`
      UPDATE liquidity_levels
         SET last_seen_at = ?, touches = ?
       WHERE id = ?
    `).run(now, Math.max(existing.touches, level.touches ?? 1), level.id);

    return { inserted: false, level: this.getLevel(level.id) ?? existing };
  }

  getLevel(id: string): LiquidityLevel | null {
    const row = this.db.prepare("SELECT * FROM liquidity_levels WHERE id = ?").get(id) as unknown as LevelDbRow | undefined;
    return row ? fromDb(row) : null;
  }

  /**
   * Move a level to a new state, recording the transition time and any event
   * detail. Returns the updated level, or null when the level is unknown.
   */
  setState(
    id: string,
    state: LiquidityState,
    detail?: { sweptAt?: number; sweepExtreme?: number; brokenAt?: number },
  ): LiquidityLevel | null {
    const existing = this.getLevel(id);
    if (!existing) return null;

    this.db.prepare(`
      UPDATE liquidity_levels
         SET state = ?,
             state_changed_at = ?,
             swept_at = COALESCE(?, swept_at),
             sweep_extreme = COALESCE(?, sweep_extreme),
             broken_at = COALESCE(?, broken_at),
             invalidated_at = CASE WHEN ? = 'INVALIDATED' THEN ? ELSE invalidated_at END
       WHERE id = ?
    `).run(
      state, Date.now(),
      detail?.sweptAt ?? null,
      detail?.sweepExtreme ?? null,
      detail?.brokenAt ?? null,
      state, Date.now(),
      id,
    );

    return this.getLevel(id);
  }

  /**
   * Levels that are still meaningful for a symbol/timeframe.
   *
   * Note the absence of a time cut-off on `formed_at`: §11 requires an old but
   * still-valid swing high to keep being reported. Only levels explicitly
   * INVALIDATED are excluded.
   */
  listLevels(symbol: string, timeframe: string, options?: { includeInvalidated?: boolean }): LiquidityLevel[] {
    const sql = options?.includeInvalidated
      ? "SELECT * FROM liquidity_levels WHERE symbol = ? AND timeframe = ? ORDER BY price"
      : "SELECT * FROM liquidity_levels WHERE symbol = ? AND timeframe = ? AND state != 'INVALIDATED' ORDER BY price";
    const rows = this.db.prepare(sql).all(symbol.toUpperCase(), timeframe) as unknown as LevelDbRow[];
    return rows.map(fromDb);
  }

  /** Nearest untaken level above / below price. */
  nearestLevels(
    symbol: string,
    timeframe: string,
    price: number,
  ): { above: LiquidityLevel | null; below: LiquidityLevel | null } {
    const levels = this.listLevels(symbol, timeframe).filter(
      (l) => l.state === "ACTIVE" || l.state === "APPROACHING" || l.state === "TOUCHED",
    );
    const above = levels
      .filter((l) => l.price > price)
      .sort((a, b) => a.price - b.price)[0] ?? null;
    const below = levels
      .filter((l) => l.price < price)
      .sort((a, b) => b.price - a.price)[0] ?? null;
    return { above, below };
  }

  /**
   * Has this price AREA already been handled?
   *
   * Finds the nearest level of the same symbol/timeframe/side that has already
   * been consumed (SWEPT or BROKEN) and lies within `tolerancePct` of `price`.
   *
   * Why this exists: the engine recomputes pivots from a rolling window, so a
   * consumed level is forgotten and an almost-identical pivot can be "discovered"
   * again days later at the same price — reported to the operator as if it were
   * fresh. Remembering consumption per AREA (not per exact tick) is what makes
   * that stop happening (REQUIREMENTS §11: persistent liquidity levels).
   *
   * Returns the previously consumed level, or null when the area is untouched.
   */
  takenNear(
    symbol: string,
    timeframe: string,
    side: LiabilitySideAlias,
    price: number,
    tolerancePct: number,
    lookbackDays: number,
  ): LiquidityLevel | null {
    const rows = this.db.prepare(`
      SELECT * FROM liquidity_levels
       WHERE symbol = ? AND timeframe = ? AND side = ?
         AND state IN ('SWEPT','BROKEN')
    `).all(symbol.toUpperCase(), timeframe, side) as unknown as LevelDbRow[];

    // Only consumption from the recent past counts. Crypto structure turns over
    // roughly weekly; treating a level handled two months ago as "the same area"
    // would suppress genuinely fresh setups. See region_lookback_days.
    const cutoff = Date.now() - lookbackDays * 86_400_000;
    const tolerance = Math.abs(price) * (tolerancePct / 100);

    let best: LiquidityLevel | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const row of rows) {
      // Judge by when the level was actually HANDLED — not when it formed, and
      // NOT `state_changed_at`, which records when this row was last written.
      // Back-filling history writes today's timestamp into state_changed_at, so
      // using it here would make a two-month-old sweep look like it happened
      // today and defeat the lookback window entirely.
      const handledAt = row.swept_at ?? row.broken_at ?? row.state_changed_at ?? 0;
      if (handledAt < cutoff) continue;

      const distance = Math.abs(row.price - price);
      if (distance <= tolerance && distance < bestDistance) {
        bestDistance = distance;
        best = fromDb(row);
      }
    }
    return best;
  }

  /** Every level ever recorded for a symbol/timeframe, for audit/UI. */
  allLevels(symbol: string, timeframe: string): LiquidityLevel[] {
    const rows = this.db.prepare(
      "SELECT * FROM liquidity_levels WHERE symbol = ? AND timeframe = ? ORDER BY formed_at",
    ).all(symbol.toUpperCase(), timeframe) as unknown as LevelDbRow[];
    return rows.map(fromDb);
  }

  // ── Alert log ─────────────────────────────────────────────────────────────

  logAlert(row: AlertLogRow): void {
    this.db.prepare(`
      INSERT INTO alert_log (event_key, symbol, timeframe, event_type, level_id, state, sent_at, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        state = excluded.state,
        sent_at = excluded.sent_at,
        message = excluded.message
    `).run(row.eventKey, row.symbol, row.timeframe, row.eventType, row.levelId, row.state, row.sentAt, row.message);
  }

  recentAlerts(limit = 50): AlertLogRow[] {
    return (this.db.prepare("SELECT * FROM alert_log ORDER BY sent_at DESC LIMIT ?").all(limit) as unknown as Array<{
      event_key: string; symbol: string; timeframe: string; event_type: string;
      level_id: string; state: string; sent_at: number; message: string | null;
    }>).map((r) => ({
      eventKey: r.event_key,
      symbol: r.symbol,
      timeframe: r.timeframe,
      eventType: r.event_type,
      levelId: r.level_id,
      state: r.state,
      sentAt: r.sent_at,
      message: r.message,
    }));
  }

  // ── Generic key/value (dedup state, universe snapshot, counters) ──────────

  putState(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
  }

  getState<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM kv_state WHERE key = ?").get(key) as unknown as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      logger.warn({ key }, "Corrupt JSON in kv_state — ignoring");
      return null;
    }
  }

  // ── Runtime events (structured log trail, §24) ────────────────────────────

  recordEvent(kind: string, detail?: unknown): void {
    this.db.prepare("INSERT INTO runtime_events (at, kind, detail) VALUES (?, ?, ?)")
      .run(Date.now(), kind, detail === undefined ? null : JSON.stringify(detail));
  }

  recentEvents(limit = 50): Array<{ at: number; kind: string; detail: string | null }> {
    return this.db.prepare("SELECT at, kind, detail FROM runtime_events ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<{ at: number; kind: string; detail: string | null }>;
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  /**
   * Retention sweep. Levels themselves are never deleted on age alone (§11);
   * only the operational trail is trimmed.
   */
  pruneRuntimeEvents(keepDays = 7): number {
    const cutoff = Date.now() - keepDays * 86_400_000;
    const res = this.db.prepare("DELETE FROM runtime_events WHERE at < ?").run(cutoff);
    return Number(res.changes ?? 0);
  }

  getStats(): { levels: number; activeLevels: number; alerts: number; events: number } {
    const one = (sql: string): number =>
      Number((this.db.prepare(sql).get() as unknown as { n: number }).n);
    return {
      levels: one("SELECT COUNT(*) AS n FROM liquidity_levels"),
      activeLevels: one("SELECT COUNT(*) AS n FROM liquidity_levels WHERE state != 'INVALIDATED'"),
      alerts: one("SELECT COUNT(*) AS n FROM alert_log"),
      events: one("SELECT COUNT(*) AS n FROM runtime_events"),
    };
  }

  close(): void {
    this.db.close();
  }
}

let instance: LiquidityStore | null = null;

/** Shared store. Path comes from SQLITE_PATH, defaulting to ./data/liquidity.db. */
export function getLiquidityStore(): LiquidityStore {
  if (!instance) {
    const dbPath = process.env.SQLITE_PATH || path.join(process.cwd(), "data", "liquidity.db");
    instance = new LiquidityStore(dbPath);
  }
  return instance;
}

export function closeLiquidityStore(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
