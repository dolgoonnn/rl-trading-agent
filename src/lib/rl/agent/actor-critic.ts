/**
 * Actor-Critic Networks
 * Separate actor (policy) and critic (value) networks for PPO
 */

import * as tf from '@tensorflow/tfjs';

export interface ActorCriticConfig {
  inputSize: number;
  hiddenLayers: number[]; // Shared feature layers
  actorLayers?: number[]; // Actor-specific layers
  criticLayers?: number[]; // Critic-specific layers
  numActions: number;
  useBatchNorm: boolean;
  dropout: number;
  l2Regularization: number;
  sharedFeatures: boolean; // Share feature extractor between actor/critic
}

const DEFAULT_CONFIG: ActorCriticConfig = {
  inputSize: 96,
  hiddenLayers: [256, 128],
  actorLayers: [64],
  criticLayers: [64],
  numActions: 4,
  useBatchNorm: true,
  dropout: 0.2,
  l2Regularization: 0.01,
  sharedFeatures: false, // Separate networks often work better for trading
};

/**
 * Actor network - outputs action probabilities
 */
export function buildActorNetwork(config: Partial<ActorCriticConfig> = {}): tf.LayersModel {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const input = tf.input({ shape: [cfg.inputSize] });
  let x: tf.SymbolicTensor = input;

  // Shared/feature layers
  for (let i = 0; i < cfg.hiddenLayers.length; i++) {
    x = tf.layers.dense({
      units: cfg.hiddenLayers[i]!,
      activation: cfg.useBatchNorm ? 'linear' : 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: cfg.l2Regularization }),
      name: `actor_shared_${i}`,
    }).apply(x) as tf.SymbolicTensor;

    if (cfg.useBatchNorm) {
      x = tf.layers.batchNormalization({ momentum: 0.9, epsilon: 1e-5 }).apply(x) as tf.SymbolicTensor;
      x = tf.layers.activation({ activation: 'relu' }).apply(x) as tf.SymbolicTensor;
    }
    x = tf.layers.dropout({ rate: cfg.dropout }).apply(x) as tf.SymbolicTensor;
  }

  // Actor-specific layers
  const actorLayers = cfg.actorLayers ?? [64];
  for (let i = 0; i < actorLayers.length; i++) {
    x = tf.layers.dense({
      units: actorLayers[i]!,
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: cfg.l2Regularization }),
      name: `actor_head_${i}`,
    }).apply(x) as tf.SymbolicTensor;
  }

  // Output layer - action logits (softmax applied during sampling)
  const output = tf.layers.dense({
    units: cfg.numActions,
    activation: 'linear', // We'll apply softmax during action selection
    name: 'actor_output',
  }).apply(x) as tf.SymbolicTensor;

  return tf.model({ inputs: input, outputs: output, name: 'actor' });
}

/**
 * Critic network - outputs state value estimate
 */
export function buildCriticNetwork(config: Partial<ActorCriticConfig> = {}): tf.LayersModel {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const input = tf.input({ shape: [cfg.inputSize] });
  let x: tf.SymbolicTensor = input;

  // Shared/feature layers
  for (let i = 0; i < cfg.hiddenLayers.length; i++) {
    x = tf.layers.dense({
      units: cfg.hiddenLayers[i]!,
      activation: cfg.useBatchNorm ? 'linear' : 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: cfg.l2Regularization }),
      name: `critic_shared_${i}`,
    }).apply(x) as tf.SymbolicTensor;

    if (cfg.useBatchNorm) {
      x = tf.layers.batchNormalization({ momentum: 0.9, epsilon: 1e-5 }).apply(x) as tf.SymbolicTensor;
      x = tf.layers.activation({ activation: 'relu' }).apply(x) as tf.SymbolicTensor;
    }
    x = tf.layers.dropout({ rate: cfg.dropout }).apply(x) as tf.SymbolicTensor;
  }

  // Critic-specific layers
  const criticLayers = cfg.criticLayers ?? [64];
  for (let i = 0; i < criticLayers.length; i++) {
    x = tf.layers.dense({
      units: criticLayers[i]!,
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: cfg.l2Regularization }),
      name: `critic_head_${i}`,
    }).apply(x) as tf.SymbolicTensor;
  }

  // Output layer - single value estimate
  const output = tf.layers.dense({
    units: 1,
    activation: 'linear',
    name: 'critic_output',
  }).apply(x) as tf.SymbolicTensor;

  return tf.model({ inputs: input, outputs: output, name: 'critic' });
}

/**
 * Combined Actor-Critic network with shared features
 * Outputs both action probabilities and value estimate
 */
export function buildSharedActorCritic(config: Partial<ActorCriticConfig> = {}): {
  model: tf.LayersModel;
  actor: tf.LayersModel;
  critic: tf.LayersModel;
} {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const input = tf.input({ shape: [cfg.inputSize] });
  let shared: tf.SymbolicTensor = input;

  // Shared feature layers
  for (let i = 0; i < cfg.hiddenLayers.length; i++) {
    shared = tf.layers.dense({
      units: cfg.hiddenLayers[i]!,
      activation: cfg.useBatchNorm ? 'linear' : 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: cfg.l2Regularization }),
      name: `shared_${i}`,
    }).apply(shared) as tf.SymbolicTensor;

    if (cfg.useBatchNorm) {
      shared = tf.layers.batchNormalization({ momentum: 0.9, epsilon: 1e-5 }).apply(shared) as tf.SymbolicTensor;
      shared = tf.layers.activation({ activation: 'relu' }).apply(shared) as tf.SymbolicTensor;
    }
    shared = tf.layers.dropout({ rate: cfg.dropout }).apply(shared) as tf.SymbolicTensor;
  }

  // Actor head
  let actorHead: tf.SymbolicTensor = shared;
  const actorLayers = cfg.actorLayers ?? [64];
  for (let i = 0; i < actorLayers.length; i++) {
    actorHead = tf.layers.dense({
      units: actorLayers[i]!,
      activation: 'relu',
      name: `actor_head_${i}`,
    }).apply(actorHead) as tf.SymbolicTensor;
  }
  const actorOutput = tf.layers.dense({
    units: cfg.numActions,
    activation: 'linear',
    name: 'actor_output',
  }).apply(actorHead) as tf.SymbolicTensor;

  // Critic head
  let criticHead: tf.SymbolicTensor = shared;
  const criticLayers = cfg.criticLayers ?? [64];
  for (let i = 0; i < criticLayers.length; i++) {
    criticHead = tf.layers.dense({
      units: criticLayers[i]!,
      activation: 'relu',
      name: `critic_head_${i}`,
    }).apply(criticHead) as tf.SymbolicTensor;
  }
  const criticOutput = tf.layers.dense({
    units: 1,
    activation: 'linear',
    name: 'critic_output',
  }).apply(criticHead) as tf.SymbolicTensor;

  // Combined model
  const model = tf.model({
    inputs: input,
    outputs: [actorOutput, criticOutput],
    name: 'actor_critic',
  });

  // Separate models for convenience (share weights with combined)
  const actor = tf.model({ inputs: input, outputs: actorOutput, name: 'actor' });
  const critic = tf.model({ inputs: input, outputs: criticOutput, name: 'critic' });

  return { model, actor, critic };
}
