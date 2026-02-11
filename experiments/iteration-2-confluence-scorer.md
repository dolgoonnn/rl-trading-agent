# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=4.588
- Walk-forward validation: 30 windows per symbol
- Symbols: BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT, APTUSDT, ARBUSDT, MATICUSDT
- Commission: 0.1% per side
- Slippage: 0.05% per side
- Max position hold: 109 bars

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
**Threshold:** 4.588

## Results

### Walk-Forward Summary
| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |
|--------|---------|----------|------------|--------------|--------|
| BTCUSDT | 30 | 15/30 | 31.38 | -228.32 | FAIL |
| ETHUSDT | 31 | 21/31 | 10.40 | -134.35 | FAIL |
| SOLUSDT | 33 | 22/33 | 0.87 | -244.00 | FAIL |
| LINKUSDT | 33 | 17/33 | 1.72 | -61.68 | FAIL |
| DOGEUSDT | 33 | 19/33 | -1.19 | -140.72 | FAIL |
| NEARUSDT | 33 | 21/33 | 6.58 | -96.27 | FAIL |
| ADAUSDT | 32 | 17/32 | -2.72 | -91.23 | FAIL |
| APTUSDT | 33 | 20/33 | 6.53 | -59.86 | FAIL |
| ARBUSDT | 32 | 23/32 | 8.89 | -39.74 | FAIL |
| MATICUSDT | 16 | 7/16 | -4.56 | -70.29 | FAIL |


**Overall pass rate:** 59.5%
**Overall verdict:** FAILED

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |
|----------|---------|--------|------|--------|----------|---------|-----------|
| order_block | 12581 | 2535 | 1343 | 1192 | 53.0% | 0.24% | 598.75% |
| fvg | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| bos_continuation | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |
| choch_reversal | 0 | 0 | 0 | 0 | 0.0% | 0.00% | 0.00% |


**Total trades:** 2535
**Overall win rate:** 53.0%
**Overall PnL:** 1195.06%

### Comparison to RL (exp-014)
_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._


## Key Learnings
- **Moderate win rate (53.0%).** Acceptable if average winners exceed average losers.
- **order_block** is the most active strategy (2535 trades, 53.0% win rate).
- **Dead strategies (0 trades):** fvg, bos_continuation, choch_reversal. These may need looser entry conditions or the confluence threshold may be filtering them out.
- **Failed symbols:** BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT, APTUSDT, ARBUSDT, MATICUSDT. The confluence scorer may need symbol-specific weight tuning.
- **Signal-to-trade conversion:** 20.1% (2535 trades from 12581 signals above threshold).

## Decision: Adjust -- the system shows promise but needs threshold/weight tuning before proceeding

## Impact on Next Iteration
The scorer needs adjustment before proceeding. Focus areas:
1. Analyze which factors contribute most to winning trades
2. Consider lowering threshold to increase trade count
3. Review strategy entry conditions for each failing symbol

---
_Generated: 2026-02-10T17:09:38.659Z_
_Script: scripts/backtest-confluence.ts_
