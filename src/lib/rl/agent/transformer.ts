/**
 * Transformer Encoder Block
 * Full transformer block with attention, feed-forward, and residuals
 */

import * as tf from '@tensorflow/tfjs';
import { MultiHeadAttention, learnablePositionalEncoding } from './attention';

// Use tf.Variable instead of tf.LayerVariable for custom layers
type Variable = tf.Variable<tf.Rank>;

export interface TransformerBlockConfig {
  modelDim: number; // Model/embedding dimension
  numHeads: number; // Number of attention heads
  ffDim: number; // Feed-forward hidden dimension
  dropout: number; // Dropout rate
}

/**
 * Single Transformer Encoder Block
 * Attention -> Add & Norm -> FFN -> Add & Norm
 */
export class TransformerBlock {
  private config: TransformerBlockConfig;
  private attention: MultiHeadAttention;

  // FFN weights
  private ffn1: Variable | null = null;
  private ffn1Bias: Variable | null = null;
  private ffn2: Variable | null = null;
  private ffn2Bias: Variable | null = null;

  // Layer norm params
  private ln1Gamma: Variable | null = null;
  private ln1Beta: Variable | null = null;
  private ln2Gamma: Variable | null = null;
  private ln2Beta: Variable | null = null;

  private built: boolean = false;

  constructor(config: TransformerBlockConfig) {
    this.config = config;
    this.attention = new MultiHeadAttention({
      numHeads: config.numHeads,
      keyDim: Math.floor(config.modelDim / config.numHeads),
      dropout: config.dropout,
    });
  }

  /**
   * Build layer weights
   */
  build(): void {
    if (this.built) return;

    const { modelDim, ffDim } = this.config;

    // FFN weights
    this.ffn1 = tf.variable(
      tf.randomNormal([modelDim, ffDim], 0, Math.sqrt(2 / (modelDim + ffDim))),
      true,
      'ffn1'
    );
    this.ffn1Bias = tf.variable(tf.zeros([ffDim]), true, 'ffn1_bias');
    this.ffn2 = tf.variable(
      tf.randomNormal([ffDim, modelDim], 0, Math.sqrt(2 / (ffDim + modelDim))),
      true,
      'ffn2'
    );
    this.ffn2Bias = tf.variable(tf.zeros([modelDim]), true, 'ffn2_bias');

    // Layer norm params (initialized to no-op: gamma=1, beta=0)
    this.ln1Gamma = tf.variable(tf.ones([modelDim]), true, 'ln1_gamma');
    this.ln1Beta = tf.variable(tf.zeros([modelDim]), true, 'ln1_beta');
    this.ln2Gamma = tf.variable(tf.ones([modelDim]), true, 'ln2_gamma');
    this.ln2Beta = tf.variable(tf.zeros([modelDim]), true, 'ln2_beta');

    this.built = true;
  }

  /**
   * Layer normalization
   */
  private layerNorm(
    x: tf.Tensor,
    gamma: tf.Tensor,
    beta: tf.Tensor,
    epsilon: number = 1e-6
  ): tf.Tensor {
    return tf.tidy(() => {
      const mean = tf.mean(x, -1, true);
      const variance = tf.mean(tf.square(tf.sub(x, mean)), -1, true);
      const normalized = tf.div(tf.sub(x, mean), tf.sqrt(tf.add(variance, epsilon)));
      return tf.add(tf.mul(normalized, gamma), beta);
    });
  }

  /**
   * Feed-forward network
   */
  private feedForward(x: tf.Tensor, training: boolean): tf.Tensor {
    return tf.tidy(() => {
      const batchSize = x.shape[0]!;
      const seqLen = x.shape[1]!;
      const modelDim = this.config.modelDim;

      // Reshape for matrix multiply
      let flat = tf.reshape(x, [-1, modelDim]);

      // First layer with GELU activation
      let hidden = tf.add(tf.matMul(flat, this.ffn1!), this.ffn1Bias!);
      hidden = tf.mul(hidden, tf.sigmoid(tf.mul(hidden, 1.702))); // GELU approximation

      // Dropout
      if (training && this.config.dropout > 0) {
        hidden = tf.dropout(hidden, this.config.dropout);
      }

      // Second layer (projection back to model dim)
      let output = tf.add(tf.matMul(hidden, this.ffn2!), this.ffn2Bias!);

      // Dropout
      if (training && this.config.dropout > 0) {
        output = tf.dropout(output, this.config.dropout);
      }

      return tf.reshape(output, [batchSize, seqLen, modelDim]);
    });
  }

  /**
   * Apply transformer block
   * @param x Input tensor [batch, seq_len, model_dim]
   * @param training Whether in training mode
   */
  apply(x: tf.Tensor, training: boolean = false): tf.Tensor {
    if (!this.built) this.build();

    return tf.tidy(() => {
      // Self-attention with residual
      const attOutput = this.attention.apply(x, x, x, training);
      let output = tf.add(x, attOutput);

      // Layer norm 1
      output = this.layerNorm(output, this.ln1Gamma!, this.ln1Beta!);

      // Feed-forward with residual
      const ffOutput = this.feedForward(output, training);
      output = tf.add(output, ffOutput);

      // Layer norm 2
      output = this.layerNorm(output, this.ln2Gamma!, this.ln2Beta!);

      return output;
    });
  }

  /**
   * Get all trainable weights
   */
  getWeights(): tf.Tensor[] {
    if (!this.built) return [];
    return [
      ...this.attention.getWeights(),
      this.ffn1!,
      this.ffn1Bias!,
      this.ffn2!,
      this.ffn2Bias!,
      this.ln1Gamma!,
      this.ln1Beta!,
      this.ln2Gamma!,
      this.ln2Beta!,
    ];
  }

  /**
   * Dispose of tensors
   */
  dispose(): void {
    this.attention.dispose();
    this.ffn1?.dispose();
    this.ffn1Bias?.dispose();
    this.ffn2?.dispose();
    this.ffn2Bias?.dispose();
    this.ln1Gamma?.dispose();
    this.ln1Beta?.dispose();
    this.ln2Gamma?.dispose();
    this.ln2Beta?.dispose();
  }
}

export interface TransformerEncoderConfig {
  seqLength: number; // Sequence length (e.g., 60 returns)
  inputDim: number; // Input feature dimension
  modelDim: number; // Internal model dimension
  numHeads: number; // Attention heads
  ffDim: number; // Feed-forward hidden dim
  numLayers: number; // Number of transformer blocks
  dropout: number;
  usePositionalEncoding: boolean;
}

/**
 * Full Transformer Encoder
 * Stacks multiple transformer blocks with positional encoding
 */
export class TransformerEncoder {
  private config: TransformerEncoderConfig;
  private blocks: TransformerBlock[];

  // Input projection
  private inputProj: Variable | null = null;
  private inputBias: Variable | null = null;

  // Positional encoding
  private posEncoding: Variable | null = null;

  private built: boolean = false;

  constructor(config: TransformerEncoderConfig) {
    this.config = config;
    this.blocks = [];

    for (let i = 0; i < config.numLayers; i++) {
      this.blocks.push(
        new TransformerBlock({
          modelDim: config.modelDim,
          numHeads: config.numHeads,
          ffDim: config.ffDim,
          dropout: config.dropout,
        })
      );
    }
  }

  /**
   * Build layer weights
   */
  build(): void {
    if (this.built) return;

    const { inputDim, modelDim, seqLength } = this.config;

    // Input projection
    this.inputProj = tf.variable(
      tf.randomNormal([inputDim, modelDim], 0, Math.sqrt(2 / (inputDim + modelDim))),
      true,
      'input_proj'
    );
    this.inputBias = tf.variable(tf.zeros([modelDim]), true, 'input_bias');

    // Positional encoding
    if (this.config.usePositionalEncoding) {
      this.posEncoding = learnablePositionalEncoding(seqLength, modelDim, 'pos_enc');
    }

    // Build blocks
    for (const block of this.blocks) {
      block.build();
    }

    this.built = true;
  }

  /**
   * Apply transformer encoder
   * @param x Input tensor [batch, seq_len, input_dim]
   * @param training Whether in training mode
   * @returns Encoded tensor [batch, seq_len, model_dim]
   */
  apply(x: tf.Tensor, training: boolean = false): tf.Tensor {
    if (!this.built) this.build();

    return tf.tidy(() => {
      const batchSize = x.shape[0]!;
      const seqLen = x.shape[1]!;
      const inputDim = this.config.inputDim;
      const modelDim = this.config.modelDim;

      // Project input to model dimension
      let flat = tf.reshape(x, [-1, inputDim]);
      let encoded = tf.add(tf.matMul(flat, this.inputProj!), this.inputBias!);
      encoded = tf.reshape(encoded, [batchSize, seqLen, modelDim]);

      // Add positional encoding
      if (this.posEncoding) {
        // Broadcast positional encoding to batch
        const posEnc = tf.expandDims(this.posEncoding!, 0);
        encoded = tf.add(encoded, posEnc);
      }

      // Apply dropout to embeddings
      if (training && this.config.dropout > 0) {
        encoded = tf.dropout(encoded, this.config.dropout);
      }

      // Apply transformer blocks
      for (const block of this.blocks) {
        encoded = block.apply(encoded, training);
      }

      return encoded;
    });
  }

  /**
   * Apply and pool to get fixed-size output
   * @param x Input tensor [batch, seq_len, input_dim]
   * @param training Whether in training mode
   * @returns Pooled output [batch, model_dim]
   */
  applyAndPool(x: tf.Tensor, training: boolean = false): tf.Tensor {
    return tf.tidy(() => {
      const encoded = this.apply(x, training);
      // Global average pooling over sequence dimension
      return tf.mean(encoded, 1);
    });
  }

  /**
   * Get all trainable weights
   */
  getWeights(): tf.Tensor[] {
    if (!this.built) return [];

    const weights: tf.Tensor[] = [this.inputProj!, this.inputBias!];

    if (this.posEncoding) {
      weights.push(this.posEncoding);
    }

    for (const block of this.blocks) {
      weights.push(...block.getWeights());
    }

    return weights;
  }

  /**
   * Dispose of tensors
   */
  dispose(): void {
    this.inputProj?.dispose();
    this.inputBias?.dispose();
    this.posEncoding?.dispose();
    for (const block of this.blocks) {
      block.dispose();
    }
  }
}
