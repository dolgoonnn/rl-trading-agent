#!/usr/bin/env npx tsx
/**
 * Evaluate Weight Optimizer (PPO) vs Static Baseline
 *
 * Runs walk-forward validation with two runners:
 *   1. Static baseline (fixed production weights)
 *   2. PPO-optimized (regime-adaptive weight multipliers)
 *
 * The PPO model adjusts weights every 24 bars based on regime context.
 * Uses deterministic policy (means only, no exploration noise).
 *
 * Usage:
 *   npx tsx scripts/eval-weight-optimizer.ts --model models/weight_optimizer_best.json
 *   npx tsx scripts/eval-weight-optimizer.ts --model models/weight_optimizer_latest.json --symbols BTC
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import type { SerializedWeights } from '../src/lib/rl/agent/base-agent';
import { ContinuousPPOAgent } from '../src/lib/rl/agent/continuous-ppo-agent';
import {
  ConfluenceScorer,
  type ConfluenceConfig,
  type ConfluenceWeights,
  PRODUCTION_STRATEGY_CONFIG,
} from '../src/lib/rl/strategies/confluence-scorer';
import {
  WEIGHT_NAMES,
  COMPACT_ACTION_SIZE,
  STATE_SIZE,
} from '../src/lib/rl/environment/weight-optimizer-env';
import {
  detectRegime,
  regimeLabel,
  type MarketRegime,
} from '@/lib/ict';
import {
  runWalkForward,
  type WalkForwardStrategyRunner,
  type TradeResult,
  type WalkForwardConfig,
} from './walk-forward-validate';

// ============================================
// CLI
// ============================================

interface EvalConfig {
  modelPath: string;
  symbols: string[];
  timeframe: string;
  decisionInterval: number;
  threshold: number;
  suppressedRegimes: string[];
  obFreshnessHalfLife: number;
  atrExtensionBands: number;
  multiplierScale: number;
  friction: number;
}

function parseArgs(): EvalConfig {
  const args = process.argv.slice(2);
  const config: EvalConfig = {
    modelPath: path.join(process.cwd(), 'models', 'weight_optimizer_best.json'),
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    timeframe: '1h',
    decisionInterval: 24,
    threshold: 3.5,
    suppressedRegimes: ['ranging+normal', 'ranging+high', 'downtrend+high'],
    obFreshnessHalfLife: 15,
    atrExtensionBands: 3.0,
    multiplierScale: 0.7,
    friction: 0.0007, // Maker: 0.05% + 0.02% slippage per side
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--model':
        config.modelPath = args[++i] ?? config.modelPath;
        break;
      case '--symbols':
        config.symbols = (args[++i] ?? 'BTCUSDT').split(',').map((s) => {
          const upper = s.toUpperCase().trim();
          return upper.endsWith('USDT') ? upper : `${upper}USDT`;
        });
        break;
      case '--threshold':
        config.threshold = parseFloat(args[++i] ?? '3.5');
        break;
      case '--decision-interval':
        config.decisionInterval = parseInt(args[++i] ?? '24', 10);
        break;
    }
  }

  return config;
}

// ============================================
// Regime State Builder (matching weight-optimizer-env)
// ============================================

function buildRegimeState(candles: Candle[], currentIndex: number): number[] {
  const features: number[] = [];

  // Regime features (6)
  let regime: MarketRegime | null = null;
  if (currentIndex >= 50 && currentIndex < candles.length) {
    try {
      regime = detectRegime(candles, currentIndex);
    } catch {
      regime = null;
    }
  }

  // Trend encoding
  if (!regime) {
    features.push(0);
  } else {
    const label = regimeLabel(regime);
    features.push(label.startsWith('uptrend') ? 1 : label.startsWith('downtrend') ? -1 : 0);
  }

  // Volatility encoding
  if (!regime) {
    features.push(0.5);
  } else {
    const label = regimeLabel(regime);
    features.push(label.endsWith('+high') ? 1 : label.endsWith('+low') ? 0 : 0.5);
  }

  features.push(regime?.trendStrength ?? 0);
  features.push(regime?.efficiency ?? 0);
  features.push(regime?.atrPercentile ?? 0.5);
  features.push(regime ? (regime.atrPercentile > 0.7 ? 1 : 0) : 0);

  // Order flow features (4) — zeros (no predictive power proven)
  features.push(0, 0, 0, 0);

  // Performance features (4) — initialized to neutral
  features.push(0, 0, 0, 0);

  return features;
}

function clamp(v: number, min: number, max: number): number {
  if (!isFinite(v)) return 0;
  return Math.max(min, Math.min(max, v));
}

// ============================================
// PPO-Enhanced Runner
// ============================================

function createPPORunner(
  agent: ContinuousPPOAgent,
  config: EvalConfig,
): WalkForwardStrategyRunner {
  return {
    name: `PPO-WeightOptimizer(interval=${config.decisionInterval})`,

    async run(
      trainCandles: Candle[],
      valCandles: Candle[],
      _meta?: { symbol?: string },
    ): Promise<TradeResult[]> {
      const scorerConfig: Partial<ConfluenceConfig> = {
        minThreshold: config.threshold,
        activeStrategies: ['order_block'],
        suppressedRegimes: config.suppressedRegimes,
        obFreshnessHalfLife: config.obFreshnessHalfLife,
        atrExtensionBands: config.atrExtensionBands,
        strategyConfig: {
          ...PRODUCTION_STRATEGY_CONFIG,
          slPlacementMode: 'dynamic_rr' as const,
        },
      };

      const scorer = new ConfluenceScorer(scorerConfig);
      const allCandles = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;
      const friction = config.friction;

      const trades: TradeResult[] = [];
      let currentPosition: {
        side: 'long' | 'short';
        entryPrice: number;
        entryTimestamp: number;
        stopLoss: number;
        takeProfit: number;
        entryBar: number;
        strategy?: string;
      } | null = null;

      // PPO state tracking
      let currentMultipliers: Partial<Record<keyof ConfluenceWeights, number>> = {};
      let rollingWinRate = 0.5;
      let rollingPnL = 0;
      let recentTrades: { pnl: number; won: boolean }[] = [];
      let maxEquity = 1;
      let currentEquity = 1;
      let currentDrawdown = 0;
      let lastDecisionBar = valStartIndex;

      // Initialize multipliers to 1.0
      for (const name of WEIGHT_NAMES) {
        currentMultipliers[name] = 1.0;
      }

      for (let i = valStartIndex; i < allCandles.length; i++) {
        const candle = allCandles[i];
        if (!candle) continue;

        // PPO decision point: update weight multipliers
        if (i - lastDecisionBar >= config.decisionInterval || i === valStartIndex) {
          // Build state
          const regimeFeatures = buildRegimeState(allCandles, i);

          // Update performance features (last 4)
          regimeFeatures[10] = clamp((rollingWinRate - 0.5) * 4, -1, 1);
          regimeFeatures[11] = clamp(rollingPnL * 10, -1, 1);
          regimeFeatures[12] = clamp(-currentDrawdown * 5, -1, 0);
          regimeFeatures[13] = clamp(recentTrades.length / 20, 0, 1);

          // Get deterministic action from PPO
          const action = agent.selectAction(regimeFeatures, false);

          // Map 3 compact actions → 10 weight multipliers
          const globalRaw = Math.max(-1, Math.min(1, action[0]!));
          const structRaw = Math.max(-1, Math.min(1, action[1]!));
          const proxRaw = Math.max(-1, Math.min(1, action[2]!));

          const scale = config.multiplierScale;
          const globalMult = Math.exp(globalRaw * scale);
          const structMult = Math.exp(structRaw * scale * 0.5);
          const proxMult = Math.exp(proxRaw * scale * 0.5);

          for (const name of WEIGHT_NAMES) {
            let mult = globalMult;
            if (['structureAlignment', 'recentBOS', 'killZoneActive'].includes(name)) {
              mult *= structMult;
            } else if (['obProximity', 'fvgAtCE', 'oteZone', 'breakerConfluence', 'obFvgConfluence'].includes(name)) {
              mult *= proxMult;
            }
            currentMultipliers[name] = mult;
          }

          lastDecisionBar = i;
        }

        // Check exit for open position
        if (currentPosition) {
          const pos = currentPosition;
          const barsHeld = i - pos.entryBar;

          const slHit = pos.side === 'long'
            ? candle.low <= pos.stopLoss
            : candle.high >= pos.stopLoss;
          const tpHit = pos.side === 'long'
            ? candle.high >= pos.takeProfit
            : candle.low <= pos.takeProfit;
          const maxBars = barsHeld >= 72;

          let exitPrice: number | null = null;
          if (slHit) exitPrice = pos.stopLoss;
          else if (tpHit) exitPrice = pos.takeProfit;
          else if (maxBars) exitPrice = candle.close;

          if (exitPrice !== null) {
            // Apply exit friction
            exitPrice = pos.side === 'long'
              ? exitPrice * (1 - friction)
              : exitPrice * (1 + friction);

            const pnl = pos.side === 'long'
              ? (exitPrice - pos.entryPrice) / pos.entryPrice
              : (pos.entryPrice - exitPrice) / pos.entryPrice;

            trades.push({
              entryTimestamp: pos.entryTimestamp,
              exitTimestamp: candle.timestamp,
              direction: pos.side,
              entryPrice: pos.entryPrice,
              exitPrice,
              pnlPercent: pnl,
              strategy: pos.strategy,
            });

            // Update rolling stats
            recentTrades.push({ pnl, won: pnl > 0 });
            if (recentTrades.length > 50) recentTrades.shift();
            rollingWinRate = recentTrades.filter(t => t.won).length / recentTrades.length;
            rollingPnL = recentTrades.reduce((s, t) => s + t.pnl, 0);
            currentEquity *= (1 + pnl * 0.1);
            if (currentEquity > maxEquity) maxEquity = currentEquity;
            currentDrawdown = (maxEquity - currentEquity) / maxEquity;

            currentPosition = null;
          }

          if (currentPosition) continue; // Still in position
        }

        // Check for new entry
        const result = scorer.evaluateWithWeightMultipliers(
          allCandles,
          i,
          currentMultipliers,
        );

        if (result.action === 'trade' && result.selectedSignal) {
          const sig = result.selectedSignal.signal;
          const entryPrice = sig.direction === 'long'
            ? sig.entryPrice * (1 + friction)
            : sig.entryPrice * (1 - friction);

          currentPosition = {
            side: sig.direction,
            entryPrice,
            entryTimestamp: candle.timestamp,
            stopLoss: sig.stopLoss,
            takeProfit: sig.takeProfit,
            entryBar: i,
            strategy: sig.strategy,
          };
        }
      }

      return trades;
    },
  };
}

// ============================================
// Static Baseline Runner (matches production config)
// ============================================

function createStaticRunner(config: EvalConfig): WalkForwardStrategyRunner {
  return {
    name: `StaticBaseline(threshold=${config.threshold})`,

    async run(
      trainCandles: Candle[],
      valCandles: Candle[],
      _meta?: { symbol?: string },
    ): Promise<TradeResult[]> {
      const scorerConfig: Partial<ConfluenceConfig> = {
        minThreshold: config.threshold,
        activeStrategies: ['order_block'],
        suppressedRegimes: config.suppressedRegimes,
        obFreshnessHalfLife: config.obFreshnessHalfLife,
        atrExtensionBands: config.atrExtensionBands,
        strategyConfig: {
          ...PRODUCTION_STRATEGY_CONFIG,
          slPlacementMode: 'dynamic_rr' as const,
        },
      };

      const scorer = new ConfluenceScorer(scorerConfig);
      const allCandles = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;
      const friction = config.friction;

      const trades: TradeResult[] = [];
      let currentPosition: {
        side: 'long' | 'short';
        entryPrice: number;
        entryTimestamp: number;
        stopLoss: number;
        takeProfit: number;
        entryBar: number;
        strategy?: string;
      } | null = null;

      for (let i = valStartIndex; i < allCandles.length; i++) {
        const candle = allCandles[i];
        if (!candle) continue;

        // Check exit
        if (currentPosition) {
          const pos = currentPosition;
          const barsHeld = i - pos.entryBar;

          const slHit = pos.side === 'long'
            ? candle.low <= pos.stopLoss
            : candle.high >= pos.stopLoss;
          const tpHit = pos.side === 'long'
            ? candle.high >= pos.takeProfit
            : candle.low <= pos.takeProfit;
          const maxBars = barsHeld >= 72;

          let exitPrice: number | null = null;
          if (slHit) exitPrice = pos.stopLoss;
          else if (tpHit) exitPrice = pos.takeProfit;
          else if (maxBars) exitPrice = candle.close;

          if (exitPrice !== null) {
            exitPrice = pos.side === 'long'
              ? exitPrice * (1 - friction)
              : exitPrice * (1 + friction);

            const pnl = pos.side === 'long'
              ? (exitPrice - pos.entryPrice) / pos.entryPrice
              : (pos.entryPrice - exitPrice) / pos.entryPrice;

            trades.push({
              entryTimestamp: pos.entryTimestamp,
              exitTimestamp: candle.timestamp,
              direction: pos.side,
              entryPrice: pos.entryPrice,
              exitPrice,
              pnlPercent: pnl,
              strategy: pos.strategy,
            });

            currentPosition = null;
          }

          if (currentPosition) continue;
        }

        // Check entry
        const result = scorer.evaluate(allCandles, i);

        if (result.action === 'trade' && result.selectedSignal) {
          const sig = result.selectedSignal.signal;
          const entryPrice = sig.direction === 'long'
            ? sig.entryPrice * (1 + friction)
            : sig.entryPrice * (1 - friction);

          currentPosition = {
            side: sig.direction,
            entryPrice,
            entryTimestamp: candle.timestamp,
            stopLoss: sig.stopLoss,
            takeProfit: sig.takeProfit,
            entryBar: i,
            strategy: sig.strategy,
          };
        }
      }

      return trades;
    },
  };
}

// ============================================
// Main
// ============================================

function log(msg: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

async function main(): Promise<void> {
  const config = parseArgs();

  log('============================================================');
  log('PPO Weight Optimizer Evaluation');
  log('============================================================');
  log(`Model: ${config.modelPath}`);
  log(`Symbols: ${config.symbols.join(', ')}`);
  log(`Threshold: ${config.threshold}`);
  log(`Decision interval: ${config.decisionInterval} bars`);
  log(`Suppressed regimes: ${config.suppressedRegimes.join(', ')}`);
  log('');

  // Load PPO model
  if (!fs.existsSync(config.modelPath)) {
    log(`[Error] Model not found: ${config.modelPath}`);
    process.exit(1);
  }

  const savedData: SerializedWeights = JSON.parse(
    fs.readFileSync(config.modelPath, 'utf-8'),
  );

  const agent = new ContinuousPPOAgent({
    inputSize: STATE_SIZE,
    actionSize: COMPACT_ACTION_SIZE,
    hiddenLayers: [32, 16],
  });

  await agent.loadWeights(savedData);
  const params = agent.getParamCount();
  log(`Model loaded: ${params.total} params (actor=${params.actor}, critic=${params.critic})`);
  log('');

  // WF config
  const wfConfig: Partial<WalkForwardConfig> = {
    symbols: config.symbols,
    timeframe: config.timeframe,
  };

  // Run static baseline
  log('--- Running Static Baseline ---');
  const staticRunner = createStaticRunner(config);
  const staticResult = await runWalkForward(staticRunner, wfConfig);

  log('');
  log('--- Running PPO Weight Optimizer ---');
  const ppoRunner = createPPORunner(agent, config);
  const ppoResult = await runWalkForward(ppoRunner, wfConfig);

  // Print comparison
  log('');
  log('============================================================');
  log('COMPARISON: Static Baseline vs PPO Weight Optimizer');
  log('============================================================');

  const staticEligible = staticResult.symbols.flatMap(s => s.windows).filter(w => w.trades > 0);
  const ppoEligible = ppoResult.symbols.flatMap(s => s.windows).filter(w => w.trades > 0);

  const staticPassRate = staticEligible.length > 0
    ? staticEligible.filter(w => w.passed).length / staticEligible.length
    : 0;
  const ppoPassRate = ppoEligible.length > 0
    ? ppoEligible.filter(w => w.passed).length / ppoEligible.length
    : 0;

  const staticTrades = staticEligible.reduce((s, w) => s + w.trades, 0);
  const ppoTrades = ppoEligible.reduce((s, w) => s + w.trades, 0);

  const staticPnL = staticEligible.reduce((s, w) => s + w.pnl, 0);
  const ppoPnL = ppoEligible.reduce((s, w) => s + w.pnl, 0);

  const staticWR = staticEligible.reduce((s, w) => s + w.winRate, 0) / (staticEligible.length || 1);
  const ppoWR = ppoEligible.reduce((s, w) => s + w.winRate, 0) / (ppoEligible.length || 1);

  log(`  Metric            | Static Baseline | PPO Optimizer  | Delta`);
  log(`  ------------------+-----------------+----------------+---------`);
  log(`  Pass Rate         | ${(staticPassRate * 100).toFixed(1).padStart(13)}% | ${(ppoPassRate * 100).toFixed(1).padStart(12)}% | ${((ppoPassRate - staticPassRate) * 100).toFixed(1).padStart(6)}pp`);
  log(`  Total Trades      | ${String(staticTrades).padStart(14)} | ${String(ppoTrades).padStart(13)} | ${String(ppoTrades - staticTrades).padStart(7)}`);
  log(`  Avg Win Rate      | ${staticWR.toFixed(1).padStart(13)}% | ${ppoWR.toFixed(1).padStart(12)}% | ${(ppoWR - staticWR).toFixed(1).padStart(6)}pp`);
  log(`  Total PnL         | ${(staticPnL * 100).toFixed(1).padStart(13)}% | ${(ppoPnL * 100).toFixed(1).padStart(12)}% | ${((ppoPnL - staticPnL) * 100).toFixed(1).padStart(6)}pp`);

  // Per-symbol comparison
  log('');
  log('  Per-Symbol Pass Rates:');
  for (const sym of config.symbols) {
    const staticSym = staticResult.symbols.find(s => s.symbol === sym);
    const ppoSym = ppoResult.symbols.find(s => s.symbol === sym);
    if (staticSym && ppoSym) {
      const staticSymRate = staticSym.totalWindows > 0
        ? staticSym.positiveWindows / staticSym.totalWindows
        : 0;
      const ppoSymRate = ppoSym.totalWindows > 0
        ? ppoSym.positiveWindows / ppoSym.totalWindows
        : 0;
      log(
        `    ${sym.padEnd(10)} | ` +
        `Static: ${(staticSymRate * 100).toFixed(1)}% (${staticSym.positiveWindows}/${staticSym.totalWindows}) | ` +
        `PPO: ${(ppoSymRate * 100).toFixed(1)}% (${ppoSym.positiveWindows}/${ppoSym.totalWindows}) | ` +
        `Delta: ${((ppoSymRate - staticSymRate) * 100).toFixed(1)}pp`
      );
    }
  }

  log('');
  const verdict = ppoPassRate > staticPassRate
    ? 'PPO WINS'
    : ppoPassRate === staticPassRate
      ? 'TIE'
      : 'STATIC WINS';
  log(`  VERDICT: ${verdict}`);
  log('============================================================');

  // Save results
  const resultPath = path.join(
    process.cwd(),
    'experiments',
    `ppo-eval-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`,
  );
  fs.writeFileSync(resultPath, JSON.stringify({
    config,
    modelParams: params,
    static: {
      passRate: staticPassRate,
      trades: staticTrades,
      pnl: staticPnL,
      winRate: staticWR,
    },
    ppo: {
      passRate: ppoPassRate,
      trades: ppoTrades,
      pnl: ppoPnL,
      winRate: ppoWR,
    },
    delta: {
      passRate: ppoPassRate - staticPassRate,
      trades: ppoTrades - staticTrades,
      pnl: ppoPnL - staticPnL,
      winRate: ppoWR - staticWR,
    },
    perSymbol: config.symbols.map(sym => ({
      symbol: sym,
      static: staticResult.symbols.find(s => s.symbol === sym),
      ppo: ppoResult.symbols.find(s => s.symbol === sym),
    })),
  }, null, 2));
  log(`Results saved to ${resultPath}`);

  agent.dispose();
}

main().catch((err) => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
