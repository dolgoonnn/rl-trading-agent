# Plan: Make RL Viable for ICT Trading

## Context

The RL approach (DQN meta-strategy agent) was abandoned after 1/19 experiment pass rate. Root causes:
1. **Circular features**: All 42 features derived from same OHLCV data that generates strategies — no independent signal
2. **Over-parameterized**: 37K params on 26K unique contexts = memorization capacity
3. **Sparse rewards**: Agent only gets feedback at trade exit (20-50 bars later)
4. **Wrong role**: RL tried to "pick strategies" — same job the rule-based confluence scorer does transparently

Additionally, Iter 9 revealed: **friction (0.30% RT) exceeds edge at 1H**. PnL without friction: +50%, with friction: -103%. Any RL improvement must produce a bigger edge, not just optimize a marginal one.

**Goal**: Redesign the RL pipeline so it can learn robust patterns by addressing all 4 root causes.

---

## Phase 1: Independent Data Sources (Order Flow Features)

**Why**: Break the circular dependency. Give the agent information the rule-based system can't encode.

### 1.1 Create Binance Futures API fetcher
**File**: `src/lib/data/binance-futures-api.ts` (~150 lines)

Fetch from free public endpoints:
- **Funding rates**: `GET /fapi/v1/fundingRate` (every 8h)
- **Open interest**: `GET /fapi/v1/openInterest` (hourly snapshots)
- **Liquidations**: `GET /fapi/v1/allForceOrders` (event stream, aggregate hourly)
- **Long/Short ratio**: `GET /futures/data/globalLongShortAccountRatio` (hourly)

```typescript
interface FuturesSnapshot {
  timestamp: number;
  fundingRate: number;          // -0.01 to 0.01
  openInterest: number;         // USD value
  longShortRatio: number;       // >1 = more longs
  liquidationVolLong: number;   // Long liqs past hour
  liquidationVolShort: number;  // Short liqs past hour
}
```

### 1.2 Extract taker buy volume from existing klines
**File**: `scripts/fetch-historical-data.ts` (modify)

Binance klines already return `takerBuyBaseAssetVolume` at index [9] — currently ignored. Extract it.

### 1.3 Create order flow feature builder
**File**: `src/lib/rl/environment/order-flow-features.ts` (~120 lines)

10 new features (orthogonal to OHLCV):
| Feature | Source | Range |
|---------|--------|-------|
| `fundingRate` | Futures API | [-0.01, 0.01] |
| `fundingRateTrend` | 3-period delta | [-1, 1] |
| `openInterestChange1h` | OI delta | [-0.1, 0.1] |
| `openInterestChange24h` | OI 24h delta | [-0.5, 0.5] |
| `longShortRatio` | Futures API | [0, 3] normalized |
| `takerBuyRatio` | klines[9] / volume | [0, 1] |
| `liquidationPressure` | long_liqs - short_liqs normalized | [-1, 1] |
| `liquidationVolume` | total liqs / avg volume | [0, 5] clipped |
| `fundingOIDiv` | funding up + OI down = divergence | [-1, 1] |
| `crowdingSig` | extreme funding + extreme ratio = crowded | [0, 1] |

### 1.4 Backfill historical futures data
**File**: `scripts/sync-binance-futures.ts` (~100 lines)

Fetch 18 months of hourly funding/OI/liquidation data for BTC, ETH, SOL. Store in `data/{SYMBOL}_futures_1h.json`.

### 1.5 Extend state builder
**File**: `src/lib/rl/environment/state-builder.ts` (modify)

Add order flow context. New total: **52 features** (42 existing + 10 order flow).

---

## Phase 2: Overfitting Prevention Framework

**Why**: 1/19 pass rate = no statistical rigor. Need to reject overfitted models before deployment.

### 2.1 Implement Probability of Backtest Overfitting (PBO)
**File**: `src/lib/rl/utils/pbo.ts` (~150 lines)

Based on [Bailey et al. CSCV method](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253):
- Partition walk-forward windows into combinatorial train/test splits
- For each split: rank models by in-sample Sharpe, check if best IS model is also best OOS
- PBO = fraction of splits where IS winner underperforms OOS
- **Reject any model with PBO > 0.50** (coin-flip or worse)

### 2.2 Multi-symbol training (activate existing code)
**File**: `src/lib/rl/training/multi-symbol-trainer.ts` (already exists, activate)

- Train on BTC + ETH + SOL simultaneously with ATR normalization
- Prevents single-asset memorization
- Already implemented, just not wired into training scripts

### 2.3 Walk-forward validation with CSCV
**File**: `scripts/walk-forward-validate.ts` (modify)

Add PBO calculation after walk-forward sweep. Report:
- Walk-forward pass rate (existing)
- PBO score (new) — probability the best config is overfitted
- Deflated Sharpe ratio (new) — adjusts for multiple testing

### 2.4 Overfitting hypothesis test for RL agents
**File**: `scripts/validate-rl-agent.ts` (~200 lines)

Based on [arxiv.org/abs/2209.05559](https://arxiv.org/abs/2209.05559):
- Train N agents (e.g., 20) with same architecture, different seeds
- Estimate overfitting probability per agent
- Reject agents above PBO threshold
- Only deploy survivors

---

## Phase 3: PPO as Weight Optimizer (Not Strategy Picker)

**Why**: Don't use RL to pick strategies (the confluence scorer does this). Use RL to learn **regime-adaptive weights** for the 10 confluence factors.

Inspired by [Adaptive Alpha Weighting with PPO](https://arxiv.org/html/2509.01393):

### 3.1 Define PPO weight optimizer environment
**File**: `src/lib/rl/environment/weight-optimizer-env.ts` (~250 lines)

```typescript
// State: market regime context + order flow + recent performance
interface WeightOptimizerState {
  // Regime features (6)
  regimeLabel: number;         // encoded regime
  volatilityLevel: number;     // normalized ATR
  trendStrength: number;       // HH/HL pattern
  // Order flow (4)
  fundingRate: number;
  openInterestTrend: number;
  liquidationPressure: number;
  takerBuyRatio: number;
  // Recent performance (4)
  rollingWinRate: number;      // last 20 trades
  rollingPnL: number;          // normalized
  currentDrawdown: number;
  tradesThisWindow: number;
}

// Action: 10 weight adjustments (continuous, bounded)
type WeightAction = number[];  // 10 values in [-1, 1], mapped to weight multipliers [0.5, 2.0]

// Reward: risk-adjusted PnL of trades taken with these weights over next N bars
```

**Key design**: PPO outputs **multipliers** on the base weights, not raw weights. This preserves domain knowledge (base weights from calibration) while allowing regime adaptation.

### 3.2 Adapt existing PPO agent
**File**: `src/lib/rl/agent/ppo-agent.ts` (modify)

- Change action space from discrete (5 strategies) to continuous (10 weight multipliers)
- Use Gaussian policy (mean + std per weight) instead of categorical
- Smaller network: [32, 16] — only 14 state features, 10 outputs = ~1K params (vs 37K)
- **Critical**: Keep params << unique contexts to prevent memorization

### 3.3 Training loop for weight optimizer
**File**: `scripts/train-weight-optimizer.ts` (~200 lines)

- Episode = one walk-forward window (720 bars)
- Every 24 bars: PPO observes regime context, outputs weight multipliers
- Confluence scorer runs with adjusted weights for next 24 bars
- Reward = risk-adjusted PnL of trades in that 24-bar window
- Multi-symbol training (BTC + ETH + SOL simultaneously)

### 3.4 Integration with confluence scorer
**File**: `src/lib/rl/strategies/confluence-scorer.ts` (modify)

Add method:
```typescript
evaluateWithWeightMultipliers(
  candles: Candle[],
  currentIndex: number,
  weightMultipliers: Record<keyof ConfluenceWeights, number>
): ConfluenceScorerResult
```

---

## Phase 4: ARES — Attention-Based Reward Shaping

**Why**: Solve sparse rewards. Agent only gets reward at trade exit (20-50 bars later). [ARES](https://arxiv.org/html/2505.10802v1) uses transformer attention to decompose delayed rewards into per-step credit.

### 4.1 Implement ARES reward shaper
**File**: `src/lib/rl/training/ares-reward-shaper.ts` (~200 lines)

- Collect episodes: (state, action, ..., final_reward)
- Train transformer to predict episode return from state-action sequence
- Extract attention weights from final layer → per-step credit
- Use shaped rewards as dense signal for PPO/DQN training

### 4.2 Integrate with training loop
**File**: `scripts/train-weight-optimizer.ts` (modify)

- Pre-train ARES transformer on historical trade episodes
- During PPO training, use ARES-shaped rewards instead of sparse trade-exit rewards
- Expected: faster convergence, less credit assignment noise

---

## Phase 5: Transformer Q-Network (Optional, If Phase 3 Succeeds)

### 5.1 Wire existing transformer into DQN
**File**: `src/lib/rl/agent/dqn-agent.ts` (modify)

- `src/lib/rl/agent/transformer.ts` already has full implementation
- Replace dense [128, 64, 32] with transformer encoder
- Lower param count (~5-10K vs 37K)
- Processes 60-bar return sequence with attention before Q-value output

### 5.2 Multi-symbol transformer training
Use multi-symbol trainer with transformer DQN + order flow features.

---

## Implementation Order & Dependencies

```
Phase 1 (Order Flow Data)     ← DO FIRST, benefits both rule-based AND RL
  ↓
Phase 2 (Overfitting Prevention) ← Validation framework before training
  ↓
Phase 3 (PPO Weight Optimizer)  ← The core RL redesign
  ↓
Phase 4 (ARES Reward Shaping)   ← Improves Phase 3 training
  ↓
Phase 5 (Transformer DQN)       ← Optional architecture upgrade
```

**Phase 1 also benefits the rule-based system**: Order flow features could be added as new confluence factors (e.g., "funding rate alignment" = +1.0 weight).

---

## Critical Files to Modify/Create

| File | Action | Phase |
|------|--------|-------|
| `src/lib/data/binance-futures-api.ts` | CREATE | 1 |
| `src/lib/rl/environment/order-flow-features.ts` | CREATE | 1 |
| `scripts/sync-binance-futures.ts` | CREATE | 1 |
| `scripts/fetch-historical-data.ts` | MODIFY (extract taker buy vol) | 1 |
| `src/lib/rl/environment/state-builder.ts` | MODIFY (add order flow) | 1 |
| `src/lib/rl/utils/pbo.ts` | CREATE | 2 |
| `scripts/walk-forward-validate.ts` | MODIFY (add PBO) | 2 |
| `scripts/validate-rl-agent.ts` | CREATE | 2 |
| `src/lib/rl/environment/weight-optimizer-env.ts` | CREATE | 3 |
| `src/lib/rl/agent/ppo-agent.ts` | MODIFY (continuous actions) | 3 |
| `scripts/train-weight-optimizer.ts` | CREATE | 3 |
| `src/lib/rl/strategies/confluence-scorer.ts` | MODIFY (weight multipliers) | 3 |
| `src/lib/rl/training/ares-reward-shaper.ts` | CREATE | 4 |

---

## Verification Plan

### Phase 1 Verification
```bash
# Fetch futures data
npx tsx scripts/sync-binance-futures.ts --symbol BTCUSDT --months 18
# Verify data integrity
npx tsx scripts/sync-binance-futures.ts --verify
# Run existing backtest with order flow features as new confluence factors
npx tsx scripts/backtest-confluence.ts --symbol BTCUSDT --with-orderflow
```

### Phase 2 Verification
```bash
# Run walk-forward with PBO
npx tsx scripts/walk-forward-validate.ts --strategy ob --pbo
# Should output: Walk-forward pass rate + PBO score + Deflated Sharpe
```

### Phase 3 Verification
```bash
# Train weight optimizer
npx tsx scripts/train-weight-optimizer.ts --episodes 500 --symbols BTC,ETH,SOL
# Validate
npx tsx scripts/validate-rl-agent.ts --model models/weight_optimizer_latest.json --pbo-threshold 0.50
# Compare: static weights vs PPO-optimized weights
npx tsx scripts/walk-forward-validate.ts --strategy ob --ppo-weights models/weight_optimizer_latest.json
```

### Success Criteria
- **Phase 1**: Order flow features reduce feature circularity. Measurable: at least 2 order flow features have >0.05 correlation with trade outcome (independent of existing factors)
- **Phase 2**: PBO < 0.40 for surviving models (better than coin-flip)
- **Phase 3**: PPO weight optimizer improves walk-forward pass rate by >5pp over static weights (46.8% → 52%+)
- **Overall**: Walk-forward pass rate > 55% with PPO-optimized weights + order flow features

---

## Key Research Sources

- [DRL Crypto Overfitting (Hypothesis Test)](https://arxiv.org/abs/2209.05559)
- [Adaptive Alpha Weighting with PPO](https://arxiv.org/html/2509.01393)
- [ARES: Attention-Based Reward Shaping](https://arxiv.org/html/2505.10802v1)
- [CSCV / Probability of Backtest Overfitting](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253)
- [Walk-Forward with Hypothesis Testing](https://arxiv.org/html/2512.12924v1)
- [Venue Share Indicators for Crypto RL](https://www.mdpi.com/2079-8954/14/1/111)
- [Binance Futures API: Funding Rates](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History)
- [Binance Futures API: Open Interest](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest)
