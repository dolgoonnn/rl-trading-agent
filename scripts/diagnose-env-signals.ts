#!/usr/bin/env npx tsx
/** Diagnose: does the WeightOptimizerEnvironment produce trades? */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { WeightOptimizerEnvironment } from '@/lib/rl/environment/weight-optimizer-env';

const candles: Candle[] = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data', 'BTCUSDT_1h.json'), 'utf-8'),
);
console.log(`Loaded ${candles.length} candles`);

// Test with default env config
const env = new WeightOptimizerEnvironment();
env.setData(candles);

// Test multiple start positions with neutral action [0, 0, 0]
const neutralAction = [0, 0, 0];
let totalTrades = 0;
let totalSteps = 0;

for (let startIdx = 500; startIdx < 5000; startIdx += 720) {
  let state = env.reset(startIdx);
  let done = false;
  let epTrades = 0;
  let stepCount = 0;

  while (!done) {
    const result = env.step(neutralAction);
    epTrades += result.info.trades;
    stepCount++;
    state = result.state;
    done = result.done;
  }

  console.log(`Start ${startIdx}: ${epTrades} trades in ${stepCount} steps`);
  totalTrades += epTrades;
  totalSteps += stepCount;
}

console.log(`\nTotal: ${totalTrades} trades across ${totalSteps} steps`);

// Also test with amplified action [0.5, 0.5, 0.5] (boost all weights)
console.log('\n--- Amplified action [0.5, 0.5, 0.5] ---');
const ampAction = [0.5, 0.5, 0.5];
let ampTrades = 0;

for (let startIdx = 500; startIdx < 5000; startIdx += 720) {
  let state = env.reset(startIdx);
  let done = false;
  let epTrades = 0;

  while (!done) {
    const result = env.step(ampAction);
    epTrades += result.info.trades;
    state = result.state;
    done = result.done;
  }

  console.log(`Start ${startIdx}: ${epTrades} trades`);
  ampTrades += epTrades;
}

console.log(`\nTotal amplified: ${ampTrades} trades`);
