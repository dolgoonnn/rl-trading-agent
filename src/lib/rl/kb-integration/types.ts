/**
 * KB-RL Integration Types
 * Types for bridging the knowledge base with the RL exit agent
 */

import type { KnowledgeChunk } from '@/lib/kb/types';

/**
 * Configuration for KB integration with RL agent
 */
export interface KBIntegrationConfig {
  /** Master switch for KB integration */
  enabled: boolean;

  // Feature integration
  /** Add KB features to agent state (4 additional features) */
  addKBFeatures: boolean;
  /** Number of KB features added to state (default: 4) */
  kbFeatureCount: number;

  // Reward shaping
  /** Enable reward bonuses based on KB alignment */
  useKBRewardShaping: boolean;
  /** Maximum bonus/penalty as fraction of base reward (default: 0.2 = 20%) */
  maxKBRewardBonus: number;
  /** Bonus per aligned KB rule (default: 0.03 = 3%) */
  ruleAlignmentBonus: number;
  /** Penalty per conflicting KB rule (default: 0.02 = 2%) */
  ruleConflictPenalty: number;
  /** Bonus threshold for high concept similarity (default: 0.7) */
  highSimilarityThreshold: number;
  /** Bonus for high similarity match (default: 0.05 = 5%) */
  highSimilarityBonus: number;

  // Search parameters
  /** Number of top matches to retrieve (default: 3) */
  topK: number;
  /** Minimum similarity threshold for matches (default: 0.4) */
  minSimilarity: number;

  // Performance / caching
  /** LRU cache size for concept queries (default: 500) */
  cacheSize: number;
  /** Pre-compute embeddings for common ICT patterns on init */
  warmCacheOnInit: boolean;
  /** Cache TTL in milliseconds (default: 300000 = 5 minutes) */
  cacheTTL: number;
}

/**
 * Default configuration for KB integration
 */
export const DEFAULT_KB_CONFIG: KBIntegrationConfig = {
  enabled: false,

  // Features
  addKBFeatures: true,
  kbFeatureCount: 4,

  // Reward shaping
  useKBRewardShaping: true,
  maxKBRewardBonus: 0.2,
  ruleAlignmentBonus: 0.03,
  ruleConflictPenalty: 0.02,
  highSimilarityThreshold: 0.7,
  highSimilarityBonus: 0.05,

  // Search
  topK: 3,
  minSimilarity: 0.4,

  // Caching
  cacheSize: 500,
  warmCacheOnInit: false,
  cacheTTL: 300000,
};

/**
 * A single concept match from the knowledge base
 */
export interface KBConceptMatch {
  /** The matched knowledge chunk */
  chunk: KnowledgeChunk;
  /** Similarity score (0-1) */
  similarity: number;
  /** ICT concept name if identified */
  concept?: string;
  /** Extracted trading rules from this chunk */
  rules: KBTradingRule[];
}

/**
 * A trading rule extracted from KB content
 */
export interface KBTradingRule {
  /** Rule text/description */
  text: string;
  /** Direction the rule supports */
  direction: 'long' | 'short' | 'neutral';
  /** Confidence in rule extraction (0-1) */
  confidence: number;
  /** Action the rule suggests */
  suggestedAction?: 'hold' | 'exit' | 'tighten_stop' | 'take_partial';
  /** Source concept for attribution */
  sourceConcept?: string;
}

/**
 * Context from KB for current market situation
 */
export interface KBContext {
  /** Top matching concepts */
  matches: KBConceptMatch[];
  /** Overall alignment score (-1 to 1, positive = KB supports position) */
  alignmentScore: number;
  /** Rules that align with current position */
  alignedRules: KBTradingRule[];
  /** Rules that conflict with current position */
  conflictingRules: KBTradingRule[];
  /** Primary concept for this situation */
  primaryConcept?: string;
  /** Human-readable summary of KB reasoning */
  explanation: string;
  /** Query that was used */
  query: string;
  /** Whether result came from cache */
  fromCache: boolean;
  /** Timestamp when context was generated */
  timestamp: number;
}

/**
 * KB-derived features for agent state (4 features)
 */
export interface KBStateFeatures {
  /** Highest similarity from KB matches (0-1) */
  primaryConceptSimilarity: number;
  /** Confidence score weighted by match count (0-1) */
  conceptConfidenceScore: number;
  /** Do KB rules support the position? (-1 to 1) */
  ruleAlignmentScore: number;
  /** Has KB seen similar setups before? (0-1) */
  setupFamiliarityScore: number;
}

/**
 * Extended exit state with KB features
 */
export interface KBExitState {
  /** Base features (18) + KB features (4) = 22 total */
  features: number[];
  /** The KB context used to generate these features */
  kbContext: KBContext | null;
  /** Just the KB-derived features */
  kbFeatures: KBStateFeatures | null;
}

/**
 * Market context for generating KB queries
 */
export interface MarketQueryContext {
  /** Current position side */
  positionSide: 'long' | 'short';
  /** Market structure bias */
  bias: 'bullish' | 'bearish' | 'neutral';
  /** Recent price action description */
  priceAction: string;
  /** Nearby ICT concepts (OB, FVG, etc.) */
  nearbyStructures: string[];
  /** Current session/kill zone */
  session?: string;
  /** Unrealized PnL percentage */
  pnlPercent: number;
  /** Bars in position */
  barsHeld: number;
}

/**
 * Result from reward shaping calculation
 */
export interface KBRewardResult {
  /** Total KB-based bonus/penalty */
  bonus: number;
  /** Breakdown of bonus components */
  components: {
    /** Bonus from high concept similarity */
    similarityBonus: number;
    /** Bonus from aligned rules */
    alignedRulesBonus: number;
    /** Penalty from conflicting rules */
    conflictingRulesPenalty: number;
  };
  /** KB context that informed this calculation */
  context: KBContext | null;
}

/**
 * Decision explanation with KB context
 */
export interface KBDecisionExplanation {
  /** The action taken */
  action: 'hold' | 'exit_market' | 'tighten_stop' | 'take_partial';
  /** Primary KB concept influencing decision */
  primaryConcept?: string;
  /** Key supporting concepts */
  supportingConcepts: string[];
  /** Rules that support this action */
  supportingRules: string[];
  /** Rules that suggest a different action */
  conflictingRules: string[];
  /** Confidence in KB-based reasoning (0-1) */
  confidence: number;
  /** Natural language explanation */
  explanation: string;
}

/**
 * Cache entry for concept queries
 */
export interface CacheEntry<T> {
  /** Cached value */
  value: T;
  /** Timestamp when cached */
  cachedAt: number;
  /** Number of times accessed */
  accessCount: number;
}

/**
 * LRU Cache statistics
 */
export interface CacheStats {
  /** Total cache hits */
  hits: number;
  /** Total cache misses */
  misses: number;
  /** Current cache size */
  size: number;
  /** Maximum cache capacity */
  capacity: number;
  /** Hit rate percentage */
  hitRate: number;
}
