/**
 * Funding Rate Arbitrage Types
 *
 * Types for the market-neutral funding rate arbitrage module.
 * Collects funding payments by holding delta-neutral positions
 * when funding rates are elevated.
 */

// ============================================
// Direction & Status
// ============================================

/** Arb direction: short perp when rate positive, long perp when negative */
export type ArbDirection = 'short_perp' | 'long_perp';

/** Arb position lifecycle status */
export type ArbPositionStatus = 'open' | 'closed';

/** Reason an arb position was closed */
export type ArbExitReason =
  | 'rate_dropped'
  | 'rate_flipped'
  | 'max_hold_time'
  | 'spread_too_wide'
  | 'manual'
  | 'shutdown';

// ============================================
// Funding Rate Data
// ============================================

/** A snapshot of funding rate data polled from exchange */
export interface FundingRateSnapshot {
  symbol: string;
  fundingRate: number;
  nextFundingTime: number;
  markPrice: number;
  indexPrice: number;
  bid1: number;
  ask1: number;
  spread: number;
  polledAt: number;
}

/** Historical funding rate record */
export interface FundingRateRecord {
  symbol: string;
  fundingRate: number;
  fundingRateTimestamp: number;
}

// ============================================
// Arb Position
// ============================================

/** A single funding payment received/paid during position hold */
export interface FundingPayment {
  timestamp: number;
  fundingRate: number;
  paymentUSDT: number;
  /** Positive = we received, negative = we paid */
  direction: 'received' | 'paid';
}

/** A funding arb position tracked by the bot */
export interface FundingArbPosition {
  id: string;
  symbol: string;
  direction: ArbDirection;
  status: ArbPositionStatus;

  // Entry
  entryPrice: number;
  entrySpread: number;
  entryFundingRate: number;
  entryTimestamp: number;
  positionSizeUSDT: number;

  // Funding collection
  fundingPayments: FundingPayment[];
  totalFundingCollected: number;
  fundingPaymentCount: number;

  // Exit (filled when closed)
  exitPrice?: number;
  exitTimestamp?: number;
  exitReason?: ArbExitReason;
  exitSpread?: number;

  // P&L
  spreadCost: number;
  netPnlUSDT: number;
  holdTimeHours: number;
  annualizedAPY: number;
}

// ============================================
// Arb Configuration
// ============================================

/** Funding rate arbitrage configuration */
export interface FundingArbConfig {
  /** Minimum absolute funding rate to open position (per 8h period) */
  minFundingRate: number;
  /** Close position when rate drops below this (per 8h period) */
  closeBelowRate: number;
  /** Max position size per symbol in USDT */
  maxPositionSizeUSDT: number;
  /** Max concurrent arb positions */
  maxArbPositions: number;
  /** Max hold time in hours */
  maxHoldTimeHours: number;
  /** Max entry bid-ask spread as fraction (e.g. 0.001 = 0.1%) */
  maxEntrySpread: number;
  /** Symbols eligible for arb */
  arbSymbols: string[];
  /** Commission per side as fraction */
  commissionPerSide: number;
  /** How often to poll funding rates (minutes) */
  pollIntervalMinutes: number;
}

// ============================================
// Arb Engine State
// ============================================

/** State of the arb engine for a given symbol */
export type ArbEngineState = 'monitoring' | 'open';

/** Evaluation result from the arb engine */
export interface ArbEvaluation {
  action: 'open' | 'close' | 'hold' | 'skip';
  reason: string;
  direction?: ArbDirection;
  fundingRate?: number;
  spread?: number;
  breakEvenHours?: number;
}
