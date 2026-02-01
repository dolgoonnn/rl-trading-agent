/**
 * Network Architectures
 * Q-network variants for DQN agent
 */

import * as tf from '@tensorflow/tfjs';
import { TransformerEncoder } from './transformer';

// Use tf.Variable instead of tf.LayerVariable for custom layers
type Variable = tf.Variable<tf.Rank>;

export type NetworkType = 'dense' | 'transformer';

export interface DenseNetworkConfig {
  inputSize: number;
  hiddenLayers: number[];
  outputSize: number;
  useBatchNorm: boolean;
  dropout: number;
  l2Regularization: number;
}

export interface TransformerNetworkConfig {
  // Returns sequence (processed by transformer)
  returnsSeqLength: number; // e.g., 60
  returnsInputDim: number; // e.g., 1 (just return values)

  // ICT features (concatenated after transformer)
  ictFeatureSize: number; // e.g., 30

  // Transformer config
  transformerDim: number; // Model dimension
  numHeads: number; // Attention heads
  ffDim: number; // Feed-forward dimension
  numLayers: number; // Transformer blocks
  transformerDropout: number;

  // Output head
  hiddenLayers: number[];
  outputSize: number;
  dropout: number;
  useBatchNorm: boolean;
}

/**
 * Build standard dense Q-network
 */
export function buildDenseNetwork(config: DenseNetworkConfig): tf.LayersModel {
  const model = tf.sequential({ name: 'dense_qnet' });

  // Input layer
  model.add(
    tf.layers.dense({
      inputShape: [config.inputSize],
      units: config.hiddenLayers[0]!,
      activation: config.useBatchNorm ? 'linear' : 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: config.l2Regularization }),
    })
  );

  if (config.useBatchNorm) {
    model.add(tf.layers.batchNormalization({ momentum: 0.9, epsilon: 1e-5 }));
    model.add(tf.layers.activation({ activation: 'relu' }));
  }
  model.add(tf.layers.dropout({ rate: config.dropout }));

  // Hidden layers
  for (let i = 1; i < config.hiddenLayers.length; i++) {
    model.add(
      tf.layers.dense({
        units: config.hiddenLayers[i]!,
        activation: config.useBatchNorm ? 'linear' : 'relu',
        kernelRegularizer: tf.regularizers.l2({ l2: config.l2Regularization }),
      })
    );

    if (config.useBatchNorm) {
      model.add(tf.layers.batchNormalization({ momentum: 0.9, epsilon: 1e-5 }));
      model.add(tf.layers.activation({ activation: 'relu' }));
    }
    model.add(tf.layers.dropout({ rate: config.dropout }));
  }

  // Output layer
  model.add(
    tf.layers.dense({
      units: config.outputSize,
      activation: 'linear',
    })
  );

  return model;
}

/**
 * Transformer Q-Network
 * Processes returns sequence with attention, then combines with ICT features
 */
export class TransformerQNetwork {
  private config: TransformerNetworkConfig;
  private transformer: TransformerEncoder;

  // Dense layers for final output
  private denseWeights: Variable[] = [];
  private denseBiases: Variable[] = [];
  private bnParams: { gamma: Variable; beta: Variable }[] = [];
  private outputWeight: Variable | null = null;
  private outputBias: Variable | null = null;

  private built: boolean = false;

  constructor(config: TransformerNetworkConfig) {
    this.config = config;

    // Create transformer encoder for returns sequence
    this.transformer = new TransformerEncoder({
      seqLength: config.returnsSeqLength,
      inputDim: config.returnsInputDim,
      modelDim: config.transformerDim,
      numHeads: config.numHeads,
      ffDim: config.ffDim,
      numLayers: config.numLayers,
      dropout: config.transformerDropout,
      usePositionalEncoding: true,
    });
  }

  /**
   * Build network weights
   */
  build(): void {
    if (this.built) return;

    // Build transformer
    this.transformer.build();

    // Combined input: transformer output + ICT features
    const combinedInputSize = this.config.transformerDim + this.config.ictFeatureSize;

    // Build dense head
    let prevSize = combinedInputSize;
    for (let i = 0; i < this.config.hiddenLayers.length; i++) {
      const units = this.config.hiddenLayers[i]!;

      this.denseWeights.push(
        tf.variable(
          tf.randomNormal([prevSize, units], 0, Math.sqrt(2 / (prevSize + units))),
          true,
          `dense_${i}_weight`
        )
      );
      this.denseBiases.push(tf.variable(tf.zeros([units]), true, `dense_${i}_bias`));

      if (this.config.useBatchNorm) {
        this.bnParams.push({
          gamma: tf.variable(tf.ones([units]), true, `bn_${i}_gamma`),
          beta: tf.variable(tf.zeros([units]), true, `bn_${i}_beta`),
        });
      }

      prevSize = units;
    }

    // Output layer
    this.outputWeight = tf.variable(
      tf.randomNormal([prevSize, this.config.outputSize], 0, Math.sqrt(2 / (prevSize + this.config.outputSize))),
      true,
      'output_weight'
    );
    this.outputBias = tf.variable(tf.zeros([this.config.outputSize]), true, 'output_bias');

    this.built = true;
  }

  /**
   * Layer normalization helper
   */
  private batchNorm(
    x: tf.Tensor,
    gamma: tf.Tensor,
    beta: tf.Tensor,
    _training: boolean
  ): tf.Tensor {
    return tf.tidy(() => {
      // Simple batch norm (not tracking running stats for simplicity)
      const mean = tf.mean(x, 0, true);
      const variance = tf.mean(tf.square(tf.sub(x, mean)), 0, true);
      const normalized = tf.div(tf.sub(x, mean), tf.sqrt(tf.add(variance, 1e-5)));
      return tf.add(tf.mul(normalized, gamma), beta);
    });
  }

  /**
   * Forward pass
   * @param returnsSeq Returns sequence [batch, seq_len, 1]
   * @param ictFeatures ICT features [batch, ict_feature_size]
   * @param training Whether in training mode
   * @returns Q-values [batch, num_actions]
   */
  apply(
    returnsSeq: tf.Tensor,
    ictFeatures: tf.Tensor,
    training: boolean = false
  ): tf.Tensor {
    if (!this.built) this.build();

    return tf.tidy(() => {
      // Process returns with transformer
      const transformerOutput = this.transformer.applyAndPool(returnsSeq, training);

      // Concatenate with ICT features
      let combined = tf.concat([transformerOutput, ictFeatures], -1);

      // Dense head
      for (let i = 0; i < this.denseWeights.length; i++) {
        combined = tf.add(tf.matMul(combined, this.denseWeights[i]!), this.denseBiases[i]!);

        if (this.config.useBatchNorm && this.bnParams[i]) {
          combined = this.batchNorm(
            combined,
            this.bnParams[i]!.gamma,
            this.bnParams[i]!.beta,
            training
          );
        }

        combined = tf.relu(combined);

        if (training && this.config.dropout > 0) {
          combined = tf.dropout(combined, this.config.dropout);
        }
      }

      // Output layer
      const output = tf.add(tf.matMul(combined, this.outputWeight!), this.outputBias!);

      return output;
    });
  }

  /**
   * Predict Q-values from flat state vector
   * Splits state into returns sequence and ICT features
   */
  predict(state: tf.Tensor, training: boolean = false): tf.Tensor {
    return tf.tidy(() => {
      const batchSize = state.shape[0]!;

      // Split state: first N values are returns, rest are ICT features
      const returnsFlat = tf.slice(state, [0, 0], [batchSize, this.config.returnsSeqLength]);
      const ictFeatures = tf.slice(
        state,
        [0, this.config.returnsSeqLength],
        [batchSize, this.config.ictFeatureSize]
      );

      // Reshape returns to sequence [batch, seq_len, 1]
      const returnsSeq = tf.expandDims(returnsFlat, -1);

      return this.apply(returnsSeq, ictFeatures, training);
    });
  }

  /**
   * Get all trainable weights
   */
  getWeights(): tf.Tensor[] {
    if (!this.built) return [];

    const weights: tf.Tensor[] = [...this.transformer.getWeights()];

    for (let i = 0; i < this.denseWeights.length; i++) {
      weights.push(this.denseWeights[i]!);
      weights.push(this.denseBiases[i]!);
      if (this.bnParams[i]) {
        weights.push(this.bnParams[i]!.gamma);
        weights.push(this.bnParams[i]!.beta);
      }
    }

    weights.push(this.outputWeight!);
    weights.push(this.outputBias!);

    return weights;
  }

  /**
   * Dispose of tensors
   */
  dispose(): void {
    this.transformer.dispose();
    for (const w of this.denseWeights) w.dispose();
    for (const b of this.denseBiases) b.dispose();
    for (const bn of this.bnParams) {
      bn.gamma.dispose();
      bn.beta.dispose();
    }
    this.outputWeight?.dispose();
    this.outputBias?.dispose();
  }
}

/**
 * Create a Q-network based on type
 */
export function createQNetwork(
  type: NetworkType,
  config: DenseNetworkConfig | TransformerNetworkConfig
): tf.LayersModel | TransformerQNetwork {
  if (type === 'dense') {
    return buildDenseNetwork(config as DenseNetworkConfig);
  } else {
    return new TransformerQNetwork(config as TransformerNetworkConfig);
  }
}
