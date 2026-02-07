/**
 * Data Augmentation for Reinforcement Learning (DARL)
 *
 * Based on: "Using Data Augmentation Based Reinforcement Learning for Daily Stock Trading" (MDPI 2020)
 * https://www.mdpi.com/2079-9292/9/9/1384
 *
 * Key insight: Train on minute-level data to get 60x more training instances,
 * while making trading decisions at hourly level. This dramatically reduces overfitting.
 *
 * Augmentation strategies:
 * 1. Time-scale augmentation: Aggregate minute data to various timeframes
 * 2. Noise injection: Add realistic market noise to candles
 * 3. Temporal jittering: Shift windows to create different perspectives
 * 4. Synthetic pattern generation: Create variations of existing patterns
 */

import type { Candle } from '@/types';

export interface AugmentationConfig {
  // Time-scale augmentation
  enableMultiTimeframe: boolean;
  timeframes: number[]; // In minutes: [1, 5, 15, 60]

  // Noise injection
  enableNoise: boolean;
  noiseLevel: number; // 0.001 = 0.1% typical noise
  volumeNoiseLevel: number; // 0.1 = 10% volume noise

  // Temporal jittering
  enableJittering: boolean;
  jitterWindow: number; // Number of candles to shift

  // Synthetic pattern generation
  enableSynthetic: boolean;
  syntheticMultiplier: number; // How many synthetic versions per real pattern
}

const DEFAULT_CONFIG: AugmentationConfig = {
  enableMultiTimeframe: true,
  timeframes: [1, 5, 15, 60], // Minute, 5min, 15min, hourly

  enableNoise: true,
  noiseLevel: 0.0005, // 0.05% price noise
  volumeNoiseLevel: 0.1, // 10% volume noise

  enableJittering: true,
  jitterWindow: 5, // Shift up to 5 candles

  enableSynthetic: true,
  syntheticMultiplier: 2, // 2 synthetic versions per pattern
};

export class DataAugmentor {
  private config: AugmentationConfig;

  constructor(config: Partial<AugmentationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Augment minute-level data into multiple training datasets
   * Returns an array of hourly-aggregated datasets with variations
   */
  augmentMinuteData(minuteCandles: Candle[]): Candle[][] {
    const datasets: Candle[][] = [];

    // 1. Base hourly aggregation (no augmentation)
    const hourlyBase = this.aggregateToHourly(minuteCandles);
    datasets.push(hourlyBase);

    // 2. Multi-timeframe aggregations (different perspectives)
    if (this.config.enableMultiTimeframe) {
      // Create hourly from 5-minute intermediate
      const fiveMinute = this.aggregateCandles(minuteCandles, 5);
      const hourlyFrom5m = this.aggregateCandles(fiveMinute, 12);
      if (hourlyFrom5m.length > 0) datasets.push(hourlyFrom5m);

      // Create hourly from 15-minute intermediate
      const fifteenMinute = this.aggregateCandles(minuteCandles, 15);
      const hourlyFrom15m = this.aggregateCandles(fifteenMinute, 4);
      if (hourlyFrom15m.length > 0) datasets.push(hourlyFrom15m);
    }

    // 3. Temporal jittering (shift the aggregation window)
    if (this.config.enableJittering) {
      for (let offset = 1; offset <= this.config.jitterWindow; offset++) {
        const jitteredMinutes = minuteCandles.slice(offset);
        const jitteredHourly = this.aggregateToHourly(jitteredMinutes);
        if (jitteredHourly.length > 0) datasets.push(jitteredHourly);
      }
    }

    // 4. Noise injection variants
    if (this.config.enableNoise) {
      const noisyMinutes = this.addNoise(minuteCandles);
      const noisyHourly = this.aggregateToHourly(noisyMinutes);
      if (noisyHourly.length > 0) datasets.push(noisyHourly);

      // Second noise variant with different seed
      const noisyMinutes2 = this.addNoise(minuteCandles, 2);
      const noisyHourly2 = this.aggregateToHourly(noisyMinutes2);
      if (noisyHourly2.length > 0) datasets.push(noisyHourly2);
    }

    // 5. Synthetic pattern variations
    if (this.config.enableSynthetic) {
      for (let i = 0; i < this.config.syntheticMultiplier; i++) {
        const synthetic = this.generateSyntheticVariation(hourlyBase, i);
        if (synthetic.length > 0) datasets.push(synthetic);
      }
    }

    return datasets;
  }

  /**
   * Augment existing hourly data without minute data
   * Less effective but still useful for forex/commodities
   */
  augmentHourlyData(hourlyCandles: Candle[]): Candle[][] {
    const datasets: Candle[][] = [];

    // Base data
    datasets.push(hourlyCandles);

    // Noise variants
    if (this.config.enableNoise) {
      for (let i = 0; i < 3; i++) {
        const noisy = this.addNoise(hourlyCandles, i);
        datasets.push(noisy);
      }
    }

    // Synthetic variants
    if (this.config.enableSynthetic) {
      for (let i = 0; i < this.config.syntheticMultiplier; i++) {
        const synthetic = this.generateSyntheticVariation(hourlyCandles, i);
        datasets.push(synthetic);
      }
    }

    // Temporal scaling (stretch/compress returns slightly)
    const stretched = this.scaleReturns(hourlyCandles, 1.05);
    const compressed = this.scaleReturns(hourlyCandles, 0.95);
    datasets.push(stretched, compressed);

    return datasets;
  }

  /**
   * Aggregate candles to a higher timeframe
   */
  aggregateCandles(candles: Candle[], periodMinutes: number): Candle[] {
    if (candles.length === 0) return [];

    const msPerPeriod = periodMinutes * 60 * 1000;
    const aggregated: Candle[] = [];
    let bucket: Candle[] = [];
    let bucketStart = Math.floor(candles[0]!.timestamp / msPerPeriod) * msPerPeriod;

    for (const candle of candles) {
      const candleBucket = Math.floor(candle.timestamp / msPerPeriod) * msPerPeriod;

      if (candleBucket !== bucketStart && bucket.length > 0) {
        aggregated.push(this.mergeCandleBucket(bucket, bucketStart));
        bucket = [];
        bucketStart = candleBucket;
      }

      bucket.push(candle);
    }

    // Last bucket
    if (bucket.length > 0) {
      aggregated.push(this.mergeCandleBucket(bucket, bucketStart));
    }

    return aggregated;
  }

  /**
   * Aggregate minute candles to hourly
   */
  private aggregateToHourly(minuteCandles: Candle[]): Candle[] {
    return this.aggregateCandles(minuteCandles, 60);
  }

  /**
   * Merge a bucket of candles into a single candle
   */
  private mergeCandleBucket(bucket: Candle[], timestamp: number): Candle {
    return {
      timestamp,
      open: bucket[0]!.open,
      high: Math.max(...bucket.map((c) => c.high)),
      low: Math.min(...bucket.map((c) => c.low)),
      close: bucket[bucket.length - 1]!.close,
      volume: bucket.reduce((sum, c) => sum + c.volume, 0),
    };
  }

  /**
   * Add realistic market noise to candles
   * Uses log-normal noise for prices (multiplicative)
   */
  private addNoise(candles: Candle[], seed: number = 0): Candle[] {
    const rng = this.seededRandom(seed);

    return candles.map((c) => {
      // Price noise (multiplicative, log-normal)
      const priceNoise = 1 + this.gaussianNoise(rng) * this.config.noiseLevel;

      // Volume noise (also multiplicative)
      const volumeNoise = 1 + this.gaussianNoise(rng) * this.config.volumeNoiseLevel;

      // Apply noise while maintaining OHLC relationships
      const open = c.open * priceNoise;
      const close = c.close * priceNoise;
      const range = c.high - c.low;
      const noisyRange = range * (1 + Math.abs(this.gaussianNoise(rng)) * this.config.noiseLevel);
      const midpoint = (c.high + c.low) / 2 * priceNoise;

      return {
        timestamp: c.timestamp,
        open,
        high: midpoint + noisyRange / 2,
        low: midpoint - noisyRange / 2,
        close,
        volume: Math.max(0, c.volume * volumeNoise),
      };
    });
  }

  /**
   * Generate a synthetic variation of the data
   * Preserves market structure but creates slightly different paths
   */
  private generateSyntheticVariation(candles: Candle[], variant: number): Candle[] {
    if (candles.length < 2) return candles;

    const rng = this.seededRandom(variant * 12345);
    const result: Candle[] = [];

    // Calculate returns and volatility
    const returns = candles.slice(1).map((c, i) => (c.close - candles[i]!.close) / candles[i]!.close);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const volatility = Math.sqrt(
      returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length
    );

    // Start with first candle
    result.push({ ...candles[0]! });

    // Generate synthetic path with similar statistical properties
    for (let i = 1; i < candles.length; i++) {
      const originalReturn = returns[i - 1]!;

      // Add small random perturbation while preserving direction
      const perturbation = this.gaussianNoise(rng) * volatility * 0.3;
      const syntheticReturn = originalReturn + perturbation;

      const prevCandle = result[i - 1]!;
      const syntheticClose = prevCandle.close * (1 + syntheticReturn);

      // Reconstruct OHLC maintaining rough proportions
      const original = candles[i]!;
      const originalRange = original.high - original.low;
      const originalMid = (original.high + original.low) / 2;
      const scaleFactor = syntheticClose / original.close;

      const syntheticMid = originalMid * scaleFactor;
      const syntheticRange = originalRange * scaleFactor * (1 + this.gaussianNoise(rng) * 0.1);

      result.push({
        timestamp: original.timestamp,
        open: prevCandle.close, // Gaps are rare in synthetic data
        high: syntheticMid + syntheticRange / 2,
        low: syntheticMid - syntheticRange / 2,
        close: syntheticClose,
        volume: original.volume * (1 + this.gaussianNoise(rng) * 0.2),
      });
    }

    return result;
  }

  /**
   * Scale returns while maintaining price continuity
   * Useful for volatility regime testing
   */
  private scaleReturns(candles: Candle[], scale: number): Candle[] {
    if (candles.length < 2) return candles;

    const result: Candle[] = [{ ...candles[0]! }];

    for (let i = 1; i < candles.length; i++) {
      const original = candles[i]!;
      const prevOriginal = candles[i - 1]!;
      const prevResult = result[i - 1]!;

      // Scale the return
      const originalReturn = (original.close - prevOriginal.close) / prevOriginal.close;
      const scaledReturn = originalReturn * scale;
      const newClose = prevResult.close * (1 + scaledReturn);

      // Scale the range proportionally
      const scaleFactor = newClose / original.close;

      result.push({
        timestamp: original.timestamp,
        open: prevResult.close,
        high: newClose + (original.high - original.close) * scaleFactor * scale,
        low: newClose + (original.low - original.close) * scaleFactor * scale,
        close: newClose,
        volume: original.volume,
      });
    }

    return result;
  }

  /**
   * Seeded random number generator for reproducibility
   */
  private seededRandom(seed: number): () => number {
    let state = seed || 1;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }

  /**
   * Generate Gaussian noise using Box-Muller transform
   */
  private gaussianNoise(rng: () => number): number {
    const u1 = rng();
    const u2 = rng();
    const mag = Math.sqrt(-2 * Math.log(u1 + 1e-10));
    return mag * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Get statistics about augmentation
   */
  getAugmentationStats(
    originalCount: number,
    augmentedDatasets: Candle[][]
  ): AugmentationStats {
    const totalAugmented = augmentedDatasets.reduce((sum, ds) => sum + ds.length, 0);

    return {
      originalCount,
      datasetsCreated: augmentedDatasets.length,
      totalAugmentedCandles: totalAugmented,
      augmentationFactor: totalAugmented / originalCount,
      avgDatasetSize: Math.round(totalAugmented / augmentedDatasets.length),
    };
  }
}

export interface AugmentationStats {
  originalCount: number;
  datasetsCreated: number;
  totalAugmentedCandles: number;
  augmentationFactor: number;
  avgDatasetSize: number;
}

/**
 * Combine multiple augmented datasets into a single training dataset
 * with proper episode boundaries
 */
export function combineAugmentedDatasets(
  datasets: Candle[][],
  shuffle: boolean = true
): { candles: Candle[]; episodeBoundaries: number[] } {
  // Track where each dataset ends (episode boundaries)
  const episodeBoundaries: number[] = [];
  let totalCandles = 0;

  for (const dataset of datasets) {
    totalCandles += dataset.length;
    episodeBoundaries.push(totalCandles);
  }

  // Optionally shuffle dataset order (not candle order within datasets)
  let orderedDatasets = datasets;
  if (shuffle) {
    orderedDatasets = [...datasets].sort(() => Math.random() - 0.5);
  }

  // Concatenate all candles
  const candles: Candle[] = [];
  for (const dataset of orderedDatasets) {
    candles.push(...dataset);
  }

  return { candles, episodeBoundaries };
}

/**
 * Create a rolling sample from augmented data
 * Useful for curriculum learning (start with easier patterns)
 */
export function createCurriculumSamples(
  datasets: Candle[][],
  windowSize: number = 500,
  stepSize: number = 100
): Candle[][] {
  const samples: Candle[][] = [];

  for (const dataset of datasets) {
    for (let start = 0; start + windowSize <= dataset.length; start += stepSize) {
      samples.push(dataset.slice(start, start + windowSize));
    }
  }

  return samples;
}
