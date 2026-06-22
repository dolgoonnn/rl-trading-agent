import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/data/schema';
import * as decisionLogModule from '@/lib/bot/decision-log';
import {
  appendDecisionLog,
  logSkippedSignal,
  readDecisionLog,
  readSkippedSignals,
} from '@/lib/bot/decision-log';

/**
 * decision_log is append-only at the APP layer: immutability is enforced by the
 * module's API surface (no exported update/delete). These tests:
 *   1. round-trip an appended row + read it chronologically,
 *   2. assert the module exports NO mutating function (update/delete/etc),
 *   3. assert appending more rows leaves earlier rows byte-for-byte unchanged.
 */

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

function freshDb(): TestDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

describe('decision-log module — append-only API surface', () => {
  it('exposes ONLY append/insert/read helpers (no update/delete/mutate)', () => {
    const exportedNames = Object.keys(decisionLogModule);

    // The intended surface.
    expect(exportedNames).toContain('appendDecisionLog');
    expect(exportedNames).toContain('logSkippedSignal');
    expect(exportedNames).toContain('readDecisionLog');
    expect(exportedNames).toContain('readSkippedSignals');

    // No mutating verb may be exported — immutability is an API guarantee.
    const banned = /update|delete|remove|patch|mutate|set|edit|drop|clear|truncate/i;
    for (const name of exportedNames) {
      expect(name, `forbidden mutator export: ${name}`).not.toMatch(banned);
    }

    // Direct typeof checks for the obvious mutator names.
    const mod = decisionLogModule as Record<string, unknown>;
    expect(typeof mod.updateDecisionLog).toBe('undefined');
    expect(typeof mod.deleteDecisionLog).toBe('undefined');
    expect(typeof mod.removeDecisionLog).toBe('undefined');
  });

  it('appendDecisionLog inserts a row that reads back', () => {
    const db = freshDb();
    appendDecisionLog(db, {
      type: 'weekly_review',
      symbol: 'BTCUSDT',
      detail: { cells: 12 },
      nowMs: 1_700_000_000_000,
    });

    const rows = readDecisionLog(db);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe('weekly_review');
    expect(r.symbol).toBe('BTCUSDT');
    expect(r.createdAt).toBe(1_700_000_000_000);
    expect(JSON.parse(r.detail!)).toEqual({ cells: 12 });
  });

  it('reads rows chronologically (oldest first)', () => {
    const db = freshDb();
    appendDecisionLog(db, { type: 'startup', nowMs: 100 });
    appendDecisionLog(db, { type: 'halt', nowMs: 200 });
    appendDecisionLog(db, { type: 'weekly_review', nowMs: 300 });

    const rows = readDecisionLog(db);
    expect(rows.map((r) => r.createdAt)).toEqual([100, 200, 300]);
    expect(rows.map((r) => r.type)).toEqual(['startup', 'halt', 'weekly_review']);
  });

  it('appending more rows preserves earlier rows unchanged', () => {
    const db = freshDb();
    appendDecisionLog(db, { type: 'startup', nowMs: 100, detail: { v: 1 } });

    const before = readDecisionLog(db);
    expect(before).toHaveLength(1);
    const firstSnapshot = { ...before[0]! };

    // Append two more rows.
    appendDecisionLog(db, { type: 'halt', nowMs: 200 });
    appendDecisionLog(db, { type: 'resume', nowMs: 300 });

    const after = readDecisionLog(db);
    expect(after).toHaveLength(3);
    // The original row must be byte-for-byte identical.
    const firstAfter = after.find((r) => r.id === firstSnapshot.id)!;
    expect(firstAfter).toEqual(firstSnapshot);
  });

  it('logSkippedSignal inserts and reads back', () => {
    const db = freshDb();
    logSkippedSignal(db, {
      ts: 1_700_000_000_000,
      symbol: 'ETHUSDT',
      reason: 'mark_deviation',
      signalEntry: 3000.5,
      score: 6.2,
      regime: 'uptrend+normal',
      detail: { bps: 73 },
    });

    const rows = readSkippedSignals(db);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.symbol).toBe('ETHUSDT');
    expect(r.reason).toBe('mark_deviation');
    expect(r.signalEntry).toBeCloseTo(3000.5);
    expect(r.score).toBeCloseTo(6.2);
    expect(JSON.parse(r.detail!)).toEqual({ bps: 73 });
  });

  it('logSkippedSignal works with only required fields (no crash)', () => {
    const db = freshDb();
    expect(() =>
      logSkippedSignal(db, { ts: 1, symbol: 'SOLUSDT', reason: 'stale_candle' }),
    ).not.toThrow();
    const rows = readSkippedSignals(db);
    expect(rows[0]!.signalEntry).toBeNull();
    expect(rows[0]!.detail).toBeNull();
  });
});
