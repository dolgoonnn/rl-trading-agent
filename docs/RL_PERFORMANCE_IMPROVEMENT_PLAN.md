# RL Trading Agent Performance Improvement Plan

## Actual Results (2026-02-01)

### Latest Training Run Summary

| Run | Agent | Episodes | Train Win Rate | Val Win Rate | Val Sharpe | Val PnL | Gap |
|-----|-------|----------|----------------|--------------|------------|---------|-----|
| Baseline | DQN (256,128,64) | 460 | 93.0% | 46.3% | -5.435 | -$300 | 46.7% |
| Anti-overfit | DQN (128,64,32) | 500 | 94.8% | 47.3% | -5.228 | -$251 | 47.5% |

**Status: SEVERE OVERFITTING PERSISTS**

### Target vs Achieved

| Metric | Target | Achieved | Status |
|--------|--------|----------|--------|
| Val Sharpe | >0.8 | -5.2 | FAIL |
| Val Win Rate | >50% | 47.3% | FAIL |
| Train/Val Gap | <15% | 47.5% | FAIL |
| Max Drawdown | <15% | 3.1% | PASS |
| Profit Factor | >1.3 | <1.0 | FAIL |

### What We Tried

1. **Reduced network size** (256,128,64) -> (128,64,32): No improvement
2. **Increased dropout** 0.2 -> 0.35: No improvement
3. **Increased L2 regularization** 0.01 -> 0.02: No improvement
4. **Reduced training frequency** every 4 -> every 8 steps: No improvement
5. **Full data passes** (disabled random start): Made things worse

### Data Analysis

```
Training Period:  2025-02-01 to 2025-11-19 (7008 candles)
Validation Period: 2025-11-19 to 2026-01-31 (1752 candles)

Both periods similar:
- Mean return: -0.001% to -0.005% (both bearish)
- Volatility: ~0.46% (identical)
- 50% positive candles (both)

NOT a regime change issue - model is memorizing.
```

### Root Cause Analysis

The overfitting is fundamental to the approach:
1. **Limited data**: 1 year of hourly data = 8760 samples (small for deep RL)
2. **Episode memorization**: 500-step random windows get memorized across ~500 episodes
3. **High-frequency trading**: Agent learns to exploit specific micro-patterns
4. **State space complexity**: 96 features with small network still overfits

---

## Current Implementation Status

### Fixes Applied

- [x] Epsilon decay per episode (not per step)
- [x] Training frequency reduced (every 4-8 steps)
- [x] Transaction costs added
- [x] Reward function uses tanh scaling
- [x] ICT bonuses capped at 0.15
- [x] Huber loss for stability
- [x] Gradient clipping (1.0)
- [x] Batch normalization
- [x] L2 regularization

### Still Broken

- [ ] Severe overfitting (47% gap between train/val)
- [ ] Negative Sharpe on validation
- [ ] Model memorizes training patterns

---

## Next Steps Required

### Option A: More Data (Recommended)
- Fetch 3+ years of data
- Fetch multiple symbols (ETHUSDT, SOLUSDT)
- Cross-asset generalization

### Option B: Simpler Model
- Try gradient boosting (XGBoost/LightGBM) instead of deep RL
- Feature engineering + rule-based signals
- Ensemble with ICT confluence scoring

### Option C: Walk-Forward Validation
- Enable `useRollingValidation: true` in trainer
- Smaller train windows (500 candles)
- Multiple test folds

### Option D: Reduce State Complexity
- Use only top 20 features
- Feature selection based on importance
- PCA dimensionality reduction

---

## File Changes Made

| File | Changes |
|------|---------|
| `dqn-agent.ts` | Hidden layers (128,64,32), dropout 0.35, L2 0.02 |
| `ppo-agent.ts` | Hidden layers (128,64,32), dropout 0.25, L2 0.02 |
| `trainer.ts` | trainFrequency 8 |
| `train-agent.ts` | maxStepsPerEpisode 500, randomStart true |

---

## Commands Used

```bash
# Smoke test (10 episodes)
npx tsx scripts/train-agent.ts --episodes 10

# Baseline (50 episodes)
npx tsx scripts/train-agent.ts --episodes 50 --output ./models/baseline.json

# Full training (500 episodes)
npx tsx scripts/train-agent.ts --episodes 500 --output ./models/dqn-v1.json

# Data analysis
npx tsx scripts/analyze-data.ts
```

---

## Conclusion

The RL agent successfully trains on data (93%+ win rate) but fails to generalize (47% val win rate). This is a classic deep RL overfitting problem with limited financial data.

**Recommendation:** Before investing more time in RL tuning, consider:
1. Getting significantly more data (3+ years, multiple assets)
2. Using simpler ML approaches (gradient boosting, rule-based)
3. Validating ICT concepts with backtesting before RL training
