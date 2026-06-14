import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/data/schema';
import { botKillSwitch } from '@/lib/data/schema';
import {
  readKillFlag,
  setKillFlag,
  getKillFlag,
} from '@/lib/bot/kill-switch';

/**
 * Kill-switch is an OUT-OF-BAND, LATCHED, reduce-only halt. Three independent
 * sources can trip it: a filesystem sentinel (data/KILL), an env var
 * (KILL_SWITCH=1), and the singleton bot_kill_switch DB row. The PURE
 * `readKillFlag` resolves the latched decision from injected booleans/row so
 * every branch is unit-testable with no fs/env/Date.now in the logic path.
 */

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

function freshDb(): TestDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

describe('readKillFlag — pure latched decision from injected sources', () => {
  it('all sources clear ⇒ not halted', () => {
    const d = readKillFlag({ fileExists: false, envKill: false, dbRow: undefined });
    expect(d.halted).toBe(false);
    expect(d.source).toBeUndefined();
  });

  it('file sentinel present ⇒ halted with source "file"', () => {
    const d = readKillFlag({ fileExists: true, envKill: false, dbRow: undefined });
    expect(d.halted).toBe(true);
    expect(d.source).toBe('file');
  });

  it('env KILL_SWITCH=1 ⇒ halted with source "env"', () => {
    const d = readKillFlag({ fileExists: false, envKill: true, dbRow: undefined });
    expect(d.halted).toBe(true);
    expect(d.source).toBe('env');
  });

  it('DB row halted=true ⇒ halted with source "db" and propagates reason', () => {
    const d = readKillFlag({
      fileExists: false,
      envKill: false,
      dbRow: { halted: true, source: 'manual', reason: 'dashboard flip' },
    });
    expect(d.halted).toBe(true);
    expect(d.source).toBe('db');
    expect(d.reason).toBe('dashboard flip');
  });

  it('DB row halted=false ⇒ NOT halted (no auto-trip from a present-but-clear row)', () => {
    const d = readKillFlag({
      fileExists: false,
      envKill: false,
      dbRow: { halted: false },
    });
    expect(d.halted).toBe(false);
  });

  it('file takes precedence over a clear DB row (any source halts)', () => {
    const d = readKillFlag({
      fileExists: true,
      envKill: false,
      dbRow: { halted: false },
    });
    expect(d.halted).toBe(true);
    expect(d.source).toBe('file');
  });
});

describe('setKillFlag / getKillFlag — DB singleton row id=1, latched', () => {
  it('getKillFlag on a fresh DB returns not-halted (no row yet)', () => {
    const db = freshDb();
    const flag = getKillFlag(db);
    expect(flag.halted).toBe(false);
  });

  it('setKillFlag writes the singleton row id=1 and getKillFlag reads it back', () => {
    const db = freshDb();
    setKillFlag(db, { halted: true, reason: 'hard DD breach', source: 'retirement', nowMs: 123 });

    const flag = getKillFlag(db);
    expect(flag.halted).toBe(true);
    expect(flag.reason).toBe('hard DD breach');
    expect(flag.source).toBe('retirement');

    // It is the singleton row (id=1), not an append.
    const rows = db.select().from(botKillSwitch).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(1);
    expect(rows[0]!.haltedAt).toBe(123);
  });

  it('setKillFlag twice updates the SAME row (id=1) — no duplicate rows', () => {
    const db = freshDb();
    setKillFlag(db, { halted: true, reason: 'first', source: 'a', nowMs: 1 });
    setKillFlag(db, { halted: true, reason: 'second', source: 'b', nowMs: 2 });

    const rows = db.select().from(botKillSwitch).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('second');
  });

  it('LATCHED: write halted=true, simulate reload (new db handle, same file) ⇒ still halted', () => {
    // Use a shared in-memory DB across two drizzle handles to simulate a reload.
    const sqlite = new Database(':memory:');
    const dbA = drizzle(sqlite, { schema });
    migrate(dbA, { migrationsFolder: './drizzle' });
    setKillFlag(dbA, { halted: true, reason: 'latched', source: 'retirement', nowMs: 1 });

    // "Reload": a brand-new drizzle handle over the SAME underlying sqlite.
    const dbB = drizzle(sqlite, { schema });
    const flag = getKillFlag(dbB);
    expect(flag.halted).toBe(true);
    expect(flag.reason).toBe('latched');
  });

  it('manual reset path: writing halted=false clears the latch (the ONLY un-halt route)', () => {
    const db = freshDb();
    setKillFlag(db, { halted: true, reason: 'tripped', source: 'retirement', nowMs: 1 });
    expect(getKillFlag(db).halted).toBe(true);

    setKillFlag(db, { halted: false, reason: 'manual reset', source: 'operator', nowMs: 2 });
    expect(getKillFlag(db).halted).toBe(false);

    // Still a single row.
    const rows = db.select().from(botKillSwitch).where(eq(botKillSwitch.id, 1)).all();
    expect(rows).toHaveLength(1);
  });
});

describe('canTrade integration — kill flag blocks NEW entries (reduce-only)', () => {
  // These tests assert the contract: a tripped kill flag blocks new entries
  // regardless of equity, and is REDUCE-ONLY — the kill path must NOT force-close
  // existing open positions (closing is managed elsewhere in manageOpenPosition).

  it('DB halted=true ⇒ canTrade returns a blocking decision regardless of equity', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const { PositionTracker } = await import('@/lib/bot/position-tracker');

    const db = freshDb();
    setKillFlag(db, { halted: true, reason: 'kill', source: 'retirement', nowMs: 1 });

    const tracker = new PositionTracker(10_000); // healthy equity, zero drawdown
    const engine = new RiskEngine();

    // Inject the kill source via DI so the pure decision is testable.
    const blocker = engine.canTrade(tracker, { nowMs: 2, killFlag: getKillFlag(db) });
    expect(blocker).not.toBeNull();
    expect(blocker!.type).toBe('max_drawdown');
    expect(blocker!.reason.toLowerCase()).toContain('kill');
  });

  it('file sentinel present ⇒ canTrade blocks even with healthy equity', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const { PositionTracker } = await import('@/lib/bot/position-tracker');

    const tracker = new PositionTracker(10_000);
    const engine = new RiskEngine();

    const killFlag = readKillFlag({ fileExists: true, envKill: false, dbRow: undefined });
    const blocker = engine.canTrade(tracker, { nowMs: 2, killFlag });
    expect(blocker).not.toBeNull();
  });

  it('no kill flag ⇒ canTrade allows (returns null) with healthy equity', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const { PositionTracker } = await import('@/lib/bot/position-tracker');

    const tracker = new PositionTracker(10_000);
    const engine = new RiskEngine();

    const killFlag = readKillFlag({ fileExists: false, envKill: false, dbRow: undefined });
    const blocker = engine.canTrade(tracker, { nowMs: 2, killFlag });
    expect(blocker).toBeNull();
  });

  it('REDUCE-ONLY: the kill-switch module exports NO force-close / position-mutating helper', async () => {
    const mod = await import('@/lib/bot/kill-switch');
    const names = Object.keys(mod);
    const banned = /close|liquidate|exit|flatten|sell|cancelPosition/i;
    for (const name of names) {
      expect(name, `kill-switch must not expose a position-closing helper: ${name}`).not.toMatch(
        banned,
      );
    }
  });
});
