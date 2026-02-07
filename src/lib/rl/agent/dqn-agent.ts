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
import { ReplayBuffer, PrioritizedReplayBuffer, NStepReplayBuffer } from './replay-buffer';
import { NoisyDense, setNoisyLayerTrainingMode } from './noisy-layer';

/**
 * Custom layer for Dueling DQN: combines Value and Advantage streams
 * Q(s,a) = V(s) + (A(s,a) - mean(A(s,:)))
 */
class DuelingCombineLayer extends tf.layers.Layer {
  static className = 'DuelingCombineLayer';

  constructor(config?: tf.serialization.ConfigDict) {
    super(config ?? {});
  }

  call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor | tf.Tensor[] {
    return tf.tidy(() => {
      const inputArray = inputs as tf.Tensor[];
      const value = inputArray[0]!;
      const advantage = inputArray[1]!;
      // value shape: [batch, 1]
      // advantage shape: [batch, numActions]

      // Q = V + (A - mean(A))
      const advantageMean = tf.mean(advantage, -1, true);
      const normalizedAdvantage = tf.sub(advantage, advantageMean);
      return tf.add(value, normalizedAdvantage);
    });
  }

  computeOutputShape(inputShape: tf.Shape[]): tf.Shape {
    // Output shape matches advantage shape [batch, numActions]
    return inputShape[1]!;
  }

  getConfig(): tf.serialization.ConfigDict {
    return super.getConfig();
  }
}

// Register the custom layer
tf.serialization.registerClass(DuelingCombineLayer);

const DEFAULT_CONFIG: DQNConfig = {
  inputSize: 104, // Updated: was 94, now 104 with BOS/CHoCH features
  hiddenLayers: [128, 64, 32], // Larger capacity for complex patterns
  outputSize: 4,
  learningRate: 0.0003,
  gamma: 0.99,
  tau: 0.005,
  epsilonStart: 1.0,
  epsilonEnd: 0.05, // Maintain exploration floor
  epsilonDecay: 0.995, // Used for exponential mode (legacy)
  dropout: 0.25, // Reduced dropout
  l2Regularization: 0.01, // Reduced L2
  // Training stability
  useBatchNorm: true,
  gradientClipNorm: 1.0,
  useHuberLoss: true,
  huberDelta: 1.0,
  // Learning rate scheduling
  lrWarmupSteps: 1000,
  lrDecayRate: 0.99,
  // Noisy networks (replaces epsilon-greedy)
  useNoisyNetworks: false, // Set to true to use NoisyNet exploration
  noisySigmaInit: 0.5, // Initial noise scale
  // Action bias settings (to prevent "hold" collapse)
  actionBias: true, // Enable action exploration bonus
  actionBiasDecay: 0.999, // Decay rate for action bias
  // Epsilon decay mode (Phase 2 research-backed improvements)
  // Research: "Linear decay with reward-based adjustment outperforms exponential decay"
  useLinearEpsilonDecay: true, // NEW: Use linear instead of exponential decay
  totalExpectedEpisodes: 200, // NEW: For linear decay calculation
  rewardBasedEpsilonAdjustment: true, // NEW: Increase epsilon if win rate is low
  lowWinRateThreshold: 0.4, // NEW: Win rate below this triggers epsilon boost
  epsilonBoostAmount: 0.1, // NEW: How much to boost epsilon when win rate is low
  // Double DQN (reduces Q-value overestimation)
  // Research: "R-DDQN achieves 73% win rate improvement over standard DQN"
  useDoubleDQN: true, // Use Double DQN by default
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

  // Action distribution tracking (for diagnostics) - initialized dynamically in constructor
  private actionCounts: number[] = [];
  private episodeActionCounts: number[] = [];
  private recentQValues: number[][] = []; // Last 100 Q-value vectors
  private actionBiasValue: number = 0.1; // Initial action exploration bonus

  constructor(
    config: Partial<DQNConfig> = {},
    buffer?: ReplayBuffer
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.epsilon = this.config.epsilonStart;
    this.buffer = buffer ?? new ReplayBuffer();

    // Initialize action tracking arrays based on output size
    this.actionCounts = new Array(this.config.outputSize).fill(0);
    this.episodeActionCounts = new Array(this.config.outputSize).fill(0);

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
   * Supports Dueling DQN architecture when config.useDueling is true
   * Supports Noisy Networks when config.useNoisyNetworks is true
   */
  private buildNetwork(name: string): tf.LayersModel {
    const useDueling = this.config.useDueling ?? false;
    const useNoisy = this.config.useNoisyNetworks ?? false;

    if (useDueling) {
      return this.buildDuelingNetwork(name, useNoisy);
    }
    return this.buildSequentialNetwork(name, useNoisy);
  }

  /**
   * Build standard sequential Q-network
   * @param name - Network name
   * @param useNoisy - Whether to use NoisyDense layers for exploration
   */
  private buildSequentialNetwork(name: string, useNoisy: boolean = false): tf.LayersModel {
    const useBatchNorm = this.config.useBatchNorm ?? true;
    const sigmaInit = this.config.noisySigmaInit ?? 0.5;

    // For noisy networks, we use functional API to support custom layers
    if (useNoisy) {
      return this.buildNoisySequentialNetwork(name, useBatchNorm, sigmaInit);
    }

    // Standard sequential model
    const model = tf.sequential({ name });

    // Input layer
    model.add(
      tf.layers.dense({
        inputShape: [this.config.inputSize],
        units: this.config.hiddenLayers[0]!,
        activation: useBatchNorm ? 'linear' : 'relu',
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
   * Build sequential network with NoisyDense layers for exploration
   * Uses functional API to support custom NoisyDense layer
   */
  private buildNoisySequentialNetwork(
    name: string,
    useBatchNorm: boolean,
    sigmaInit: number
  ): tf.LayersModel {
    const input = tf.input({ shape: [this.config.inputSize], name: `${name}_input` });

    let x: tf.SymbolicTensor = input;

    // Hidden layers (standard dense with optional batch norm)
    for (let i = 0; i < this.config.hiddenLayers.length; i++) {
      x = tf.layers.dense({
        units: this.config.hiddenLayers[i]!,
        activation: useBatchNorm ? 'linear' : 'relu',
        kernelRegularizer: tf.regularizers.l2({ l2: this.config.l2Regularization }),
        name: `${name}_dense${i + 1}`,
      }).apply(x) as tf.SymbolicTensor;

      if (useBatchNorm) {
        x = tf.layers.batchNormalization({ momentum: 0.9, epsilon: 1e-5, name: `${name}_bn${i + 1}` })
          .apply(x) as tf.SymbolicTensor;
        x = tf.layers.activation({ activation: 'relu', name: `${name}_relu${i + 1}` })
          .apply(x) as tf.SymbolicTensor;
      }
      x = tf.layers.dropout({ rate: this.config.dropout, name: `${name}_dropout${i + 1}` })
        .apply(x) as tf.SymbolicTensor;
    }

    // Noisy output layer - this provides exploration via learned noise
    const output = new NoisyDense({
      units: this.config.outputSize,
      sigmaInit,
    }).apply(x) as tf.SymbolicTensor;

    return tf.model({ inputs: input, outputs: output, name });
  }

  /**
   * Build Dueling DQN network with separate Value and Advantage streams
   * Q(s,a) = V(s) + (A(s,a) - mean(A(s,:)))
   * @param name - Network name
   * @param useNoisy - Whether to use NoisyDense layers for value/advantage streams
   */
  private buildDuelingNetwork(name: string, useNoisy: boolean = false): tf.LayersModel {
    const useBatchNorm = this.config.useBatchNorm ?? true;
    const sigmaInit = this.config.noisySigmaInit ?? 0.5;

    // Input layer
    const input = tf.input({ shape: [this.config.inputSize], name: `${name}_input` });

    // Shared hidden layers
    let shared: tf.SymbolicTensor = input;

    for (let i = 0; i < this.config.hiddenLayers.length; i++) {
      shared = tf.layers.dense({
        units: this.config.hiddenLayers[i]!,
        activation: useBatchNorm ? 'linear' : 'relu',
        kernelRegularizer: tf.regularizers.l2({ l2: this.config.l2Regularization }),
        name: `${name}_shared_dense${i + 1}`,
      }).apply(shared) as tf.SymbolicTensor;

      if (useBatchNorm) {
        shared = tf.layers.batchNormalization({ momentum: 0.9, epsilon: 1e-5, name: `${name}_shared_bn${i + 1}` })
          .apply(shared) as tf.SymbolicTensor;
        shared = tf.layers.activation({ activation: 'relu', name: `${name}_shared_relu${i + 1}` })
          .apply(shared) as tf.SymbolicTensor;
      }
      shared = tf.layers.dropout({ rate: this.config.dropout, name: `${name}_shared_dropout${i + 1}` })
        .apply(shared) as tf.SymbolicTensor;
    }

    // Value stream: outputs V(s) (scalar)
    const valueHiddenUnits = Math.max(32, Math.floor(this.config.hiddenLayers[this.config.hiddenLayers.length - 1]! / 2));
    let valueStream: tf.SymbolicTensor;
    let valueOutput: tf.SymbolicTensor;

    if (useNoisy) {
      valueStream = new NoisyDense({ units: valueHiddenUnits, sigmaInit })
        .apply(shared) as tf.SymbolicTensor;
      valueStream = tf.layers.activation({ activation: 'relu', name: `${name}_value_relu` })
        .apply(valueStream) as tf.SymbolicTensor;
      valueOutput = new NoisyDense({ units: 1, sigmaInit })
        .apply(valueStream) as tf.SymbolicTensor;
    } else {
      valueStream = tf.layers.dense({
        units: valueHiddenUnits,
        activation: 'relu',
        kernelRegularizer: tf.regularizers.l2({ l2: this.config.l2Regularization }),
        name: `${name}_value_hidden`,
      }).apply(shared) as tf.SymbolicTensor;

      valueOutput = tf.layers.dense({
        units: 1,
        activation: 'linear',
        name: `${name}_value_output`,
      }).apply(valueStream) as tf.SymbolicTensor;
    }

    // Advantage stream: outputs A(s,a) for each action
    const advantageHiddenUnits = Math.max(32, Math.floor(this.config.hiddenLayers[this.config.hiddenLayers.length - 1]! / 2));
    let advantageStream: tf.SymbolicTensor;
    let advantageOutput: tf.SymbolicTensor;

    if (useNoisy) {
      advantageStream = new NoisyDense({ units: advantageHiddenUnits, sigmaInit })
        .apply(shared) as tf.SymbolicTensor;
      advantageStream = tf.layers.activation({ activation: 'relu', name: `${name}_advantage_relu` })
        .apply(advantageStream) as tf.SymbolicTensor;
      advantageOutput = new NoisyDense({ units: this.config.outputSize, sigmaInit })
        .apply(advantageStream) as tf.SymbolicTensor;
    } else {
      advantageStream = tf.layers.dense({
        units: advantageHiddenUnits,
        activation: 'relu',
        kernelRegularizer: tf.regularizers.l2({ l2: this.config.l2Regularization }),
        name: `${name}_advantage_hidden`,
      }).apply(shared) as tf.SymbolicTensor;

      advantageOutput = tf.layers.dense({
        units: this.config.outputSize,
        activation: 'linear',
        name: `${name}_advantage_output`,
      }).apply(advantageStream) as tf.SymbolicTensor;
    }

    // Combine: Q(s,a) = V(s) + (A(s,a) - mean(A(s,:)))
    // Custom lambda layer to compute Q-values
    const qValues = new DuelingCombineLayer({ name: `${name}_dueling_combine` })
      .apply([valueOutput, advantageOutput]) as tf.SymbolicTensor;

    return tf.model({
      inputs: input,
      outputs: qValues,
      name,
    });
  }

  /**
   * Set the current symbol for symbol-specific epsilon scaling
   * Called by the training loop when switching between symbols
   */
  setCurrentSymbol(symbol: string): void {
    (this.config as { currentSymbol?: string }).currentSymbol = symbol;
  }

  /**
   * Get the effective epsilon with symbol-specific scaling
   */
  private getEffectiveEpsilon(): number {
    const scaling = this.config.symbolEpsilonScaling;
    const currentSymbol = this.config.currentSymbol;

    if (scaling && currentSymbol && scaling[currentSymbol] !== undefined) {
      // Apply symbol-specific scaling
      return Math.min(1.0, this.epsilon * scaling[currentSymbol]!);
    }

    return this.epsilon;
  }

  /**
   * Select action using epsilon-greedy policy or noisy network exploration
   * When using noisy networks, exploration is handled by the network itself
   *
   * Includes action bias to prevent "hold" collapse - adds small bonus to
   * non-hold actions during training to encourage exploration of trading actions.
   *
   * Symbol-specific epsilon scaling: Different symbols may need more/less exploration
   * BTC typically has lower Sharpe -> needs more exploration (higher epsilon)
   */
  selectAction(state: number[], training: boolean = true): Action {
    const useNoisy = this.config.useNoisyNetworks ?? false;
    const useActionBias = this.config.actionBias ?? true;

    // Get effective epsilon with symbol-specific scaling
    const effectiveEpsilon = this.getEffectiveEpsilon();

    // Epsilon-greedy during training (only if not using noisy networks)
    if (!useNoisy && training && Math.random() < effectiveEpsilon) {
      // Biased random exploration: favor trading actions over wait/hold
      // 70% chance of trading action, 30% chance of WAIT/HOLD
      if (Math.random() < 0.7) {
        // Uniformly sample from all non-wait actions (indices 1 to outputSize-1)
        const numTradingActions = this.config.outputSize - 1;
        const randomActionIdx = 1 + Math.floor(Math.random() * numTradingActions);
        this.actionCounts[randomActionIdx] = (this.actionCounts[randomActionIdx] ?? 0) + 1;
        this.episodeActionCounts[randomActionIdx] = (this.episodeActionCounts[randomActionIdx] ?? 0) + 1;
        return randomActionIdx as Action;
      }
      this.actionCounts[0] = (this.actionCounts[0] ?? 0) + 1;
      this.episodeActionCounts[0] = (this.episodeActionCounts[0] ?? 0) + 1;
      return 0 as Action; // WAIT/HOLD
    }

    // For noisy networks, set the global training mode flag
    // This enables noise during training and disables it during evaluation
    if (useNoisy) {
      setNoisyLayerTrainingMode(training);
    }

    // Get Q-values from online network
    // For noisy networks, the noise provides exploration during training
    const qValues = tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const predictions = this.onlineNetwork.predict(stateTensor) as tf.Tensor;
      return Array.from(predictions.dataSync());
    });

    // Track Q-values for diagnostics
    this.recentQValues.push([...qValues]);
    if (this.recentQValues.length > 100) {
      this.recentQValues.shift();
    }

    // Apply action bias during training to prevent "wait/hold" collapse
    // This adds a small bonus to all trading actions (not just first 3)
    const biasedQValues = [...qValues];
    if (training && useActionBias && this.actionBiasValue > 0.01) {
      // Don't bias WAIT/HOLD (index 0), bias all trading actions dynamically
      for (let i = 1; i < this.config.outputSize; i++) {
        if (biasedQValues[i] !== undefined) {
          // Give slightly higher bias to later actions (like CHoCH) to encourage exploration
          const biasMultiplier = i === this.config.outputSize - 1 ? 1.2 : 1.0;
          biasedQValues[i] += this.actionBiasValue * biasMultiplier;
        }
      }
    }

    // Select action with highest Q-value - use full output size
    let maxQ = -Infinity;
    let bestAction: Action = Actions.HOLD;

    for (let i = 0; i < this.config.outputSize; i++) {
      if (biasedQValues[i]! > maxQ) {
        maxQ = biasedQValues[i]!;
        bestAction = i as Action;
      }
    }

    // Track action distribution
    this.actionCounts[bestAction] = (this.actionCounts[bestAction] ?? 0) + 1;
    this.episodeActionCounts[bestAction] = (this.episodeActionCounts[bestAction] ?? 0) + 1;

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
   * Returns loss value
   */
  train(batchSize?: number): number {
    if (!this.buffer.isReady()) {
      return 0;
    }

    // Check if using prioritized replay
    if (this.buffer instanceof PrioritizedReplayBuffer) {
      const { batch, indices, weights } = this.buffer.sampleWithIndices(batchSize);
      const { loss, tdErrors } = this.trainOnBatchWithTDErrors(batch, weights);

      // Update priorities based on TD errors
      this.buffer.updatePriorities(indices, tdErrors);

      // Soft update target network
      this.updateTargetNetwork(this.config.tau);

      return loss;
    }

    // Standard replay buffer
    const batch = this.buffer.sample(batchSize);
    const { loss } = this.trainOnBatchWithTDErrors(batch);

    // Soft update target network
    this.updateTargetNetwork(this.config.tau);

    // NOTE: Epsilon decay moved to endEpisode() to prevent per-step decay
    // which causes exploration to collapse too quickly

    return loss;
  }

  /**
   * Weighted Huber loss (smooth L1) for importance-weighted samples
   * Used by Prioritized Experience Replay
   */
  private weightedHuberLoss(
    yTrue: tf.Tensor,
    yPred: tf.Tensor,
    weights: number[],
    delta: number = 1.0
  ): tf.Scalar {
    const error = tf.sub(yTrue, yPred);
    const absError = tf.abs(error);
    const quadratic = tf.minimum(absError, delta);
    const linear = tf.sub(absError, quadratic);
    const perSampleLoss = tf.add(tf.mul(0.5, tf.square(quadratic)), tf.mul(delta, linear));
    // Mean over actions for each sample
    const sampleLosses = tf.mean(perSampleLoss, 1);
    // Apply importance sampling weights
    const weightsTensor = tf.tensor1d(weights);
    const weightedLosses = tf.mul(sampleLosses, weightsTensor);
    return tf.mean(weightedLosses) as tf.Scalar;
  }

  /**
   * Train on a specific batch of transitions
   * Uses Huber loss and gradient clipping for stability
   * Returns both loss and TD errors for prioritized replay
   * @param batch - Batch of transitions to train on
   * @param importanceWeights - Optional importance sampling weights for PER
   */
  private trainOnBatchWithTDErrors(
    batch: Transition[],
    importanceWeights?: number[]
  ): { loss: number; tdErrors: number[] } {
    const states = batch.map((t) => t.state);
    const actions = batch.map((t) => t.action);
    const rewards = batch.map((t) => t.reward);
    const nextStates = batch.map((t) => t.nextState);
    const dones = batch.map((t) => t.done);

    const useHuber = this.config.useHuberLoss ?? true;
    const huberDelta = this.config.huberDelta ?? 1.0;
    const clipNorm = this.config.gradientClipNorm ?? 1.0;
    const useDoubleDQN = this.config.useDoubleDQN ?? true;

    // Use uniform weights if not provided
    const weights = importanceWeights ?? new Array(batch.length).fill(1);

    let tdErrors: number[] = [];

    const loss = tf.tidy(() => {
      const statesTensor = tf.tensor2d(states);
      const nextStatesTensor = tf.tensor2d(nextStates);

      // Get next Q-values
      // Double DQN: use online network to select actions, target network to evaluate
      // Standard DQN: use target network for both selection and evaluation
      const nextQTarget = this.targetNetwork.predict(nextStatesTensor) as tf.Tensor;
      const nextQValues = nextQTarget.dataSync();

      let nextActions: number[];
      if (useDoubleDQN) {
        // Double DQN: action selection from online network
        const nextQOnline = this.onlineNetwork.predict(nextStatesTensor) as tf.Tensor;
        nextActions = Array.from(nextQOnline.argMax(1).dataSync());
      } else {
        // Standard DQN: action selection from target network (same as evaluation)
        nextActions = Array.from(nextQTarget.argMax(1).dataSync());
      }

      // Get current Q-values for TD error calculation
      const currentQPred = this.onlineNetwork.predict(statesTensor) as tf.Tensor;
      const currentQ = currentQPred.dataSync();

      // Compute target Q-values and TD errors
      // For N-step returns, use gamma^n instead of gamma
      const effectiveGamma = this.buffer instanceof NStepReplayBuffer
        ? this.buffer.getGammaN()
        : this.config.gamma;

      const numActions = this.config.outputSize;
      const targetQValues: number[] = [];
      tdErrors = [];
      for (let i = 0; i < batch.length; i++) {
        const nextAction = nextActions[i]!;
        const nextQ = nextQValues[i * numActions + nextAction]!;
        // N-step target: G_n + γ^n * max Q(s')
        // Standard target: r + γ * max Q(s')
        const target = dones[i]
          ? rewards[i]!
          : rewards[i]! + effectiveGamma * nextQ;
        targetQValues.push(target);

        // TD error = |target - predicted|
        const predictedQ = currentQ[i * numActions + actions[i]!]!;
        tdErrors.push(Math.abs(target - predictedQ));
      }

      // Compute loss and gradients
      const { grads, value: lossValue } = tf.variableGrads((): tf.Scalar => {
        const predictions = this.onlineNetwork.predict(statesTensor) as tf.Tensor;
        const predictedQ = predictions.dataSync();

        // Create target tensor
        const targets: number[] = [];
        for (let i = 0; i < batch.length; i++) {
          for (let j = 0; j < numActions; j++) {
            if (j === actions[i]) {
              targets.push(targetQValues[i]!);
            } else {
              targets.push(predictedQ[i * numActions + j]!);
            }
          }
        }

        const targetTensor = tf.tensor2d(targets, [batch.length, numActions]);

        // Calculate weighted loss
        // Use Huber loss for robustness or MSE
        if (useHuber) {
          // Weighted Huber loss with importance sampling
          return this.weightedHuberLoss(targetTensor, predictions, weights, huberDelta);
        } else {
          // Weighted MSE
          const perSampleLoss = tf.square(tf.sub(targetTensor, predictions));
          const sampleLosses = tf.mean(perSampleLoss, 1);
          const weightsTensor = tf.tensor1d(weights);
          const weightedLosses = tf.mul(sampleLosses, weightsTensor);
          return tf.mean(weightedLosses) as tf.Scalar;
        }
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

    return { loss, tdErrors };
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
   * Handles per-episode epsilon decay with configurable strategy
   *
   * Phase 2 Research: "Reward-based ε decay outperforms exponential decay
   * with easier hyperparameter tuning."
   */
  endEpisode(): void {
    this.episodeCount++;

    const useLinear = this.config.useLinearEpsilonDecay ?? true;
    const totalEpisodes = this.config.totalExpectedEpisodes ?? 200;

    if (useLinear) {
      // Linear decay: epsilon decreases proportionally with episode count
      // More gradual than exponential, prevents exploration collapse
      const decayRange = this.config.epsilonStart - this.config.epsilonEnd;
      const progress = Math.min(this.episodeCount / totalEpisodes, 1.0);
      this.epsilon = this.config.epsilonStart - (progress * decayRange);
    } else {
      // Legacy exponential decay: epsilon = epsilonStart * decay^episode
      this.epsilon = Math.max(
        this.config.epsilonEnd,
        this.config.epsilonStart * Math.pow(this.config.epsilonDecay, this.episodeCount)
      );
    }

    // Ensure epsilon doesn't go below minimum
    this.epsilon = Math.max(this.config.epsilonEnd, this.epsilon);

    // Reward-based epsilon adjustment
    // If win rate is too low, increase exploration
    const useRewardBasedAdjustment = this.config.rewardBasedEpsilonAdjustment ?? true;
    if (useRewardBasedAdjustment) {
      const winRate = this.calculateRecentWinRate();
      const lowWinRateThreshold = this.config.lowWinRateThreshold ?? 0.4;
      const boostAmount = this.config.epsilonBoostAmount ?? 0.1;

      if (winRate < lowWinRateThreshold && this.episodeCount > 10) {
        // Boost epsilon to encourage more exploration
        this.epsilon = Math.min(
          this.config.epsilonStart * 0.8, // Cap at 80% of start
          this.epsilon + boostAmount
        );
      }
    }

    // Decay action bias over time
    const actionBiasDecay = this.config.actionBiasDecay ?? 0.999;
    this.actionBiasValue *= actionBiasDecay;

    // Reset episode action counts
    this.episodeActionCounts = new Array(this.config.outputSize).fill(0);
  }

  /**
   * Calculate recent win rate from reward history
   * Used for reward-based epsilon adjustment
   */
  private calculateRecentWinRate(): number {
    if (this.recentRewards.length < 10) return 0.5; // Default to neutral

    // Count positive rewards as "wins"
    const wins = this.recentRewards.filter(r => r > 0).length;
    return wins / this.recentRewards.length;
  }

  /**
   * Reset epsilon to a specified value (for walk-forward windows)
   * Used when transitioning to a new rolling window to boost exploration
   *
   * Phase 2 Research: "Reset epsilon on new rolling window" to prevent
   * the agent from being stuck in local optima when market regime changes.
   */
  resetEpsilon(epsilon?: number): void {
    // Boost exploration for new window while preserving some learning
    // Default: reset to 70% of start value (balances exploration vs exploitation)
    const defaultReset = this.config.epsilonStart * 0.7;
    this.epsilon = epsilon ?? defaultReset;

    // Ensure we're above the minimum
    this.epsilon = Math.max(this.config.epsilonEnd, this.epsilon);

    // Don't reset episode count - keep learning momentum
    // But do reset action bias to encourage fresh exploration
    this.actionBiasValue = 0.08; // Slight reset of action bias
  }

  /**
   * Get current epsilon value (for monitoring)
   */
  getEpsilon(): number {
    return this.epsilon;
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
   * Get exploration diagnostics for debugging "hold" collapse
   * Returns action distribution and Q-value statistics
   */
  getDiagnostics(): ExplorationDiagnostics {
    const totalActions = this.actionCounts.reduce((a, b) => a + b, 0);
    const actionDistribution = totalActions > 0
      ? this.actionCounts.map(c => c / totalActions)
      : [0.25, 0.25, 0.25, 0.25];

    // Q-value statistics
    let avgQValues = [0, 0, 0, 0];
    let qValueRange = { min: 0, max: 0 };
    if (this.recentQValues.length > 0) {
      for (const qv of this.recentQValues) {
        for (let i = 0; i < 4; i++) {
          const qVal = avgQValues[i];
          const qvVal = qv[i];
          if (qVal !== undefined && qvVal !== undefined) {
            avgQValues[i] = qVal + qvVal;
          }
        }
      }
      avgQValues = avgQValues.map(q => q / this.recentQValues.length);

      const allQValues = this.recentQValues.flat();
      qValueRange = {
        min: Math.min(...allQValues),
        max: Math.max(...allQValues),
      };
    }

    // Check for Q-value collapse (all actions have similar Q-values)
    const qValueSpread = Math.max(...avgQValues) - Math.min(...avgQValues);
    const qValueCollapsed = qValueSpread < 0.01;

    // Check for vanishing gradients (Q-values extremely small)
    const avgAbsQ = avgQValues.reduce((a, b) => a + Math.abs(b), 0) / 4;
    const vanishingGradients = avgAbsQ < 1e-10;

    return {
      actionDistribution: {
        hold: actionDistribution[0] ?? 0.25,
        buy: actionDistribution[1] ?? 0.25,
        sell: actionDistribution[2] ?? 0.25,
        close: actionDistribution[3] ?? 0.25,
      },
      totalActions,
      episodeActionCounts: [...this.episodeActionCounts],
      avgQValues,
      qValueRange,
      qValueSpread,
      qValueCollapsed,
      vanishingGradients,
      actionBias: this.actionBiasValue,
    };
  }

  /**
   * Check network weights for vanishing gradient issues
   * Returns statistics about weight magnitudes
   */
  checkWeightHealth(): WeightHealthReport {
    const weights = this.onlineNetwork.getWeights();
    let minWeight = Infinity;
    let maxWeight = -Infinity;
    let totalWeights = 0;
    let zeroWeights = 0;
    let tinyWeights = 0; // < 1e-10

    for (const weightTensor of weights) {
      const data = weightTensor.dataSync();
      for (let i = 0; i < data.length; i++) {
        const w = Math.abs(data[i]!);
        totalWeights++;
        if (w < minWeight) minWeight = w;
        if (w > maxWeight) maxWeight = w;
        if (w === 0) zeroWeights++;
        if (w < 1e-10) tinyWeights++;
      }
    }

    const vanishingGradientRisk = tinyWeights / totalWeights > 0.5;

    return {
      minWeight,
      maxWeight,
      totalWeights,
      zeroWeights,
      tinyWeights,
      tinyWeightRatio: tinyWeights / totalWeights,
      vanishingGradientRisk,
    };
  }

  /**
   * Reset action tracking (call at start of new training run)
   */
  resetDiagnostics(): void {
    this.actionCounts = new Array(this.config.outputSize).fill(0);
    this.episodeActionCounts = new Array(this.config.outputSize).fill(0);
    this.recentQValues = [];
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

export interface ExplorationDiagnostics {
  actionDistribution: {
    hold: number;
    buy: number;
    sell: number;
    close: number;
  };
  totalActions: number;
  episodeActionCounts: number[];
  avgQValues: number[];
  qValueRange: { min: number; max: number };
  qValueSpread: number;
  qValueCollapsed: boolean;
  vanishingGradients: boolean;
  actionBias: number;
}

export interface WeightHealthReport {
  minWeight: number;
  maxWeight: number;
  totalWeights: number;
  zeroWeights: number;
  tinyWeights: number;
  tinyWeightRatio: number;
  vanishingGradientRisk: boolean;
}
