#!/usr/bin/env tsx
/**
 * Analyze the brother's trade dataset (experiments/brother-trades.md).
 *
 * TWO samples with very different statistical status:
 *  - LEDGER (History/Deals tab, gold lot 1.0, n=11): the ONLY unbiased sample.
 *    Includes losers. Use this for edge/expectancy.
 *  - CHART ENTRIES (n=64): WINNERS-BIASED (he screenshots wins). Use ONLY for
 *    DESCRIBING the method (instrument mix, direction, sizing, scale-in, tails),
 *    never for win-rate/expectancy.
 */

interface Deal { side: 'buy' | 'sell'; open: number; close: number; pnl: number; time: string; }
interface Entry { date: string; symbol: string; dir: 'BUY' | 'SELL'; lot: number; entry: number; pnl: number; dup?: boolean; sl?: number; }

// ---- LEDGER (exact fills, gold lot 1.0, $100/point) ----
const LEDGER: Deal[] = [
  { side: 'sell', open: 4628.973, close: 4627.567, pnl: 140.60, time: '2026-04-28T11:55:40' },
  { side: 'buy', open: 4609.727, close: 4610.073, pnl: 34.60, time: '2026-04-28T13:10:55' },
  { side: 'sell', open: 4611.863, close: 4581.564, pnl: 3029.90, time: '2026-04-28T14:36:25' },
  { side: 'sell', open: 4565.053, close: 4562.677, pnl: 237.60, time: '2026-04-28T17:47:29' },
  { side: 'sell', open: 4591.583, close: 4608.267, pnl: -1668.40, time: '2026-04-29T03:08:54' },
  { side: 'buy', open: 4609.387, close: 4607.003, pnl: -238.40, time: '2026-04-29T03:15:07' },
  { side: 'sell', open: 4606.213, close: 4600.307, pnl: 590.60, time: '2026-04-29T03:30:11' },
  { side: 'sell', open: 4583.993, close: 4583.535, pnl: 45.80, time: '2026-04-29T09:22:26' },
  { side: 'sell', open: 4580.503, close: 4579.607, pnl: 89.60, time: '2026-04-29T10:12:49' },
  { side: 'sell', open: 4599.403, close: 4572.227, pnl: 2717.60, time: '2026-04-29T10:42:02' },
  { side: 'sell', open: 4602.653, close: 4571.077, pnl: 3157.60, time: '2026-04-29T10:42:25' },
];

// ---- CHART ENTRIES (winners-biased; descriptive only) ----
const ENTRIES: Entry[] = [
  { date: '2026-04-14', symbol: 'Boom 1000', dir: 'BUY', lot: 5, entry: 13738.4874, pnl: 157.47 },
  { date: '2026-04-16', symbol: 'Boom 1000', dir: 'BUY', lot: 2, entry: 13877.5964, pnl: 78.11 },
  { date: '2026-04-16', symbol: 'Boom 1000', dir: 'BUY', lot: 2, entry: 13870.0864, pnl: 93.13 },
  { date: '2026-04-16', symbol: 'Boom 1000', dir: 'BUY', lot: 2, entry: 13865.0694, pnl: 103.16 },
  { date: '2026-04-16', symbol: 'Boom 1000', dir: 'BUY', lot: 1, entry: 13870.0864, pnl: 210.92, dup: true },
  { date: '2026-04-16', symbol: 'Boom 1000', dir: 'BUY', lot: 1, entry: 13865.0694, pnl: 215.93, dup: true },
  { date: '2026-04-16', symbol: 'Volatility 100', dir: 'SELL', lot: 20, entry: 813.55, pnl: 117.40 },
  { date: '2026-04-16', symbol: 'Volatility 100', dir: 'SELL', lot: 10, entry: 813.55, pnl: 211.00, sl: 812.92 },
  { date: '2026-04-17', symbol: 'XAUUSD', dir: 'BUY', lot: 0.2, entry: 4795.62, pnl: 168.40 },
  { date: '2026-04-20', symbol: 'XAUUSD', dir: 'BUY', lot: 0.2, entry: 4785.42, pnl: 195.20 },
  { date: '2026-04-21', symbol: 'XAUUSD', dir: 'BUY', lot: 0.2, entry: 4790.60, pnl: 95.60 },
  { date: '2026-04-21', symbol: 'XAUUSD', dir: 'BUY', lot: 0.1, entry: 4785.42, pnl: 99.60 },
  { date: '2026-04-22', symbol: 'XAUUSD', dir: 'SELL', lot: 0.2, entry: 4771.12, pnl: 91.80 },
  { date: '2026-04-22', symbol: 'Step Index 200', dir: 'BUY', lot: 2, entry: 10394.3, pnl: 112.00 },
  { date: '2026-04-22', symbol: 'Step Index 500', dir: 'SELL', lot: 2, entry: 5323.3, pnl: 170.00 },
  { date: '2026-04-22', symbol: 'Step Index 200', dir: 'BUY', lot: 1, entry: 10394.3, pnl: 174.00 },
  { date: '2026-04-22', symbol: 'Step Index 500', dir: 'SELL', lot: 1, entry: 5323.3, pnl: 180.00 },
  { date: '2026-04-22', symbol: 'Step Index 500', dir: 'SELL', lot: 1, entry: 5323.3, pnl: 980.00, sl: 5320.7, dup: true },
  { date: '2026-04-23', symbol: 'Step Index 200', dir: 'BUY', lot: 2, entry: 10345.5, pnl: 100.00 },
  { date: '2026-04-23', symbol: 'Step Index 200', dir: 'BUY', lot: 0.5, entry: 10345.5, pnl: 124.00, sl: 10346.1 },
  { date: '2026-04-23', symbol: 'Jump 100', dir: 'BUY', lot: 3, entry: 390.93, pnl: 33.33 },
  { date: '2026-04-24', symbol: 'Crash 1000', dir: 'SELL', lot: 10, entry: 5697.694, pnl: 192.22 },
  { date: '2026-04-24', symbol: 'Crash 1000', dir: 'SELL', lot: 10, entry: 5685.034, pnl: 65.62 },
  { date: '2026-04-25', symbol: 'Boom 1000', dir: 'BUY', lot: 5, entry: 14304.2266, pnl: 104.40 },
  { date: '2026-04-25', symbol: 'Boom 1000', dir: 'BUY', lot: 5, entry: 14288.1826, pnl: 184.62 },
  { date: '2026-04-25', symbol: 'Boom 1000', dir: 'BUY', lot: 5, entry: 14270.6256, pnl: 272.41 },
  { date: '2026-04-27', symbol: 'Boom 1000', dir: 'BUY', lot: 8, entry: 14209.4736, pnl: 173.13 },
  { date: '2026-04-27', symbol: 'XAUUSD', dir: 'SELL', lot: 0.2, entry: 4717.47, pnl: 292.60 },
  { date: '2026-04-27', symbol: 'XAUUSD', dir: 'SELL', lot: 0.2, entry: 4713.99, pnl: 223.00 },
  { date: '2026-04-27', symbol: 'XAUUSD', dir: 'SELL', lot: 0.1, entry: 4711.48, pnl: 86.40 },
  { date: '2026-04-28', symbol: 'XAUUSD', dir: 'SELL', lot: 0.2, entry: 4631.90, pnl: 122.60 },
  { date: '2026-04-29', symbol: 'XAUUSD', dir: 'SELL', lot: 0.05, entry: 4606.97, pnl: 116.65 },
  { date: '2026-04-29', symbol: 'XAUUSD', dir: 'SELL', lot: 0.05, entry: 4603.76, pnl: 101.50 },
  { date: '2026-04-30', symbol: 'Volatility 100', dir: 'BUY', lot: 50, entry: 587.69, pnl: 307.00 },
  { date: '2026-05-04', symbol: 'Step Index 200', dir: 'BUY', lot: 2, entry: 10242.9, pnl: 204.00 },
  { date: '2026-05-05', symbol: 'Volatility 75', dir: 'SELL', lot: 0.75, entry: 36763.49, pnl: 114.19 },
  { date: '2026-05-05', symbol: 'XAUUSD', dir: 'BUY', lot: 0.2, entry: 4542.18, pnl: 243.20 },
  { date: '2026-05-05', symbol: 'XAUUSD', dir: 'BUY', lot: 0.2, entry: 4537.66, pnl: 333.60, sl: 4532.33 },
  { date: '2026-05-08', symbol: 'XAUUSD', dir: 'SELL', lot: 0.2, entry: 4729.44, pnl: 285.60 },
  { date: '2026-05-11', symbol: 'Step Index', dir: 'BUY', lot: 2, entry: 7908.7, pnl: 236.00, dup: true },
  { date: '2026-05-11', symbol: 'Step Index', dir: 'BUY', lot: 2, entry: 7908.7, pnl: 364.00 },
  { date: '2026-05-11', symbol: 'Step Index 200', dir: 'SELL', lot: 1, entry: 10396.5, pnl: 170.00 },
  { date: '2026-05-13', symbol: 'Volatility 100', dir: 'SELL', lot: 50, entry: 436.89, pnl: 204.50 },
  { date: '2026-05-13', symbol: 'Volatility 100 (1s)', dir: 'BUY', lot: 50, entry: 1143.80, pnl: 209.00, sl: 1130.06 },
  { date: '2026-05-13', symbol: 'XAUUSD', dir: 'SELL', lot: 0.08, entry: 4712.30, pnl: 61.28 },
  { date: '2026-05-13', symbol: 'Step Index 200', dir: 'SELL', lot: 2, entry: 10373.7, pnl: 120.00 },
  { date: '2026-05-21', symbol: 'Step Index', dir: 'SELL', lot: 2, entry: 8106.4, pnl: 308.00 },
  { date: '2026-05-29', symbol: 'Volatility 100', dir: 'SELL', lot: 50, entry: 387.67, pnl: 211.00 },
  { date: '2026-06-02', symbol: 'Boom 150', dir: 'BUY', lot: 5, entry: 9331.344, pnl: 30.45 },
  { date: '2026-06-02', symbol: 'XAUUSD', dir: 'SELL', lot: 0.2, entry: 4539.69, pnl: 155.00 },
  { date: '2026-06-08', symbol: 'Step Index', dir: 'SELL', lot: 5, entry: 8008.3, pnl: 405.00 },
  { date: '2026-06-11', symbol: 'Volatility 100', dir: 'SELL', lot: 50, entry: 352.89, pnl: 199.00 },
  { date: '2026-06-11', symbol: 'Step Index', dir: 'SELL', lot: 5, entry: 8018.9, pnl: 440.00 },
  { date: '2026-06-15', symbol: 'Step Index', dir: 'BUY', lot: 3, entry: 7983.2, pnl: 99.00 },
  { date: '2026-06-18', symbol: 'Volatility 75', dir: 'BUY', lot: 0.75, entry: 37062.33, pnl: 718.00, sl: 37142.03 },
  { date: '2026-06-19', symbol: 'XAUUSD', dir: 'SELL', lot: 0.3, entry: 4156.07, pnl: 37.80 },
  { date: '2026-06-19', symbol: 'XAUUSD', dir: 'SELL', lot: 0.3, entry: 4155.96, pnl: 34.50 },
  { date: '2026-06-19', symbol: 'XAUUSD', dir: 'SELL', lot: 0.3, entry: 4155.77, pnl: 28.80 },
  { date: '2026-06-19', symbol: 'XAUUSD', dir: 'SELL', lot: 0.3, entry: 4155.67, pnl: 25.80 },
  { date: '2026-06-24', symbol: 'Boom 1000', dir: 'BUY', lot: 8, entry: 14729.9347, pnl: 120.60 },
  { date: '2026-06-24', symbol: 'Boom 1000', dir: 'BUY', lot: 8, entry: 14720.3357, pnl: 197.40 },
  { date: '2026-06-25', symbol: 'Boom 1000', dir: 'BUY', lot: 5, entry: 14846.7127, pnl: 155.07 },
  { date: '2026-06-29', symbol: 'Volatility 75', dir: 'SELL', lot: 0.75, entry: 48856.80, pnl: 121.25 },
];

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
function stdev(a: number[]): number { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); }
function skewness(a: number[]): number { const m = mean(a), sd = stdev(a); return sd > 0 ? mean(a.map((v) => ((v - m) / sd) ** 3)) : 0; }

function bar(title: string) { console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`); }

// ============================================================
bar('A) LEDGER — the ONLY honest sample (gold, lot 1.0, n=11, $100/point)');
// ============================================================
{
  const pnl = LEDGER.map((d) => d.pnl);
  const wins = pnl.filter((p) => p > 0);
  const losses = pnl.filter((p) => p < 0);
  const points = LEDGER.map((d) => (d.close - d.open) * (d.side === 'sell' ? -1 : 1));
  const total = sum(pnl);
  const grossWin = sum(wins), grossLoss = -sum(losses);

  console.log(`  trades: ${pnl.length}  |  wins: ${wins.length}  losses: ${losses.length}  |  win rate: ${fmt(wins.length / pnl.length * 100, 1)}%`);
  console.log(`  net P&L: $${fmt(total)}  (deposit 20,000 → balance 30,537.10, +52.8%)`);
  console.log(`  avg win:  $${fmt(mean(wins))}   avg loss:  $${fmt(mean(losses))}   win/loss ratio: ${fmt(mean(wins) / -mean(losses))}x`);
  console.log(`  expectancy/trade: $${fmt(mean(pnl))}   profit factor: ${fmt(grossWin / grossLoss)}`);
  console.log(`  median P&L: $${fmt([...pnl].sort((a, b) => a - b)[Math.floor(pnl.length / 2)]!)}   skew: ${fmt(skewness(pnl))}`);

  const sorted = [...pnl].sort((a, b) => b - a);
  console.log(`\n  TAIL CONCENTRATION (positive-skew test):`);
  console.log(`    top 1 winner = $${fmt(sorted[0]!)} = ${fmt(sorted[0]! / total * 100, 1)}% of net profit`);
  console.log(`    top 3 winners = $${fmt(sum(sorted.slice(0, 3)))} = ${fmt(sum(sorted.slice(0, 3)) / total * 100, 1)}% of net profit`);
  console.log(`    => remove the top 3 trades and the other 8 net only $${fmt(total - sum(sorted.slice(0, 3)))}`);

  console.log(`\n  POINTS CAPTURED per trade (signed by direction):`);
  console.log(`    winners captured: ${LEDGER.filter((d) => d.pnl > 0).map((d) => fmt((d.close - d.open) * (d.side === 'sell' ? -1 : 1), 1)).join(', ')} pts`);
  console.log(`    losers gave back: ${LEDGER.filter((d) => d.pnl < 0).map((d) => fmt((d.close - d.open) * (d.side === 'sell' ? -1 : 1), 1)).join(', ')} pts`);
  console.log(`    biggest winner ${fmt(Math.max(...points), 1)} pts vs worst loser ${fmt(Math.min(...points), 1)} pts`);

  console.log(`\n  BY DIRECTION:`);
  for (const side of ['sell', 'buy'] as const) {
    const d = LEDGER.filter((x) => x.side === side);
    console.log(`    ${side.toUpperCase().padEnd(4)}: n=${d.length}  net $${fmt(sum(d.map((x) => x.pnl)))}  wins ${d.filter((x) => x.pnl > 0).length}/${d.length}`);
  }
  console.log(`    => the 2 losers were a counter-trend SELL (fought a bounce) + a BUY. Every continuation-SELL won.`);

  console.log(`\n  BY DAY (gold was selling off 4629 -> 4571, ~-1.2% over 2 days = the REGIME):`);
  for (const day of ['2026-04-28', '2026-04-29']) {
    const d = LEDGER.filter((x) => x.time.startsWith(day));
    console.log(`    ${day}: n=${d.length}  net $${fmt(sum(d.map((x) => x.pnl)))}`);
  }
}

// ============================================================
bar('B) CHART ENTRIES — WINNERS-BIASED, describes METHOD only (n=64, NOT edge)');
// ============================================================
{
  const real = ENTRIES.filter((e) => !e.dup); // drop re-snaps of same position
  console.log(`  ${ENTRIES.length} labels; ${ENTRIES.length - real.length} are dup re-snaps -> ${real.length} distinct positions`);
  console.log(`  ⚠️  every one is a winner -> CANNOT infer win rate/expectancy from this. Method description only.\n`);

  const norm = (s: string) => s.replace(/ \(1s\)| \d+$/, '').replace('Volatility', 'Vol').replace('Step Index', 'Step');
  const fam: Record<string, Entry[]> = {};
  for (const e of real) (fam[norm(e.symbol)] ??= []).push(e);
  console.log(`  BY INSTRUMENT FAMILY (count of winning screenshots — selection, not performance):`);
  for (const [k, v] of Object.entries(fam).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${k.padEnd(14)} n=${String(v.length).padStart(2)}   dirs: ${v.filter((e) => e.dir === 'BUY').length}B/${v.filter((e) => e.dir === 'SELL').length}S`);
  }

  console.log(`\n  BY DIRECTION (overall): ${real.filter((e) => e.dir === 'BUY').length} BUY / ${real.filter((e) => e.dir === 'SELL').length} SELL`);
  console.log(`    XAUUSD gold: ${real.filter((e) => e.symbol === 'XAUUSD' && e.dir === 'BUY').length}B/${real.filter((e) => e.symbol === 'XAUUSD' && e.dir === 'SELL').length}S`);
  console.log(`    Boom (up-spike): ${real.filter((e) => e.symbol.startsWith('Boom')).length} trades, all ${real.filter((e) => e.symbol.startsWith('Boom') && e.dir === 'BUY').length === real.filter((e) => e.symbol.startsWith('Boom')).length ? 'BUY (with spike bias)' : 'mixed'}`);
  console.log(`    Crash (down-spike): ${real.filter((e) => e.symbol.startsWith('Crash')).length} trades, all ${real.filter((e) => e.symbol.startsWith('Crash') && e.dir === 'SELL').length === real.filter((e) => e.symbol.startsWith('Crash')).length ? 'SELL (with spike bias)' : 'mixed'}`);

  // scale-in detection: same date + symbol + dir, >=2 entries
  const groups: Record<string, Entry[]> = {};
  for (const e of real) (groups[`${e.date}|${e.symbol}|${e.dir}`] ??= []).push(e);
  const scaled = Object.values(groups).filter((g) => g.length >= 2);
  console.log(`\n  SCALE-IN behaviour: ${scaled.length} sessions had >=2 entries same day/instrument/dir`);
  console.log(`    scaled-session sizes: ${scaled.map((g) => g.length).sort((a, b) => b - a).join(', ')}  (adds only into the move, at better prices)`);

  console.log(`\n  SL lines present on ${real.filter((e) => e.sl !== undefined).length} screenshots (he uses stops; on the +718 Vol75 the SL trailed ABOVE entry).`);

  // biggest tail in chart set
  const top = [...real].sort((a, b) => b.pnl - a.pnl).slice(0, 5);
  console.log(`\n  BIGGEST WINS in the chart set: ${top.map((e) => `${e.symbol} +$${fmt(e.pnl, 0)}`).join(' | ')}`);
  console.log(`    (consistent with tail-capture: a handful of big rides dwarf the +$30..+200 majority)`);
}

bar('READ');
console.log(`  • Only the LEDGER is unbiased. It shows ~82% win rate BUT that is one 2-day GOLD-SELLOFF`);
console.log(`    window — small n, single regime. The honest signal is the SHAPE: tiny/medium wins +`);
console.log(`    a couple of monster trend-rides (top-3 ~84% of profit), losers cut, counter-trend punished.`);
console.log(`  • Chart entries only DESCRIBE the method: fade-extension entries, scale into the move,`);
console.log(`    wide/trailed stops, BUY Boom / SELL Crash (with the spike), heavy on gold + synthetics.`);
console.log(`  • The edge that survives = trade WITH the dominant move + hold the tail; on random-walk`);
console.log(`    synthetics there is no dominant move to ride, so the same method is ~0 EV (deriv-synthetics.md).`);
