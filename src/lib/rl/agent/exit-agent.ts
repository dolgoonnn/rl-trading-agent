/**
 * Exit Agent
 *
 * Simplified DQN agent for exit timing decisions.
 * Only 2 actions: HOLD (keep position) or EXIT (close position)
 *
 * This avoids the "do nothing" exploit because:
 * - The agent only sees states when already in a position
 * - Must decide when to exit, cannot avoid trading
 */

import * as tf from '@tensorflow/tfjs';

export interface ExitAgentConfig {
  inputSize: number;
  hiddenLayers: number[];
  learningRate: number;
  gamma: number;
  epsilonStart: number;
  epsilonEnd: number;
  epsilonDecay: number;
  batchSize: number;
  memorySize: number;
  targetUpdateFreq: number;
  dropout?: number;
  l2Regularization?: number;
}

interface Experience {
  state: number[];
  action: number;
  reward: number;
  nextState: number[];
  done: boolean;
}

export class ExitAgent {
  private config: ExitAgentConfig;
  private mainNetwork: tf.LayersModel;
  private targetNetwork: tf.LayersModel;
  private optimizer: tf.Optimizer;
  private memory: Experience[] = [];
  private memoryIndex: number = 0;

  public epsilon: number;
  private totalSteps: number = 0;

  constructor(config: ExitAgentConfig) {
    this.config = config;
    this.epsilon = config.epsilonStart;

    // Create networks
    this.mainNetwork = this.buildNetwork();
    this.targetNetwork = this.buildNetwork();

    // Copy weights to target
    this.updateTargetNetwork();

    // Optimizer
    this.optimizer = tf.train.adam(config.learningRate);
  }

  private buildNetwork(): tf.LayersModel {
    const model = tf.sequential();

    // Input layer
    model.add(tf.layers.dense({
      units: this.config.hiddenLayers[0]!,
      inputShape: [this.config.inputSize],
      activation: 'relu',
      kernelInitializer: 'glorotUniform',
      kernelRegularizer: this.config.l2Regularization
        ? tf.regularizers.l2({ l2: this.config.l2Regularization })
        : undefined,
    }));

    // Optional dropout
    if (this.config.dropout && this.config.dropout > 0) {
      model.add(tf.layers.dropout({ rate: this.config.dropout }));
    }

    // Hidden layers
    for (let i = 1; i < this.config.hiddenLayers.length; i++) {
      model.add(tf.layers.dense({
        units: this.config.hiddenLayers[i]!,
        activation: 'relu',
        kernelInitializer: 'glorotUniform',
        kernelRegularizer: this.config.l2Regularization
          ? tf.regularizers.l2({ l2: this.config.l2Regularization })
          : undefined,
      }));

      if (this.config.dropout && this.config.dropout > 0) {
        model.add(tf.layers.dropout({ rate: this.config.dropout }));
      }
    }

    // Output layer: 2 actions (HOLD=0, EXIT=1)
    model.add(tf.layers.dense({
      units: 2,
      activation: 'linear',
      kernelInitializer: 'glorotUniform',
    }));

    return model;
  }

  /**
   * Select action using epsilon-greedy policy
   */
  selectAction(state: number[], training: boolean = true): number {
    if (training && Math.random() < this.epsilon) {
      // Random action: 0 (HOLD) or 1 (EXIT)
      return Math.random() < 0.5 ? 0 : 1;
    }

    // Greedy action
    return tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const qValues = this.mainNetwork.predict(stateTensor) as tf.Tensor;
      const actionIndex = qValues.argMax(1).dataSync()[0]!;
      return actionIndex;
    });
  }

  /**
   * Get Q-values for state
   */
  getQValues(state: number[]): number[] {
    return tf.tidy(() => {
      const stateTensor = tf.tensor2d([state]);
      const qValues = this.mainNetwork.predict(stateTensor) as tf.Tensor;
      return Array.from(qValues.dataSync());
    });
  }

  /**
   * Store experience in replay buffer
   */
  storeExperience(
    state: number[],
    action: number,
    reward: number,
    nextState: number[],
    done: boolean
  ): void {
    const experience: Experience = { state, action, reward, nextState, done };

    if (this.memory.length < this.config.memorySize) {
      this.memory.push(experience);
    } else {
      this.memory[this.memoryIndex] = experience;
      this.memoryIndex = (this.memoryIndex + 1) % this.config.memorySize;
    }

    this.totalSteps++;
  }

  /**
   * Train on batch from replay buffer
   */
  train(): number {
    if (this.memory.length < this.config.batchSize) {
      return 0;
    }

    // Sample batch
    const batch: Experience[] = [];
    for (let i = 0; i < this.config.batchSize; i++) {
      const idx = Math.floor(Math.random() * this.memory.length);
      batch.push(this.memory[idx]!);
    }

    // Train
    const loss = tf.tidy(() => {
      const states = tf.tensor2d(batch.map(e => e.state));
      const nextStates = tf.tensor2d(batch.map(e => e.nextState));
      const actions = batch.map(e => e.action);
      const rewards = batch.map(e => e.reward);
      const dones = batch.map(e => e.done);

      // Get current Q-values
      const currentQs = this.mainNetwork.predict(states) as tf.Tensor;

      // Get next Q-values from target network
      const nextQs = this.targetNetwork.predict(nextStates) as tf.Tensor;
      const maxNextQs = nextQs.max(1);

      // Compute targets
      const targets = currentQs.arraySync() as number[][];
      const maxNextQsArr = maxNextQs.arraySync() as number[];

      for (let i = 0; i < batch.length; i++) {
        const target = dones[i]
          ? rewards[i]!
          : rewards[i]! + this.config.gamma * maxNextQsArr[i]!;
        targets[i]![actions[i]!] = target;
      }

      const targetTensor = tf.tensor2d(targets);

      // Compute loss and update
      const lossValue = this.optimizer.minimize(() => {
        const predictions = this.mainNetwork.apply(states, { training: true }) as tf.Tensor;
        return tf.losses.meanSquaredError(targetTensor, predictions) as tf.Scalar;
      }, true);

      return lossValue?.dataSync()[0] ?? 0;
    });

    // Update target network periodically
    if (this.totalSteps % this.config.targetUpdateFreq === 0) {
      this.updateTargetNetwork();
    }

    // Decay epsilon
    this.epsilon = Math.max(
      this.config.epsilonEnd,
      this.epsilon * this.config.epsilonDecay
    );

    return loss;
  }

  /**
   * Copy weights from main to target network
   */
  private updateTargetNetwork(): void {
    const mainWeights = this.mainNetwork.getWeights();
    this.targetNetwork.setWeights(mainWeights.map(w => w.clone()));
  }

  /**
   * Get weights for serialization
   */
  getWeights(): tf.Tensor[] {
    return this.mainNetwork.getWeights();
  }

  /**
   * Set weights from serialization
   */
  setWeights(weights: tf.Tensor[]): void {
    this.mainNetwork.setWeights(weights);
    this.updateTargetNetwork();
  }

  /**
   * Export weights as serializable arrays
   */
  exportWeights(): { shape: number[]; data: number[] }[] {
    return this.mainNetwork.getWeights().map(w => ({
      shape: w.shape,
      data: Array.from(w.dataSync()),
    }));
  }

  /**
   * Import weights from serialized arrays
   */
  importWeights(serialized: { shape: number[]; data: number[] }[]): void {
    const weights = serialized.map(({ shape, data }) =>
      tf.tensor(data, shape as [number] | [number, number])
    );
    this.setWeights(weights);
  }

  /**
   * Get current statistics
   */
  getStats(): {
    epsilon: number;
    totalSteps: number;
    memorySize: number;
  } {
    return {
      epsilon: this.epsilon,
      totalSteps: this.totalSteps,
      memorySize: this.memory.length,
    };
  }

  /**
   * Cleanup tensors
   */
  dispose(): void {
    this.mainNetwork.dispose();
    this.targetNetwork.dispose();
  }
}
