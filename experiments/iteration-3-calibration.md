# Iteration 3: Threshold & Weight Calibration

Run: 2026-02-07T16:23:19.166Z
Symbols: BTCUSDT, ETHUSDT, SOLUSDT

## Hypothesis

Weights and threshold can be tuned using walk-forward cross-validation with a maximin objective (maximize worst-case window Sharpe, not average).

## Phase 1: Threshold Search

Objective: max(min(window_sharpe))

| Threshold | Min Sharpe | Avg Sharpe | Std Sharpe | Pass Rate | Windows | Trades |
|-----------|------------|------------|------------|-----------|---------|--------|
| 3.0 | -748.74 | -31.74 | 88.78 | 17.2% | 17/99 | 1562 |
| 3.5 | -748.74 | -32.37 | 89.11 | 18.2% | 18/99 | 1554 |
| 4.0 | -849.03 | -41.52 | 112.84 | 19.2% | 19/99 | 1269 |
| 4.5 | -3019.61 | -92.28 | 341.94 | 26.3% | 26/99 | 1057 |
| 5.0 | -4552.27 | -150.38 | 567.13 | 32.3% | 32/99 | 983 |
| 5.5 | -4552.27 | -151.11 | 566.97 | 33.3% | 33/99 | 954 |
| 6.0 | -9933.83 | -202.88 | 1006.95 | 23.2% | 23/99 | 417 |

### Best Threshold: 3

- Min Sharpe: -748.7411
- Avg Sharpe: -31.7423
- Reasoning: Selected threshold 3.0 with maximin objective. Worst-case window Sharpe: -748.74 (highest among all candidates).

## Phase 2: Weight Sensitivity

_Skipped (--skip-sensitivity flag)_

## Stability Assessment

NEGATIVE: Best threshold (3) has negative worst-case Sharpe (-748.74). No threshold configuration fully prevents losing windows.

## Decision

PIVOT: No threshold/weight combination yields reliable positive performance. Re-evaluate the confluence factors or underlying strategy signals.

## Key Learnings

_(Fill in after reviewing results)_

## Impact on Next Iteration

_(Fill in after reviewing results)_
