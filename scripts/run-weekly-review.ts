#!/usr/bin/env npx tsx
/**
 * Weekly Review — cron entrypoint (Task 4b, PLAN-D).
 *
 * Reads the forward bot's closed trades, materializes the per-cell P&L
 * decomposition into `pnl_cells` (stamped with the current week), runs the
 * cold-cohort decay scan, prints a readable report (per-cell table + cost-trap
 * and decay flags), and appends a single immutable `decision_log` 'weekly_review'
 * row recording that the review ran.
 *
 * This is READ-OR-APPEND ONLY. It never touches the live-trading decision path
 * and never mutates a trade — it only summarizes history.
 *
 * CADENCE: run every Monday at 00:30 UTC. This script does NOT embed a scheduler;
 * wire it via cron/PM2/systemd, e.g. a crontab line:
 *
 *     30 0 * * 1  cd /path/to/ict-trading && pnpm review:weekly >> logs/weekly-review.log 2>&1
 *
 * Usage:
 *   pnpm review:weekly          # review for the current ISO-week (UTC Monday)
 *   npx tsx scripts/run-weekly-review.ts
 */

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../src/lib/data/db';
import {
  materializePnlCells,
  readReviewTrades,
  coldCohortScan,
  type PnlCell,
  type CohortStat,
} from '../src/lib/bot/review';
import { appendDecisionLog } from '../src/lib/bot/decision-log';

const DAY_MS = 24 * 3_600_000;

/** UTC-Monday 00:00 of the week containing `nowMs` (the pnl_cells weekOf stamp). */
function weekOfUtcMonday(nowMs: number): number {
  const d = new Date(nowMs);
  // getUTCDay(): 0=Sun..6=Sat. Convert so Monday is day 0.
  const dayFromMonday = (d.getUTCDay() + 6) % 7;
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - dayFromMonday * DAY_MS;
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function printCellReport(cells: PnlCell[]): void {
  console.log('\n=== Per-Cell P&L Decomposition (regime × symbol × bucket × exit) ===');
  if (cells.length === 0) {
    console.log('  (no closed trades yet)');
    return;
  }

  // Sort: cost traps first, then by descending |sumNet| so the report leads with
  // the cells that matter for the review decision.
  const sorted = [...cells].sort((a, b) => {
    if (a.costTrap !== b.costTrap) return a.costTrap ? -1 : 1;
    return Math.abs(b.sumNet) - Math.abs(a.sumNet);
  });

  const header = [
    'regime'.padEnd(18),
    'symbol'.padEnd(9),
    'bkt'.padEnd(4),
    'exit'.padEnd(12),
    'n'.padStart(4),
    'meanNet'.padStart(9),
    'sumNet'.padStart(9),
    'WR'.padStart(6),
    'fund%G'.padStart(7),
    'flags',
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const c of sorted) {
    const flags: string[] = [];
    if (c.costTrap) flags.push('COST-TRAP');
    if (c.lowConfidence) flags.push('low-n');
    console.log(
      [
        c.regime.padEnd(18),
        c.symbol.padEnd(9),
        c.confluenceBucket.padEnd(4),
        c.exitReason.padEnd(12),
        String(c.n).padStart(4),
        fmtPct(c.meanNet).padStart(9),
        fmtPct(c.sumNet).padStart(9),
        fmtPct(c.winRate).padStart(6),
        c.fundingPctOfGross.toFixed(2).padStart(7),
        flags.join(','),
      ].join(' '),
    );
  }

  const traps = sorted.filter((c) => c.costTrap);
  if (traps.length > 0) {
    console.log(`\n  ⚠ ${traps.length} COST-TRAP cell(s): funding/friction is eating the edge.`);
  }
}

function printCohortReport(cohorts: CohortStat[]): void {
  console.log('\n=== Cold-Cohort Decay Scan (by entry-month, UTC) ===');
  if (cohorts.length === 0) {
    console.log('  (no closed trades yet)');
    return;
  }
  console.log(
    ['month'.padEnd(8), 'n'.padStart(4), 'meanNet'.padStart(9), 'sharpe'.padStart(8), 'DSR'.padStart(8), 'flag'].join(' '),
  );
  for (const c of cohorts) {
    console.log(
      [
        c.month.padEnd(8),
        String(c.n).padStart(4),
        fmtPct(c.meanNet).padStart(9),
        c.sharpe.toFixed(2).padStart(8),
        c.deflatedSharpe.toFixed(2).padStart(8),
        c.decaying ? 'DECAYING' : '',
      ].join(' '),
    );
  }
  const decaying = cohorts.filter((c) => c.decaying);
  if (decaying.length > 0) {
    console.log(`\n  ⚠ ${decaying.length} cohort(s) flagged DECAYING (deflated Sharpe <= 0).`);
  }
}

async function main(): Promise<void> {
  // Migrate-on-startup so the review never reads against a stale schema.
  migrate(db, { migrationsFolder: './drizzle' });

  const nowMs = Date.now();
  const weekOf = weekOfUtcMonday(nowMs);
  console.log(`Weekly review — week of ${new Date(weekOf).toISOString().slice(0, 10)} (UTC Monday)`);

  // Materialize cells into pnl_cells (returns them so we don't re-read).
  const cells = materializePnlCells(db, weekOf);
  printCellReport(cells);

  // Cold-cohort decay scan over the full trade history.
  const trades = readReviewTrades(db);
  const cohorts = coldCohortScan(trades);
  printCohortReport(cohorts);

  const costTraps = cells.filter((c) => c.costTrap).length;
  const decayingCohorts = cohorts.filter((c) => c.decaying).length;

  // Append an immutable audit row recording that the review ran.
  appendDecisionLog(db, {
    type: 'weekly_review',
    detail: {
      weekOf,
      tradesReviewed: trades.length,
      cells: cells.length,
      costTraps,
      cohorts: cohorts.length,
      decayingCohorts,
    },
    nowMs,
  });

  console.log(
    `\nReview complete: ${trades.length} trades, ${cells.length} cells ` +
      `(${costTraps} cost-trap), ${cohorts.length} cohorts (${decayingCohorts} decaying). ` +
      `Logged decision_log 'weekly_review'.`,
  );
}

main().catch((err) => {
  console.error('[weekly-review] failed:', err);
  process.exit(1);
});
