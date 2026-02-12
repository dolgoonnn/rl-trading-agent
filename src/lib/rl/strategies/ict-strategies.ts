/**
 * ICT Strategy Definitions
 *
 * Defines ICT-based trading strategies that the meta-strategy agent can select.
 * Each strategy uses the existing ICT detection modules (order-blocks, fair-value-gaps, market-structure).
 *
 * Strategy Types:
 * - OrderBlockStrategy: Entry at unmitigated OBs
 * - FVGStrategy: Entry into unfilled FVGs
 * - BOSContinuationStrategy: Trade with Break of Structure
 * - CHoCHReversalStrategy: Trade Change of Character reversals
 * - WaitStrategy: No trade, wait for better setup
 */

import {
  bodySize,
  range as candleRange,
  type Candle,
  type OrderBlock,
  type FairValueGap,
  type StructureBreak,
  type MarketStructure,
} from '@/types';
import type { HybridPosition } from '../types';
import {
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFairValueGaps,
  checkKillZone,
  shouldTradeByTime,
  detectLiquidityLevels,
  detectLiquiditySweeps,
  type KillZoneConfig,
  type KillZoneInfo,
} from '@/lib/ict';
import { DEFAULT_OB_CONFIG, type OrderBlockConfig } from '@/lib/ict/order-blocks';
import { type FVGConfig } from '@/lib/ict/fair-value-gaps';
import type { LiquidityLevel, LiquiditySweep } from '@/types';

// ============================================
// Strategy Types
// ============================================

/** Strategy selection actions for meta-agent */
export type StrategyAction = 0 | 1 | 2 | 3 | 4;
export const StrategyActions = {
  WAIT: 0 as StrategyAction,           // No trade, wait for setup
  ORDER_BLOCK: 1 as StrategyAction,    // Trade into Order Block
  FVG: 2 as StrategyAction,            // Trade into Fair Value Gap
  BOS_CONTINUATION: 3 as StrategyAction, // Trade with BOS
  CHOCH_REVERSAL: 4 as StrategyAction,  // Trade CHoCH reversal
} as const;

export const STRATEGY_COUNT = 5;

export type StrategyName = 'wait' | 'order_block' | 'fvg' | 'bos_continuation' | 'choch_reversal';

export function strategyActionToName(action: StrategyAction): StrategyName {
  switch (action) {
    case StrategyActions.WAIT: return 'wait';
    case StrategyActions.ORDER_BLOCK: return 'order_block';
    case StrategyActions.FVG: return 'fvg';
    case StrategyActions.BOS_CONTINUATION: return 'bos_continuation';
    case StrategyActions.CHOCH_REVERSAL: return 'choch_reversal';
    default: return 'wait';
  }
}

/** Entry signal from a strategy */
export interface StrategySignal {
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  confidence: number; // 0-1
  strategy: StrategyName;
  reasoning: string[];
  // References for KB matching
  orderBlock?: OrderBlock;
  fvg?: FairValueGap;
  structureBreak?: StructureBreak;
}

/** Exit signal from a strategy */
export interface StrategyExitSignal {
  shouldExit: boolean;
  reason?: string;
  confidence: number;
}

/** ICT context for strategy evaluation */
export interface ICTStrategyContext {
  structure: MarketStructure;
  orderBlocks: OrderBlock[];
  fvgs: FairValueGap[];
  currentPrice: number;
  atr: number;
  timestamp: number;
  killZone?: KillZoneInfo;
  liquidityLevels?: LiquidityLevel[];
  recentSweeps?: LiquiditySweep[];
  /** Volatility scale factor: ATR% / reference ATR% (~1.0 for crypto, ~0.1 for forex) */
  volatilityScale: number;
}

// ============================================
// Base Strategy Interface
// ============================================

export interface ICTStrategy {
  name: StrategyName;

  /**
   * Detect entry opportunity
   * @returns Signal if entry conditions met, null otherwise
   */
  detectEntry(
    candles: Candle[],
    currentIndex: number,
    ictContext: ICTStrategyContext
  ): StrategySignal | null;

  /**
   * Check if position should be exited
   */
  detectExit(
    position: HybridPosition,
    candles: Candle[],
    currentIndex: number,
    ictContext: ICTStrategyContext
  ): StrategyExitSignal;

  /**
   * Get strategy-specific features for state representation
   */
  getFeatures(
    candles: Candle[],
    currentIndex: number,
    ictContext: ICTStrategyContext
  ): number[];
}

// ============================================
// Strategy Configuration
// ============================================

/**
 * SL placement mode determines how stop loss and take profit are calculated:
 * - ob_based: SL at OB boundary ± ATR×multiple, TP at entry ± ATR×tpMultiple (current default)
 * - entry_based: SL at entry ± ATR×slMultiple, TP at entry ± ATR×tpMultiple (true geometric R:R)
 * - dynamic_rr: SL at OB boundary ± ATR×multiple, TP = entry + targetRR × risk (exact R:R from OB SL)
 */
export type SLPlacementMode = 'ob_based' | 'entry_based' | 'dynamic_rr';

export interface StrategyConfig {
  /** Minimum confluence factors for entry (default: 2) */
  minConfluence: number;
  /** Maximum age of OB/FVG in bars (default: 75) */
  maxStructureAge: number;
  /** Risk:Reward minimum (default: 1.2) */
  minRiskReward: number;
  /** ATR multiple for stop loss (default: 1.5) */
  stopLossATRMultiple: number;
  /** ATR multiple for take profit (default: 3.0) */
  takeProfitATRMultiple: number;
  /** Proximity to structure for entry (default: 0.005 = 0.5%) */
  proximityPercent: number;
  /** Enable kill zone filter (default: true) */
  useKillZoneFilter: boolean;
  /** Kill zone configuration */
  killZoneConfig: Partial<KillZoneConfig>;
  /** Require liquidity sweep for FVG/OB entries (default: false) */
  requireLiquiditySweep: boolean;
  /** Bonus confidence when liquidity sweep is present (default: 0.15) */
  liquiditySweepBonus: number;
  /** Require reaction confirmation at OB zone before entering (default: true) */
  requireReactionConfirmation: boolean;
  /** Minimum candle body as fraction of range for reaction conviction (default: 0.4) */
  minReactionBodyPercent: number;
  /** SL/TP placement mode (default: 'ob_based') */
  slPlacementMode: SLPlacementMode;
}

// ============================================
// Entry Configuration (Tunable Thresholds)
// ============================================

/**
 * Configurable entry thresholds based on proper ICT methodology.
 *
 * ICT Methodology Changes:
 * - Replaced arbitrary pullback percentages with OTE (Optimal Trade Entry) Fibonacci zone
 * - OTE Zone is 62%-79% retracement with optimal at 70.5%
 * - FVG entries should be at CE (Consequent Encroachment) - 50% midpoint
 */
export const ENTRY_CONFIG = {
  // BOS Continuation thresholds - TIGHTENED for quality
  bosWindowBars: 40,        // BOS context valid for 40 bars (was 50 loosened, 20 too tight, 30 still kills BOS)
  bosMinConfidence: 0.50,   // Require body-close confirmed BOS (was 0.25)

  // OTE Zone (Fibonacci-based) - PROPER ICT METHODOLOGY
  // "The OTE is the zone between 0.62 and 0.79 Fibonacci retracement"
  oteMin: 0.50,             // 50% retracement minimum (discount territory)
  oteMax: 0.79,             // 79% max (proper OTE boundary)
  oteOptimal: 0.705,        // 70.5% optimal entry
  oteBonus: 0.62,           // 62%+ is true OTE zone

  // FVG Entry Configuration
  fvgRequireDisplacement: true,  // Now hard-filtered at detection level (fair-value-gaps.ts)
  fvgDisplacementBonus: 0.15,    // Bonus for displacement (in strategy confidence)
  fvgCeTolerance: 0.0015,        // 0.15% tolerance around CE level (tightened from 0.3%)

  // No fallback pullback zone - require proper OTE or FVG entry
  pullbackMin: 0.001,
  pullbackMax: 0.10,             // Reduced from 25% - only tight pullbacks as fallback
} as const;

const DEFAULT_CONFIG: StrategyConfig = {
  minConfluence: 2,         // Require 2+ confluence factors (restored from 1)
  maxStructureAge: 75,      // OBs/FVGs older than 75 bars are stale (restored from 100)
  minRiskReward: 1.5,       // Minimum 1.5 R:R (restored from 1.0)
  stopLossATRMultiple: 2.0, // Wider stops reduce premature SL hits (was 1.0)
  takeProfitATRMultiple: 4.0, // Higher TP for 2:1 R:R with wider stops (was 2.0)
  proximityPercent: 0.005,  // Tighter OB touch zone (restored from 0.01)
  useKillZoneFilter: false, // Scored by confluence, not hard filtered
  killZoneConfig: {
    primaryOnly: false,
    includeAsian: true,
    minSessionQuality: 0.3,
  },
  requireLiquiditySweep: false, // Don't require, but use as bonus
  liquiditySweepBonus: 0.15,    // Bonus for sweep confirmation
  requireReactionConfirmation: true,  // Require candle close beyond OB + body conviction
  minReactionBodyPercent: 0.4,        // 40% body-to-range ratio for conviction
  slPlacementMode: 'ob_based',       // Default: SL at OB boundary (backward compatible)
};

/**
 * Check if trade should be taken based on kill zone timing
 * Returns null if trade is allowed, or a reason string if blocked
 */
function checkKillZoneFilter(
  ctx: ICTStrategyContext,
  config: StrategyConfig
): string | null {
  if (!config.useKillZoneFilter) return null;

  const result = shouldTradeByTime(ctx.timestamp, config.killZoneConfig);
  if (!result.shouldTrade) {
    return result.reason;
  }
  return null;
}

// ============================================
// SL/TP Placement Helpers
// ============================================

function calculateLongSLTP(
  entryPrice: number,
  obBoundary: number,
  atr: number,
  slMultiple: number,
  tpMultiple: number,
  mode: SLPlacementMode,
): { stopLoss: number; takeProfit: number } {
  switch (mode) {
    case 'entry_based':
      return {
        stopLoss: entryPrice - atr * slMultiple,
        takeProfit: entryPrice + atr * tpMultiple,
      };
    case 'dynamic_rr': {
      const stopLoss = obBoundary - atr * slMultiple;
      const risk = entryPrice - stopLoss;
      const targetRR = tpMultiple / slMultiple;
      return { stopLoss, takeProfit: entryPrice + risk * targetRR };
    }
    case 'ob_based':
    default:
      return {
        stopLoss: obBoundary - atr * slMultiple,
        takeProfit: entryPrice + atr * tpMultiple,
      };
  }
}

function calculateShortSLTP(
  entryPrice: number,
  obBoundary: number,
  atr: number,
  slMultiple: number,
  tpMultiple: number,
  mode: SLPlacementMode,
): { stopLoss: number; takeProfit: number } {
  switch (mode) {
    case 'entry_based':
      return {
        stopLoss: entryPrice + atr * slMultiple,
        takeProfit: entryPrice - atr * tpMultiple,
      };
    case 'dynamic_rr': {
      const stopLoss = obBoundary + atr * slMultiple;
      const risk = stopLoss - entryPrice;
      const targetRR = tpMultiple / slMultiple;
      return { stopLoss, takeProfit: entryPrice - risk * targetRR };
    }
    case 'ob_based':
    default:
      return {
        stopLoss: obBoundary + atr * slMultiple,
        takeProfit: entryPrice - atr * tpMultiple,
      };
  }
}

// ============================================
// Order Block Strategy
// ============================================

export class OrderBlockStrategy implements ICTStrategy {
  readonly name: StrategyName = 'order_block';
  private config: StrategyConfig;

  constructor(config: Partial<StrategyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  detectEntry(
    candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): StrategySignal | null {
    const current = candles[currentIndex];
    if (!current) return null;

    // Kill zone filter - skip trades outside high-probability sessions
    const kzBlock = checkKillZoneFilter(ctx, this.config);
    if (kzBlock) return null;

    // Find unmitigated OBs within age limit
    const validOBs = ctx.orderBlocks.filter((ob) =>
      ob.status === 'unmitigated' &&
      currentIndex - ob.index <= this.config.maxStructureAge
    );

    // Check each OB for touch
    for (const ob of validOBs) {
      const signal = this.checkOBEntry(ob, current, ctx);
      if (signal) {
        // Add kill zone info to reasoning
        if (ctx.killZone?.inKillZone) {
          signal.reasoning.push(`${ctx.killZone.name} session active`);
        }
        return signal;
      }
    }

    return null;
  }

  private checkOBEntry(
    ob: OrderBlock,
    candle: Candle,
    ctx: ICTStrategyContext
  ): StrategySignal | null {
    const proximity = this.config.proximityPercent;
    const reasoning: string[] = [];

    // Check for recent liquidity sweep confirmation
    const hasLongSweep = ctx.recentSweeps?.some(s => s.level.type === 'ssl') ?? false;
    const hasShortSweep = ctx.recentSweeps?.some(s => s.level.type === 'bsl') ?? false;

    if (ob.type === 'bullish') {
      // For bullish OB, check if price wicked down into it
      const touchZoneTop = ob.high * (1 + proximity);
      const touchZoneBottom = ob.low * (1 - proximity);

      if (candle.low <= touchZoneTop && candle.low >= touchZoneBottom) {
        reasoning.push('Price touched bullish OB');

        // Reaction confirmation: candle must close above OB midpoint with body conviction
        if (this.config.requireReactionConfirmation) {
          const obMid = (ob.low + ob.high) / 2;
          if (candle.close <= obMid) {
            return null; // No bullish reaction — price didn't close above OB midpoint
          }
          const cr = candleRange(candle);
          if (cr > 0 && bodySize(candle) / cr < this.config.minReactionBodyPercent) {
            return null; // Weak body — no conviction
          }
          reasoning.push('Reaction confirmed (close above OB mid, body conviction)');
        }

        // Check liquidity sweep requirement
        if (this.config.requireLiquiditySweep && !hasLongSweep) {
          return null;
        }

        // Check trend alignment
        if (ctx.structure.bias !== 'bearish') {
          reasoning.push('Trend alignment confirmed');

          // Calculate SL/TP based on placement mode
          const { stopLoss, takeProfit } = calculateLongSLTP(
            candle.close, ob.low, ctx.atr,
            this.config.stopLossATRMultiple, this.config.takeProfitATRMultiple,
            this.config.slPlacementMode,
          );
          const riskReward = (takeProfit - candle.close) / (candle.close - stopLoss);

          if (riskReward >= this.config.minRiskReward) {
            reasoning.push(`R:R ${riskReward.toFixed(2)} meets minimum (${this.config.slPlacementMode})`);

            // Calculate confidence with liquidity sweep bonus
            let confidence = 0.5 + ob.strength / 200;
            if (hasLongSweep) {
              confidence += this.config.liquiditySweepBonus;
              reasoning.push('SSL swept - liquidity taken');
            }

            return {
              direction: 'long',
              entryPrice: candle.close,
              stopLoss,
              takeProfit,
              riskReward,
              confidence: Math.min(0.9, confidence),
              strategy: this.name,
              reasoning,
              orderBlock: ob,
            };
          }
        }
      }
    } else {
      // For bearish OB, check if price wicked up into it
      const touchZoneTop = ob.high * (1 + proximity);
      const touchZoneBottom = ob.low * (1 - proximity);

      if (candle.high >= touchZoneBottom && candle.high <= touchZoneTop) {
        reasoning.push('Price touched bearish OB');

        // Reaction confirmation: candle must close below OB midpoint with body conviction
        if (this.config.requireReactionConfirmation) {
          const obMid = (ob.low + ob.high) / 2;
          if (candle.close >= obMid) {
            return null; // No bearish reaction — price didn't close below OB midpoint
          }
          const cr = candleRange(candle);
          if (cr > 0 && bodySize(candle) / cr < this.config.minReactionBodyPercent) {
            return null; // Weak body — no conviction
          }
          reasoning.push('Reaction confirmed (close below OB mid, body conviction)');
        }

        // Check liquidity sweep requirement
        if (this.config.requireLiquiditySweep && !hasShortSweep) {
          return null;
        }

        if (ctx.structure.bias !== 'bullish') {
          reasoning.push('Trend alignment confirmed');

          // Calculate SL/TP based on placement mode
          const { stopLoss, takeProfit } = calculateShortSLTP(
            candle.close, ob.high, ctx.atr,
            this.config.stopLossATRMultiple, this.config.takeProfitATRMultiple,
            this.config.slPlacementMode,
          );
          const riskReward = (candle.close - takeProfit) / (stopLoss - candle.close);

          if (riskReward >= this.config.minRiskReward) {
            reasoning.push(`R:R ${riskReward.toFixed(2)} meets minimum (${this.config.slPlacementMode})`);

            // Calculate confidence with liquidity sweep bonus
            let confidence = 0.5 + ob.strength / 200;
            if (hasShortSweep) {
              confidence += this.config.liquiditySweepBonus;
              reasoning.push('BSL swept - liquidity taken');
            }

            return {
              direction: 'short',
              entryPrice: candle.close,
              stopLoss,
              takeProfit,
              riskReward,
              confidence: Math.min(0.9, confidence),
              strategy: this.name,
              reasoning,
              orderBlock: ob,
            };
          }
        }
      }
    }

    return null;
  }

  detectExit(
    position: HybridPosition,
    candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): StrategyExitSignal {
    const current = candles[currentIndex];
    if (!current) return { shouldExit: false, confidence: 0 };

    // Exit if opposite OB forms
    const oppositeOBs = ctx.orderBlocks.filter((ob) => {
      if (position.side === 'long') return ob.type === 'bearish';
      return ob.type === 'bullish';
    });

    // Check for fresh opposite OB
    for (const ob of oppositeOBs) {
      if (currentIndex - ob.index <= 5 && ob.status === 'unmitigated') {
        return {
          shouldExit: true,
          reason: `Fresh ${ob.type} OB formed - potential reversal`,
          confidence: 0.7,
        };
      }
    }

    // Exit if structure changes against position
    const recentBreaks = ctx.structure.structureBreaks.filter(
      (b) => currentIndex - b.breakIndex <= 5
    );

    for (const sb of recentBreaks) {
      if (sb.type === 'choch') {
        if (position.side === 'long' && sb.direction === 'bearish') {
          return {
            shouldExit: true,
            reason: 'Bearish CHoCH - structure reversal',
            confidence: 0.8,
          };
        }
        if (position.side === 'short' && sb.direction === 'bullish') {
          return {
            shouldExit: true,
            reason: 'Bullish CHoCH - structure reversal',
            confidence: 0.8,
          };
        }
      }
    }

    return { shouldExit: false, confidence: 0 };
  }

  getFeatures(
    _candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): number[] {
    // 4 features for OB strategy
    const bullishOBs = ctx.orderBlocks.filter(
      (ob) => ob.type === 'bullish' && ob.status === 'unmitigated'
    );
    const bearishOBs = ctx.orderBlocks.filter(
      (ob) => ob.type === 'bearish' && ob.status === 'unmitigated'
    );

    // Distance to nearest bullish/bearish OB (normalized)
    const nearestBullish = bullishOBs.reduce((min, ob) => {
      const dist = Math.abs(ctx.currentPrice - ob.high) / ctx.currentPrice;
      return dist < min ? dist : min;
    }, 1);

    const nearestBearish = bearishOBs.reduce((min, ob) => {
      const dist = Math.abs(ctx.currentPrice - ob.low) / ctx.currentPrice;
      return dist < min ? dist : min;
    }, 1);

    // Freshness of nearest OB (normalized)
    const freshestBullish = bullishOBs.reduce((min, ob) => {
      return (currentIndex - ob.index) < min ? (currentIndex - ob.index) : min;
    }, 100) / 100;

    const freshestBearish = bearishOBs.reduce((min, ob) => {
      return (currentIndex - ob.index) < min ? (currentIndex - ob.index) : min;
    }, 100) / 100;

    return [
      Math.max(0, 1 - nearestBullish * 10), // 0-1, closer = higher
      Math.max(0, 1 - nearestBearish * 10),
      1 - freshestBullish, // 0-1, fresher = higher
      1 - freshestBearish,
    ];
  }
}

// ============================================
// FVG Strategy
// ============================================

/**
 * FVG Strategy using proper ICT methodology:
 * - Entry at Consequent Encroachment (CE) - 50% midpoint of FVG
 * - Only trade FVGs formed from displacement (strong impulsive move)
 * - "CE is respected far more often than the entire FVG" - TheSimpleICT
 */
export class FVGStrategy implements ICTStrategy {
  readonly name: StrategyName = 'fvg';
  private config: StrategyConfig;

  constructor(config: Partial<StrategyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  detectEntry(
    candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): StrategySignal | null {
    const current = candles[currentIndex];
    if (!current) return null;

    // Kill zone filter - skip trades outside high-probability sessions
    const kzBlock = checkKillZoneFilter(ctx, this.config);
    if (kzBlock) return null;

    // Find unfilled FVGs within age limit (use 30 bars, tighter than general maxStructureAge)
    const fvgMaxAge = Math.min(30, this.config.maxStructureAge);
    const validFVGs = ctx.fvgs.filter((fvg) =>
      fvg.status !== 'filled' &&
      currentIndex - fvg.index <= fvgMaxAge
    );

    // Structure alignment: require recent BOS in FVG direction
    // FVGs formed in ranging/choppy structure are low quality
    const hasBullishBOS = ctx.structure.structureBreaks.some(
      (sb) => sb.type === 'bos' && sb.direction === 'bullish' && currentIndex - sb.breakIndex <= 40,
    );
    const hasBearishBOS = ctx.structure.structureBreaks.some(
      (sb) => sb.type === 'bos' && sb.direction === 'bearish' && currentIndex - sb.breakIndex <= 40,
    );

    for (const fvg of validFVGs) {
      // Skip FVGs without structure alignment
      if (fvg.type === 'bullish' && !hasBullishBOS) continue;
      if (fvg.type === 'bearish' && !hasBearishBOS) continue;

      const signal = this.checkFVGEntry(fvg, current, ctx);
      if (signal) {
        // Add kill zone info to reasoning
        if (ctx.killZone?.inKillZone) {
          signal.reasoning.push(`${ctx.killZone.name} session active`);
        }
        signal.reasoning.push('Structure-aligned (recent BOS in direction)');
        return signal;
      }
    }

    return null;
  }

  private checkFVGEntry(
    fvg: FairValueGap,
    candle: Candle,
    ctx: ICTStrategyContext
  ): StrategySignal | null {
    const reasoning: string[] = [];

    // FVG quality filter: require meaningful size (>0.3% of price)
    const minFVGSize = 0.003; // 0.3% minimum for meaningful gap
    if (fvg.sizePercent < minFVGSize) {
      return null;
    }

    // FVG-specific R:R requirement - USE CONFIG VALUE (no longer hardcoded 2.5)
    const fvgMinRR = this.config.minRiskReward;

    // Get Consequent Encroachment (CE) - 50% midpoint
    const ce = fvg.consequentEncroachment;
    const ceTolerance = ENTRY_CONFIG.fvgCeTolerance;

    // Check for recent liquidity sweep confirmation
    const hasLongSweep = ctx.recentSweeps?.some(s => s.level.type === 'ssl') ?? false;
    const hasShortSweep = ctx.recentSweeps?.some(s => s.level.type === 'bsl') ?? false;

    if (fvg.type === 'bullish') {
      // ICT: Entry at CE (Consequent Encroachment) - 50% midpoint of FVG
      // Price must reach the CE level and then close above it (bullish reaction)
      const touchedCE = candle.low <= ce * (1 + ceTolerance);
      const closedAboveCE = candle.close > ce;

      if (touchedCE && closedAboveCE) {
        reasoning.push('Price touched CE (50% of bullish FVG)');
        reasoning.push(`CE level: ${ce.toFixed(2)}`);

        if (fvg.displacement) {
          reasoning.push('FVG formed from displacement (higher quality)');
        }

        // Check liquidity sweep requirement/bonus
        if (this.config.requireLiquiditySweep && !hasLongSweep) {
          return null; // Skip if sweep required but not present
        }

        // Bias filter: require bullish or neutral bias (allow neutral for more trades)
        if (ctx.structure.bias !== 'bearish') {
          reasoning.push(ctx.structure.bias === 'bullish' ? 'Trend supports long' : 'Neutral trend');

          // Stop below FVG low, take profit using ATR multiple
          const stopLoss = fvg.low - ctx.atr * 0.5;
          const takeProfit = candle.close + ctx.atr * this.config.takeProfitATRMultiple;
          const riskReward = (takeProfit - candle.close) / (candle.close - stopLoss);

          if (riskReward >= fvgMinRR) {
            // Higher confidence for displacement FVGs and bullish bias
            let confidence = 0.45;
            if (fvg.displacement) confidence += ENTRY_CONFIG.fvgDisplacementBonus;
            if (ctx.structure.bias === 'bullish') confidence += 0.1;
            confidence += fvg.sizePercent * 5; // Size bonus

            // Liquidity sweep bonus
            if (hasLongSweep) {
              confidence += this.config.liquiditySweepBonus;
              reasoning.push('SSL swept - liquidity taken');
            }

            return {
              direction: 'long',
              entryPrice: candle.close,
              stopLoss,
              takeProfit,
              riskReward,
              confidence: Math.min(0.9, confidence),
              strategy: this.name,
              reasoning,
              fvg,
            };
          }
        }
      }
    } else {
      // ICT: Entry at CE for bearish FVG
      // Price must reach CE level and then close below it (bearish reaction)
      const touchedCE = candle.high >= ce * (1 - ceTolerance);
      const closedBelowCE = candle.close < ce;

      if (touchedCE && closedBelowCE) {
        reasoning.push('Price touched CE (50% of bearish FVG)');
        reasoning.push(`CE level: ${ce.toFixed(2)}`);

        if (fvg.displacement) {
          reasoning.push('FVG formed from displacement (higher quality)');
        }

        // Check liquidity sweep requirement/bonus
        if (this.config.requireLiquiditySweep && !hasShortSweep) {
          return null; // Skip if sweep required but not present
        }

        // Bias filter: require bearish or neutral bias
        if (ctx.structure.bias !== 'bullish') {
          reasoning.push(ctx.structure.bias === 'bearish' ? 'Trend supports short' : 'Neutral trend');

          const stopLoss = fvg.high + ctx.atr * 0.5;
          const takeProfit = candle.close - ctx.atr * this.config.takeProfitATRMultiple;
          const riskReward = (candle.close - takeProfit) / (stopLoss - candle.close);

          if (riskReward >= fvgMinRR) {
            let confidence = 0.45;
            if (fvg.displacement) confidence += ENTRY_CONFIG.fvgDisplacementBonus;
            if (ctx.structure.bias === 'bearish') confidence += 0.1;
            confidence += fvg.sizePercent * 5;

            // Liquidity sweep bonus
            if (hasShortSweep) {
              confidence += this.config.liquiditySweepBonus;
              reasoning.push('BSL swept - liquidity taken');
            }

            return {
              direction: 'short',
              entryPrice: candle.close,
              stopLoss,
              takeProfit,
              riskReward,
              confidence: Math.min(0.9, confidence),
              strategy: this.name,
              reasoning,
              fvg,
            };
          }
        }
      }
    }

    return null;
  }

  detectExit(
    position: HybridPosition,
    candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): StrategyExitSignal {
    const current = candles[currentIndex];
    if (!current) return { shouldExit: false, confidence: 0 };

    // Exit if opposite FVG is being respected
    const oppositeFVGs = ctx.fvgs.filter((fvg) => {
      if (position.side === 'long') return fvg.type === 'bearish';
      return fvg.type === 'bullish';
    });

    for (const fvg of oppositeFVGs) {
      // Price entered opposite FVG
      if (position.side === 'long' && current.high >= fvg.low && current.high <= fvg.high) {
        return {
          shouldExit: true,
          reason: 'Price hit bearish FVG - resistance',
          confidence: 0.65,
        };
      }
      if (position.side === 'short' && current.low <= fvg.high && current.low >= fvg.low) {
        return {
          shouldExit: true,
          reason: 'Price hit bullish FVG - support',
          confidence: 0.65,
        };
      }
    }

    return { shouldExit: false, confidence: 0 };
  }

  getFeatures(
    _candles: Candle[],
    _currentIndex: number,
    ctx: ICTStrategyContext
  ): number[] {
    const bullishFVGs = ctx.fvgs.filter((f) => f.type === 'bullish' && f.status !== 'filled');
    const bearishFVGs = ctx.fvgs.filter((f) => f.type === 'bearish' && f.status !== 'filled');

    // Distance to nearest FVG
    const nearestBullish = bullishFVGs.reduce((min, fvg) => {
      const dist = Math.abs(ctx.currentPrice - fvg.high) / ctx.currentPrice;
      return dist < min ? dist : min;
    }, 1);

    const nearestBearish = bearishFVGs.reduce((min, fvg) => {
      const dist = Math.abs(ctx.currentPrice - fvg.low) / ctx.currentPrice;
      return dist < min ? dist : min;
    }, 1);

    // FVG size (larger = more significant)
    const avgBullishSize = bullishFVGs.length > 0
      ? bullishFVGs.reduce((sum, f) => sum + f.sizePercent, 0) / bullishFVGs.length
      : 0;

    const avgBearishSize = bearishFVGs.length > 0
      ? bearishFVGs.reduce((sum, f) => sum + f.sizePercent, 0) / bearishFVGs.length
      : 0;

    return [
      Math.max(0, 1 - nearestBullish * 10),
      Math.max(0, 1 - nearestBearish * 10),
      Math.min(1, avgBullishSize * 5), // Normalize size
      Math.min(1, avgBearishSize * 5),
    ];
  }
}

// ============================================
// BOS Continuation Strategy
// ============================================

/**
 * BOS Continuation Strategy using proper ICT methodology:
 * - Entry in OTE (Optimal Trade Entry) Zone: 62%-79% Fibonacci retracement
 * - Optimal entry at 70.5% level
 * - "The OTE is the zone between 0.62 and 0.79 Fibonacci retracement" - TradingFinder
 */
export class BOSContinuationStrategy implements ICTStrategy {
  readonly name: StrategyName = 'bos_continuation';
  private config: StrategyConfig;

  constructor(config: Partial<StrategyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  detectEntry(
    candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): StrategySignal | null {
    const current = candles[currentIndex];
    if (!current) return null;

    // Kill zone filter - skip trades outside high-probability sessions
    const kzBlock = checkKillZoneFilter(ctx, this.config);
    if (kzBlock) return null;

    // Look for recent BOS (body close required now, so higher quality)
    const recentBOS = ctx.structure.structureBreaks.filter(
      (sb) => sb.type === 'bos' &&
        currentIndex - sb.breakIndex <= ENTRY_CONFIG.bosWindowBars &&
        sb.confidence >= ENTRY_CONFIG.bosMinConfidence
    );

    if (recentBOS.length === 0) return null;

    // Get the most recent BOS
    const bos = recentBOS[recentBOS.length - 1]!;
    const reasoning: string[] = [`Recent ${bos.direction} BOS (body close confirmed)`];

    // Add kill zone info to reasoning
    if (ctx.killZone?.inKillZone) {
      reasoning.push(`${ctx.killZone.name} session active`);
    }

    // For continuation, we trade in the direction of BOS
    if (bos.direction === 'bullish') {
      // Use OTE Zone (50%-79% retracement for discount/OTE territory)
      const swingLow = bos.brokenSwing.price;
      const swingHigh = bos.breakCandle.high;
      const swingRange = swingHigh - swingLow;

      if (swingRange <= 0) return null;

      // Calculate Fibonacci retracement level
      const retracement = (swingHigh - current.close) / swingRange;

      // Check if price is in discount/OTE zone (50%-79%)
      const inDiscountOTE = retracement >= ENTRY_CONFIG.oteMin && retracement <= ENTRY_CONFIG.oteMax;

      // Require proper OTE zone - no fallback to loose pullback ranges
      if (inDiscountOTE) {
        reasoning.push(`Price in discount/OTE (${(retracement * 100).toFixed(1)}% retracement)`);

        // Bonus for true OTE zone (62%+)
        const inTrueOTE = retracement >= ENTRY_CONFIG.oteBonus;
        if (inTrueOTE) {
          reasoning.push('In true OTE zone (62%+)');
        }

        // Near optimal 70.5%
        const nearOptimal = Math.abs(retracement - ENTRY_CONFIG.oteOptimal) < 0.05;
        if (nearOptimal) {
          reasoning.push('Near optimal 70.5% entry');
        }

        // OB confluence
        const supportOB = ctx.orderBlocks.find(
          (ob) => ob.type === 'bullish' &&
            ob.status === 'unmitigated' &&
            current.low <= ob.high * 1.005
        );

        if (supportOB) {
          reasoning.push('OB support confluence');
        }

        const stopLoss = swingLow - ctx.atr * this.config.stopLossATRMultiple;
        const takeProfit = current.close + ctx.atr * this.config.takeProfitATRMultiple;
        const riskReward = (takeProfit - current.close) / (current.close - stopLoss);

        if (riskReward >= this.config.minRiskReward) {
          let confidence = bos.confidence;
          if (inTrueOTE) confidence += 0.1;
          if (nearOptimal) confidence += 0.05;
          if (supportOB) confidence += 0.1;

          return {
            direction: 'long',
            entryPrice: current.close,
            stopLoss,
            takeProfit,
            riskReward,
            confidence: Math.min(0.9, confidence),
            strategy: this.name,
            reasoning,
            structureBreak: bos,
            orderBlock: supportOB,
          };
        }
      }
    } else {
      // Bearish BOS - use OTE Zone for short entry
      const swingHigh = bos.brokenSwing.price;
      const swingLow = bos.breakCandle.low;
      const swingRange = swingHigh - swingLow;

      if (swingRange <= 0) return null;

      // Calculate Fibonacci retracement level
      const retracement = (current.close - swingLow) / swingRange;

      // Check if price is in premium/OTE zone (50%-79%)
      const inPremiumOTE = retracement >= ENTRY_CONFIG.oteMin && retracement <= ENTRY_CONFIG.oteMax;

      // Require proper OTE zone - no fallback to loose pullback ranges
      if (inPremiumOTE) {
        reasoning.push(`Price in premium/OTE (${(retracement * 100).toFixed(1)}% retracement)`);

        const inTrueOTE = retracement >= ENTRY_CONFIG.oteBonus;
        if (inTrueOTE) {
          reasoning.push('In true OTE zone (62%+)');
        }

        const nearOptimal = Math.abs(retracement - ENTRY_CONFIG.oteOptimal) < 0.05;
        if (nearOptimal) {
          reasoning.push('Near optimal 70.5% entry');
        }

        const resistanceOB = ctx.orderBlocks.find(
          (ob) => ob.type === 'bearish' &&
            ob.status === 'unmitigated' &&
            current.high >= ob.low * 0.995
        );

        if (resistanceOB) {
          reasoning.push('OB resistance confluence');
        }

        const stopLoss = swingHigh + ctx.atr * this.config.stopLossATRMultiple;
        const takeProfit = current.close - ctx.atr * this.config.takeProfitATRMultiple;
        const riskReward = (current.close - takeProfit) / (stopLoss - current.close);

        if (riskReward >= this.config.minRiskReward) {
          let confidence = bos.confidence;
          if (inTrueOTE) confidence += 0.1;
          if (nearOptimal) confidence += 0.05;
          if (resistanceOB) confidence += 0.1;

          return {
            direction: 'short',
            entryPrice: current.close,
            stopLoss,
            takeProfit,
            riskReward,
            confidence: Math.min(0.9, confidence),
            strategy: this.name,
            reasoning,
            structureBreak: bos,
            orderBlock: resistanceOB,
          };
        }
      }
    }

    return null;
  }

  detectExit(
    position: HybridPosition,
    _candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): StrategyExitSignal {
    // Exit on opposite BOS or CHoCH
    const recentBreaks = ctx.structure.structureBreaks.filter(
      (sb) => currentIndex - sb.breakIndex <= 5
    );

    for (const sb of recentBreaks) {
      if (position.side === 'long' && sb.direction === 'bearish') {
        return {
          shouldExit: true,
          reason: `Bearish ${sb.type.toUpperCase()} - trend change`,
          confidence: sb.type === 'choch' ? 0.85 : 0.7,
        };
      }
      if (position.side === 'short' && sb.direction === 'bullish') {
        return {
          shouldExit: true,
          reason: `Bullish ${sb.type.toUpperCase()} - trend change`,
          confidence: sb.type === 'choch' ? 0.85 : 0.7,
        };
      }
    }

    return { shouldExit: false, confidence: 0 };
  }

  getFeatures(
    _candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): number[] {
    const recentBOS = ctx.structure.structureBreaks.filter(
      (sb) => sb.type === 'bos' && currentIndex - sb.breakIndex <= 20
    );

    const bullishBOS = recentBOS.filter((sb) => sb.direction === 'bullish');
    const bearishBOS = recentBOS.filter((sb) => sb.direction === 'bearish');

    // Recency of last BOS
    const lastBullishAge = bullishBOS.length > 0
      ? (currentIndex - bullishBOS[bullishBOS.length - 1]!.breakIndex) / 20
      : 1;

    const lastBearishAge = bearishBOS.length > 0
      ? (currentIndex - bearishBOS[bearishBOS.length - 1]!.breakIndex) / 20
      : 1;

    // Confidence of last BOS
    const lastBullishConf = bullishBOS.length > 0
      ? bullishBOS[bullishBOS.length - 1]!.confidence
      : 0;

    const lastBearishConf = bearishBOS.length > 0
      ? bearishBOS[bearishBOS.length - 1]!.confidence
      : 0;

    return [
      1 - lastBullishAge, // Fresher = higher
      1 - lastBearishAge,
      lastBullishConf,
      lastBearishConf,
    ];
  }
}

// ============================================
// CHoCH Reversal Strategy
// ============================================

export class CHoCHReversalStrategy implements ICTStrategy {
  readonly name: StrategyName = 'choch_reversal';
  private config: StrategyConfig;

  constructor(config: Partial<StrategyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  detectEntry(
    candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): StrategySignal | null {
    const current = candles[currentIndex];
    if (!current) return null;

    // Kill zone filter - skip trades outside high-probability sessions
    const kzBlock = checkKillZoneFilter(ctx, this.config);
    if (kzBlock) return null;

    // Look for recent CHoCH - TIGHTENED for quality reversals
    const recentCHoCH = ctx.structure.structureBreaks.filter(
      (sb) => sb.type === 'choch' &&
        currentIndex - sb.breakIndex <= 15 && // Tightened: only fresh CHoCH
        sb.confidence >= 0.6 // Require high-confidence body close beyond level
    );

    if (recentCHoCH.length === 0) return null;

    const choch = recentCHoCH[recentCHoCH.length - 1]!;
    const reasoning: string[] = [`Recent ${choch.direction} CHoCH - reversal signal`];

    // Add kill zone info to reasoning
    if (ctx.killZone?.inKillZone) {
      reasoning.push(`${ctx.killZone.name} session active`);
    }

    // CHoCH is a reversal signal - trade in the direction of the CHoCH
    if (choch.direction === 'bullish') {
      // After bullish CHoCH, look for entry on pullback
      reasoning.push('Looking for long entry after reversal');

      // Find supporting OB (can be before or after CHoCH now)
      const supportOB = ctx.orderBlocks.find(
        (ob) => ob.type === 'bullish' &&
          ob.status === 'unmitigated' &&
          currentIndex - ob.index <= 50 // Within 50 bars
      );

      // Check if price is near the OB OR just enter on CHoCH directly
      const hasOBConfluence = supportOB && Math.abs(current.close - supportOB.high) / current.close <= 0.02;

      if (hasOBConfluence) {
        reasoning.push('Found supporting OB confluence');
      }

      // Entry either with OB confluence OR just on CHoCH if recent enough
      if (hasOBConfluence || currentIndex - choch.breakIndex <= 10) {
        const stopLoss = supportOB
          ? supportOB.low - ctx.atr * 0.5
          : choch.brokenSwing.price - ctx.atr * this.config.stopLossATRMultiple;
        const takeProfit = current.close + ctx.atr * this.config.takeProfitATRMultiple * 1.2;
        const riskReward = (takeProfit - current.close) / (current.close - stopLoss);

        if (riskReward >= this.config.minRiskReward) {
          return {
            direction: 'long',
            entryPrice: current.close,
            stopLoss,
            takeProfit,
            riskReward,
            confidence: Math.min(0.9, choch.confidence + 0.15 + (hasOBConfluence ? 0.15 : 0)),
            strategy: this.name,
            reasoning,
            structureBreak: choch,
            orderBlock: supportOB,
          };
        }
      }
    } else {
      // After bearish CHoCH, look for short entry
      reasoning.push('Looking for short entry after reversal');

      const resistanceOB = ctx.orderBlocks.find(
        (ob) => ob.type === 'bearish' &&
          ob.status === 'unmitigated' &&
          currentIndex - ob.index <= 50
      );

      const hasOBConfluence = resistanceOB && Math.abs(current.close - resistanceOB.low) / current.close <= 0.02;

      if (hasOBConfluence) {
        reasoning.push('Found resistance OB confluence');
      }

      if (hasOBConfluence || currentIndex - choch.breakIndex <= 10) {
        const stopLoss = resistanceOB
          ? resistanceOB.high + ctx.atr * 0.5
          : choch.brokenSwing.price + ctx.atr * this.config.stopLossATRMultiple;
        const takeProfit = current.close - ctx.atr * this.config.takeProfitATRMultiple * 1.2;
        const riskReward = (current.close - takeProfit) / (stopLoss - current.close);

        if (riskReward >= this.config.minRiskReward) {
          return {
            direction: 'short',
            entryPrice: current.close,
            stopLoss,
            takeProfit,
            riskReward,
            confidence: Math.min(0.9, choch.confidence + 0.15 + (hasOBConfluence ? 0.15 : 0)),
            strategy: this.name,
            reasoning,
            structureBreak: choch,
            orderBlock: resistanceOB,
          };
        }
      }
    }

    return null;
  }

  detectExit(
    position: HybridPosition,
    _candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): StrategyExitSignal {
    // Reversal trades - exit on opposite CHoCH or structure failure
    const recentBreaks = ctx.structure.structureBreaks.filter(
      (sb) => currentIndex - sb.breakIndex <= 5
    );

    for (const sb of recentBreaks) {
      if (sb.type === 'choch') {
        if (position.side === 'long' && sb.direction === 'bearish') {
          return {
            shouldExit: true,
            reason: 'Counter CHoCH - reversal failed',
            confidence: 0.9,
          };
        }
        if (position.side === 'short' && sb.direction === 'bullish') {
          return {
            shouldExit: true,
            reason: 'Counter CHoCH - reversal failed',
            confidence: 0.9,
          };
        }
      }
    }

    return { shouldExit: false, confidence: 0 };
  }

  getFeatures(
    _candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): number[] {
    const recentCHoCH = ctx.structure.structureBreaks.filter(
      (sb) => sb.type === 'choch' && currentIndex - sb.breakIndex <= 20
    );

    const bullishCHoCH = recentCHoCH.filter((sb) => sb.direction === 'bullish');
    const bearishCHoCH = recentCHoCH.filter((sb) => sb.direction === 'bearish');

    const lastBullishAge = bullishCHoCH.length > 0
      ? (currentIndex - bullishCHoCH[bullishCHoCH.length - 1]!.breakIndex) / 20
      : 1;

    const lastBearishAge = bearishCHoCH.length > 0
      ? (currentIndex - bearishCHoCH[bearishCHoCH.length - 1]!.breakIndex) / 20
      : 1;

    const lastBullishConf = bullishCHoCH.length > 0
      ? bullishCHoCH[bullishCHoCH.length - 1]!.confidence
      : 0;

    const lastBearishConf = bearishCHoCH.length > 0
      ? bearishCHoCH[bearishCHoCH.length - 1]!.confidence
      : 0;

    return [
      1 - lastBullishAge,
      1 - lastBearishAge,
      lastBullishConf,
      lastBearishConf,
    ];
  }
}

// ============================================
// Wait Strategy (No Trade)
// ============================================

export class WaitStrategy implements ICTStrategy {
  readonly name: StrategyName = 'wait';

  detectEntry(): StrategySignal | null {
    // Wait strategy never generates entry signals
    return null;
  }

  detectExit(): StrategyExitSignal {
    // Wait strategy always says don't exit (not applicable when not in position)
    return { shouldExit: false, confidence: 0 };
  }

  getFeatures(): number[] {
    // No features for wait strategy
    return [0, 0, 0, 0];
  }
}

// ============================================
// Strategy Manager
// ============================================

export class ICTStrategyManager {
  private strategies: Map<StrategyName, ICTStrategy>;

  constructor(config: Partial<StrategyConfig> = {}) {
    this.strategies = new Map<StrategyName, ICTStrategy>([
      ['wait', new WaitStrategy()],
      ['order_block', new OrderBlockStrategy(config)],
      ['fvg', new FVGStrategy(config)],
      ['bos_continuation', new BOSContinuationStrategy(config)],
      ['choch_reversal', new CHoCHReversalStrategy(config)],
    ]);
  }

  getStrategy(name: StrategyName): ICTStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      throw new Error(`Unknown strategy: ${name}`);
    }
    return strategy;
  }

  getAllStrategies(): ICTStrategy[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Build ICT context from candles
   *
   * Auto-scales OB/FVG detection thresholds based on asset volatility.
   * Reference: BTC hourly ATR% ≈ 0.6%. Forex ATR% ≈ 0.07%.
   * Scale factor = clamp(ATR% / 0.006, 0.05, 5.0)
   */
  buildContext(
    candles: Candle[],
    currentIndex: number
  ): ICTStrategyContext {
    const lookbackCandles = candles.slice(
      Math.max(0, currentIndex - 100),
      currentIndex + 1
    );

    const current = candles[currentIndex];
    if (!current) {
      throw new Error(`No candle at index ${currentIndex}`);
    }

    // Calculate ATR
    const atr = this.calculateATR(lookbackCandles);

    // Compute volatility scale factor for auto-scaling detection thresholds
    // Reference ATR% = 0.006 (0.6%), typical for BTC hourly
    const atrPercent = current.close > 0 ? atr / current.close : 0.006;
    const REFERENCE_ATR_PERCENT = 0.006;
    const volatilityScale = Math.max(0.05, Math.min(5.0, atrPercent / REFERENCE_ATR_PERCENT));

    // Scale OB detection thresholds by volatility
    const scaledOBConfig: OrderBlockConfig = {
      ...DEFAULT_OB_CONFIG,
      minMovePercent: DEFAULT_OB_CONFIG.minMovePercent * volatilityScale,
    };

    // Scale FVG detection thresholds by volatility
    const scaledFVGConfig: FVGConfig = {
      minSizePercent: 0.4 * volatilityScale,
      maxAgeCandles: 30,
      displacementMultiple: 1.5,
      avgBodyLookback: 14,
    };

    const structure = analyzeMarketStructure(lookbackCandles);
    const orderBlocks = detectOrderBlocks(lookbackCandles, scaledOBConfig);
    const fvgs = detectFairValueGaps(lookbackCandles, scaledFVGConfig);

    // Get kill zone info
    const killZone = checkKillZone(current.timestamp);

    // Get liquidity data
    const liquidityLevels = detectLiquidityLevels(lookbackCandles);
    const recentSweeps = detectLiquiditySweeps(lookbackCandles, liquidityLevels);

    return {
      structure,
      orderBlocks,
      fvgs,
      currentPrice: current.close,
      atr,
      timestamp: current.timestamp,
      killZone,
      liquidityLevels,
      recentSweeps,
      volatilityScale,
    };
  }

  /**
   * Get combined features from all strategies
   * Returns 20 features (4 per strategy x 5 strategies)
   */
  getCombinedFeatures(
    candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): number[] {
    const features: number[] = [];

    for (const strategy of this.getAllStrategies()) {
      const strategyFeatures = strategy.getFeatures(candles, currentIndex, ctx);
      features.push(...strategyFeatures);
    }

    return features;
  }

  /**
   * Execute strategy selection
   */
  executeStrategy(
    action: StrategyAction,
    candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): StrategySignal | null {
    const strategyName = strategyActionToName(action);
    const strategy = this.getStrategy(strategyName);
    return strategy.detectEntry(candles, currentIndex, ctx);
  }

  /**
   * Check exit for current strategy
   */
  checkExit(
    strategyName: StrategyName,
    position: HybridPosition,
    candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext
  ): StrategyExitSignal {
    const strategy = this.getStrategy(strategyName);
    return strategy.detectExit(position, candles, currentIndex, ctx);
  }

  private calculateATR(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) return 1;

    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const high = candles[i]!.high;
      const low = candles[i]!.low;
      const prevClose = candles[i - 1]?.close ?? candles[i]!.open;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      sum += tr;
    }

    return sum / period;
  }
}

// ============================================
// Exports
// ============================================

export { DEFAULT_CONFIG as DEFAULT_STRATEGY_CONFIG };
// Note: ENTRY_CONFIG is already exported at declaration
