# Iteration 3: Threshold & Weight Calibration

Run: 2026-02-07T18:57:17.856Z
Symbols: BTCUSDT, ETHUSDT, SOLUSDT

## Hypothesis

Weights and threshold can be tuned using walk-forward cross-validation with a maximin objective (maximize worst-case window Sharpe, not average).

## Phase 1: Threshold Search

Objective: max(min(window_sharpe))

| Threshold | Min Sharpe | Avg Sharpe | Std Sharpe | Pass Rate | Windows | Trades |
|-----------|------------|------------|------------|-----------|---------|--------|
| 3.0 | -164.69 | 0.74 | 47.20 | 49.0% | 48/98 | 840 |
| 3.5 | -177.97 | 3.21 | 47.86 | 53.1% | 52/98 | 803 |
| 4.0 | -389.21 | -3.37 | 69.15 | 51.0% | 49/96 | 755 |
| 4.5 | -389.21 | -2.27 | 83.90 | 55.8% | 53/95 | 711 |
| 5.0 | -389.21 | -4.75 | 78.60 | 50.0% | 47/94 | 640 |
| 5.5 | -389.21 | -9.19 | 87.12 | 45.7% | 43/94 | 590 |
| 6.0 | -774.11 | -11.78 | 111.52 | 41.9% | 39/93 | 494 |

### Best Threshold: 3

- Min Sharpe: -164.6890
- Avg Sharpe: 0.7363
- Reasoning: Selected threshold 3.0 with maximin objective. Worst-case window Sharpe: -164.69 (highest among all candidates). Note: 1 threshold(s) had higher average Sharpe but worse worst-case. Maximin prevents trading off bad windows for good ones.

## Phase 2: Weight Sensitivity

_Skipped (--skip-sensitivity flag)_

## Stability Assessment

NEGATIVE: Best threshold (3) has negative worst-case Sharpe (-164.69). No threshold configuration fully prevents losing windows.

## Decision

ADJUST: Average performance is positive but worst-case is negative. The system may need position management improvements (Iteration 4) to cap losses.

## Key Learnings

_(Fill in after reviewing results)_

## Impact on Next Iteration

_(Fill in after reviewing results)_
