#!/usr/bin/env npx tsx
/**
 * Deflated Sharpe Ratio (DSR) Validation Script
 *
 * Corrects observed Sharpe for selection bias from ~200+ trials conducted
 * during strategy development. Uses the Bailey & de Prado (2014) framework.
 *
 * Trial counting (conservative):
 * - ~190 single-parameter experiments
 * - 18 CMA-ES 3-symbol runs (each run = 1 independent trial, not each generation)
 * - 4 CMA-ES broad runs (7-10 symbol)
 * - Total: ~212 independent trials
 *
 * Also computes Minimum Backtest Length (MBL) — the minimum number of bars
 * needed for the observed Sharpe to be statistically significant.
 *
 * Usage:
 *   npx tsx scripts/validate-dsr.ts
 *   npx tsx scripts/validate-dsr.ts --trials 300
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
  calculateSharpe,
  type WalkForwardStrategyRunner,
  type TradeResult,
} from './walk-forward-validate';
import {
  calculateDeflatedSharpe,
  getMinSignificantSharpe,
} from '../src/lib/rl/utils/deflated-sharpe';

// ============================================
// Trial Counting
// ============================================

/**
 * Conservative trial count following Lopez de Prado's guidance:
 * - CMA-ES population members within a generation share covariance matrix
 *   and are NOT independent trials
 * - Each CMA-ES RUN (not eval) counts as 1 independent trial
 * - Single-parameter experiments are independent
 */
const TRIAL_COUNTS = {
  singleParamExperiments: 190,  // ~190 documented single-parameter experiments
  cmaes3SymRuns: 18,             // Runs 1-18 (each run = 1 trial)
  cmaesBroadRuns: 4,             // Broad Runs 1-4
  totalIndependent: 212,         // Sum of above
} as const;

// ============================================
// Production Configs (same as validate-monte-carlo.ts)
// ============================================

const CONFIG_3SYM = {
  name: '3sym (Run 18)',
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as string[],
  threshold: 4.672,
  atrExtension: 4.10,
  halfLife: 18,
  cooldown: 8,
  maxBars: 108,
  partialFraction: 0.55,
  partialTriggerR: 0.84,
  partialBeBuffer: 0.05,
  suppress: ['ranging+normal', 'ranging+high', 'downtrend+high'] as string[],
  regimeThresholds: {
    'uptrend+high': 2.86,
    'uptrend+normal': 6.17,
    'uptrend+low': 3.13,
    'downtrend+normal': 4.33,
    'downtrend+low': 4.48,
  } as Record<string, number>,
  weights: {
    structureAlignment: 2.660,
    killZoneActive: 0.814,
    liquiditySweep: 1.733,
    obProximity: 1.103,
    fvgAtCE: 1.554,
    recentBOS: 1.255,
    rrRatio: 0.627,
    oteZone: 0.787,
    obFvgConfluence: 1.352,
    momentumConfirmation: 0,
  } as Partial<ConfluenceWeights>,
};

const CONFIG_7SYM = {
  name: '7sym (Broad Run 4)',
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'LINKUSDT', 'DOGEUSDT', 'NEARUSDT', 'ADAUSDT'] as string[],
  threshold: 4.797,
  atrExtension: 2.63,
  halfLife: 19,
  cooldown: 8,
  maxBars: 112,
  partialFraction: 0.44,
  partialTriggerR: 0.94,
  partialBeBuffer: 0.12,
  suppress: ['ranging+normal', 'ranging+high', 'downtrend+high'] as string[],
  regimeThresholds: {
    'uptrend+high': 2.90,
    'uptrend+normal': 5.21,
    'uptrend+low': 2.90,
    'downtrend+normal': 5.20,
    'downtrend+low': 4.16,
  } as Record<string, number>,
  weights: {
    structureAlignment: 2.561,
    killZoneActive: 0.566,
    liquiditySweep: 1.347,
    obProximity: 1.374,
    fvgAtCE: 0.674,
    recentBOS: 1.492,
    rrRatio: 0.294,
    oteZone: 0.610,
    obFvgConfluence: 1.162,
    momentumConfirmation: 0,
  } as Partial<ConfluenceWeights>,
};

type ProdConfig = typeof CONFIG_3SYM;

// ============================================
// Position Simulation (matching run-pbo.ts)
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
  config: { partialFraction: number; partialTriggerR: number; partialBeBuffer: number; maxBars: number },
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

function createRunner(cfg: ProdConfig): WalkForwardStrategyRunner {
  return {
    name: `DSR-${cfg.name}`,
    async run(trainCandles: Candle[], valCandles: Candle[]): Promise<TradeResult[]> {
      const scorerConfig: Partial<ConfluenceConfig> = {
        minThreshold: cfg.threshold,
        minSignalRR: 1.5,
        strategyConfig: { slPlacementMode: 'dynamic_rr' as SLPlacementMode },
        activeStrategies: ['order_block'] as StrategyName[],
        suppressedRegimes: [...cfg.suppress],
        atrExtensionBands: cfg.atrExtension,
        regimeThresholdOverrides: { ...cfg.regimeThresholds },
        obFreshnessHalfLife: cfg.halfLife,
        cooldownBars: cfg.cooldown,
        weights: cfg.weights as ConfluenceWeights,
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

          const trade = simulatePositionPartialTP(position, allCandles, i + 1, cfg);
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
// Trade Collection
// ============================================

async function collectTradesAndSharpe(cfg: ProdConfig): Promise<{
  trades: TradeResult[];
  sharpe: number;
  passRate: number;
  returns: number[];
}> {
  log(`Collecting trades for ${cfg.name}...`);

  const allTrades: TradeResult[] = [];
  const collectingRunner: WalkForwardStrategyRunner = {
    name: `DSR-Collect-${cfg.name}`,
    async run(trainCandles: Candle[], valCandles: Candle[], meta?: { symbol?: string }): Promise<TradeResult[]> {
      const baseRunner = createRunner(cfg);
      const trades = await baseRunner.run(trainCandles, valCandles, meta);
      allTrades.push(...trades);
      return trades;
    },
  };

  const wfResult = await runWalkForward(
    collectingRunner,
    { symbols: cfg.symbols },
    { quiet: true }
  );

  const returns = allTrades.map((t) => t.pnlPercent);
  const sharpe = calculateSharpe(returns);

  log(`  ${allTrades.length} trades, Sharpe=${sharpe.toFixed(3)}, pass rate=${(wfResult.passRate * 100).toFixed(1)}%`);

  return { trades: allTrades, sharpe, passRate: wfResult.passRate, returns };
}

// ============================================
// Higher-order moments for better variance estimate
// ============================================

function calcSkewness(returns: number[]): number {
  if (returns.length < 3) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const n = returns.length;
  const m3 = returns.reduce((s, r) => s + (r - mean) ** 3, 0) / n;
  const m2 = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(m2);
  if (std === 0) return 0;
  return m3 / (std ** 3);
}

function calcKurtosis(returns: number[]): number {
  if (returns.length < 4) return 3; // Normal
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const n = returns.length;
  const m4 = returns.reduce((s, r) => s + (r - mean) ** 4, 0) / n;
  const m2 = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  if (m2 === 0) return 3;
  return m4 / (m2 ** 2);
}

// ============================================
// Minimum Backtest Length (MBL)
// ============================================

/**
 * Compute the minimum number of observations (trades) needed for the given
 * Sharpe ratio to be statistically significant at the given trial count.
 *
 * For DSR > 0: SR > sqrt(Var[SR] * 2 * ln(N))
 * With Var[SR] = (1 + 0.5 * SR^2) / T
 * => SR^2 > (1 + 0.5 * SR^2) * 2 * ln(N) / T
 * => T > (1 + 0.5 * SR^2) * 2 * ln(N) / SR^2
 */
function computeMinBacktestLength(sharpe: number, numTrials: number): number {
  if (sharpe <= 0 || numTrials <= 1) return Infinity;
  const sr2 = sharpe * sharpe;
  return Math.ceil((1 + 0.5 * sr2) * 2 * Math.log(numTrials) / sr2);
}

// ============================================
// DSR Validation
// ============================================

interface DSRValidationResult {
  config: string;
  originalSharpe: number;
  deflatedSharpe: number;
  haircut: number;
  numTrials: number;
  numTrades: number;
  skewness: number;
  kurtosis: number;
  isSignificant: boolean;
  minBacktestLength: number;
  actualObservations: number;
  mblPass: boolean;
  minSignificantSharpe: number;
  passRate: number;
}

async function runDSRValidation(
  cfg: ProdConfig,
  numTrials: number
): Promise<DSRValidationResult> {
  log('');
  log('------------------------------------------------------------');
  log(`DSR VALIDATION: ${cfg.name}`);
  log('------------------------------------------------------------');

  const { trades, sharpe, passRate, returns } = await collectTradesAndSharpe(cfg);

  const skewness = calcSkewness(returns);
  const kurtosis = calcKurtosis(returns);

  log(`  Sharpe:    ${sharpe.toFixed(4)}`);
  log(`  Trades:    ${trades.length}`);
  log(`  Skewness:  ${skewness.toFixed(4)}`);
  log(`  Kurtosis:  ${kurtosis.toFixed(4)}`);
  log('');

  // Compute DSR
  const dsrResult = calculateDeflatedSharpe(sharpe, trades.length, numTrials, {
    skewness,
    kurtosis,
  });

  log(`  Trial count:          ${numTrials}`);
  log(`  Sharpe variance:      ${dsrResult.sharpeVariance.toFixed(6)}`);
  log(`  Haircut:              ${dsrResult.haircut.toFixed(4)}`);
  log(`  Original Sharpe:      ${dsrResult.originalSharpe.toFixed(4)}`);
  log(`  Deflated Sharpe:      ${dsrResult.deflatedSharpe.toFixed(4)}`);
  log(`  Significant (DSR>0):  ${dsrResult.isSignificant ? '\x1b[32mYES\x1b[0m' : '\x1b[31mNO\x1b[0m'}`);
  log('');

  // Minimum Backtest Length
  const mbl = computeMinBacktestLength(sharpe, numTrials);
  const mblPass = trades.length >= mbl;
  log(`  Min Backtest Length:  ${mbl} trades`);
  log(`  Actual trades:        ${trades.length}`);
  log(`  MBL check:            ${mblPass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} (have ${trades.length}/${mbl})`);
  log('');

  // Minimum significant Sharpe
  const minSharpe = getMinSignificantSharpe(numTrials, trades.length);
  const aboveMinSharpe = sharpe >= minSharpe;
  log(`  Min significant SR:   ${minSharpe.toFixed(4)} (for ${numTrials} trials, ${trades.length} trades)`);
  log(`  Observed SR:          ${sharpe.toFixed(4)}`);
  log(`  Above minimum:        ${aboveMinSharpe ? '\x1b[32mYES\x1b[0m' : '\x1b[31mNO\x1b[0m'}`);

  return {
    config: cfg.name,
    originalSharpe: sharpe,
    deflatedSharpe: dsrResult.deflatedSharpe,
    haircut: dsrResult.haircut,
    numTrials,
    numTrades: trades.length,
    skewness,
    kurtosis,
    isSignificant: dsrResult.isSignificant,
    minBacktestLength: mbl,
    actualObservations: trades.length,
    mblPass,
    minSignificantSharpe: minSharpe,
    passRate,
  };
}

// ============================================
// CLI
// ============================================

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function main(): Promise<void> {
  const trialsOverride = getArg('trials');
  const numTrials = trialsOverride ? parseInt(trialsOverride, 10) : TRIAL_COUNTS.totalIndependent;

  log('============================================================');
  log('DEFLATED SHARPE RATIO (DSR) VALIDATION');
  log('============================================================');
  log('');
  log('Trial counting (conservative):');
  log(`  Single-param experiments:  ${TRIAL_COUNTS.singleParamExperiments}`);
  log(`  CMA-ES 3-sym runs:        ${TRIAL_COUNTS.cmaes3SymRuns}`);
  log(`  CMA-ES broad runs:        ${TRIAL_COUNTS.cmaesBroadRuns}`);
  log(`  Total independent trials:  ${numTrials}`);
  log('');
  log('Note: CMA-ES population members within a generation share the');
  log('covariance matrix and are NOT independent. Each CMA-ES RUN');
  log('(not each evaluation) counts as 1 trial.');

  const results: DSRValidationResult[] = [];

  results.push(await runDSRValidation(CONFIG_3SYM, numTrials));
  results.push(await runDSRValidation(CONFIG_7SYM, numTrials));

  // Combined verdict
  log('');
  log('============================================================');
  log('DSR COMBINED VERDICT');
  log('============================================================');
  log('');

  for (const r of results) {
    const dsrPass = r.isSignificant;
    const mblPass = r.mblPass;
    const overallPass = dsrPass && mblPass;
    const color = overallPass ? '\x1b[32m' : '\x1b[31m';

    log(`${r.config}:`);
    log(`  Original Sharpe:  ${r.originalSharpe.toFixed(4)}`);
    log(`  Deflated Sharpe:  ${r.deflatedSharpe.toFixed(4)}`);
    log(`  Haircut:          ${r.haircut.toFixed(4)}`);
    log(`  DSR > 0:          ${dsrPass ? '\x1b[32mYES\x1b[0m' : '\x1b[31mNO\x1b[0m'}`);
    log(`  MBL check:        ${mblPass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}`);
    log(`  ${color}Overall: ${overallPass ? 'PASS' : 'FAIL'}\x1b[0m`);
    log('');
  }

  const allPass = results.every((r) => r.isSignificant && r.mblPass);
  if (allPass) {
    log('\x1b[32m============================================================\x1b[0m');
    log('\x1b[32m  DSR VALIDATION: ALL CONFIGS PASS\x1b[0m');
    log('\x1b[32m============================================================\x1b[0m');
  } else {
    log('\x1b[31m============================================================\x1b[0m');
    log('\x1b[31m  DSR VALIDATION: SOME CONFIGS FAILED\x1b[0m');
    log('\x1b[31m============================================================\x1b[0m');
  }

  // Save results
  const outputDir = path.resolve('experiments');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, 'dsr-results.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    trialCounting: TRIAL_COUNTS,
    numTrialsUsed: numTrials,
    results,
    allPass,
  }, null, 2));
  log(`\nResults saved to: ${outputPath}`);
}

main().catch((err: unknown) => {
  console.error('DSR validation failed:', err);
  process.exit(1);
});
