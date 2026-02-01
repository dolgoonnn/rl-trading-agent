/**
 * ICT Rule Types
 *
 * These types define the structure for user-defined trading rules
 * extracted from ICT YouTube video transcripts.
 */

// ICT Concepts that can be used in conditions
export type ICTConcept =
  | 'market_structure'
  | 'order_block'
  | 'fvg'
  | 'liquidity'
  | 'ote'
  | 'premium_discount'
  | 'bos'
  | 'choch'
  | 'mss'
  | 'breaker'
  | 'mitigation';

// Kill zones for time-based conditions
export type KillZone =
  | 'asian'
  | 'london_open'
  | 'london_close'
  | 'ny_am'
  | 'ny_lunch'
  | 'ny_pm'
  | 'silver_bullet'; // 10-11 AM EST

// Comparison operators
export type Operator =
  | 'equals'
  | 'not_equals'
  | 'greater_than'
  | 'less_than'
  | 'in_range'
  | 'exists'
  | 'not_exists';

// Bias types
export type BiasType = 'bullish' | 'bearish' | 'any';

// Price zone types
export type ZoneType = 'premium' | 'discount' | 'equilibrium' | 'ote';

/**
 * Rule Condition - A single condition that must be met
 */
export interface RuleCondition {
  id: string;
  type: ConditionType;
  params: ConditionParams;
  description: string; // Human-readable description from video
}

export type ConditionType =
  | 'htf_bias'
  | 'price_in_zone'
  | 'concept_present'
  | 'liquidity_swept'
  | 'structure_break'
  | 'time_in_killzone'
  | 'candle_pattern'
  | 'custom';

export type ConditionParams =
  | HTFBiasParams
  | PriceInZoneParams
  | ConceptPresentParams
  | LiquiditySweptParams
  | StructureBreakParams
  | TimeInKillzoneParams
  | CandlePatternParams
  | CustomParams;

export interface HTFBiasParams {
  type: 'htf_bias';
  timeframe: string; // '4h', '1d', etc.
  bias: BiasType;
}

export interface PriceInZoneParams {
  type: 'price_in_zone';
  zone: ZoneType;
  fibLevel?: { start: number; end: number }; // e.g., 0.62 to 0.79 for OTE
}

export interface ConceptPresentParams {
  type: 'concept_present';
  concept: ICTConcept;
  direction?: 'bullish' | 'bearish';
  maxAge?: number; // Max candles old
  unmitigated?: boolean; // For OBs/breakers
}

export interface LiquiditySweptParams {
  type: 'liquidity_swept';
  liquidityType: 'bsl' | 'ssl'; // Buy-side or sell-side
  withinCandles?: number; // How recently
}

export interface StructureBreakParams {
  type: 'structure_break';
  breakType: 'bos' | 'choch' | 'mss';
  direction: 'bullish' | 'bearish';
  timeframe?: string;
}

export interface TimeInKillzoneParams {
  type: 'time_in_killzone';
  killZones: KillZone[];
}

export interface CandlePatternParams {
  type: 'candle_pattern';
  pattern: string; // 'engulfing', 'rejection', etc.
}

export interface CustomParams {
  type: 'custom';
  expression: string; // Free-form description for now
}

/**
 * Entry Rule - Defines how to enter a trade
 */
export interface EntryRule {
  type: EntryType;
  params: EntryParams;
  description: string;
}

export type EntryType =
  | 'market'
  | 'limit_at_ob'
  | 'limit_at_fvg'
  | 'limit_at_fib'
  | 'custom';

export interface EntryParams {
  // For limit orders
  offsetPips?: number; // Offset from zone
  fibLevel?: number; // Specific fib level

  // For zone entries
  zoneEdge?: 'high' | 'low' | 'mid'; // Which edge of OB/FVG
}

/**
 * Exit Rule - Defines stop loss and take profit
 */
export interface ExitRule {
  stopLoss: StopLossRule;
  takeProfit: TakeProfitRule;
}

export interface StopLossRule {
  type: 'swing_based' | 'ob_based' | 'fixed_pips' | 'atr_based' | 'custom';
  params: {
    // For swing-based
    swingOffset?: number; // Pips beyond swing

    // For fixed
    pips?: number;

    // For ATR
    atrMultiplier?: number;

    // Custom description
    description?: string;
  };
}

export interface TakeProfitRule {
  type: 'rr_based' | 'liquidity_target' | 'swing_target' | 'fixed_pips' | 'custom';
  params: {
    // For R:R based
    riskReward?: number; // e.g., 2.0, 3.0

    // For liquidity target
    targetType?: 'bsl' | 'ssl';

    // For fixed
    pips?: number;

    // Custom description
    description?: string;
  };
}

/**
 * Complete ICT Rule - As stored in database
 */
export interface ICTRule {
  id: string;
  name: string;
  description?: string;

  // Source from video
  source?: string;
  sourceUrl?: string;
  sourceTimestamp?: string;

  // Rule logic
  conditions: RuleCondition[];
  entryLogic: EntryRule;
  exitLogic: ExitRule;

  // Categorization
  concepts: ICTConcept[];
  killZones: KillZone[];
  direction: 'long' | 'short' | 'both';

  // Status
  isActive: boolean;
  confidence: 'learning' | 'testing' | 'proven';

  // Stats
  totalTriggers: number;
  approvedTrades: number;
  wins: number;
  losses: number;

  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Trade Suggestion - Generated when rule conditions are met
 */
export interface TradeSuggestion {
  id: string;
  ruleId: string;
  ruleName: string;

  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;

  htfBias?: 'bullish' | 'bearish';
  killZone?: KillZone;
  confluenceScore?: number;
  reasoning: string;

  status: 'pending' | 'approved' | 'rejected' | 'expired';
  outcome?: 'win' | 'loss' | 'breakeven';
  exitPrice?: number;
  pnlR?: number;

  triggeredAt: Date;
  respondedAt?: Date;
  closedAt?: Date;
}

/**
 * Default empty rule for creating new rules
 */
export const createEmptyRule = (): Omit<ICTRule, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  description: '',
  source: '',
  sourceUrl: '',
  sourceTimestamp: '',
  conditions: [],
  entryLogic: {
    type: 'market',
    params: {},
    description: 'Enter at market price',
  },
  exitLogic: {
    stopLoss: {
      type: 'swing_based',
      params: { swingOffset: 5 },
    },
    takeProfit: {
      type: 'rr_based',
      params: { riskReward: 2 },
    },
  },
  concepts: [],
  killZones: [],
  direction: 'both',
  isActive: false,
  confidence: 'learning',
  totalTriggers: 0,
  approvedTrades: 0,
  wins: 0,
  losses: 0,
  notes: '',
});

/**
 * Create a condition with sensible defaults
 */
export const createCondition = (type: ConditionType): RuleCondition => {
  const id = crypto.randomUUID();

  switch (type) {
    case 'htf_bias':
      return {
        id,
        type,
        params: { type: 'htf_bias', timeframe: '4h', bias: 'bullish' },
        description: 'Higher timeframe bias is bullish',
      };
    case 'price_in_zone':
      return {
        id,
        type,
        params: { type: 'price_in_zone', zone: 'discount' },
        description: 'Price is in discount zone',
      };
    case 'concept_present':
      return {
        id,
        type,
        params: { type: 'concept_present', concept: 'fvg', unmitigated: true },
        description: 'Unmitigated FVG present',
      };
    case 'liquidity_swept':
      return {
        id,
        type,
        params: { type: 'liquidity_swept', liquidityType: 'ssl', withinCandles: 10 },
        description: 'Sell-side liquidity swept recently',
      };
    case 'structure_break':
      return {
        id,
        type,
        params: { type: 'structure_break', breakType: 'choch', direction: 'bullish' },
        description: 'Bullish CHoCH occurred',
      };
    case 'time_in_killzone':
      return {
        id,
        type,
        params: { type: 'time_in_killzone', killZones: ['ny_am'] },
        description: 'During NY AM session',
      };
    case 'candle_pattern':
      return {
        id,
        type,
        params: { type: 'candle_pattern', pattern: 'rejection' },
        description: 'Rejection candle pattern',
      };
    default:
      return {
        id,
        type: 'custom',
        params: { type: 'custom', expression: '' },
        description: 'Custom condition',
      };
  }
};
