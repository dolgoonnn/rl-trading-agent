# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=4.286
- Walk-forward validation: 29 windows per symbol
- Symbols: BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT, APTUSDT, ARBUSDT, MATICUSDT
- Commission: 0.1% per side
- Slippage: 0.05% per side
- Max position hold: 104 bars

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
**Threshold:** 4.286

## Results

### Walk-Forward Summary
| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |
|--------|---------|----------|------------|--------------|--------|
| BTCUSDT | 29 | 17/29 | 25.44 | -49.84 | FAIL |
| ETHUSDT | 31 | 19/31 | 8.95 | -134.35 | FAIL |
| SOLUSDT | 33 | 22/33 | -2.61 | -333.55 | FAIL |
| LINKUSDT | 33 | 18/33 | 2.44 | -62.21 | FAIL |
| DOGEUSDT | 33 | 15/33 | -8.56 | -246.22 | FAIL |
| NEARUSDT | 33 | 15/33 | 13.41 | -100.67 | FAIL |
| ADAUSDT | 32 | 15/32 | -3.65 | -113.97 | FAIL |
| APTUSDT | 33 | 18/33 | 12.44 | -49.48 | FAIL |
| ARBUSDT | 32 | 20/32 | 3.94 | -56.70 | FAIL |
| MATICUSDT | 16 | 8/16 | -7.67 | -62.60 | FAIL |


**Overall pass rate:** 54.8%
**Overall verdict:** FAILED

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |
|----------|---------|--------|------|--------|----------|---------|-----------|
| order_block | 14517 | 2357 | 1242 | 1115 | 52.7% | 0.17% | 395.48% |
| fvg | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| bos_continuation | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| choch_reversal | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |


**Total trades:** 2357
**Overall win rate:** 52.7%
**Overall PnL:** 137.64%

### Comparison to RL (exp-014)
_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._


## Key Learnings
- **Moderate win rate (52.7%).** Acceptable if average winners exceed average losers.
- **order_block** is the most active strategy (2357 trades, 52.7% win rate).
- **Dead strategies (0 trades):** fvg, bos_continuation, choch_reversal. These may need looser entry conditions or the confluence threshold may be filtering them out.
- **Failed symbols:** BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT, APTUSDT, ARBUSDT, MATICUSDT. The confluence scorer may need symbol-specific weight tuning.
- **Signal-to-trade conversion:** 16.2% (2357 trades from 14517 signals above threshold).

## Decision: Adjust -- the system shows promise but needs threshold/weight tuning before proceeding

## Impact on Next Iteration
The scorer needs adjustment before proceeding. Focus areas:
1. Analyze which factors contribute most to winning trades
2. Consider lowering threshold to increase trade count
3. Review strategy entry conditions for each failing symbol

---
_Generated: 2026-02-10T16:06:58.725Z_
_Script: scripts/backtest-confluence.ts_
