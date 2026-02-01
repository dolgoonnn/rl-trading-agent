# RL Trading Agent - Performance Report

This document tracks the performance of the reinforcement learning trading agent across multiple assets.

## Target Metrics

| Metric | Target | Priority |
|--------|--------|----------|
| Validation Sharpe | >0.8 | CRITICAL |
| Train/Val Gap | <15% | CRITICAL |
| Max Drawdown | <15% | HIGH |
| Profit Factor | >1.3 | HIGH |
| Per-symbol Win Rate | >50% | HIGH |
| Risk per trade | <2% capital | REQUIRED |

## Current Status

**Last Training Run:** 2026-02-01

### Overall Metrics (Validation Set)

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Average Sharpe | -5.23 | >0.8 | FAIL |
| Average Win Rate | 47.3% | >50% | FAIL |
| Average Max DD | 3.1% | <15% | PASS |
| Profit Factor | <1.0 | >1.3 | FAIL |

### Per-Symbol Performance

| Symbol | Sharpe | Win% | MaxDD | PF | Trades | Return |
|--------|--------|------|-------|-----|--------|--------|
| BTCUSDT | -5.23 | 47.3% | 3.1% | <1.0 | 317 | -$251 |
| ETHUSDT | - | - | - | - | - | Not tested |
| SOLUSDT | - | - | - | - | - | Not tested |
| EURUSD=X | - | - | - | - | - | Not tested |

## Training History

### Run 1: Baseline DQN (2026-02-01)
```
Date: 2026-02-01
Agent: DQN (256,128,64)
Episodes: 460 (early stopped)
Duration: 907 seconds

Validation Results:
  Sharpe: -5.435
  Win Rate: 46.3%
  Max Drawdown: 3.1%
  Total PnL: -$300.18

Training Results (Episode 460):
  Win Rate: 93.0%
  PnL: +$1,058.64

Notes:
- SEVERE OVERFITTING: 93% train vs 46% val win rate
- Early stopping triggered after 30 evals without improvement
```

### Run 2: Anti-Overfit DQN (2026-02-01)
```
Date: 2026-02-01
Agent: DQN (128,64,32) + dropout 0.35 + L2 0.02
Episodes: 500
Duration: 487 seconds

Validation Results:
  Sharpe: -5.228
  Win Rate: 47.3%
  Max Drawdown: 3.1%
  Total PnL: -$251.04

Training Results (Episode 500):
  Win Rate: 94.8%
  PnL: +$1,092.42

Notes:
- Smaller network did NOT reduce overfitting
- Train/Val gap still ~47%
- Agent memorizes training patterns
```

## Training Configuration

### DQN Agent (Current)
- **Architecture:** 128 -> 64 -> 32 -> 4 actions (reduced from 256,128,64)
- **Learning Rate:** 0.0003
- **Gamma:** 0.99
- **Epsilon Decay:** Per-episode exponential (0.995)
- **Dropout:** 0.35 (increased from 0.2)
- **L2 Regularization:** 0.02 (increased from 0.01)
- **Batch Normalization:** Enabled
- **Huber Loss:** Enabled (delta=1.0)
- **Gradient Clipping:** 1.0

### PPO Agent (Updated)
- **Architecture:** 128 -> 64 -> 32 (Actor & Critic)
- **Learning Rate:** 0.0003
- **Gamma:** 0.99, Lambda: 0.95
- **Clip Ratio:** 0.2
- **Dropout:** 0.25
- **L2 Regularization:** 0.02
- **N Steps:** 2048, Epochs: 10

### Environment
- **Transaction Costs:** Symbol-specific
- **Max Drawdown Limit:** 25%
- **Position Size:** 10% of capital
- **Random Start:** Enabled
- **Max Steps/Episode:** 500

## Data Summary

```
Symbol: BTCUSDT 1h
Total Candles: 8,760 (1 year)
Train Candles: 7,008 (80%)
Val Candles: 1,752 (20%)

Training Period: 2025-02-01 to 2025-11-19
  Mean Return: -0.001%
  Volatility: 0.46%
  Total Return: -14%

Validation Period: 2025-11-19 to 2026-01-31
  Mean Return: -0.005%
  Volatility: 0.46%
  Total Return: -9.5%
```

## Key Findings

1. **Overfitting is Severe**
   - Train win rate: 93-95%
   - Val win rate: 46-47%
   - Gap: ~47% (target <15%)

2. **Regularization Didn't Help**
   - Smaller network: No improvement
   - Higher dropout: No improvement
   - Higher L2: No improvement

3. **Data Limitation**
   - Only 8,760 samples (1 year hourly)
   - 500-step episodes get memorized
   - Need significantly more data

## Recommendations

1. **Get More Data**
   - Fetch 3+ years of history
   - Add multiple symbols (ETH, SOL)
   - Cross-asset generalization

2. **Simpler Approach**
   - Consider gradient boosting (XGBoost)
   - Rule-based ICT signals
   - Backtest ICT concepts first

3. **Walk-Forward Validation**
   - Enable rolling window validation
   - Smaller train windows
   - Multiple test folds

## How to Train

```bash
# Fetch data
npx tsx scripts/fetch-historical-data.ts --symbol BTCUSDT --timeframe 1h --days 365

# Quick test (10 episodes)
npx tsx scripts/train-agent.ts --episodes 10

# Baseline run (50 episodes)
npx tsx scripts/train-agent.ts --episodes 50 --output ./models/test.json

# Full training (500 episodes)
npx tsx scripts/train-agent.ts --episodes 500 --output ./models/dqn-v1.json

# Data analysis
npx tsx scripts/analyze-data.ts
```

## Model Files

Models saved to `/models/`:
- `dqn-fixed-v1.json` - Baseline DQN
- `dqn-anti-overfit-v1.json` - Reduced network DQN
- `baseline-test.json` - 50 episode test

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/rl/agent/dqn-agent.ts` | DQN implementation |
| `src/lib/rl/agent/ppo-agent.ts` | PPO implementation |
| `src/lib/rl/environment/trading-env.ts` | Trading environment |
| `src/lib/rl/environment/reward-calculator.ts` | Reward shaping |
| `src/lib/rl/environment/state-builder.ts` | State features |
| `scripts/train-agent.ts` | Training CLI |
| `scripts/analyze-data.ts` | Data analysis |
