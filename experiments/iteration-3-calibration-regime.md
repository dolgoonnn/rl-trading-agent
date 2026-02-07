# Iteration 3: Threshold & Weight Calibration

Run: 2026-02-07T16:07:04.655Z
Symbols: BTCUSDT, ETHUSDT, SOLUSDT

## Hypothesis

Weights and threshold can be tuned using walk-forward cross-validation with a maximin objective (maximize worst-case window Sharpe, not average).

## Phase 1: Threshold Search

Objective: max(min(window_sharpe))

| Threshold | Min Sharpe | Avg Sharpe | Std Sharpe | Pass Rate | Windows | Trades |
|-----------|------------|------------|------------|-----------|---------|--------|
| 3.0 | -84.26 | -11.16 | 17.84 | 27.3% | 27/99 | 2479 |
| 3.5 | -70.96 | -12.44 | 16.92 | 22.2% | 22/99 | 2356 |
| 4.0 | -63.57 | -13.59 | 16.99 | 19.2% | 19/99 | 2265 |
| 4.5 | -65.80 | -14.09 | 17.97 | 25.3% | 25/99 | 1952 |
| 5.0 | -103.41 | -15.63 | 22.41 | 28.3% | 28/99 | 1695 |
| 5.5 | -305.90 | -22.13 | 39.46 | 18.2% | 18/99 | 1449 |
| 6.0 | -562.18 | -37.35 | 84.55 | 24.2% | 24/99 | 1218 |

### Best Threshold: 4

- Min Sharpe: -63.5694
- Avg Sharpe: -13.5882
- Reasoning: Selected threshold 4.0 with maximin objective. Worst-case window Sharpe: -63.57 (highest among all candidates). Note: 2 threshold(s) had higher average Sharpe but worse worst-case. Maximin prevents trading off bad windows for good ones.

## Phase 2: Weight Sensitivity

_Skipped (--skip-sensitivity flag)_

## Stability Assessment

NEGATIVE: Best threshold (4) has negative worst-case Sharpe (-63.57). No threshold configuration fully prevents losing windows.

## Decision

PIVOT: No threshold/weight combination yields reliable positive performance. Re-evaluate the confluence factors or underlying strategy signals.

## Key Learnings

_(Fill in after reviewing results)_

## Impact on Next Iteration

_(Fill in after reviewing results)_
