# Iteration 3: Threshold & Weight Calibration

Run: 2026-02-07T17:08:09.294Z
Symbols: BTCUSDT, ETHUSDT, SOLUSDT

## Hypothesis

Weights and threshold can be tuned using walk-forward cross-validation with a maximin objective (maximize worst-case window Sharpe, not average).

## Phase 1: Threshold Search

Objective: max(min(window_sharpe))

| Threshold | Min Sharpe | Avg Sharpe | Std Sharpe | Pass Rate | Windows | Trades |
|-----------|------------|------------|------------|-----------|---------|--------|
| 3.0 | -577.99 | -14.42 | 148.64 | 35.4% | 35/99 | 418 |
| 3.5 | -27576.33 | -300.81 | 2775.75 | 35.4% | 35/99 | 347 |
| 4.0 | -27576.33 | -315.02 | 2788.18 | 32.3% | 32/99 | 301 |
| 4.5 | -3671.75 | -85.68 | 511.95 | 29.3% | 29/99 | 252 |
| 5.0 | -3671.75 | -88.91 | 579.35 | 21.2% | 21/99 | 191 |
| 5.5 | -1361.28 | -20.92 | 145.17 | 2.0% | 2/99 | 44 |
| 6.0 | 0.00 | 0.00 | 0.00 | 0.0% | 0/99 | 1 |

### Best Threshold: 6

- Min Sharpe: 0.0000
- Avg Sharpe: 0.0000
- Reasoning: Selected threshold 6.0 with maximin objective. Worst-case window Sharpe: 0.00 (highest among all candidates). Low trade count (1 across 99 windows). Results may be noisy due to small sample size.

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
