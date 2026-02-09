# Model Improvement Progress

## Validation Gate (Hard Requirements)

A model only "passes" if **ALL** of these are true:

| Metric | Requirement |
|--------|-------------|
| BTC 90-day Sharpe | > 0 |
| ETH 90-day Sharpe | > 0 |
| SOL 90-day Sharpe | > 0 |
| Aggregate Win Rate | > 35% |
| Min Trades (each symbol) | >= 10 |

**No shortcuts. No "it's close enough."**

---

## Current Best Model

- **Model**: None that passes 90-day gate
- **Status**: Searching for first passing model

---

## Iteration Log

### Baseline (exp-000): Current Best Pre-Framework

- **Date**: 2026-02-03
- **Model**: `ict_ensemble_improved_2026-02-03T12-50-20.json`
- **Config**: DDQN, dropout=0.30, L2=0.012, LR=0.0004
- **Training Result**:
  - Val Sharpe: 7.8 (on 30-day validation)
  - Looked promising during training
- **90-Day Backtest (GATE)**:

| Symbol | Sharpe | Status |
|--------|--------|--------|
| BTC | -5.53 | FAIL |
| ETH | +15.71 | PASS |
| SOL | -17.55 | FAIL |

- **Outcome**: **FAIL** (2/3 symbols negative)
- **Learnings**:
  1. Model has recency bias - only works on ETH which had similar patterns to training period
  2. 30-day validation is insufficient - overfitting not detected
  3. Walk-forward validation alone doesn't prevent symbol-specific overfitting
- **Next Action**: Research regime-aware training, CPCV validation, or symbol-specific adaptation

---


### exp-014: Iteration 10: Back to iter8 config (epsilon=0.16) ...

- **Date**: 2026-02-04
- **Hypothesis**: Iteration 10: Back to iter8 config (epsilon=0.16) with 120 episodes for more BTC learning
- **Config**: dropout=0.38, LR=0.00028, L2=0.028
- **Training Result**:
  - Episodes: 120
  - Val Sharpe: 10.43
  - Model: `models/iterative_2026-02-04T08-04-32.json`
- **90-Day Backtest (GATE)**:

| Symbol | Sharpe | Status |
|--------|--------|--------|
| BTCUSDT | 8.11 | PASS |
| ETHUSDT | 18.83 | PASS |
| SOLUSDT | 17.62 | PASS |

- **Outcome**: **PASS**
- **Fail Reasons**: None
- **Learnings**: TBD - Update after analysis

---

## Research Notes

### Techniques to Try

1. **Market Regime Detection**
   - Detect volatility regimes (low/medium/high)
   - Train separate sub-models per regime
   - Source: Standard practice in quantitative finance

2. **CPCV (Combinatorial Purged Cross-Validation)**
   - Superior overfitting detection vs walk-forward
   - Source: https://arxiv.org/abs/2209.05559

3. **Multi-Objective Reward Shaping**
   - Balance profitability vs drawdown vs consistency
   - Avoid single-metric optimization

4. **Data Augmentation**
   - Add noise to training data
   - Synthetic regime changes

5. **Symbol-Aware Features**
   - Different volatility normalization per symbol
   - Relative strength indicators

---

## Workflow Rules

1. **Never skip 90-day backtest** - It's the only honest measure
2. **Always document why** - Both successes and failures
3. **One change at a time** - Otherwise can't learn what worked
4. **Research before coding** - Find evidence-based techniques
5. **Track everything** - Config, results, learnings
