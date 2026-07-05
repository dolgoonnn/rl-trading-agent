#!/usr/bin/env tsx
/**
 * Resume the crypto bot after the SPURIOUS retirement halt (fixed by the
 * trade-count gate — fix(backend) "gate DSR edge-decay hard-halt on real trade count").
 *
 * Run this with the bot process STOPPED, AFTER deploying the fixed code, then
 * restart the bot. Safe + idempotent + self-guarding; DRY-RUN by default.
 *
 *   npx tsx scripts/resume-bot.ts            # dry-run: print the plan only
 *   npx tsx scripts/resume-bot.ts --apply    # back up DB, then apply
 *
 * It does three guarded things:
 *   1. bot_trades cleanup — ONLY if bot_state.total_trades === 0 (proving the rows
 *      are backtest-dump/replay artifacts, not authoritative live trades). Never
 *      touches real trades.
 *   2. Pre-go-live equity-snapshot trim — removes snapshots BEFORE started_at
 *      (the Feb-23 dump period), keeping the live-period curve.
 *   3. Kill-switch latch clear — ONLY if halted AND source === 'retirement' (the
 *      spurious DSR halt). It will NOT clear an absolute-drawdown, stale_feed,
 *      manual, file, or env halt — those are real and must be reviewed by a human.
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const APPLY = process.argv.includes('--apply');
const DB_PATH = resolve('data', 'ict-trading.db');

interface StateRow { total_trades: number; started_at: number }
interface KillRow { halted: number; source: string | null; reason: string | null; manual_review: number }

function main(): void {
  if (!existsSync(DB_PATH)) { console.error(`DB not found: ${DB_PATH}`); process.exit(1); }
  if (APPLY) {
    const bak = `${DB_PATH}.bak-resume-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(DB_PATH, bak);
    console.log(`[backup] ${bak}`);
  }
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');

  const state = db.prepare('SELECT total_trades, started_at FROM bot_state WHERE id = 1').get() as StateRow | undefined;
  const kill = db.prepare('SELECT halted, source, reason, manual_review FROM bot_kill_switch WHERE id = 1').get() as KillRow | undefined;
  const tradeCount = (db.prepare('SELECT COUNT(*) AS n FROM bot_trades').get() as { n: number }).n;
  const snapCount = (db.prepare('SELECT COUNT(*) AS n FROM bot_equity_snapshots').get() as { n: number }).n;

  console.log(`\nMode: ${APPLY ? 'APPLY' : 'DRY-RUN (no changes)'}`);
  console.log(`bot_state.total_trades = ${state?.total_trades ?? '?'}  started_at = ${state ? new Date(state.started_at).toISOString() : '?'}`);
  console.log(`bot_trades rows = ${tradeCount}  |  equity_snapshots = ${snapCount}`);
  console.log(`kill_switch: halted=${kill?.halted} source=${kill?.source} review=${kill?.manual_review}`);
  console.log(`  reason: ${kill?.reason ?? '(none)'}\n`);

  const plan: string[] = [];
  const run = (label: string, fn: () => number): void => {
    if (APPLY) { const n = fn(); console.log(`[done] ${label} → ${n} row(s)`); }
    else plan.push(label);
  };

  // 1. bot_trades artifacts — guarded on total_trades === 0
  if (state && state.total_trades === 0 && tradeCount > 0) {
    run(`clear ${tradeCount} bot_trades artifact rows (total_trades=0 ⇒ none are live)`, () => db.prepare('DELETE FROM bot_trades').run().changes);
  } else if (tradeCount > 0) {
    console.log(`[skip] bot_trades: total_trades=${state?.total_trades} > 0 — rows look REAL, leaving untouched.`);
  }

  // 2. pre-go-live equity-snapshot trim
  if (state) {
    const stale = (db.prepare('SELECT COUNT(*) AS n FROM bot_equity_snapshots WHERE timestamp < ?').get(state.started_at) as { n: number }).n;
    if (stale > 0) run(`trim ${stale} pre-go-live equity snapshots (before started_at)`, () => db.prepare('DELETE FROM bot_equity_snapshots WHERE timestamp < ?').run(state.started_at).changes);
  }

  // 3. clear the spurious retirement latch ONLY
  if (kill?.halted && kill.source === 'retirement') {
    run(`CLEAR retirement latch (spurious DSR halt — fixed by trade-count gate)`, () => db.prepare("UPDATE bot_kill_switch SET halted = 0, manual_review = 0, reason = 'cleared by resume-bot.ts after trade-count-gate fix', halted_at = NULL WHERE id = 1").run().changes);
  } else if (kill?.halted) {
    console.log(`[skip] kill_switch source='${kill.source}' is NOT 'retirement' — real halt, NOT cleared (human review required).`);
  } else {
    console.log(`[ok] kill_switch not halted — nothing to clear.`);
  }

  if (!APPLY && plan.length) { console.log('Planned actions (re-run with --apply):'); for (const p of plan) console.log(`  • ${p}`); }
  db.close();
  console.log(`\n${APPLY ? '✅ Applied. Now restart the bot (fixed code). Verify it resumes + watch reconcile-sim once it trades.' : 'ℹ️  Dry-run only. Deploy fixed code + stop the bot, then re-run with --apply.'}`);
}

main();
