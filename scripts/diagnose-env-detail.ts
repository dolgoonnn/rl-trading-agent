#!/usr/bin/env npx tsx
/** Detailed diagnostic: trace what happens inside the env with different actions */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  WeightOptimizerEnvironment,
  WEIGHT_NAMES,
} from '@/lib/rl/environment/weight-optimizer-env';
import { ConfluenceScorer, PRODUCTION_STRATEGY_CONFIG } from '@/lib/rl/strategies/confluence-scorer';

const candles: Candle[] = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data', 'BTCUSDT_1h.json'), 'utf-8'),
);

const startIdx = 500;

// Direct scorer test: bars 500-520
console.log('=== Direct scorer test (bars 500-520) ===');
const scorer = new ConfluenceScorer({
  activeStrategies: ['order_block'],
  minThreshold: 3.5,
  suppressedRegimes: ['ranging+normal', 'ranging+high'],
  strategyConfig: { ...PRODUCTION_STRATEGY_CONFIG, slPlacementMode: 'dynamic_rr' as const },
});

for (let bar = 500; bar < 524; bar++) {
  const result = scorer.evaluate(candles, bar);
  if (result.action === 'trade' || result.allScored.length > 0) {
    console.log(`Bar ${bar}: action=${result.action}, signals=${result.allScored.length}`);
    for (const s of result.allScored) {
      console.log(`  ${s.signal.strategy} ${s.signal.direction}: score=${s.totalScore.toFixed(2)}`);
      for (const [k, v] of Object.entries(s.factorBreakdown)) {
        if (v > 0) console.log(`    ${k}: ${v.toFixed(3)}`);
      }
    }
  }
}

// Now test with weight multipliers
console.log('\n=== With multipliers (1.5x all) ===');
const mults: Partial<Record<string, number>> = {};
for (const name of WEIGHT_NAMES) mults[name] = 1.5;

for (let bar = 500; bar < 524; bar++) {
  const result = scorer.evaluateWithWeightMultipliers(candles, bar, mults);
  if (result.action === 'trade' || result.allScored.length > 0) {
    console.log(`Bar ${bar}: action=${result.action}, signals=${result.allScored.length}`);
    for (const s of result.allScored) {
      console.log(`  ${s.signal.strategy} ${s.signal.direction}: score=${s.totalScore.toFixed(2)}`);
    }
  }
}

// Full episode comparison: env with neutral vs amplified
console.log('\n=== Full episode test (startIdx=1940 which produced 8 trades) ===');

const env = new WeightOptimizerEnvironment();
env.setData(candles);

// Neutral
let state = env.reset(1940);
let done = false;
let neutralTrades = 0;
let stepNum = 0;
while (!done) {
  const result = env.step([0, 0, 0]);
  if (result.info.trades > 0) {
    console.log(`  Neutral step ${stepNum}: ${result.info.trades} trades, PnL=${(result.info.pnl*100).toFixed(2)}%`);
  }
  neutralTrades += result.info.trades;
  state = result.state;
  done = result.done;
  stepNum++;
}
console.log(`Neutral total: ${neutralTrades} trades`);

// Amplified
state = env.reset(1940);
done = false;
let ampTrades = 0;
stepNum = 0;
while (!done) {
  const result = env.step([0.5, 0.5, 0.5]);
  if (result.info.trades > 0) {
    console.log(`  Amplified step ${stepNum}: ${result.info.trades} trades, PnL=${(result.info.pnl*100).toFixed(2)}%`);
  }
  ampTrades += result.info.trades;
  state = result.state;
  done = result.done;
  stepNum++;
}
console.log(`Amplified total: ${ampTrades} trades`);
