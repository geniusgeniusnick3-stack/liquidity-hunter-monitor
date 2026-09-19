/**
 * Alert de-duplication and cooldown (REQUIREMENTS §17, §18).
 *
 * Two independent guards, because they solve different problems:
 *
 *   §17 de-duplication — the SAME event must not be announced twice.
 *   §18 cooldown       — price oscillating around one zone must not produce a
 *                        stream of *new* events either.
 *
 * ── Why there are TWO identity layers ──────────────────────────────────────
 *
 * §17 states the dedup key as `symbol + timeframe + event_type +
 * liquidity_level_id`. Used literally as the sole key, that defeats the other
 * half of §17 — "unless the state changes (APPROACHING → SWEPT)". APPROACHING
 * and SWEPT are different event_types, so they would hash to different keys and
 * a genuine transition would look like a brand-new event with nothing to
 * compare against.
 *
 * So identity is tracked at two levels:
 *
 *   eventKey  = symbol | timeframe | event_type | levelId   → §17 as written
 *   levelKey  = symbol | timeframe | levelId                → the liquidity level
 *
 * An event is suppressed only when the *same event key* has already announced
 * the *same state*. A state this level has never announced before is a
 * transition, and is reported as such.
 *
 * The clock is injectable so behaviour can be tested without sleeping.
 */

export interface AlertIdentity {
  symbol: string;
  timeframe: string;
  eventType: string;
  /** Stable id of the liquidity level — see liquidityLevelId(). */
  levelId: string;
  /** Event state, e.g. APPROACHING / SWEPT / BROKEN. */
  state: string;
}

export type DedupReason =
  | "new_event"
  | "state_changed"
  | "duplicate_event"
  | "cooldown_active";

export interface DedupDecision {
  send: boolean;
  reason: DedupReason;
  /** Seconds remaining when suppressed by cooldown. */
  cooldownRemainingSeconds?: number;
  /** ms since the original notification, when suppressed as a duplicate. */
  duplicateAgeMs?: number;
}

export interface DeduplicatorOptions {
  /** Same event + state re-announced within this window is suppressed (§17). */
  dedupWindowHours: number;
  /** Any alert for the same symbol is suppressed within this window (§18). */
  cooldownMinutes: number;
}

interface EventEntry {
  firstSeenAt: number;
  notifiedStates: Set<string>;
}

interface LevelEntry {
  firstSeenAt: number;
  /** `eventType:state` tokens already announced for this level. */
  states: Set<string>;
}

/**
 * Stable identifier for a liquidity level.
 *
 * Identified by WHEN it formed and at WHAT price — both immutable once the
 * pivot is confirmed. An array index would NOT be stable (it shifts as new
 * candles arrive), which would silently defeat de-duplication.
 */
export function liquidityLevelId(
  symbol: string,
  timeframe: string,
  side: string,
  formedAtSeconds: number,
  price: number,
): string {
  return `${symbol.toUpperCase()}|${timeframe}|${side}|${formedAtSeconds}|${price}`;
}

/** §17 key — identifies one event instance (per event type). */
export function alertKey(id: AlertIdentity): string {
  return `${id.symbol.toUpperCase()}|${id.timeframe}|${id.eventType}|${id.levelId}`;
}

/** Identifies the underlying liquidity level, independent of event type. */
export function levelKey(id: AlertIdentity): string {
  return `${id.symbol.toUpperCase()}|${id.timeframe}|${id.levelId}`;
}

export function stateToken(id: AlertIdentity): string {
  return `${id.eventType}:${id.state}`;
}

export class AlertDeduplicator {
  private entries = new Map<string, EventEntry>();
  private levels = new Map<string, LevelEntry>();
  private lastAlertPerSymbol = new Map<string, number>();
  private now: () => number;

  constructor(private options: DeduplicatorOptions, now: () => number = () => Date.now()) {
    this.now = now;
  }

  setOptions(options: DeduplicatorOptions): void {
    this.options = options;
  }

  /**
   * Decide whether an event should be delivered.
   * Pure — call `record()` after a successful send.
   */
  shouldSend(id: AlertIdentity): DedupDecision {
    const t = this.now();

    // ── 1. §17: the exact same event announcing the same state → never ──
    const entry = this.entries.get(alertKey(id));
    if (entry && entry.notifiedStates.has(id.state)) {
      const age = t - entry.firstSeenAt;
      if (age < this.options.dedupWindowHours * 3_600_000) {
        return { send: false, reason: "duplicate_event", duplicateAgeMs: age };
      }
    }

    // ── 2. §18: per-symbol cooldown — applies to new events AND transitions ──
    const last = this.lastAlertPerSymbol.get(id.symbol.toUpperCase());
    if (last !== undefined) {
      const cooldownMs = this.options.cooldownMinutes * 60_000;
      const elapsed = t - last;
      if (elapsed < cooldownMs) {
        return {
          send: false,
          reason: "cooldown_active",
          cooldownRemainingSeconds: Math.ceil((cooldownMs - elapsed) / 1000),
        };
      }
    }

    // ── 3. Deliver. Report whether this is genuinely new information about the
    //       level (a transition) or a first/fresh notice.
    const level = this.levels.get(levelKey(id));
    const isTransition = level !== undefined && level.states.size > 0 && !level.states.has(stateToken(id));

    return { send: true, reason: isTransition ? "state_changed" : "new_event" };
  }

  /** Record that an alert was actually delivered. */
  record(id: AlertIdentity): void {
    const t = this.now();

    const ek = alertKey(id);
    const existing = this.entries.get(ek);
    if (existing) {
      existing.notifiedStates.add(id.state);
    } else {
      this.entries.set(ek, { firstSeenAt: t, notifiedStates: new Set([id.state]) });
    }

    const lk = levelKey(id);
    const lvl = this.levels.get(lk);
    if (lvl) {
      lvl.states.add(stateToken(id));
    } else {
      this.levels.set(lk, { firstSeenAt: t, states: new Set([stateToken(id)]) });
    }

    this.lastAlertPerSymbol.set(id.symbol.toUpperCase(), t);
  }

  /** Forget a level (e.g. it was invalidated and should be re-announced if it returns). */
  forget(id: AlertIdentity): void {
    this.entries.delete(alertKey(id));
    this.levels.delete(levelKey(id));
  }

  /** Bounded memory: drop tracking data older than the dedup window. */
  prune(): number {
    const t = this.now();
    const maxAge = this.options.dedupWindowHours * 3_600_000;

    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (t - entry.firstSeenAt > maxAge) {
        this.entries.delete(key);
        removed++;
      }
    }
    for (const [key, level] of this.levels) {
      if (t - level.firstSeenAt > maxAge) {
        this.levels.delete(key);
      }
    }
    return removed;
  }

  getStats(): { trackedEvents: number; trackedLevels: number; trackedSymbols: number } {
    return {
      trackedEvents: this.entries.size,
      trackedLevels: this.levels.size,
      trackedSymbols: this.lastAlertPerSymbol.size,
    };
  }

  /** Persistence hook (REQUIREMENTS §11 — restart recovery). */
  exportState(): {
    events: Array<{ key: string; firstSeenAt: number; notifiedStates: string[] }>;
    levels: Array<{ key: string; firstSeenAt: number; states: string[] }>;
  } {
    return {
      events: [...this.entries.entries()].map(([key, e]) => ({
        key,
        firstSeenAt: e.firstSeenAt,
        notifiedStates: [...e.notifiedStates],
      })),
      levels: [...this.levels.entries()].map(([key, l]) => ({
        key,
        firstSeenAt: l.firstSeenAt,
        states: [...l.states],
      })),
    };
  }

  importState(state: ReturnType<AlertDeduplicator["exportState"]>): void {
    for (const row of state.events) {
      this.entries.set(row.key, {
        firstSeenAt: row.firstSeenAt,
        notifiedStates: new Set(row.notifiedStates),
      });
    }
    for (const row of state.levels) {
      this.levels.set(row.key, {
        firstSeenAt: row.firstSeenAt,
        states: new Set(row.states),
      });
    }
  }
}
