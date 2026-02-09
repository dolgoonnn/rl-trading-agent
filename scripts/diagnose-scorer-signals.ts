#!/usr/bin/env npx tsx
/** Quick diagnostic: how many signals does the confluence scorer produce? */

import fs from 'fs';
import path from 'path';
import { ConfluenceScorer, PRODUCTION_STRATEGY_CONFIG, type ConfluenceConfig } from '@/lib/rl/strategies/confluence-scorer';
import type { Candle } from '@/types';

const candles: Candle[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'BTCUSDT_1h.json'), 'utf-8'));
console.log(`Loaded ${candles.length} candles`);

// Test sparse range for speed (every 5th bar)
const START = 500;
const END = 3000;
const STEP = 5;

function testConfig(label: string, config: Partial<ConfluenceConfig>): void {
  const scorer = new ConfluenceScorer(config);
  let signals = 0;
  const totalBars = Math.floor((END - START) / STEP);

  for (let i = START; i < END; i += STEP) {
    const result = scorer.evaluate(candles, i);
    if (result.action === 'trade') signals++;
  }

  console.log(`${label.padEnd(45)} → ${signals} signals / ${totalBars} bars (${(signals/totalBars*100).toFixed(1)}%)`);
}

testConfig('Default (threshold=3.5, no suppress)', {
  activeStrategies: ['order_block'],
  minThreshold: 3.5,
  strategyConfig: { ...PRODUCTION_STRATEGY_CONFIG },
});

testConfig('+ regime suppress', {
  activeStrategies: ['order_block'],
  minThreshold: 3.5,
  suppressedRegimes: ['ranging+normal', 'ranging+high'],
  strategyConfig: { ...PRODUCTION_STRATEGY_CONFIG },
});

testConfig('+ dynamic_rr', {
  activeStrategies: ['order_block'],
  minThreshold: 3.5,
  suppressedRegimes: ['ranging+normal', 'ranging+high'],
  strategyConfig: { ...PRODUCTION_STRATEGY_CONFIG, slPlacementMode: 'dynamic_rr' as const },
});

testConfig('Threshold=2.0 (no suppress)', {
  activeStrategies: ['order_block'],
  minThreshold: 2.0,
  strategyConfig: { ...PRODUCTION_STRATEGY_CONFIG },
});

testConfig('Threshold=2.0 + suppress + dynamic_rr', {
  activeStrategies: ['order_block'],
  minThreshold: 2.0,
  suppressedRegimes: ['ranging+normal', 'ranging+high'],
  strategyConfig: { ...PRODUCTION_STRATEGY_CONFIG, slPlacementMode: 'dynamic_rr' as const },
});

testConfig('minConfluence=1, threshold=2.0', {
  activeStrategies: ['order_block'],
  minThreshold: 2.0,
  strategyConfig: { ...PRODUCTION_STRATEGY_CONFIG, minConfluence: 1 },
});

console.log('\nDone.');
