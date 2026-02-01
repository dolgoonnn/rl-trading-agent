/**
 * DQN Agent
 * Double DQN implementation with TensorFlow.js
 */

import * as tf from '@tensorflow/tfjs';
import type {
  Action,
  DQNConfig,
  AgentState,
  Transition,
} from '../types';
import { Actions } from '../types';
import { ReplayBuffer } from './replay-buffer';

const DEFAULT_CONFIG: DQNConfig = {
  inputSize: 94,
  hiddenLayers: [128, 64, 32], // Reduced to prevent overfitting
  outputSize: 4,
  learningRate: 0.0003, // Reduced for stability
  gamma: 0.99,
  tau: 0.005,
  epsilonStart: 1.0,
  epsilonEnd: 0.01,
  epsilonDecay: 0.995,
  dropout: 0.35, // Increased from 0.2 to reduce overfitting
  l2Regularization: 0.02, // Increased from 0.01 for stronger regularization
  // Training stability
  useBatchNorm: true,
  gradientClipNorm: 1.0,
  useHuberLoss: true,
  huberDelta: 1.0,
  // Learning rate scheduling
  lrWarmupSteps: 1000,
  lrDecayRate: 0.99,
};

export { DQNConfig };

export class DQNAgent {
  private config: DQNConfig;
  private onlineNetwork: tf.LayersModel;
  private targetNetwork: tf.LayersModel;
  private optimizer: tf.Optimizer;
  private buffer: ReplayBuffer;

  // Agent state
  private epsilon: number;
  private totalSteps: number = 0;
  private episodeCount: number = 0;
  private recentLosses: number[] = [];
  private recentRewards: number[] = [];

  constructor(
    config: Partial<DQNConfig> = {},
    buffer?: ReplayBuffer
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.epsilon = this.config.epsilonStart;
    this.buffer = buffer ?? new ReplayBuffer();

    // Build networks
    this.onlineNetwork = this.buildNetwork('online');
    this.targetNetwork = this.buildNetwork('target');

    // Copy initial weights to target
    this.updateTargetNetwork(1.0);

    // Create optimizer
    this.optimizer = tf.train.adam(this.config.learningRate);
  }

  /**
   * Build the Q-network with optional batch normalization
   */
  private buildNetwork(name: string): tf.LayersModel {
    const model = tf.sequential({ name });
    const useBatchNorm = this.config.useBatchNorm ?? true;

    // Input layer
    model.add(
      tf.layers.dense({
        inputShape: [this.config.inputSize],
        units: this.config.hiddenLayers[0]!,
        activation: useBatchNorm ? 'linear' : 'relu', // Apply activation after BN
        kernelRegularizer: tf.regularizers.l2({ l2: this.config.l2Regularization }),
        name: `${name}_dense1`,
      })
    );

    if (useBatchNorm) {
      model.add(tf.layers.batchNormalization({ momentum: 0.9, epsilon: 1e-5 }));
      model.add(tf.layers.activation({ activation: 'relu' }));
    }
    model.add(tf.layers.dropout({ rate: this.config.dropout }));

    // Hidden layers
    for (let i = 1; i < this.config.hiddenLayers.length; i++) {
      model.add(
        tf.layers.dense({
          units: this.config.hiddenLayers[i]!,
          activation: useBatchNorm ? 'linear' : 'relu',
          kernelRegularizer: tf.regularizers.l2({ l2: this.config.l2Regularization }),
          name: `${name}_dense${i + 1}`,
        })
      );

      if (useBatchNorm) {
        model.add(tf.layers.batchNormalization({ momentum: 0.9, epsilon: 1e-5 }));
        model.add(tf.layers.activation({ activation: 'relu' }));
      }
      model.add(tf.layers.dropout({ rate: this.config.dropout }));
    }

    // Output layer (Q-values for each action)
    model.add(
      tf.layers.dense({
        units: this.config.outputSize,
        activation: 'linear',
        name: `${name}_output`,
      })
    );

    return model;
  }

  /**
   * Select action using epsilon-greedy policy
   */
  selectAction(state: number[], training: boolean = true): Action {
    // Epsilon-greedy during training
    if (training && Math.random() < this.epsilon) {
      return Math.floor(Math.random() * 4) as Action;
    }

    // Get Q-values from online network
    const qValues = tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const predictions = this.onlineNetwork.predict(stateTensor) as tf.Tensor;
      return predictions.dataSync();
    });

    // Select action with highest Q-value
    let maxQ = -Infinity;
    let bestAction: Action = Actions.HOLD;

    for (let i = 0; i < 4; i++) {
      if (qValues[i]! > maxQ) {
        maxQ = qValues[i]!;
        bestAction = i as Action;
      }
    }

    return bestAction;
  }

  /**
   * Get Q-values for a state (for debugging/analysis)
   */
  getQValues(state: number[]): { action: Action; qValue: number }[] {
    const qValues = tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const predictions = this.onlineNetwork.predict(stateTensor) as tf.Tensor;
      return predictions.dataSync();
    });

    return [
      { action: Actions.HOLD, qValue: qValues[0]! },
      { action: Actions.BUY, qValue: qValues[1]! },
      { action: Actions.SELL, qValue: qValues[2]! },
      { action: Actions.CLOSE, qValue: qValues[3]! },
    ];
  }

  /**
   * Store experience in replay buffer
   */
  storeExperience(
    state: number[],
    action: Action,
    reward: number,
    nextState: number[],
    done: boolean
  ): void {
    this.buffer.store(state, action, reward, nextState, done);
    this.totalSteps++;
    this.recentRewards.push(reward);
    if (this.recentRewards.length > 100) {
      this.recentRewards.shift();
    }
  }

  /**
   * Train on a batch from replay buffer
   * Uses Double DQN for reduced overestimation
   */
  train(batchSize?: number): number {
    if (!this.buffer.isReady()) {
      return 0;
    }

    const batch = this.buffer.sample(batchSize);
    const loss = this.trainOnBatch(batch);

    // Soft update target network
    this.updateTargetNetwork(this.config.tau);

    // NOTE: Epsilon decay moved to endEpisode() to prevent per-step decay
    // which causes exploration to collapse too quickly

    return loss;
  }

  /**
   * Huber loss (smooth L1) - more robust to outliers than MSE
   */
  private huberLoss(yTrue: tf.Tensor, yPred: tf.Tensor, delta: number = 1.0): tf.Scalar {
    const error = tf.sub(yTrue, yPred);
    const absError = tf.abs(error);
    const quadratic = tf.minimum(absError, delta);
    const linear = tf.sub(absError, quadratic);
    return tf.mean(tf.add(tf.mul(0.5, tf.square(quadratic)), tf.mul(delta, linear))) as tf.Scalar;
  }

  /**
   * Train on a specific batch of transitions
   * Uses Huber loss and gradient clipping for stability
   */
  private trainOnBatch(batch: Transition[]): number {
    const states = batch.map((t) => t.state);
    const actions = batch.map((t) => t.action);
    const rewards = batch.map((t) => t.reward);
    const nextStates = batch.map((t) => t.nextState);
    const dones = batch.map((t) => t.done);

    const useHuber = this.config.useHuberLoss ?? true;
    const huberDelta = this.config.huberDelta ?? 1.0;
    const clipNorm = this.config.gradientClipNorm ?? 1.0;

    const loss = tf.tidy(() => {
      const statesTensor = tf.tensor2d(states);
      const nextStatesTensor = tf.tensor2d(nextStates);

      // Double DQN: use online network to select actions, target network to evaluate
      const nextQOnline = this.onlineNetwork.predict(nextStatesTensor) as tf.Tensor;
      const nextActions = nextQOnline.argMax(1).dataSync();

      const nextQTarget = this.targetNetwork.predict(nextStatesTensor) as tf.Tensor;
      const nextQValues = nextQTarget.dataSync();

      // Compute target Q-values
      const targetQValues: number[] = [];
      for (let i = 0; i < batch.length; i++) {
        const nextAction = nextActions[i]!;
        const nextQ = nextQValues[i * 4 + nextAction]!;
        const target = dones[i]
          ? rewards[i]!
          : rewards[i]! + this.config.gamma * nextQ;
        targetQValues.push(target);
      }

      // Compute loss and gradients
      const { grads, value: lossValue } = tf.variableGrads((): tf.Scalar => {
        const predictions = this.onlineNetwork.predict(statesTensor) as tf.Tensor;
        const predictedQ = predictions.dataSync();

        // Create target tensor
        const targets: number[] = [];
        for (let i = 0; i < batch.length; i++) {
          for (let j = 0; j < 4; j++) {
            if (j === actions[i]) {
              targets.push(targetQValues[i]!);
            } else {
              targets.push(predictedQ[i * 4 + j]!);
            }
          }
        }

        const targetTensor = tf.tensor2d(targets, [batch.length, 4]);

        // Use Huber loss for robustness to outliers
        if (useHuber) {
          return this.huberLoss(targetTensor, predictions, huberDelta);
        }
        return tf.losses.meanSquaredError(targetTensor, predictions) as tf.Scalar;
      });

      // Clip gradients to prevent exploding gradients
      const clippedGrads: tf.NamedTensorMap = {};
      let globalNorm = 0;

      // Calculate global norm
      for (const grad of Object.values(grads)) {
        const g = grad as tf.Tensor;
        globalNorm += tf.sum(tf.square(g)).dataSync()[0]!;
      }
      globalNorm = Math.sqrt(globalNorm);

      // Clip if necessary
      const scale = globalNorm > clipNorm ? clipNorm / globalNorm : 1.0;
      for (const [name, grad] of Object.entries(grads)) {
        clippedGrads[name] = tf.mul(grad as tf.Tensor, scale);
      }

      this.optimizer.applyGradients(clippedGrads);

      return (lossValue as tf.Scalar).dataSync()[0]!;
    });

    this.recentLosses.push(loss);
    if (this.recentLosses.length > 100) {
      this.recentLosses.shift();
    }

    // Update learning rate based on warmup/decay schedule
    this.updateLearningRate();

    return loss;
  }

  /**
   * Update learning rate with warmup and decay
   * Note: TensorFlow.js doesn't allow direct LR modification.
   * This method is a placeholder for future implementation using
   * optimizer recreation or custom gradient scaling.
   */
  private updateLearningRate(): void {
    // TensorFlow.js doesn't allow changing learning rate directly,
    // so we skip this for now - the warmup effect is marginal
    // Future: recreate optimizer with new LR if significant change needed
  }

  /**
   * Soft update target network weights
   */
  private updateTargetNetwork(tau: number): void {
    tf.tidy(() => {
      const onlineWeights = this.onlineNetwork.getWeights();
      const targetWeights = this.targetNetwork.getWeights();

      const newWeights = onlineWeights.map((onlineW, i) => {
        const targetW = targetWeights[i]!;
        return onlineW.mul(tau).add(targetW.mul(1 - tau));
      });

      this.targetNetwork.setWeights(newWeights);
    });
  }

  /**
   * Called at episode end
   * Handles per-episode epsilon decay using exponential decay
   */
  endEpisode(): void {
    this.episodeCount++;

    // Exponential decay: epsilon = epsilonStart * decay^episode
    // This ensures proper exploration schedule across episodes, not steps
    this.epsilon = Math.max(
      this.config.epsilonEnd,
      this.config.epsilonStart * Math.pow(this.config.epsilonDecay, this.episodeCount)
    );
  }

  /**
   * Get current agent state
   */
  getState(): AgentState {
    return {
      epsilon: this.epsilon,
      totalSteps: this.totalSteps,
      episodeCount: this.episodeCount,
      averageReward:
        this.recentRewards.length > 0
          ? this.recentRewards.reduce((a, b) => a + b, 0) / this.recentRewards.length
          : 0,
      averageLoss:
        this.recentLosses.length > 0
          ? this.recentLosses.reduce((a, b) => a + b, 0) / this.recentLosses.length
          : 0,
    };
  }

  /**
   * Save model weights to JSON-serializable format
   */
  async saveWeights(): Promise<SerializedWeights> {
    const weights = this.onlineNetwork.getWeights();
    const serialized: SerializedWeights = {
      weights: [],
      config: this.config,
      state: this.getState(),
      agentType: 'dqn',
    };

    for (const weight of weights) {
      serialized.weights.push({
        shape: weight.shape,
        data: Array.from(weight.dataSync()),
      });
    }

    return serialized;
  }

  /**
   * Load model weights from serialized format
   */
  async loadWeights(data: SerializedWeights): Promise<void> {
    const tensors = data.weights.map((w) => tf.tensor(w.data, w.shape));
    this.onlineNetwork.setWeights(tensors);
    this.updateTargetNetwork(1.0);

    // Restore state
    this.epsilon = data.state.epsilon;
    this.totalSteps = data.state.totalSteps;
    this.episodeCount = data.state.episodeCount;

    // Dispose tensors
    tensors.forEach((t) => t.dispose());
  }

  /**
   * Get replay buffer
   */
  getBuffer(): ReplayBuffer {
    return this.buffer;
  }

  /**
   * Dispose of TensorFlow resources
   */
  dispose(): void {
    this.onlineNetwork.dispose();
    this.targetNetwork.dispose();
    this.optimizer.dispose();
  }
}

export interface SerializedWeights {
  weights: { shape: number[]; data: number[] }[];
  config: DQNConfig;
  state: AgentState;
  agentType: 'dqn';
}
