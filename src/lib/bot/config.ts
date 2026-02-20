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
  LTFConfig,
} from '@/types/bot';
import type { FundingArbConfig } from '@/types/funding-arb';

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
};

// ============================================
// LTF Config Defaults
// ============================================

export const DEFAULT_LTF_CONFIG: LTFConfig = {
  enabled: false,
  ltfInterval: '5',
  zoneTimeoutBars: 36, // 3 hours at 5m
  confirmTimeoutBars: 12, // 1 hour at 5m
  requireMSS: true,
  requireCVD: true,
  requireVolumeSpike: false, // Start lenient
  volumeSpikeThreshold: 1.5,
  cvdLookback: 12,
  onTimeout: 'skip',
  ltfSwingLookback: 3,
};

// ============================================
// Funding Rate Arb Config Defaults
// ============================================

export const DEFAULT_FUNDING_ARB_CONFIG: FundingArbConfig = {
  minFundingRate: 0.0002, // 0.02% per 8h (~27% APY minimum)
  closeBelowRate: 0.00005, // 0.005% per 8h (~6.8% APY)
  maxPositionSizeUSDT: 2000,
  maxArbPositions: 3,
  maxHoldTimeHours: 168, // 7 days
  maxEntrySpread: 0.001, // 0.1%
  arbSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  commissionPerSide: 0.00055, // Bybit taker
  pollIntervalMinutes: 60, // Hourly
};

// ============================================
// Bybit API Constants
// ============================================

/** Bybit API category for each symbol */
export const BYBIT_CATEGORY = 'linear' as const;

/** Candle interval for Bybit API */
export const BYBIT_INTERVAL = '60' as const; // 1 hour
