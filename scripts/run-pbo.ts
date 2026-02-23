#!/usr/bin/env npx tsx
/**
 * PBO (Probability of Backtest Overfitting) Test
 *
 * Runs multiple configurations through walk-forward and computes PBO
 * using CSCV to estimate overfitting probability.
 *
 * Usage:
 *   npx tsx scripts/run-pbo.ts
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  type ConfluenceConfig,
  type ConfluenceWeights,
} from '../src/lib/rl/strategies/confluence-scorer';
import type { StrategyName, SLPlacementMode } from '../src/lib/rl/strategies/ict-strategies';
import {
  runWalkForward,
  type WalkForwardStrategyRunner,
  type TradeResult,
} from './walk-forward-validate';
import { estimatePBO, type WindowResult } from '../src/lib/rl/utils/pbo';

// ============================================
// Production Config (Broad Run 4 — 7-symbol)
// ============================================

const PROD_WEIGHTS: Partial<ConfluenceWeights> = {
  structureAlignment: 0.1928,
  killZoneActive: 1.2658,
  liquiditySweep: 1.4896,
  obProximity: 2.7262,
  fvgAtCE: 2.3162,
  recentBOS: 2.2229,
  rrRatio: 0.5567,
  oteZone: 1.0621,
  obFvgConfluence: 1.0892,
  momentumConfirmation: 0,
};

const PROD_REGIME_THRESHOLDS: Record<string, number> = {
  'uptrend+high': 3.14,
  'uptrend+normal': 5.74,
  'uptrend+low': 5.49,
  'downtrend+normal': 4.38,
  'downtrend+low': 6.50,
};

const PROD_SUPPRESS = ['ranging+normal', 'ranging+high', 'downtrend+high'];
const PROD_THRESHOLD = 4.05;
const PROD_ATR_EXT = 5.79;
const PROD_HALF_LIFE = 12;
const PROD_COOLDOWN = 7;
const PROD_MAX_BARS = 160;
const PROD_PARTIAL_FRACTION = 0.50;
const PROD_PARTIAL_TRIGGER_R = 1.41;
const PROD_PARTIAL_BE_BUFFER = 0.20;

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

// ============================================
// Config Variants to Test
// ============================================

interface ConfigVariant {
  id: string;
  threshold: number;
  atrExtension: number;
  regimeThresholds: Record<string, number>;
  suppressedRegimes: string[];
  weights: Partial<ConfluenceWeights>;
  halfLife: number;
  cooldown: number;
  maxBars: number;
  partialFraction: number;
  partialTriggerR: number;
  partialBeBuffer: number;
}

function prodVariant(id: string, overrides: Partial<ConfigVariant> = {}): ConfigVariant {
  return {
    id,
    threshold: PROD_THRESHOLD,
    atrExtension: PROD_ATR_EXT,
    regimeThresholds: { ...PROD_REGIME_THRESHOLDS },
    suppressedRegimes: [...PROD_SUPPRESS],
    weights: { ...PROD_WEIGHTS },
    halfLife: PROD_HALF_LIFE,
    cooldown: PROD_COOLDOWN,
    maxBars: PROD_MAX_BARS,
    partialFraction: PROD_PARTIAL_FRACTION,
    partialTriggerR: PROD_PARTIAL_TRIGGER_R,
    partialBeBuffer: PROD_PARTIAL_BE_BUFFER,
    ...overrides,
  };
}

/** Configs spanning the parameter space around production values */
const VARIANTS: ConfigVariant[] = [
  // Production config (Run 20)
  prodVariant('prod'),

  // Threshold variants
  prodVariant('thresh-3.5', { threshold: 3.5 }),
  prodVariant('thresh-4.5', { threshold: 4.5 }),

  // ATR extension variants
  prodVariant('atr-4.5', { atrExtension: 4.5 }),
  prodVariant('atr-6.5', { atrExtension: 6.5 }),

  // No regime thresholds (flat threshold across all regimes)
  prodVariant('no-regime-thresh', { regimeThresholds: {} }),

  // No suppress (allow all regimes)
  prodVariant('no-suppress', { suppressedRegimes: [] }),

  // 2-regime suppress (less filtering)
  prodVariant('2-suppress', { suppressedRegimes: ['ranging+normal', 'ranging+high'] }),
];

// ============================================
// Position Simulation (matching backtest-confluence.ts)
// ============================================

const FRICTION_PER_SIDE = 0.0007;

interface SimulatedPosition {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  direction: 'long' | 'short';
  entryIndex: number;
  entryTimestamp: number;
  strategy: string;
}

function simulatePositionPartialTP(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
  config: ConfigVariant,
): TradeResult | null {
  const friction = FRICTION_PER_SIDE;
  const adjustedEntry = position.direction === 'long'
    ? position.entryPrice * (1 + friction)
    : position.entryPrice * (1 - friction);

  let currentSL = position.stopLoss;
  const riskDistance = position.direction === 'long'
    ? position.entryPrice - position.stopLoss
    : position.stopLoss - position.entryPrice;
  let partialTaken = false;
  let partialPnl = 0;

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;
    const barsHeld = i - position.entryIndex;

    // Check SL/TP
    let exitPrice: number | null = null;
    if (position.direction === 'long') {
      if (candle.low <= currentSL) exitPrice = currentSL;
      else if (candle.high >= position.takeProfit) exitPrice = position.takeProfit;
    } else {
      if (candle.high >= currentSL) exitPrice = currentSL;
      else if (candle.low <= position.takeProfit) exitPrice = position.takeProfit;
    }

    if (exitPrice !== null) {
      const adjustedExit = position.direction === 'long'
        ? exitPrice * (1 - friction)
        : exitPrice * (1 + friction);
      const exitPnl = position.direction === 'long'
        ? (adjustedExit - adjustedEntry) / adjustedEntry
        : (adjustedEntry - adjustedExit) / adjustedEntry;
      const remainingFraction = 1 - config.partialFraction;
      const finalPnl = partialTaken
        ? config.partialFraction * partialPnl + remainingFraction * exitPnl
        : exitPnl;
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent: finalPnl,
        strategy: position.strategy,
      };
    }

    // Partial TP
    if (!partialTaken && riskDistance > 0) {
      const unrealizedR = position.direction === 'long'
        ? (candle.close - position.entryPrice) / riskDistance
        : (position.entryPrice - candle.close) / riskDistance;
      if (unrealizedR >= config.partialTriggerR) {
        partialTaken = true;
        const partialExit = position.direction === 'long'
          ? candle.close * (1 - friction)
          : candle.close * (1 + friction);
        partialPnl = position.direction === 'long'
          ? (partialExit - adjustedEntry) / adjustedEntry
          : (adjustedEntry - partialExit) / adjustedEntry;
        const buffer = riskDistance * config.partialBeBuffer;
        if (position.direction === 'long') {
          currentSL = Math.max(currentSL, position.entryPrice + buffer);
        } else {
          currentSL = Math.min(currentSL, position.entryPrice - buffer);
        }
      }
    }

    // Max bars
    if (barsHeld >= config.maxBars) {
      const adjustedExit = position.direction === 'long'
        ? candle.close * (1 - friction)
        : candle.close * (1 + friction);
      const exitPnl = position.direction === 'long'
        ? (adjustedExit - adjustedEntry) / adjustedEntry
        : (adjustedEntry - adjustedExit) / adjustedEntry;
      const remainingFraction = 1 - config.partialFraction;
      const finalPnl = partialTaken
        ? config.partialFraction * partialPnl + remainingFraction * exitPnl
        : exitPnl;
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent: finalPnl,
        strategy: position.strategy,
      };
    }
  }

  return null;
}

// ============================================
// Runner Factory
// ============================================

function createPBORunner(variant: ConfigVariant): WalkForwardStrategyRunner {
  return {
    name: `PBO-${variant.id}`,
    async run(trainCandles: Candle[], valCandles: Candle[]): Promise<TradeResult[]> {
      const scorerConfig: Partial<ConfluenceConfig> = {
        minThreshold: variant.threshold,
        minSignalRR: 1.5,
        strategyConfig: { slPlacementMode: 'dynamic_rr' as SLPlacementMode },
        activeStrategies: ['order_block'] as StrategyName[],
        suppressedRegimes: variant.suppressedRegimes,
        atrExtensionBands: variant.atrExtension,
        regimeThresholdOverrides: variant.regimeThresholds,
        obFreshnessHalfLife: variant.halfLife,
        cooldownBars: variant.cooldown,
        weights: variant.weights as ConfluenceWeights,
      };
      const scorer = new ConfluenceScorer(scorerConfig);
      const allCandles = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;
      const trades: TradeResult[] = [];
      let currentPosition: SimulatedPosition | null = null;
      let positionExitIndex = -1;

      for (let i = valStartIndex; i < allCandles.length; i++) {
        const candle = allCandles[i];
        if (!candle) continue;
        if (currentPosition !== null && i <= positionExitIndex) continue;
        currentPosition = null;

        const result = scorer.evaluate(allCandles, i);
        if (result.action === 'trade' && result.selectedSignal) {
          const signal = result.selectedSignal.signal;
          const position: SimulatedPosition = {
            entryPrice: signal.entryPrice,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            direction: signal.direction,
            entryIndex: i,
            entryTimestamp: candle.timestamp,
            strategy: signal.strategy,
          };

          const trade = simulatePositionPartialTP(position, allCandles, i + 1, variant);
          if (trade) {
            trades.push(trade);
            let exitIdx = i + 1;
            for (let j = i + 1; j < allCandles.length; j++) {
              const c = allCandles[j];
              if (c && c.timestamp >= trade.exitTimestamp) {
                exitIdx = j;
                break;
              }
            }
            currentPosition = position;
            positionExitIndex = exitIdx;
          }
        }
      }
      return trades;
    },
  };
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  console.log('============================================================');
  console.log('PBO TEST: Probability of Backtest Overfitting');
  console.log('============================================================');
  console.log(`Testing ${VARIANTS.length} config variants on ${SYMBOLS.length} symbols...`);
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log('');

  // Run walk-forward for each variant and collect per-window Sharpe
  const windowResults: WindowResult[] = [];

  for (const variant of VARIANTS) {
    console.log(`Running ${variant.id}...`);
    const runner = createPBORunner(variant);
    const wfResult = await runWalkForward(runner, { symbols: SYMBOLS }, { quiet: true });

    // Collect per-window Sharpe ratios across all symbols
    const windowMetrics: number[] = [];
    for (const symbol of wfResult.symbols) {
      for (const window of symbol.windows) {
        windowMetrics.push(window.sharpe);
      }
    }

    windowResults.push({
      configId: variant.id,
      windowMetrics,
    });

    console.log(`  ${variant.id}: pass rate ${(wfResult.passRate * 100).toFixed(1)}%, ${windowMetrics.length} windows`);
  }

  console.log('');
  console.log('Computing PBO...');

  // Run PBO estimation (random sampling for speed)
  const pboResult = estimatePBO(windowResults, 2000);

  console.log('');
  console.log('============================================================');
  console.log('PBO RESULTS');
  console.log('============================================================');
  console.log(`PBO: ${(pboResult.pbo * 100).toFixed(1)}%`);
  console.log(`Combinations tested: ${pboResult.numCombinations}`);
  console.log(`Overfit combinations: ${pboResult.numOverfit}`);
  console.log(`Avg logit OOS: ${pboResult.avgLogitOOS.toFixed(3)}`);
  console.log(`Passes (PBO < ${pboResult.threshold}): ${pboResult.passes ? 'YES' : 'NO'}`);
  console.log('');

  // Interpretation
  if (pboResult.pbo < 0.25) {
    console.log('Interpretation: STRONG evidence of genuine edge (PBO < 25%)');
  } else if (pboResult.pbo < 0.50) {
    console.log('Interpretation: MODERATE evidence — some overfitting risk but likely real edge');
  } else {
    console.log('Interpretation: HIGH overfitting risk — IS winner unlikely to work OOS');
  }

  // Save results
  const outputPath = path.resolve('experiments/pbo-results-3sym-run20.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    symbols: SYMBOLS,
    variants: VARIANTS.map((v) => v.id),
    pbo: pboResult.pbo,
    numCombinations: pboResult.numCombinations,
    numOverfit: pboResult.numOverfit,
    avgLogitOOS: pboResult.avgLogitOOS,
    passes: pboResult.passes,
  }, null, 2));

  console.log(`\nResults saved to: experiments/pbo-results-3sym-run20.json`);
}

main().catch((err: unknown) => {
  console.error('PBO test failed:', err);
  process.exit(1);
});
