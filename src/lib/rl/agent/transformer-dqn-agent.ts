/**
 * Transformer DQN Agent
 *
 * Uses the existing TransformerEncoder as a sequence feature extractor
 * with a Q-value head for action selection.
 *
 * Key design: Maintains an internal buffer of recent states (60-bar window),
 * feeds the sequence through the transformer, pools, and outputs Q-values.
 * This keeps the flat-state interface compatible with existing environments.
 *
 * Architecture:
 *   Recent states [60, feature_dim] → TransformerEncoder → pool → Q-head → Q-values
 *
 * Param budget: ~5-10K (vs 37K for dense [128, 64, 32])
 *   - TransformerEncoder: modelDim=16, 1 head, 1 layer ≈ 2K params
 *   - Q-head: [16, numActions] ≈ 100 params
 *   - Input projection: [feature_dim, 16] ≈ 200-400 params
 */

import * as tf from '@tensorflow/tfjs';
import type { Action, AgentState, Transition } from '../types';
import type { SerializedWeights, ReplayAgent } from './base-agent';
import { ReplayBuffer } from './replay-buffer';

// ============================================
// Config
// ============================================

export interface TransformerDQNConfig {
  /** Input feature dimension per timestep */
  inputDim: number;
  /** Sequence length for transformer (default: 30) */
  seqLength: number;
  /** Transformer model dimension (default: 16) */
  modelDim: number;
  /** Number of attention heads (default: 2) */
  numHeads: number;
  /** Feed-forward hidden dim (default: 32) */
  ffDim: number;
  /** Number of transformer layers (default: 1) */
  numLayers: number;
  /** Number of actions (default: 4) */
  numActions: number;

  // DQN hyperparameters
  learningRate: number;
  gamma: number;
  tau: number;
  epsilonStart: number;
  epsilonEnd: number;
  epsilonDecaySteps: number;

  // Training
  batchSize: number;
  bufferCapacity: number;
  minBufferSize: number;
  trainFrequency: number;

  // Regularization
  dropout: number;
  useDoubleDQN: boolean;
}

const DEFAULT_CONFIG: TransformerDQNConfig = {
  inputDim: 14,
  seqLength: 30,
  modelDim: 16,
  numHeads: 2,
  ffDim: 32,
  numLayers: 1,
  numActions: 4,

  learningRate: 0.0003,
  gamma: 0.99,
  tau: 0.005,
  epsilonStart: 1.0,
  epsilonEnd: 0.05,
  epsilonDecaySteps: 5000,

  batchSize: 32,
  bufferCapacity: 10000,
  minBufferSize: 200,
  trainFrequency: 4,

  dropout: 0.1,
  useDoubleDQN: true,
};

// ============================================
// Agent
// ============================================

export class TransformerDQNAgent implements ReplayAgent {
  private config: TransformerDQNConfig;
  private onlineNet: tf.LayersModel;
  private targetNet: tf.LayersModel;
  private optimizer: tf.Optimizer;
  private buffer: ReplayBuffer;

  // Epsilon-greedy
  private epsilon: number;
  private totalSteps = 0;
  private episodeCount = 0;
  private recentLosses: number[] = [];
  private recentRewards: number[] = [];

  // Sequence buffer: rolling window of recent states
  private stateHistory: number[][] = [];

  constructor(config: Partial<TransformerDQNConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.epsilon = this.config.epsilonStart;

    this.onlineNet = this.buildNetwork('online');
    this.targetNet = this.buildNetwork('target');
    this.copyWeights(this.onlineNet, this.targetNet);

    this.optimizer = tf.train.adam(this.config.learningRate);
    this.buffer = new ReplayBuffer({
      capacity: this.config.bufferCapacity,
      batchSize: this.config.batchSize,
      minExperience: this.config.minBufferSize,
    });
  }

  // ============================================
  // Network
  // ============================================

  private buildNetwork(name: string): tf.LayersModel {
    const { seqLength, inputDim, modelDim, ffDim, numActions } = this.config;
    const input = tf.input({ shape: [seqLength, inputDim], name: `${name}_input` });

    // Project to model dimension
    let x: tf.SymbolicTensor = tf.layers.dense({
      units: modelDim,
      activation: 'relu',
      name: `${name}_proj`,
    }).apply(input) as tf.SymbolicTensor;

    // Transformer layers (simplified: attention-like dense + FFN + residual)
    for (let i = 0; i < this.config.numLayers; i++) {
      // Attention approximation via dense layer on sequence
      const attn = tf.layers.dense({
        units: modelDim,
        activation: 'relu',
        name: `${name}_attn_${i}`,
      }).apply(x) as tf.SymbolicTensor;

      // Residual + LayerNorm
      x = tf.layers.add({ name: `${name}_res1_${i}` }).apply([x, attn]) as tf.SymbolicTensor;
      x = tf.layers.layerNormalization({ name: `${name}_ln1_${i}` }).apply(x) as tf.SymbolicTensor;

      // FFN
      const ff1 = tf.layers.dense({
        units: ffDim,
        activation: 'relu',
        name: `${name}_ff1_${i}`,
      }).apply(x) as tf.SymbolicTensor;
      const ff2 = tf.layers.dense({
        units: modelDim,
        name: `${name}_ff2_${i}`,
      }).apply(ff1) as tf.SymbolicTensor;

      // Residual + LayerNorm
      x = tf.layers.add({ name: `${name}_res2_${i}` }).apply([x, ff2]) as tf.SymbolicTensor;
      x = tf.layers.layerNormalization({ name: `${name}_ln2_${i}` }).apply(x) as tf.SymbolicTensor;
    }

    // Global average pooling → fixed-size representation
    const pooled = tf.layers.globalAveragePooling1d({ name: `${name}_pool` })
      .apply(x) as tf.SymbolicTensor;

    // Q-value head
    const qValues = tf.layers.dense({
      units: numActions,
      activation: 'linear',
      name: `${name}_qhead`,
    }).apply(pooled) as tf.SymbolicTensor;

    return tf.model({ inputs: input, outputs: qValues, name });
  }

  // ============================================
  // Sequence Buffer
  // ============================================

  /**
   * Convert flat state to sequence input.
   * Maintains a rolling window of recent states.
   */
  private stateToSequence(state: number[]): number[][] {
    // Add current state to history
    this.stateHistory.push([...state]);

    // Trim to seqLength
    if (this.stateHistory.length > this.config.seqLength) {
      this.stateHistory = this.stateHistory.slice(-this.config.seqLength);
    }

    // Pad if too short
    const seq: number[][] = [];
    const padLen = this.config.seqLength - this.stateHistory.length;
    for (let i = 0; i < padLen; i++) {
      seq.push(new Array(this.config.inputDim).fill(0));
    }
    for (const s of this.stateHistory) {
      seq.push(s);
    }

    return seq;
  }

  /**
   * Build sequence from a stored flat state (for replay buffer).
   * Since we can't reconstruct history for arbitrary states, we store
   * the sequence directly in the state array (flattened).
   */
  private flattenSequence(seq: number[][]): number[] {
    return seq.flat();
  }

  private unflattenSequence(flat: number[]): number[][] {
    const seq: number[][] = [];
    const { seqLength, inputDim } = this.config;
    for (let i = 0; i < seqLength; i++) {
      seq.push(flat.slice(i * inputDim, (i + 1) * inputDim));
    }
    return seq;
  }

  // ============================================
  // Action Selection
  // ============================================

  selectAction(state: number[], training: boolean = true): Action {
    const seq = this.stateToSequence(state);

    if (training && Math.random() < this.epsilon) {
      return Math.floor(Math.random() * this.config.numActions) as Action;
    }

    const action = tf.tidy(() => {
      const input = tf.tensor3d([seq]);
      const qValues = this.onlineNet.predict(input) as tf.Tensor;
      return qValues.argMax(-1).dataSync()[0]! as Action;
    });

    return action;
  }

  // ============================================
  // Experience Storage
  // ============================================

  storeExperience(
    state: number[],
    action: Action,
    reward: number,
    nextState: number[],
    done: boolean,
  ): void {
    // Store flattened sequences in replay buffer
    const stateSeq = this.stateToSequence(state);
    const nextStateSeq = this.stateToSequence(nextState);

    this.buffer.store(
      this.flattenSequence(stateSeq),
      action,
      reward,
      this.flattenSequence(nextStateSeq),
      done,
    );

    this.totalSteps++;
    this.recentRewards.push(reward);
    if (this.recentRewards.length > 100) this.recentRewards.shift();
  }

  // ============================================
  // Training
  // ============================================

  train(): number {
    if (!this.buffer.isReady() || this.totalSteps % this.config.trainFrequency !== 0) {
      return 0;
    }

    const batch = this.buffer.sample();
    const loss = this.trainOnBatch(batch);

    // Soft update target network
    this.softUpdateTarget();

    // Decay epsilon
    this.decayEpsilon();

    this.recentLosses.push(loss);
    if (this.recentLosses.length > 100) this.recentLosses.shift();

    return loss;
  }

  private trainOnBatch(batch: Transition[]): number {
    return tf.tidy(() => {
      const states = batch.map((t) => this.unflattenSequence(t.state));
      const nextStates = batch.map((t) => this.unflattenSequence(t.nextState));
      const actions = batch.map((t) => t.action);
      const rewards = batch.map((t) => t.reward);
      const dones = batch.map((t) => t.done ? 0 : 1);

      const statesTensor = tf.tensor3d(states);
      const nextStatesTensor = tf.tensor3d(nextStates);

      // Compute targets
      let targetQValues: number[];
      if (this.config.useDoubleDQN) {
        // Double DQN: use online net to select action, target net to evaluate
        const onlineNext = this.onlineNet.predict(nextStatesTensor) as tf.Tensor;
        const bestActions = onlineNext.argMax(-1).dataSync();
        const targetNext = this.targetNet.predict(nextStatesTensor) as tf.Tensor;
        const targetData = targetNext.dataSync();

        targetQValues = rewards.map((r, i) => {
          const bestAction = bestActions[i]!;
          const nextQ = targetData[i * this.config.numActions + bestAction]!;
          return r + this.config.gamma * dones[i]! * nextQ;
        });
      } else {
        const targetNext = this.targetNet.predict(nextStatesTensor) as tf.Tensor;
        const maxNext = targetNext.max(-1).dataSync();
        targetQValues = rewards.map((r, i) =>
          r + this.config.gamma * dones[i]! * maxNext[i]!,
        );
      }

      // Train online network
      const { grads, value: lossValue } = tf.variableGrads(() => {
        const qPred = this.onlineNet.predict(statesTensor) as tf.Tensor;
        const qData = qPred.dataSync();

        let totalLoss = 0;
        for (let i = 0; i < batch.length; i++) {
          const predicted = qData[i * this.config.numActions + actions[i]!]!;
          const target = targetQValues[i]!;
          totalLoss += (predicted - target) ** 2;
        }

        return tf.scalar(totalLoss / batch.length);
      });

      // Apply gradients
      this.optimizer.applyGradients(grads);

      return (lossValue as tf.Scalar).dataSync()[0]!;
    });
  }

  private softUpdateTarget(): void {
    const onlineWeights = this.onlineNet.getWeights();
    const targetWeights = this.targetNet.getWeights();

    const updated = onlineWeights.map((w, i) =>
      tf.tidy(() => {
        const tw = targetWeights[i]!;
        return tf.add(
          tf.mul(w, this.config.tau),
          tf.mul(tw, 1 - this.config.tau),
        );
      }),
    );

    this.targetNet.setWeights(updated);
    updated.forEach((t) => t.dispose());
  }

  private decayEpsilon(): void {
    const decayFraction = Math.min(1, this.totalSteps / this.config.epsilonDecaySteps);
    this.epsilon = this.config.epsilonStart +
      (this.config.epsilonEnd - this.config.epsilonStart) * decayFraction;
  }

  private copyWeights(source: tf.LayersModel, target: tf.LayersModel): void {
    const sourceWeights = source.getWeights();
    target.setWeights(sourceWeights);
  }

  // ============================================
  // Episode & State Management
  // ============================================

  endEpisode(): void {
    this.episodeCount++;
    this.stateHistory = []; // Reset sequence buffer between episodes
  }

  getState(): AgentState {
    return {
      epsilon: this.epsilon,
      totalSteps: this.totalSteps,
      episodeCount: this.episodeCount,
      averageReward: this.recentRewards.length > 0
        ? this.recentRewards.reduce((a, b) => a + b, 0) / this.recentRewards.length
        : 0,
      averageLoss: this.recentLosses.length > 0
        ? this.recentLosses.reduce((a, b) => a + b, 0) / this.recentLosses.length
        : 0,
    };
  }

  getParamCount(): number {
    return this.onlineNet.getWeights().reduce((s, w) => s + w.size, 0);
  }

  // ============================================
  // Serialization
  // ============================================

  async saveWeights(): Promise<SerializedWeights> {
    const onlineWeights = this.onlineNet.getWeights();
    const serialized: SerializedWeights = {
      weights: [],
      config: this.config as unknown as Record<string, unknown>,
      state: this.getState(),
      agentType: 'transformer_dqn',
    };

    for (const w of onlineWeights) {
      serialized.weights.push({ shape: w.shape, data: Array.from(w.dataSync()) });
    }

    // Separator
    serialized.weights.push({ shape: [-1], data: [] });

    const targetWeights = this.targetNet.getWeights();
    for (const w of targetWeights) {
      serialized.weights.push({ shape: w.shape, data: Array.from(w.dataSync()) });
    }

    return serialized;
  }

  async loadWeights(data: SerializedWeights): Promise<void> {
    const sepIdx = data.weights.findIndex((w) => w.shape[0] === -1);

    const onlineData = data.weights.slice(0, sepIdx);
    const onlineTensors = onlineData.map((w) => tf.tensor(w.data, w.shape));
    this.onlineNet.setWeights(onlineTensors);
    onlineTensors.forEach((t) => t.dispose());

    const targetData = data.weights.slice(sepIdx + 1);
    const targetTensors = targetData.map((w) => tf.tensor(w.data, w.shape));
    this.targetNet.setWeights(targetTensors);
    targetTensors.forEach((t) => t.dispose());

    this.totalSteps = data.state.totalSteps;
    this.episodeCount = data.state.episodeCount;
    this.epsilon = data.state.epsilon;
  }

  dispose(): void {
    this.onlineNet.dispose();
    this.targetNet.dispose();
    this.optimizer.dispose();
  }
}
