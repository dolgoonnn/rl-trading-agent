/**
 * Trainer
 * Main training loop for the RL agent
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
import { DQNAgent, SerializedWeights } from '../agent/dqn-agent';
import { ReplayBuffer } from '../agent/replay-buffer';
import { Evaluator } from './evaluator';
import { RewardConfig } from '../environment/reward-calculator';
import { StateBuilderConfig } from '../environment/state-builder';

const DEFAULT_CONFIG: TrainingConfig = {
  episodes: 1000,
  maxStepsPerEpisode: 0, // 0 = use all data
  saveInterval: 100,
  evalInterval: 10,
  earlyStoppingPatience: 50,
  minImprovement: 0.01,
  trainSplit: 0.8,
  logInterval: 10,
  verbose: true,
  trainFrequency: 8, // Train every N steps - increased to reduce overfitting
  // Walk-forward validation (optional - if not set, uses static split)
  useRollingValidation: false,
  rollingTrainWindow: 500,
  rollingTestWindow: 100,
  rollingStepSize: 100,
};

export interface TrainerCallbacks {
  onEpisodeEnd?: (metrics: TrainingMetrics) => void;
  onEvaluation?: (result: EvaluationResult) => void;
  onCheckpoint?: (weights: SerializedWeights) => void;
  onLog?: (message: string) => void;
}

export class Trainer {
  private config: TrainingConfig;
  private envConfig: Partial<EnvironmentConfig>;
  private stateConfig: Partial<StateBuilderConfig>;
  private rewardConfig: Partial<RewardConfig>;

  private trainCandles: Candle[];
  private valCandles: Candle[];
  private agent: DQNAgent;
  private evaluator: Evaluator;
  private callbacks: TrainerCallbacks;

  // Rolling window state (for walk-forward validation)
  private rollingWindows: { train: Candle[]; test: Candle[] }[] = [];

  // Training state
  private bestSharpe: number = -Infinity;
  private noImprovementCount: number = 0;
  private stopped: boolean = false;

  constructor(
    candles: Candle[],
    config: Partial<TrainingConfig> = {},
    envConfig: Partial<EnvironmentConfig> = {},
    dqnConfig: Partial<DQNConfig> = {},
    stateConfig: Partial<StateBuilderConfig> = {},
    rewardConfig: Partial<RewardConfig> = {},
    callbacks: TrainerCallbacks = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.envConfig = envConfig;
    this.stateConfig = stateConfig;
    this.rewardConfig = rewardConfig;
    this.callbacks = callbacks;
    // Note: original candles array available in constructor scope if needed

    if (this.config.useRollingValidation) {
      // Create rolling windows for walk-forward validation
      this.rollingWindows = this.createRollingWindows(candles);
      // Use first window initially
      if (this.rollingWindows.length > 0) {
        this.trainCandles = this.rollingWindows[0]!.train;
        this.valCandles = this.rollingWindows[0]!.test;
      } else {
        throw new Error('Not enough data for rolling windows');
      }
      this.log(`Created ${this.rollingWindows.length} rolling windows`);
    } else {
      // Static train/val split
      const splitIdx = Math.floor(candles.length * this.config.trainSplit);
      this.trainCandles = candles.slice(0, splitIdx);
      this.valCandles = candles.slice(splitIdx);
    }

    // Get actual state size from environment
    const tempEnv = new TradingEnvironment(this.trainCandles.slice(0, 100), envConfig, stateConfig);
    const stateSize = tempEnv.getStateSize();

    // Initialize components with correct input size
    const buffer = new ReplayBuffer();
    this.agent = new DQNAgent({ ...dqnConfig, inputSize: stateSize }, buffer);
    this.evaluator = new Evaluator();

    this.log(`Training data: ${this.trainCandles.length} candles`);
    this.log(`Validation data: ${this.valCandles.length} candles`);
    this.log(`State vector size: ${stateSize}`);
  }

  /**
   * Create rolling windows for walk-forward validation
   * Each window has a train period followed by a test period
   */
  private createRollingWindows(candles: Candle[]): { train: Candle[]; test: Candle[] }[] {
    const trainWindow = this.config.rollingTrainWindow ?? 500;
    const testWindow = this.config.rollingTestWindow ?? 100;
    const stepSize = this.config.rollingStepSize ?? 100;

    const windows: { train: Candle[]; test: Candle[] }[] = [];
    let start = 0;

    while (start + trainWindow + testWindow <= candles.length) {
      windows.push({
        train: candles.slice(start, start + trainWindow),
        test: candles.slice(start + trainWindow, start + trainWindow + testWindow),
      });
      start += stepSize;
    }

    return windows;
  }

  /**
   * Run the training loop
   */
  async train(): Promise<TrainingResult> {
    const results: TrainingMetrics[] = [];
    const evaluations: EvaluationResult[] = [];

    for (let episode = 1; episode <= this.config.episodes; episode++) {
      if (this.stopped) {
        this.log('Training stopped by user');
        break;
      }

      // Run episode
      const metrics = this.runEpisode(episode);
      results.push(metrics);

      // Callbacks
      this.callbacks.onEpisodeEnd?.(metrics);

      // Logging
      if (episode % this.config.logInterval === 0) {
        this.log(this.evaluator.formatMetrics(metrics));
      }

      // Evaluation
      if (episode % this.config.evalInterval === 0) {
        const evalResult = this.evaluate(episode);
        evaluations.push(evalResult);
        this.callbacks.onEvaluation?.(evalResult);

        // Early stopping check
        if (evalResult.metrics.sharpeRatio > this.bestSharpe + this.config.minImprovement) {
          this.bestSharpe = evalResult.metrics.sharpeRatio;
          this.noImprovementCount = 0;

          // Save best model
          const weights = await this.agent.saveWeights();
          this.callbacks.onCheckpoint?.(weights);
        } else {
          this.noImprovementCount++;
          if (this.noImprovementCount >= this.config.earlyStoppingPatience) {
            this.log(`Early stopping: No improvement for ${this.config.earlyStoppingPatience} evaluations`);
            break;
          }
        }
      }

      // Periodic checkpoint
      if (episode % this.config.saveInterval === 0) {
        const weights = await this.agent.saveWeights();
        this.callbacks.onCheckpoint?.(weights);
      }
    }

    // Final evaluation
    const finalEval = this.evaluate(results.length);

    return {
      metrics: results,
      evaluations,
      finalEvaluation: finalEval,
      agent: this.agent,
    };
  }

  /**
   * Run a single training episode
   */
  private runEpisode(episode: number): TrainingMetrics {
    const env = new TradingEnvironment(
      this.trainCandles,
      { ...this.envConfig, randomStart: true },
      this.stateConfig,
      this.rewardConfig
    );

    let state = env.reset();
    let totalReward = 0;
    let steps = 0;
    let totalLoss = 0;
    let lossCount = 0;

    const maxSteps = this.config.maxStepsPerEpisode > 0
      ? this.config.maxStepsPerEpisode
      : this.trainCandles.length;

    const trainFrequency = this.config.trainFrequency ?? 4;

    while (!env.isDone() && steps < maxSteps) {
      // Select action
      const action = this.agent.selectAction(state.features);

      // Take step
      const { state: nextState, reward, done } = env.step(action);

      // Store experience
      this.agent.storeExperience(
        state.features,
        action,
        reward,
        nextState.features,
        done
      );

      // Train every N steps to reduce overfitting and improve stability
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
      sharpeRatio: 0, // Will be calculated in evaluation
      maxDrawdown: portfolio.maxDrawdown * 100,
      totalPnL: portfolio.realizedPnL,
    };
  }

  /**
   * Evaluate on validation data
   */
  private evaluate(episode: number): EvaluationResult {
    const env = new TradingEnvironment(
      this.valCandles,
      { ...this.envConfig, randomStart: false },
      this.stateConfig,
      this.rewardConfig
    );

    let state = env.reset();
    let totalReward = 0;
    const equityCurve: number[] = [this.envConfig.initialCapital ?? 10000];

    while (!env.isDone()) {
      // Use greedy policy (no exploration)
      const action = this.agent.selectAction(state.features, false);
      const { state: nextState, reward } = env.step(action);

      totalReward += reward;
      equityCurve.push(env.getPortfolio().equity);
      state = nextState;
    }

    const trades = env.getTrades();
    const initialCapital = this.envConfig.initialCapital ?? 10000;

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
   * Log message
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[Trainer] ${message}`);
      this.callbacks.onLog?.(message);
    }
  }
}

export interface TrainingResult {
  metrics: TrainingMetrics[];
  evaluations: EvaluationResult[];
  finalEvaluation: EvaluationResult;
  agent: DQNAgent;
}

/**
 * Backtest a trained agent on historical data
 */
export function backtestAgent(
  agent: DQNAgent,
  candles: Candle[],
  envConfig: Partial<EnvironmentConfig> = {},
  stateConfig: Partial<StateBuilderConfig> = {},
  rewardConfig: Partial<RewardConfig> = {}
): BacktestResult {
  const env = new TradingEnvironment(candles, envConfig, stateConfig, rewardConfig);
  const evaluator = new Evaluator();

  let state = env.reset();
  let totalReward = 0;
  const equityCurve: number[] = [envConfig.initialCapital ?? 10000];
  const actions: { index: number; action: number; price: number }[] = [];

  while (!env.isDone()) {
    const action = agent.selectAction(state.features, false);
    const { state: nextState, reward, info } = env.step(action);

    actions.push({
      index: env.getCurrentIndex(),
      action,
      price: info.price,
    });

    totalReward += reward;
    equityCurve.push(env.getPortfolio().equity);
    state = nextState;
  }

  const trades = env.getTrades();
  const initialCapital = envConfig.initialCapital ?? 10000;

  const evalResult = evaluator.evaluate(
    trades,
    equityCurve,
    initialCapital,
    0,
    totalReward,
    0,
    0
  );

  return {
    ...evalResult,
    actions,
    portfolio: env.getPortfolio(),
  };
}

export interface BacktestResult extends EvaluationResult {
  actions: { index: number; action: number; price: number }[];
  portfolio: import('../types').Portfolio;
}
