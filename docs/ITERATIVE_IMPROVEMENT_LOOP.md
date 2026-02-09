# Iterative RL Trading Model Improvement Framework

## The Problem

We've been in a cycle of:
1. Make changes → 2. Short backtest looks good → 3. Long backtest fails → 4. Repeat

This happens because:
- No documentation of what was tried and why it failed
- Validating on 30-day data, then failing on 90-day data
- No systematic learning from past experiments
- No proper out-of-sample testing

---

## The Solution: Iterative Research-Train-Validate Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                    ITERATIVE IMPROVEMENT LOOP                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   1. RESEARCH          2. HYPOTHESIS         3. IMPLEMENT        │
│   ─────────────        ──────────────        ────────────        │
│   Web search for       Document what         Make targeted       │
│   techniques           we're testing         code changes        │
│                        and why                                   │
│         │                    │                     │             │
│         └──────────┬─────────┴─────────────────────┘             │
│                    ▼                                             │
│            4. TRAIN (with logging)                               │
│            ────────────────────────                              │
│            Save metrics to experiments.json                      │
│                    │                                             │
│                    ▼                                             │
│         5. VALIDATE (90-day backtest)  ◀── HARD GATE            │
│         ──────────────────────────────                           │
│         All 3 symbols, 2160 bars each                           │
│                    │                                             │
│         ┌─────────┴─────────┐                                   │
│         │                   │                                    │
│     PASS: Sharpe>0      FAIL                                    │
│     all symbols              │                                   │
│         │                    │                                   │
│         ▼                    ▼                                   │
│   6. DOCUMENT           6. DOCUMENT                             │
│   ─────────────        ─────────────                            │
│   Success + why        Failure + why                            │
│         │                    │                                   │
│         ▼                    └──────────▶ Back to Step 1        │
│   7. NEXT ITERATION                                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

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

## Files & Scripts

| File | Purpose |
|------|---------|
| `experiments/experiments.json` | Persistent experiment registry |
| `experiments/PROGRESS.md` | Human-readable progress log |
| `scripts/train-iterative.ts` | Training script with auto-logging |
| `scripts/validate-90day.ts` | 90-day backtest gate script |

---

## Usage

### Run a New Experiment

```bash
npx tsx scripts/train-iterative.ts --hypothesis "What are we testing and why"
```

### With Custom Hyperparameters

```bash
npx tsx scripts/train-iterative.ts \
  --hypothesis "Testing higher L2 regularization" \
  --lr 0.0003 \
  --l2 0.02 \
  --dropout 0.35 \
  --episodes 150
```

### Validate an Existing Model

```bash
npx tsx scripts/validate-90day.ts --model models/xxx.json
```

---

## Hyperparameter Guide

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| `--dropout` | 0.30 | 0.20-0.50 | Higher = more regularization |
| `--lr` | 0.0004 | 0.0001-0.001 | Lower = slower, more stable |
| `--l2` | 0.012 | 0.005-0.05 | Higher = stronger weight penalty |
| `--epsilon-end` | 0.15 | 0.05-0.25 | Lower = more exploitation |
| `--episodes` | 150 | 50-300 | More = longer training |

---

## Research Techniques to Try

1. **Market Regime Detection**
   - Detect volatility regimes (low/medium/high)
   - Train separate sub-models per regime

2. **CPCV (Combinatorial Purged Cross-Validation)**
   - Superior overfitting detection vs walk-forward
   - Source: https://arxiv.org/abs/2209.05559

3. **Multi-Objective Reward Shaping**
   - Balance profitability vs drawdown vs consistency

4. **Data Augmentation**
   - Add noise to training data
   - Synthetic regime changes

5. **Symbol-Aware Features**
   - Different volatility normalization per symbol

---

## Workflow Rules

1. **Never skip 90-day backtest** - It's the only honest measure
2. **Always document why** - Both successes and failures
3. **One change at a time** - Otherwise can't learn what worked
4. **Research before coding** - Find evidence-based techniques
5. **Track everything** - Config, results, learnings

---

## Iteration Template

Each iteration should follow this structure in PROGRESS.md:

```markdown
### exp-XXX: [Brief Hypothesis]

- **Date**: YYYY-MM-DD
- **Hypothesis**: What we're testing and why
- **Config**: Key parameter changes
- **Training Result**:
  - Episodes completed
  - Best val Sharpe
  - Model path
- **90-Day Backtest (GATE)**:

| Symbol | Sharpe | Status |
|--------|--------|--------|
| BTC | X.XX | PASS/FAIL |
| ETH | X.XX | PASS/FAIL |
| SOL | X.XX | PASS/FAIL |

- **Outcome**: PASS/FAIL
- **Learnings**: What we learned from this iteration
- **Next Action**: What to try next
```
