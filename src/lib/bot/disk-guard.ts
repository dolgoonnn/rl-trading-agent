/**
 * Keep the order-flow archive from taking down live trading.
 *
 * WHY THIS EXISTS
 * On 2026-08-10 the Railway volume filled. The CORE trading process died with
 * `SQLITE_FULL` on a routine state save, the container entered a restart loop,
 * and Railway's edge stopped routing to it — the dashboard 404'd and the whole
 * paper book went dark. Nothing was wrong with the trading code.
 *
 * The cause was `collect-btc-orderflow.ts`: it appends one NDJSON line per
 * second per symbol and had NO retention of any kind. Its own header estimated
 * "~1-2 MB/day/symbol"; the measured rate is 13.2 MB/day/symbol, so three
 * symbols write ~40 MB/day and a two-week run is ~550 MB. The estimate being
 * 7-13x low is why nobody was watching it.
 *
 * The real defect is the priority inversion: a RESEARCH collector was able to
 * kill the LIVE BOOK. This module removes that by giving the archive two hard
 * bounds — an age/size budget, and a free-space reserve held back for the core
 * processes that the collector will not write into.
 *
 * SAFETY: pruning only ever touches `.ndjson` files inside the archive
 * directory. The SQLite DB and the bot state files are the book's memory;
 * deleting one to reclaim space would be a worse failure than the outage.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Only these are ever eligible for deletion. */
const ARCHIVE_EXT = '.ndjson';

export interface DiskStatus {
  freeBytes: number;
  totalBytes: number;
  /** 0..1; NaN when the path cannot be stat'd. */
  freeRatio: number;
}

export function diskStatus(dir: string): DiskStatus {
  try {
    const s = fs.statfsSync(dir);
    const freeBytes = s.bavail * s.bsize;
    const totalBytes = s.blocks * s.bsize;
    return { freeBytes, totalBytes, freeRatio: totalBytes > 0 ? freeBytes / totalBytes : NaN };
  } catch {
    return { freeBytes: NaN, totalBytes: NaN, freeRatio: NaN };
  }
}

/**
 * Is there room to keep writing, holding `reserveBytes` back for the core?
 *
 * Fails OPEN: if the disk cannot be stat'd we return true. A broken guard must
 * not silently stop data collection — the bounded archive below is the durable
 * protection, this is the fast one.
 */
export function hasHeadroom(dir: string, reserveBytes: number): boolean {
  const { freeBytes } = diskStatus(dir);
  if (!Number.isFinite(freeBytes)) return true;
  return freeBytes > reserveBytes;
}

export interface PruneOptions {
  /** Delete archive files older than this many days. */
  maxAgeDays: number;
  /** Additionally cap the archive's total size, deleting oldest-first. */
  maxTotalBytes: number;
}

export interface PruneResult {
  deleted: string[];
  freedBytes: number;
  remainingBytes: number;
}

/**
 * Bound the archive by age and by total size. Oldest files go first, which
 * matches how the data is used: order-flow research reads recent history, and a
 * three-week-old book snapshot is worth less than a live trading book.
 */
export function pruneArchive(dir: string, opts: PruneOptions): PruneResult {
  const deleted: string[] = [];
  let freedBytes = 0;
  let entries: Array<{ name: string; size: number; mtimeMs: number }>;
  try {
    entries = fs.readdirSync(dir)
      .filter((n) => n.endsWith(ARCHIVE_EXT))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, size: st.size, mtimeMs: st.mtimeMs };
      });
  } catch {
    return { deleted, freedBytes, remainingBytes: 0 };
  }

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

  const drop = (e: { name: string; size: number }): void => {
    try {
      fs.unlinkSync(path.join(dir, e.name));
      deleted.push(e.name);
      freedBytes += e.size;
    } catch { /* already gone or locked — nothing useful to do */ }
  };

  const cutoff = Date.now() - opts.maxAgeDays * 86_400_000;
  const survivors: typeof entries = [];
  for (const e of entries) {
    if (e.mtimeMs < cutoff) drop(e);
    else survivors.push(e);
  }

  let total = survivors.reduce((a, e) => a + e.size, 0);
  for (const e of survivors) {
    if (total <= opts.maxTotalBytes) break;
    drop(e);
    total -= e.size;
  }

  return { deleted, freedBytes, remainingBytes: total };
}

/**
 * Defaults sized from the MEASURED rate (13.2 MB/day/symbol), not the estimate
 * that caused the outage: 14 days x 3 symbols is ~550 MB, so a 1 GB cap leaves
 * the archive room to run while keeping a healthy margin on a small volume.
 */
export const ARCHIVE_BUDGET: PruneOptions = { maxAgeDays: 14, maxTotalBytes: 1_000_000_000 };

/** Free space held back for the core trading processes — never written into. */
export const CORE_RESERVE_BYTES = 500_000_000;
