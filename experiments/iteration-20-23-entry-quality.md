# Iterations 20-23: Entry Quality

## Running Baseline (from Iter 19)
`--exit-mode simple --partial-tp "0.5,1.0"` → **57.7% pass rate, +60.84% PnL, 50.2% WR**

## Iter 20: Continuous OB Freshness (Exponential Decay)
Replace 3-tier OB age scoring with `score = exp(-age / halfLife)`.

| Half-Life | Pass Rate |
|-----------|-----------|
| 0 (3-tier) | **57.7%** |
| 10 | 53.1% |
| 15 | 52.1% |
| 20 | 52.1% |
| 25 | 50.5% |

**Result**: 3-tier scoring wins. Exponential decay hurts because the discrete tiers match real OB behavior.
**Decision**: Keep 3-tier (default).

## Iter 21: ATR Extension Filter
Skip signals where price is > N ATR bands from SMA(20).

| ATR Bands | Pass Rate | PnL | Trades |
|-----------|-----------|-----|--------|
| None | 57.7% | +60.84% | 807 |
| 1.5 | 52.1% | — | — |
| 2.0 | 58.3% | — | — |
| **2.5** | **59.4%** | +40.87% | 772 |
| 3.0 | 59.4% | — | — |

**Result**: 2.5 ATR bands = **+1.7pp pass rate**. Filters out 35 overextended entries.
**Decision**: Carry forward `--atr-extension 2.5`.

## Iter 22: Volume-Weighted OB Quality
Score OBs by formation volume relative to 20-bar average.

| Weight | Pass Rate |
|--------|-----------|
| 0 (disabled) | **59.4%** |
| 0.5 | 52.0% |
| 1.0 | 54.1% |
| 1.5 | 46.5% |

**Result**: Volume quality actively hurts. Crypto hourly volume is too noisy for institutional OB detection.
**Decision**: Keep disabled (weight=0).

## Iter 23: OB Displacement Sweep
Sweep OB `minMovePercent` threshold with all other improvements.

| MinMove% | Pass Rate |
|----------|-----------|
| 1.0 | 56.1% |
| **1.2** | **59.4%** |
| 1.5 | 52.6% |
| 1.8 | 45.6% |
| 2.0 | 43.7% |

**Result**: Current 1.2% is optimal. Higher kills too many valid OBs.
**Decision**: Keep 1.2% (default).

## Phase B Summary
Only ATR extension filter improved on exit management gains.

### New Running Baseline
```bash
npx tsx scripts/backtest-confluence.ts --strategy ob --sl-mode dynamic_rr \
  --friction 0.0007 --suppress-regime "ranging+normal,ranging+high,downtrend+high" \
  --threshold 4.0 --exit-mode simple --partial-tp "0.5,1.0" --atr-extension 2.5
```
**59.4% pass rate, +40.87% PnL, 49.7% WR** (772 trades)

---
_Generated: 2026-02-08_
