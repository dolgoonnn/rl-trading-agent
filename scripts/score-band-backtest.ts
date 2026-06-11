/**
 * Score-band filter counterfactual.
 *
 * Uses the actual 431 paper trades in bot_trades. Reports what cumulative P&L
 * would be if you only took trades whose confluence_score fell into a given
 * [lo, hi) band. No strategy reimplementation — pure subset arithmetic on
 * existing outcomes.
 *
 * Also runs a grid sweep to find the band with the best total return-per-trade.
 */

import Database from 'better-sqlite3';
import * as path from 'node:path';

interface Trade {
  symbol: string;
  confluence_score: number;
  pnl_percent: number;
  pnl_usdt: number;
  exit_reason: string;
  bars_held: number;
}

interface BandStats {
  band: string;
  lo: number;
  hi: number;
  n: number;
  wins: number;
  winRate: number;
  slHits: number;
  slRate: number;
  totalPct: number;
  meanPct: number;
  meanBars: number;
  totalUsdt: number;
}

function statsFor(trades: Trade[], lo: number, hi: number, label: string): BandStats {
  const inBand = trades.filter((t) => t.confluence_score >= lo && t.confluence_score < hi);
  const n = inBand.length;
  if (n === 0) {
    return { band: label, lo, hi, n: 0, wins: 0, winRate: 0, slHits: 0, slRate: 0, totalPct: 0, meanPct: 0, meanBars: 0, totalUsdt: 0 };
  }
  const wins = inBand.filter((t) => t.pnl_percent > 0).length;
  const slHits = inBand.filter((t) => t.exit_reason === 'stop_loss').length;
  const totalPct = inBand.reduce((s, t) => s + t.pnl_percent, 0);
  const totalUsdt = inBand.reduce((s, t) => s + t.pnl_usdt, 0);
  const totalBars = inBand.reduce((s, t) => s + t.bars_held, 0);
  return {
    band: label,
    lo,
    hi,
    n,
    wins,
    winRate: wins / n,
    slHits,
    slRate: slHits / n,
    totalPct,
    meanPct: totalPct / n,
    meanBars: totalBars / n,
    totalUsdt,
  };
}

function fmtRow(s: BandStats): string {
  const totalPctStr = `${s.totalPct >= 0 ? '+' : ''}${(s.totalPct * 100).toFixed(1)}%`;
  const meanPctStr = `${s.meanPct >= 0 ? '+' : ''}${(s.meanPct * 100).toFixed(3)}%`;
  return (
    s.band.padEnd(14) +
    `n=${String(s.n).padStart(4)}  ` +
    `WR=${(s.winRate * 100).toFixed(1).padStart(5)}%  ` +
    `SL%=${(s.slRate * 100).toFixed(1).padStart(5)}%  ` +
    `total=${totalPctStr.padStart(8)}  ` +
    `mean=${meanPctStr.padStart(9)}  ` +
    `usdt=${s.totalUsdt >= 0 ? '+' : ''}${s.totalUsdt.toFixed(2).padStart(8)}  ` +
    `bars=${s.meanBars.toFixed(1)}`
  );
}

function main(): void {
  const db = new Database(path.resolve('data/ict-trading.db'), { readonly: true });
  const trades = db
    .prepare(
      `SELECT symbol, confluence_score, pnl_percent, pnl_usdt, exit_reason, bars_held
       FROM bot_trades WHERE exit_price IS NOT NULL`,
    )
    .all() as Trade[];
  db.close();

  console.log(`\nLoaded ${trades.length} closed trades.\n`);

  // Section 1: existing buckets recap
  console.log('═'.repeat(110));
  console.log('SCORE BUCKETS (current state)');
  console.log('─'.repeat(110));
  const buckets: Array<[number, number, string]> = [
    [0, 4, '<4'],
    [4, 5, '4-5'],
    [5, 6, '5-6'],
    [6, 7, '6-7'],
    [7, Infinity, '7+'],
  ];
  for (const [lo, hi, label] of buckets) {
    console.log(fmtRow(statsFor(trades, lo, hi, label)));
  }
  console.log(fmtRow(statsFor(trades, 0, Infinity, 'ALL')));

  // Section 2: cap experiments — trade only [lo, hi)
  console.log('\n' + '═'.repeat(110));
  console.log('THRESHOLD-CAP EXPERIMENTS — trade only if lo ≤ score < hi');
  console.log('─'.repeat(110));
  const caps: Array<[number, number, string]> = [
    [4.0, 5.0, '[4.0, 5.0)'],
    [4.0, 5.5, '[4.0, 5.5)'],
    [3.5, 5.0, '[3.5, 5.0)'],
    [3.5, 5.5, '[3.5, 5.5)'],
    [3.0, 6.0, '[3.0, 6.0)'],
    [4.0, 6.0, '[4.0, 6.0)'],
    [4.0, Infinity, '[4.0, ∞)  (current ≈ Run 20)'],
  ];
  for (const [lo, hi, label] of caps) {
    console.log(fmtRow(statsFor(trades, lo, hi, label)));
  }

  // Section 3: grid sweep — find best mean PnL band with n ≥ 30
  console.log('\n' + '═'.repeat(110));
  console.log('GRID SWEEP — best mean PnL/trade among bands with n ≥ 30');
  console.log('─'.repeat(110));
  const grid: BandStats[] = [];
  for (let lo = 3.0; lo <= 6.0; lo += 0.25) {
    for (let hi = lo + 0.5; hi <= 8.0; hi += 0.25) {
      const s = statsFor(trades, lo, hi, `[${lo.toFixed(2)}, ${hi.toFixed(2)})`);
      if (s.n >= 30) grid.push(s);
    }
  }
  grid.sort((a, b) => b.meanPct - a.meanPct);
  console.log('top 10 by mean PnL/trade:');
  for (const s of grid.slice(0, 10)) console.log(fmtRow(s));
  console.log('\ntop 10 by total PnL (with n ≥ 30):');
  grid.sort((a, b) => b.totalPct - a.totalPct);
  for (const s of grid.slice(0, 10)) console.log(fmtRow(s));

  console.log('\n' + '═'.repeat(110));
  console.log('Caveat: paper trades from one regime window. Apply walk-forward to confirm.');
  console.log('═'.repeat(110) + '\n');
}

main();
