import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/data/schema';

/**
 * Re-audit finding: recordSnapshot() at startup/shutdown/trade-close bypassed
 * the per-tick hourly dedup, so the DB had up to 23 snapshots in one UTC hour —
 * which skews any Sharpe-from-snapshots / DSR computed downstream. The fix makes
 * recordSnapshot idempotent per UTC hour at the source (at most one row/hour,
 * latest equity wins), so every caller — incl. PM2 autorestarts — is deduped.
 */
const HOUR_MS = 3_600_000;
const DAY0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);
const at = (hour: number, minute = 0): number => DAY0 + hour * HOUR_MS + minute * 60_000;

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('@/lib/data/db', () => ({
  get db() { return testDb; },
  get schema() { return schema; },
}));

import { PositionTracker } from '@/lib/bot/position-tracker';

function freshDb(): TestDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

const snaps = () => testDb.select().from(schema.botEquitySnapshots).all();

describe('recordSnapshot — idempotent per UTC hour', () => {
  beforeEach(() => { testDb = freshDb(); });

  it('writes at most ONE snapshot per UTC hour across many calls', () => {
    const t = new PositionTracker(10_000);
    t.recordSnapshot({}, at(10, 0));   // startup
    t.recordSnapshot({}, at(10, 5));   // tick
    t.recordSnapshot({}, at(10, 30));  // trade-close
    t.recordSnapshot({}, at(10, 59));  // shutdown
    expect(snaps().length).toBe(1);
  });

  it('latest call in the hour wins (overwrite, not append)', () => {
    const t = new PositionTracker(10_000);
    t.recordSnapshot({}, at(10, 0));
    t.recordSnapshot({}, at(10, 30));
    const rows = snaps();
    expect(rows.length).toBe(1);
    expect(rows[0]!.timestamp).toBe(at(10, 30));
  });

  it('records a NEW snapshot when the UTC hour advances', () => {
    const t = new PositionTracker(10_000);
    t.recordSnapshot({}, at(10, 0));
    t.recordSnapshot({}, at(11, 0));
    t.recordSnapshot({}, at(12, 30));
    expect(snaps().length).toBe(3);
  });

  it('REGRESSION: 23 calls in one hour => 1 row (was 23 — the audit bug)', () => {
    const t = new PositionTracker(10_000);
    for (let m = 0; m < 23; m++) t.recordSnapshot({}, at(14, m));
    expect(snaps().length).toBe(1);
  });
});
