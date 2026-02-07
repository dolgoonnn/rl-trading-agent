# Iteration 3: Threshold & Weight Calibration

Run: 2026-02-07T16:54:25.788Z
Symbols: BTCUSDT, ETHUSDT, SOLUSDT

## Hypothesis

Weights and threshold can be tuned using walk-forward cross-validation with a maximin objective (maximize worst-case window Sharpe, not average).

## Phase 1: Threshold Search

Objective: max(min(window_sharpe))

| Threshold | Min Sharpe | Avg Sharpe | Std Sharpe | Pass Rate | Windows | Trades |
|-----------|------------|------------|------------|-----------|---------|--------|
| 3.0 | -633.43 | -39.39 | 139.38 | 39.4% | 39/99 | 563 |
| 3.5 | -775.57 | -29.04 | 126.14 | 41.4% | 41/99 | 476 |
| 4.0 | -775.57 | -19.85 | 112.11 | 40.4% | 40/99 | 422 |
| 4.5 | -767.73 | -19.11 | 139.07 | 32.3% | 32/99 | 357 |
| 5.0 | -919.15 | -1.56 | 345.96 | 20.2% | 20/99 | 275 |
| 5.5 | -1116.67 | -32.78 | 150.70 | 3.0% | 3/99 | 61 |
| 6.0 | 0.00 | 0.00 | 0.00 | 0.0% | 0/99 | 3 |

### Best Threshold: 6

- Min Sharpe: 0.0000
- Avg Sharpe: 0.0000
- Reasoning: Selected threshold 6.0 with maximin objective. Worst-case window Sharpe: 0.00 (highest among all candidates). Low trade count (3 across 99 windows). Results may be noisy due to small sample size.

## Phase 2: Weight Sensitivity

_Skipped (--skip-sensitivity flag)_

## Stability Assessment

NEGATIVE: Best threshold (6) has negative worst-case Sharpe (0.00). No threshold configuration fully prevents losing windows.

## Decision

PIVOT: No threshold/weight combination yields reliable positive performance. Re-evaluate the confluence factors or underlying strategy signals.

## Key Learnings

_(Fill in after reviewing results)_

## Impact on Next Iteration

_(Fill in after reviewing results)_
