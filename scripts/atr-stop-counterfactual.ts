/**
 * ATR-floored stop-loss counterfactual.
 *
 * For each closed bot_trade we replay forward from the entry bar using the
 * same entry, direction and original TP distance — but the SL is widened to
 *   SL_new_dist = max(SL_orig_dist, k * ATR_14(at_entry))
 * R:R is preserved (TP is moved symmetrically to keep reward/risk ratio).
 *
 * Reports current vs counterfactual: win rate, SL-hit rate, mean R-multiple,
 * fast-stop (≤15 bar) rate. Pure analysis — no strategy logic recreated.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Trade {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  entry_price: number;
  exit_price: number;
  entry_timestamp: number;
  exit_timestamp: number;
  stop_loss: number;
  take_profit: number;
  bars_held: number;
  exit_reason: string;
  pnl_percent: number;
}

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function loadCandles(symbol: string): Candle[] {
  const file = path.resolve(`data/${symbol}_1h.json`);
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Candle[];
  return raw.sort((a, b) => a.timestamp - b.timestamp);
}

function findEntryIndex(candles: Candle[], entryTs: number): number {
  // Binary search — candles are timestamp-sorted ascending.
  // Bot entries timestamp at bar-close; the entry bar is the one whose
  // timestamp matches OR the bar that contains entryTs.
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid]!.timestamp < entryTs) lo = mid + 1;
    else hi = mid;
  }
  if (candles[lo]?.timestamp === entryTs) return lo;
  // Fall back: the largest index with timestamp <= entryTs
  if (lo > 0 && candles[lo - 1]!.timestamp <= entryTs) return lo - 1;
  return -1;
}

function atrAt(candles: Candle[], idx: number, period = 14): number {
  if (idx < period) return 0;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    sum += tr;
  }
  return sum / period;
}

interface Outcome {
  exitReason: 'stop_loss' | 'take_profit' | 'max_bars';
  barsHeld: number;
  pnlR: number;
  exitPrice: number;
}

function simulate(
  candles: Candle[],
  entryIdx: number,
  direction: 'long' | 'short',
  entry: number,
  sl: number,
  tp: number,
  maxBars = 108,
): Outcome {
  const slDist = Math.abs(entry - sl);
  for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + maxBars, candles.length); i++) {
    const c = candles[i]!;
    const barsHeld = i - entryIdx;
    if (direction === 'long') {
      if (c.low <= sl) return { exitReason: 'stop_loss', barsHeld, pnlR: -1, exitPrice: sl };
      if (c.high >= tp) return { exitReason: 'take_profit', barsHeld, pnlR: Math.abs(tp - entry) / slDist, exitPrice: tp };
    } else {
      if (c.high >= sl) return { exitReason: 'stop_loss', barsHeld, pnlR: -1, exitPrice: sl };
      if (c.low <= tp) return { exitReason: 'take_profit', barsHeld, pnlR: Math.abs(entry - tp) / slDist, exitPrice: tp };
    }
  }
  const exitBarIdx = Math.min(entryIdx + maxBars, candles.length - 1);
  const exit = candles[exitBarIdx]!.close;
  const pnl = direction === 'long' ? (exit - entry) : (entry - exit);
  return { exitReason: 'max_bars', barsHeld: exitBarIdx - entryIdx, pnlR: pnl / slDist, exitPrice: exit };
}

interface Stats {
  n: number;
  wins: number;
  winRate: number;
  slHits: number;
  slRate: number;
  fastStops: number; // SL hit in ≤15 bars
  fastStopRate: number;
  meanR: number;
  totalR: number;
  meanBars: number;
}

function summarize(outcomes: Outcome[]): Stats {
  const n = outcomes.length;
  if (n === 0) {
    return { n: 0, wins: 0, winRate: 0, slHits: 0, slRate: 0, fastStops: 0, fastStopRate: 0, meanR: 0, totalR: 0, meanBars: 0 };
  }
  const wins = outcomes.filter((o) => o.pnlR > 0).length;
  const slHits = outcomes.filter((o) => o.exitReason === 'stop_loss').length;
  const fastStops = outcomes.filter((o) => o.exitReason === 'stop_loss' && o.barsHeld <= 15).length;
  const totalR = outcomes.reduce((s, o) => s + o.pnlR, 0);
  const totalBars = outcomes.reduce((s, o) => s + o.barsHeld, 0);
  return {
    n,
    wins,
    winRate: wins / n,
    slHits,
    slRate: slHits / n,
    fastStops,
    fastStopRate: fastStops / n,
    meanR: totalR / n,
    totalR,
    meanBars: totalBars / n,
  };
}

const ATR_MULTIPLIERS = [1.0, 1.5, 2.0, 2.5];

function main(): void {
  const dbPath = path.resolve('data/ict-trading.db');
  const db = new Database(dbPath, { readonly: true });

  const trades = db
    .prepare(
      `SELECT id, symbol, direction, entry_price, exit_price, entry_timestamp, exit_timestamp,
              stop_loss, take_profit, bars_held, exit_reason, pnl_percent
       FROM bot_trades WHERE exit_price IS NOT NULL ORDER BY entry_timestamp ASC`,
    )
    .all() as Trade[];

  console.log(`\nLoaded ${trades.length} closed trades.\n`);

  // Group by symbol so we only load each symbol's candles once
  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol)!.push(t);
  }

  // Compute baseline (actual) outcomes from bot_trades fields
  const baselineBySymbol = new Map<string, Outcome[]>();
  // Counterfactual outcomes per multiplier per symbol
  const cfBySymbol = new Map<string, Map<number, Outcome[]>>();

  for (const [symbol, symbolTrades] of bySymbol) {
    const candles = loadCandles(symbol);
    if (candles.length < 100) {
      console.log(`  ${symbol}: insufficient candles (${candles.length}), skipping`);
      continue;
    }
    const baseline: Outcome[] = [];
    const cfMap = new Map<number, Outcome[]>();
    for (const m of ATR_MULTIPLIERS) cfMap.set(m, []);

    for (const t of symbolTrades) {
      const slDist = Math.abs(t.entry_price - t.stop_loss);
      const tpDist = Math.abs(t.take_profit - t.entry_price);
      const rr = slDist > 0 ? tpDist / slDist : 0;

      // Baseline outcome reconstructed from stored fields
      const baselineR =
        t.exit_reason === 'stop_loss' ? -1
        : t.exit_reason === 'take_profit' ? rr
        : (t.direction === 'long' ? (t.exit_price - t.entry_price) : (t.entry_price - t.exit_price)) / Math.max(slDist, 1e-9);
      baseline.push({
        exitReason: t.exit_reason === 'stop_loss' ? 'stop_loss' : t.exit_reason === 'take_profit' ? 'take_profit' : 'max_bars',
        barsHeld: t.bars_held,
        pnlR: baselineR,
        exitPrice: t.exit_price,
      });

      // Counterfactual: widen SL by ATR; keep R:R constant (move TP proportionally)
      const entryIdx = findEntryIndex(candles, t.entry_timestamp);
      if (entryIdx < 14) continue; // need ATR window
      const atr = atrAt(candles, entryIdx, 14);
      if (atr <= 0) continue;

      for (const mult of ATR_MULTIPLIERS) {
        const newSlDist = Math.max(slDist, atr * mult);
        if (newSlDist <= slDist + 1e-9) {
          // No change — copy baseline
          cfMap.get(mult)!.push(baseline[baseline.length - 1]!);
          continue;
        }
        const newTpDist = newSlDist * rr;
        const newSl = t.direction === 'long' ? t.entry_price - newSlDist : t.entry_price + newSlDist;
        const newTp = t.direction === 'long' ? t.entry_price + newTpDist : t.entry_price - newTpDist;
        const outcome = simulate(candles, entryIdx, t.direction, t.entry_price, newSl, newTp);
        cfMap.get(mult)!.push(outcome);
      }
    }
    baselineBySymbol.set(symbol, baseline);
    cfBySymbol.set(symbol, cfMap);
  }

  db.close();

  // Aggregate report
  const allBaseline: Outcome[] = [];
  const allCf = new Map<number, Outcome[]>();
  for (const m of ATR_MULTIPLIERS) allCf.set(m, []);
  for (const symbol of bySymbol.keys()) {
    allBaseline.push(...(baselineBySymbol.get(symbol) ?? []));
    const cfMap = cfBySymbol.get(symbol);
    if (cfMap) {
      for (const m of ATR_MULTIPLIERS) {
        allCf.get(m)!.push(...(cfMap.get(m) ?? []));
      }
    }
  }

  const printRow = (label: string, s: Stats): void => {
    console.log(
      `${label.padEnd(22)} n=${String(s.n).padStart(4)}  WR=${(s.winRate * 100).toFixed(1).padStart(5)}%  ` +
        `SL%=${(s.slRate * 100).toFixed(1).padStart(5)}%  fastSL%=${(s.fastStopRate * 100).toFixed(1).padStart(5)}%  ` +
        `meanR=${s.meanR.toFixed(3).padStart(7)}  totalR=${s.totalR.toFixed(2).padStart(8)}  meanBars=${s.meanBars.toFixed(1)}`,
    );
  };

  console.log('═'.repeat(120));
  console.log('AGGREGATE (all symbols)');
  console.log('─'.repeat(120));
  printRow('baseline (actual)', summarize(allBaseline));
  for (const m of ATR_MULTIPLIERS) {
    printRow(`ATR-floor ${m.toFixed(1)}x`, summarize(allCf.get(m)!));
  }

  console.log('\n' + '═'.repeat(120));
  console.log('PER-SYMBOL');
  for (const symbol of bySymbol.keys()) {
    console.log('─'.repeat(120));
    console.log(symbol);
    printRow('  baseline', summarize(baselineBySymbol.get(symbol) ?? []));
    for (const m of ATR_MULTIPLIERS) {
      printRow(`  ATR-floor ${m.toFixed(1)}x`, summarize(cfBySymbol.get(symbol)?.get(m) ?? []));
    }
  }
  console.log('═'.repeat(120));
  console.log('\nNote: counterfactual preserves R:R (TP scales with SL).');
  console.log('"fastSL%" = stop hit within 15 bars — the noise-floor diagnostic.\n');
}

main();
