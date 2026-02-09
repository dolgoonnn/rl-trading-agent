# Iteration 11: Expanded Regime Suppression Sweep

## Hypothesis
Suppressing additional losing regimes (downtrend+high at -113% PnL, uptrend+normal at -103% PnL) beyond the baseline (ranging+normal, ranging+high) will improve walk-forward pass rate.

## Config
- Strategy: OB-only
- SL mode: dynamic_rr
- Friction: 0.07% per side (maker)
- Enhanced exits
- Threshold: 4.0

## Results

| Run | Suppressed Regimes | Pass Rate | Trades | Win Rate | PnL |
|-----|-------------------|-----------|--------|----------|-----|
| 1 (baseline) | ranging+normal, ranging+high | 51.0% | 891 | 41.0% | -86.6% |
| 2 | + downtrend+high | **54.6%** | 823 | 41.4% | -28.1% |
| 3 | + uptrend+normal | 44.9% | 829 | 41.3% | -77.5% |
| 4 | all 4 | 50.5% | 762 | 41.9% | +30.5% |

## Key Findings

1. **downtrend+high suppression is the clear winner**: +3.6pp pass rate improvement (51.0% → 54.6%)
2. **uptrend+normal suppression is destructive**: -6.1pp (51.0% → 44.9%), likely removes windows where uptrend+normal trades have positive variance
3. **All 4 combined**: neutral on pass rate (50.5%) but flips PnL positive (+30.5%)
4. Eligible windows stay above 95 for all configs (well above 70 threshold)

## Regime PnL Breakdown (Run 2 - Winner)

| Regime | Trades | Win Rate | Total PnL |
|--------|--------|----------|-----------|
| ranging+low | 223 | 38.6% | +36.4% |
| downtrend+normal | 213 | 44.6% | +43.1% |
| uptrend+normal | 161 | 35.4% | -105.3% |
| uptrend+high | 154 | 50.6% | +83.3% |
| uptrend+low | 38 | 39.5% | +21.5% |
| downtrend+low | 34 | 29.4% | -23.9% |

**uptrend+normal** is still the biggest loser (-105.3%) but suppressing it hurts pass rate. It may contain windows where the losses are concentrated but other windows benefit from its trades.

## Decision

Use **3-regime suppression**: ranging+normal, ranging+high, downtrend+high.
Pass rate: **54.6%** (up from 51.0% baseline, passes 45% gate).

---
_Generated: 2026-02-08_
