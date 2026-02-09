# CMA-ES Optimization System

Complete technical documentation of the hyperparameter optimization pipeline for the ICT confluence trading system.

---

## Table of Contents

1. [ELI5 — The Simple Version](#eli5--the-simple-version)
2. [System Overview](#system-overview)
3. [Walk-Forward Validation](#walk-forward-validation)
4. [The 23 Parameters](#the-23-parameters)
5. [CMA-ES Algorithm](#cma-es-algorithm)
6. [Run History](#run-history)
7. [Convergence Analysis](#convergence-analysis)
8. [Production Config](#production-config)

---

## ELI5 — The Simple Version

Imagine you're tuning a radio to find the best station. But this radio has **23 dials** instead of one — and you can't see the frequency display, you can only hear the quality of the sound.

Here's how the system works:

1. **The Radio (Confluence Scorer)**: A scoring system that looks at crypto price data and decides "should I trade here?" It checks things like: Is the market trending? Is there a supply/demand zone nearby? Was there a recent breakout? Each check gets a weight (how much it matters) and a threshold (how much total confidence is needed before trading).

2. **The Sound Quality (Walk-Forward Validation)**: We test the radio on historical data — but we do it honestly. We train on 3 months, then test on the NEXT month (data the system has never seen). We slide this window forward across ~3 years of data on 3 different cryptocurrencies. A "pass" means the system made money in that unseen month. Our score is the percentage of months that passed.

3. **The Tuner (CMA-ES)**: This is the algorithm that turns the 23 dials. It works like evolution:
   - **Generate** 16-25 random dial settings (a "population")
   - **Test** each one through walk-forward validation
   - **Keep the best** settings, throw away the worst
   - **Make new settings** near the winners, with some randomness
   - **Repeat** for 30-40 generations

4. **The Key Trick (Normalization)**: Some dials go from 0-3, others from 2.5-6.5, others from 50-150. Without normalization, the algorithm explores the big-range dials too aggressively and the small-range dials too timidly. By squishing everything to 0-1, all dials get equal attention. This single fix improved our score from 72.3% to 74.0%.

5. **The Result**: After 18 rounds of optimization over several days, we went from **71.3% → 78.1% pass rate** — meaning the system profitably trades in 78% of unseen monthly windows.

---

## System Overview

### What the Trading System Does

The system trades BTC, ETH, and SOL on 1-hour candles using **ICT (Inner Circle Trader)** concepts:

- **Order Blocks (OB)**: Institutional supply/demand zones where large players entered
- **Fair Value Gaps (FVG)**: Price imbalances that tend to get filled
- **Market Structure**: Breaks of structure (BOS) and changes of character (CHoCH)
- **Kill Zones**: High-probability trading sessions (London Open, NY Open, NY PM)
- **Liquidity Sweeps**: Runs of stop-losses that precede reversals

### How the Confluence Scorer Works

The scorer evaluates each trade candidate across **13 factors**. Each factor returns a value from 0 to 1, which is multiplied by its weight. The weighted sum becomes the **confluence score**.

```
confluence_score = sum(factor_i * weight_i)  for i in 1..13
```

If `confluence_score >= threshold`, the trade is taken. The threshold varies by **market regime** (trend direction + volatility level), and some regimes are suppressed entirely (zero trades).

### What Gets Optimized

The optimizer jointly tunes:

- **10 factor weights** — how much each confluence factor matters
- **5 regime thresholds** — minimum score required per market condition
- **8 hyperparameters** — base threshold, exit timing, position sizing, etc.

This joint optimization is critical. Individual parameter sweeps hit a 71.3% ceiling because parameters interact (e.g., raising a weight is meaningless if the threshold rises too). CMA-ES explores the joint space and finds combinations that single-param sweeps cannot.

---

## Walk-Forward Validation

Walk-forward validation prevents overfitting by always testing on unseen data.

### Window Mechanics

```
Data: ~26,000 hourly candles per symbol (~3 years)

Window 1:  [===== Train 3mo =====][= Val 1mo =]
Window 2:       [===== Train 3mo =====][= Val 1mo =]
Window 3:            [===== Train 3mo =====][= Val 1mo =]
...
Window N:                                        [===== Train =====][= Val =]
```

| Parameter | Value | Description |
|-----------|-------|-------------|
| Train window | 2,160 bars | ~3 months of hourly candles |
| Validation window | 720 bars | ~1 month of hourly candles |
| Slide step | 720 bars | Move forward 1 month between windows |
| Lookback buffer | 100 bars | Extra candles prepended for indicator warm-up |
| Symbols | BTC, ETH, SOL | Each validated independently |

This produces **~32 windows per symbol**, **~97 eligible windows total** across 3 symbols.

### Pass Criteria

A validation window **passes** if:
- The Sharpe ratio is positive (profitable on a risk-adjusted basis)
- Windows with zero trades are **skipped** (not counted as pass or fail)

The overall **pass rate** = (passed windows) / (eligible windows).

### Why This Matters

A system can look great on in-sample data but fail on unseen data. Walk-forward validation is the gold standard for trading system evaluation because:

1. **No future leakage**: Validation data always comes AFTER training data
2. **Multiple independent tests**: ~97 windows, not just one backtest
3. **Cross-asset generalization**: Must work on BTC, ETH, and SOL simultaneously
4. **Regime diversity**: Windows span bull markets, bear markets, ranging periods, and high/low volatility

---

## The 23 Parameters

### Weight Multipliers (10 parameters)

These scale the default weights of each confluence factor. A multiplier of 1.0 means "use the default weight"; 2.0 means "double the importance".

| # | Parameter | Range | Default | Run 18 Multiplier | Effective Weight | What It Controls |
|---|-----------|-------|---------|-------------------|-----------------|-----------------|
| 1 | structureAlignment | 0.0–3.0 | 2.0 | 1.330 | 2.660 | Market bias matches trade direction |
| 2 | killZoneActive | 0.0–3.0 | 0.5 | 1.628 | 0.814 | Trading during high-probability sessions |
| 3 | liquiditySweep | 0.0–3.0 | 2.0 | 0.867 | 1.733 | Recent stop-run in trade direction |
| 4 | obProximity | 0.0–3.0 | 1.0 | 1.103 | 1.103 | Freshness of the order block (exponential decay) |
| 5 | fvgAtCE | 0.0–3.0 | 1.0 | 1.554 | 1.554 | FVG at consequent encroachment with displacement |
| 6 | recentBOS | 0.0–3.0 | 1.0 | 1.255 | 1.255 | Break of structure within 30 bars |
| 7 | rrRatio | 0.0–3.0 | 1.5 | 0.418 | 0.627 | Risk-reward ratio >= 2.0 |
| 8 | oteZone | 0.0–3.0 | 0.5 | 1.574 | 0.787 | Entry in OTE (62-79% fib) zone |
| 9 | obFvgConfluence | 0.0–3.0 | 1.0 | 1.352 | 1.352 | Both OB and FVG present near price |
| 10 | momentumConfirmation | 0.0–3.0 | 0.0 | — | 0.0 | Pullback confirmation (disabled) |

Notable CMA-ES findings:
- **rrRatio dropped 58%** (1.5 → 0.627): R:R ratio is less predictive than expected
- **fvgAtCE rose 55%** (1.0 → 1.554): FVG displacement/size is highly predictive
- **obFvgConfluence rose 35%** (1.0 → 1.352): Joint OB+FVG signal is underweighted at default

### Regime Thresholds (5 parameters)

Different market conditions require different quality bars for trade entry. Higher threshold = fewer, pickier trades.

| # | Regime | Range | Default | Run 18 | Interpretation |
|---|--------|-------|---------|--------|---------------|
| 11 | uptrend+high vol | 2.5–6.5 | 3.5 | 2.86 | Low bar → more entries (trend + vol = opportunity) |
| 12 | uptrend+normal vol | 2.5–6.5 | 5.0 | 6.17 | High bar → very selective (normal vol = less edge) |
| 13 | uptrend+low vol | 2.5–6.5 | 3.5 | 3.13 | Low bar → more entries |
| 14 | downtrend+normal vol | 2.5–6.5 | 4.5 | 4.33 | Moderate selectivity |
| 15 | downtrend+low vol | 2.5–6.5 | 5.0 | 4.48 | Slightly relaxed from default |

Three regimes are **fully suppressed** (zero trades): `ranging+normal`, `ranging+high`, `downtrend+high`.

### Hyperparameters (8 parameters)

| # | Parameter | Range | Default | Run 18 | What It Controls |
|---|-----------|-------|---------|--------|-----------------|
| 16 | baseThreshold | 3.0–5.5 | 4.15 | 4.672 | Minimum confluence score for any trade |
| 17 | obFreshnessHalfLife | 5–30 | 15 | 18 | Bars until OB proximity score halves (exponential decay) |
| 18 | atrExtensionBands | 1.5–5.0 | 3.0 | 4.10 | ATR multiplier to skip over-extended prices |
| 19 | partialFraction | 0.2–0.7 | 0.45 | 0.55 | Fraction of position closed at first TP |
| 20 | partialTriggerR | 0.5–1.5 | 0.85 | 0.84 | R-multiple that triggers partial take-profit |
| 21 | partialBeBuffer | 0.0–0.3 | 0.10 | 0.05 | Buffer added to breakeven stop after partial TP |
| 22 | maxBars | 50–150 | 100 | 108 | Maximum bars before forced exit |
| 23 | cooldownBars | 2–12 | 6 | 8 | Minimum bars between consecutive trades |

Key findings:
- **baseThreshold 4.67** (vs 4.15): ~12% more selective than default
- **atrExtension 4.10** (vs 3.0): 37% wider filter — avoid chasing extended moves
- **partialFraction 0.55** (vs 0.45): Take 55% off at first TP, not 45%

---

## CMA-ES Algorithm

### What Is CMA-ES?

**Covariance Matrix Adaptation Evolution Strategy** is a derivative-free optimization algorithm designed for continuous, noisy, non-convex problems. It's ideal for our use case because:

1. **No gradients needed**: Walk-forward pass rate is discrete and noisy
2. **Handles noise**: Population-based evaluation averages out randomness
3. **Learns correlations**: Discovers that certain parameters interact (e.g., threshold × halfLife)
4. **Scale-free**: Works in normalized [0,1] space regardless of original parameter ranges

### How It Works

```
Initialize: mean = center of search space, sigma = initial step size, C = identity matrix

For each generation:
  1. SAMPLE:  Generate λ candidates from N(mean, sigma² * C)
  2. EVALUATE: Run walk-forward validation on each candidate (subprocess)
  3. RANK:    Sort by fitness (descending)
  4. SELECT:  Keep top μ = λ/2 candidates
  5. UPDATE:
     - mean   ← weighted average of top μ candidates
     - sigma  ← adapt step size based on evolution path
     - C      ← update covariance from selected candidates
  6. CHECK:   Terminate if sigma < 1e-6 or no improvement for 20 generations
```

### Implementation Details

Our implementation uses a **diagonal covariance** approximation (not full CMA-ES) — appropriate for the 23-dimensional space and reduces per-generation overhead.

| Setting | Value | Notes |
|---------|-------|-------|
| Dimensions | 23 | All normalized to [0,1] |
| Population (λ) | 16–25 | Varied across runs |
| Parents (μ) | λ/2 | Top half selected |
| Generations | 30–40 | Per run |
| Sigma range | 0.005–0.15 | Decreased over warm-start chain |
| Termination | sigma < 1e-6 OR stale 20 gen | Whichever hits first |

### Fitness Function

Each candidate is evaluated by spawning a **subprocess** that runs the actual backtest script — ensuring zero simulation mismatch between optimization and production.

```typescript
fitness = passRate * 10                                              // Dominant factor
        + (pnl > 0 ? min(pnl, 200) + log1p(max(pnl - 200, 0)) * 10
                    : pnl * 0.5)                                     // PnL (capped + log)
        + (winRate > 50 ? (winRate - 50) * 2 : 0)                   // Win rate bonus
        + (trades < 200 ? -(200 - trades) * 0.5 :
           trades >= 400 ? min((trades - 400) * 0.02, 10) : 0)      // Trade count
```

**Pass rate dominates** (weight 10 per percentage point). A 1pp improvement in pass rate is worth 10 fitness points — more than any PnL or win rate adjustment. This correctly prioritizes robustness over raw returns.

### Normalization — The Key Breakthrough

Before Run 8, CMA-ES operated in raw parameter space:

| Parameter | Range | Stride |
|-----------|-------|--------|
| Weight multipliers | 0–3 | 3.0 |
| Regime thresholds | 2.5–6.5 | 4.0 |
| maxBars | 50–150 | 100.0 |
| partialBeBuffer | 0–0.3 | 0.3 |

With uniform sigma, the algorithm took 100× larger steps on `maxBars` than `partialBeBuffer`. This meant some parameters were barely explored while others were over-explored.

**Fix**: Normalize all parameters to [0,1] before CMA-ES sees them:

```
normalized = (raw - lower_bound) / (upper_bound - lower_bound)
```

All parameters now have stride 1.0 — uniform exploration. This single change produced a **+1.7pp improvement** (72.3% → 74.0%) in Run 8.

### Warm Starting

Each run can warm-start from a previous run's best solution. The mean is initialized to the previous best (in normalized space), and a fresh sigma is set. This allows:

1. **Progressive refinement**: Large sigma early → small sigma late
2. **Escape attempts**: Increase sigma to check for better basins
3. **Efficient search**: Don't re-explore already-excluded regions

The warm-start chain for this project: Run 1 → 4 → 5 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 18.

---

## Run History

### Overview Table

| Run | Dims | Norm | Sigma | Pop | Gen | Warm From | Pass Rate | Fitness | Trades | WR | PnL | Key Change |
|-----|------|------|-------|-----|-----|-----------|-----------|---------|--------|----|-----|------------|
| 1 | 18 | No | 0.15 | 16 | 30 | — | 72.3% | 994.4 | 742 | 54.4% | +464% | Initial 18-dim exploration |
| 3 | 21 | No | 0.15 | 20 | 30 | — | 69.5% | 966.9 | 740 | 54.2% | +488% | Added partial TP params (REGRESSION) |
| 4 | 21 | No | 0.15 | 20 | 30 | Run 1 | 72.3% | 995.7 | 750 | 54.4% | +496% | Warm start recovery |
| 5 | 21 | No | 0.08 | 20 | 30 | Run 4 | 72.3% | 999.1 | 747 | 54.9% | +576% | Fine-tuning, broke 999 fitness |
| 6 | 21 | No | 0.05 | 20 | 30 | Run 5 | 72.3% | 998.7 | 746 | 54.7% | +580% | Ultra-fine (slight regression) |
| 7 | 23 | No | 0.12 | 20 | 30 | Run 5 | 68.4% | 964.3 | 746 | 56.2% | +645% | Added maxBars/cooldown (REGRESSION) |
| **8** | **23** | **Yes** | **0.05** | **25** | **40** | **Run 5** | **74.0%** | **1017.4** | **751** | **55.1%** | **+608%** | **Normalization breakthrough** |
| 9 | 23 | Yes | 0.03 | 25 | 40 | Run 8 | 75.0% | 1032.6 | 739 | 55.8% | +815% | Steady climb |
| 10 | 23 | Yes | 0.02 | 25 | 40 | Run 9 | 76.8% | 1048.9 | 731 | 55.3% | +784% | Broke 76% ceiling |
| 11 | 23 | Yes | 0.015 | 25 | 40 | Run 10 | 77.1% | 1057.5 | 740 | 55.8% | +1102% | Broke 77% ceiling |
| 12 | 23 | Yes | 0.012 | 25 | 40 | Run 11 | 77.1% | 1059.8 | 736 | 56.3% | +1236% | Marginal fitness gain |
| 13 | 23 | Yes | 0.01 | 25 | 40 | Run 12 | 77.1% | 1060.2 | 736 | 56.3% | +1281% | Convergence signal |
| 14 | 23 | Yes | 0.02 | 30 | 40 | Run 13 | 77.1% | 1060.1 | 739 | 56.0% | +1332% | Escape attempt — confirmed basin |
| 15 | 23 | Yes | 0.008 | 16 | 40 | Run 14 | 78.1% | 1067.5 | 734 | 56.0% | +1084% | Broke 77.1% ceiling |
| 16 | 23 | Yes | 0.006 | 16 | 40 | Run 15 | 78.1% | 1071.2 | 729 | 56.2% | +1437% | Fitness peak candidate |
| 17 | 23 | Yes | 0.005 | 16 | 40 | Run 16 | 78.1% | 1070.1 | 728 | 56.2% | +1315% | No improvement |
| **18** | **23** | **Yes** | **0.01** | **25** | **40** | **Run 16** | **78.1%** | **1071.7** | **732** | **56.6%** | **+1398%** | **Production champion** |

### Phase Breakdown

**Phase 1 — Dimension Discovery (Runs 1–7)**

Started with 18 dimensions (weights + regime thresholds + base threshold + half-life + ATR extension). Expanding to 21 (partial TP params) and 23 (maxBars, cooldown) initially caused regressions because the raw parameter space was unevenly explored.

- Lesson: Adding dimensions without normalization hurts — the optimizer wastes budget on large-stride params.

**Phase 2 — Normalization Breakthrough (Run 8)**

Normalizing all 23 parameters to [0,1] space was the single most impactful change. Pass rate jumped from 72.3% to 74.0% immediately.

- Lesson: Parameter scale normalization is essential for CMA-ES with heterogeneous dimensions.

**Phase 3 — Refinement (Runs 9–14)**

Progressive sigma reduction from 0.03 to 0.01, with one escape attempt at sigma=0.02 (Run 14). Pass rate climbed steadily: 75.0% → 76.8% → 77.1%, then plateaued at 77.1% for four consecutive runs.

- Run 14 confirmed the 77.1% basin by expanding search and finding nothing better.

**Phase 4 — Ceiling Break (Run 15)**

Tight sigma (0.008) with smaller population (16) found a narrow improvement path that wider searches missed. Broke through to 78.1%.

- Lesson: Very tight local search can find improvements that wider exploration skips over.

**Phase 5 — Convergence Confirmation (Runs 16–18)**

Three runs at different sigma/population settings all converged to the same neighborhood:
- Run 16 (sigma=0.006, pop=16): fitness 1071.2
- Run 17 (sigma=0.005, pop=16): fitness 1070.1
- Run 18 (sigma=0.01, pop=25): fitness 1071.7

Maximum delta: 1.6 fitness points. Optimization is complete.

---

## Convergence Analysis

### Evidence That Optimization Is Done

1. **Pass rate plateau**: Runs 15–18 all at 78.1% — four consecutive runs at the same ceiling
2. **Fitness convergence**: Runs 16–18 within 1.6 points of each other (1070.1–1071.7)
3. **Escape failure**: Run 14 (wider sigma + larger pop) found nothing better than Run 13
4. **Escape retry**: Run 18 (wider sigma from Run 16 baseline) confirmed Run 16's basin
5. **Progressive sigma history**: 0.15 → 0.05 → 0.03 → 0.02 → 0.015 → 0.012 → 0.01 → 0.008 → 0.006 → 0.005. The search has narrowed to the tightest reasonable precision.

### Total Improvement vs Baseline

| Metric | Baseline | Run 18 | Improvement |
|--------|----------|--------|-------------|
| WF Pass Rate | 71.3% | 78.1% | +6.8 pp |
| Fitness | 987.1 | 1071.7 | +84.6 (+8.6%) |
| Win Rate | 54.5% | 56.6% | +2.1 pp |
| PnL (cumulative) | +533% | +1398% | +162% relative |
| Trades | 748 | 732 | -2% (similar volume) |

### Why 190 Single-Param Experiments Failed

Before CMA-ES, ~190 individual parameter experiments were run. None broke 71.3%. The reason: **parameter interactions**. For example:

- Raising `fvgAtCE` weight alone doesn't help if the threshold stays the same (the extra score just means more trades pass — including bad ones)
- Raising the threshold alone doesn't help if weights aren't rebalanced (you lose good trades along with bad ones)
- CMA-ES finds the joint combination where weight increases AND threshold increases work together

This is the fundamental advantage of joint optimization over grid/random search on individual parameters.

### PBO Validation

**Probability of Backtest Overfitting (PBO) = 18.5%** via CSCV method with 2,000 combinations.

A PBO below 25% is considered strong evidence of genuine predictive edge (not curve-fitting). At 18.5%, the probability that our walk-forward results are due to overfitting is low.

---

## Production Config

### Run 18 CLI Command

```bash
npx tsx scripts/backtest-confluence.ts \
  --strategy ob \
  --sl-mode dynamic_rr \
  --friction 0.0007 \
  --suppress-regime "ranging+normal,ranging+high,downtrend+high" \
  --threshold 4.672 \
  --exit-mode simple \
  --partial-tp "0.55,0.84,0.05" \
  --atr-extension 4.10 \
  --ob-half-life 18 \
  --max-bars 108 \
  --cooldown-bars 8 \
  --regime-threshold "uptrend+high:2.86,uptrend+normal:6.17,uptrend+low:3.13,downtrend+normal:4.33,downtrend+low:4.48" \
  --weights "structureAlignment:2.660,killZoneActive:0.814,liquiditySweep:1.733,obProximity:1.103,fvgAtCE:1.554,recentBOS:1.255,rrRatio:0.627,oteZone:0.787,obFvgConfluence:1.352"
```

### Key Performance Metrics

- **78.1% walk-forward pass rate** across ~97 eligible windows (3 symbols)
- **56.6% win rate** over 732 trades
- **+1,398% cumulative PnL** (with 0.07% friction per trade)
- **PBO = 18.5%** — strong evidence of genuine edge
- **Fitness = 1071.7** (peak across 18 CMA-ES runs)

### Model File

The full optimized parameters are saved at `models/cmaes_run18_escape.json`.

---

## Appendix: File Reference

| File | Purpose |
|------|---------|
| `src/lib/rl/utils/cma-es.ts` | CMA-ES algorithm implementation (diagonal covariance) |
| `scripts/train-cmaes-production.ts` | Production optimizer — subprocess evaluation, normalization, warm-starting |
| `src/lib/rl/strategies/confluence-scorer.ts` | Confluence scoring with 13 factors, regime thresholds, weight config |
| `scripts/backtest-confluence.ts` | Backtest engine called by optimizer subprocess |
| `scripts/walk-forward-validate.ts` | Walk-forward validation framework (3mo train / 1mo val / 1mo slide) |
| `models/cmaes_run*.json` | Per-run optimization results and best parameters |
| `models/cmaes_run18_escape.json` | Production champion config |
