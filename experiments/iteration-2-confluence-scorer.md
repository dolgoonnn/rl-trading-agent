# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=4.048
- Walk-forward validation: 37 windows per symbol
- Symbols: BTCUSDT, ETHUSDT, SOLUSDT
- Commission: 0.1% per side
- Slippage: 0.05% per side
- Max position hold: 160 bars

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
**Threshold:** 4.048

## Results

### Walk-Forward Summary
| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |
|--------|---------|----------|------------|--------------|--------|
| BTCUSDT | 37 | 24/37 | 19.81 | -231.58 | FAIL |
| ETHUSDT | 37 | 22/37 | -24.77 | -735.52 | FAIL |
| SOLUSDT | 37 | 27/37 | 7.91 | -113.06 | FAIL |


**Overall pass rate:** 65.8%
**Overall verdict:** FAILED

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |
|----------|---------|--------|------|--------|----------|---------|-----------|
| order_block | 3635 | 656 | 294 | 362 | 44.8% | 0.46% | 304.17% |
| fvg | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| bos_continuation | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| choch_reversal | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |


**Total trades:** 656
**Overall win rate:** 44.8%
**Overall PnL:** 745.41%

### Comparison to RL (exp-014)
_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._


## Key Learnings
- **Low win rate (44.8%).** May need to increase threshold or add additional filters.
- **order_block** is the most active strategy (656 trades, 44.8% win rate).
- **Dead strategies (0 trades):** fvg, bos_continuation, choch_reversal. These may need looser entry conditions or the confluence threshold may be filtering them out.
- **Failed symbols:** BTCUSDT, ETHUSDT, SOLUSDT. The confluence scorer may need symbol-specific weight tuning.
- **Signal-to-trade conversion:** 18.0% (656 trades from 3635 signals above threshold).

## Decision: Adjust -- the system shows promise but needs threshold/weight tuning before proceeding

## Impact on Next Iteration
The scorer needs adjustment before proceeding. Focus areas:
1. Analyze which factors contribute most to winning trades
2. Consider lowering threshold to increase trade count
3. Review strategy entry conditions for each failing symbol

---
_Generated: 2026-06-13T17:29:24.444Z_
_Script: scripts/backtest-confluence.ts_
