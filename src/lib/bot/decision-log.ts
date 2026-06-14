/**
 * Decision log + skipped-signal logging — APPEND-ONLY at the app layer.
 *
 * The `decision_log` table is an immutable audit trail. Immutability is enforced
 * here by the MODULE'S API SURFACE: this file exports ONLY append/insert and read
 * helpers. There is intentionally NO exported update/delete/mutate function — a
 * code-review (and a test) asserts the export surface so the invariant can't be
 * accidentally broken later.
 *
 * Both writers take the Drizzle DB handle as an argument (dependency-injected) so
 * they work against the live on-disk DB, a forward DB, or an in-memory test DB
 * with no global coupling.
 */

import { asc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/data/schema';
import {
  decisionLog,
  skippedSignals,
  type DecisionLogRow,
  type SkippedSignalRow,
} from '@/lib/data/schema';

/** Any Drizzle better-sqlite3 DB bound to our schema (live, forward, or :memory:). */
export type BotDb = BetterSQLite3Database<typeof schema>;

// ============================================================================
// decision_log — append-only audit trail
// ============================================================================

export interface AppendDecisionLogArgs {
  /** Event type, e.g. 'weekly_review' | 'startup' | 'halt' | 'resume'. */
  type: string;
  /** Optional symbol the decision concerns. */
  symbol?: string;
  /** Optional structured payload (serialized to JSON). */
  detail?: unknown;
  /** Creation timestamp (ms). Injected for determinism; defaults to now. */
  nowMs?: number;
}

/**
 * Append a single row to `decision_log`. No update/delete counterpart exists by
 * design — the only way to change the log is to append to it.
 */
export function appendDecisionLog(db: BotDb, args: AppendDecisionLogArgs): void {
  const { type, symbol, detail, nowMs = Date.now() } = args;
  db.insert(decisionLog)
    .values({
      createdAt: nowMs,
      type,
      symbol: symbol ?? null,
      detail: detail === undefined ? null : JSON.stringify(detail),
    })
    .run();
}

/** Read all decision-log rows oldest-first (chronological). */
export function readDecisionLog(db: BotDb): DecisionLogRow[] {
  return db.select().from(decisionLog).orderBy(asc(decisionLog.id)).all();
}

// ============================================================================
// skipped_signals — every pre-trade reject
// ============================================================================

export interface LogSkippedSignalArgs {
  /** Timestamp of the skip (ms). */
  ts: number;
  /** Symbol the signal was for. */
  symbol: string;
  /** Reject reason (guard RejectReason, 'funding_filter', 'regime_suppress', …). */
  reason: string;
  /** Signal entry price, if known. */
  signalEntry?: number;
  /** Confluence score, if known. */
  score?: number;
  /** Regime tag, if known. */
  regime?: string;
  /** Optional structured payload (serialized to JSON). */
  detail?: unknown;
}

/**
 * Append a single `skipped_signals` row. Used by every reject path (pre-trade
 * guards, funding filter, no-trade band, regime suppression). Like the decision
 * log, there is no update/delete — skips are immutable facts.
 */
export function logSkippedSignal(db: BotDb, args: LogSkippedSignalArgs): void {
  const { ts, symbol, reason, signalEntry, score, regime, detail } = args;
  db.insert(skippedSignals)
    .values({
      ts,
      symbol,
      reason,
      signalEntry: signalEntry ?? null,
      score: score ?? null,
      regime: regime ?? null,
      detail: detail === undefined ? null : JSON.stringify(detail),
    })
    .run();
}

/** Read all skipped-signal rows oldest-first (chronological). */
export function readSkippedSignals(db: BotDb): SkippedSignalRow[] {
  return db.select().from(skippedSignals).orderBy(asc(skippedSignals.id)).all();
}
