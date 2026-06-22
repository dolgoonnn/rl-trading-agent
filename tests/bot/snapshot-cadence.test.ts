import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/data/schema';
import { shouldSnapshot, hourBucket } from '@/lib/bot/snapshot';

const HOUR_MS = 3_600_000;
// Aligned to a UTC hour boundary so bucket math is clean.
const BASE_MS = 1_704_067_200_000; // 2024-01-01T00:00:00Z

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

function freshDb(): TestDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

/**
 * Mirror of the bot's hourly checkpoint: only writes a snapshot when the UTC
 * hour bucket advances past the last recorded bucket. Returns the new bucket.
 */
function checkpoint(
  db: TestDb,
  prevBucket: number | null,
  nowMs: number,
  equity: number,
): number | null {
  const decision = shouldSnapshot(prevBucket, nowMs);
  if (!decision.snapshot) return prevBucket;
  db.insert(schema.botEquitySnapshots)
    .values({
      timestamp: nowMs,
      equity,
      peakEquity: equity,
      drawdown: 0,
      openPositions: 0,
      dailyPnl: 0,
      cumulativePnl: equity - 10_000,
    })
    .run();
  return decision.bucket;
}

describe('shouldSnapshot — pure hourly dedupe', () => {
  it('snapshots on the very first call (no prior bucket)', () => {
    const r = shouldSnapshot(null, BASE_MS);
    expect(r.snapshot).toBe(true);
    expect(r.bucket).toBe(hourBucket(BASE_MS));
  });

  it('does NOT snapshot again within the same hour bucket', () => {
    const bucket = hourBucket(BASE_MS);
    const r = shouldSnapshot(bucket, BASE_MS + 30_000); // 30s later, same hour
    expect(r.snapshot).toBe(false);
    expect(r.bucket).toBe(bucket);
  });

  it('snapshots once the bucket advances to the next hour', () => {
    const bucket = hourBucket(BASE_MS);
    const r = shouldSnapshot(bucket, BASE_MS + HOUR_MS);
    expect(r.snapshot).toBe(true);
    expect(r.bucket).toBe(bucket + 1);
  });
});

describe('hourly snapshot checkpoint (in-memory DB)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records EXACTLY 5 snapshots for 5 simulated hourly bars (one per UTC hour)', () => {
    const db = freshDb();
    let bucket: number | null = null;

    for (let h = 0; h < 5; h++) {
      vi.setSystemTime(BASE_MS + h * HOUR_MS);
      bucket = checkpoint(db, bucket, Date.now(), 10_000 + h);
    }

    const rows = db.select().from(schema.botEquitySnapshots).all();
    expect(rows).toHaveLength(5);
  });

  it('two ticks within the same hour produce only 1 snapshot', () => {
    const db = freshDb();
    let bucket: number | null = null;

    // First tick at the top of the hour
    vi.setSystemTime(BASE_MS);
    bucket = checkpoint(db, bucket, Date.now(), 10_000);

    // Second tick 30 seconds later (same hour bucket)
    vi.setSystemTime(BASE_MS + 30_000);
    bucket = checkpoint(db, bucket, Date.now(), 10_001);

    const rows = db.select().from(schema.botEquitySnapshots).all();
    expect(rows).toHaveLength(1);
    // Bucket stays on the same hour across both ticks.
    expect(bucket).toBe(hourBucket(BASE_MS));
  });

  it('does not record one-snapshot-per-30s-tick across an hour', () => {
    const db = freshDb();
    let bucket: number | null = null;

    // 120 ticks at 30s each = 1 hour of ticks. Should yield 2 snapshots
    // (hour bucket 0 at t=0, hour bucket 1 at t=3600s), NOT 120.
    for (let i = 0; i <= 120; i++) {
      vi.setSystemTime(BASE_MS + i * 30_000);
      bucket = checkpoint(db, bucket, Date.now(), 10_000);
    }

    const rows = db.select().from(schema.botEquitySnapshots).all();
    expect(rows).toHaveLength(2);
  });
});
