/**
 * Feature Reducer
 *
 * Implements dimensionality reduction for the state vector to prevent overfitting.
 *
 * Methods:
 * 1. PCA (Principal Component Analysis) - linear reduction
 * 2. Feature Selection - keep most important features based on variance
 * 3. Feature Grouping - average correlated features
 *
 * Research basis: High-dimensional state spaces with limited training data
 * lead to overfitting. Reducing 104 features to ~50 while preserving 95%+
 * of variance significantly improves generalization.
 */

import type { TradingState } from '../types';

export interface FeatureReducerConfig {
  method: 'pca' | 'selection' | 'grouping' | 'none';

  // PCA settings
  targetDimensions?: number; // Target number of dimensions
  varianceThreshold?: number; // Keep components explaining this much variance (0.95 = 95%)

  // Feature selection settings
  topKFeatures?: number; // Select top K features by variance

  // Feature grouping settings
  correlationThreshold?: number; // Group features with correlation > this

  // Warmup settings
  warmupSamples: number; // Number of samples to collect before fitting
}

const DEFAULT_CONFIG: FeatureReducerConfig = {
  method: 'pca',
  targetDimensions: 50,
  varianceThreshold: 0.95,
  topKFeatures: 50,
  correlationThreshold: 0.9,
  warmupSamples: 1000,
};

interface PCAModel {
  mean: number[];
  components: number[][]; // Principal components (eigenvectors)
  explainedVariance: number[]; // Variance explained by each component
  nComponents: number;
}

export class FeatureReducer {
  private config: FeatureReducerConfig;

  // PCA model
  private pcaModel: PCAModel | null = null;

  // Feature selection model
  private selectedFeatureIndices: number[] | null = null;

  // Warmup samples
  private warmupData: number[][] = [];
  private isFitted: boolean = false;

  constructor(config: Partial<FeatureReducerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a sample during warmup phase
   */
  addSample(features: number[]): void {
    if (this.isFitted) return;

    this.warmupData.push([...features]);

    if (this.warmupData.length >= this.config.warmupSamples) {
      this.fit();
    }
  }

  /**
   * Check if reducer is ready to transform
   */
  isReady(): boolean {
    return this.isFitted || this.config.method === 'none';
  }

  /**
   * Get output dimension
   */
  getOutputDimension(): number {
    if (this.config.method === 'none') {
      return -1; // Unknown, pass-through
    }

    if (this.config.method === 'pca') {
      return this.pcaModel?.nComponents ?? this.config.targetDimensions ?? 50;
    }

    if (this.config.method === 'selection') {
      return this.selectedFeatureIndices?.length ?? this.config.topKFeatures ?? 50;
    }

    // grouping - return after fitting
    return this.selectedFeatureIndices?.length ?? 50;
  }

  /**
   * Fit the reducer on collected warmup data
   */
  fit(): void {
    if (this.warmupData.length === 0) {
      throw new Error('No warmup data collected');
    }

    console.log(`[FeatureReducer] Fitting ${this.config.method} on ${this.warmupData.length} samples...`);

    switch (this.config.method) {
      case 'pca':
        this.fitPCA();
        break;
      case 'selection':
        this.fitSelection();
        break;
      case 'grouping':
        this.fitGrouping();
        break;
      case 'none':
        break;
    }

    this.isFitted = true;

    // Clear warmup data to free memory
    this.warmupData = [];

    console.log(`[FeatureReducer] Fitted. Output dimension: ${this.getOutputDimension()}`);
  }

  /**
   * Transform features using the fitted model
   */
  transform(features: number[]): number[] {
    if (!this.isFitted) {
      // During warmup, return original features
      return features;
    }

    switch (this.config.method) {
      case 'pca':
        return this.transformPCA(features);
      case 'selection':
      case 'grouping':
        return this.transformSelection(features);
      case 'none':
        return features;
      default:
        return features;
    }
  }

  /**
   * Fit and transform a state
   */
  fitTransformState(state: TradingState): TradingState {
    if (!this.isFitted) {
      this.addSample(state.features);
    }

    return {
      ...state,
      features: this.transform(state.features),
    };
  }

  // ============================================
  // PCA Implementation
  // ============================================

  /**
   * Fit PCA model
   * Uses covariance matrix eigendecomposition
   */
  private fitPCA(): void {
    const n = this.warmupData.length;
    const d = this.warmupData[0]!.length;

    // Compute mean
    const mean = new Array(d).fill(0);
    for (const sample of this.warmupData) {
      for (let i = 0; i < d; i++) {
        mean[i] += sample[i]!;
      }
    }
    for (let i = 0; i < d; i++) {
      mean[i] /= n;
    }

    // Center data
    const centered = this.warmupData.map((sample) =>
      sample.map((v, i) => v - mean[i]!)
    );

    // Compute covariance matrix (d x d)
    const cov = this.computeCovariance(centered);

    // Power iteration for top eigenvalues/eigenvectors
    // (Full eigendecomposition is expensive, use iterative method)
    const { eigenvectors, eigenvalues } = this.powerIteration(
      cov,
      this.config.targetDimensions ?? 50
    );

    // Determine number of components based on variance threshold
    const totalVariance = eigenvalues.reduce((a, b) => a + b, 0);
    let cumulativeVariance = 0;
    let nComponents = 0;

    for (let i = 0; i < eigenvalues.length; i++) {
      cumulativeVariance += eigenvalues[i]!;
      nComponents++;
      if (cumulativeVariance / totalVariance >= (this.config.varianceThreshold ?? 0.95)) {
        break;
      }
    }

    this.pcaModel = {
      mean,
      components: eigenvectors.slice(0, nComponents),
      explainedVariance: eigenvalues.slice(0, nComponents).map((ev) => ev / totalVariance),
      nComponents,
    };

    const totalExplained = this.pcaModel.explainedVariance.reduce((a, b) => a + b, 0);
    console.log(`[PCA] Reduced ${d} -> ${nComponents} dimensions, explaining ${(totalExplained * 100).toFixed(1)}% variance`);
  }

  /**
   * Compute covariance matrix
   */
  private computeCovariance(data: number[][]): number[][] {
    const n = data.length;
    const d = data[0]!.length;
    const cov: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));

    for (let i = 0; i < d; i++) {
      for (let j = i; j < d; j++) {
        let sum = 0;
        for (const sample of data) {
          sum += sample[i]! * sample[j]!;
        }
        const value = sum / (n - 1);
        cov[i]![j] = value;
        cov[j]![i] = value;
      }
    }

    return cov;
  }

  /**
   * Power iteration method for computing top eigenvectors
   * More efficient than full eigendecomposition for large matrices
   */
  private powerIteration(
    matrix: number[][],
    nComponents: number,
    maxIter: number = 100,
    tolerance: number = 1e-6
  ): { eigenvectors: number[][]; eigenvalues: number[] } {
    const d = matrix.length;
    const eigenvectors: number[][] = [];
    const eigenvalues: number[] = [];

    // Make a copy of the matrix to deflate
    const A = matrix.map((row) => [...row]);

    for (let comp = 0; comp < nComponents; comp++) {
      // Initialize random vector
      let v = Array.from({ length: d }, () => Math.random() - 0.5);
      let eigenvalue = 0;

      for (let iter = 0; iter < maxIter; iter++) {
        // Multiply: Av
        const Av = new Array(d).fill(0);
        for (let i = 0; i < d; i++) {
          for (let j = 0; j < d; j++) {
            Av[i] += A[i]![j]! * v[j]!;
          }
        }

        // Compute eigenvalue (Rayleigh quotient)
        let num = 0, denom = 0;
        for (let i = 0; i < d; i++) {
          num += v[i]! * Av[i]!;
          denom += v[i]! * v[i]!;
        }
        const newEigenvalue = num / denom;

        // Normalize
        const norm = Math.sqrt(Av.reduce((a, b) => a + b * b, 0));
        const newV = Av.map((x) => x / norm);

        // Check convergence
        let diff = 0;
        for (let i = 0; i < d; i++) {
          diff += Math.pow(newV[i]! - v[i]!, 2);
        }

        v = newV;
        eigenvalue = newEigenvalue;

        if (diff < tolerance) break;
      }

      eigenvectors.push(v);
      eigenvalues.push(eigenvalue);

      // Deflate: A = A - eigenvalue * v * v^T
      for (let i = 0; i < d; i++) {
        const row = A[i]!;
        for (let j = 0; j < d; j++) {
          row[j] = row[j]! - eigenvalue * v[i]! * v[j]!;
        }
      }
    }

    return { eigenvectors, eigenvalues };
  }

  /**
   * Transform using PCA
   */
  private transformPCA(features: number[]): number[] {
    if (!this.pcaModel) return features;

    const { mean, components } = this.pcaModel;

    // Center
    const centered = features.map((v, i) => v - mean[i]!);

    // Project onto principal components
    return components.map((component) =>
      component.reduce((sum, c, i) => sum + c * centered[i]!, 0)
    );
  }

  // ============================================
  // Feature Selection Implementation
  // ============================================

  /**
   * Fit feature selection based on variance
   */
  private fitSelection(): void {
    const n = this.warmupData.length;
    const d = this.warmupData[0]!.length;

    // Compute variance for each feature
    const variances: { index: number; variance: number }[] = [];

    for (let i = 0; i < d; i++) {
      let sum = 0, sumSq = 0;
      for (const sample of this.warmupData) {
        sum += sample[i]!;
        sumSq += sample[i]! * sample[i]!;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      variances.push({ index: i, variance });
    }

    // Sort by variance (descending) and select top K
    variances.sort((a, b) => b.variance - a.variance);
    const topK = this.config.topKFeatures ?? 50;
    this.selectedFeatureIndices = variances.slice(0, topK).map((v) => v.index).sort((a, b) => a - b);

    console.log(`[Selection] Selected ${this.selectedFeatureIndices.length} features by variance`);
  }

  /**
   * Transform using feature selection
   */
  private transformSelection(features: number[]): number[] {
    if (!this.selectedFeatureIndices) return features;
    return this.selectedFeatureIndices.map((i) => features[i]!);
  }

  // ============================================
  // Feature Grouping Implementation
  // ============================================

  /**
   * Fit feature grouping based on correlation
   */
  private fitGrouping(): void {
    const n = this.warmupData.length;
    const d = this.warmupData[0]!.length;

    // Compute correlation matrix
    const correlations: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));

    // First compute means and stds
    const means: number[] = [];
    const stds: number[] = [];

    for (let i = 0; i < d; i++) {
      let sum = 0, sumSq = 0;
      for (const sample of this.warmupData) {
        sum += sample[i]!;
        sumSq += sample[i]! * sample[i]!;
      }
      means.push(sum / n);
      stds.push(Math.sqrt(sumSq / n - (sum / n) ** 2) + 1e-8);
    }

    // Compute correlations
    for (let i = 0; i < d; i++) {
      for (let j = i; j < d; j++) {
        if (i === j) {
          correlations[i]![j] = 1;
        } else {
          let sum = 0;
          for (const sample of this.warmupData) {
            sum += ((sample[i]! - means[i]!) / stds[i]!) * ((sample[j]! - means[j]!) / stds[j]!);
          }
          const corr = sum / n;
          correlations[i]![j] = corr;
          correlations[j]![i] = corr;
        }
      }
    }

    // Group highly correlated features
    const grouped = new Set<number>();
    const selected: number[] = [];
    const threshold = this.config.correlationThreshold ?? 0.9;

    for (let i = 0; i < d; i++) {
      if (grouped.has(i)) continue;

      selected.push(i);

      // Mark all highly correlated features as grouped
      for (let j = i + 1; j < d; j++) {
        if (Math.abs(correlations[i]![j]!) > threshold) {
          grouped.add(j);
        }
      }
    }

    this.selectedFeatureIndices = selected;
    console.log(`[Grouping] Reduced from ${d} to ${selected.length} features by grouping correlated features`);
  }

  // ============================================
  // Serialization
  // ============================================

  /**
   * Export the fitted model for persistence
   */
  exportModel(): SerializedFeatureReducer | null {
    if (!this.isFitted) return null;

    return {
      config: this.config,
      pcaModel: this.pcaModel,
      selectedFeatureIndices: this.selectedFeatureIndices,
    };
  }

  /**
   * Import a previously fitted model
   */
  importModel(data: SerializedFeatureReducer): void {
    this.config = data.config;
    this.pcaModel = data.pcaModel;
    this.selectedFeatureIndices = data.selectedFeatureIndices;
    this.isFitted = true;
    this.warmupData = []; // Clear warmup data

    console.log(`[FeatureReducer] Imported ${this.config.method} model with ${this.getOutputDimension()} output dimensions`);
  }

  // ============================================
  // Statistics
  // ============================================

  /**
   * Get reduction statistics
   */
  getStats(): FeatureReducerStats {
    return {
      method: this.config.method,
      isFitted: this.isFitted,
      inputDimension: this.warmupData.length > 0 ? this.warmupData[0]!.length : 0,
      outputDimension: this.getOutputDimension(),
      warmupProgress: this.isFitted ? 1.0 : this.warmupData.length / this.config.warmupSamples,
      explainedVariance: this.pcaModel?.explainedVariance.reduce((a, b) => a + b, 0),
    };
  }
}

export interface FeatureReducerStats {
  method: string;
  isFitted: boolean;
  inputDimension: number;
  outputDimension: number;
  warmupProgress: number;
  explainedVariance?: number;
}

export interface SerializedFeatureReducer {
  config: FeatureReducerConfig;
  pcaModel: {
    mean: number[];
    components: number[][];
    explainedVariance: number[];
    nComponents: number;
  } | null;
  selectedFeatureIndices: number[] | null;
}

/**
 * Create a pre-configured feature reducer
 */
export function createFeatureReducer(
  type: 'aggressive' | 'moderate' | 'light' | 'none' = 'moderate'
): FeatureReducer {
  switch (type) {
    case 'aggressive':
      return new FeatureReducer({
        method: 'pca',
        targetDimensions: 30,
        varianceThreshold: 0.9,
        warmupSamples: 500,
      });

    case 'moderate':
      return new FeatureReducer({
        method: 'pca',
        targetDimensions: 50,
        varianceThreshold: 0.95,
        warmupSamples: 1000,
      });

    case 'light':
      return new FeatureReducer({
        method: 'selection',
        topKFeatures: 70,
        warmupSamples: 500,
      });

    case 'none':
    default:
      return new FeatureReducer({ method: 'none' });
  }
}
