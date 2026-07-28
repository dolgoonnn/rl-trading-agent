#!/usr/bin/env npx tsx
/**
 * Consolidated live paper track-record status.
 *
 * The forward record is fragmented across three stores; this prints one unified
 * view of the combined book for the charter review:
 *   - crypto  → bot_trades table + bot_state (data/ict-trading.db)
 *   - metals  → data/metals-bot-state.json
 *   - gold    → data/gold-bot-state.json
 *
 *   npx tsx scripts/track-record-status.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { combineSleeves, partitionByHoldCap } from '../src/lib/bot/track-record';
import { readCryptoSleeve, readMetalsSleeve, readGoldSleeve } from '../src/lib/bot/sleeve-readers';

/** Holds beyond this are downtime-stranded artifacts, not strategy trades. */
const STALE_HOLD_CAP_MS = 120 * 3_600_000; // 120h — above the longest legit hold (weekend ~85h)

interface MetalsTrade {
  leg: string;
  entryTime: string;
  exitTime: string;
  pnlPct: number;
  stale?: boolean; // bot-flagged (per-leg cap) — authoritative when present
}

/**
 * Metals strategy-vs-stale partition. Prefer the bot's own `stale` flag (set at
 * close via per-leg caps); fall back to the hold-duration heuristic for older
 * trades booked before the flag existed.
 */
function metalsHonestPnl(): { strategyPnlPct: number; strategyCount: number; stalePnlPct: number; staleCount: number } | null {
  const d = readJson(path.resolve('data/metals-bot-state.json')) as { trades?: MetalsTrade[] } | null;
  const trades = d?.trades;
  if (!trades || trades.length === 0) return null;
  const withHold = trades.map((t) => ({
    // Flagged-stale trades force holdMs above the cap so the partition counts
    // them as stale; unflagged trades use their real hold vs the 120h fallback.
    holdMs: t.stale === true
      ? STALE_HOLD_CAP_MS + 1
      : Math.max(0, Date.parse(t.exitTime) - Date.parse(t.entryTime)),
    pnlPct: t.pnlPct,
  }));
  return partitionByHoldCap(withHold, STALE_HOLD_CAP_MS);
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function main(): void {
  const sleeves = [readCryptoSleeve(), readMetalsSleeve(), readGoldSleeve()];
  const combined = combineSleeves(sleeves);

  console.log('='.repeat(72));
  console.log('LIVE PAPER TRACK RECORD (consolidated across 3 stores)');
  console.log('='.repeat(72));
  console.log('sleeve'.padEnd(18) + 'closed'.padStart(8) + 'cumPnL%'.padStart(10) + 'winRate'.padStart(9) + 'open'.padStart(6));
  for (const s of sleeves) {
    console.log(
      s.label.padEnd(18) +
        String(s.closedTrades).padStart(8) +
        s.cumPnlPct.toFixed(2).padStart(10) +
        (s.closedTrades > 0 ? (s.winRate * 100).toFixed(0) + '%' : '—').padStart(9) +
        String(s.openPositions).padStart(6),
    );
  }
  console.log('-'.repeat(72));

  // Honest metals attribution: strip downtime-stranded positions.
  const honest = metalsHonestPnl();
  if (honest && honest.staleCount > 0) {
    console.log(
      `session/metals HONEST: strategy ${honest.strategyPnlPct.toFixed(2)}% (${honest.strategyCount} normal-hold trades)` +
        ` | ${honest.staleCount} downtime-stranded artifacts ${honest.stalePnlPct.toFixed(2)}% (held >120h during bot outages — NOT strategy)`,
    );
    console.log('-'.repeat(72));
  }

  console.log(
    `TOTAL: ${combined.totalClosedTrades} closed trades, ${combined.totalOpenPositions} open across ${combined.activeSleeves}/${sleeves.length} active sleeves`,
  );
  if (combined.idleSleeves.length > 0) {
    console.log(`IDLE (no trades yet): ${combined.idleSleeves.join(', ')}`);
  }
  if (combined.totalClosedTrades === 0) {
    console.log('\n⚠  EMPTY track record — no sleeve has booked a closed trade.');
  } else if (combined.activeSleeves < sleeves.length) {
    console.log('\n⚠  Diversification NOT yet realized live — the combined-book edge needs ALL sleeves active.');
  }
  console.log('='.repeat(72));
}

main();
