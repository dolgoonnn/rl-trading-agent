# Iteration 3: Threshold & Weight Calibration

Run: 2026-02-07T17:05:30.967Z
Symbols: BTCUSDT, ETHUSDT, SOLUSDT

## Hypothesis

Weights and threshold can be tuned using walk-forward cross-validation with a maximin objective (maximize worst-case window Sharpe, not average).

## Phase 1: Threshold Search

Objective: max(min(window_sharpe))

| Threshold | Min Sharpe | Avg Sharpe | Std Sharpe | Pass Rate | Windows | Trades |
|-----------|------------|------------|------------|-----------|---------|--------|
| 3.0 | -633.43 | -21.94 | 111.41 | 38.4% | 38/99 | 439 |
| 3.5 | -775.57 | -22.03 | 116.60 | 39.4% | 39/99 | 377 |
| 4.0 | -775.57 | -2.43 | 131.84 | 38.4% | 38/99 | 334 |
| 4.5 | -767.73 | 21.62 | 360.39 | 30.3% | 30/99 | 278 |
| 5.0 | -1952.76 | -52.14 | 408.68 | 15.2% | 15/99 | 212 |
| 5.5 | -616.33 | -14.40 | 90.53 | 3.0% | 3/99 | 49 |
| 6.0 | 0.00 | 0.00 | 0.00 | 0.0% | 0/99 | 1 |

### Best Threshold: 6

- Min Sharpe: 0.0000
- Avg Sharpe: 0.0000
- Reasoning: Selected threshold 6.0 with maximin objective. Worst-case window Sharpe: 0.00 (highest among all candidates). Note: 1 threshold(s) had higher average Sharpe but worse worst-case. Maximin prevents trading off bad windows for good ones. Low trade count (1 across 99 windows). Results may be noisy due to small sample size.

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
