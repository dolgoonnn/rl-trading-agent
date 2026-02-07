/**
 * Multi-Symbol Trainer
 *
 * Trains RL agents across multiple trading pairs simultaneously.
 * Key insight: Training on diverse assets improves generalization
 * because the model learns universal price patterns, not asset-specific quirks.
 *
 * Features:
 * - ATR normalization for cross-asset learning
 * - Balanced sampling across symbols
 * - Per-symbol and aggregate metrics tracking
 * - Symbol-specific cost configuration
 */

import type { Candle } from '@/types';
import type {
  TrainingConfig,
  TrainingMetrics,
  EvaluationResult,
  DQNConfig,
  EnvironmentConfig,
} from '../types';
import { TradingEnvironment } from '../environment/trading-env';
import { DQNAgent } from '../agent/dqn-agent';
import { NStepReplayBuffer } from '../agent/replay-buffer';
import { Evaluator } from './evaluator';
import { RewardConfig } from '../environment/reward-calculator';
import { StateBuilderConfig } from '../environment/state-builder';
import { getEnvConfigForSymbol } from '../config/symbols';

export interface MultiSymbolConfig extends Omit<TrainingConfig, 'trainSplit'> {
  // Symbol-specific settings
  symbolWeights?: Record<string, number>; // Sampling weights per symbol
  validateOnAllSymbols: boolean; // Validate on all or just primary
  primarySymbol?: string; // Main symbol for early stopping

  // Cross-symbol learning
  shuffleSymbols: boolean; // Randomize symbol order each episode
  balancedSampling: boolean; // Equal episodes per symbol

  // Train/val split per symbol
  trainSplit: number;
}

const DEFAULT_MULTI_CONFIG: Partial<MultiSymbolConfig> = {
  validateOnAllSymbols: true,
  shuffleSymbols: true,
  balancedSampling: true,
  trainSplit: 0.8,
};

export interface SymbolData {
  symbol: string;
  trainCandles: Candle[];
  valCandles: Candle[];
  envConfig: Partial<EnvironmentConfig>;
}

export interface MultiSymbolMetrics extends TrainingMetrics {
  symbol: string;
}

export interface MultiSymbolResult {
  metrics: MultiSymbolMetrics[];
  evaluations: Record<string, EvaluationResult[]>;
  aggregateEvaluation: EvaluationResult;
  perSymbolFinal: Record<string, EvaluationResult>;
  agent: DQNAgent;
}

export class MultiSymbolTrainer {
  private config: MultiSymbolConfig;
  private stateConfig: Partial<StateBuilderConfig>;
  private rewardConfig: Partial<RewardConfig>;

  private symbolData: SymbolData[] = [];
  private agent: DQNAgent;
  private evaluator: Evaluator;

  // Training state
  private bestAggregateSharpe: number = -Infinity;
  private noImprovementCount: number = 0;
  private stopped: boolean = false;

  constructor(
    symbolsData: Record<string, Candle[]>, // symbol -> candles
    config: Partial<MultiSymbolConfig> = {},
    baseEnvConfig: Partial<EnvironmentConfig> = {},
    dqnConfig: Partial<DQNConfig> = {},
    stateConfig: Partial<StateBuilderConfig> = {},
    rewardConfig: Partial<RewardConfig> = {},
  ) {
    this.config = {
      episodes: 1000,
      maxStepsPerEpisode: 0,
      saveInterval: 100,
      evalInterval: 10,
      earlyStoppingPatience: 50,
      minImprovement: 0.01,
      logInterval: 10,
      verbose: true,
      trainFrequency: 8,
      useRollingValidation: false, // Use static split for multi-symbol
      ...DEFAULT_MULTI_CONFIG,
      ...config,
    } as MultiSymbolConfig;

    this.stateConfig = stateConfig;
    this.rewardConfig = rewardConfig;

    // Process each symbol's data
    for (const [symbol, candles] of Object.entries(symbolsData)) {
      if (candles.length < 200) {
        console.warn(`[MultiSymbol] Skipping ${symbol}: insufficient data (${candles.length} candles)`);
        continue;
      }

      const splitIdx = Math.floor(candles.length * this.config.trainSplit);

      // Get symbol-specific costs from config
      const symbolEnvConfig = getEnvConfigForSymbol(symbol);

      this.symbolData.push({
        symbol,
        trainCandles: candles.slice(0, splitIdx),
        valCandles: candles.slice(splitIdx),
        envConfig: {
          ...baseEnvConfig,
          spread: symbolEnvConfig.spread,
          commission: symbolEnvConfig.commission,
          slippage: symbolEnvConfig.slippage,
        },
      });
    }

    if (this.symbolData.length === 0) {
      throw new Error('No valid symbol data provided');
    }

    this.log(`Initialized with ${this.symbolData.length} symbols:`);
    for (const sd of this.symbolData) {
      this.log(`  ${sd.symbol}: ${sd.trainCandles.length} train, ${sd.valCandles.length} val`);
    }

    // Get state size from first symbol
    const firstSymbol = this.symbolData[0]!;
    const tempEnv = new TradingEnvironment(
      firstSymbol.trainCandles.slice(0, 100),
      firstSymbol.envConfig,
      stateConfig
    );
    const stateSize = tempEnv.getStateSize();

    // Initialize components with N-step buffer for better credit assignment
    const nSteps = 3; // 3-step returns help with bias-variance tradeoff
    const gamma = dqnConfig.gamma ?? 0.99;
    const buffer = new NStepReplayBuffer({ capacity: 100000 }, nSteps, gamma); // N-step returns
    this.agent = new DQNAgent({ ...dqnConfig, inputSize: stateSize }, buffer);
    this.evaluator = new Evaluator();

    this.log(`State vector size: ${stateSize}`);
  }

  /**
   * Run the multi-symbol training loop
   */
  async train(): Promise<MultiSymbolResult> {
    const allMetrics: MultiSymbolMetrics[] = [];
    const evaluations: Record<string, EvaluationResult[]> = {};

    // Initialize evaluation tracking for each symbol
    for (const sd of this.symbolData) {
      evaluations[sd.symbol] = [];
    }

    // Calculate episodes per symbol
    const episodesPerSymbol = this.config.balancedSampling
      ? Math.ceil(this.config.episodes / this.symbolData.length)
      : this.config.episodes;

    let globalEpisode = 0;

    for (let round = 0; round < episodesPerSymbol; round++) {
      // Optionally shuffle symbol order
      const symbols = this.config.shuffleSymbols
        ? this.shuffleArray([...this.symbolData])
        : this.symbolData;

      for (const symbolData of symbols) {
        if (this.stopped) break;

        globalEpisode++;
        if (globalEpisode > this.config.episodes) break;

        // Run episode for this symbol
        const metrics = this.runEpisode(symbolData, globalEpisode);
        allMetrics.push({ ...metrics, symbol: symbolData.symbol });

        // Logging
        if (globalEpisode % this.config.logInterval === 0) {
          this.log(`[${symbolData.symbol}] ${this.evaluator.formatMetrics(metrics)}`);
        }

        // Evaluation
        if (globalEpisode % this.config.evalInterval === 0) {
          const evalResults = this.evaluateAllSymbols(globalEpisode);

          for (const [symbol, result] of Object.entries(evalResults)) {
            evaluations[symbol]!.push(result);
          }

          // Aggregate metrics for early stopping
          const aggregateSharpe = this.computeAggregateSharpe(evalResults);
          this.logAggregateEvaluation(evalResults, aggregateSharpe);

          // Early stopping check
          if (aggregateSharpe > this.bestAggregateSharpe + this.config.minImprovement) {
            this.bestAggregateSharpe = aggregateSharpe;
            this.noImprovementCount = 0;
          } else {
            this.noImprovementCount++;
            if (this.noImprovementCount >= this.config.earlyStoppingPatience) {
              this.log(`Early stopping: No improvement for ${this.config.earlyStoppingPatience} evaluations`);
              this.stopped = true;
            }
          }
        }
      }

      if (this.stopped) break;
    }

    // Final evaluation
    const finalPerSymbol = this.evaluateAllSymbols(globalEpisode);
    const aggregateEval = this.createAggregateEvaluation(finalPerSymbol, globalEpisode);

    this.logFinalSummary(finalPerSymbol, aggregateEval);

    return {
      metrics: allMetrics,
      evaluations,
      aggregateEvaluation: aggregateEval,
      perSymbolFinal: finalPerSymbol,
      agent: this.agent,
    };
  }

  /**
   * Run a single training episode on one symbol
   */
  private runEpisode(symbolData: SymbolData, episode: number): TrainingMetrics {
    const env = new TradingEnvironment(
      symbolData.trainCandles,
      { ...symbolData.envConfig, randomStart: true },
      this.stateConfig,
      this.rewardConfig,
      true // Training mode
    );

    let state = env.reset();
    let totalReward = 0;
    let steps = 0;
    let totalLoss = 0;
    let lossCount = 0;

    const maxSteps = this.config.maxStepsPerEpisode > 0
      ? this.config.maxStepsPerEpisode
      : symbolData.trainCandles.length;

    const trainFrequency = this.config.trainFrequency ?? 4;

    while (!env.isDone() && steps < maxSteps) {
      const action = this.agent.selectAction(state.features);
      const { state: nextState, reward, done } = env.step(action);

      this.agent.storeExperience(
        state.features,
        action,
        reward,
        nextState.features,
        done
      );

      if (steps % trainFrequency === 0) {
        const loss = this.agent.train();
        if (loss > 0) {
          totalLoss += loss;
          lossCount++;
        }
      }

      totalReward += reward;
      state = nextState;
      steps++;
    }

    this.agent.endEpisode();

    const portfolio = env.getPortfolio();
    const trades = env.getTrades();

    return {
      episode,
      totalReward,
      averageReward: steps > 0 ? totalReward / steps : 0,
      epsilon: this.agent.getState().epsilon,
      loss: lossCount > 0 ? totalLoss / lossCount : 0,
      totalTrades: trades.length,
      winRate: trades.length > 0
        ? (portfolio.winningTrades / trades.length) * 100
        : 0,
      sharpeRatio: 0,
      maxDrawdown: portfolio.maxDrawdown * 100,
      totalPnL: portfolio.realizedPnL,
    };
  }

  /**
   * Evaluate on all symbols
   */
  private evaluateAllSymbols(episode: number): Record<string, EvaluationResult> {
    const results: Record<string, EvaluationResult> = {};

    for (const symbolData of this.symbolData) {
      results[symbolData.symbol] = this.evaluateSymbol(symbolData, episode);
    }

    return results;
  }

  /**
   * Evaluate on a single symbol
   */
  private evaluateSymbol(symbolData: SymbolData, episode: number): EvaluationResult {
    const env = new TradingEnvironment(
      symbolData.valCandles,
      { ...symbolData.envConfig, randomStart: false },
      this.stateConfig,
      this.rewardConfig,
      false // Evaluation mode
    );

    let state = env.reset();
    let totalReward = 0;
    const equityCurve: number[] = [symbolData.envConfig.initialCapital ?? 10000];

    while (!env.isDone()) {
      const action = this.agent.selectAction(state.features, false);
      const { state: nextState, reward } = env.step(action);

      totalReward += reward;
      equityCurve.push(env.getPortfolio().equity);
      state = nextState;
    }

    const trades = env.getTrades();
    const initialCapital = symbolData.envConfig.initialCapital ?? 10000;

    return this.evaluator.evaluate(
      trades,
      equityCurve,
      initialCapital,
      episode,
      totalReward,
      this.agent.getState().epsilon,
      this.agent.getState().averageLoss
    );
  }

  /**
   * Compute aggregate Sharpe ratio across all symbols
   * Uses average Sharpe weighted by data size
   */
  private computeAggregateSharpe(results: Record<string, EvaluationResult>): number {
    let totalWeight = 0;
    let weightedSharpe = 0;

    for (const [symbol, result] of Object.entries(results)) {
      const symbolData = this.symbolData.find((sd) => sd.symbol === symbol);
      const weight = symbolData?.valCandles.length ?? 1;
      totalWeight += weight;
      weightedSharpe += result.metrics.sharpeRatio * weight;
    }

    return totalWeight > 0 ? weightedSharpe / totalWeight : 0;
  }

  /**
   * Create aggregate evaluation combining all symbols
   */
  private createAggregateEvaluation(
    perSymbol: Record<string, EvaluationResult>,
    episode: number
  ): EvaluationResult {
    const results = Object.values(perSymbol);
    const n = results.length;

    // Average metrics
    const avgWinRate = results.reduce((a, r) => a + r.metrics.winRate, 0) / n;
    const avgSharpe = results.reduce((a, r) => a + r.metrics.sharpeRatio, 0) / n;
    const avgDrawdown = results.reduce((a, r) => a + r.metrics.maxDrawdown, 0) / n;
    const totalTrades = results.reduce((a, r) => a + r.metrics.totalTrades, 0);
    const avgPnL = results.reduce((a, r) => a + r.metrics.totalPnL, 0) / n;
    const avgReward = results.reduce((a, r) => a + r.metrics.totalReward, 0) / n;

    return {
      metrics: {
        episode,
        totalReward: avgReward,
        averageReward: avgReward / Math.max(1, results[0]?.equityCurve.length ?? 1),
        epsilon: 0,
        loss: 0,
        totalTrades,
        winRate: avgWinRate,
        sharpeRatio: avgSharpe,
        maxDrawdown: avgDrawdown,
        totalPnL: avgPnL,
      },
      trades: results.flatMap((r) => r.trades),
      equityCurve: [], // Aggregate equity curve not meaningful
    };
  }

  /**
   * Log aggregate evaluation results
   */
  private logAggregateEvaluation(
    results: Record<string, EvaluationResult>,
    aggregateSharpe: number
  ): void {
    const symbols = Object.keys(results);
    const sharpes = symbols.map((s) => `${s}:${results[s]!.metrics.sharpeRatio.toFixed(2)}`);
    this.log(`[Eval] Sharpe: ${sharpes.join(' | ')} | Avg: ${aggregateSharpe.toFixed(2)}`);
  }

  /**
   * Log final training summary
   */
  private logFinalSummary(
    perSymbol: Record<string, EvaluationResult>,
    aggregate: EvaluationResult
  ): void {
    this.log('\n' + '='.repeat(60));
    this.log('MULTI-SYMBOL TRAINING SUMMARY');
    this.log('='.repeat(60));

    this.log('\nPer-Symbol Results:');
    this.log('| Symbol     | Win Rate | Sharpe | Max DD  | Trades |');
    this.log('|------------|----------|--------|---------|--------|');

    for (const [symbol, result] of Object.entries(perSymbol)) {
      const m = result.metrics;
      this.log(`| ${symbol.padEnd(10)} | ${m.winRate.toFixed(1).padStart(6)}% | ${m.sharpeRatio.toFixed(2).padStart(6)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.totalTrades.toString().padStart(6)} |`);
    }

    this.log('|------------|----------|--------|---------|--------|');
    const a = aggregate.metrics;
    this.log(`| AGGREGATE  | ${a.winRate.toFixed(1).padStart(6)}% | ${a.sharpeRatio.toFixed(2).padStart(6)} | ${a.maxDrawdown.toFixed(1).padStart(6)}% | ${a.totalTrades.toString().padStart(6)} |`);

    this.log('\nSuccess Criteria:');
    const sharpeOk = a.sharpeRatio > 0;
    const winRateOk = a.winRate > 45;
    const drawdownOk = a.maxDrawdown < 30;

    this.log(`  ${sharpeOk ? '✓' : '✗'} Positive Sharpe: ${a.sharpeRatio.toFixed(2)}`);
    this.log(`  ${winRateOk ? '✓' : '✗'} Win Rate > 45%: ${a.winRate.toFixed(1)}%`);
    this.log(`  ${drawdownOk ? '✓' : '✗'} Max Drawdown < 30%: ${a.maxDrawdown.toFixed(1)}%`);

    if (sharpeOk && winRateOk && drawdownOk) {
      this.log('\n✓ Multi-symbol validation PASSED');
    } else {
      this.log('\n✗ Multi-symbol validation FAILED - needs more tuning');
    }
  }

  /**
   * Stop training
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Get the trained agent
   */
  getAgent(): DQNAgent {
    return this.agent;
  }

  /**
   * Shuffle array (Fisher-Yates)
   */
  private shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j]!, array[i]!];
    }
    return array;
  }

  /**
   * Log message
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[MultiSymbol] ${message}`);
    }
  }
}
