# Gold Model Readiness Assessment

## Context

Gold CMA-ES Run 12 validation is complete. The question: is 6/7 PASS (only PBO fails) sufficient to paper trade?

---

## Side-by-Side Comparison: All Three Models

| Check               | Crypto 3-sym | Forex (DROPPED) | **Gold** |
|---------------------|-------------|-----------------|----------|
| Walk-Forward >60%   | 78.1% PASS  | 61.5% PASS      | **66.7% PASS** |
| PBO <25%            | 18.5% PASS  | 31.8% FAIL      | **36.4% FAIL** |
| DSR >0              | 6.77 PASS   | 3.13 PASS       | **15.31 PASS** |
| MC Bootstrap Sharpe | 3.03 PASS   | -3.94 FAIL      | **13.22 PASS** |
| MC Bootstrap PnL    | +69.5% PASS | -9.3% FAIL      | **+22.1% PASS** |
| MC Skip 20%         | 100% PASS   | 95% PASS        | **100% PASS** |
| Param Fragility     | 97% FAIL    | 76% FAIL        | **33% PASS** |
| **Score**           | **6/7**     | **3/7**         | **6/7** |
| Trades              | 701         | 315             | 87 |
| Win Rate            | 56.3%       | 43.5%           | 69.0% |
| Sharpe              | 7.67        | 3.71            | 25.57 |
| Max Drawdown        | 63.3%       | 8.4%            | 6.1% |

---

## What Each Test Tells You

### 1. Walk-Forward (66.7% PASS) — "Does the strategy work out-of-sample?"
The model is profitable in 8/12 validation windows. This is above the 60% threshold. The CMA-ES training reported "100% WF" because it optimized against this metric on the full dataset — the independent walk-forward in the validation script uses a stricter protocol.

### 2. PBO (36.4% FAIL) — "Are we picking the best variant by luck?"
PBO uses CSCV (Combinatorially Symmetric Cross-Validation) to check if the best-in-sample config also wins out-of-sample. **This test is structurally underpowered for gold:**
- Crypto has 3 symbols x ~32 windows = ~97 data points per variant
- Gold has 1 symbol x 12 windows = 12 data points per variant
- Each CSCV split gets only 6 windows per half — extremely noisy
- The 36.4% is dominated by sampling noise, not a genuine overfitting signal

**Key nuance**: PBO measures whether you picked the *best variant among alternatives* by luck. But all 8 gold variants scored 66.7-75% WF pass rate (very tight spread). This means the parameter space is flat — you're NOT on a lucky peak. PBO just can't detect this with 12 windows.

### 3. DSR (15.31 PASS) — "Does the Sharpe survive selection bias correction?"
Even after correcting for 236 total trials across all campaigns, the deflated Sharpe is 15.31. For context: crypto's DSR is 6.77, forex was 3.13. Gold's DSR is the strongest of all models by a wide margin. MBL (minimum backtest length) is only 6 trades; you have 87.

### 4. Bootstrap Sharpe 5th pct (13.22 PASS) — "Is the Sharpe stable under resampling?"
Even at the 5th percentile of 1000 bootstrap draws, Sharpe remains 13.22. Forex failed this at -3.94. This means gold's edge is NOT dependent on a few lucky trades — it's distributed across the trade population.

### 5. Bootstrap PnL 5th pct (+22.1% PASS) — "Can we still make money in the worst-case resampling?"
At the 5th percentile, you still make +22.1%. Forex failed at -9.3%. This is a strong signal that the edge is real and not dependent on trade ordering.

### 6. Skip 20% (100% PASS) — "What if we miss 20% of the best trades?"
Even randomly removing 20% of trades, the strategy is profitable in 100% of 1000 iterations. This means the edge isn't concentrated in a few outlier trades.

### 7. Parameter Fragility (33% PASS) — "How brittle are the optimized parameters?"
**This is arguably the most important result.** Under 5% Gaussian noise on all 32 parameters:
- Gold mean WF pass rate drops from 66.7% to 65.6% — almost no degradation
- Fragility score: 33% (meaning 67% of perturbed configs maintain similar performance)
- Crypto scores 97% fragility (almost all perturbations degrade performance)
- Gold is in a **broad, flat basin** — the exact parameter values matter less

---

## Honest Risk Assessment

### Strengths
- **Best parameter robustness of any model** — 33% fragility vs crypto's 97%
- **Extremely strong DSR** — survives 236-trial correction with huge margin
- **All Monte Carlo tests pass convincingly** — edge is real and distributed
- **Tiny drawdown** — 6.1% MaxDD vs crypto's 63.3%
- **High win rate** — 69% WR provides psychological comfort during paper trading

### Concerns
- **87 trades is a small sample** — statistical power is limited
- **Single symbol** — no cross-asset diversification signal
- **Sharpe of 25.57 is unrealistically high** — likely inflated by small sample + low return dispersion. Will compress in live trading.
- **PBO structurally can't validate** with 12 windows — this isn't a gold-specific problem, it's a single-symbol problem
- **WF pass rate dropped** from 100% (CMA-ES training) to 66.7% (independent validation) — some overfitting to the training WF windows exists

### Comparison to Forex (which was DROPPED)
Gold is categorically stronger than forex on every metric except PBO:
- Forex failed 4/7, gold fails 1/7
- Forex Bootstrap Sharpe was -3.94, gold is +13.22
- Forex Bootstrap PnL was -9.3%, gold is +22.1%
- Forex fragility was 76%, gold is 33%
- Forex was correctly dropped. Gold should NOT be dropped for the same reason.

---

## Critical Caveats (Real Money Considerations)

### 1. Sharpe of 25.57 Is NOT Real-World Achievable
This backtest Sharpe is an artifact of small sample + low return variance. Real-world degradation factors:
- **Slippage**: Gold has wide spreads during Asian-to-London transition (exactly when this strategy enters)
- **Timing lag**: The strategy assumes entry at the FVG CE price — in practice you'll get filled worse
- **Regime change**: Gold's session dynamics can shift (e.g., Chinese central bank activity, geopolitical events)
- **Realistic expectation**: Sharpe will compress to 2-5 in live trading. If it stays above 1.5 after 30+ trades, that's excellent.

### 2. 87 Trades Is a Small Sample
- With 87 trades, the 95% confidence interval on win rate is approximately +/-10% (59-79%)
- The "69% WR" could easily be 59% in reality — still profitable with targetRR=1.36, but barely
- Law of small numbers: 87 trades can look great by chance. The MC bootstrap helps but can't eliminate this
- The MBL (minimum backtest length) is only 6 — that's the DSR threshold, not a sample size guarantee

### 3. Walk-Forward Dropped from 100% to 66.7%
This 33 percentage point gap between CMA-ES training (100% WF) and independent validation (66.7% WF) is the clearest evidence of overfitting in the training process. The model was partially fit to the WF window boundaries. 66.7% is still above 60% threshold, but the gap itself is a warning sign.

### 4. Single-Symbol Concentration Risk
- The crypto model hedges across BTC/ETH/SOL — if one symbol's regime shifts, others may compensate
- Gold has ZERO diversification — if gold's session structure changes, the entire model breaks
- Session-based strategies (Asian range) depend on institutional order flow patterns that can shift permanently
- No cross-validation against related instruments (silver, platinum, DXY)

### 5. What the Validation Suite CANNOT Test
- **Regime change risk**: All tests resample from the SAME historical trade distribution. If gold's market microstructure changes (e.g., new Asian session participants, changing London Fix mechanics), all historical statistics become irrelevant.
- **Execution risk**: Backtest assumes perfect fills at signal prices. Gold futures have variable liquidity.
- **Data quality risk**: GC_F data source quality and survivorship characteristics affect all results.

### 6. PBO Failure IS Meaningful, Even If Structurally Limited
While PBO is underpowered with 12 windows, the 36.4% is not zero. It means that in 36.4% of combinatorial splits, the best in-sample variant did NOT perform best out-of-sample. With crypto (18.5%) this was rare. With gold it happens more than 1/3 of the time. This could reflect genuine overfitting OR just noise — we can't distinguish with this sample size.

---

## Verdict: Conditional Paper Trade

**Paper trading is free and the evidence threshold for a zero-cost experiment is lower than for live trading.**

The model passes paper trading gate because:
1. **6/7 checks pass** — exceeds >=5/7 threshold
2. **PBO failure is structurally limited** by 1-symbol window count
3. **Parameter robustness (33%) is the best of any model** — opposite of overfitting
4. **Every trade-level Monte Carlo test passes** — the edge survives resampling
5. **DSR at 15.31** — selection bias cannot explain this

### Paper Trading Requirements
- **Minimum 30 trades** before evaluating (roughly 5 months at 6 trades/month)
- **Kill thresholds**: Stop if win rate drops below 50% after 20+ trades, or if MaxDD exceeds 15%
- **Track every metric**: Entry slippage, fill quality, timing accuracy vs signal timestamp
- **Do NOT go live** until paper trading produces 30+ trades with WR>55% and positive Sharpe

### What to Expect (Realistic)
- Sharpe compresses from 25.57 to 2-5 (still good if >1.5)
- Win rate drops from 69% to 55-65%
- MaxDD expands from 6.1% to 10-20%
- Trade frequency: ~6/month — this is a slow model, patience is required
- Some months will have 0 trades (gold enters ranging sessions)

### Infrastructure
Paper trading gold uses Bybit's XAUUSDT linear perpetual (same API as crypto).
The bot supports `--gold` flag to add XAUUSDT with the gold strategy config.
The model was trained on GC_F (COMEX gold futures) but XAUUSDT tracks the same underlying — session dynamics are equivalent for paper trading purposes.
