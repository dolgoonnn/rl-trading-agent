/**
 * Forecast-to-Fill (F2F) Gold Strategy — Types & Constants
 *
 * Based on: arxiv 2511.08571 — "Forecast-to-Fill" (Sharpe 2.88 on gold 2015-2025)
 *
 * Only 2 optimized parameters (λ, θ). Everything else is fixed from the paper.
 */

// ============================================
// Fixed Parameters (NOT optimized — from paper)
// ============================================

export const F2F_FIXED_PARAMS = {
  /** Trend-momentum blend weight (ω) — 60% trend, 40% momentum */
  trendBlendWeight: 0.60,

  /** Minimum p_bull for long entry activation */
  activationThreshold: 0.52,

  /** ATR period for stop-loss calculations */
  atrPeriod: 14,

  /** Hard stop: entry - N × ATR */
  hardStopAtrMultiple: 2.0,

  /** Trailing stop: peak - N × ATR */
  trailingStopAtrMultiple: 1.5,

  /** Maximum hold time in trading days */
  timeoutDays: 30,

  /** Annualized volatility target */
  volTargetAnnual: 0.15,

  /** Maximum leverage */
  leverageCap: 2.0,

  /** Kelly fraction applied to position sizing */
  kellyFraction: 0.40,

  /** Momentum lookback in trading days */
  momentumLookback: 50,

  /** Z-score clip range */
  zScoreClipMin: -3.0,
  zScoreClipMax: 3.0,

  /** Annualization factor for daily returns — √252 */
  annualizationFactor: Math.sqrt(252),

  /** Daily vol target: σ* = volTargetAnnual / √252 */
  get dailyVolTarget(): number {
    return this.volTargetAnnual / this.annualizationFactor;
  },

  // === Enhanced Kelly (Phase 5) — disabled by default ===

  /** Market impact penalty coefficient (γ) — penalizes position changes */
  marketImpactGamma: 0.0,

  /** Baseline position multiplier — fraction of vol-targeted weight held always */
  baselinePositionFraction: 0.0,
} as const;

// ============================================
// Optimized Parameters
// ============================================

export interface F2FOptimizedParams {
  /** EMA decay for smoothed log-prices — λ ∈ [0.90, 0.99] */
  lambda: number;
  /** EWMA vol decay — θ ∈ [0.90, 0.99] */
  theta: number;
}

/** Grid search range for λ and θ */
export const F2F_GRID = {
  lambdaMin: 0.90,
  lambdaMax: 0.99,
  lambdaStep: 0.01,
  thetaMin: 0.90,
  thetaMax: 0.99,
  thetaStep: 0.01,
} as const;

// ============================================
// Walk-Forward Configuration
// ============================================

export interface F2FWalkForwardConfig {
  /** Training window in trading days (default: 3652 ≈ 10yr × 365.25) */
  trainBars: number;
  /** Validation window in trading days (default: 126 ≈ 6mo) */
  valBars: number;
  /** Slide step in trading days (default: 21 ≈ 1mo) */
  slideBars: number;
}

export const F2F_DEFAULT_WF_CONFIG: F2FWalkForwardConfig = {
  trainBars: 2520,   // 10yr × 252 trading days
  valBars: 126,      // 6mo × 21 trading days/mo
  slideBars: 21,     // 1mo slide
};

// ============================================
// Signal Types
// ============================================

export interface F2FSignal {
  /** Bar index in candle array */
  index: number;
  /** Timestamp of the candle */
  timestamp: number;
  /** Smoothed log price ỹ_t */
  smoothedLogPrice: number;
  /** Change in smoothed log price: Δỹ_t = ỹ_t - ỹ_{t-1} */
  deltaSmoothed: number;
  /** Z-score of Δỹ_t (standardized using training stats) */
  zScore: number;
  /** Trend confidence: p_trend ∈ [0,1] */
  pTrend: number;
  /** Momentum: 1 if price > price_{t-50}, else 0 */
  momentum: number;
  /** Blended probability: p_bull = ω·p_trend + (1-ω)·m_t */
  pBull: number;
  /** p_bear = 1 - p_bull */
  pBear: number;
  /** ATR(14) at this bar */
  atr: number;
  /** EWMA volatility (daily) at this bar */
  ewmaVol: number;
  /** Close price at this bar */
  close: number;
  /** Low price at this bar (for intraday stop checks) */
  low: number;
  /** Whether this bar generates a long entry signal */
  isLongEntry: boolean;
  /** Whether this bar generates a short entry signal */
  isShortEntry: boolean;
  /** Whether regime filter suppresses entries on this bar */
  isRegimeSuppressed: boolean;
}

// ============================================
// Training Stats
// ============================================

export interface F2FTrainStats {
  /** Mean of Δỹ over training period */
  mu: number;
  /** Std of Δỹ over training period */
  sigma: number;
}

// ============================================
// Trade Types
// ============================================

export type F2FExitReason = 'hard_stop' | 'trailing_stop' | 'timeout' | 'derisk' | 'end_of_data';

export interface F2FTrade {
  /** Entry bar index */
  entryIndex: number;
  /** Entry timestamp */
  entryTimestamp: number;
  /** Entry price */
  entryPrice: number;
  /** Exit bar index */
  exitIndex: number;
  /** Exit timestamp */
  exitTimestamp: number;
  /** Exit price */
  exitPrice: number;
  /** Exit reason */
  exitReason: F2FExitReason;
  /** Direction */
  direction: 'long' | 'short';
  /** Position weight [0, leverageCap] */
  weight: number;
  /** PnL as percentage of equity (weight × return - friction) */
  pnlPercent: number;
  /** Trading days held */
  daysHeld: number;
  /** p_bull at entry */
  pBullAtEntry: number;
  /** ATR at entry */
  atrAtEntry: number;
  /** Hard stop price */
  hardStop: number;
  /** Trailing stop at exit */
  trailingStop: number;
  /** Peak price seen during hold */
  peakPrice: number;
}

// ============================================
// Simulation Results
// ============================================

export interface F2FSimulationResult {
  trades: F2FTrade[];
  /** Equity curve (value at each bar) */
  equityCurve: number[];
  /** Total PnL (%) */
  totalPnl: number;
  /** Sharpe ratio (annualized √252) */
  sharpe: number;
  /** Maximum drawdown (%) */
  maxDrawdown: number;
  /** Win rate */
  winRate: number;
  /** Average days held */
  avgDaysHeld: number;
  /** Exit reason breakdown */
  exitReasons: Record<F2FExitReason, number>;
}

// ============================================
// Optimizer Results
// ============================================

export interface F2FWindowResult {
  /** Window index */
  windowIndex: number;
  /** Train start index */
  trainStart: number;
  /** Train end index */
  trainEnd: number;
  /** Val start index */
  valStart: number;
  /** Val end index */
  valEnd: number;
  /** Best λ from grid search on train */
  bestLambda: number;
  /** Best θ from grid search on train */
  bestTheta: number;
  /** Train Sharpe with best params */
  trainSharpe: number;
  /** OOS (validation) Sharpe */
  valSharpe: number;
  /** OOS trades */
  valTrades: F2FTrade[];
  /** Whether OOS Sharpe > 0 */
  pass: boolean;
}

export interface F2FOptimizationResult {
  /** All window results */
  windows: F2FWindowResult[];
  /** Pass rate: fraction of windows with positive OOS Sharpe */
  passRate: number;
  /** All OOS trades concatenated */
  allOOSTrades: F2FTrade[];
  /** Final params from last window (for live use) */
  finalParams: F2FOptimizedParams;
  /** Aggregate OOS metrics */
  aggregate: F2FSimulationResult;
}
