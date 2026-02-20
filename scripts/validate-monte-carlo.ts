#!/usr/bin/env npx tsx
/**
 * Monte Carlo Validation Script
 *
 * Runs Monte Carlo simulations on walk-forward trade results to validate
 * strategy robustness beyond simple pass-rate metrics.
 *
 * Tests:
 * 1. Trade reshuffling — does edge depend on trade ordering?
 * 2. Bootstrap — confidence intervals for performance metrics
 * 3. Trade skipping — robust to missed fills (10%, 20%, 30%)?
 * 4. Parameter perturbation — stable under joint parameter noise?
 *
 * Usage:
 *   npx tsx scripts/validate-monte-carlo.ts --config 3sym
 *   npx tsx scripts/validate-monte-carlo.ts --config 7sym --iterations 2000
 *   npx tsx scripts/validate-monte-carlo.ts --config both --perturbation-iters 100
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
  calculateMaxDrawdown,
  type WalkForwardStrategyRunner,
  type TradeResult,
  type WalkForwardResult,
} from './walk-forward-validate';
import {
  reshuffleTrades,
  bootstrapTrades,
  skipTrades,
  perturbParameters,
  type MCStatistics,
  type SkipTradesResult,
  type PerturbationResult,
} from '../src/lib/rl/utils/monte-carlo';

// ============================================
// Production Configs
// ============================================

// --- 3-symbol (Run 18) ---
const RUN18_WEIGHTS: Partial<ConfluenceWeights> = {
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
};

const RUN18_REGIME_THRESHOLDS: Record<string, number> = {
  'uptrend+high': 2.86,
  'uptrend+normal': 6.17,
  'uptrend+low': 3.13,
  'downtrend+normal': 4.33,
  'downtrend+low': 4.48,
};

interface ProdConfig {
  name: string;
  symbols: string[];
  threshold: number;
  atrExtension: number;
  halfLife: number;
  cooldown: number;
  maxBars: number;
  partialFraction: number;
  partialTriggerR: number;
  partialBeBuffer: number;
  suppress: string[];
  regimeThresholds: Record<string, number>;
  weights: Partial<ConfluenceWeights>;
  modelPath: string;
}

const CONFIG_3SYM: ProdConfig = {
  name: '3sym (Run 18)',
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  threshold: 4.672,
  atrExtension: 4.10,
  halfLife: 18,
  cooldown: 8,
  maxBars: 108,
  partialFraction: 0.55,
  partialTriggerR: 0.84,
  partialBeBuffer: 0.05,
  suppress: ['ranging+normal', 'ranging+high', 'downtrend+high'],
  regimeThresholds: RUN18_REGIME_THRESHOLDS,
  weights: RUN18_WEIGHTS,
  modelPath: 'models/cmaes_run18_escape.json',
};

// --- 7-symbol (Broad Run 4) ---
const BROAD4_WEIGHTS: Partial<ConfluenceWeights> = {
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
};

const BROAD4_REGIME_THRESHOLDS: Record<string, number> = {
  'uptrend+high': 2.90,
  'uptrend+normal': 5.21,
  'uptrend+low': 2.90,
  'downtrend+normal': 5.20,
  'downtrend+low': 4.16,
};

const CONFIG_7SYM: ProdConfig = {
  name: '7sym (Broad Run 4)',
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'LINKUSDT', 'DOGEUSDT', 'NEARUSDT', 'ADAUSDT'],
  threshold: 4.797,
  atrExtension: 2.63,
  halfLife: 19,
  cooldown: 8,
  maxBars: 112,
  partialFraction: 0.44,
  partialTriggerR: 0.94,
  partialBeBuffer: 0.12,
  suppress: ['ranging+normal', 'ranging+high', 'downtrend+high'],
  regimeThresholds: BROAD4_REGIME_THRESHOLDS,
  weights: BROAD4_WEIGHTS,
  modelPath: 'models/cmaes_broad_run4.json',
};

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
// Runner Factory (matching run-pbo.ts pattern)
// ============================================

function createRunner(cfg: ProdConfig): WalkForwardStrategyRunner {
  return {
    name: `MC-${cfg.name}`,
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
// Trade Collection (walk-forward with trade pooling)
// ============================================

async function collectTrades(
  cfg: ProdConfig
): Promise<{ trades: TradeResult[]; wfResult: WalkForwardResult }> {
  log(`Collecting trades for ${cfg.name}...`);

  // We need a custom runner that collects ALL trades across windows
  const allTrades: TradeResult[] = [];

  const collectingRunner: WalkForwardStrategyRunner = {
    name: `MC-Collect-${cfg.name}`,
    async run(trainCandles: Candle[], valCandles: Candle[], meta?: { symbol?: string }): Promise<TradeResult[]> {
      const baseRunner = createRunner(cfg);
      const trades = await baseRunner.run(trainCandles, valCandles, meta);
      allTrades.push(...trades);
      return trades;
    },
  };

  const wfResult = await runWalkForward(
    collectingRunner,
    { symbols: [...cfg.symbols] },
    { quiet: true }
  );

  log(`  Collected ${allTrades.length} trades, WF pass rate: ${(wfResult.passRate * 100).toFixed(1)}%`);
  return { trades: allTrades, wfResult };
}

// ============================================
// Parameter Perturbation Evaluator
// ============================================

async function createPerturbEvaluator(
  cfg: ProdConfig
): Promise<(params: number[]) => Promise<{ passRate: number; pnl: number; trades: number }>> {
  // Load model to get specs for decoding
  const modelData = JSON.parse(
    fs.readFileSync(path.resolve(cfg.modelPath), 'utf-8')
  ) as { specs: string[]; bestParams: number[] };

  const specs = modelData.specs;

  return async (params: number[]) => {
    // Decode params into a config variant
    const decoded = decodeParamsToConfig(params, specs, cfg);

    const runner: WalkForwardStrategyRunner = {
      name: 'MC-Perturb',
      async run(trainCandles: Candle[], valCandles: Candle[]): Promise<TradeResult[]> {
        const scorerConfig: Partial<ConfluenceConfig> = {
          minThreshold: decoded.threshold,
          minSignalRR: 1.5,
          strategyConfig: { slPlacementMode: 'dynamic_rr' as SLPlacementMode },
          activeStrategies: ['order_block'] as StrategyName[],
          suppressedRegimes: [...cfg.suppress],
          atrExtensionBands: decoded.atrExtension,
          regimeThresholdOverrides: { ...decoded.regimeThresholds },
          obFreshnessHalfLife: decoded.halfLife,
          cooldownBars: decoded.cooldown,
          weights: decoded.weights as ConfluenceWeights,
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
            const trade = simulatePositionPartialTP(position, allCandles, i + 1, decoded);
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

    const wfResult = await runWalkForward(
      runner,
      { symbols: [...cfg.symbols] },
      { quiet: true }
    );

    // Compute total PnL and trades from WF results
    const totalPnl = wfResult.symbols.reduce((sum, s) =>
      sum + s.windows.reduce((ws, w) => ws + w.pnl, 0), 0
    );
    const totalTrades = wfResult.symbols.reduce((sum, s) =>
      sum + s.windows.reduce((ws, w) => ws + w.trades, 0), 0
    );

    return { passRate: wfResult.passRate, pnl: totalPnl, trades: totalTrades };
  };
}

// Decode raw CMA-ES parameter vector into a usable config
interface DecodedConfig {
  weights: Partial<ConfluenceWeights>;
  regimeThresholds: Record<string, number>;
  threshold: number;
  halfLife: number;
  atrExtension: number;
  partialFraction: number;
  partialTriggerR: number;
  partialBeBuffer: number;
  maxBars: number;
  cooldown: number;
}

// Import DEFAULT_WEIGHTS for multiplier decoding
import { DEFAULT_WEIGHTS } from '../src/lib/rl/strategies/confluence-scorer';

function decodeParamsToConfig(
  params: number[],
  specs: string[],
  baseCfg: ProdConfig
): DecodedConfig {
  const weights: Partial<ConfluenceWeights> = {};
  const regimeThresholds: Record<string, number> = {};
  let threshold = baseCfg.threshold;
  let halfLife = baseCfg.halfLife;
  let atrExtension = baseCfg.atrExtension;
  let partialFraction = baseCfg.partialFraction;
  let partialTriggerR = baseCfg.partialTriggerR;
  let partialBeBuffer = baseCfg.partialBeBuffer;
  let maxBars = baseCfg.maxBars;
  let cooldown = baseCfg.cooldown;

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
    }
  }

  return {
    weights, regimeThresholds, threshold,
    halfLife, atrExtension,
    partialFraction, partialTriggerR, partialBeBuffer,
    maxBars, cooldown,
  };
}

// ============================================
// Output Formatting
// ============================================

function formatMCStat(label: string, stat: MCStatistics, realValue: number): void {
  const sig = stat.isSignificant ? '\x1b[32mSIGNIFICANT\x1b[0m' : '\x1b[33mNOT SIGNIFICANT\x1b[0m';
  log(`  ${label}:`);
  log(`    Real:       ${realValue.toFixed(4)}`);
  log(`    MC Mean:    ${stat.distribution.mean.toFixed(4)} (std: ${stat.distribution.std.toFixed(4)})`);
  log(`    MC Range:   [${stat.distribution.p5.toFixed(4)}, ${stat.distribution.p95.toFixed(4)}] (5th-95th)`);
  log(`    Z-score:    ${stat.zScore.toFixed(3)}`);
  log(`    P-value:    ${stat.pValue.toFixed(4)}`);
  log(`    Verdict:    ${sig}`);
}

function formatBootstrap(label: string, dist: { mean: number; std: number; p5: number; p25: number; p50?: number; median: number; p75: number; p95: number }): void {
  log(`  ${label}:`);
  log(`    Mean:       ${dist.mean.toFixed(4)} (std: ${dist.std.toFixed(4)})`);
  log(`    5th pct:    ${dist.p5.toFixed(4)}`);
  log(`    25th pct:   ${dist.p25.toFixed(4)}`);
  log(`    Median:     ${dist.median.toFixed(4)}`);
  log(`    75th pct:   ${dist.p75.toFixed(4)}`);
  log(`    95th pct:   ${dist.p95.toFixed(4)}`);
}

function formatSkip(result: SkipTradesResult): void {
  const skipPct = (result.skipRate * 100).toFixed(0);
  log(`  Skip ${skipPct}%:`);
  log(`    Median Sharpe: ${result.sharpe.median.toFixed(3)}`);
  log(`    Median PnL:    ${(result.finalPnl.median * 100).toFixed(1)}%`);
  log(`    Profitable:    ${(result.profitableFraction * 100).toFixed(1)}% of iterations`);
}

// ============================================
// MC Validation Runner
// ============================================

interface MCValidationResult {
  config: string;
  totalTrades: number;
  realSharpe: number;
  realMaxDD: number;
  realPnl: number;
  realWinRate: number;
  realPassRate: number;
  reshuffle: {
    sharpe: { mean: number; std: number; p5: number; p95: number; zScore: number; pValue: number };
    maxDrawdown: { mean: number; std: number; p5: number; p95: number; zScore: number; pValue: number };
    finalPnl: { mean: number; std: number; p5: number; p95: number; zScore: number; pValue: number };
  };
  bootstrap: {
    sharpe: { mean: number; std: number; p5: number; p25: number; median: number; p75: number; p95: number };
    maxDrawdown: { mean: number; std: number; p5: number; p25: number; median: number; p75: number; p95: number };
    finalPnl: { mean: number; std: number; p5: number; p25: number; median: number; p75: number; p95: number };
    winRate: { mean: number; std: number; p5: number; p25: number; median: number; p75: number; p95: number };
  };
  skipTrades: {
    [key: string]: {
      sharpe: { mean: number; median: number; p5: number; p95: number };
      finalPnl: { mean: number; median: number; p5: number; p95: number };
      profitableFraction: number;
    };
  };
  perturbation?: {
    passRates: { mean: number; std: number; p5: number; median: number; p95: number };
    pnls: { mean: number; std: number; p5: number; median: number; p95: number };
    fragilityScore: number;
  };
  verdict: 'PASS' | 'FAIL';
  verdictDetails: string[];
}

async function runMCValidation(
  cfg: ProdConfig,
  iterations: number,
  perturbIters: number
): Promise<MCValidationResult> {
  log('');
  log('============================================================');
  log(`MONTE CARLO VALIDATION: ${cfg.name}`);
  log('============================================================');
  log(`Iterations: ${iterations}`);
  log(`Symbols: ${cfg.symbols.join(', ')}`);
  log('');

  // Step 1: Collect trades via walk-forward
  const { trades, wfResult } = await collectTrades(cfg);

  if (trades.length < 10) {
    log('\x1b[31mInsufficient trades for MC analysis\x1b[0m');
    return {
      config: cfg.name,
      totalTrades: trades.length,
      realSharpe: 0,
      realMaxDD: 0,
      realPnl: 0,
      realWinRate: 0,
      realPassRate: wfResult.passRate,
      reshuffle: {
        sharpe: { mean: 0, std: 0, p5: 0, p95: 0, zScore: 0, pValue: 1 },
        maxDrawdown: { mean: 0, std: 0, p5: 0, p95: 0, zScore: 0, pValue: 1 },
        finalPnl: { mean: 0, std: 0, p5: 0, p95: 0, zScore: 0, pValue: 1 },
      },
      bootstrap: {
        sharpe: { mean: 0, std: 0, p5: 0, p25: 0, median: 0, p75: 0, p95: 0 },
        maxDrawdown: { mean: 0, std: 0, p5: 0, p25: 0, median: 0, p75: 0, p95: 0 },
        finalPnl: { mean: 0, std: 0, p5: 0, p25: 0, median: 0, p75: 0, p95: 0 },
        winRate: { mean: 0, std: 0, p5: 0, p25: 0, median: 0, p75: 0, p95: 0 },
      },
      skipTrades: {},
      verdict: 'FAIL',
      verdictDetails: ['Insufficient trades'],
    };
  }

  const returns = trades.map((t) => t.pnlPercent);
  const realSharpe = calculateSharpe(returns);
  const realMaxDD = calculateMaxDrawdown(returns);
  const realPnl = returns.reduce((eq, r) => eq * (1 + r), 1) - 1;
  const realWinRate = returns.filter((r) => r > 0).length / returns.length;

  log(`Real performance:`);
  log(`  Trades: ${trades.length}`);
  log(`  Sharpe: ${realSharpe.toFixed(3)}`);
  log(`  MaxDD:  ${(realMaxDD * 100).toFixed(1)}%`);
  log(`  PnL:    ${(realPnl * 100).toFixed(1)}%`);
  log(`  WinRate: ${(realWinRate * 100).toFixed(1)}%`);
  log(`  WF Pass Rate: ${(wfResult.passRate * 100).toFixed(1)}%`);
  log('');

  // Step 2: Reshuffle test
  log('--- Reshuffle Test ---');
  const reshuffleResult = reshuffleTrades(trades, iterations);
  formatMCStat('Sharpe', reshuffleResult.sharpe, realSharpe);
  formatMCStat('Max Drawdown', reshuffleResult.maxDrawdown, realMaxDD);
  formatMCStat('Final PnL', reshuffleResult.finalPnl, realPnl);
  log('');

  // Step 3: Bootstrap test
  log('--- Bootstrap Test ---');
  const bootstrapResult = bootstrapTrades(trades, iterations);
  formatBootstrap('Sharpe', bootstrapResult.sharpe);
  formatBootstrap('Max Drawdown', bootstrapResult.maxDrawdown);
  formatBootstrap('Final PnL', bootstrapResult.finalPnl);
  formatBootstrap('Win Rate', bootstrapResult.winRate);
  log('');

  // Step 4: Skip trades test
  log('--- Skip Trades Test ---');
  const skip10 = skipTrades(trades, 0.10, iterations);
  const skip20 = skipTrades(trades, 0.20, iterations);
  const skip30 = skipTrades(trades, 0.30, iterations);
  formatSkip(skip10);
  formatSkip(skip20);
  formatSkip(skip30);
  log('');

  // Step 5: Parameter perturbation (optional)
  let perturbResult: PerturbationResult | undefined;
  if (perturbIters > 0) {
    log('--- Parameter Perturbation Test ---');
    log(`Running ${perturbIters} perturbations (sigma=0.05)...`);

    const modelData = JSON.parse(
      fs.readFileSync(path.resolve(cfg.modelPath), 'utf-8')
    ) as { specs: string[]; bestParams: number[] };

    const evaluator = await createPerturbEvaluator(cfg);
    perturbResult = await perturbParameters(
      modelData.bestParams,
      modelData.specs,
      0.05,
      perturbIters,
      evaluator
    );

    log(`  Pass Rate Distribution:`);
    log(`    Mean:       ${(perturbResult.passRates.mean * 100).toFixed(1)}%`);
    log(`    Std:        ${(perturbResult.passRates.std * 100).toFixed(1)}pp`);
    log(`    5th pct:    ${(perturbResult.passRates.p5 * 100).toFixed(1)}%`);
    log(`    Median:     ${(perturbResult.passRates.median * 100).toFixed(1)}%`);
    log(`    95th pct:   ${(perturbResult.passRates.p95 * 100).toFixed(1)}%`);
    log(`  Fragility:    ${(perturbResult.fragilityScore * 100).toFixed(1)}% of perturbations dropped > 5pp`);
    log('');
  }

  // Step 6: Verdict
  const verdictDetails: string[] = [];
  let allPass = true;

  // Reshuffle: edge should NOT depend heavily on ordering
  // For Sharpe, reshuffling preserves mean return but changes sequence
  // We mainly check that real performance is not anomalously dependent on order
  // A low p-value for reshuffle Sharpe means order matters (could be good or bad)
  // The KEY insight: PnL should be similar regardless of order for a non-serial-correlated strategy
  if (reshuffleResult.finalPnl.pValue > 0.95) {
    verdictDetails.push('WARN: Real PnL significantly WORSE than reshuffled (serial correlation hurts)');
  } else {
    verdictDetails.push('PASS: Reshuffle PnL consistent (no adverse serial correlation)');
  }

  // Bootstrap: 5th percentile Sharpe should be > 0
  if (bootstrapResult.sharpe.p5 > 0) {
    verdictDetails.push(`PASS: Bootstrap Sharpe 5th percentile > 0 (${bootstrapResult.sharpe.p5.toFixed(3)})`);
  } else {
    verdictDetails.push(`FAIL: Bootstrap Sharpe 5th percentile <= 0 (${bootstrapResult.sharpe.p5.toFixed(3)})`);
    allPass = false;
  }

  // Bootstrap: 5th percentile PnL should be > 0
  if (bootstrapResult.finalPnl.p5 > 0) {
    verdictDetails.push(`PASS: Bootstrap PnL 5th percentile > 0 (${(bootstrapResult.finalPnl.p5 * 100).toFixed(1)}%)`);
  } else {
    verdictDetails.push(`FAIL: Bootstrap PnL 5th percentile <= 0 (${(bootstrapResult.finalPnl.p5 * 100).toFixed(1)}%)`);
    allPass = false;
  }

  // Skip 20%: should still be profitable in > 80% of iterations
  if (skip20.profitableFraction >= 0.80) {
    verdictDetails.push(`PASS: Skip 20% still profitable in ${(skip20.profitableFraction * 100).toFixed(0)}% of iterations`);
  } else {
    verdictDetails.push(`FAIL: Skip 20% only profitable in ${(skip20.profitableFraction * 100).toFixed(0)}% of iterations`);
    allPass = false;
  }

  // Parameter perturbation: fragility < 50%
  if (perturbResult) {
    if (perturbResult.fragilityScore < 0.50) {
      verdictDetails.push(`PASS: Parameter fragility ${(perturbResult.fragilityScore * 100).toFixed(0)}% (< 50%)`);
    } else {
      verdictDetails.push(`FAIL: Parameter fragility ${(perturbResult.fragilityScore * 100).toFixed(0)}% (>= 50%)`);
      allPass = false;
    }
  }

  const verdict = allPass ? 'PASS' : 'FAIL';

  log('============================================================');
  log('VERDICT');
  log('============================================================');
  for (const detail of verdictDetails) {
    const color = detail.startsWith('PASS') ? '\x1b[32m' : detail.startsWith('WARN') ? '\x1b[33m' : '\x1b[31m';
    log(`  ${color}${detail}\x1b[0m`);
  }
  log('');
  const verdictColor = verdict === 'PASS' ? '\x1b[32m' : '\x1b[31m';
  log(`  ${verdictColor}MONTE CARLO VERDICT: ${verdict}\x1b[0m`);
  log('');

  // Build serializable result
  const distToJson = (d: { mean: number; std: number; p5: number; p25: number; median: number; p75: number; p95: number }) => ({
    mean: d.mean, std: d.std, p5: d.p5, p25: d.p25, median: d.median, p75: d.p75, p95: d.p95,
  });
  const statToJson = (s: MCStatistics) => ({
    mean: s.distribution.mean, std: s.distribution.std,
    p5: s.distribution.p5, p95: s.distribution.p95,
    zScore: s.zScore, pValue: s.pValue,
  });

  return {
    config: cfg.name,
    totalTrades: trades.length,
    realSharpe,
    realMaxDD,
    realPnl,
    realWinRate,
    realPassRate: wfResult.passRate,
    reshuffle: {
      sharpe: statToJson(reshuffleResult.sharpe),
      maxDrawdown: statToJson(reshuffleResult.maxDrawdown),
      finalPnl: statToJson(reshuffleResult.finalPnl),
    },
    bootstrap: {
      sharpe: distToJson(bootstrapResult.sharpe),
      maxDrawdown: distToJson(bootstrapResult.maxDrawdown),
      finalPnl: distToJson(bootstrapResult.finalPnl),
      winRate: distToJson(bootstrapResult.winRate),
    },
    skipTrades: {
      '10pct': {
        sharpe: { mean: skip10.sharpe.mean, median: skip10.sharpe.median, p5: skip10.sharpe.p5, p95: skip10.sharpe.p95 },
        finalPnl: { mean: skip10.finalPnl.mean, median: skip10.finalPnl.median, p5: skip10.finalPnl.p5, p95: skip10.finalPnl.p95 },
        profitableFraction: skip10.profitableFraction,
      },
      '20pct': {
        sharpe: { mean: skip20.sharpe.mean, median: skip20.sharpe.median, p5: skip20.sharpe.p5, p95: skip20.sharpe.p95 },
        finalPnl: { mean: skip20.finalPnl.mean, median: skip20.finalPnl.median, p5: skip20.finalPnl.p5, p95: skip20.finalPnl.p95 },
        profitableFraction: skip20.profitableFraction,
      },
      '30pct': {
        sharpe: { mean: skip30.sharpe.mean, median: skip30.sharpe.median, p5: skip30.sharpe.p5, p95: skip30.sharpe.p95 },
        finalPnl: { mean: skip30.finalPnl.mean, median: skip30.finalPnl.median, p5: skip30.finalPnl.p5, p95: skip30.finalPnl.p95 },
        profitableFraction: skip30.profitableFraction,
      },
    },
    perturbation: perturbResult ? {
      passRates: {
        mean: perturbResult.passRates.mean,
        std: perturbResult.passRates.std,
        p5: perturbResult.passRates.p5,
        median: perturbResult.passRates.median,
        p95: perturbResult.passRates.p95,
      },
      pnls: {
        mean: perturbResult.pnls.mean,
        std: perturbResult.pnls.std,
        p5: perturbResult.pnls.p5,
        median: perturbResult.pnls.median,
        p95: perturbResult.pnls.p95,
      },
      fragilityScore: perturbResult.fragilityScore,
    } : undefined,
    verdict,
    verdictDetails,
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
  const configArg = getArg('config') ?? 'both';
  const iterations = parseInt(getArg('iterations') ?? '1000', 10);
  const perturbIters = parseInt(getArg('perturbation-iters') ?? '0', 10);

  log('============================================================');
  log('MONTE CARLO VALIDATION');
  log('============================================================');
  log(`Config: ${configArg}`);
  log(`MC Iterations: ${iterations}`);
  log(`Perturbation Iterations: ${perturbIters}`);
  log('');

  const results: MCValidationResult[] = [];

  if (configArg === '3sym' || configArg === 'both') {
    results.push(await runMCValidation(CONFIG_3SYM, iterations, perturbIters));
  }

  if (configArg === '7sym' || configArg === 'both') {
    results.push(await runMCValidation(CONFIG_7SYM, iterations, perturbIters));
  }

  // Save results
  const outputDir = path.resolve('experiments');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `monte-carlo-results-${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  log(`Results saved to: ${outputPath}`);

  // Also save as latest
  const latestPath = path.join(outputDir, 'monte-carlo-results.json');
  fs.writeFileSync(latestPath, JSON.stringify(results, null, 2));

  // Combined summary
  if (results.length > 1) {
    log('');
    log('============================================================');
    log('COMBINED SUMMARY');
    log('============================================================');
    for (const r of results) {
      const color = r.verdict === 'PASS' ? '\x1b[32m' : '\x1b[31m';
      log(`  ${r.config}: ${color}${r.verdict}\x1b[0m (${r.totalTrades} trades, Sharpe=${r.realSharpe.toFixed(3)})`);
    }
    const allPass = results.every((r) => r.verdict === 'PASS');
    log('');
    if (allPass) {
      log('\x1b[32m  ALL CONFIGS PASS MONTE CARLO VALIDATION\x1b[0m');
    } else {
      log('\x1b[31m  SOME CONFIGS FAILED MONTE CARLO VALIDATION\x1b[0m');
    }
  }
}

main().catch((err: unknown) => {
  console.error('Monte Carlo validation failed:', err);
  process.exit(1);
});
