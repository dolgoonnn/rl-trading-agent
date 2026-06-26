// scripts/leverage-sweep.ts
import { readFileSync, writeFileSync } from 'node:fs';
import type { Candle } from '../src/types/candle';
import type { TradeTapeEntry, LeverageConfig, LeverageResult } from '../src/lib/scalp/leverage/types';
import { simulateLeverage } from '../src/lib/scalp/leverage/simulator';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  if (i !== -1) {
    const val = process.argv[i + 1];
    if (val !== undefined) return val;
  }
  return def;
}

const tapePath = arg('--tape', 'tape.json');
const grid = arg('--leverage-grid', '1,2,5,10,25,50,100,125').split(',').map(Number).sort((a, b) => a - b);
if (grid.length === 0 || grid.some((n) => !Number.isFinite(n) || n <= 0)) {
  console.error('FATAL: --leverage-grid must be a comma-separated list of positive finite numbers');
  process.exit(1);
}

const marginFraction = Number(arg('--margin-fraction', '1'));
const mmr = Number(arg('--mmr', '0.005'));
const slippageBps = Number(arg('--slippage-bps', '3'));
const fundingRate8h = Number(arg('--funding-rate', '0.0001'));
const ruinThreshold = Number(arg('--ruin-threshold', '0.10'));
const mcIterations = Number(arg('--mc-iterations', '1000'));
const outPath = arg('--out', 'experiments/leverage-sweep.json');

// Validate scalar numeric args
if (!Number.isFinite(marginFraction) || marginFraction <= 0 || marginFraction > 1) {
  console.error('FATAL: --margin-fraction must be a finite number in (0, 1]');
  process.exit(1);
}
if (!Number.isFinite(mmr) || mmr < 0) {
  console.error('FATAL: --mmr must be a finite number >= 0');
  process.exit(1);
}
if (!Number.isFinite(slippageBps) || slippageBps < 0) {
  console.error('FATAL: --slippage-bps must be a finite number >= 0');
  process.exit(1);
}
if (!Number.isFinite(fundingRate8h) || fundingRate8h < 0) {
  console.error('FATAL: --funding-rate must be a finite number >= 0');
  process.exit(1);
}
if (!Number.isFinite(ruinThreshold) || ruinThreshold < 0) {
  console.error('FATAL: --ruin-threshold must be a finite number >= 0');
  process.exit(1);
}
if (!Number.isInteger(mcIterations) || mcIterations <= 0) {
  console.error('FATAL: --mc-iterations must be a positive integer');
  process.exit(1);
}

const tape: TradeTapeEntry[] = JSON.parse(readFileSync(tapePath, 'utf8')) as TradeTapeEntry[];
if (tape.length === 0) { console.error('Empty tape — nothing to simulate.'); process.exit(1); }

// Load 1m candles for each distinct symbol in the tape.
const symbols = [...new Set(tape.map((t) => t.symbol))];
const candlesBySymbol = new Map<string, Candle[]>();
for (const sym of symbols) {
  const path = `data/${sym}_1m.json`;
  try {
    candlesBySymbol.set(sym, JSON.parse(readFileSync(path, 'utf8')) as Candle[]);
  } catch {
    console.error(`FATAL: missing 1m candle file ${path} for symbol ${sym}`);
    process.exit(1);
  }
}

const results: LeverageResult[] = grid.map((leverage) => {
  const cfg: LeverageConfig = { leverage, marginFraction, mmr, slippageBps, fundingRate8h, ruinThreshold, mcIterations };
  return simulateLeverage(tape, candlesBySymbol, cfg);
});

// L* = growth-maximizing; L_ruin = first L with ruinProbability >= 5%.
const star = results.reduce((a, b) => (b.meanLogGrowthPerTrade > a.meanLogGrowthPerTrade ? b : a));
const ruinLevel = results.find((r) => r.ruinProbability >= 0.05);

console.log(`\nTape: ${tape.length} trades across ${symbols.join(', ')} | marginFraction=${marginFraction}, mmr=${mmr}, slippage=${slippageBps}bps\n`);
console.log('   L  | totalReturn |  meanLogG/trade | maxDD | liquidations |  ruin%');
console.log('------|-------------|-----------------|-------|--------------|--------');
for (const r of results) {
  console.log(
    `${String(r.leverage).padStart(5)} | ${(r.totalReturn * 100).toFixed(1).padStart(10)}% | ${r.meanLogGrowthPerTrade.toFixed(6).padStart(15)} | ${(r.maxDrawdown * 100).toFixed(0).padStart(4)}% | ${String(r.liquidations).padStart(12)} | ${(r.ruinProbability * 100).toFixed(1).padStart(5)}%`,
  );
}
console.log(`\nL* (max growth) = ${star.leverage}  |  L_ruin (ruin% >= 5%) = ${ruinLevel ? ruinLevel.leverage : 'none in grid'}`);

// ASCII growth curve.
const maxG = Math.max(...results.map((r) => r.meanLogGrowthPerTrade), 0);
const minG = Math.min(...results.map((r) => r.meanLogGrowthPerTrade), 0);
const span = maxG - minG || 1;
console.log('\nGrowth rate vs leverage (ln-multiplier per trade):');
for (const r of results) {
  const n = Math.round(((r.meanLogGrowthPerTrade - minG) / span) * 40);
  console.log(`${String(r.leverage).padStart(5)} | ${'#'.repeat(Math.max(0, n))}`);
}

writeFileSync(outPath, JSON.stringify({ config: { grid, marginFraction, mmr, slippageBps, fundingRate8h, ruinThreshold, mcIterations }, symbols, tradeCount: tape.length, lStar: star.leverage, lRuin: ruinLevel?.leverage ?? null, results }, null, 2));
console.log(`\nWrote report to ${outPath}`);
