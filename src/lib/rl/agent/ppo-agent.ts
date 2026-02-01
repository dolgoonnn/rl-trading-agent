/**
 * PPO Agent
 * Proximal Policy Optimization implementation with TensorFlow.js
 */

import * as tf from '@tensorflow/tfjs';
import type { Action, AgentState } from '../types';
import { Actions } from '../types';
import type { RolloutAgent, SerializedWeights } from './base-agent';
import { buildActorNetwork, buildCriticNetwork } from './actor-critic';

export interface PPOConfig {
  inputSize: number;
  hiddenLayers: number[];
  numActions: number;

  // PPO hyperparameters
  learningRate: number;
  gamma: number; // Discount factor
  lambda: number; // GAE lambda
  clipRatio: number; // PPO clip parameter
  entropyCoef: number; // Entropy bonus coefficient
  valueCoef: number; // Value loss coefficient

  // Training
  nSteps: number; // Rollout length before training
  nEpochs: number; // Training epochs per rollout
  miniBatchSize: number;

  // Regularization
  useBatchNorm: boolean;
  dropout: number;
  l2Regularization: number;
  gradientClipNorm: number;
}

const DEFAULT_CONFIG: PPOConfig = {
  inputSize: 96,
  hiddenLayers: [128, 64, 32], // Reduced to prevent overfitting
  numActions: 4,

  learningRate: 0.0003,
  gamma: 0.99,
  lambda: 0.95,
  clipRatio: 0.2,
  entropyCoef: 0.01,
  valueCoef: 0.5,

  nSteps: 2048,
  nEpochs: 10,
  miniBatchSize: 64,

  useBatchNorm: true,
  dropout: 0.25, // Increased from 0.1 to reduce overfitting
  l2Regularization: 0.02, // Increased from 0.01
  gradientClipNorm: 0.5,
};

interface RolloutStep {
  state: number[];
  action: Action;
  reward: number;
  value: number;
  logProb: number;
  done: boolean;
}

export class PPOAgent implements RolloutAgent {
  private config: PPOConfig;
  private actor: tf.LayersModel;
  private critic: tf.LayersModel;
  private actorOptimizer: tf.Optimizer;
  private criticOptimizer: tf.Optimizer;

  // Rollout buffer
  private rolloutBuffer: RolloutStep[] = [];

  // Agent state
  private totalSteps: number = 0;
  private episodeCount: number = 0;
  private recentLosses: number[] = [];
  private recentRewards: number[] = [];

  constructor(config: Partial<PPOConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Build networks
    this.actor = buildActorNetwork({
      inputSize: this.config.inputSize,
      hiddenLayers: this.config.hiddenLayers,
      numActions: this.config.numActions,
      useBatchNorm: this.config.useBatchNorm,
      dropout: this.config.dropout,
      l2Regularization: this.config.l2Regularization,
    });

    this.critic = buildCriticNetwork({
      inputSize: this.config.inputSize,
      hiddenLayers: this.config.hiddenLayers,
      useBatchNorm: this.config.useBatchNorm,
      dropout: this.config.dropout,
      l2Regularization: this.config.l2Regularization,
    });

    // Create optimizers
    this.actorOptimizer = tf.train.adam(this.config.learningRate);
    this.criticOptimizer = tf.train.adam(this.config.learningRate);
  }

  /**
   * Select action using the policy network
   */
  selectAction(state: number[], training: boolean = true): Action {
    return tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const logits = this.actor.predict(stateTensor) as tf.Tensor;
      const probs = tf.softmax(logits);
      const probsData = probs.dataSync();

      if (training) {
        // Sample from distribution
        const rand = Math.random();
        let cumProb = 0;
        for (let i = 0; i < 4; i++) {
          cumProb += probsData[i]!;
          if (rand < cumProb) {
            return i as Action;
          }
        }
        return Actions.HOLD;
      } else {
        // Greedy action
        let maxProb = -Infinity;
        let bestAction: Action = Actions.HOLD;
        for (let i = 0; i < 4; i++) {
          if (probsData[i]! > maxProb) {
            maxProb = probsData[i]!;
            bestAction = i as Action;
          }
        }
        return bestAction;
      }
    });
  }

  /**
   * Get action probabilities and value for a state
   */
  private getActionProbsAndValue(state: number[]): { probs: number[]; value: number; logProbs: number[] } {
    return tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const logits = this.actor.predict(stateTensor) as tf.Tensor;
      const probs = tf.softmax(logits);
      const logProbs = tf.logSoftmax(logits);
      const value = this.critic.predict(stateTensor) as tf.Tensor;

      return {
        probs: Array.from(probs.dataSync()),
        logProbs: Array.from(logProbs.dataSync()),
        value: value.dataSync()[0]!,
      };
    });
  }

  /**
   * Store a step in the rollout buffer
   */
  storeStep(
    state: number[],
    action: Action,
    reward: number,
    value: number,
    logProb: number,
    done: boolean
  ): void {
    this.rolloutBuffer.push({
      state: [...state],
      action,
      reward,
      value,
      logProb,
      done,
    });

    this.totalSteps++;
    this.recentRewards.push(reward);
    if (this.recentRewards.length > 100) {
      this.recentRewards.shift();
    }
  }

  /**
   * Convenience method for storing during training loop
   */
  storeExperience(
    state: number[],
    action: Action,
    reward: number,
    _nextState: number[],
    done: boolean
  ): void {
    const { value, logProbs } = this.getActionProbsAndValue(state);
    const logProb = logProbs[action]!;
    this.storeStep(state, action, reward, value, logProb, done);
  }

  /**
   * Complete rollout and compute advantages using GAE
   */
  completeRollout(lastValue: number): number {
    if (this.rolloutBuffer.length === 0) {
      return 0;
    }

    // Compute advantages using GAE (Generalized Advantage Estimation)
    const { advantages, returns } = this.computeGAE(lastValue);

    // Normalize advantages
    const advMean = advantages.reduce((a, b) => a + b, 0) / advantages.length;
    const advStd = Math.sqrt(
      advantages.reduce((a, b) => a + Math.pow(b - advMean, 2), 0) / advantages.length
    ) + 1e-8;
    const normalizedAdvantages = advantages.map((a) => (a - advMean) / advStd);

    // Train for multiple epochs
    let totalLoss = 0;
    for (let epoch = 0; epoch < this.config.nEpochs; epoch++) {
      const epochLoss = this.trainEpoch(normalizedAdvantages, returns);
      totalLoss += epochLoss;
    }

    const avgLoss = totalLoss / this.config.nEpochs;
    this.recentLosses.push(avgLoss);
    if (this.recentLosses.length > 100) {
      this.recentLosses.shift();
    }

    // Clear rollout buffer
    this.rolloutBuffer = [];

    return avgLoss;
  }

  /**
   * Train on rollout - called every nSteps
   */
  train(): number {
    // PPO trains via completeRollout, not every step
    // Check if we have enough steps
    if (this.rolloutBuffer.length >= this.config.nSteps) {
      // Get value of last state for bootstrapping
      const lastStep = this.rolloutBuffer[this.rolloutBuffer.length - 1]!;
      const { value: lastValue } = this.getActionProbsAndValue(lastStep.state);
      return this.completeRollout(lastStep.done ? 0 : lastValue);
    }
    return 0;
  }

  /**
   * Compute GAE advantages and returns
   */
  private computeGAE(lastValue: number): { advantages: number[]; returns: number[] } {
    const advantages: number[] = new Array(this.rolloutBuffer.length);
    const returns: number[] = new Array(this.rolloutBuffer.length);

    let lastGAE = 0;
    let lastReturn = lastValue;

    for (let t = this.rolloutBuffer.length - 1; t >= 0; t--) {
      const step = this.rolloutBuffer[t]!;
      const nextValue = t === this.rolloutBuffer.length - 1 ? lastValue : this.rolloutBuffer[t + 1]!.value;
      const mask = step.done ? 0 : 1;

      const delta = step.reward + this.config.gamma * nextValue * mask - step.value;
      lastGAE = delta + this.config.gamma * this.config.lambda * mask * lastGAE;
      advantages[t] = lastGAE;

      lastReturn = step.reward + this.config.gamma * mask * lastReturn;
      returns[t] = lastReturn;
    }

    return { advantages, returns };
  }

  /**
   * Train for one epoch on the rollout data
   */
  private trainEpoch(advantages: number[], returns: number[]): number {
    // Shuffle indices for mini-batches
    const indices = Array.from({ length: this.rolloutBuffer.length }, (_, i) => i);
    this.shuffleArray(indices);

    let totalLoss = 0;
    let batchCount = 0;

    for (let i = 0; i < indices.length; i += this.config.miniBatchSize) {
      const batchIndices = indices.slice(i, i + this.config.miniBatchSize);
      if (batchIndices.length === 0) continue;

      const batchLoss = this.trainMiniBatch(batchIndices, advantages, returns);
      totalLoss += batchLoss;
      batchCount++;
    }

    return batchCount > 0 ? totalLoss / batchCount : 0;
  }

  /**
   * Train on a mini-batch
   */
  private trainMiniBatch(
    indices: number[],
    advantages: number[],
    returns: number[]
  ): number {
    const batchStates = indices.map((i) => this.rolloutBuffer[i]!.state);
    const batchActions = indices.map((i) => this.rolloutBuffer[i]!.action);
    const batchOldLogProbs = indices.map((i) => this.rolloutBuffer[i]!.logProb);
    const batchAdvantages = indices.map((i) => advantages[i]!);
    const batchReturns = indices.map((i) => returns[i]!);

    const loss = tf.tidy(() => {
      const statesTensor = tf.tensor2d(batchStates);

      // Actor loss
      const { grads: actorGrads, value: actorLoss } = tf.variableGrads(() => {
        const logits = this.actor.predict(statesTensor) as tf.Tensor;
        const logProbs = tf.logSoftmax(logits);
        const logProbsData = logProbs.dataSync();
        const probs = tf.softmax(logits);
        const probsData = probs.dataSync();

        // Get log probs for selected actions
        const selectedLogProbs: number[] = [];
        for (let i = 0; i < indices.length; i++) {
          selectedLogProbs.push(logProbsData[i * 4 + batchActions[i]!]!);
        }

        // Compute ratio
        const ratios = selectedLogProbs.map((logP, i) => Math.exp(logP - batchOldLogProbs[i]!));

        // Clipped surrogate objective
        const surr1 = ratios.map((r, i) => r * batchAdvantages[i]!);
        const surr2 = ratios.map((r, i) =>
          Math.min(Math.max(r, 1 - this.config.clipRatio), 1 + this.config.clipRatio) * batchAdvantages[i]!
        );
        const policyLoss = -surr1.map((s1, i) => Math.min(s1, surr2[i]!)).reduce((a, b) => a + b, 0) / indices.length;

        // Entropy bonus
        let entropy = 0;
        for (let i = 0; i < indices.length; i++) {
          for (let a = 0; a < 4; a++) {
            const p = probsData[i * 4 + a]!;
            if (p > 1e-8) {
              entropy -= p * Math.log(p);
            }
          }
        }
        entropy /= indices.length;

        return tf.scalar(policyLoss - this.config.entropyCoef * entropy);
      });

      // Apply actor gradients with clipping
      this.applyClippedGradients(actorGrads, this.actorOptimizer);

      // Critic loss
      const { grads: criticGrads, value: criticLoss } = tf.variableGrads(() => {
        const values = this.critic.predict(statesTensor) as tf.Tensor;
        const valuesData = values.dataSync();

        // MSE loss
        let valueLoss = 0;
        for (let i = 0; i < indices.length; i++) {
          valueLoss += Math.pow(valuesData[i]! - batchReturns[i]!, 2);
        }
        valueLoss /= indices.length;

        return tf.scalar(valueLoss * this.config.valueCoef);
      });

      // Apply critic gradients with clipping
      this.applyClippedGradients(criticGrads, this.criticOptimizer);

      return (actorLoss as tf.Scalar).dataSync()[0]! + (criticLoss as tf.Scalar).dataSync()[0]!;
    });

    return loss;
  }

  /**
   * Apply gradients with norm clipping
   */
  private applyClippedGradients(grads: tf.NamedTensorMap, optimizer: tf.Optimizer): void {
    let globalNorm = 0;
    for (const grad of Object.values(grads)) {
      const g = grad as tf.Tensor;
      globalNorm += tf.sum(tf.square(g)).dataSync()[0]!;
    }
    globalNorm = Math.sqrt(globalNorm);

    const scale = globalNorm > this.config.gradientClipNorm
      ? this.config.gradientClipNorm / globalNorm
      : 1.0;

    const clippedGrads: tf.NamedTensorMap = {};
    for (const [name, grad] of Object.entries(grads)) {
      clippedGrads[name] = tf.mul(grad as tf.Tensor, scale);
    }

    optimizer.applyGradients(clippedGrads);
  }

  /**
   * Fisher-Yates shuffle
   */
  private shuffleArray<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j]!, array[i]!];
    }
  }

  /**
   * Called at episode end
   */
  endEpisode(): void {
    this.episodeCount++;
  }

  /**
   * Get current agent state
   */
  getState(): AgentState {
    return {
      epsilon: 0, // PPO doesn't use epsilon-greedy
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
   * Save model weights
   */
  async saveWeights(): Promise<SerializedWeights> {
    const actorWeights = this.actor.getWeights();
    const criticWeights = this.critic.getWeights();

    const serialized: SerializedWeights = {
      weights: [],
      config: this.config as unknown as Record<string, unknown>,
      state: this.getState(),
      agentType: 'ppo',
    };

    // Serialize actor weights
    for (const weight of actorWeights) {
      serialized.weights.push({
        shape: weight.shape,
        data: Array.from(weight.dataSync()),
      });
    }

    // Add separator
    serialized.weights.push({ shape: [-1], data: [] });

    // Serialize critic weights
    for (const weight of criticWeights) {
      serialized.weights.push({
        shape: weight.shape,
        data: Array.from(weight.dataSync()),
      });
    }

    return serialized;
  }

  /**
   * Load model weights
   */
  async loadWeights(data: SerializedWeights): Promise<void> {
    // Find separator
    const separatorIdx = data.weights.findIndex((w) => w.shape[0] === -1);

    // Load actor weights
    const actorWeightsData = data.weights.slice(0, separatorIdx);
    const actorTensors = actorWeightsData.map((w) => tf.tensor(w.data, w.shape));
    this.actor.setWeights(actorTensors);
    actorTensors.forEach((t) => t.dispose());

    // Load critic weights
    const criticWeightsData = data.weights.slice(separatorIdx + 1);
    const criticTensors = criticWeightsData.map((w) => tf.tensor(w.data, w.shape));
    this.critic.setWeights(criticTensors);
    criticTensors.forEach((t) => t.dispose());

    // Restore state
    this.totalSteps = data.state.totalSteps;
    this.episodeCount = data.state.episodeCount;
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.actor.dispose();
    this.critic.dispose();
    this.actorOptimizer.dispose();
    this.criticOptimizer.dispose();
  }
}
