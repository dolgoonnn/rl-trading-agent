# Iteration 13: Threshold Calibration

## Hypothesis
With dynamic_rr SL and expanded 3-regime suppression, the optimal threshold may have shifted from 4.0.

## Method
Calibrate script with maximin objective (maximize worst-case window Sharpe) across thresholds [3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0].

## Config
- Strategy: OB-only
- SL mode: dynamic_rr
- Friction: 0.07% per side (maker)
- Suppress: ranging+normal, ranging+high, downtrend+high

## Calibration Results (Simple Position Sim)

| Threshold | Min Sharpe | Avg Sharpe | Pass Rate | Trades |
|-----------|------------|------------|-----------|--------|
| 3.0 | -164.7 | +0.74 | 49.0% | 840 |
| 3.5 | -178.0 | +3.21 | 53.1% | 803 |
| **4.0** | -389.2 | -3.37 | **51.0%** | 755 |
| **4.5** | -389.2 | -2.27 | **55.8%** | 711 |
| 5.0 | -389.2 | -4.75 | 50.0% | 640 |
| 5.5 | -389.2 | -9.19 | 45.7% | 590 |
| 6.0 | -774.1 | -11.78 | 41.9% | 494 |

Maximin selects threshold 3.0 (best worst-case: -164.7). But pass rate is only 49.0%.

## Verification with Full Backtest (Enhanced Exits)

| Threshold | Pass Rate | Trades | PnL |
|-----------|-----------|--------|-----|
| 4.0 (enhanced) | **54.6%** | 823 | -28.1% |
| 4.5 (enhanced) | 50.5% | 778 | -16.0% |
| 4.0 (simple) | **54.6%** | 748 | **+9.7%** |

## Key Findings

1. **Calibration's simple sim disagrees with backtest's enhanced sim** — different position management → different results
2. **Threshold 4.0 remains optimal** in full backtest: 54.6% pass rate (tied with simple exits)
3. **Simple exits flip PnL positive** (+9.7% vs -28.1% enhanced) while maintaining same pass rate
4. Threshold 4.5 drops pass rate with enhanced exits (50.5%), not an improvement

## Decision

Keep **threshold 4.0**. Use **simple exits** for production (same pass rate, positive PnL).

---
_Generated: 2026-02-08_
