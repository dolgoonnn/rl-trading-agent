# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=3.064
- Walk-forward validation: 35 windows per symbol
- Symbols: BTCUSDT, ETHUSDT, SOLUSDT
- Commission: 0.1% per side
- Slippage: 0.05% per side
- Max position hold: 168 bars

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
**Threshold:** 3.064

## Results

### Walk-Forward Summary
| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |
|--------|---------|----------|------------|--------------|--------|
| BTCUSDT | 35 | 20/35 | 9.54 | -174.95 | FAIL |
| ETHUSDT | 35 | 24/35 | -16.27 | -734.36 | FAIL |
| SOLUSDT | 35 | 24/35 | 5.70 | -485.29 | FAIL |


**Overall pass rate:** 64.8%
**Overall verdict:** FAILED

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |
|----------|---------|--------|------|--------|----------|---------|-----------|
| order_block | 4024 | 607 | 290 | 317 | 47.8% | 0.48% | 293.86% |
| fvg | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| bos_continuation | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| choch_reversal | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |


**Total trades:** 607
**Overall win rate:** 47.8%
**Overall PnL:** 768.01%

### Comparison to RL (exp-014)
_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._


## Key Learnings
- **Moderate win rate (47.8%).** Acceptable if average winners exceed average losers.
- **order_block** is the most active strategy (607 trades, 47.8% win rate).
- **Dead strategies (0 trades):** fvg, bos_continuation, choch_reversal. These may need looser entry conditions or the confluence threshold may be filtering them out.
- **Failed symbols:** BTCUSDT, ETHUSDT, SOLUSDT. The confluence scorer may need symbol-specific weight tuning.
- **Signal-to-trade conversion:** 15.1% (607 trades from 4024 signals above threshold).

## Decision: Adjust -- the system shows promise but needs threshold/weight tuning before proceeding

## Impact on Next Iteration
The scorer needs adjustment before proceeding. Focus areas:
1. Analyze which factors contribute most to winning trades
2. Consider lowering threshold to increase trade count
3. Review strategy entry conditions for each failing symbol

---
_Generated: 2026-04-19T15:15:22.599Z_
_Script: scripts/backtest-confluence.ts_
