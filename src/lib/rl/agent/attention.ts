/**
 * Multi-Head Attention Layer
 * TensorFlow.js implementation for transformer-based Q-network
 */

import * as tf from '@tensorflow/tfjs';

// Use tf.Variable instead of tf.LayerVariable for custom layers
type Variable = tf.Variable<tf.Rank>;

/**
 * Scaled Dot-Product Attention
 * Attention(Q, K, V) = softmax(Q*K^T / sqrt(d_k)) * V
 */
export function scaledDotProductAttention(
  query: tf.Tensor,
  key: tf.Tensor,
  value: tf.Tensor,
  mask?: tf.Tensor
): { output: tf.Tensor; attentionWeights: tf.Tensor } {
  return tf.tidy(() => {
    const depth = query.shape[query.shape.length - 1]!;
    const scale = Math.sqrt(depth);

    // Q * K^T
    const matmulQK = tf.matMul(query, key, false, true);

    // Scale
    const scaledAttention = tf.div(matmulQK, scale);

    // Apply mask if provided (for padding)
    let maskedAttention = scaledAttention;
    if (mask) {
      maskedAttention = tf.add(scaledAttention, tf.mul(mask, -1e9));
    }

    // Softmax
    const attentionWeights = tf.softmax(maskedAttention, -1);

    // Attention * V
    const output = tf.matMul(attentionWeights, value);

    return { output, attentionWeights };
  });
}

/**
 * Multi-Head Attention config
 */
export interface MultiHeadAttentionConfig {
  numHeads: number;
  keyDim: number;
  valueDim?: number;
  dropout?: number;
}

/**
 * Multi-Head Attention Layer
 * Splits Q, K, V into multiple heads, applies attention, then concatenates
 */
export class MultiHeadAttention {
  private numHeads: number;
  private keyDim: number;
  private valueDim: number;
  private dropout: number;

  // Learnable projection weights
  private wQ: Variable | null = null;
  private wK: Variable | null = null;
  private wV: Variable | null = null;
  private wO: Variable | null = null;

  private built: boolean = false;
  private inputDim: number = 0;

  constructor(config: MultiHeadAttentionConfig) {
    this.numHeads = config.numHeads;
    this.keyDim = config.keyDim;
    this.valueDim = config.valueDim ?? config.keyDim;
    this.dropout = config.dropout ?? 0;
  }

  /**
   * Build the layer weights
   */
  build(inputDim: number): void {
    if (this.built) return;

    this.inputDim = inputDim;
    const headDim = this.keyDim;
    const totalKeyDim = this.numHeads * headDim;
    const totalValueDim = this.numHeads * this.valueDim;

    // Create projection weights
    this.wQ = tf.variable(
      tf.randomNormal([inputDim, totalKeyDim], 0, Math.sqrt(2 / (inputDim + totalKeyDim))),
      true,
      'wQ'
    );
    this.wK = tf.variable(
      tf.randomNormal([inputDim, totalKeyDim], 0, Math.sqrt(2 / (inputDim + totalKeyDim))),
      true,
      'wK'
    );
    this.wV = tf.variable(
      tf.randomNormal([inputDim, totalValueDim], 0, Math.sqrt(2 / (inputDim + totalValueDim))),
      true,
      'wV'
    );
    this.wO = tf.variable(
      tf.randomNormal([totalValueDim, inputDim], 0, Math.sqrt(2 / (totalValueDim + inputDim))),
      true,
      'wO'
    );

    this.built = true;
  }

  /**
   * Apply multi-head attention
   * @param query Query tensor [batch, seq_len, d_model]
   * @param key Key tensor [batch, seq_len, d_model]
   * @param value Value tensor [batch, seq_len, d_model]
   * @param training Whether in training mode
   */
  apply(
    query: tf.Tensor,
    key: tf.Tensor,
    value: tf.Tensor,
    training: boolean = false
  ): tf.Tensor {
    if (!this.built) {
      this.build(query.shape[query.shape.length - 1] as number);
    }

    return tf.tidy(() => {
      const batchSize = query.shape[0]!;
      const seqLen = query.shape[1]!;

      // Project Q, K, V
      const q = tf.matMul(tf.reshape(query, [-1, this.inputDim]), this.wQ!);
      const k = tf.matMul(tf.reshape(key, [-1, this.inputDim]), this.wK!);
      const v = tf.matMul(tf.reshape(value, [-1, this.inputDim]), this.wV!);

      // Reshape to [batch, num_heads, seq_len, head_dim]
      const qReshaped = tf.transpose(
        tf.reshape(q, [batchSize, seqLen, this.numHeads, this.keyDim]),
        [0, 2, 1, 3]
      );
      const kReshaped = tf.transpose(
        tf.reshape(k, [batchSize, seqLen, this.numHeads, this.keyDim]),
        [0, 2, 1, 3]
      );
      const vReshaped = tf.transpose(
        tf.reshape(v, [batchSize, seqLen, this.numHeads, this.valueDim]),
        [0, 2, 1, 3]
      );

      // Apply scaled dot-product attention for each head
      const { output: attentionOutput } = scaledDotProductAttention(
        qReshaped,
        kReshaped,
        vReshaped
      );

      // Transpose back and reshape [batch, seq_len, num_heads * value_dim]
      const concatOutput = tf.reshape(
        tf.transpose(attentionOutput, [0, 2, 1, 3]),
        [batchSize, seqLen, this.numHeads * this.valueDim]
      );

      // Final projection
      let output = tf.matMul(
        tf.reshape(concatOutput, [-1, this.numHeads * this.valueDim]),
        this.wO!
      );
      output = tf.reshape(output, [batchSize, seqLen, this.inputDim]);

      // Apply dropout during training
      if (training && this.dropout > 0) {
        output = tf.dropout(output, this.dropout);
      }

      return output;
    });
  }

  /**
   * Get trainable weights
   */
  getWeights(): tf.Tensor[] {
    if (!this.built) return [];
    return [this.wQ!, this.wK!, this.wV!, this.wO!];
  }

  /**
   * Set weights
   */
  setWeights(weights: tf.Tensor[]): void {
    if (weights.length !== 4) throw new Error('Expected 4 weight tensors');

    if (this.wQ) (this.wQ as tf.Variable).assign(weights[0]!);
    if (this.wK) (this.wK as tf.Variable).assign(weights[1]!);
    if (this.wV) (this.wV as tf.Variable).assign(weights[2]!);
    if (this.wO) (this.wO as tf.Variable).assign(weights[3]!);
  }

  /**
   * Dispose of tensors
   */
  dispose(): void {
    this.wQ?.dispose();
    this.wK?.dispose();
    this.wV?.dispose();
    this.wO?.dispose();
  }
}

/**
 * Learnable positional encoding
 */
export function learnablePositionalEncoding(
  seqLength: number,
  embeddingDim: number,
  name: string = 'pos_enc'
): Variable {
  // Initialize with sinusoidal positions as starting point
  const positions = Array.from({ length: seqLength }, (_, i) => {
    const row: number[] = [];
    for (let j = 0; j < embeddingDim; j++) {
      if (j % 2 === 0) {
        row.push(Math.sin(i / Math.pow(10000, j / embeddingDim)));
      } else {
        row.push(Math.cos(i / Math.pow(10000, (j - 1) / embeddingDim)));
      }
    }
    return row;
  });

  return tf.variable(tf.tensor2d(positions), true, name);
}

/**
 * Fixed sinusoidal positional encoding
 */
export function sinusoidalPositionalEncoding(
  seqLength: number,
  embeddingDim: number
): tf.Tensor2D {
  const positions = Array.from({ length: seqLength }, (_, i) => {
    const row: number[] = [];
    for (let j = 0; j < embeddingDim; j++) {
      if (j % 2 === 0) {
        row.push(Math.sin(i / Math.pow(10000, j / embeddingDim)));
      } else {
        row.push(Math.cos(i / Math.pow(10000, (j - 1) / embeddingDim)));
      }
    }
    return row;
  });

  return tf.tensor2d(positions);
}
