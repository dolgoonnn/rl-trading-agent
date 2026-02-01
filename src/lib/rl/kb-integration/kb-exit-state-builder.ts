/**
 * KB Exit State Builder
 * Extends ExitStateBuilder with 4 additional KB-derived features
 */

import type { Candle } from '@/types';
import type { ExitState, HybridPosition } from '../types';
import { ExitStateBuilder, type ExitStateBuilderConfig } from '../environment/exit-state-builder';
import { KBConceptMatcher } from './concept-matcher';
import type {
  KBIntegrationConfig,
  KBStateFeatures,
  KBContext,
  MarketQueryContext,
} from './types';
import { DEFAULT_KB_CONFIG } from './types';
import {
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFairValueGaps,
} from '@/lib/ict';

/**
 * Extended exit state including KB features
 */
export interface KBExtendedExitState extends ExitState {
  /** KB-derived features (4 additional) */
  kbFeatures: KBStateFeatures | null;
  /** Full KB context for explainability */
  kbContext: KBContext | null;
}

export interface KBExitStateBuilderConfig extends ExitStateBuilderConfig {
  kbConfig: Partial<KBIntegrationConfig>;
}

// Default config not used directly but kept for reference
// const DEFAULT_KB_STATE_CONFIG: KBExitStateBuilderConfig = {
//   featureNoiseLevel: 0.02,
//   kbConfig: {},
// };

export class KBExitStateBuilder extends ExitStateBuilder {
  private kbConfig: KBIntegrationConfig;
  private conceptMatcher: KBConceptMatcher;
  private initialized: boolean = false;

  // Cache for KB context (one per position entry)
  private cachedKBContext: KBContext | null = null;
  private cachedPositionEntryIndex: number = -1;

  constructor(config: Partial<KBExitStateBuilderConfig> = {}) {
    super(config);
    this.kbConfig = { ...DEFAULT_KB_CONFIG, ...config.kbConfig };
    this.conceptMatcher = new KBConceptMatcher(this.kbConfig);
  }

  /**
   * Initialize the KB concept matcher
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.conceptMatcher.initialize();
    this.initialized = true;
  }

  /**
   * Build exit state with KB features
   * Total: 26 features (22 base + 4 KB)
   */
  override build(
    candles: Candle[],
    currentIndex: number,
    position: HybridPosition,
    training: boolean = false
  ): KBExtendedExitState {
    // Build base state (22 features)
    const baseState = super.build(candles, currentIndex, position, training);

    // Check if KB features are enabled
    if (!this.kbConfig.enabled || !this.kbConfig.addKBFeatures) {
      return {
        ...baseState,
        kbFeatures: null,
        kbContext: null,
      };
    }

    // Get or generate KB context
    const kbContext = this.getKBContext(candles, currentIndex, position);

    // Build KB features
    const kbFeatures = this.buildKBFeatures(kbContext, position);

    // Flatten KB features and append to base features
    const kbFeatureArray = this.flattenKBFeatures(kbFeatures);

    // Apply noise during training
    let allFeatures = [...baseState.features, ...kbFeatureArray];
    if (training && this.kbConfig.addKBFeatures) {
      // Apply same noise level to KB features (base is 22 features)
      const baseFeatureCount = 22;
      allFeatures = allFeatures.map((f, i) => {
        if (i >= baseFeatureCount) {
          // Only add noise to KB features if needed
          const noiseLevel = 0.02; // Match base noise
          const noise = (Math.random() * 2 - 1) * noiseLevel;
          return f * (1 + noise);
        }
        return f;
      });
    }

    return {
      ...baseState,
      features: allFeatures,
      kbFeatures,
      kbContext,
    };
  }

  /**
   * Build synchronous state (uses cached KB context)
   * Use this for high-frequency calls during training
   */
  buildSync(
    candles: Candle[],
    currentIndex: number,
    position: HybridPosition,
    training: boolean = false
  ): KBExtendedExitState {
    // Build base state (18 features)
    const baseState = super.build(candles, currentIndex, position, training);

    // Check if KB features are enabled
    if (!this.kbConfig.enabled || !this.kbConfig.addKBFeatures) {
      return {
        ...baseState,
        kbFeatures: null,
        kbContext: null,
      };
    }

    // Use cached KB context (must be set via setKBContext or refreshKBContext)
    const kbContext = this.cachedKBContext;

    // Build KB features (may be null if no context)
    const kbFeatures = kbContext
      ? this.buildKBFeatures(kbContext, position)
      : this.createDefaultKBFeatures();

    // Flatten KB features
    const kbFeatureArray = this.flattenKBFeatures(kbFeatures);

    return {
      ...baseState,
      features: [...baseState.features, ...kbFeatureArray],
      kbFeatures,
      kbContext,
    };
  }

  /**
   * Get KB context (from cache or generate)
   * KB context is cached per position (refreshed on position entry)
   */
  private getKBContext(
    _candles: Candle[],
    _currentIndex: number,
    position: HybridPosition
  ): KBContext | null {
    // Check if we have cached context for this position
    if (
      this.cachedKBContext &&
      this.cachedPositionEntryIndex === position.entryIndex
    ) {
      return this.cachedKBContext;
    }

    // Need to refresh - but this is sync, so return null
    // The environment should call refreshKBContext() when position opens
    return null;
  }

  /**
   * Refresh KB context for a new position (async)
   * Call this when a position is opened
   */
  async refreshKBContext(
    candles: Candle[],
    currentIndex: number,
    position: HybridPosition
  ): Promise<KBContext> {
    // Build market query context
    const marketContext = this.buildMarketQueryContext(
      candles,
      currentIndex,
      position
    );

    // Query KB for matching concepts
    const kbContext = await this.conceptMatcher.matchConcepts(marketContext);

    // Cache for this position
    this.cachedKBContext = kbContext;
    this.cachedPositionEntryIndex = position.entryIndex;

    return kbContext;
  }

  /**
   * Set KB context directly (for testing or manual control)
   */
  setKBContext(context: KBContext | null, positionEntryIndex: number): void {
    this.cachedKBContext = context;
    this.cachedPositionEntryIndex = positionEntryIndex;
  }

  /**
   * Clear cached KB context
   */
  clearKBContext(): void {
    this.cachedKBContext = null;
    this.cachedPositionEntryIndex = -1;
  }

  /**
   * Build market query context from current state
   */
  private buildMarketQueryContext(
    candles: Candle[],
    currentIndex: number,
    position: HybridPosition
  ): MarketQueryContext {
    const lookbackCandles = candles.slice(
      Math.max(0, currentIndex - 60),
      currentIndex + 1
    );
    const currentPrice = candles[currentIndex]?.close ?? 0;

    // Analyze market structure
    const structure = analyzeMarketStructure(lookbackCandles);
    const orderBlocks = detectOrderBlocks(lookbackCandles);
    const fvgs = detectFairValueGaps(lookbackCandles);

    // Build nearby structures list
    const nearbyStructures: string[] = [];

    // Check for nearby OBs
    for (const ob of orderBlocks.slice(-3)) {
      if (ob.status === 'unmitigated') {
        const distance = Math.abs(
          ((ob.high + ob.low) / 2 - currentPrice) / currentPrice
        );
        if (distance < 0.02) {
          nearbyStructures.push(`${ob.type} order block`);
        }
      }
    }

    // Check for nearby FVGs
    for (const fvg of fvgs.slice(-3)) {
      if (fvg.status !== 'filled') {
        const distance = Math.abs(
          ((fvg.high + fvg.low) / 2 - currentPrice) / currentPrice
        );
        if (distance < 0.02) {
          nearbyStructures.push(`${fvg.type} fair value gap`);
        }
      }
    }

    // Price action description
    const priceAction = this.describePriceAction(lookbackCandles);

    // Calculate PnL
    const pnlPercent =
      position.side === 'long'
        ? (currentPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - currentPrice) / position.entryPrice;

    // Session detection
    const currentTimestamp = candles[currentIndex]?.timestamp ?? 0;
    const session = this.detectSession(currentTimestamp);

    return {
      positionSide: position.side,
      bias: structure.bias,
      priceAction,
      nearbyStructures,
      session,
      pnlPercent,
      barsHeld: position.barsHeld,
    };
  }

  /**
   * Describe recent price action
   */
  private describePriceAction(candles: Candle[]): string {
    if (candles.length < 5) return '';

    const recent = candles.slice(-5);
    const closes = recent.map((c) => c.close);
    const first = closes[0] ?? 0;
    const last = closes[closes.length - 1] ?? 0;

    if (first === 0) return '';

    const change = (last - first) / first;

    if (change > 0.01) return 'strong bullish momentum';
    if (change > 0.003) return 'bullish price action';
    if (change < -0.01) return 'strong bearish momentum';
    if (change < -0.003) return 'bearish price action';
    return 'consolidation';
  }

  /**
   * Detect current trading session
   */
  private detectSession(timestamp: number): string | undefined {
    const date = new Date(timestamp);
    const hour = date.getUTCHours();

    if (hour >= 7 && hour < 11) return 'london';
    if (hour >= 13 && hour < 17) return 'new york';
    if (hour >= 0 && hour < 4) return 'asian';
    return undefined;
  }

  /**
   * Build KB state features from context
   */
  private buildKBFeatures(
    kbContext: KBContext | null,
    _position: HybridPosition
  ): KBStateFeatures {
    if (!kbContext || kbContext.matches.length === 0) {
      return this.createDefaultKBFeatures();
    }

    // Primary concept similarity (highest match)
    const primaryConceptSimilarity = kbContext.matches[0]?.similarity ?? 0;

    // Concept confidence (weighted by match count and similarities)
    const totalSimilarity = kbContext.matches.reduce(
      (sum, m) => sum + m.similarity,
      0
    );
    const avgSimilarity =
      kbContext.matches.length > 0
        ? totalSimilarity / kbContext.matches.length
        : 0;
    const matchCountFactor = Math.min(kbContext.matches.length / 3, 1); // Saturates at 3 matches
    const conceptConfidenceScore = avgSimilarity * matchCountFactor;

    // Rule alignment score (already calculated in context)
    const ruleAlignmentScore = kbContext.alignmentScore;

    // Setup familiarity (based on rule count and concept variety)
    const uniqueConcepts = new Set(
      kbContext.matches.map((m) => m.concept).filter(Boolean)
    );
    const totalRules =
      kbContext.alignedRules.length + kbContext.conflictingRules.length;
    const setupFamiliarityScore = Math.min(
      (uniqueConcepts.size * 0.3 + totalRules * 0.1) / 2,
      1
    );

    return {
      primaryConceptSimilarity,
      conceptConfidenceScore,
      ruleAlignmentScore,
      setupFamiliarityScore,
    };
  }

  /**
   * Create default KB features (no KB data available)
   */
  private createDefaultKBFeatures(): KBStateFeatures {
    return {
      primaryConceptSimilarity: 0,
      conceptConfidenceScore: 0,
      ruleAlignmentScore: 0,
      setupFamiliarityScore: 0,
    };
  }

  /**
   * Flatten KB features to array
   */
  private flattenKBFeatures(features: KBStateFeatures): number[] {
    return [
      features.primaryConceptSimilarity,
      features.conceptConfidenceScore,
      features.ruleAlignmentScore,
      features.setupFamiliarityScore,
    ];
  }

  /**
   * Get feature vector size
   * Returns 26 when KB features enabled (22 base + 4 KB), 22 otherwise
   */
  override getFeatureSize(): number {
    if (this.kbConfig.enabled && this.kbConfig.addKBFeatures) {
      return 22 + this.kbConfig.kbFeatureCount;
    }
    return 22;
  }

  /**
   * Get KB feature count
   */
  getKBFeatureCount(): number {
    return this.kbConfig.kbFeatureCount;
  }

  /**
   * Check if KB features are enabled
   */
  isKBEnabled(): boolean {
    return this.kbConfig.enabled && this.kbConfig.addKBFeatures;
  }

  /**
   * Get concept matcher (for direct access if needed)
   */
  getConceptMatcher(): KBConceptMatcher {
    return this.conceptMatcher;
  }

  /**
   * Update KB configuration
   */
  updateKBConfig(config: Partial<KBIntegrationConfig>): void {
    this.kbConfig = { ...this.kbConfig, ...config };
    this.conceptMatcher.updateConfig(this.kbConfig);
  }

  /**
   * Get current KB configuration
   */
  getKBConfig(): KBIntegrationConfig {
    return { ...this.kbConfig };
  }
}
