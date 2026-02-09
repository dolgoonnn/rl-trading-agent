# ICT Trading Model: Iterative Roadmap to Production

## Context

The current RL approach (DQN meta-strategy agent selecting from 5 ICT strategies) has a **1/19 experiment pass rate** with extreme fragility — changing epsilon by 0.01 destroys all performance. All 4 advanced DQN techniques (Dueling, N-step, PER, NoisyNet) failed to beat baseline DDQN. This points to a model finding a narrow lucky path, not learning robust trading patterns.

**The ICT strategy detection layer is solid.** The 5 strategies (OrderBlock, FVG, BOS Continuation, CHoCH Reversal, Wait) are well-implemented with proper ICT methodology. The problem is the RL meta-layer selecting between them unreliably.

**Strategic pivot:** Replace the fragile RL strategy selector with a deterministic confluence scorer. Use walk-forward validation instead of static backtesting. Deploy to paper trading. Only reintroduce RL later as an optimizer if the rule-based system proves profitable.

---

## Iteration 0: Reproducibility Test
**Duration:** ~1 day | **Goal:** Confirm whether exp-014's success was real or lucky

### Hypothesis
exp-014 (the only passing model) found a fragile local optimum, not a robust policy.

### Implementation
- Run exp-014 config 5 times with different random seeds
- Same params: dropout=0.38, LR=0.00028, L2=0.028, epsilon=0.16, 120 episodes
- Record per-symbol Sharpe for each run through existing 90-day gate

### Files
- `scripts/train-iterative.ts` — wrap in seed loop

### Measurement
- Pass rate out of 5 runs
- Variance of BTC Sharpe across runs

### Decision Gate
- If 0-1/5 pass → confirms fragility, validates pivot to rule-based (expected outcome)
- If 3+/5 pass → RL signal is real, but still proceed with rule-based as parallel track

### Document
- Results in `experiments/iteration-0-reproducibility.md`

---

## Iteration 1: Walk-Forward Validation Framework
**Duration:** 1-2 days | **Goal:** Replace static 90-day gate with proper validation

### Hypothesis
Static 90-day gate enables overfitting to one specific data window.

### Implementation
New script: `scripts/walk-forward-validate.ts`

```
Data: 12+ months hourly candles (already have ~12mo per symbol)
Training window: 3 months rolling
Validation window: 1 month following
Slide: 1 month forward each step

Window 1: Train [M1-M3], Validate [M4]
Window 2: Train [M2-M4], Validate [M5]
...
Window 9: Train [M9-M11], Validate [M12]
```

### Pass Criteria
- Positive Sharpe on >= 7/9 windows per symbol
- No window with Sharpe < -2.0 (catastrophic failure)

### Files
- New: `scripts/walk-forward-validate.ts`
- Reads: `data/BTCUSDT_1h.json`, `data/ETHUSDT_1h.json`, `data/SOLUSDT_1h.json`

### Document
- Framework design + baseline results in `experiments/iteration-1-walk-forward.md`
- This becomes the **gold standard** for all future iterations

---

## Iteration 2: Rule-Based Confluence Scorer
**Duration:** 2-3 days | **Goal:** Build transparent strategy selector that beats RL agent

### Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

### Architecture
At each bar, evaluate all 4 active strategies. Each signal gets scored:

| Factor | Weight | Source Module |
|--------|--------|---------------|
| Structure alignment (bias matches direction) | 2.0 | `src/lib/ict/market-structure.ts` |
| Kill zone active (London/NY Open) | 1.5 | `src/lib/ict/kill-zones.ts` |
| Liquidity sweep confirmation | 1.5 | `src/lib/ict/liquidity.ts` |
| OB proximity + freshness (unmitigated) | 1.0 | `src/lib/ict/order-blocks.ts` |
| FVG at CE level + displacement | 1.0 | `src/lib/ict/fair-value-gaps.ts` |
| Recent BOS in direction (confidence >= 0.5) | 1.0 | market-structure structureBreaks |
| R:R ratio >= 2.0 | 0.8 | Strategy's detectEntry result |
| OTE zone position (62%-79% retrace) | 0.5 | BOS strategy Fibonacci calc |
| Breaker block confluence | 0.5 | `src/lib/ict/breaker-blocks.ts` |
| OB + FVG confluence (both present) | 1.0 | Combined check |

**Decision logic:**
1. Evaluate all 4 strategies → get signals with scores
2. Take highest-scoring signal IF score >= minimum threshold
3. If nothing passes threshold → WAIT

### Files
- New: `src/lib/rl/strategies/confluence-scorer.ts`
- New: `scripts/backtest-confluence.ts`
- Reuses: `src/lib/rl/strategies/ict-strategies.ts` (existing strategy classes)
- Reuses: All `src/lib/ict/*.ts` detection modules

### Measurement
- Walk-forward Sharpe (using Iteration 1 framework)
- Comparison to exp-014 on same data windows
- Per-strategy signal quality (win rate, avg R:R)

### Document
- Results in `experiments/iteration-2-confluence-scorer.md`

---

## Iteration 3: Threshold & Weight Calibration
**Duration:** 1-2 days | **Goal:** Optimize scorer without overfitting

### Hypothesis
Weights and threshold can be tuned using walk-forward cross-validation with a maximin objective (maximize worst-case window).

### Implementation
- Grid search: threshold [3.0, 3.5, 4.0, 4.5, 5.0]
- For each threshold, run full walk-forward validation
- Select threshold maximizing **worst-case window Sharpe** (not average)
- Sensitivity test: vary each weight by +/-0.5, check stability

### Anti-Overfit Rule
Optimize for `max(min(window_sharpe))`, NOT `max(avg(window_sharpe))`.

### Files
- New: `scripts/calibrate-confluence.ts`
- Uses: `scripts/walk-forward-validate.ts` from Iteration 1

### Document
- Results in `experiments/iteration-3-calibration.md`

---

## Iteration 4: Position Management Optimization
**Duration:** 1-2 days | **Goal:** Optimize exits, SL/TP, and sizing

### Hypothesis
The existing position management (break-even at 1R, partial at 1.5R, trail at 2R) can be improved with per-strategy exit logic.

### Implementation
- Test strategy-specific exits:
  - OB strategy: exit on opposing OB or CHoCH
  - FVG strategy: exit on gap fill or opposing FVG
  - BOS strategy: exit on structure break against position
  - CHoCH strategy: tighter stops, higher R:R targets
- Test Kelly-based position sizing vs fixed 10%
- Reuse existing `PositionManager` from `src/lib/paper-trading/position-manager.ts`

### Files
- Modify: `src/lib/rl/strategies/confluence-scorer.ts` (add exit logic)
- Reuse: `src/lib/paper-trading/position-manager.ts`, `position-sizer.ts`

### Document
- Results in `experiments/iteration-4-position-management.md`

---

## Iteration 5: Paper Trading Deployment
**Duration:** 2-3 days | **Goal:** Deploy rule-based scorer to live paper trading

### Implementation
1. Create `ConfluencePaperTrader` — replaces DQN agent with confluence scorer
2. Wire to existing Binance WS, candle manager, risk manager
3. Start BTC-only for first 2 weeks
4. Existing risk manager circuit breakers stay (2% daily loss, 5% drawdown, cooldowns)

### Files
- New or modify: `src/lib/paper-trading/paper-trader.ts` (swap DQN → confluence scorer)
- Wire: `src/lib/paper-trading/binance-ws.ts`, `risk-manager.ts`, `position-manager.ts`
- UI: `src/app/live-trading/page.tsx` (connect to real WS, remove demo data)

### Measurement
- Live P&L, rolling 30-day Sharpe
- Trade count, win rate
- Slippage comparison (backtest assumed vs actual)

### Document
- Daily paper trading log in `experiments/paper-trading-log.md`

---

## Iteration 6: Multi-Asset Expansion
**Duration:** 1-2 days | **Goal:** Add ETH/SOL to paper trading, test forex in backtest

### Implementation
- Add ETH + SOL to paper trading (WS already supports multi-symbol)
- Backtest confluence scorer on forex data
- Check if same weights/threshold generalize across asset classes

### Files
- Forex backtest: `scripts/backtest-confluence.ts` (extend to forex symbols)
- Paper trading: config change in `production-config.ts`

### Document
- Results in `experiments/iteration-6-multi-asset.md`

---

## Iteration 7: RL as Weight Optimizer (Optional, Week 4-5)
**Duration:** 2-3 days | **Goal:** Test if RL can improve confluence weights based on regime

### Prerequisite
Only attempt if rule-based system from Iterations 2-6 shows profit on paper trading.

### Architecture
```
Confluence Scorer (base weights) → RL Agent adjusts weights per regime → Final signal
```

- RL agent outputs weight multipliers (0.5x to 1.5x) for each factor
- State: 42 existing features + regime indicators (ADX, volatility percentile)
- Much smaller action space than current meta-strategy
- PPO agent for continuous actions

### Key Difference from Current RL
The RL is **not making trade decisions**. It's adjusting the sensitivity of a proven rule-based system.

---

## 30-Day Paper Trading Gate (Weeks 5-6)

| Metric | Requirement |
|--------|-------------|
| Duration | >= 30 days continuous |
| Per-symbol Sharpe (30-day rolling) | > 0 |
| Aggregate win rate | > 40% |
| Max drawdown | < 5% |
| Min trades per symbol | >= 15 |
| Circuit breaker triggers | 0 |
| Walk-forward pass rate (backtested) | >= 70% |

---

## Experiment Tracking

Each iteration produces a markdown file in `experiments/`:
```
experiments/
  iteration-0-reproducibility.md
  iteration-1-walk-forward.md
  iteration-2-confluence-scorer.md
  iteration-3-calibration.md
  iteration-4-position-management.md
  iteration-5-paper-trading.md
  iteration-6-multi-asset.md
  iteration-7-rl-optimizer.md     (if attempted)
  paper-trading-log.md
```

Each file follows the template:
```markdown
# Iteration N: [Title]
## Hypothesis
## Implementation Summary
## Results (tables, metrics)
## Key Learnings
## Decision: [Continue / Pivot / Adjust]
## Impact on Next Iteration
```

---

## Why This Over Continuing RL

1. **1/19 pass rate = fragile.** The parameter space is exhausted.
2. **RL adds wrong complexity.** Weighted score does this transparently.
3. **Time-to-production.** Rule-based → paper trading in ~2 weeks.
4. **The strategies are already good.** Detection isn't the bottleneck — selection is.
5. **RL can still add value later** (Iteration 7) as a regime-aware weight optimizer.
