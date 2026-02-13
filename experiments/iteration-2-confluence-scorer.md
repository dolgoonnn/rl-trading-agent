# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=4.672
- Walk-forward validation: 13 windows per symbol
- Symbols: EURUSD=X, GBPUSD=X, USDJPY=X, AUDUSD=X
- Commission: 0.1% per side
- Slippage: 0.05% per side
- Max position hold: 108 bars

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
**Threshold:** 4.672

## Results

### Walk-Forward Summary
| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |
|--------|---------|----------|------------|--------------|--------|
| EURUSD=X | 13 | 2/13 | -32.73 | -109.14 | FAIL |
| GBPUSD=X | 13 | 2/13 | -35.61 | -123.89 | FAIL |
| USDJPY=X | 13 | 8/13 | 29.32 | -116.18 | FAIL |
| AUDUSD=X | 13 | 7/13 | 30.31 | -138.38 | FAIL |


**Overall pass rate:** 36.5%
**Overall verdict:** FAILED

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |
|----------|---------|--------|------|--------|----------|---------|-----------|
| order_block | 1202 | 275 | 141 | 134 | 51.3% | -0.09% | -24.95% |
| fvg | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| bos_continuation | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| choch_reversal | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |


**Total trades:** 275
**Overall win rate:** 51.3%
**Overall PnL:** -22.31%

### Comparison to RL (exp-014)
_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._


## Key Learnings
- **Moderate win rate (51.3%).** Acceptable if average winners exceed average losers.
- **order_block** is the most active strategy (275 trades, 51.3% win rate).
- **Dead strategies (0 trades):** fvg, bos_continuation, choch_reversal. These may need looser entry conditions or the confluence threshold may be filtering them out.
- **Failed symbols:** EURUSD=X, GBPUSD=X, USDJPY=X, AUDUSD=X. The confluence scorer may need symbol-specific weight tuning.
- **Signal-to-trade conversion:** 22.9% (275 trades from 1202 signals above threshold).

## Decision: Pivot -- fundamental approach may need rethinking. Consider different confluence factors or entry logic.

## Impact on Next Iteration
The scorer needs adjustment before proceeding. Focus areas:
1. Analyze which factors contribute most to winning trades
2. Consider lowering threshold to increase trade count
3. Review strategy entry conditions for each failing symbol

---
_Generated: 2026-02-13T02:46:49.034Z_
_Script: scripts/backtest-confluence.ts_
