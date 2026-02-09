/**
 * Continuous PPO Agent
 *
 * PPO with Gaussian policy for continuous action spaces.
 * Designed for the Weight Optimizer: learns regime-adaptive multipliers
 * for the 10 confluence scoring weights.
 *
 * Key differences from discrete PPO:
 *   - Actor outputs 10 means + 10 log_stds (Gaussian params)
 *   - Actions sampled from N(mean, std), clipped to [-1, 1]
 *   - Log probability uses Gaussian density (not categorical)
 *   - Entropy = 0.5 * log(2πe * σ²) per action dimension
 *   - Tiny network [32, 16] ≈ 2.4K params to prevent memorization
 */

import * as tf from '@tensorflow/tfjs';
import type { AgentState } from '../types';
import type { SerializedWeights } from './base-agent';

// ============================================
// Config
// ============================================

export interface ContinuousPPOConfig {
  inputSize: number;
  hiddenLayers: number[];
  actionSize: number;

  // PPO hyperparameters
  learningRate: number;
  gamma: number;
  lambda: number;
  clipRatio: number;
  entropyCoef: number;
  valueCoef: number;

  // Training
  nSteps: number;
  nEpochs: number;
  miniBatchSize: number;

  // Gaussian policy
  logStdMin: number;
  logStdMax: number;
  actionClipMin: number;
  actionClipMax: number;

  // Regularization
  gradientClipNorm: number;
  l2Regularization: number;
}

const DEFAULT_CONFIG: ContinuousPPOConfig = {
  inputSize: 14,
  hiddenLayers: [32, 16],
  actionSize: 10,

  learningRate: 0.0003,
  gamma: 0.99,
  lambda: 0.95,
  clipRatio: 0.2,
  entropyCoef: 0.01,
  valueCoef: 0.5,

  nSteps: 128,
  nEpochs: 4,
  miniBatchSize: 32,

  logStdMin: -2.0,
  logStdMax: 0.5,
  actionClipMin: -1.0,
  actionClipMax: 1.0,

  gradientClipNorm: 0.5,
  l2Regularization: 0.001,
};

// ============================================
// Rollout Step
// ============================================

interface ContinuousRolloutStep {
  state: number[];
  action: number[];
  reward: number;
  value: number;
  logProb: number;
  done: boolean;
}

// ============================================
// Agent
// ============================================

export class ContinuousPPOAgent {
  private config: ContinuousPPOConfig;
  private actor: tf.LayersModel;
  private critic: tf.LayersModel;
  private actorOptimizer: tf.Optimizer;
  private criticOptimizer: tf.Optimizer;

  // Rollout buffer
  private rolloutBuffer: ContinuousRolloutStep[] = [];

  // Tracking
  private totalSteps = 0;
  private episodeCount = 0;
  private recentLosses: number[] = [];
  private recentRewards: number[] = [];

  constructor(config: Partial<ContinuousPPOConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.actor = this.buildActor();
    this.critic = this.buildCritic();
    this.actorOptimizer = tf.train.adam(this.config.learningRate);
    this.criticOptimizer = tf.train.adam(this.config.learningRate);
  }

  // ============================================
  // Network Building
  // ============================================

  /**
   * Actor outputs 2 * actionSize values: [means..., logStds...]
   * Means: linear (will be clipped at action selection)
   * LogStds: clipped to [logStdMin, logStdMax]
   */
  private buildActor(): tf.LayersModel {
    const input = tf.input({ shape: [this.config.inputSize] });
    let x: tf.SymbolicTensor = input;

    for (let i = 0; i < this.config.hiddenLayers.length; i++) {
      x = tf.layers.dense({
        units: this.config.hiddenLayers[i]!,
        activation: 'relu',
        kernelRegularizer: tf.regularizers.l2({ l2: this.config.l2Regularization }),
        name: `actor_hidden_${i}`,
      }).apply(x) as tf.SymbolicTensor;
    }

    // Output: actionSize means + actionSize logStds
    const output = tf.layers.dense({
      units: this.config.actionSize * 2,
      activation: 'linear',
      name: 'actor_output',
    }).apply(x) as tf.SymbolicTensor;

    return tf.model({ inputs: input, outputs: output, name: 'continuous_actor' });
  }

  /**
   * Critic outputs a single scalar value estimate.
   */
  private buildCritic(): tf.LayersModel {
    const input = tf.input({ shape: [this.config.inputSize] });
    let x: tf.SymbolicTensor = input;

    for (let i = 0; i < this.config.hiddenLayers.length; i++) {
      x = tf.layers.dense({
        units: this.config.hiddenLayers[i]!,
        activation: 'relu',
        kernelRegularizer: tf.regularizers.l2({ l2: this.config.l2Regularization }),
        name: `critic_hidden_${i}`,
      }).apply(x) as tf.SymbolicTensor;
    }

    const output = tf.layers.dense({
      units: 1,
      activation: 'linear',
      name: 'critic_output',
    }).apply(x) as tf.SymbolicTensor;

    return tf.model({ inputs: input, outputs: output, name: 'continuous_critic' });
  }

  // ============================================
  // Action Selection
  // ============================================

  /**
   * Get mean and std from actor output.
   */
  private parseActorOutput(rawOutput: number[]): { means: number[]; stds: number[] } {
    const n = this.config.actionSize;
    const means: number[] = [];
    const logStds: number[] = [];

    for (let i = 0; i < n; i++) {
      means.push(rawOutput[i]!);
      // Clip logStd to prevent extreme values
      const raw = rawOutput[n + i]!;
      logStds.push(Math.max(this.config.logStdMin, Math.min(this.config.logStdMax, raw)));
    }

    const stds = logStds.map((ls) => Math.exp(ls));
    return { means, stds };
  }

  /**
   * Select continuous actions from Gaussian policy.
   * Returns actions clipped to [-1, 1].
   */
  selectAction(state: number[], training: boolean = true): number[] {
    const rawOutput = tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const output = this.actor.predict(stateTensor) as tf.Tensor;
      return Array.from(output.dataSync());
    });

    const { means, stds } = this.parseActorOutput(rawOutput);

    if (!training) {
      // Deterministic: use means, clipped
      return means.map((m) =>
        Math.max(this.config.actionClipMin, Math.min(this.config.actionClipMax, m)),
      );
    }

    // Stochastic: sample from Gaussian
    const actions: number[] = [];
    for (let i = 0; i < this.config.actionSize; i++) {
      const noise = gaussianRandom();
      const raw = means[i]! + stds[i]! * noise;
      actions.push(Math.max(this.config.actionClipMin, Math.min(this.config.actionClipMax, raw)));
    }

    return actions;
  }

  /**
   * Compute log probability of actions under current Gaussian policy.
   */
  private computeLogProb(state: number[], action: number[]): { logProb: number; value: number } {
    return tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const actorOut = this.actor.predict(stateTensor) as tf.Tensor;
      const actorData = Array.from(actorOut.dataSync());

      const { means, stds } = this.parseActorOutput(actorData);

      // Sum of log probs across all action dimensions
      let logProb = 0;
      for (let i = 0; i < this.config.actionSize; i++) {
        const mu = means[i]!;
        const sigma = stds[i]!;
        const a = action[i]!;
        // log N(a | mu, sigma) = -0.5 * ((a - mu) / sigma)^2 - log(sigma) - 0.5 * log(2π)
        logProb += -0.5 * ((a - mu) / sigma) ** 2 - Math.log(sigma) - 0.5 * Math.log(2 * Math.PI);
      }

      const valueOut = this.critic.predict(stateTensor) as tf.Tensor;
      const value = valueOut.dataSync()[0]!;

      return { logProb, value };
    });
  }

  // ============================================
  // Step Storage
  // ============================================

  /**
   * Store a transition in the rollout buffer.
   */
  storeStep(state: number[], action: number[], reward: number, done: boolean): void {
    const { logProb, value } = this.computeLogProb(state, action);

    this.rolloutBuffer.push({
      state: [...state],
      action: [...action],
      reward,
      value,
      logProb,
      done,
    });

    this.totalSteps++;
    this.recentRewards.push(reward);
    if (this.recentRewards.length > 100) this.recentRewards.shift();
  }

  /**
   * Check if rollout buffer is ready for training.
   */
  isReadyToTrain(): boolean {
    return this.rolloutBuffer.length >= this.config.nSteps;
  }

  // ============================================
  // Training
  // ============================================

  /**
   * Train on collected rollout. Call after isReadyToTrain() returns true.
   * Returns average loss.
   */
  train(): number {
    if (this.rolloutBuffer.length === 0) return 0;

    // Bootstrap last value
    const lastStep = this.rolloutBuffer[this.rolloutBuffer.length - 1]!;
    const lastValue = lastStep.done ? 0 : tf.tidy(() => {
      const s = tf.tensor2d([lastStep.state]);
      return (this.critic.predict(s) as tf.Tensor).dataSync()[0]!;
    });

    // Compute GAE
    const { advantages, returns } = this.computeGAE(lastValue);

    // Normalize advantages
    const advMean = advantages.reduce((a, b) => a + b, 0) / advantages.length;
    const advStd = Math.sqrt(
      advantages.reduce((a, b) => a + (b - advMean) ** 2, 0) / advantages.length,
    ) + 1e-8;
    const normAdv = advantages.map((a) => (a - advMean) / advStd);

    // Train for multiple epochs
    let totalLoss = 0;
    for (let epoch = 0; epoch < this.config.nEpochs; epoch++) {
      totalLoss += this.trainEpoch(normAdv, returns);
    }

    const avgLoss = totalLoss / this.config.nEpochs;
    this.recentLosses.push(avgLoss);
    if (this.recentLosses.length > 100) this.recentLosses.shift();

    // Clear buffer
    this.rolloutBuffer = [];
    return avgLoss;
  }

  private computeGAE(lastValue: number): { advantages: number[]; returns: number[] } {
    const n = this.rolloutBuffer.length;
    const advantages = new Array<number>(n);
    const returns = new Array<number>(n);

    let lastGAE = 0;
    let lastReturn = lastValue;

    for (let t = n - 1; t >= 0; t--) {
      const step = this.rolloutBuffer[t]!;
      const nextVal = t === n - 1 ? lastValue : this.rolloutBuffer[t + 1]!.value;
      const mask = step.done ? 0 : 1;

      const delta = step.reward + this.config.gamma * nextVal * mask - step.value;
      lastGAE = delta + this.config.gamma * this.config.lambda * mask * lastGAE;
      advantages[t] = lastGAE;

      lastReturn = step.reward + this.config.gamma * mask * lastReturn;
      returns[t] = lastReturn;
    }

    return { advantages, returns };
  }

  private trainEpoch(advantages: number[], returns: number[]): number {
    const indices = Array.from({ length: this.rolloutBuffer.length }, (_, i) => i);
    shuffleArray(indices);

    let totalLoss = 0;
    let batchCount = 0;

    for (let i = 0; i < indices.length; i += this.config.miniBatchSize) {
      const batch = indices.slice(i, i + this.config.miniBatchSize);
      if (batch.length === 0) continue;
      totalLoss += this.trainMiniBatch(batch, advantages, returns);
      batchCount++;
    }

    return batchCount > 0 ? totalLoss / batchCount : 0;
  }

  private trainMiniBatch(
    indices: number[],
    advantages: number[],
    returns: number[],
  ): number {
    const batchStates = indices.map((i) => this.rolloutBuffer[i]!.state);
    const batchActions = indices.map((i) => this.rolloutBuffer[i]!.action);
    const batchOldLogProbs = indices.map((i) => this.rolloutBuffer[i]!.logProb);
    const batchOldValues = indices.map((i) => this.rolloutBuffer[i]!.value);
    const batchAdv = indices.map((i) => advantages[i]!);
    const batchReturns = indices.map((i) => returns[i]!);

    const n = this.config.actionSize;

    const loss = tf.tidy(() => {
      const statesTensor = tf.tensor2d(batchStates);
      const actionsTensor = tf.tensor2d(batchActions); // [batch, actionSize]
      const oldLogProbsTensor = tf.tensor1d(batchOldLogProbs);
      const advTensor = tf.tensor1d(batchAdv);
      const returnsTensor = tf.tensor1d(batchReturns);
      const oldValuesTensor = tf.tensor1d(batchOldValues);

      // ---- Actor loss (all tensor ops, no dataSync) ----
      const { grads: actorGrads, value: actorLoss } = tf.variableGrads(() => {
        const actorOut = this.actor.predict(statesTensor) as tf.Tensor; // [batch, 2*actionSize]

        // Split into means and logStds
        const means = tf.slice(actorOut, [0, 0], [-1, n]); // [batch, n]
        const rawLogStds = tf.slice(actorOut, [0, n], [-1, n]); // [batch, n]
        const logStds = tf.clipByValue(rawLogStds, this.config.logStdMin, this.config.logStdMax);
        const stds = tf.exp(logStds);

        // Gaussian log prob: -0.5 * ((a - mu) / sigma)^2 - logStd - 0.5 * log(2π)
        const diff = tf.sub(actionsTensor, means); // [batch, n]
        const normalized = tf.div(diff, stds); // [batch, n]
        const logProbPerDim = tf.sub(
          tf.sub(tf.mul(tf.square(normalized), -0.5), logStds),
          0.5 * Math.log(2 * Math.PI),
        ); // [batch, n]
        const logProbs = tf.sum(logProbPerDim, -1); // [batch]

        // PPO ratio
        const ratio = tf.exp(tf.sub(logProbs, oldLogProbsTensor)); // [batch]
        const clippedRatio = tf.clipByValue(ratio, 1 - this.config.clipRatio, 1 + this.config.clipRatio);

        const surr1 = tf.mul(ratio, advTensor);
        const surr2 = tf.mul(clippedRatio, advTensor);
        const policyLoss = tf.neg(tf.mean(tf.minimum(surr1, surr2)));

        // Entropy: sum over dims of (0.5 + 0.5*log(2π) + logStd)
        const entropyPerDim = tf.add(logStds, 0.5 + 0.5 * Math.log(2 * Math.PI));
        const entropy = tf.mean(tf.sum(entropyPerDim, -1));

        return tf.sub(policyLoss, tf.mul(this.config.entropyCoef, entropy)) as tf.Scalar;
      });

      this.applyClippedGradients(actorGrads, this.actorOptimizer);

      // ---- Critic loss (all tensor ops) ----
      const { grads: criticGrads, value: criticLoss } = tf.variableGrads(() => {
        const values = tf.squeeze(this.critic.predict(statesTensor) as tf.Tensor); // [batch]

        // Simple MSE (skip value clipping for simplicity with tensor ops)
        const valueLoss = tf.mean(tf.square(tf.sub(values, returnsTensor)));

        return tf.mul(valueLoss, this.config.valueCoef) as tf.Scalar;
      });

      this.applyClippedGradients(criticGrads, this.criticOptimizer);

      return (actorLoss as tf.Scalar).dataSync()[0]! + (criticLoss as tf.Scalar).dataSync()[0]!;
    });

    return loss;
  }

  private applyClippedGradients(grads: tf.NamedTensorMap, optimizer: tf.Optimizer): void {
    let globalNorm = 0;
    for (const grad of Object.values(grads)) {
      globalNorm += tf.sum(tf.square(grad as tf.Tensor)).dataSync()[0]!;
    }
    globalNorm = Math.sqrt(globalNorm);

    const scale = globalNorm > this.config.gradientClipNorm
      ? this.config.gradientClipNorm / globalNorm
      : 1.0;

    const clipped: tf.NamedTensorMap = {};
    for (const [name, grad] of Object.entries(grads)) {
      clipped[name] = tf.mul(grad as tf.Tensor, scale);
    }

    optimizer.applyGradients(clipped);
  }

  // ============================================
  // Episode Management
  // ============================================

  endEpisode(): void {
    this.episodeCount++;
  }

  getState(): AgentState {
    return {
      epsilon: 0,
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

  getConfig(): ContinuousPPOConfig {
    return { ...this.config };
  }

  // ============================================
  // Serialization
  // ============================================

  async saveWeights(): Promise<SerializedWeights> {
    const actorWeights = this.actor.getWeights();
    const criticWeights = this.critic.getWeights();

    const serialized: SerializedWeights = {
      weights: [],
      config: this.config as unknown as Record<string, unknown>,
      state: this.getState(),
      agentType: 'continuous_ppo',
    };

    for (const w of actorWeights) {
      serialized.weights.push({ shape: w.shape, data: Array.from(w.dataSync()) });
    }

    // Separator
    serialized.weights.push({ shape: [-1], data: [] });

    for (const w of criticWeights) {
      serialized.weights.push({ shape: w.shape, data: Array.from(w.dataSync()) });
    }

    return serialized;
  }

  async loadWeights(data: SerializedWeights): Promise<void> {
    const sepIdx = data.weights.findIndex((w) => w.shape[0] === -1);

    const actorData = data.weights.slice(0, sepIdx);
    const actorTensors = actorData.map((w) => tf.tensor(w.data, w.shape));
    this.actor.setWeights(actorTensors);
    actorTensors.forEach((t) => t.dispose());

    const criticData = data.weights.slice(sepIdx + 1);
    const criticTensors = criticData.map((w) => tf.tensor(w.data, w.shape));
    this.critic.setWeights(criticTensors);
    criticTensors.forEach((t) => t.dispose());

    this.totalSteps = data.state.totalSteps;
    this.episodeCount = data.state.episodeCount;
  }

  dispose(): void {
    this.actor.dispose();
    this.critic.dispose();
    this.actorOptimizer.dispose();
    this.criticOptimizer.dispose();
  }

  /** Get parameter count for diagnostics. */
  getParamCount(): { actor: number; critic: number; total: number } {
    const actorParams = this.actor.getWeights().reduce((s, w) => s + w.size, 0);
    const criticParams = this.critic.getWeights().reduce((s, w) => s + w.size, 0);
    return { actor: actorParams, critic: criticParams, total: actorParams + criticParams };
  }
}

// ============================================
// Helpers
// ============================================

/** Box-Muller transform for Gaussian random numbers. */
function gaussianRandom(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function shuffleArray<T>(array: T[]): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j]!, array[i]!];
  }
}
