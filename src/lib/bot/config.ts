/**
 * Bot Configuration — Run 18 CMA-ES Optimized Defaults
 *
 * These are the production-validated parameters from CMA-ES optimization:
 * - 78.1% walk-forward pass rate
 * - PBO = 18.5%, DSR = 6.77
 * - MC trade-level ALL PASS
 */

import type {
  BotConfig,
  StrategyConfig,
  CircuitBreakerConfig,
} from '@/types/bot';

// ============================================
// Bot Config Defaults
// ============================================

export const DEFAULT_BOT_CONFIG: BotConfig = {
  mode: 'paper',
  exchange: 'bybit',
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  timeframe: '1h',
  initialCapital: 10000,
  riskPerTrade: 0.003, // 0.3% risk per trade (MC-informed)
  maxPositions: 3, // One per symbol
  pollDelaySeconds: 5, // 5s after hour close
  paperSlippage: 0.001, // 0.1% slippage simulation
  commissionPerSide: 0.00055, // Bybit taker: 0.055%
  verbose: false,
};

// ============================================
// Strategy Config — Run 18 CMA-ES Optimized
// ============================================

export const RUN18_STRATEGY_CONFIG: StrategyConfig = {
  activeStrategies: ['order_block'],
  weights: {
    structureAlignment: 2.660,
    killZoneActive: 0.814,
    liquiditySweep: 1.733,
    obProximity: 1.103,
    fvgAtCE: 1.554,
    recentBOS: 1.255,
    rrRatio: 0.627,
    oteZone: 0.787,
    obFvgConfluence: 1.352,
    breakerConfluence: 0,
    obVolumeQuality: 0,
    momentumConfirmation: 0,
    fundingAlignment: 0,
  },
  baseThreshold: 4.672,
  regimeThresholds: {
    'uptrend+high': 2.86,
    'uptrend+normal': 6.17,
    'uptrend+low': 3.13,
    'downtrend+normal': 4.33,
    'downtrend+low': 4.48,
  },
  suppressedRegimes: ['ranging+normal', 'ranging+high', 'downtrend+high'],
  obHalfLife: 18,
  atrExtensionBands: 4.10,
  cooldownBars: 8,
  maxBars: 108,
  exitMode: 'partial_tp',
  partialTP: {
    fraction: 0.55,
    triggerR: 0.84,
    beBuffer: 0.05,
  },
  frictionPerSide: 0.0007, // 0.07% combined commission + slippage
};

// ============================================
// Strategy Config — Gold Run 12 CMA-ES Optimized
// ============================================

export const GOLD_RUN12_STRATEGY_CONFIG: StrategyConfig = {
  activeStrategies: ['asian_range_gold'],
  weights: {
    structureAlignment: 0.185,
    killZoneActive: 1.234,
    liquiditySweep: 3.443,
    obProximity: 0.274,
    fvgAtCE: 1.568,
    recentBOS: 1.786,
    rrRatio: 3.910,
    oteZone: 0.211,
    obFvgConfluence: 1.358,
    breakerConfluence: 0,
    obVolumeQuality: 0,
    momentumConfirmation: 0,
    fundingAlignment: 0,
  },
  baseThreshold: 3.177,
  regimeThresholds: {
    'uptrend+high': 4.39,
    'uptrend+normal': 5.31,
    'uptrend+low': 5.16,
    'downtrend+normal': 2.76,
    'downtrend+low': 4.94,
  },
  suppressedRegimes: [], // No regime suppression for gold
  obHalfLife: 10,
  atrExtensionBands: 2.92,
  cooldownBars: 5,
  maxBars: 93,
  exitMode: 'partial_tp',
  partialTP: {
    fraction: 0.20,
    triggerR: 0.70,
    beBuffer: 0.02,
  },
  frictionPerSide: 0.0007,
  goldConfig: {
    minRangePct: 0.16,
    minSweepPct: 0.073,
    longBiasMultiplier: 1.297,
    goldVolScale: 0.81,
    targetRR: 1.363,
    displacementMultiple: 1.0,
    sweepLookback: 29,
    fvgSearchWindow: 18,
    ceTolerance: 0.0028,
  },
};

// ============================================
// Circuit Breaker Defaults
// ============================================

export const DEFAULT_CIRCUIT_BREAKERS: CircuitBreakerConfig = {
  dailyLossLimit: 0.03, // -3% daily
  weeklyLossLimit: 0.05, // -5% weekly
  maxDrawdown: 0.15, // -15% from peak (at target sizing)
  maxConsecutiveLosses: 5,
  maxSystemErrorsPerHour: 3,
};

// ============================================
// Symbol-specific config
// ============================================

/** Inverse volatility weights for position sizing across symbols */
export const SYMBOL_ALLOCATION: Record<string, number> = {
  BTCUSDT: 0.40,
  ETHUSDT: 0.33,
  SOLUSDT: 0.27,
  XAUUSDT: 1.00, // Gold runs as its own allocation pool (single symbol)
};

/** Gold symbols that use the asian_range_gold strategy */
export const GOLD_SYMBOLS = new Set(['XAUUSDT']);

/** Check if a symbol uses the gold strategy */
export function isGoldSymbol(symbol: string): boolean {
  return GOLD_SYMBOLS.has(symbol);
}

/** Get the appropriate strategy config for a symbol */
export function getStrategyConfigForSymbol(symbol: string): StrategyConfig {
  return isGoldSymbol(symbol) ? GOLD_RUN12_STRATEGY_CONFIG : RUN18_STRATEGY_CONFIG;
}

/** Bybit API category for each symbol */
export const BYBIT_CATEGORY = 'linear' as const;

/** Candle interval for Bybit API */
export const BYBIT_INTERVAL = '60' as const; // 1 hour
