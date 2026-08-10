/**
 * The order-flow archive must never be able to kill the trading fleet.
 *
 * 2026-08-10: the Railway volume filled and the CORE trading process died with
 * SQLITE_FULL while the container crash-looped, so Railway's edge stopped
 * routing and the whole book went dark. The cause was the order-flow collector:
 * it appends one line per second per symbol with NO retention of any kind, and
 * its own header claimed "~1-2 MB/day/symbol" when the real rate is 13.2
 * MB/day/symbol — a 7-13x underestimate that is why nobody watched it.
 *
 * That is a priority inversion: a research collector must never be able to take
 * down live trading. Two guarantees fix it —
 *   1. the archive is bounded (age AND total bytes), pruned oldest-first, and
 *   2. the collector stops writing while free space is below a reserve that is
 *      held back for the core processes.
 *
 * Pruning is scoped to the archive directory and to .ndjson files ONLY. The
 * SQLite DB and the bot state files are the live book's memory; deleting one to
 * free space would be a far worse failure than the one being fixed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneArchive, hasHeadroom, diskStatus, ensureFreeSpace } from '../../src/lib/bot/disk-guard';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Write a file and backdate it so age-based rules can be exercised. */
function seed(name: string, bytes: number, ageDays: number): void {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x'.repeat(bytes));
  const t = new Date(Date.now() - ageDays * 86_400_000);
  fs.utimesSync(p, t, t);
}

describe('pruneArchive', () => {
  it('deletes files past the age limit', () => {
    seed('BTCUSDT_old.ndjson', 1000, 30);
    seed('BTCUSDT_new.ndjson', 1000, 1);
    const r = pruneArchive(dir, { maxAgeDays: 14, maxTotalBytes: 1e9 });
    expect(r.deleted).toEqual(['BTCUSDT_old.ndjson']);
    expect(fs.existsSync(path.join(dir, 'BTCUSDT_new.ndjson'))).toBe(true);
  });

  it('enforces a total byte budget, oldest first', () => {
    seed('a.ndjson', 1000, 5);
    seed('b.ndjson', 1000, 3);
    seed('c.ndjson', 1000, 1);
    const r = pruneArchive(dir, { maxAgeDays: 365, maxTotalBytes: 2500 });
    // Only the oldest needs to go to get under budget.
    expect(r.deleted).toEqual(['a.ndjson']);
    expect(r.freedBytes).toBe(1000);
  });

  it('keeps deleting until it is actually under budget', () => {
    seed('a.ndjson', 1000, 5);
    seed('b.ndjson', 1000, 4);
    seed('c.ndjson', 1000, 1);
    const r = pruneArchive(dir, { maxAgeDays: 365, maxTotalBytes: 1200 });
    expect(r.deleted).toEqual(['a.ndjson', 'b.ndjson']);
  });

  it('NEVER touches anything that is not an archive file', () => {
    // The live book's memory lives beside the archive. Losing it to free disk
    // space would be worse than the outage this guard exists to prevent.
    fs.writeFileSync(path.join(dir, 'ict-trading.db'), 'x'.repeat(50_000));
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), 'x'.repeat(50_000));
    seed('old.ndjson', 1000, 99);
    const r = pruneArchive(dir, { maxAgeDays: 1, maxTotalBytes: 1 });
    expect(r.deleted).toEqual(['old.ndjson']);
    expect(fs.existsSync(path.join(dir, 'ict-trading.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'metals-bot-state.json'))).toBe(true);
  });

  it('is a no-op on a missing directory rather than throwing', () => {
    const r = pruneArchive(path.join(dir, 'nope'), { maxAgeDays: 1, maxTotalBytes: 1 });
    expect(r.deleted).toEqual([]);
    expect(r.freedBytes).toBe(0);
  });
});

describe('ensureFreeSpace — the recovery primitive', () => {
  it('does nothing when the target is already met', () => {
    seed('a.ndjson', 1000, 5);
    // 1 byte of free space is always available on a working disk.
    const r = ensureFreeSpace(dir, 1);
    expect(r.deleted).toEqual([]);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'a.ndjson'))).toBe(true);
  });

  it('reports honestly when it cannot reach the target', () => {
    seed('a.ndjson', 1000, 5);
    // Demanding more than the whole disk can never succeed — and must not
    // pretend otherwise, since the caller decides whether to start the fleet.
    const total = diskStatus(dir).totalBytes;
    const r = ensureFreeSpace(dir, total * 2);
    expect(r.ok).toBe(false);
  });

  it('deletes oldest-first while chasing the target', () => {
    seed('old.ndjson', 1000, 9);
    seed('new.ndjson', 1000, 1);
    const total = diskStatus(dir).totalBytes;
    const r = ensureFreeSpace(dir, total * 2); // unreachable => deletes everything
    expect(r.deleted[0]).toBe('old.ndjson');
  });

  it('still refuses to touch the live book, even chasing an impossible target', () => {
    fs.writeFileSync(path.join(dir, 'ict-trading.db'), 'x'.repeat(10_000));
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), 'x'.repeat(10_000));
    seed('a.ndjson', 1000, 5);
    const total = diskStatus(dir).totalBytes;
    ensureFreeSpace(dir, total * 2);
    expect(fs.existsSync(path.join(dir, 'ict-trading.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'metals-bot-state.json'))).toBe(true);
  });

  it('treats an unmeasurable disk as ok rather than deleting blindly', () => {
    const r = ensureFreeSpace(path.join(dir, 'missing'), 1e15);
    expect(r.ok).toBe(true);
    expect(r.deleted).toEqual([]);
  });
});

describe('hasHeadroom', () => {
  it('reports real free space for a real path', () => {
    const s = diskStatus(dir);
    expect(s.totalBytes).toBeGreaterThan(0);
    expect(s.freeBytes).toBeGreaterThan(0);
  });

  it('refuses writes once free space drops under the reserve', () => {
    const s = diskStatus(dir);
    // A reserve larger than the whole disk can never be satisfied.
    expect(hasHeadroom(dir, s.totalBytes * 2)).toBe(false);
    expect(hasHeadroom(dir, 1)).toBe(true);
  });

  it('fails OPEN on an unreadable path — a broken guard must not stop collection', () => {
    // The guard protects the fleet; if the guard itself breaks, the correct
    // behaviour is to keep collecting, not to silently halt on a bad path.
    expect(hasHeadroom(path.join(dir, 'does-not-exist'), 1024)).toBe(true);
  });
});
