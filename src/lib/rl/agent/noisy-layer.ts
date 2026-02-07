/**
 * NoisyDense Layer
 *
 * Implements parametric noise for exploration as described in:
 * "Noisy Networks for Exploration" (Fortunato et al., 2017)
 *
 * Instead of epsilon-greedy exploration, the network learns when to explore
 * via learnable noise parameters. This provides:
 * - State-dependent exploration (more noise where uncertain)
 * - Automatic exploration schedule (no epsilon decay tuning)
 * - Better exploration in high-dimensional state spaces
 */

import * as tf from '@tensorflow/tfjs';

// Global flag to control noisy layer training mode
// This is needed because TensorFlow.js predict() doesn't support training flag
let noisyLayerTrainingMode = true;

export function setNoisyLayerTrainingMode(training: boolean): void {
  noisyLayerTrainingMode = training;
}

export function getNoisyLayerTrainingMode(): boolean {
  return noisyLayerTrainingMode;
}

// Counter for unique layer names
let noisyLayerCounter = 0;

/**
 * NoisyDense layer with factorized Gaussian noise
 *
 * For efficiency, uses factorized noise:
 * noise_ij = f(eps_i) * f(eps_j)
 * where f(x) = sign(x) * sqrt(|x|)
 */
export class NoisyDense extends tf.layers.Layer {
  static className = 'NoisyDense';

  private units: number;
  private sigmaInit: number;
  private useBias: boolean;

  // Learnable parameters (mean)
  private muWeight!: tf.LayerVariable;
  private muBias!: tf.LayerVariable | null;

  // Learnable parameters (noise scale)
  private sigmaWeight!: tf.LayerVariable;
  private sigmaBias!: tf.LayerVariable | null;

  // Input dimension (set in build)
  private inputDim: number = 0;

  constructor(config: { units: number; sigmaInit?: number; useBias?: boolean; name?: string }) {
    const layerId = noisyLayerCounter++;
    super({ name: config.name ?? `noisy_dense_${config.units}_${layerId}` });
    this.units = config.units;
    this.sigmaInit = config.sigmaInit ?? 0.5;
    this.useBias = config.useBias ?? true;
  }

  build(inputShape: tf.Shape | tf.Shape[]): void {
    const shape = Array.isArray(inputShape[0]) ? inputShape[0] : inputShape;
    this.inputDim = shape[shape.length - 1] as number;

    // Initialize mu with uniform distribution [-1/sqrt(inputDim), 1/sqrt(inputDim)]
    const bound = 1 / Math.sqrt(this.inputDim);

    // Mean weights
    this.muWeight = this.addWeight(
      'mu_weight',
      [this.inputDim, this.units],
      'float32',
      tf.initializers.randomUniform({ minval: -bound, maxval: bound })
    );

    // Sigma weights (initialized to sigmaInit / sqrt(inputDim))
    const sigmaValue = this.sigmaInit / Math.sqrt(this.inputDim);
    this.sigmaWeight = this.addWeight(
      'sigma_weight',
      [this.inputDim, this.units],
      'float32',
      tf.initializers.constant({ value: sigmaValue })
    );

    if (this.useBias) {
      this.muBias = this.addWeight(
        'mu_bias',
        [this.units],
        'float32',
        tf.initializers.randomUniform({ minval: -bound, maxval: bound })
      );

      this.sigmaBias = this.addWeight(
        'sigma_bias',
        [this.units],
        'float32',
        tf.initializers.constant({ value: sigmaValue })
      );
    } else {
      this.muBias = null;
      this.sigmaBias = null;
    }

    this.built = true;
  }

  /**
   * Factorized noise function: f(x) = sign(x) * sqrt(|x|)
   */
  private factorizedNoise(epsilon: tf.Tensor): tf.Tensor {
    return tf.sign(epsilon).mul(tf.sqrt(tf.abs(epsilon)));
  }

  call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor | tf.Tensor[] {
    return tf.tidy(() => {
      const input = Array.isArray(inputs) ? inputs[0]! : inputs;
      // Use global training mode flag since TF.js predict() doesn't support training arg
      const training = noisyLayerTrainingMode;

      // Get mean weights
      const muW = this.muWeight.read();
      const sigmaW = this.sigmaWeight.read();

      let weight: tf.Tensor;
      let bias: tf.Tensor | null = null;

      if (training) {
        // Generate factorized noise for efficiency
        // eps_i for input, eps_j for output
        const epsInput = tf.randomStandardNormal([this.inputDim, 1]);
        const epsOutput = tf.randomStandardNormal([1, this.units]);

        // Factorized noise: noise_ij = f(eps_i) * f(eps_j)
        const noiseInput = this.factorizedNoise(epsInput);
        const noiseOutput = this.factorizedNoise(epsOutput);
        const weightNoise = noiseInput.matMul(noiseOutput);

        // Weight = mu + sigma * noise
        weight = muW.add(sigmaW.mul(weightNoise));

        if (this.useBias && this.muBias && this.sigmaBias) {
          const muB = this.muBias.read();
          const sigmaB = this.sigmaBias.read();
          const biasNoise = this.factorizedNoise(tf.randomStandardNormal([this.units]));
          bias = muB.add(sigmaB.mul(biasNoise));
        }
      } else {
        // Evaluation mode: use mean weights only (no noise)
        weight = muW;
        if (this.useBias && this.muBias) {
          bias = this.muBias.read();
        }
      }

      // Linear transformation
      let output = input.matMul(weight);
      if (bias) {
        output = output.add(bias);
      }

      return output;
    });
  }

  computeOutputShape(inputShape: tf.Shape | tf.Shape[]): tf.Shape {
    const shape = Array.isArray(inputShape[0]) ? inputShape[0] : inputShape;
    return [...shape.slice(0, -1), this.units] as tf.Shape;
  }

  getConfig(): tf.serialization.ConfigDict {
    const config = super.getConfig();
    return {
      ...config,
      units: this.units,
      sigmaInit: this.sigmaInit,
      useBias: this.useBias,
    };
  }

  static fromConfig<T extends tf.serialization.Serializable>(
    cls: tf.serialization.SerializableConstructor<T>,
    config: tf.serialization.ConfigDict
  ): T {
    return new cls(config) as T;
  }
}

// Register for serialization
tf.serialization.registerClass(NoisyDense);
