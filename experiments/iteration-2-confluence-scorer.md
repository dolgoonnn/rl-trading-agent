# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=4.542
- Walk-forward validation: 26 windows per symbol
- Symbols: BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT, APTUSDT, ARBUSDT, MATICUSDT
- Commission: 0.1% per side
- Slippage: 0.05% per side
- Max position hold: 114 bars

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
**Threshold:** 4.542

## Results

### Walk-Forward Summary
| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |
|--------|---------|----------|------------|--------------|--------|
| BTCUSDT | 26 | 15/26 | 1169.13 | -101.80 | FAIL |
| ETHUSDT | 31 | 17/31 | -10.51 | -373.88 | FAIL |
| SOLUSDT | 33 | 18/33 | -1.75 | -258.89 | FAIL |
| LINKUSDT | 33 | 18/33 | -49.40 | -1179.81 | FAIL |
| DOGEUSDT | 33 | 15/33 | -0.48 | -277.36 | FAIL |
| NEARUSDT | 33 | 12/33 | -10.73 | -77.37 | FAIL |
| ADAUSDT | 32 | 13/32 | -14.21 | -203.38 | FAIL |
| APTUSDT | 33 | 22/33 | 19.24 | -49.37 | FAIL |
| ARBUSDT | 32 | 13/32 | 5.34 | -51.46 | FAIL |
| MATICUSDT | 16 | 5/16 | 4.15 | -44.69 | FAIL |


**Overall pass rate:** 49.0%
**Overall verdict:** FAILED

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |
|----------|---------|--------|------|--------|----------|---------|-----------|
| order_block | 21387 | 1745 | 897 | 848 | 51.4% | 0.14% | 240.66% |
| fvg | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| bos_continuation | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| choch_reversal | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |


**Total trades:** 1745
**Overall win rate:** 51.4%
**Overall PnL:** -4.91%

### Comparison to RL (exp-014)
_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._


## Key Learnings
- **Moderate win rate (51.4%).** Acceptable if average winners exceed average losers.
- **order_block** is the most active strategy (1745 trades, 51.4% win rate).
- **Dead strategies (0 trades):** fvg, bos_continuation, choch_reversal. These may need looser entry conditions or the confluence threshold may be filtering them out.
- **Failed symbols:** BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT, APTUSDT, ARBUSDT, MATICUSDT. The confluence scorer may need symbol-specific weight tuning.
- **Signal-to-trade conversion:** 8.2% (1745 trades from 21387 signals above threshold).

## Decision: Pivot -- fundamental approach may need rethinking. Consider different confluence factors or entry logic.

## Impact on Next Iteration
The scorer needs adjustment before proceeding. Focus areas:
1. Analyze which factors contribute most to winning trades
2. Consider lowering threshold to increase trade count
3. Review strategy entry conditions for each failing symbol

---
_Generated: 2026-02-10T16:06:35.564Z_
_Script: scripts/backtest-confluence.ts_
