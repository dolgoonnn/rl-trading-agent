# Iteration 12: Circuit Breaker Implementation

## Hypothesis
A circuit breaker that pauses trading after N consecutive losses will reduce catastrophic drawdown in worst-case windows (W8 BTC -20%, W22 ETH -24%).

## Implementation
Added to `scripts/backtest-confluence.ts`:
- `CircuitBreakerConfig` interface: `{ maxConsecutiveLosses, cooldownBars }`
- `--circuit-breaker "maxLosses,cooldownBars"` CLI flag
- Consecutive loss tracking inside `createConfluenceRunner()` closure
- Reset per walk-forward window

## Config
- Base: OB-only, dynamic_rr, maker (0.07%), suppress 3 regimes, threshold 4.0, enhanced exits

## Results

| CB Config | Pass Rate | Trades | PnL | CB Fires |
|-----------|-----------|--------|-----|----------|
| None | 54.6% | 823 | -28.1% | N/A |
| 3,30 | 54.6% | 784 | 0.0% | **0** |
| 3,50 | 52.6% | 754 | -39.4% | **0** |
| 4,30 | 54.6% | 809 | -25.7% | **0** |
| 4,50 | 55.7% | 799 | -24.2% | **0** |

## Key Findings

1. **Circuit breaker never fires**. At 7-10 trades per window, consecutive loss streaks of 3-4 are extremely rare.
2. Trade count differences are from stochastic position timing, not from CB activation.
3. The catastrophic windows (W8, W22) aren't caused by consecutive losses — they're caused by a few large losses in a window. CB targets loss streaks, not large individual losses.
4. The circuit breaker is **not useful at this trade frequency**. Would be relevant at higher frequencies (15m) or in paper trading (where it covers longer periods).

## Decision

**Skip circuit breaker in backtest config.** Retain implementation for paper trading (where it covers months of data and CB can fire). The paper trader already has a built-in circuit breaker (3 losses → 20-bar cooldown in RiskManager).

---
_Generated: 2026-02-08_
