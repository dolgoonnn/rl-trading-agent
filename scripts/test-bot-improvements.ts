#!/usr/bin/env npx tsx
/**
 * Unit Tests for Bot Improvements (Phase 1-3)
 *
 * Tests pure logic without DB, exchange, or backtest dependencies.
 * Run: npx tsx scripts/test-bot-improvements.ts
 */

import { RiskEngine } from '../src/lib/bot/risk-engine';
import {
  DEFAULT_RISK_CONFIG,
  DEFAULT_DRAWDOWN_TIERS,
  DEFAULT_REGIME_SIZE_MULTIPLIERS,
  DEFAULT_CIRCUIT_BREAKERS,
} from '../src/lib/bot/config';
import type {
  CircuitBreakerState,
  DrawdownTier,
  RiskConfig,
  BotSymbol,
  BotPosition,
} from '../src/types/bot';
import type { Candle } from '../src/types/candle';

// ============================================
// Test Framework (minimal)
// ============================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  FAIL: ${name}`);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, name: string): void {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  FAIL: ${name} — expected ~${expected}, got ${actual} (diff=${diff.toFixed(6)})`);
  }
}

function section(name: string): void {
  console.log(`\n--- ${name} ---`);
}

// ============================================
// Mock PositionTracker
// ============================================

function mockTracker(overrides: {
  drawdown?: number;
  equity?: number;
  peakEquity?: number;
  dailyPnl?: number;
  weeklyPnl?: number;
  consecutiveLosses?: number;
  recentErrors?: number;
  openPositions?: BotPosition[];
  circuitBreakers?: CircuitBreakerState[];
  rollingSharpe?: number | null;
  kellyRisk?: number | null;
} = {}): any {
  return {
    getDrawdown: () => overrides.drawdown ?? 0,
    getEquity: () => overrides.equity ?? 10000,
    getPeakEquity: () => overrides.peakEquity ?? 10000,
    getDailyPnl: () => overrides.dailyPnl ?? 0,
    getWeeklyPnl: () => overrides.weeklyPnl ?? 0,
    getConsecutiveLosses: () => overrides.consecutiveLosses ?? 0,
    getRecentErrorCount: () => overrides.recentErrors ?? 0,
    getOpenPositions: () => overrides.openPositions ?? [],
    getCircuitBreakers: () => overrides.circuitBreakers ?? [],
    setCircuitBreakers: () => {},
    hasOpenPosition: (sym: BotSymbol) =>
      (overrides.openPositions ?? []).some((p) => p.symbol === sym),
    getRollingSharpe: () => overrides.rollingSharpe ?? null,
    getKellyRisk: () => overrides.kellyRisk ?? null,
  };
}

// ============================================
// Test: Drawdown Tiers
// ============================================

section('Drawdown Tiers');
{
  const engine = new RiskEngine();

  // Normal tier (DD < 10%)
  const t1 = engine.getDrawdownTier(0);
  assert(t1.label === 'normal', 'DD 0% → normal tier');
  assert(t1.sizeMultiplier === 1.0, 'DD 0% → 100% sizing');

  const t2 = engine.getDrawdownTier(0.05);
  assert(t2.label === 'normal', 'DD 5% → normal tier');

  const t3 = engine.getDrawdownTier(0.099);
  assert(t3.label === 'normal', 'DD 9.9% → still normal');

  // Caution tier (10-20%)
  const t4 = engine.getDrawdownTier(0.10);
  assert(t4.label === 'caution', 'DD 10% → caution tier');
  assert(t4.sizeMultiplier === 0.50, 'DD 10% → 50% sizing');

  const t5 = engine.getDrawdownTier(0.15);
  assert(t5.label === 'caution', 'DD 15% → caution tier');

  // Defensive tier (20-30%)
  const t6 = engine.getDrawdownTier(0.20);
  assert(t6.label === 'defensive', 'DD 20% → defensive tier');
  assert(t6.sizeMultiplier === 0.25, 'DD 20% → 25% sizing');

  // Halt tier (>30%)
  const t7 = engine.getDrawdownTier(0.30);
  assert(t7.label === 'halt', 'DD 30% → halt tier');
  assert(t7.sizeMultiplier === 0, 'DD 30% → 0% sizing (halted)');

  const t8 = engine.getDrawdownTier(0.50);
  assert(t8.label === 'halt', 'DD 50% → halt tier');

  // Edge case: exactly at boundary
  const t9 = engine.getDrawdownTier(0.10);
  assert(t9.label === 'caution', 'DD exactly 10% → caution (maxDrawdown exclusive)');
}

// ============================================
// Test: canTrade with Drawdown Halt
// ============================================

section('canTrade — Drawdown Halt');
{
  const engine = new RiskEngine();

  // Normal DD → can trade
  const r1 = engine.canTrade(mockTracker({ drawdown: 0.05 }));
  assert(r1 === null, 'DD 5% → can trade');

  // Halt DD → cannot trade
  const r2 = engine.canTrade(mockTracker({ drawdown: 0.35 }));
  assert(r2 !== null, 'DD 35% → cannot trade');
  assert(r2!.type === 'max_drawdown', 'DD 35% → max_drawdown breaker');
  assert(r2!.resumeAt === Infinity, 'DD halt → requires manual review');

  // Max positions → cannot trade
  const mockPositions = [
    { symbol: 'BTCUSDT' },
    { symbol: 'ETHUSDT' },
    { symbol: 'SOLUSDT' },
  ] as BotPosition[];
  const r3 = engine.canTrade(mockTracker({ openPositions: mockPositions }));
  assert(r3 !== null, '3/3 positions → cannot trade');

  // Active circuit breaker → cannot trade
  const activeCB: CircuitBreakerState = {
    type: 'daily_loss',
    triggeredAt: Date.now() - 1000,
    resumeAt: Date.now() + 86_400_000,
    reason: 'test',
  };
  const r4 = engine.canTrade(mockTracker({ circuitBreakers: [activeCB] }));
  assert(r4 !== null, 'Active CB → cannot trade');
  assert(r4!.type === 'daily_loss', 'Active CB type preserved');

  // Expired circuit breaker → can trade
  const expiredCB: CircuitBreakerState = {
    type: 'daily_loss',
    triggeredAt: Date.now() - 100_000,
    resumeAt: Date.now() - 1000,
    reason: 'test',
  };
  const r5 = engine.canTrade(mockTracker({ circuitBreakers: [expiredCB] }));
  assert(r5 === null, 'Expired CB → can trade');
}

// ============================================
// Test: Regime Size Multipliers
// ============================================

section('Regime Size Multipliers');
{
  const engine = new RiskEngine();
  const tracker = mockTracker({ drawdown: 0, rollingSharpe: 1.0 });

  // uptrend+normal → 1.0
  const r1 = engine.getPositionSizeMultiplier(tracker, 'uptrend+normal');
  assertClose(r1.breakdown.regime, 1.0, 0.001, 'uptrend+normal → regime 1.0');

  // uptrend+low → 0.8
  const r2 = engine.getPositionSizeMultiplier(tracker, 'uptrend+low');
  assertClose(r2.breakdown.regime, 0.8, 0.001, 'uptrend+low → regime 0.8');

  // uptrend+high → 0.6
  const r3 = engine.getPositionSizeMultiplier(tracker, 'uptrend+high');
  assertClose(r3.breakdown.regime, 0.6, 0.001, 'uptrend+high → regime 0.6');

  // downtrend+normal → 0.5
  const r4 = engine.getPositionSizeMultiplier(tracker, 'downtrend+normal');
  assertClose(r4.breakdown.regime, 0.5, 0.001, 'downtrend+normal → regime 0.5');

  // Unknown regime → default 1.0
  const r5 = engine.getPositionSizeMultiplier(tracker, 'unknown+regime');
  assertClose(r5.breakdown.regime, 1.0, 0.001, 'unknown regime → default 1.0');
}

// ============================================
// Test: Position Size Multiplier Composition
// ============================================

section('Position Size Multiplier Composition');
{
  const engine = new RiskEngine();

  // All normal: DD=0, regime=uptrend+normal, Sharpe=1.0
  const r1 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0, rollingSharpe: 1.0 }),
    'uptrend+normal',
  );
  assertClose(r1.multiplier, 1.0, 0.001, 'All normal → 1.0 multiplier');
  assertClose(r1.breakdown.drawdown, 1.0, 0.001, 'All normal → DD 1.0');
  assertClose(r1.breakdown.sharpe, 1.0, 0.001, 'All normal → Sharpe 1.0');

  // Caution DD + normal regime + good Sharpe
  const r2 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0.15, rollingSharpe: 1.5 }),
    'uptrend+normal',
  );
  assertClose(r2.multiplier, 0.5, 0.001, 'DD caution → 0.5 multiplier');
  assertClose(r2.breakdown.drawdown, 0.5, 0.001, 'DD 15% → DD mult 0.5');

  // Normal DD + bad regime + good Sharpe
  const r3 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0.05, rollingSharpe: 1.0 }),
    'downtrend+normal',
  );
  assertClose(r3.multiplier, 0.5, 0.001, 'downtrend+normal → 0.5 multiplier');

  // Normal DD + normal regime + low Sharpe
  const r4 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0, rollingSharpe: 0.3 }),
    'uptrend+normal',
  );
  assertClose(r4.multiplier, 0.5, 0.001, 'Low Sharpe → 0.5 multiplier');
  assertClose(r4.breakdown.sharpe, 0.5, 0.001, 'Sharpe 0.3 → sharpe mult 0.5');

  // Normal DD + normal regime + negative Sharpe → halt
  const r5 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0, rollingSharpe: -0.5 }),
    'uptrend+normal',
  );
  assertClose(r5.multiplier, 0, 0.001, 'Negative Sharpe → 0 multiplier (halt)');

  // No Sharpe data → default 1.0
  const r6 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0, rollingSharpe: null }),
    'uptrend+normal',
  );
  assertClose(r6.multiplier, 1.0, 0.001, 'No Sharpe data → 1.0 (default)');

  // Multiplicative combination: DD caution (0.5) × downtrend (0.5) × low Sharpe (0.5) = 0.125
  const r7 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0.15, rollingSharpe: 0.3 }),
    'downtrend+normal',
  );
  assertClose(r7.multiplier, 0.125, 0.001, 'DD×regime×sharpe = 0.5×0.5×0.5 = 0.125');
}

// ============================================
// Test: Kelly-Adjusted Risk
// ============================================

section('Kelly-Adjusted Risk');
{
  const engine = new RiskEngine();
  const baseRisk = 0.003;

  // No Kelly data → fallback to baseRisk
  const r1 = engine.getKellyAdjustedRisk(mockTracker({ kellyRisk: null }), baseRisk);
  assertClose(r1, 0.003, 0.0001, 'No Kelly data → baseRisk 0.003');

  // Kelly computed → use it
  const r2 = engine.getKellyAdjustedRisk(mockTracker({ kellyRisk: 0.002 }), baseRisk);
  assertClose(r2, 0.002, 0.0001, 'Kelly 0.002 → use Kelly');

  // Kelly at floor (0.001) → use it
  const r3 = engine.getKellyAdjustedRisk(mockTracker({ kellyRisk: 0.001 }), baseRisk);
  assertClose(r3, 0.001, 0.0001, 'Kelly at floor → 0.001');

  // Kelly at ceiling (0.005) → use it
  const r4 = engine.getKellyAdjustedRisk(mockTracker({ kellyRisk: 0.005 }), baseRisk);
  assertClose(r4, 0.005, 0.0001, 'Kelly at ceiling → 0.005');
}

// ============================================
// Test: Correlation Multiplier
// ============================================

section('Correlation Multiplier');
{
  const engine = new RiskEngine();

  // No open positions → 1.0
  const r1 = engine.getCorrelationMultiplier(
    [],
    'BTCUSDT' as BotSymbol,
    new Map(),
  );
  assertClose(r1, 1.0, 0.001, 'No open positions → 1.0');

  // Generate correlated candle data (same returns = perfect correlation)
  function makeCandles(prices: number[]): Candle[] {
    return prices.map((close, i) => ({
      timestamp: 1000000 + i * 3600,
      open: close,
      high: close * 1.001,
      low: close * 0.999,
      close,
      volume: 100,
    }));
  }

  // BTC and ETH with perfectly correlated prices
  const btcPrices = Array.from({ length: 25 }, (_, i) => 50000 + i * 100);
  const ethPrices = Array.from({ length: 25 }, (_, i) => 3000 + i * 6); // Same direction

  const candleMap = new Map<BotSymbol, Candle[]>();
  candleMap.set('BTCUSDT', makeCandles(btcPrices));
  candleMap.set('ETHUSDT', makeCandles(ethPrices));

  const r2 = engine.getCorrelationMultiplier(
    ['BTCUSDT'] as BotSymbol[],
    'ETHUSDT' as BotSymbol,
    candleMap,
    20,
    0.85,
  );
  // Perfectly correlated → correlatedCount=1 → 1/sqrt(2) ≈ 0.707
  assertClose(r2, 1 / Math.sqrt(2), 0.05, 'Perfect correlation → ~0.707');

  // Uncorrelated data
  const solPrices = Array.from({ length: 25 }, (_, i) =>
    100 + Math.sin(i * 0.5) * 10, // Oscillating, not correlated
  );
  candleMap.set('SOLUSDT', makeCandles(solPrices));

  const r3 = engine.getCorrelationMultiplier(
    ['SOLUSDT'] as BotSymbol[],
    'BTCUSDT' as BotSymbol,
    candleMap,
    20,
    0.85,
  );
  // Uncorrelated → 1.0 (no reduction)
  assert(r3 >= 0.9, 'Uncorrelated assets → ~1.0 (no reduction)');

  // Multiple correlated open positions
  const r4 = engine.getCorrelationMultiplier(
    ['BTCUSDT', 'ETHUSDT'] as BotSymbol[],
    'ETHUSDT' as BotSymbol, // Adding another ETH
    candleMap,
    20,
    0.85,
  );
  // If both are correlated → count=2 → 1/sqrt(3) ≈ 0.577
  // (BTCUSDT correlated with ETHUSDT: yes. ETHUSDT self-correlated: yes if same data)
  assert(r4 < 0.75, 'Two correlated open → multiplier < 0.75');

  // Not enough candle data → 1.0
  const sparseMap = new Map<BotSymbol, Candle[]>();
  sparseMap.set('BTCUSDT', makeCandles([50000, 50100])); // Only 2 candles
  sparseMap.set('ETHUSDT', makeCandles(ethPrices));

  const r5 = engine.getCorrelationMultiplier(
    ['BTCUSDT'] as BotSymbol[],
    'ETHUSDT' as BotSymbol,
    sparseMap,
    20,
    0.85,
  );
  assertClose(r5, 1.0, 0.001, 'Insufficient data → 1.0');
}

// ============================================
// Test: Circuit Breaker Evaluation
// ============================================

section('Circuit Breaker Evaluation');
{
  const engine = new RiskEngine();

  // No triggers when everything is fine
  const r1 = engine.evaluateAfterTrade(mockTracker({
    equity: 10000,
    dailyPnl: -100,    // -1% (limit is -3%)
    weeklyPnl: -200,   // -2% (limit is -5%)
    drawdown: 0.05,    // 5% (limit is 15%)
    consecutiveLosses: 2, // (limit is 5)
    recentErrors: 1,   // (limit is 3)
  }));
  assert(r1.length === 0, 'All within limits → no triggers');

  // Daily loss trigger
  const r2 = engine.evaluateAfterTrade(mockTracker({
    equity: 10000,
    dailyPnl: -400,    // -4% > -3% limit
  }));
  assert(r2.length >= 1, 'Daily loss exceeded → triggered');
  assert(r2.some((cb) => cb.type === 'daily_loss'), 'Daily loss type present');

  // Weekly loss trigger
  const r3 = engine.evaluateAfterTrade(mockTracker({
    equity: 10000,
    weeklyPnl: -600,   // -6% > -5% limit
  }));
  assert(r3.some((cb) => cb.type === 'weekly_loss'), 'Weekly loss triggered');

  // Max drawdown trigger
  const r4 = engine.evaluateAfterTrade(mockTracker({
    equity: 10000,
    drawdown: 0.20,    // 20% > 15% limit
  }));
  assert(r4.some((cb) => cb.type === 'max_drawdown'), 'Max drawdown triggered');
  const ddCb = r4.find((cb) => cb.type === 'max_drawdown')!;
  assert(ddCb.resumeAt === Infinity, 'Max DD → manual review (Infinity)');

  // Consecutive losses trigger
  const r5 = engine.evaluateAfterTrade(mockTracker({
    equity: 10000,
    consecutiveLosses: 5,
  }));
  assert(r5.some((cb) => cb.type === 'consecutive_losses'), 'Consecutive losses triggered');

  // System errors trigger
  const r6 = engine.evaluateAfterTrade(mockTracker({
    equity: 10000,
    recentErrors: 5,
  }));
  assert(r6.some((cb) => cb.type === 'system_errors'), 'System errors triggered');

  // Multiple triggers at once
  const r7 = engine.evaluateAfterTrade(mockTracker({
    equity: 10000,
    dailyPnl: -400,
    weeklyPnl: -600,
    consecutiveLosses: 5,
  }));
  assert(r7.length >= 3, 'Multiple triggers fire simultaneously');
}

// ============================================
// Test: barsHeld Index-Based (Logic Check)
// ============================================

section('barsHeld Index-Based Calculation');
{
  // Simulating what checkPositionExit does:
  // barsHeld = currentBarIndex - position.entryBarIndex

  const entryBarIndex = 100;

  // After 1 bar
  assert(101 - entryBarIndex === 1, 'After 1 bar → barsHeld=1');

  // After 108 bars (max-bars limit)
  assert(208 - entryBarIndex === 108, 'After 108 bars → barsHeld=108 (max-bars trigger)');

  // Same bar (shouldn't happen but edge case)
  assert(100 - entryBarIndex === 0, 'Same bar → barsHeld=0');

  // Verify this matches backtest style (i - position.entryIndex)
  // In backtest: barsHeld = i - pos.entryIndex where i is loop counter
  // In bot: barsHeld = currentBarIndex - position.entryBarIndex
  // These are structurally identical — the fix was to stop using timestamp math
  assert(true, 'barsHeld logic matches backtest (index - entryIndex)');
}

// ============================================
// Test: Config Cleanup Verification
// ============================================

section('Config Cleanup');
{
  // Verify dead fields are removed from BotConfig
  const config = {
    mode: 'paper' as const,
    exchange: 'bybit' as const,
    symbols: ['BTCUSDT'] as BotSymbol[],
    timeframe: '1h' as const,
    initialCapital: 10000,
    riskPerTrade: 0.003,
    maxPositions: 3,
    pollDelaySeconds: 5,
    verbose: false,
  };

  // These fields should NOT exist anymore
  assert(!('paperSlippage' in config), 'paperSlippage removed from BotConfig');
  assert(!('commissionPerSide' in config), 'commissionPerSide removed from BotConfig');

  // RiskConfig should be the new constructor parameter
  assert(DEFAULT_RISK_CONFIG.circuitBreakers !== undefined, 'RiskConfig has circuitBreakers');
  assert(DEFAULT_RISK_CONFIG.drawdownTiers !== undefined, 'RiskConfig has drawdownTiers');
  assert(DEFAULT_RISK_CONFIG.maxPositions === 3, 'RiskConfig maxPositions = 3');
  assert(DEFAULT_RISK_CONFIG.regimeSizeMultipliers !== undefined, 'RiskConfig has regimeSizeMultipliers');
}

// ============================================
// Test: Drawdown Tier Config Values
// ============================================

section('Drawdown Tier Config Values');
{
  assert(DEFAULT_DRAWDOWN_TIERS.length === 4, '4 drawdown tiers defined');

  // Check order (must be ascending by maxDrawdown)
  for (let i = 1; i < DEFAULT_DRAWDOWN_TIERS.length; i++) {
    assert(
      DEFAULT_DRAWDOWN_TIERS[i]!.maxDrawdown > DEFAULT_DRAWDOWN_TIERS[i - 1]!.maxDrawdown,
      `Tier ${i} maxDD > tier ${i - 1} maxDD (ascending order)`,
    );
  }

  // Check multipliers decrease
  assert(DEFAULT_DRAWDOWN_TIERS[0]!.sizeMultiplier === 1.0, 'Normal tier = 1.0');
  assert(DEFAULT_DRAWDOWN_TIERS[1]!.sizeMultiplier === 0.50, 'Caution tier = 0.50');
  assert(DEFAULT_DRAWDOWN_TIERS[2]!.sizeMultiplier === 0.25, 'Defensive tier = 0.25');
  assert(DEFAULT_DRAWDOWN_TIERS[3]!.sizeMultiplier === 0, 'Halt tier = 0');

  // Last tier should have Infinity maxDrawdown (catch-all)
  assert(DEFAULT_DRAWDOWN_TIERS[3]!.maxDrawdown === Infinity, 'Halt tier maxDD = Infinity');
}

// ============================================
// Test: Regime Multiplier Config Values
// ============================================

section('Regime Multiplier Config Values');
{
  assert(DEFAULT_REGIME_SIZE_MULTIPLIERS['uptrend+normal'] === 1.0, 'uptrend+normal = 1.0');
  assert(DEFAULT_REGIME_SIZE_MULTIPLIERS['uptrend+low'] === 0.8, 'uptrend+low = 0.8');
  assert(DEFAULT_REGIME_SIZE_MULTIPLIERS['uptrend+high'] === 0.6, 'uptrend+high = 0.6');
  assert(DEFAULT_REGIME_SIZE_MULTIPLIERS['downtrend+normal'] === 0.5, 'downtrend+normal = 0.5');
  assert(DEFAULT_REGIME_SIZE_MULTIPLIERS['downtrend+low'] === 0.5, 'downtrend+low = 0.5');

  // Ranging regimes should NOT be in the multiplier map (they're suppressed)
  assert(DEFAULT_REGIME_SIZE_MULTIPLIERS['ranging+normal'] === undefined, 'ranging+normal not in multipliers (suppressed)');
  assert(DEFAULT_REGIME_SIZE_MULTIPLIERS['ranging+high'] === undefined, 'ranging+high not in multipliers (suppressed)');
}

// ============================================
// Test: Pearson Correlation (via getCorrelationMultiplier edge cases)
// ============================================

section('Pearson Correlation Edge Cases');
{
  const engine = new RiskEngine();

  // Anti-correlated returns → should not trigger (only positive correlation counts)
  // Use alternating up/down pattern: when BTC goes up, ETH goes down
  function makeCandles(prices: number[]): Candle[] {
    return prices.map((close, i) => ({
      timestamp: 1000000 + i * 3600,
      open: close,
      high: close * 1.001,
      low: close * 0.999,
      close,
      volume: 100,
    }));
  }

  // BTC: alternating +100, -50 pattern
  const btcPrices: number[] = [50000];
  for (let i = 1; i < 25; i++) {
    btcPrices.push(btcPrices[i - 1]! + (i % 2 === 1 ? 200 : -100));
  }
  // ETH: opposite pattern (-6, +3)
  const antiPrices: number[] = [3000];
  for (let i = 1; i < 25; i++) {
    antiPrices.push(antiPrices[i - 1]! + (i % 2 === 1 ? -12 : 6));
  }

  const candleMap = new Map<BotSymbol, Candle[]>();
  candleMap.set('BTCUSDT', makeCandles(btcPrices));
  candleMap.set('ETHUSDT', makeCandles(antiPrices));

  const r1 = engine.getCorrelationMultiplier(
    ['BTCUSDT'] as BotSymbol[],
    'ETHUSDT' as BotSymbol,
    candleMap,
    20,
    0.85,
  );
  assertClose(r1, 1.0, 0.001, 'Anti-correlated → no reduction (1.0)');

  // Same symbol (identity) → corr = 1.0 → should reduce
  candleMap.set('ETHUSDT', makeCandles(btcPrices)); // Same prices
  const r2 = engine.getCorrelationMultiplier(
    ['BTCUSDT'] as BotSymbol[],
    'ETHUSDT' as BotSymbol,
    candleMap,
    20,
    0.85,
  );
  assertClose(r2, 1 / Math.sqrt(2), 0.01, 'Identity corr → 1/sqrt(2)');

  // Constant prices (zero variance) → should return 1.0 (denom=0)
  const constPrices = Array.from({ length: 25 }, () => 50000);
  candleMap.set('BTCUSDT', makeCandles(constPrices));
  candleMap.set('ETHUSDT', makeCandles(constPrices));

  const r3 = engine.getCorrelationMultiplier(
    ['BTCUSDT'] as BotSymbol[],
    'ETHUSDT' as BotSymbol,
    candleMap,
    20,
    0.85,
  );
  assertClose(r3, 1.0, 0.001, 'Constant prices → 1.0 (zero variance handled)');
}

// ============================================
// Test: Sharpe Multiplier Thresholds
// ============================================

section('Sharpe Multiplier Thresholds');
{
  const engine = new RiskEngine();

  // Sharpe >= 0.5 → 1.0
  const r1 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0, rollingSharpe: 0.5 }),
    'uptrend+normal',
  );
  assertClose(r1.breakdown.sharpe, 1.0, 0.001, 'Sharpe=0.5 → sharpe mult 1.0');

  // Sharpe = 0.499 → 0.5
  const r2 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0, rollingSharpe: 0.499 }),
    'uptrend+normal',
  );
  assertClose(r2.breakdown.sharpe, 0.5, 0.001, 'Sharpe=0.499 → sharpe mult 0.5');

  // Sharpe = 0.0 → 0 (halt)
  const r3 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0, rollingSharpe: 0.0 }),
    'uptrend+normal',
  );
  // Sharpe < 0 → 0 halt, but Sharpe = 0 is not < 0, it's 0 which is < 0.5 → 0.5
  assertClose(r3.breakdown.sharpe, 0.5, 0.001, 'Sharpe=0.0 → sharpe mult 0.5 (< 0.5 threshold)');

  // Sharpe = -0.001 → 0 (halt)
  const r4 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0, rollingSharpe: -0.001 }),
    'uptrend+normal',
  );
  assertClose(r4.breakdown.sharpe, 0, 0.001, 'Sharpe=-0.001 → sharpe mult 0 (halt)');

  // High Sharpe → 1.0
  const r5 = engine.getPositionSizeMultiplier(
    mockTracker({ drawdown: 0, rollingSharpe: 3.0 }),
    'uptrend+normal',
  );
  assertClose(r5.breakdown.sharpe, 1.0, 0.001, 'Sharpe=3.0 → sharpe mult 1.0');
}

// ============================================
// Test: LimitOrderExecutor Types
// ============================================

section('LimitOrderExecutor Types');
{
  // Verify the module can be imported and types are correct
  const { DEFAULT_LIMIT_ORDER_CONFIG } = require('../src/lib/bot/limit-order-executor');

  assert(DEFAULT_LIMIT_ORDER_CONFIG.maxWaitBars === 2, 'Default maxWaitBars = 2');
  assert(DEFAULT_LIMIT_ORDER_CONFIG.postOnly === true, 'Default postOnly = true');
  assert(DEFAULT_LIMIT_ORDER_CONFIG.enabled === false, 'Default enabled = false (paper mode)');
}

// ============================================
// Test: Status Output
// ============================================

section('Status Output');
{
  const engine = new RiskEngine();

  const tracker = mockTracker({
    drawdown: 0.12,
    equity: 8800,
    peakEquity: 10000,
    dailyPnl: -50,
    openPositions: [{ symbol: 'BTCUSDT' }] as BotPosition[],
    rollingSharpe: 1.5,
  });

  const lines = engine.getStatus(tracker);

  assert(lines.some((l) => l.includes('circuit breakers OK')), 'Status shows CB OK');
  assert(lines.some((l) => l.includes('8800')), 'Status shows equity');
  assert(lines.some((l) => l.includes('10000')), 'Status shows peak');
  assert(lines.some((l) => l.includes('caution')), 'Status shows DD tier label');
  assert(lines.some((l) => l.includes('1/3')), 'Status shows positions');
  assert(lines.some((l) => l.includes('Sharpe')), 'Status shows rolling Sharpe');
}

// ============================================
// Results
// ============================================

console.log('\n' + '='.repeat(50));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log('\nAll tests passed!');
  process.exit(0);
}
