# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=4
- Walk-forward validation: 9 windows per symbol
- Symbols: R_25, R_75, R_100
- Commission: 0.1% per side
- Slippage: 0.05% per side
- Max position hold: 100 bars

### Confluence Weights
| Factor | Weight |
|--------|--------|
| Structure Alignment | 2 |
| Kill Zone Active | 0.5 |
| Liquidity Sweep | 2 |
| OB Proximity | 1 |
| FVG at CE | 1 |
| Recent BOS | 1 |
| R:R Ratio | 1.5 |
| OTE Zone | 0.5 |
| Breaker Confluence | 0 |
| OB+FVG Confluence | 1 |

**Max possible score:** 10.5
**Threshold:** 4

## Results

### Walk-Forward Summary
| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |
|--------|---------|----------|------------|--------------|--------|
| R_25 | 9 | 1/9 | -858.47 | -6704.39 | FAIL |
| R_75 | 9 | 3/9 | -19.54 | -90.63 | FAIL |
| R_100 | 9 | 5/9 | -7.24 | -50.73 | FAIL |


**Overall pass rate:** 33.3%
**Overall verdict:** FAILED

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |
|----------|---------|--------|------|--------|----------|---------|-----------|
| order_block | 428 | 108 | 41 | 67 | 38.0% | -0.10% | -11.07% |
| fvg | 543 | 454 | 125 | 329 | 27.5% | -0.34% | -153.81% |
| bos_continuation | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| choch_reversal | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |


**Total trades:** 562
**Overall win rate:** 29.5%
**Overall PnL:** -85.07%

### Comparison to RL (exp-014)
_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._


## Key Learnings
- **Low win rate (29.5%).** May need to increase threshold or add additional filters.
- **fvg** is the most active strategy (454 trades, 27.5% win rate).
- **Dead strategies (0 trades):** bos_continuation, choch_reversal. These may need looser entry conditions or the confluence threshold may be filtering them out.
- **Failed symbols:** R_25, R_75, R_100. The confluence scorer may need symbol-specific weight tuning.
- **Signal-to-trade conversion:** 57.9% (562 trades from 971 signals above threshold).

## Decision: Pivot -- fundamental approach may need rethinking. Consider different confluence factors or entry logic.

## Impact on Next Iteration
The scorer needs adjustment before proceeding. Focus areas:
1. Analyze which factors contribute most to winning trades
2. Consider lowering threshold to increase trade count
3. Review strategy entry conditions for each failing symbol

---
_Generated: 2026-06-29T06:48:40.975Z_
_Script: scripts/backtest-confluence.ts_
