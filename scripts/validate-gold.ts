#!/usr/bin/env npx tsx
/**
 * Gold Model Validation Script
 *
 * Runs PBO, DSR, and Monte Carlo validation on the gold CMA-ES Run 12 config.
 * This is the comprehensive validation gate before paper trading the gold model.
 *
 * Tests:
 *   1. PBO — 8 config variants, 2000 CSCV combinations
 *   2. DSR — Deflated Sharpe correcting for 236 total trials
 *   3. Monte Carlo — Bootstrap, reshuffle, skip trades, parameter perturbation
 *
 * Usage:
 *   npx tsx scripts/validate-gold.ts
 *   npx tsx scripts/validate-gold.ts --skip-perturbation
 *   npx tsx scripts/validate-gold.ts --mc-iterations 2000
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  type ConfluenceConfig,
  type ConfluenceWeights,
  DEFAULT_WEIGHTS,
} from '../src/lib/rl/strategies/confluence-scorer';
import type { StrategyName, SLPlacementMode, AsianRangeGoldConfig } from '../src/lib/rl/strategies/ict-strategies';
import {
  runWalkForward,
  calculateSharpe,
  calculateMaxDrawdown,
  getAnnualizationFactor,
  type WalkForwardStrategyRunner,
  type TradeResult,
  type WalkForwardResult,
} from './walk-forward-validate';
import { estimatePBO, type WindowResult as PBOWindowResult } from '../src/lib/rl/utils/pbo';
import {
  calculateDeflatedSharpe,
  getMinSignificantSharpe,
} from '../src/lib/rl/utils/deflated-sharpe';
import {
  reshuffleTrades,
  bootstrapTrades,
  skipTrades,
  perturbParameters,
} from '../src/lib/rl/utils/monte-carlo';

// ============================================
// Gold Production Config (CMA-ES Expanded Run 1 — 11yr data)
// ============================================

const GOLD_SYMBOLS = ['GC_F'];
const GOLD_FRICTION = 0.0002;
const GOLD_MODEL_PATH = 'models/gold_expanded_run1.json';

/** Final weights = DEFAULT_WEIGHTS[key] * multiplier from bestParams */
const GOLD_WEIGHTS: Partial<ConfluenceWeights> = {
  structureAlignment: 2.4770,
  killZoneActive: 1.5000,
  liquiditySweep: 2.9897,
  obProximity: 0.6314,
  fvgAtCE: 3.0000,
  recentBOS: 2.3975,
  rrRatio: 3.3438,
  oteZone: 0.0398,
  obFvgConfluence: 0.7460,
  momentumConfirmation: 0,
};

const GOLD_REGIME_THRESHOLDS: Record<string, number> = {
  'uptrend+high': 3.99,
  'uptrend+normal': 6.43,
  'uptrend+low': 4.84,
  'downtrend+normal': 4.52,
  'downtrend+low': 6.46,
};

const GOLD_SUPPRESS: string[] = ['ranging+normal', 'ranging+high', 'downtrend+high'];
const GOLD_THRESHOLD = 4.409;
const GOLD_ATR_EXT = 4.99;
const GOLD_HALF_LIFE = 17;
const GOLD_COOLDOWN = 2;
const GOLD_MAX_BARS = 132;
const GOLD_PARTIAL_FRACTION = 0.32;
const GOLD_PARTIAL_TRIGGER_R = 0.50;
const GOLD_PARTIAL_BE_BUFFER = 0.01;

/** Gold-specific Asian range strategy config from Expanded Run 1 */
const GOLD_CONFIG: Partial<AsianRangeGoldConfig> = {
  minRangePct: 0.319,
  minSweepPct: 0.100,
  longBiasMultiplier: 1.22,
  goldVolScale: 0.66,
  targetRR: 1.00,
  displacementMultiple: 1.26,
  sweepLookback: 29,
  fvgSearchWindow: 11,
  ceTolerance: 0.0034,
};

// ============================================
// Trial Counting for DSR
// ============================================

/**
 * DSR trial count includes ALL strategy development trials:
 * - 190 single-param experiments (crypto, but shaped the strategy)
 * - 18 CMA-ES 3-sym crypto runs
 * - 4 CMA-ES broad crypto runs
 * - 4 CMA-ES forex runs (dropped but tried)
 * - 20 CMA-ES gold runs (2yr campaign)
 * - 1 CMA-ES gold expanded run (11yr campaign)
 * Total: 237 independent trials
 */
const TRIAL_COUNTS = {
  singleParamExperiments: 190,
  cmaes3SymRuns: 18,
  cmaesBroadRuns: 4,
  cmaesForexRuns: 4,
  cmaesGoldRuns: 21,
  totalIndependent: 237,
} as const;

// ============================================
// Config Variant (for PBO)
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
  goldConfig: Partial<AsianRangeGoldConfig>;
}

function prodVariant(id: string, overrides: Partial<ConfigVariant> = {}): ConfigVariant {
  return {
    id,
    threshold: GOLD_THRESHOLD,
    atrExtension: GOLD_ATR_EXT,
    regimeThresholds: { ...GOLD_REGIME_THRESHOLDS },
    suppressedRegimes: [...GOLD_SUPPRESS],
    weights: { ...GOLD_WEIGHTS },
    halfLife: GOLD_HALF_LIFE,
    cooldown: GOLD_COOLDOWN,
    maxBars: GOLD_MAX_BARS,
    partialFraction: GOLD_PARTIAL_FRACTION,
    partialTriggerR: GOLD_PARTIAL_TRIGGER_R,
    partialBeBuffer: GOLD_PARTIAL_BE_BUFFER,
    goldConfig: { ...GOLD_CONFIG },
    ...overrides,
  };
}

/** 8 variants spanning the parameter space around gold production */
const PBO_VARIANTS: ConfigVariant[] = [
  prodVariant('prod'),
  prodVariant('thresh-3.9', { threshold: 3.9 }),
  prodVariant('thresh-5.0', { threshold: 5.0 }),
  prodVariant('atr-3.5', { atrExtension: 3.5 }),
  prodVariant('atr-6.0', { atrExtension: 6.0 }),
  prodVariant('no-regime-thresh', { regimeThresholds: {} }),
  prodVariant('halflife-10', { halfLife: 10 }),
  prodVariant('halflife-24', { halfLife: 24 }),
];

// ============================================
// Position Simulation
// ============================================

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
  const friction = GOLD_FRICTION;
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

function createRunner(variant: ConfigVariant): WalkForwardStrategyRunner {
  return {
    name: `Gold-${variant.id}`,
    async run(trainCandles: Candle[], valCandles: Candle[]): Promise<TradeResult[]> {
      const scorerConfig: Partial<ConfluenceConfig> = {
        minThreshold: variant.threshold,
        minSignalRR: 1.5,  // Match backtest-confluence.ts default
        strategyConfig: { slPlacementMode: 'dynamic_rr' as SLPlacementMode },
        activeStrategies: ['asian_range_gold'] as StrategyName[],
        suppressedRegimes: variant.suppressedRegimes,
        atrExtensionBands: variant.atrExtension,
        regimeThresholdOverrides: variant.regimeThresholds,
        obFreshnessHalfLife: variant.halfLife,
        cooldownBars: variant.cooldown,
        weights: variant.weights as ConfluenceWeights,
        goldConfig: { ...variant.goldConfig },
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
// Part 1: PBO Validation
// ============================================

async function runPBOValidation(): Promise<{
  pbo: number;
  numCombinations: number;
  numOverfit: number;
  avgLogitOOS: number;
  passes: boolean;
}> {
  log('');
  log('============================================================');
  log('PART 1: PBO (Probability of Backtest Overfitting)');
  log('============================================================');
  log(`Testing ${PBO_VARIANTS.length} config variants on ${GOLD_SYMBOLS.length} gold symbol...`);
  log(`Symbols: ${GOLD_SYMBOLS.join(', ')}`);
  log('');

  const windowResults: PBOWindowResult[] = [];

  for (const variant of PBO_VARIANTS) {
    log(`  Running ${variant.id}...`);
    const runner = createRunner(variant);
    const wfResult = await runWalkForward(runner, { symbols: [...GOLD_SYMBOLS] }, { quiet: true });

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

    log(`    ${variant.id}: pass rate ${(wfResult.passRate * 100).toFixed(1)}%, ${windowMetrics.length} windows`);
  }

  log('');
  log('Computing PBO (2000 CSCV combinations)...');

  const pboResult = estimatePBO(windowResults, 2000);

  log('');
  log('------------------------------------------------------------');
  log('PBO RESULTS');
  log('------------------------------------------------------------');
  log(`  PBO:                    ${(pboResult.pbo * 100).toFixed(1)}%`);
  log(`  Combinations tested:    ${pboResult.numCombinations}`);
  log(`  Overfit combinations:   ${pboResult.numOverfit}`);
  log(`  Avg logit OOS:          ${pboResult.avgLogitOOS.toFixed(3)}`);
  log(`  Threshold:              25%`);

  const pboPass = pboResult.pbo < 0.25;
  if (pboPass) {
    log(`  Verdict:                \x1b[32mPASS (PBO < 25%)\x1b[0m`);
  } else if (pboResult.pbo < 0.50) {
    log(`  Verdict:                \x1b[33mMARGINAL (25% < PBO < 50%)\x1b[0m`);
  } else {
    log(`  Verdict:                \x1b[31mFAIL (PBO >= 50%)\x1b[0m`);
  }

  return {
    pbo: pboResult.pbo,
    numCombinations: pboResult.numCombinations,
    numOverfit: pboResult.numOverfit,
    avgLogitOOS: pboResult.avgLogitOOS,
    passes: pboPass,
  };
}

// ============================================
// Part 2: DSR Validation
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
  if (returns.length < 4) return 3;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const n = returns.length;
  const m4 = returns.reduce((s, r) => s + (r - mean) ** 4, 0) / n;
  const m2 = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  if (m2 === 0) return 3;
  return m4 / (m2 ** 2);
}

function computeMinBacktestLength(sharpe: number, numTrials: number): number {
  if (sharpe <= 0 || numTrials <= 1) return Infinity;
  const sr2 = sharpe * sharpe;
  return Math.ceil((1 + 0.5 * sr2) * 2 * Math.log(numTrials) / sr2);
}

async function collectTradesAndSharpe(): Promise<{
  trades: TradeResult[];
  sharpe: number;
  passRate: number;
  returns: number[];
  wfResult: WalkForwardResult;
}> {
  const allTrades: TradeResult[] = [];
  const prodConfig = prodVariant('prod');
  const collectingRunner: WalkForwardStrategyRunner = {
    name: 'Gold-DSR-Collect',
    async run(trainCandles: Candle[], valCandles: Candle[], meta?: { symbol?: string }): Promise<TradeResult[]> {
      const baseRunner = createRunner(prodConfig);
      const trades = await baseRunner.run(trainCandles, valCandles, meta);
      allTrades.push(...trades);
      return trades;
    },
  };

  const wfResult = await runWalkForward(
    collectingRunner,
    { symbols: [...GOLD_SYMBOLS] },
    { quiet: true }
  );

  const returns = allTrades.map((t) => t.pnlPercent);
  const annualizationFactor = getAnnualizationFactor(GOLD_SYMBOLS);
  const sharpe = calculateSharpe(returns, annualizationFactor);

  return { trades: allTrades, sharpe, passRate: wfResult.passRate, returns, wfResult };
}

interface DSRResult {
  originalSharpe: number;
  deflatedSharpe: number;
  haircut: number;
  numTrials: number;
  numTrades: number;
  skewness: number;
  kurtosis: number;
  isSignificant: boolean;
  minBacktestLength: number;
  mblPass: boolean;
  minSignificantSharpe: number;
  passRate: number;
}

async function runDSRValidation(tradesData: {
  trades: TradeResult[];
  sharpe: number;
  passRate: number;
  returns: number[];
}): Promise<DSRResult> {
  log('');
  log('============================================================');
  log('PART 2: DEFLATED SHARPE RATIO (DSR)');
  log('============================================================');
  log('');
  log('Trial counting (conservative):');
  log(`  Single-param experiments:  ${TRIAL_COUNTS.singleParamExperiments}`);
  log(`  CMA-ES 3-sym runs:        ${TRIAL_COUNTS.cmaes3SymRuns}`);
  log(`  CMA-ES broad runs:        ${TRIAL_COUNTS.cmaesBroadRuns}`);
  log(`  CMA-ES forex runs:        ${TRIAL_COUNTS.cmaesForexRuns}`);
  log(`  CMA-ES gold runs:         ${TRIAL_COUNTS.cmaesGoldRuns}`);
  log(`  Total independent trials:  ${TRIAL_COUNTS.totalIndependent}`);
  log('');

  const { trades, sharpe, passRate, returns } = tradesData;
  const numTrials = TRIAL_COUNTS.totalIndependent;
  const skewness = calcSkewness(returns);
  const kurtosis = calcKurtosis(returns);

  const annFactor = getAnnualizationFactor(GOLD_SYMBOLS);
  log(`  Trades:    ${trades.length}`);
  log(`  Sharpe:    ${sharpe.toFixed(4)} (per-trade, annualized with factor=${annFactor.toFixed(1)})`);
  log(`  NOTE:      Per-trade Sharpe with ${trades.length} trades over ~11K bars is inflated vs per-bar Sharpe.`);
  log(`             Focus on WR, profit factor, and pass rate for honest assessment.`);
  log(`  Skewness:  ${skewness.toFixed(4)}`);
  log(`  Kurtosis:  ${kurtosis.toFixed(4)}`);
  log('');

  const dsrResult = calculateDeflatedSharpe(sharpe, trades.length, numTrials, {
    skewness,
    kurtosis,
  });

  log(`  Sharpe variance:      ${dsrResult.sharpeVariance.toFixed(6)}`);
  log(`  Haircut:              ${dsrResult.haircut.toFixed(4)}`);
  log(`  Original Sharpe:      ${dsrResult.originalSharpe.toFixed(4)}`);
  log(`  Deflated Sharpe:      ${dsrResult.deflatedSharpe.toFixed(4)}`);
  log(`  Significant (DSR>0):  ${dsrResult.isSignificant ? '\x1b[32mYES\x1b[0m' : '\x1b[31mNO\x1b[0m'}`);
  log('');

  const mbl = computeMinBacktestLength(sharpe, numTrials);
  const mblPass = trades.length >= mbl;
  log(`  Min Backtest Length:  ${mbl} trades`);
  log(`  Actual trades:        ${trades.length}`);
  log(`  MBL check:            ${mblPass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} (have ${trades.length}/${mbl})`);
  log('');

  const minSharpe = getMinSignificantSharpe(numTrials, trades.length);
  log(`  Min significant SR:   ${minSharpe.toFixed(4)}`);
  log(`  Observed SR:          ${sharpe.toFixed(4)}`);
  log(`  Above minimum:        ${sharpe >= minSharpe ? '\x1b[32mYES\x1b[0m' : '\x1b[31mNO\x1b[0m'}`);

  return {
    originalSharpe: sharpe,
    deflatedSharpe: dsrResult.deflatedSharpe,
    haircut: dsrResult.haircut,
    numTrials,
    numTrades: trades.length,
    skewness,
    kurtosis,
    isSignificant: dsrResult.isSignificant,
    minBacktestLength: mbl,
    mblPass,
    minSignificantSharpe: minSharpe,
    passRate,
  };
}

// ============================================
// Part 3: Monte Carlo Validation
// ============================================

interface MCResult {
  totalTrades: number;
  realSharpe: number;
  realMaxDD: number;
  realPnl: number;
  realWinRate: number;
  reshufflePass: boolean;
  bootstrapSharpeP5: number;
  bootstrapSharpePass: boolean;
  bootstrapPnlP5: number;
  bootstrapPnlPass: boolean;
  skip20ProfitPct: number;
  skip20Pass: boolean;
  perturbation?: {
    meanPassRate: number;
    fragilityScore: number;
    fragilityPass: boolean;
  };
  verdict: 'PASS' | 'FAIL';
  verdictDetails: string[];
}

async function runMCValidation(
  tradesData: { trades: TradeResult[]; returns: number[] },
  iterations: number,
  perturbIters: number,
): Promise<MCResult> {
  log('');
  log('============================================================');
  log('PART 3: MONTE CARLO VALIDATION');
  log('============================================================');
  log(`Iterations: ${iterations}`);
  log('');

  const { trades, returns } = tradesData;
  const annualizationFactor = getAnnualizationFactor(GOLD_SYMBOLS);
  const realSharpe = calculateSharpe(returns, annualizationFactor);
  const realMaxDD = calculateMaxDrawdown(returns);
  const realPnl = returns.reduce((eq, r) => eq * (1 + r), 1) - 1;
  const realWinRate = returns.filter((r) => r > 0).length / returns.length;

  log(`Real performance:`);
  log(`  Trades: ${trades.length}`);
  log(`  Sharpe: ${realSharpe.toFixed(3)} (annualization: ${annualizationFactor.toFixed(1)}, gold trading hours)`);
  log(`  MaxDD:  ${(realMaxDD * 100).toFixed(1)}%`);
  log(`  PnL:    ${(realPnl * 100).toFixed(1)}%`);
  log(`  WinRate: ${(realWinRate * 100).toFixed(1)}%`);
  log('');

  // Reshuffle test
  log('--- Reshuffle Test ---');
  const reshuffleResult = reshuffleTrades(trades, iterations, annualizationFactor);
  const reshufflePass = reshuffleResult.finalPnl.pValue <= 0.95;
  log(`  Sharpe Z-score:     ${reshuffleResult.sharpe.zScore.toFixed(3)}`);
  log(`  PnL p-value:        ${reshuffleResult.finalPnl.pValue.toFixed(4)}`);
  log(`  Verdict:            ${reshufflePass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} (no adverse serial correlation)`);
  log('');

  // Bootstrap test
  log('--- Bootstrap Test ---');
  const bootstrapResult = bootstrapTrades(trades, iterations, undefined, annualizationFactor);
  const bootstrapSharpePass = bootstrapResult.sharpe.p5 > 0;
  const bootstrapPnlPass = bootstrapResult.finalPnl.p5 > 0;
  log(`  Sharpe 5th pct:     ${bootstrapResult.sharpe.p5.toFixed(3)} ${bootstrapSharpePass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}`);
  log(`  Sharpe median:      ${bootstrapResult.sharpe.median.toFixed(3)}`);
  log(`  PnL 5th pct:        ${(bootstrapResult.finalPnl.p5 * 100).toFixed(1)}% ${bootstrapPnlPass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}`);
  log(`  PnL median:         ${(bootstrapResult.finalPnl.median * 100).toFixed(1)}%`);
  log(`  WinRate 5th pct:    ${(bootstrapResult.winRate.p5 * 100).toFixed(1)}%`);
  log('');

  // Skip trades test
  log('--- Skip Trades Test ---');
  const skip10 = skipTrades(trades, 0.10, iterations, annualizationFactor);
  const skip20 = skipTrades(trades, 0.20, iterations, annualizationFactor);
  const skip30 = skipTrades(trades, 0.30, iterations, annualizationFactor);
  const skip20Pass = skip20.profitableFraction >= 0.80;
  log(`  Skip 10%: ${(skip10.profitableFraction * 100).toFixed(1)}% profitable, median Sharpe ${skip10.sharpe.median.toFixed(3)}`);
  log(`  Skip 20%: ${(skip20.profitableFraction * 100).toFixed(1)}% profitable, median Sharpe ${skip20.sharpe.median.toFixed(3)} ${skip20Pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}`);
  log(`  Skip 30%: ${(skip30.profitableFraction * 100).toFixed(1)}% profitable, median Sharpe ${skip30.sharpe.median.toFixed(3)}`);
  log('');

  // Parameter perturbation
  let perturbData: MCResult['perturbation'] | undefined;
  if (perturbIters > 0) {
    log('--- Parameter Perturbation Test ---');
    log(`Running ${perturbIters} perturbations (sigma=0.05)...`);

    const modelData = JSON.parse(
      fs.readFileSync(path.resolve(GOLD_MODEL_PATH), 'utf-8')
    ) as { specs: string[]; bestParams: number[] };

    const evaluator = await createPerturbEvaluator(modelData.specs);
    const perturbResult = await perturbParameters(
      modelData.bestParams,
      modelData.specs,
      0.05,
      perturbIters,
      evaluator,
    );

    const fragilityPass = perturbResult.fragilityScore < 0.50;
    perturbData = {
      meanPassRate: perturbResult.passRates.mean,
      fragilityScore: perturbResult.fragilityScore,
      fragilityPass,
    };

    log(`  Mean pass rate:     ${(perturbResult.passRates.mean * 100).toFixed(1)}%`);
    log(`  Fragility:          ${(perturbResult.fragilityScore * 100).toFixed(1)}% ${fragilityPass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}`);
    log(`  5th pct pass rate:  ${(perturbResult.passRates.p5 * 100).toFixed(1)}%`);
    log(`  Median pass rate:   ${(perturbResult.passRates.median * 100).toFixed(1)}%`);
    log('');
  }

  // Verdict
  const verdictDetails: string[] = [];
  let allPass = true;

  if (reshufflePass) {
    verdictDetails.push('PASS: Reshuffle — no adverse serial correlation');
  } else {
    verdictDetails.push('FAIL: Reshuffle — adverse serial correlation detected');
    allPass = false;
  }

  if (bootstrapSharpePass) {
    verdictDetails.push(`PASS: Bootstrap Sharpe 5th pct > 0 (${bootstrapResult.sharpe.p5.toFixed(3)})`);
  } else {
    verdictDetails.push(`FAIL: Bootstrap Sharpe 5th pct <= 0 (${bootstrapResult.sharpe.p5.toFixed(3)})`);
    allPass = false;
  }

  if (bootstrapPnlPass) {
    verdictDetails.push(`PASS: Bootstrap PnL 5th pct > 0 (${(bootstrapResult.finalPnl.p5 * 100).toFixed(1)}%)`);
  } else {
    verdictDetails.push(`FAIL: Bootstrap PnL 5th pct <= 0 (${(bootstrapResult.finalPnl.p5 * 100).toFixed(1)}%)`);
    allPass = false;
  }

  if (skip20Pass) {
    verdictDetails.push(`PASS: Skip 20% profitable in ${(skip20.profitableFraction * 100).toFixed(0)}% of iterations`);
  } else {
    verdictDetails.push(`FAIL: Skip 20% only profitable in ${(skip20.profitableFraction * 100).toFixed(0)}% of iterations`);
    allPass = false;
  }

  if (perturbData) {
    if (perturbData.fragilityPass) {
      verdictDetails.push(`PASS: Parameter fragility ${(perturbData.fragilityScore * 100).toFixed(0)}% (< 50%)`);
    } else {
      verdictDetails.push(`FAIL: Parameter fragility ${(perturbData.fragilityScore * 100).toFixed(0)}% (>= 50%)`);
      allPass = false;
    }
  }

  const verdict = allPass ? 'PASS' as const : 'FAIL' as const;

  return {
    totalTrades: trades.length,
    realSharpe,
    realMaxDD,
    realPnl,
    realWinRate,
    reshufflePass,
    bootstrapSharpeP5: bootstrapResult.sharpe.p5,
    bootstrapSharpePass,
    bootstrapPnlP5: bootstrapResult.finalPnl.p5,
    bootstrapPnlPass,
    skip20ProfitPct: skip20.profitableFraction,
    skip20Pass,
    perturbation: perturbData,
    verdict,
    verdictDetails,
  };
}

// ============================================
// Parameter Perturbation Evaluator
// ============================================

async function createPerturbEvaluator(
  specs: string[],
): Promise<(params: number[]) => Promise<{ passRate: number; pnl: number; trades: number }>> {
  return async (params: number[]) => {
    const decoded = decodeParamsToVariant(params, specs);
    const runner = createRunner(decoded);

    const wfResult = await runWalkForward(
      runner,
      { symbols: [...GOLD_SYMBOLS] },
      { quiet: true },
    );

    const totalPnl = wfResult.symbols.reduce(
      (sum, s) => sum + s.windows.reduce((ws, w) => ws + w.pnl, 0),
      0,
    );
    const totalTrades = wfResult.symbols.reduce(
      (sum, s) => sum + s.windows.reduce((ws, w) => ws + w.trades, 0),
      0,
    );

    return { passRate: wfResult.passRate, pnl: totalPnl, trades: totalTrades };
  };
}

function decodeParamsToVariant(params: number[], specs: string[]): ConfigVariant {
  const weights: Partial<ConfluenceWeights> = {};
  const regimeThresholds: Record<string, number> = {};
  let threshold = GOLD_THRESHOLD;
  let halfLife = GOLD_HALF_LIFE;
  let atrExtension = GOLD_ATR_EXT;
  let partialFraction = GOLD_PARTIAL_FRACTION;
  let partialTriggerR = GOLD_PARTIAL_TRIGGER_R;
  let partialBeBuffer = GOLD_PARTIAL_BE_BUFFER;
  let maxBars = GOLD_MAX_BARS;
  let cooldown = GOLD_COOLDOWN;
  const goldConfig: Partial<AsianRangeGoldConfig> = { ...GOLD_CONFIG };

  for (let i = 0; i < specs.length && i < params.length; i++) {
    const spec = specs[i]!;
    const val = params[i]!;

    if (spec.startsWith('w_')) {
      const wName = spec.replace('w_', '') as keyof ConfluenceWeights;
      weights[wName] = DEFAULT_WEIGHTS[wName] * val;
    } else if (spec.startsWith('t_')) {
      const rLabel = spec.replace('t_', '');
      regimeThresholds[rLabel] = val;
    } else if (spec === 'baseThreshold') {
      threshold = val;
    } else if (spec === 'obFreshnessHalfLife') {
      halfLife = Math.round(val);
    } else if (spec === 'atrExtensionBands') {
      atrExtension = val;
    } else if (spec === 'partialFraction') {
      partialFraction = val;
    } else if (spec === 'partialTriggerR') {
      partialTriggerR = val;
    } else if (spec === 'partialBeBuffer') {
      partialBeBuffer = val;
    } else if (spec === 'maxBars') {
      maxBars = Math.round(val);
    } else if (spec === 'cooldownBars') {
      cooldown = Math.round(val);
    } else if (spec === 'goldMinRangePct') {
      goldConfig.minRangePct = val;
    } else if (spec === 'goldMinSweepPct') {
      goldConfig.minSweepPct = val;
    } else if (spec === 'goldLongBias') {
      goldConfig.longBiasMultiplier = val;
    } else if (spec === 'goldVolScale') {
      goldConfig.goldVolScale = val;
    } else if (spec === 'goldTargetRR') {
      goldConfig.targetRR = val;
    } else if (spec === 'goldDispMult') {
      goldConfig.displacementMultiple = val;
    } else if (spec === 'goldSweepLookback') {
      goldConfig.sweepLookback = Math.round(val);
    } else if (spec === 'goldFvgWindow') {
      goldConfig.fvgSearchWindow = Math.round(val);
    } else if (spec === 'goldCeTolerance') {
      goldConfig.ceTolerance = val;
    }
  }

  return {
    id: 'perturbed',
    threshold,
    atrExtension,
    regimeThresholds,
    suppressedRegimes: [...GOLD_SUPPRESS],
    weights: weights as Partial<ConfluenceWeights>,
    halfLife,
    cooldown,
    maxBars,
    partialFraction,
    partialTriggerR,
    partialBeBuffer,
    goldConfig,
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

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const mcIterations = parseInt(getArg('mc-iterations') ?? '1000', 10);
  const perturbIters = hasFlag('skip-perturbation') ? 0 : parseInt(getArg('perturbation-iters') ?? '100', 10);

  log('============================================================');
  log('GOLD MODEL VALIDATION — CMA-ES Expanded Run 1 (11yr)');
  log('============================================================');
  log(`Symbols: ${GOLD_SYMBOLS.join(', ')}`);
  log(`Friction: ${GOLD_FRICTION} per side`);
  log(`Strategy: asian_range_gold`);
  log(`MC Iterations: ${mcIterations}`);
  log(`Perturbation Iterations: ${perturbIters}`);
  log('');

  // Step 1: Collect trades (reused across DSR + MC)
  log('Collecting walk-forward trades...');
  const tradesData = await collectTradesAndSharpe();
  log(`  ${tradesData.trades.length} trades, Sharpe=${tradesData.sharpe.toFixed(3)}, WF pass rate=${(tradesData.passRate * 100).toFixed(1)}%`);

  // Step 2: PBO
  const pboResult = await runPBOValidation();

  // Step 3: DSR
  const dsrResult = await runDSRValidation(tradesData);

  // Step 4: Monte Carlo
  const mcResult = await runMCValidation(
    { trades: tradesData.trades, returns: tradesData.returns },
    mcIterations,
    perturbIters,
  );

  // ============================================
  // Direction Breakdown
  // ============================================
  log('');
  log('============================================================');
  log('DIRECTION BREAKDOWN (Long vs Short)');
  log('============================================================');
  log('');

  const longTrades = tradesData.trades.filter((t) => t.direction === 'long');
  const shortTrades = tradesData.trades.filter((t) => t.direction === 'short');
  const longWins = longTrades.filter((t) => t.pnlPercent > 0);
  const shortWins = shortTrades.filter((t) => t.pnlPercent > 0);
  const longPnl = longTrades.reduce((eq, t) => eq * (1 + t.pnlPercent), 1) - 1;
  const shortPnl = shortTrades.reduce((eq, t) => eq * (1 + t.pnlPercent), 1) - 1;
  const longAvgPnl = longTrades.length > 0
    ? longTrades.reduce((s, t) => s + t.pnlPercent, 0) / longTrades.length
    : 0;
  const shortAvgPnl = shortTrades.length > 0
    ? shortTrades.reduce((s, t) => s + t.pnlPercent, 0) / shortTrades.length
    : 0;

  // Profit factor: sum of wins / abs(sum of losses)
  const longWinSum = longTrades.filter((t) => t.pnlPercent > 0).reduce((s, t) => s + t.pnlPercent, 0);
  const longLossSum = Math.abs(longTrades.filter((t) => t.pnlPercent <= 0).reduce((s, t) => s + t.pnlPercent, 0));
  const shortWinSum = shortTrades.filter((t) => t.pnlPercent > 0).reduce((s, t) => s + t.pnlPercent, 0);
  const shortLossSum = Math.abs(shortTrades.filter((t) => t.pnlPercent <= 0).reduce((s, t) => s + t.pnlPercent, 0));
  const longPF = longLossSum > 0 ? longWinSum / longLossSum : longWinSum > 0 ? Infinity : 0;
  const shortPF = shortLossSum > 0 ? shortWinSum / shortLossSum : shortWinSum > 0 ? Infinity : 0;

  log(`  Direction  | Trades | % Total | Win Rate | Avg PnL  | PF   | Compounded PnL`);
  log(`  -----------+--------+---------+----------+----------+------+----------------`);
  log(`  Long       | ${longTrades.length.toString().padStart(6)} | ${((longTrades.length / tradesData.trades.length) * 100).toFixed(1).padStart(6)}% | ${(longTrades.length > 0 ? (longWins.length / longTrades.length) * 100 : 0).toFixed(1).padStart(7)}% | ${(longAvgPnl * 100).toFixed(2).padStart(7)}% | ${longPF === Infinity ? ' Inf' : longPF.toFixed(2).padStart(4)} | ${(longPnl * 100).toFixed(1).padStart(13)}%`);
  log(`  Short      | ${shortTrades.length.toString().padStart(6)} | ${((shortTrades.length / tradesData.trades.length) * 100).toFixed(1).padStart(6)}% | ${(shortTrades.length > 0 ? (shortWins.length / shortTrades.length) * 100 : 0).toFixed(1).padStart(7)}% | ${(shortAvgPnl * 100).toFixed(2).padStart(7)}% | ${shortPF === Infinity ? ' Inf' : shortPF.toFixed(2).padStart(4)} | ${(shortPnl * 100).toFixed(1).padStart(13)}%`);
  log('');

  if (longTrades.length > 0 && shortTrades.length > 0) {
    const longBias = longTrades.length / tradesData.trades.length;
    if (longBias > 0.70) {
      log(`  \x1b[33mWARNING: ${(longBias * 100).toFixed(0)}% long bias. Edge may be regime-dependent (bull market).\x1b[0m`);
    } else if (longBias < 0.30) {
      log(`  \x1b[33mWARNING: ${((1 - longBias) * 100).toFixed(0)}% short bias.\x1b[0m`);
    } else {
      log(`  Direction balance: ${(longBias * 100).toFixed(0)}% long / ${((1 - longBias) * 100).toFixed(0)}% short — balanced.`);
    }
  } else if (shortTrades.length === 0) {
    log(`  \x1b[31mWARNING: 100% long trades. Edge is entirely regime-dependent.\x1b[0m`);
  }

  // ============================================
  // Final Scorecard
  // ============================================
  log('');
  log('============================================================');
  log('GOLD VALIDATION SCORECARD');
  log('============================================================');
  log('');

  const checks = [
    {
      name: 'Walk-Forward >60%',
      value: `${(tradesData.passRate * 100).toFixed(1)}%`,
      pass: tradesData.passRate > 0.60,
    },
    {
      name: 'PBO <25%',
      value: `${(pboResult.pbo * 100).toFixed(1)}%`,
      pass: pboResult.passes,
    },
    {
      name: 'DSR >0',
      value: dsrResult.deflatedSharpe.toFixed(2),
      pass: dsrResult.isSignificant,
    },
    {
      name: 'MC Bootstrap Sharpe',
      value: mcResult.bootstrapSharpeP5.toFixed(3),
      pass: mcResult.bootstrapSharpePass,
    },
    {
      name: 'MC Bootstrap PnL',
      value: `${(mcResult.bootstrapPnlP5 * 100).toFixed(1)}%`,
      pass: mcResult.bootstrapPnlPass,
    },
    {
      name: 'MC Skip 20%',
      value: `${(mcResult.skip20ProfitPct * 100).toFixed(0)}%`,
      pass: mcResult.skip20Pass,
    },
  ];

  if (mcResult.perturbation) {
    checks.push({
      name: 'Param Fragility <50%',
      value: `${(mcResult.perturbation.fragilityScore * 100).toFixed(0)}%`,
      pass: mcResult.perturbation.fragilityPass,
    });
  }

  let totalPass = 0;
  let totalChecks = 0;
  for (const check of checks) {
    totalChecks++;
    if (check.pass) totalPass++;
    const color = check.pass ? '\x1b[32m' : '\x1b[31m';
    const label = check.pass ? 'PASS' : 'FAIL';
    log(`  ${check.name.padEnd(22)} ${check.value.padStart(10)}  ${color}${label}\x1b[0m`);
  }

  log('');
  const overallPass = checks.every((c) => c.pass);
  const tradePassOnly = checks.filter((c) => c.name !== 'Param Fragility <50%').every((c) => c.pass);
  if (overallPass) {
    log('\x1b[32m  GOLD MODEL: ALL CHECKS PASS — PAPER TRADE\x1b[0m');
  } else if (tradePassOnly) {
    log('\x1b[33m  GOLD MODEL: TRADE-LEVEL PASS, PARAM FRAGILITY FAIL — PAPER TRADE WITH CAUTION\x1b[0m');
  } else {
    log('\x1b[31m  GOLD MODEL: VALIDATION FAILED — DO NOT PAPER TRADE\x1b[0m');
  }
  log(`  Passed ${totalPass}/${totalChecks} checks`);

  // Save results
  const outputDir = path.resolve('experiments');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const results = {
    config: 'Gold CMA-ES Run 12',
    symbols: GOLD_SYMBOLS,
    friction: GOLD_FRICTION,
    strategy: 'asian_range_gold',
    annualizationFactor: getAnnualizationFactor(GOLD_SYMBOLS),
    walkForward: {
      passRate: tradesData.passRate,
      trades: tradesData.trades.length,
      sharpe: tradesData.sharpe,
      sharpeNote: 'Per-trade Sharpe annualized with gold trading hours factor. May appear inflated vs per-bar Sharpe.',
    },
    directionBreakdown: {
      long: {
        trades: longTrades.length,
        winRate: longTrades.length > 0 ? (longWins.length / longTrades.length) * 100 : 0,
        avgPnl: longAvgPnl,
        compoundedPnl: longPnl,
        profitFactor: longPF === Infinity ? null : longPF,
      },
      short: {
        trades: shortTrades.length,
        winRate: shortTrades.length > 0 ? (shortWins.length / shortTrades.length) * 100 : 0,
        avgPnl: shortAvgPnl,
        compoundedPnl: shortPnl,
        profitFactor: shortPF === Infinity ? null : shortPF,
      },
    },
    pbo: pboResult,
    dsr: dsrResult,
    monteCarlo: mcResult,
    scorecard: checks.map((c) => ({ check: c.name, value: c.value, pass: c.pass })),
    overallPass,
    tradePassOnly,
    timestamp: new Date().toISOString(),
  };

  const outputPath = path.join(outputDir, 'gold-validation-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  log(`\nResults saved to: ${outputPath}`);
}

main().catch((err: unknown) => {
  console.error('Gold validation failed:', err);
  process.exit(1);
});
