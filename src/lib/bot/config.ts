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
  SafetyGateConfig,
  RetirementConfig,
  TradeabilityConfig,
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
// Pre-Trade Safety Gate (live/paper bot only)
// ============================================

/**
 * Hard-reject thresholds for the pre-trade safety gate.
 * - maxNotionalPctEquity 2.0  → cap a single position at 200% of equity
 * - minStopPct 0.001 (0.10%)  → floor riskDistance so a tiny stop can't blow up size
 * - maxDeviationBps 50 (0.50%) → mark collar, start loose, tighten via skipped-signal log
 * - maxCandleAgeMs 5_400_000 (90 min = 1.5× a 1h bar) → reject acting on a stale bar
 */
export const SAFETY_GATE_CONFIG: SafetyGateConfig = {
  maxNotionalPctEquity: 2.0,
  minStopPct: 0.001,
  maxDeviationBps: 50,
  maxCandleAgeMs: 5_400_000,
};

// ============================================
// L2 Tradeability Gate (live/paper bot only)
// ============================================

/**
 * L2 order-book reject thresholds for majors (BTC/ETH/SOL).
 * - maxSpreadBps 5 (0.05%) → reject when the bid/ask spread is wider than 5 bps.
 * - depthMultiple 2        → require 2× the intended notional resting in the
 *   top-10 levels on the side we'd cross, so a market order can't move the book.
 *
 * Live-only: a real L2 snapshot is injected at the order path; tests/backtest
 * pass no snapshot, so the gate is skipped (it must not shift the Run-20 edge).
 */
export const TRADEABILITY_CONFIG: TradeabilityConfig = {
  maxSpreadBps: 5,
  depthMultiple: 2,
};

// ============================================
// Retirement Kill-Switch (live/paper bot only)
// ============================================

/**
 * Frozen-at-deploy retirement parameters.
 *
 * hardKillDD is derived (NOT hard-coded) from these inputs:
 *   E[MaxDD] = sigmaAnnual·√(2·ln(horizonYears·252))/sharpe   (≈0.194 here)
 *   hardKillDD = 1.5·max(E[MaxDD], bootstrapP5DD)             (≈0.291 here)
 * Both are far below the raw in-sample 63.3% — we do NOT cut at that depth.
 *
 * NOTE (Issue C): `bootstrapP5DD = 0.10` is a PLACEHOLDER. The real value is the
 * bootstrap MaxDD 5th-percentile produced by the Monte-Carlo validation run
 * (`scripts/validate-monte-carlo.ts` → `src/lib/rl/utils/monte-carlo.ts`). Today
 * E[MaxDD] (≈0.194) dominates the `max()` so hardKillDD is insensitive to this
 * placeholder, but it MUST be wired from the funding-net MC bootstrap before the
 * bootstrap leg can ever bind. TODO: replace 0.10 with the MC bootstrap p5 MaxDD.
 *
 * - minAcceptableSharpe 0.5 → the deflated-Sharpe benchmark `c` (NOT zero): a
 *   0.3 rolling Sharpe at 100 trials must reduce sizing where raw-Sharpe didn't.
 * - minTrackRecordLength 50 → until this many live observations accrue, the DSR
 *   layer may only DE-RISK (never HARD), so we don't cut at the bottom of a
 *   normal early drawdown.
 * - maxEntriesPerDay 3/symbol, maxConsecutiveLossesPerSymbol 4 → per-symbol
 *   throttle independent of strategy cooldownBars; pauses one symbol, not the book.
 * - heartbeatTimeoutMs 7_200_000 (2× a 1h bar) → stale feed latches a HALT.
 */
export const RETIREMENT_CONFIG: RetirementConfig = {
  sigmaAnnual: 0.12,
  sharpe: 2,
  horizonYears: 0.75,
  bootstrapP5DD: 0.10,
  minAcceptableSharpe: 0.5,
  psr: 0.95,
  minTrackRecordLength: 50,
  maxEntriesPerDay: 3,
  maxConsecutiveLossesPerSymbol: 4,
  heartbeatTimeoutMs: 7_200_000,
  charterBreachK: 3,
  // dsrBreachK 3 → three consecutive sub-floor deflated-Sharpe checks (each with
  // n >= MinTRL) escalate the DSR layer to a HARD halt even without a regime
  // cause. One reading is noise; three sustained breaches are an edge collapse.
  dsrBreachK: 3,
};

// ============================================
// Bybit API Constants
// ============================================

/** Bybit API category for each symbol */
export const BYBIT_CATEGORY = 'linear' as const;

/** Candle interval for Bybit API */
export const BYBIT_INTERVAL = '60' as const; // 1 hour
