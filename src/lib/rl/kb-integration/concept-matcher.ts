/**
 * KB Concept Matcher
 * Matches market situations to KB concepts with caching
 */

import type {
  KBIntegrationConfig,
  KBConceptMatch,
  KBContext,
  KBTradingRule,
  MarketQueryContext,
  CacheEntry,
  CacheStats,
} from './types';
import { DEFAULT_KB_CONFIG } from './types';
import { semanticSearch, type SearchResult } from '@/lib/kb/search/semantic';
import type { KnowledgeChunk } from '@/lib/kb/types';

/**
 * LRU Cache implementation for concept queries
 */
class LRUCache<K, V> {
  private cache: Map<K, CacheEntry<V>>;
  private capacity: number;
  private ttl: number;
  private hits: number = 0;
  private misses: number = 0;

  constructor(capacity: number, ttl: number) {
    this.cache = new Map();
    this.capacity = capacity;
    this.ttl = ttl;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL
    if (Date.now() - entry.cachedAt > this.ttl) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // Update access count and move to end (most recently used)
    entry.accessCount++;
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: K, value: V): void {
    // Remove oldest if at capacity
    if (this.cache.size >= this.capacity) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(key, {
      value,
      cachedAt: Date.now(),
      accessCount: 1,
    });
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      capacity: this.capacity,
      hitRate: total > 0 ? (this.hits / total) * 100 : 0,
    };
  }
}

/**
 * Pattern for extracting trading rules from KB content
 */
interface RulePattern {
  pattern: RegExp;
  direction: 'long' | 'short' | 'neutral';
  action?: 'hold' | 'exit' | 'tighten_stop' | 'take_partial';
}

const RULE_PATTERNS: RulePattern[] = [
  // Exit rules
  { pattern: /exit\s+(?:at|near|on)\s+(?:the\s+)?(?:first|initial)\s+(?:target|tp|take\s*profit)/i, direction: 'neutral', action: 'take_partial' },
  { pattern: /(?:trail|move)\s+(?:your\s+)?stop\s+to\s+(?:breakeven|entry)/i, direction: 'neutral', action: 'tighten_stop' },
  { pattern: /close\s+(?:the\s+)?(?:position|trade)\s+(?:when|if|at)/i, direction: 'neutral', action: 'exit' },
  { pattern: /(?:take|book)\s+(?:profits?|partial)/i, direction: 'neutral', action: 'take_partial' },

  // Hold rules
  { pattern: /(?:hold|wait|be\s+patient)\s+(?:until|for|while)/i, direction: 'neutral', action: 'hold' },
  { pattern: /let\s+(?:the\s+)?(?:trade|position|winner)\s+run/i, direction: 'neutral', action: 'hold' },
  { pattern: /don't\s+(?:exit|close)\s+(?:prematurely|too\s+early)/i, direction: 'neutral', action: 'hold' },

  // Bullish context
  { pattern: /bullish\s+(?:order\s+block|ob|fvg|structure)/i, direction: 'long' },
  { pattern: /(?:support|demand)\s+(?:zone|area|level)/i, direction: 'long' },
  { pattern: /higher\s+(?:highs?|lows?)/i, direction: 'long' },
  { pattern: /buy\s*(?:side)?\s*liquidity/i, direction: 'long' },

  // Bearish context
  { pattern: /bearish\s+(?:order\s+block|ob|fvg|structure)/i, direction: 'short' },
  { pattern: /(?:resistance|supply)\s+(?:zone|area|level)/i, direction: 'short' },
  { pattern: /lower\s+(?:highs?|lows?)/i, direction: 'short' },
  { pattern: /sell\s*(?:side)?\s*liquidity/i, direction: 'short' },
];

export class KBConceptMatcher {
  private config: KBIntegrationConfig;
  private cache: LRUCache<string, KBContext>;
  private initialized: boolean = false;

  constructor(config: Partial<KBIntegrationConfig> = {}) {
    this.config = { ...DEFAULT_KB_CONFIG, ...config };
    this.cache = new LRUCache(this.config.cacheSize, this.config.cacheTTL);
  }

  /**
   * Initialize matcher (optionally warm cache with common patterns)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.config.warmCacheOnInit) {
      await this.warmCache();
    }

    this.initialized = true;
  }

  /**
   * Pre-warm cache with common ICT patterns
   */
  private async warmCache(): Promise<void> {
    const commonQueries = [
      'order block entry long bullish',
      'order block entry short bearish',
      'fair value gap bullish support',
      'fair value gap bearish resistance',
      'break of structure bullish continuation',
      'break of structure bearish continuation',
      'change of character reversal',
      'liquidity sweep entry',
      'kill zone london session',
      'kill zone new york session',
    ];

    for (const query of commonQueries) {
      try {
        await this.queryKnowledgeBase(query);
      } catch {
        // Ignore warm-up failures
      }
    }
  }

  /**
   * Build a query string from market context
   */
  buildMarketQuery(context: MarketQueryContext): string {
    const parts: string[] = [];

    // Position context
    parts.push(context.positionSide);
    parts.push('position');

    // Market bias
    if (context.bias !== 'neutral') {
      parts.push(context.bias);
      parts.push('market');
    }

    // Price action
    if (context.priceAction) {
      parts.push(context.priceAction);
    }

    // Nearby structures
    for (const structure of context.nearbyStructures.slice(0, 2)) {
      parts.push(structure);
    }

    // PnL context
    if (context.pnlPercent > 0.02) {
      parts.push('in profit');
      parts.push('exit timing');
    } else if (context.pnlPercent < -0.01) {
      parts.push('drawdown');
      parts.push('risk management');
    }

    // Time in trade
    if (context.barsHeld > 20) {
      parts.push('extended hold');
    }

    // Session
    if (context.session) {
      parts.push(context.session);
      parts.push('kill zone');
    }

    return parts.join(' ');
  }

  /**
   * Match market situation to KB concepts
   */
  async matchConcepts(context: MarketQueryContext): Promise<KBContext> {
    const query = this.buildMarketQuery(context);

    // Check cache first
    const cached = this.cache.get(query);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    // Query KB
    const kbContext = await this.queryKnowledgeBase(query);
    kbContext.query = query;

    // Calculate alignment with position
    const alignment = this.calculateAlignment(kbContext.matches, context.positionSide);
    kbContext.alignmentScore = alignment.score;
    kbContext.alignedRules = alignment.alignedRules;
    kbContext.conflictingRules = alignment.conflictingRules;
    kbContext.explanation = this.generateExplanation(kbContext, context);

    // Cache result
    this.cache.set(query, kbContext);

    return kbContext;
  }

  /**
   * Query knowledge base for relevant concepts
   */
  private async queryKnowledgeBase(query: string): Promise<KBContext> {
    let searchResults: SearchResult[] = [];

    try {
      searchResults = await semanticSearch(query, {
        topK: this.config.topK,
        minSimilarity: this.config.minSimilarity,
      });
    } catch {
      // KB search failed - return empty context
      return this.createEmptyContext(query);
    }

    if (searchResults.length === 0) {
      return this.createEmptyContext(query);
    }

    // Convert to KBConceptMatch format
    const matches: KBConceptMatch[] = searchResults.map((result) => ({
      chunk: result.chunk,
      similarity: result.similarity,
      concept: result.chunk.concept,
      rules: this.extractRules(result.chunk),
    }));

    // Find primary concept
    const primaryConcept = matches[0]?.concept;

    return {
      matches,
      alignmentScore: 0, // Will be calculated later
      alignedRules: [],
      conflictingRules: [],
      primaryConcept,
      explanation: '',
      query,
      fromCache: false,
      timestamp: Date.now(),
    };
  }

  /**
   * Extract trading rules from KB content
   */
  extractRules(chunk: KnowledgeChunk): KBTradingRule[] {
    const rules: KBTradingRule[] = [];
    const content = chunk.content.toLowerCase();

    // Split into sentences
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 10);

    for (const sentence of sentences) {
      for (const pattern of RULE_PATTERNS) {
        if (pattern.pattern.test(sentence)) {
          rules.push({
            text: sentence.trim(),
            direction: pattern.direction,
            confidence: 0.7, // Base confidence for pattern match
            suggestedAction: pattern.action,
            sourceConcept: chunk.concept,
          });
          break; // Only match first pattern per sentence
        }
      }
    }

    return rules;
  }

  /**
   * Calculate alignment score between KB concepts and position
   */
  private calculateAlignment(
    matches: KBConceptMatch[],
    positionSide: 'long' | 'short'
  ): {
    score: number;
    alignedRules: KBTradingRule[];
    conflictingRules: KBTradingRule[];
  } {
    const alignedRules: KBTradingRule[] = [];
    const conflictingRules: KBTradingRule[] = [];

    for (const match of matches) {
      for (const rule of match.rules) {
        if (rule.direction === 'neutral') {
          alignedRules.push(rule);
        } else if (rule.direction === positionSide) {
          alignedRules.push(rule);
        } else {
          conflictingRules.push(rule);
        }
      }
    }

    // Calculate alignment score
    const totalRules = alignedRules.length + conflictingRules.length;
    if (totalRules === 0) {
      return { score: 0, alignedRules, conflictingRules };
    }

    // Weighted by confidence
    const alignedWeight = alignedRules.reduce((sum, r) => sum + r.confidence, 0);
    const conflictWeight = conflictingRules.reduce((sum, r) => sum + r.confidence, 0);
    const totalWeight = alignedWeight + conflictWeight;

    const score = totalWeight > 0
      ? (alignedWeight - conflictWeight) / totalWeight
      : 0;

    return {
      score: Math.max(-1, Math.min(1, score)),
      alignedRules,
      conflictingRules,
    };
  }

  /**
   * Generate human-readable explanation
   */
  private generateExplanation(kbContext: KBContext, marketContext: MarketQueryContext): string {
    const parts: string[] = [];

    if (kbContext.primaryConcept) {
      parts.push(`Primary concept: ${kbContext.primaryConcept}.`);
    }

    const topMatch = kbContext.matches[0];
    if (topMatch) {
      parts.push(`Best match similarity: ${(topMatch.similarity * 100).toFixed(0)}%.`);
    }

    if (kbContext.alignedRules.length > 0) {
      parts.push(`${kbContext.alignedRules.length} supporting rule(s) found.`);
    }

    if (kbContext.conflictingRules.length > 0) {
      parts.push(`${kbContext.conflictingRules.length} conflicting rule(s) found.`);
    }

    if (kbContext.alignmentScore > 0.3) {
      parts.push(`KB supports ${marketContext.positionSide} position.`);
    } else if (kbContext.alignmentScore < -0.3) {
      parts.push(`KB suggests caution for ${marketContext.positionSide} position.`);
    }

    return parts.join(' ');
  }

  /**
   * Create empty context when no matches found
   */
  private createEmptyContext(query: string): KBContext {
    return {
      matches: [],
      alignmentScore: 0,
      alignedRules: [],
      conflictingRules: [],
      explanation: 'No relevant KB concepts found for current market situation.',
      query,
      fromCache: false,
      timestamp: Date.now(),
    };
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): CacheStats {
    return this.cache.getStats();
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<KBIntegrationConfig>): void {
    this.config = { ...this.config, ...config };

    // Recreate cache if size changed
    if (config.cacheSize !== undefined || config.cacheTTL !== undefined) {
      this.cache = new LRUCache(this.config.cacheSize, this.config.cacheTTL);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): KBIntegrationConfig {
    return { ...this.config };
  }
}
