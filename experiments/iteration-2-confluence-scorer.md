# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=4.672
- Walk-forward validation: 32 windows per symbol
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
**Threshold:** 4.672

## Results

### Walk-Forward Summary
| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |
|--------|---------|----------|------------|--------------|--------|
| BTCUSDT | 32 | 26/32 | 18.57 | -360.91 | FAIL |
| ETHUSDT | 33 | 26/33 | 3.17 | -490.13 | FAIL |
| SOLUSDT | 33 | 23/33 | 6.82 | -70.74 | FAIL |
| LINKUSDT | 33 | 20/33 | 2.18 | -69.77 | FAIL |
| DOGEUSDT | 33 | 19/33 | -0.28 | -97.88 | FAIL |
| NEARUSDT | 33 | 19/33 | 0.20 | -60.99 | FAIL |
| ADAUSDT | 32 | 18/32 | 3.85 | -51.81 | FAIL |
| APTUSDT | 33 | 18/33 | 5.57 | -70.93 | FAIL |
| ARBUSDT | 32 | 17/32 | 1.41 | -71.87 | FAIL |
| MATICUSDT | 16 | 8/16 | -7.60 | -88.26 | FAIL |


**Overall pass rate:** 62.6%
**Overall verdict:** FAILED

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |
|----------|---------|--------|------|--------|----------|---------|-----------|
| order_block | 11388 | 2746 | 1439 | 1307 | 52.4% | 0.17% | 473.67% |
| fvg | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| bos_continuation | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| choch_reversal | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |


**Total trades:** 2746
**Overall win rate:** 52.4%
**Overall PnL:** 208.79%

### Comparison to RL (exp-014)
_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._


## Key Learnings
- **Moderate win rate (52.4%).** Acceptable if average winners exceed average losers.
- **order_block** is the most active strategy (2746 trades, 52.4% win rate).
- **Dead strategies (0 trades):** fvg, bos_continuation, choch_reversal. These may need looser entry conditions or the confluence threshold may be filtering them out.
- **Failed symbols:** BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT, APTUSDT, ARBUSDT, MATICUSDT. The confluence scorer may need symbol-specific weight tuning.
- **Signal-to-trade conversion:** 24.1% (2746 trades from 11388 signals above threshold).

## Decision: Adjust -- the system shows promise but needs threshold/weight tuning before proceeding

## Impact on Next Iteration
The scorer needs adjustment before proceeding. Focus areas:
1. Analyze which factors contribute most to winning trades
2. Consider lowering threshold to increase trade count
3. Review strategy entry conditions for each failing symbol

---
_Generated: 2026-02-15T12:40:54.630Z_
_Script: scripts/backtest-confluence.ts_
