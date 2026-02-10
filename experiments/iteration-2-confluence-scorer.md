# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=4.395
- Walk-forward validation: 30 windows per symbol
- Symbols: BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT, APTUSDT, ARBUSDT, MATICUSDT
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
**Threshold:** 4.395

## Results

### Walk-Forward Summary
| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |
|--------|---------|----------|------------|--------------|--------|
| BTCUSDT | 30 | 15/30 | 29.10 | -236.12 | FAIL |
| ETHUSDT | 31 | 21/31 | 5.42 | -254.02 | FAIL |
| SOLUSDT | 33 | 20/33 | 1.14 | -69.52 | FAIL |
| LINKUSDT | 33 | 19/33 | 1.05 | -62.82 | FAIL |
| DOGEUSDT | 33 | 15/33 | -4.05 | -143.66 | FAIL |
| NEARUSDT | 33 | 16/33 | -0.11 | -115.77 | FAIL |
| ADAUSDT | 32 | 17/32 | -2.54 | -129.17 | FAIL |
| APTUSDT | 33 | 20/33 | 5.56 | -92.06 | FAIL |
| ARBUSDT | 32 | 19/32 | 4.81 | -60.60 | FAIL |
| MATICUSDT | 16 | 6/16 | -8.49 | -57.16 | FAIL |


**Overall pass rate:** 54.9%
**Overall verdict:** FAILED

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |
|----------|---------|--------|------|--------|----------|---------|-----------|
| order_block | 10432 | 2797 | 1482 | 1315 | 53.0% | 0.13% | 354.03% |
| fvg | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| bos_continuation | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| choch_reversal | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |


**Total trades:** 2797
**Overall win rate:** 53.0%
**Overall PnL:** -8.50%

### Comparison to RL (exp-014)
_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._


## Key Learnings
- **Moderate win rate (53.0%).** Acceptable if average winners exceed average losers.
- **order_block** is the most active strategy (2797 trades, 53.0% win rate).
- **Dead strategies (0 trades):** fvg, bos_continuation, choch_reversal. These may need looser entry conditions or the confluence threshold may be filtering them out.
- **Failed symbols:** BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT, APTUSDT, ARBUSDT, MATICUSDT. The confluence scorer may need symbol-specific weight tuning.
- **Signal-to-trade conversion:** 26.8% (2797 trades from 10432 signals above threshold).

## Decision: Adjust -- the system shows promise but needs threshold/weight tuning before proceeding

## Impact on Next Iteration
The scorer needs adjustment before proceeding. Focus areas:
1. Analyze which factors contribute most to winning trades
2. Consider lowering threshold to increase trade count
3. Review strategy entry conditions for each failing symbol

---
_Generated: 2026-02-10T16:06:07.558Z_
_Script: scripts/backtest-confluence.ts_
