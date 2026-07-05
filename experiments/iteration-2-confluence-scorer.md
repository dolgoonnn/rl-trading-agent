# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=4.797
- Walk-forward validation: 37 windows per symbol
- Symbols: BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT
- Commission: 0.1% per side
- Slippage: 0.05% per side
- Max position hold: 112 bars

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
**Threshold:** 4.797

## Results

### Walk-Forward Summary
| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |
|--------|---------|----------|------------|--------------|--------|
| BTCUSDT | 37 | 15/37 | 4.40 | -390.69 | FAIL |
| ETHUSDT | 37 | 20/37 | -37.91 | -1002.67 | FAIL |
| SOLUSDT | 37 | 19/37 | -0.72 | -84.81 | FAIL |
| LINKUSDT | 33 | 18/33 | 2.88 | -120.86 | FAIL |
| DOGEUSDT | 33 | 18/33 | -22.80 | -753.42 | FAIL |
| NEARUSDT | 33 | 19/33 | 1.59 | -126.07 | FAIL |
| ADAUSDT | 32 | 14/32 | 5.49 | -47.62 | FAIL |


**Overall pass rate:** 50.8%
**Overall verdict:** FAILED

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |
|----------|---------|--------|------|--------|----------|---------|-----------|
| order_block | 9096 | 1860 | 906 | 954 | 48.7% | 0.18% | 338.68% |
| fvg | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| bos_continuation | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| choch_reversal | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |


**Total trades:** 1860
**Overall win rate:** 48.7%
**Overall PnL:** 94.00%

### Comparison to RL (exp-014)
_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._


## Key Learnings
- **Moderate win rate (48.7%).** Acceptable if average winners exceed average losers.
- **order_block** is the most active strategy (1860 trades, 48.7% win rate).
- **Dead strategies (0 trades):** fvg, bos_continuation, choch_reversal. These may need looser entry conditions or the confluence threshold may be filtering them out.
- **Failed symbols:** BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT. The confluence scorer may need symbol-specific weight tuning.
- **Signal-to-trade conversion:** 20.4% (1860 trades from 9096 signals above threshold).

## Decision: Adjust -- the system shows promise but needs threshold/weight tuning before proceeding

## Impact on Next Iteration
The scorer needs adjustment before proceeding. Focus areas:
1. Analyze which factors contribute most to winning trades
2. Consider lowering threshold to increase trade count
3. Review strategy entry conditions for each failing symbol

---
_Generated: 2026-06-26T03:37:49.603Z_
_Script: scripts/backtest-confluence.ts_
