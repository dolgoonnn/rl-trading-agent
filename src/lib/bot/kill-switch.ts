/**
 * Out-of-band, LATCHED, reduce-only kill switch.
 *
 * Three independent sources can trip a halt; ANY one halts:
 *   - filesystem sentinel: `data/KILL` exists,
 *   - environment: `KILL_SWITCH === '1'`,
 *   - DB: the singleton `bot_kill_switch` row (id=1) with `halted = true`.
 *
 * LATCHED: once tripped, the bot stays halted. The ONLY way to clear it is a
 * MANUAL reset (delete the file / unset the env / write `halted = false` to the
 * DB row). There is no auto-unhalt path here.
 *
 * REDUCE-ONLY: a tripped kill flag blocks NEW entries. It does NOT, and must
 * never, force-close existing open positions — those are managed/closed by the
 * normal exit path (`manageOpenPosition`). This module therefore exposes NO
 * position-closing helper by design (a test asserts the export surface).
 *
 * The decision core `readKillFlag` is PURE — it takes the three sources as
 * injected booleans/row, so every branch is unit-testable with no fs/env/Date.now
 * in the logic path. The IO wrapper `isKilled` does the fs/env/DB reads and then
 * delegates to the pure core.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/data/schema';
import { botKillSwitch } from '@/lib/data/schema';

/** Any Drizzle better-sqlite3 DB bound to our schema (live, forward, or :memory:). */
export type KillDb = BetterSQLite3Database<typeof schema>;

/** Resolved kill decision. `source` is the first source that tripped. */
export interface KillFlag {
  halted: boolean;
  source?: string;
  reason?: string;
}

/** The minimal DB-row shape `readKillFlag` needs (injected for purity). */
export interface KillDbRow {
  halted: boolean;
  source?: string | null;
  reason?: string | null;
}

/**
 * PURE latched decision from the three injected sources. Precedence (file → env
 * → db) only decides which `source` label wins when several are tripped; the
 * `halted` result is a logical OR. A DB row that is present but `halted=false`
 * does NOT trip (no auto-halt from a clear row).
 */
export function readKillFlag(sources: {
  fileExists: boolean;
  envKill: boolean;
  dbRow: KillDbRow | undefined;
}): KillFlag {
  const { fileExists, envKill, dbRow } = sources;

  if (fileExists) {
    return { halted: true, source: 'file', reason: 'data/KILL sentinel present' };
  }
  if (envKill) {
    return { halted: true, source: 'env', reason: 'KILL_SWITCH=1' };
  }
  if (dbRow?.halted) {
    return {
      halted: true,
      source: 'db',
      reason: dbRow.reason ?? 'bot_kill_switch row halted',
    };
  }
  return { halted: false };
}

/**
 * Read the singleton `bot_kill_switch` row (id=1). Returns a not-halted flag
 * when no row exists yet (fresh DB).
 */
export function getKillFlag(db: KillDb): KillFlag {
  const row = db.select().from(botKillSwitch).where(eq(botKillSwitch.id, 1)).get();
  if (!row) return { halted: false };
  return {
    halted: row.halted,
    source: row.source ?? undefined,
    reason: row.reason ?? undefined,
  };
}

/**
 * Write the singleton `bot_kill_switch` row (id=1). LATCHED at the policy layer:
 * `halted=true` trips; `halted=false` is the manual-reset path (allowed — there
 * is no auto-unhalt, only an operator/dashboard writing false here). Always the
 * SAME row id=1 — never appends.
 */
export function setKillFlag(
  db: KillDb,
  args: { halted: boolean; reason?: string; source?: string; nowMs?: number },
): void {
  const { halted, reason, source, nowMs = Date.now() } = args;
  const existing = db.select().from(botKillSwitch).where(eq(botKillSwitch.id, 1)).get();

  const values = {
    id: 1,
    halted,
    reason: reason ?? null,
    source: source ?? null,
    haltedAt: halted ? nowMs : null,
    manualReview: true,
  };

  if (existing) {
    db.update(botKillSwitch).set(values).where(eq(botKillSwitch.id, 1)).run();
  } else {
    db.insert(botKillSwitch).values(values).run();
  }
}

/** Default filesystem sentinel path: `<cwd>/data/KILL`. */
export function killSentinelPath(): string {
  return path.join(process.cwd(), 'data', 'KILL');
}

/**
 * IO wrapper: read all three real sources (fs sentinel, env, DB row) and return
 * the latched decision. Kept separate from the pure `readKillFlag` so the logic
 * stays testable. `nowMs` is accepted for interface symmetry with the rest of
 * the guard layer (the decision itself is clock-free).
 */
export function isKilled(
  db: KillDb,
  opts: { nowMs?: number } = {},
): KillFlag {
  void opts.nowMs; // clock-free decision; param kept for call-site symmetry
  const fileExists = existsSync(killSentinelPath());
  const envKill = process.env.KILL_SWITCH === '1';
  const dbRow = db.select().from(botKillSwitch).where(eq(botKillSwitch.id, 1)).get();
  return readKillFlag({
    fileExists,
    envKill,
    dbRow: dbRow
      ? { halted: dbRow.halted, source: dbRow.source, reason: dbRow.reason }
      : undefined,
  });
}
