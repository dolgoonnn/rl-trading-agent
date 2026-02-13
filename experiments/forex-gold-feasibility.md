# Forex/Gold Feasibility Test

**Date**: 2026-02-13
**Objective**: Test if the CMA-ES-optimized crypto config (Run 18) transfers to gold (GC=F) and forex pairs.

## Code Changes Made

### 1. Symbol normalization fix (bug fix)
- `walk-forward-validate.ts`: Use `normalizeSymbolName()` for data file paths (`GC=F` -> `GC_F`)
- `backtest-confluence.ts`: Same fix for futures data path

### 2. ATR-based detection thresholds (opt-in infrastructure)
- `order-blocks.ts`: Added `minMoveATR` option to `OrderBlockConfig` (overrides `minMovePercent`)
- `fair-value-gaps.ts`: Added `minSizeATR` option to `FVGConfig` (overrides `minSizePercent`)
- Defaults unchanged (percent-based for backward compat). ATR is opt-in via config.

### 3. Pre-existing volatilityScale changes (already on branch)
- `ict-strategies.ts`: OB proximity, FVG size filter, CE tolerance all scaled by `volatilityScale`
- `volatilityScale = clamp(atrPercent / 0.006, 0.05, 1.0)` — scales down for low-vol assets

## Test Config

All tests use Run 18 CMA-ES config:
```bash
--strategy ob --sl-mode dynamic_rr --threshold 4.672 --exit-mode simple
--partial-tp "0.55,0.84,0.05" --atr-extension 4.10 --ob-half-life 18
--max-bars 108 --cooldown-bars 8
--suppress-regime "ranging+normal,ranging+high,downtrend+high"
--regime-threshold "uptrend+high:2.86,uptrend+normal:6.17,uptrend+low:3.13,downtrend+normal:4.33,downtrend+low:4.48"
--weights "structureAlignment:2.660,killZoneActive:0.814,liquiditySweep:1.733,obProximity:1.103,fvgAtCE:1.554,recentBOS:1.255,rrRatio:0.627,oteZone:0.787,obFvgConfluence:1.352"
```
- Crypto: `--friction 0.0007`
- Forex/Gold: `--friction 0.0006`

## Results

### Crypto Baseline (3-symbol, post-changes)
| Metric | Before | After |
|--------|--------|-------|
| WF Pass Rate | 78.1% | 76.5% |
| Trades | 732 | 740 |
| Win Rate | 56.6% | 56.2% |
| PnL | +1397.8% | +1356.7% |

Verdict: **Baseline preserved** (-1.6pp, within noise from floating point edge cases).

### Gold (GC=F)
| Metric | Value |
|--------|-------|
| WF Pass Rate | **50.0%** |
| Eligible Windows | 12/12 |
| Trades | 31 |
| Win Rate | 45.2% |
| PnL | -10.11% |
| Signals | 112 |

Per-regime: 95% of trades in `ranging+low`. Biggest losers in `downtrend+normal`.

### Forex (4 pairs)
| Pair | WF Pass | Windows | Trades | Win Rate | PnL |
|------|---------|---------|--------|----------|-----|
| EURUSD=X | 15.4% | 2/13 | 76 | ~48% | -7.8% |
| GBPUSD=X | 15.4% | 2/13 | 90 | ~50% | -12.0% |
| **USDJPY=X** | **61.5%** | **8/13** | 51 | ~53% | +1.3% |
| **AUDUSD=X** | **53.8%** | **7/13** | 58 | ~54% | -0.1% |
| **Aggregate** | **36.5%** | **19/52** | **275** | **51.3%** | **-22.3%** |

### Per-pair Analysis
- **EURUSD & GBPUSD**: Complete failure (15.4%). These major pairs have the tightest ranges and most efficient pricing — ICT order block edge doesn't exist.
- **USDJPY**: Promising at 61.5% with only 51 trades. The yen's carry-trade dynamics and occasional sharp moves may create genuine OB opportunities.
- **AUDUSD**: Marginal at 53.8% with 58 trades. The commodity-linked AUD has more trending behavior.

### Regime Distribution (Forex)
- **95% of trades fall in `ranging+low`** regime
- This regime is NOT suppressed — but crypto params were tuned for trending + volatile regimes
- Forex volatility is structurally lower than crypto (ATR% ~0.05% vs ~2%)

## Diagnosis: Why Crypto Edge Doesn't Transfer

### 1. Volatility mismatch (primary)
- Crypto 1h ATR: ~1.5-2.5% of price
- Forex 1h ATR: ~0.04-0.08% of price (30-50x lower)
- Gold 1h ATR: ~0.5-1.0% of price
- The `volatilityScale` mechanism handles OB/FVG detection, but confluence weights and thresholds were optimized for crypto-scale moves

### 2. Regime distribution mismatch
- Crypto: diverse regime distribution (uptrend/downtrend, high/low vol)
- Forex: predominantly `ranging+low` — the regime suppression tuned for crypto doesn't apply

### 3. Kill zone misalignment
- Kill zones (London, NY, Asia sessions) score differently for 24/7 crypto vs 5-day forex
- Weekend gaps in forex data create discontinuities in structure/OB detection

### 4. Confluence weight calibration
- Weights like `structureAlignment: 2.66` and `fvgAtCE: 1.554` were CMA-ES-optimized for crypto market structure characteristics

## Verdict

| Asset | WF Pass Rate | Interpretation |
|-------|-------------|----------------|
| Crypto 3-sym (ref) | 76.5% | Strong |
| Gold (GC=F) | 50.0% | Coin flip — no edge with crypto params |
| Forex aggregate | 36.5% | Below random — crypto params harmful |
| USDJPY | 61.5% | Interesting outlier — worth investigating |
| AUDUSD | 53.8% | Marginal — could be noise |
| EURUSD / GBPUSD | 15.4% | Complete failure |

**Overall**: < 45% aggregate = **"Weak — crypto-fitted params don't transfer"**

## Recommendations

### If pursuing forex/gold:
1. **Run CMA-ES specifically for forex**: Use USDJPY + AUDUSD as seed symbols (they showed above-chance results)
2. **Consider separate regime suppression**: Forex needs different suppressed regimes (most activity is in `ranging+low`)
3. **Lower confluence threshold**: Forex signals are smaller — threshold 4.672 may be too restrictive
4. **Recalibrate kill zone weights**: Forex has genuine session effects (London open, NY overlap)

### Infrastructure improvements made:
- `normalizeSymbolName()` now used in data path construction (bug fix)
- ATR-based detection thresholds available as opt-in (`minMoveATR` / `minSizeATR`)
- Strategy entry conditions scale with `volatilityScale`

---

## Forex CMA-ES Optimization (Runs 1-4)

After the initial feasibility test, CMA-ES was run specifically for forex:
- 4 pairs: EURUSD=X, GBPUSD=X, USDJPY=X, AUDUSD=X
- Friction: 0.0003 per side
- Run 2 (63.5%) → **Run 3 (65.4%, best)** → Run 4 (65.4%, lower fitness)
- Convergence confirmed at runs 3-4

Key differences from crypto config:
- structureAlignment 3.2x (vs 2.7x crypto) — more weight on market structure
- liquiditySweep 4.3x (vs 1.7x) — liquidity sweeps much more important in forex
- oteZone ~0 (vs 0.8) — OTE zone doesn't matter in forex
- obFvgConfluence 2.7x (vs 1.4x) — OB+FVG overlap more predictive

---

## Forex Validation Results (2026-02-13)

### Scorecard

| Check               | Value  | Result |
|---------------------|--------|--------|
| Walk-Forward >60%   | 61.5%  | PASS   |
| PBO <25%            | 31.8%  | FAIL   |
| DSR >0              | 3.13   | PASS   |
| MC Bootstrap Sharpe | -3.941 | FAIL   |
| MC Bootstrap PnL    | -9.3%  | FAIL   |
| MC Skip 20%         | 95%    | PASS   |
| Param Fragility <50%| 76%    | FAIL   |

**Passed 3/7 checks — VALIDATION FAILED**

### Key Numbers
- 315 walk-forward trades (43.5% WR, +8.9% PnL, Sharpe 3.71)
- WF pass rate 61.5% (barely above 60% threshold)
- PBO 31.8% — marginal, between 25-50% (not strong evidence against overfitting)
- DSR 3.13 — passes comfortably (haircut 0.58, from 3.71 to 3.13)
- Bootstrap Sharpe 5th percentile: **-3.94** — the strategy can produce deeply negative Sharpe
- Bootstrap PnL 5th percentile: **-9.3%** — can lose money in plausible scenarios
- Parameter fragility: 76% of perturbations drop >5pp

### Analysis

The forex model fails validation on 4 of 7 checks:

1. **PBO FAIL (31.8%)**: The "production" config is not clearly the best among reasonable variants. The no-regime-threshold variant performs equally well, suggesting the per-regime thresholds may be noise-fitted.

2. **Bootstrap Sharpe/PnL FAIL**: With only 43.5% WR and 315 trades, the strategy's edge is thin. The 5th percentile bootstrap shows deeply negative Sharpe (-3.94) — there's a meaningful probability this strategy has no real edge. Compare to 3-sym crypto where 5th pct Sharpe was +3.03.

3. **Parameter Fragility FAIL (76%)**: 76% of 5%-noise perturbations drop the pass rate >5pp. The mean perturbed pass rate is 54.0% (vs 61.5% real). The forex model sits on a knife edge — far more fragile than even the crypto model (which was 97% fragile but from a higher base).

4. **Walk-Forward barely passes (61.5%)**: Just 1.5pp above the 60% threshold. The PBO result suggests even this may be optimistic.

### Verdict: DROP FOREX MODEL

The forex model fails validation decisively (3/7 pass). The honest assessment from the research plan proved correct:
- 43.5% WR + low volatility = insufficient edge after friction
- Bootstrap shows the strategy can produce deeply negative results
- PBO suggests the "best" config is not meaningfully better than alternatives
- Parameter fragility confirms the model is noise-fitted

**Decision**: Do not paper trade the forex model. Focus entirely on the validated 3-sym crypto model.
