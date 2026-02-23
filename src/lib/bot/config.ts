/**
 * Bot Configuration — Run 20 CMA-ES Optimized Defaults
 *
 * These are the production-validated parameters from CMA-ES optimization:
 * - 69.7% walk-forward pass rate (fitness=967.9)
 * - PBO = 21%, DSR = 7.58
 * - Validated 5/7 checks
 */

import type {
  BotConfig,
  StrategyConfig,
  CircuitBreakerConfig,
  DrawdownTier,
  RiskConfig,
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
  verbose: false,
};

// ============================================
// Strategy Config — Run 20 CMA-ES Optimized
// ============================================

export const RUN20_STRATEGY_CONFIG: StrategyConfig = {
  activeStrategies: ['order_block'],
  weights: {
    structureAlignment: 0.1928,
    killZoneActive: 1.2658,
    liquiditySweep: 1.4896,
    obProximity: 2.7262,
    fvgAtCE: 2.3162,
    recentBOS: 2.2229,
    rrRatio: 0.5567,
    oteZone: 1.0621,
    obFvgConfluence: 1.0892,
    breakerConfluence: 0,
    obVolumeQuality: 0,
    momentumConfirmation: 0,
    fundingAlignment: 0,
  },
  baseThreshold: 4.048,
  regimeThresholds: {
    'uptrend+high': 3.14,
    'uptrend+normal': 5.74,
    'uptrend+low': 5.49,
    'downtrend+normal': 4.38,
    'downtrend+low': 6.50,
  },
  suppressedRegimes: ['ranging+normal', 'ranging+high', 'downtrend+high'],
  obHalfLife: 12,
  atrExtensionBands: 5.79,
  cooldownBars: 7,
  maxBars: 160,
  exitMode: 'partial_tp',
  partialTP: {
    fraction: 0.50,
    triggerR: 1.41,
    beBuffer: 0.20,
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
// Drawdown Tiers — Graduated Position Sizing
// ============================================

export const DEFAULT_DRAWDOWN_TIERS: DrawdownTier[] = [
  { maxDrawdown: 0.10, sizeMultiplier: 1.0,  label: 'normal' },
  { maxDrawdown: 0.20, sizeMultiplier: 0.50, label: 'caution' },
  { maxDrawdown: 0.30, sizeMultiplier: 0.25, label: 'defensive' },
  { maxDrawdown: Infinity, sizeMultiplier: 0, label: 'halt' },
];

// ============================================
// Regime-Aware Position Size Multipliers
// ============================================

export const DEFAULT_REGIME_SIZE_MULTIPLIERS: Record<string, number> = {
  'uptrend+normal': 1.0,
  'uptrend+low': 0.8,
  'uptrend+high': 0.6,
  'downtrend+normal': 0.5,
  'downtrend+low': 0.5,
  // Ranging and downtrend+high already suppressed (0 trades)
};

// ============================================
// Combined Risk Config
// ============================================

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  circuitBreakers: DEFAULT_CIRCUIT_BREAKERS,
  drawdownTiers: DEFAULT_DRAWDOWN_TIERS,
  maxPositions: 3,
  regimeSizeMultipliers: DEFAULT_REGIME_SIZE_MULTIPLIERS,
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
