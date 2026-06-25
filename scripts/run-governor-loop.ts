#!/usr/bin/env tsx
/**
 * Book-governance signal refresh loop.
 *
 * Calls emitBookGovernanceSignal() once immediately on start, then every 15
 * minutes. Each emit is wrapped in try/catch so a transient failure (DB lock,
 * stale data file, etc.) never kills the loop. Designed to run under PM2 as
 * the `book-governor` app; PM2 autorestart handles any crash that slips past
 * the catch.
 *
 * The signal file is consumed fail-open: a dead or stale governor (>90 min)
 * never freezes the book — the crypto bot falls back to `trade` with a
 * console warning. So correctness of the loop is: stay alive + refresh often
 * enough that staleness does not trigger the fail-open window.
 *
 * Usage (manual):  npx tsx scripts/run-governor-loop.ts
 * Production:      pm2 start ecosystem.config.cjs --only book-governor
 */

import { emitBookGovernanceSignal } from './run-allocator';

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

function tick(): void {
  const ts = new Date().toISOString();
  try {
    const { action, reason } = emitBookGovernanceSignal();
    console.log(`[${ts}] book-governor: ${action.toUpperCase()} — ${reason}`);
  } catch (err) {
    // Log and continue — one bad tick must not kill the loop.
    console.error(`[${ts}] book-governor: emit failed (will retry in ${INTERVAL_MS / 60000}min):`, err);
  }
}

// Emit once immediately so the signal is fresh on startup, then run on cadence.
tick();
setInterval(tick, INTERVAL_MS);
