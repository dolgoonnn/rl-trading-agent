/**
 * ICT (Inner Circle Trader) concept types
 */

import type { Candle } from './candle';

// Market Structure
export type Bias = 'bullish' | 'bearish' | 'neutral';
export type StructureType = 'bos' | 'choch' | 'mss';

export interface SwingPoint {
  index: number;
  price: number;
  timestamp: number;
  type: 'high' | 'low';
  strength: number; // How many candles on each side confirm this swing
}

export interface StructureBreak {
  type: StructureType;
  direction: 'bullish' | 'bearish';
  brokenSwing: SwingPoint;
  breakCandle: Candle;
  breakIndex: number;
  timestamp: number;
  confidence: number; // 0-1 quality score based on swing strength, break distance, close confirmation
}

export interface MarketStructure {
  bias: Bias;
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
  structureBreaks: StructureBreak[];
  lastHH?: SwingPoint;
  lastHL?: SwingPoint;
  lastLH?: SwingPoint;
  lastLL?: SwingPoint;
}

// Order Blocks
export type OrderBlockType = 'bullish' | 'bearish';
export type OrderBlockStatus = 'unmitigated' | 'mitigated' | 'broken';

export interface OrderBlock {
  type: OrderBlockType;
  status: OrderBlockStatus;
  high: number;
  low: number;
  openPrice: number;
  closePrice: number;
  index: number;
  timestamp: number;
  strength: number; // Based on move after OB
  mitigationIndex?: number;
}

// Fair Value Gaps (Imbalances)
export type FVGType = 'bullish' | 'bearish';
export type FVGStatus = 'unfilled' | 'partially_filled' | 'filled';

export interface FairValueGap {
  type: FVGType;
  status: FVGStatus;
  high: number;
  low: number;
  size: number; // In price
  sizePercent: number; // As % of price
  index: number;
  timestamp: number;
  fillPercent: number;
  /** Consequent Encroachment - 50% midpoint of FVG (proper ICT entry level) */
  consequentEncroachment: number;
  /** Whether FVG formed from displacement (strong impulsive move) - required for valid FVG */
  displacement: boolean;
}

// Liquidity
export type LiquidityType = 'bsl' | 'ssl'; // Buy-side / Sell-side
export type LiquidityStatus = 'active' | 'swept';

export interface LiquidityLevel {
  type: LiquidityType;
  price: number;
  strength: number; // Number of touches/equal highs/lows
  index: number;
  timestamp: number;
  status: LiquidityStatus;
  sweepIndex?: number;
  sweepTimestamp?: number;
}

export interface LiquiditySweep {
  level: LiquidityLevel;
  sweepCandle: Candle;
  sweepIndex: number;
  timestamp: number;
  priceExceeded: number; // How far past the level
}

// Breaker Blocks
export type BreakerType = 'bullish' | 'bearish';
export type BreakerStatus = 'active' | 'tested' | 'broken';

export interface BreakerBlock {
  type: BreakerType;
  status: BreakerStatus;
  /** Original order block that was broken */
  originalOB: OrderBlock;
  /** High of the breaker zone */
  high: number;
  /** Low of the breaker zone */
  low: number;
  /** Index where the OB was broken */
  breakIndex: number;
  /** Timestamp of break */
  breakTimestamp: number;
  /** How far price exceeded the OB (as % of price) */
  breakExceedance: number;
  /** Number of times breaker has been tested */
  testCount: number;
  /** Index of first test (if tested) */
  firstTestIndex?: number;
  /** Strength based on original OB and break characteristics */
  strength: number;
}

// Premium/Discount & OTE
export interface FibonacciZone {
  swingHigh: SwingPoint;
  swingLow: SwingPoint;
  equilibrium: number; // 50% level
  premiumStart: number; // Above 50%
  discountStart: number; // Below 50%
  oteStart: number; // 62% for longs, 38% for shorts
  oteEnd: number; // 79% for longs, 21% for shorts
  levels: Map<number, number>; // Fib level -> price
}

export interface OTEZone {
  type: 'bullish' | 'bearish';
  high: number;
  low: number;
  fibStart: number; // 0.62 or 0.21
  fibEnd: number; // 0.79 or 0.38
}

// Sessions & Kill Zones
export type SessionName = 'asian' | 'london' | 'newyork' | 'london_close';

export interface Session {
  name: SessionName;
  startHour: number; // UTC
  endHour: number; // UTC
  isKillZone: boolean;
}

export interface KillZone {
  session: SessionName;
  startTime: Date;
  endTime: Date;
  high?: number;
  low?: number;
}

// Setups
export interface ICTSetup {
  id: string;
  symbol: string;
  timeframe: string;
  timestamp: number;
  bias: Bias;
  direction: 'long' | 'short';

  // Components present
  hasLiquiditySweep: boolean;
  hasChoch: boolean;
  hasOrderBlock: boolean;
  hasFVG: boolean;
  inOTE: boolean;
  inKillZone: boolean;

  // Entry details
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;

  // References
  orderBlock?: OrderBlock;
  fvg?: FairValueGap;
  liquiditySweep?: LiquiditySweep;
  structureBreak?: StructureBreak;

  // Scoring
  confluenceCount: number;
  score: number; // 0-100
}

// Alert types
export type AlertType =
  | 'bos'
  | 'choch'
  | 'mss'
  | 'liquidity_sweep'
  | 'order_block_formed'
  | 'order_block_mitigated'
  | 'fvg_formed'
  | 'fvg_filled'
  | 'full_setup'
  | 'kill_zone_start'
  | 'kill_zone_end';

export interface Alert {
  type: AlertType;
  symbol: string;
  timeframe: string;
  timestamp: number;
  message: string;
  setup?: ICTSetup;
  importance: 'low' | 'medium' | 'high';
}
