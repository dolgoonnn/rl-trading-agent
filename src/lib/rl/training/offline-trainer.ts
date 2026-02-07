/**
 * Offline RL Trainer with Conservative Q-Learning (CQL)
 *
 * Based on: "Conservative Q-Learning for Offline Reinforcement Learning" (Kumar et al., NeurIPS 2020)
 * https://arxiv.org/abs/2006.04779
 *
 * Key insight: Standard Q-learning overestimates values for actions not in the dataset,
 * leading to poor out-of-distribution behavior. CQL adds a conservative penalty that
 * pushes down Q-values for unseen state-action pairs.
 *
 * Why this matters for trading:
 * 1. No risky live exploration - learns purely from historical data
 * 2. Prevents overestimation of actions that weren't taken in reality
 * 3. More robust to distribution shift between train and live trading
 */

import * as tf from '@tensorflow/tfjs';
import type { Candle } from '@/types';
import type { Action, EvaluationResult, EnvironmentConfig } from '../types';
import { Actions } from '../types';
import { TradingEnvironment } from '../environment/trading-env';
import { Evaluator } from './evaluator';
import { StateBuilderConfig } from '../environment/state-builder';
import { RewardConfig } from '../environment/reward-calculator';

export interface CQLConfig {
  // Base DQN config fields needed
  inputSize: number;
  hiddenLayers: number[];
  learningRate: number;
  gamma: number;
  dropout: number;
  l2Regularization: number;
  // CQL-specific hyperparameters
  cqlAlpha: number; // Conservative penalty weight (0.1-5.0 typical)
  cqlTemperature: number; // Softmax temperature for Q-value normalization

  // Offline training
  batchSize: number;
  numUpdates: number; // Total gradient updates
  updateInterval: number; // Log every N updates
  evalInterval: number; // Evaluate every N updates

  // Optional behavior cloning warmup
  bcWarmupUpdates: number; // Train with BC loss first to stabilize

  // Target network
  targetUpdateFrequency: number;
}

const DEFAULT_CQL_CONFIG: CQLConfig = {
  // CQL-specific
  cqlAlpha: 1.0, // Conservative penalty weight
  cqlTemperature: 1.0,

  // Training
  inputSize: 104,
  batchSize: 256,
  numUpdates: 50000,
  updateInterval: 500,
  evalInterval: 2000,
  bcWarmupUpdates: 5000,

  // Model
  hiddenLayers: [128, 64, 32],
  learningRate: 0.0001, // Lower for offline RL
  gamma: 0.99,
  targetUpdateFrequency: 100,

  // Regularization
  dropout: 0.3,
  l2Regularization: 0.01,
};

interface OfflineExperience {
  state: number[];
  action: Action;
  reward: number;
  nextState: number[];
  done: boolean;
}

export interface OfflineTrainingResult {
  updates: number;
  finalEvaluation: EvaluationResult;
  evaluations: EvaluationResult[];
  cqlLossHistory: number[];
  bellmanLossHistory: number[];
}

export class OfflineTrainer {
  private config: CQLConfig;
  private envConfig: Partial<EnvironmentConfig>;
  private stateConfig: Partial<StateBuilderConfig>;
  private rewardConfig: Partial<RewardConfig>;

  private trainCandles: Candle[];
  private valCandles: Candle[];

  // Neural networks
  private qNetwork: tf.LayersModel;
  private targetNetwork: tf.LayersModel;
  private optimizer: tf.Optimizer;

  // Offline dataset
  private dataset: OfflineExperience[] = [];

  // Tracking
  private evaluator: Evaluator;
  private updateCount: number = 0;

  constructor(
    candles: Candle[],
    config: Partial<CQLConfig> = {},
    envConfig: Partial<EnvironmentConfig> = {},
    stateConfig: Partial<StateBuilderConfig> = {},
    rewardConfig: Partial<RewardConfig> = {},
  ) {
    this.config = { ...DEFAULT_CQL_CONFIG, ...config };
    this.envConfig = envConfig;
    this.stateConfig = stateConfig;
    this.rewardConfig = rewardConfig;

    // Split data
    const splitIdx = Math.floor(candles.length * 0.8);
    this.trainCandles = candles.slice(0, splitIdx);
    this.valCandles = candles.slice(splitIdx);

    // Get state size
    const tempEnv = new TradingEnvironment(
      this.trainCandles.slice(0, 100),
      envConfig,
      stateConfig
    );
    this.config.inputSize = tempEnv.getStateSize();

    // Build networks
    this.qNetwork = this.buildNetwork();
    this.targetNetwork = this.buildNetwork();
    this.syncTargetNetwork();

    this.optimizer = tf.train.adam(this.config.learningRate);
    this.evaluator = new Evaluator();

    this.log(`Initialized CQL Offline Trainer`);
    this.log(`  State size: ${this.config.inputSize}`);
    this.log(`  Train candles: ${this.trainCandles.length}`);
    this.log(`  Val candles: ${this.valCandles.length}`);
    this.log(`  CQL alpha: ${this.config.cqlAlpha}`);
  }

  /**
   * Build Q-network with regularization
   */
  private buildNetwork(): tf.LayersModel {
    const input = tf.input({ shape: [this.config.inputSize] });
    let x = input;

    for (const units of this.config.hiddenLayers) {
      x = tf.layers.dense({
        units,
        activation: 'relu',
        kernelRegularizer: tf.regularizers.l2({ l2: this.config.l2Regularization }),
      }).apply(x) as tf.SymbolicTensor;

      if (this.config.dropout > 0) {
        x = tf.layers.dropout({ rate: this.config.dropout }).apply(x) as tf.SymbolicTensor;
      }
    }

    const output = tf.layers.dense({ units: 4, activation: 'linear' }).apply(x) as tf.SymbolicTensor;

    return tf.model({ inputs: input, outputs: output });
  }

  /**
   * Sync target network with Q-network
   */
  private syncTargetNetwork(): void {
    const weights = this.qNetwork.getWeights();
    this.targetNetwork.setWeights(weights);
  }

  /**
   * Generate offline dataset by running a behavior policy through the environment
   * Uses random policy with slight bias toward holding (simulates cautious trader)
   */
  generateDataset(): void {
    this.log('Generating offline dataset from historical data...');

    const env = new TradingEnvironment(
      this.trainCandles,
      { ...this.envConfig, randomStart: false },
      this.stateConfig,
      this.rewardConfig,
      false
    );

    let state = env.reset();
    let steps = 0;

    while (!env.isDone()) {
      // Behavior policy: random with hold bias
      const rand = Math.random();
      let action: Action;
      if (rand < 0.6) {
        action = Actions.HOLD; // 60% hold
      } else if (rand < 0.8) {
        action = rand < 0.7 ? Actions.BUY : Actions.SELL; // 20% enter
      } else {
        action = Actions.CLOSE; // 20% close
      }

      const { state: nextState, reward, done } = env.step(action);

      this.dataset.push({
        state: [...state.features],
        action,
        reward,
        nextState: [...nextState.features],
        done,
      });

      state = nextState;
      steps++;
    }

    // Also generate with slightly different policies for diversity
    for (let variant = 0; variant < 3; variant++) {
      const envVariant = new TradingEnvironment(
        this.trainCandles,
        { ...this.envConfig, randomStart: true },
        this.stateConfig,
        this.rewardConfig,
        false
      );

      let stateV = envVariant.reset();

      while (!envVariant.isDone()) {
        // Different bias per variant
        const holdProb = 0.4 + variant * 0.1;
        const rand = Math.random();
        let action: Action;
        if (rand < holdProb) {
          action = Actions.HOLD;
        } else {
          action = Math.floor(Math.random() * 4) as Action;
        }

        const { state: nextState, reward, done } = envVariant.step(action);

        this.dataset.push({
          state: [...stateV.features],
          action,
          reward,
          nextState: [...nextState.features],
          done,
        });

        stateV = nextState;
      }
    }

    // Shuffle dataset
    this.shuffleDataset();

    this.log(`Generated ${this.dataset.length} offline experiences`);
  }

  /**
   * Shuffle the dataset
   */
  private shuffleDataset(): void {
    for (let i = this.dataset.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.dataset[i], this.dataset[j]] = [this.dataset[j]!, this.dataset[i]!];
    }
  }

  /**
   * Sample a batch from the dataset
   */
  private sampleBatch(): OfflineExperience[] {
    const batch: OfflineExperience[] = [];
    for (let i = 0; i < this.config.batchSize; i++) {
      const idx = Math.floor(Math.random() * this.dataset.length);
      batch.push(this.dataset[idx]!);
    }
    return batch;
  }

  /**
   * Train with CQL
   */
  async train(): Promise<OfflineTrainingResult> {
    if (this.dataset.length === 0) {
      this.generateDataset();
    }

    const evaluations: EvaluationResult[] = [];
    const cqlLossHistory: number[] = [];
    const bellmanLossHistory: number[] = [];

    this.log('Starting CQL offline training...');

    // Optional BC warmup
    if (this.config.bcWarmupUpdates > 0) {
      this.log(`Running ${this.config.bcWarmupUpdates} behavior cloning warmup updates...`);
      for (let i = 0; i < this.config.bcWarmupUpdates; i++) {
        this.bcUpdate();
        if ((i + 1) % 1000 === 0) {
          this.log(`  BC warmup: ${i + 1}/${this.config.bcWarmupUpdates}`);
        }
      }
    }

    // Main CQL training
    for (let update = 1; update <= this.config.numUpdates; update++) {
      const { cqlLoss, bellmanLoss } = this.cqlUpdate();

      cqlLossHistory.push(cqlLoss);
      bellmanLossHistory.push(bellmanLoss);
      this.updateCount++;

      // Update target network
      if (update % this.config.targetUpdateFrequency === 0) {
        this.syncTargetNetwork();
      }

      // Logging
      if (update % this.config.updateInterval === 0) {
        const avgCQL = cqlLossHistory.slice(-this.config.updateInterval).reduce((a, b) => a + b, 0) / this.config.updateInterval;
        const avgBellman = bellmanLossHistory.slice(-this.config.updateInterval).reduce((a, b) => a + b, 0) / this.config.updateInterval;
        this.log(`Update ${update}: CQL Loss=${avgCQL.toFixed(4)}, Bellman Loss=${avgBellman.toFixed(4)}`);
      }

      // Evaluation
      if (update % this.config.evalInterval === 0) {
        const evalResult = this.evaluate(update);
        evaluations.push(evalResult);
        this.log(`  Eval: WinRate=${evalResult.metrics.winRate.toFixed(1)}%, Sharpe=${evalResult.metrics.sharpeRatio.toFixed(2)}, Trades=${evalResult.metrics.totalTrades}`);
      }
    }

    // Final evaluation
    const finalEval = this.evaluate(this.config.numUpdates);
    this.logFinalSummary(finalEval);

    return {
      updates: this.updateCount,
      finalEvaluation: finalEval,
      evaluations,
      cqlLossHistory,
      bellmanLossHistory,
    };
  }

  /**
   * CQL update step
   * Combines standard Bellman loss with conservative penalty
   * Uses pure TensorFlow operations to maintain gradient chain
   */
  private cqlUpdate(): { cqlLoss: number; bellmanLoss: number } {
    const batch = this.sampleBatch();

    // Prepare batch tensors
    const states = tf.tensor2d(batch.map((e) => e.state));
    const nextStates = tf.tensor2d(batch.map((e) => e.nextState));
    const rewardsTensor = tf.tensor1d(batch.map((e) => e.reward));
    const donesMask = tf.tensor1d(batch.map((e) => e.done ? 0 : 1));

    // Pre-compute action mask OUTSIDE gradient scope to avoid gatherND gradient issues
    const actionMask = tf.oneHot(
      tf.tensor1d(batch.map((e) => e.action), 'int32'),
      4
    ) as tf.Tensor2D;

    let bellmanLossValue = 0;
    let cqlLossValue = 0;

    // Compute gradients with TF operations
    const { grads, value: totalLoss } = tf.variableGrads(() => {
      // Current Q-values
      const currentQ = this.qNetwork.predict(states) as tf.Tensor2D;

      // Target Q-values (no gradient through target network)
      const nextQ = this.targetNetwork.predict(nextStates) as tf.Tensor2D;
      const nextMaxQ = nextQ.max(1);

      // Compute targets: r + gamma * max(Q') * (1 - done)
      const targets = rewardsTensor.add(nextMaxQ.mul(donesMask).mul(this.config.gamma));

      // Get Q-values for actions taken (using pre-computed one-hot mask)
      const selectedQ = currentQ.mul(actionMask).sum(1);

      // Bellman loss (MSE)
      const bellmanLoss = tf.losses.meanSquaredError(targets, selectedQ);

      // CQL loss: logsumexp(Q) - Q(s, a_data)
      // LogSumExp over actions
      const logSumExp = tf.logSumExp(currentQ.div(this.config.cqlTemperature), 1)
        .mul(this.config.cqlTemperature);

      // CQL penalty
      const cqlPenalty = logSumExp.sub(selectedQ).mean().mul(this.config.cqlAlpha);

      // Store values for logging
      bellmanLossValue = bellmanLoss.dataSync()[0]!;
      cqlLossValue = cqlPenalty.dataSync()[0]!;

      // Total loss
      return bellmanLoss.add(cqlPenalty) as tf.Scalar;
    });

    // Apply gradients
    this.optimizer.applyGradients(grads);

    // Dispose tensors
    states.dispose();
    nextStates.dispose();
    actionMask.dispose();
    rewardsTensor.dispose();
    donesMask.dispose();
    totalLoss.dispose();
    Object.values(grads).forEach((g) => g.dispose());

    return { cqlLoss: cqlLossValue, bellmanLoss: bellmanLossValue };
  }

  /**
   * Behavior cloning update (warmup)
   * Supervised learning to match dataset actions
   */
  private bcUpdate(): void {
    const batch = this.sampleBatch();

    const states = tf.tensor2d(batch.map((e) => e.state));
    const actionLabels = tf.oneHot(
      tf.tensor1d(batch.map((e) => e.action), 'int32'),
      4
    );

    const { grads, value: loss } = tf.variableGrads(() => {
      const logits = this.qNetwork.predict(states) as tf.Tensor2D;
      return tf.losses.softmaxCrossEntropy(actionLabels, logits) as tf.Scalar;
    });

    this.optimizer.applyGradients(grads);

    // Cleanup
    states.dispose();
    actionLabels.dispose();
    loss.dispose();
    Object.values(grads).forEach((g) => g.dispose());
  }

  /**
   * Evaluate the learned policy
   */
  private evaluate(update: number): EvaluationResult {
    const env = new TradingEnvironment(
      this.valCandles,
      { ...this.envConfig, randomStart: false },
      this.stateConfig,
      this.rewardConfig,
      false
    );

    let state = env.reset();
    let totalReward = 0;
    const equityCurve: number[] = [this.envConfig.initialCapital ?? 10000];

    while (!env.isDone()) {
      // Greedy action selection
      const action = tf.tidy(() => {
        const stateTensor = tf.tensor2d([state.features]);
        const qValues = this.qNetwork.predict(stateTensor) as tf.Tensor;
        return qValues.argMax(1).dataSync()[0] as Action;
      });

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
      update,
      totalReward,
      0,
      0
    );
  }

  /**
   * Log final training summary
   */
  private logFinalSummary(eval_: EvaluationResult): void {
    this.log('\n' + '='.repeat(60));
    this.log('CQL OFFLINE TRAINING SUMMARY');
    this.log('='.repeat(60));

    const m = eval_.metrics;
    this.log(`\nFinal Results:`);
    this.log(`  Total Trades: ${m.totalTrades}`);
    this.log(`  Win Rate: ${m.winRate.toFixed(1)}%`);
    this.log(`  Sharpe Ratio: ${m.sharpeRatio.toFixed(2)}`);
    this.log(`  Max Drawdown: ${m.maxDrawdown.toFixed(1)}%`);
    this.log(`  Total PnL: ${m.totalPnL.toFixed(2)}`);

    this.log('\nSuccess Criteria:');
    const sharpeOk = m.sharpeRatio > 0;
    const winRateOk = m.winRate > 45;
    const drawdownOk = m.maxDrawdown < 30;

    this.log(`  ${sharpeOk ? '✓' : '✗'} Positive Sharpe: ${m.sharpeRatio.toFixed(2)}`);
    this.log(`  ${winRateOk ? '✓' : '✗'} Win Rate > 45%: ${m.winRate.toFixed(1)}%`);
    this.log(`  ${drawdownOk ? '✓' : '✗'} Max Drawdown < 30%: ${m.maxDrawdown.toFixed(1)}%`);

    if (sharpeOk && winRateOk && drawdownOk) {
      this.log('\n✓ CQL offline training PASSED');
    } else {
      this.log('\n✗ CQL offline training needs tuning (try adjusting cqlAlpha)');
    }
  }

  /**
   * Get the trained Q-network for deployment
   */
  getQNetwork(): tf.LayersModel {
    return this.qNetwork;
  }

  /**
   * Select action for deployment
   */
  selectAction(state: number[]): Action {
    return tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const qValues = this.qNetwork.predict(stateTensor) as tf.Tensor;
      return qValues.argMax(1).dataSync()[0] as Action;
    });
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.qNetwork.dispose();
    this.targetNetwork.dispose();
    this.optimizer.dispose();
  }

  /**
   * Log message
   */
  private log(message: string): void {
    console.log(`[CQL] ${message}`);
  }
}
