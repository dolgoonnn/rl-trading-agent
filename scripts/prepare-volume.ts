#!/usr/bin/env tsx
/**
 * Make the data volume writable BEFORE the fleet starts. Runs first in
 * docker-entrypoint.sh, ahead of every bot.
 *
 * WHY IT RUNS HERE AND NOWHERE ELSE
 * On 2026-08-10 the Railway volume filled. The boot order is what turned that
 * into a total outage: the crypto bot launches first, backfills candles,
 * saves state, and dies on SQLITE_FULL — all before the order-flow collector
 * (5th in the list) gets a chance to clean anything up. The supervisor sees a
 * CORE process dead, exits, Railway restarts the container, and it loops until
 * `restartPolicyMaxRetries` is exhausted and the service stops being routed.
 *
 * So a self-cleaning collector cannot fix this: by the time it runs, the
 * container is already dying. The prune has to happen before ANY process opens
 * the database — which is exactly here.
 *
 * WHAT IT TARGETS
 * Free space, not archive size. A budget like "keep the archive under 1 GB"
 * frees nothing on a full 1 GB volume where every file is recent — the only
 * budget that reliably un-wedges a volume is stated in the quantity that ran
 * out. Age/size pruning still runs afterwards as ongoing hygiene.
 *
 * NON-FATAL BY DESIGN: this exits 0 even when it cannot reach the target. If
 * the volume is too small, the operator needs the fleet's own logs to say so —
 * blocking startup here would just replace one silent outage with another.
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  ensureFreeSpace, pruneArchive, diskStatus,
  ARCHIVE_BUDGET, CORE_RESERVE_BYTES,
} from '../src/lib/bot/disk-guard';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'orderflow');

const mb = (n: number): string => (Number.isFinite(n) ? `${(n / 1e6).toFixed(0)}MB` : 'unknown');

function dirSize(dir: string): number {
  try {
    return fs.readdirSync(dir).reduce((a, n) => {
      try { return a + fs.statSync(path.join(dir, n)).size; } catch { return a; }
    }, 0);
  } catch { return 0; }
}

/**
 * Deleting is allowed ONLY in the container, or with an explicit --force.
 *
 * Learned the hard way: running this on a laptop to "check it works" destroyed
 * 31 files of real L2 research archive, because a dev machine's data/orderflow
 * holds months of history while the container's holds days. A script whose job
 * is to delete files must not do that anywhere except where it was meant to.
 */
const IN_CONTAINER = fs.existsSync('/app/data') || process.env.RAILWAY_ENVIRONMENT !== undefined;
const FORCED = process.argv.includes('--force');

function main(): void {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  if (!IN_CONTAINER && !FORCED) {
    const d = diskStatus(DATA_DIR);
    let wouldDelete = 0;
    const cutoff = Date.now() - ARCHIVE_BUDGET.maxAgeDays * 86_400_000;
    try {
      for (const n of fs.readdirSync(ARCHIVE_DIR)) {
        if (n.endsWith('.ndjson') && fs.statSync(path.join(ARCHIVE_DIR, n)).mtimeMs < cutoff) wouldDelete++;
      }
    } catch { /* nothing to report */ }
    console.log(`[prepare-volume] DRY RUN (not in a container) — nothing deleted.`);
    console.log(`[prepare-volume] disk ${mb(d.freeBytes)} free; archive ${mb(dirSize(ARCHIVE_DIR))}; ${wouldDelete} files are past the ${ARCHIVE_BUDGET.maxAgeDays}d budget.`);
    console.log(`[prepare-volume] pass --force to actually delete on this machine.`);
    return;
  }

  const before = diskStatus(DATA_DIR);
  console.log(`[prepare-volume] disk ${mb(before.freeBytes)} free of ${mb(before.totalBytes)}`);
  console.log(`[prepare-volume] archive ${mb(dirSize(ARCHIVE_DIR))}, data dir ${mb(dirSize(DATA_DIR))}`);

  // 1. Recovery: claw back enough room for the core processes to open the DB.
  const ensured = ensureFreeSpace(ARCHIVE_DIR, CORE_RESERVE_BYTES);
  if (ensured.deleted.length > 0) {
    console.log(`[prepare-volume] freed ${mb(ensured.freedBytes)} by deleting ${ensured.deleted.length} archive files ` +
      `(${mb(ensured.freeBefore)} -> ${mb(ensured.freeAfter)} free)`);
  }

  // 2. Hygiene: keep the archive inside its normal age/size budget.
  const pruned = pruneArchive(ARCHIVE_DIR, ARCHIVE_BUDGET);
  if (pruned.deleted.length > 0) {
    console.log(`[prepare-volume] pruned ${pruned.deleted.length} files past the ${ARCHIVE_BUDGET.maxAgeDays}d / ${mb(ARCHIVE_BUDGET.maxTotalBytes)} budget`);
  }

  const after = diskStatus(DATA_DIR);
  if (!ensured.ok) {
    // Loud, but not fatal — the operator needs this in the logs, and refusing
    // to boot would hide it behind a container that never starts.
    console.error(`[prepare-volume] WARNING: only ${mb(after.freeBytes)} free after cleanup, ` +
      `below the ${mb(CORE_RESERVE_BYTES)} core reserve. The volume is too small for the ` +
      `current retention — increase it, or lower ARCHIVE_BUDGET. Trading may fail on SQLITE_FULL.`);
  } else {
    console.log(`[prepare-volume] ready — ${mb(after.freeBytes)} free`);
  }
}

main();
