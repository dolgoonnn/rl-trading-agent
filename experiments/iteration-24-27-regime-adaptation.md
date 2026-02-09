# Iterations 24-27: Regime Adaptation

## Running Baseline (from Iter 23)
`--exit-mode simple --partial-tp "0.5,1.0" --atr-extension 2.5` → **59.4% pass rate, +40.87% PnL, 49.7% WR**

## Iter 24: Per-Regime Threshold Overrides
Lower threshold in high-PnL regimes (more trades), raise in losing regimes (fewer, pickier trades).

| Config | Pass Rate | PnL |
|--------|-----------|-----|
| None (baseline) | **59.4%** | +40.87% |
| uptrend+high:3.5 | 59.8% | +102.08% |
| uptrend+normal:5.0 | 58.3% | +63.71% |
| uptrend+high:3.5, uptrend+normal:5.0 | 60.8% | +171.33% |
| uptrend+high:3.0, uptrend+normal:5.0 | 56.7% | +69.83% |
| **uptrend+high:3.5, uptrend+normal:5.0, downtrend+low:5.0** | **61.9%** | **+212.19%** |
| uptrend+high:3.5, uptrend+normal:5.5 | 59.8% | +164.19% |

**Result**: Per-regime thresholds = **+2.5pp pass rate, +171pp PnL**. More trades in edge regime, fewer in losing regimes.
**Decision**: Carry forward `--regime-threshold "uptrend+high:3.5,uptrend+normal:5.0,downtrend+low:5.0"`.

## Iter 25: Per-Regime SL/TP Multipliers
Scale SL/TP by regime volatility.

| Config | Pass Rate | PnL |
|--------|-----------|-----|
| None (Iter 24 best) | **61.9%** | +212.19% |
| uptrend+high:1.3 (wider) | 58.8% | +155.64% |
| ranging+low:0.8 (tighter) | 59.8% | +237.66% |
| downtrend+normal:0.8 | 50.5% | +138.34% |
| uptrend+normal:0.8 | 59.8% | +250.15% |

**Result**: All SL/TP multiplier variants hurt pass rate. The dynamic_rr mode already handles SL sizing correctly.
**Decision**: Keep uniform SL/TP (no regime multipliers).

## Iter 26: Regime Confidence Gate
Suppress signals when regime classification is uncertain (near boundaries).

| Confidence Gate | Pass Rate | PnL |
|-----------------|-----------|-----|
| 0 (disabled) | **61.9%** | +212.19% |
| 0.2 | 59.8% | +122.46% |
| 0.3 | 58.8% | +162.72% |
| 0.4 | 57.7% | +164.80% |

**Result**: Confidence gating actively hurts. Ambiguous-regime bars contain profitable trades that get filtered.
**Decision**: Keep disabled (gate=0).

## Iter 27: Best Regime Adaptation Combo
Only per-regime threshold overrides (Iter 24) improved. No combination needed.

## Phase C Summary
Only per-regime threshold overrides materially improved the system.

### New Running Baseline
```bash
npx tsx scripts/backtest-confluence.ts --strategy ob --sl-mode dynamic_rr \
  --friction 0.0007 --suppress-regime "ranging+normal,ranging+high,downtrend+high" \
  --threshold 4.0 --exit-mode simple --partial-tp "0.5,1.0" --atr-extension 2.5 \
  --regime-threshold "uptrend+high:3.5,uptrend+normal:5.0,downtrend+low:5.0"
```
**61.9% pass rate, +212.19% PnL, 50.4% WR** (768 trades)

---
_Generated: 2026-02-08_
