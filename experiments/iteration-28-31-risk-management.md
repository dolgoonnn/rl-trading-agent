# Iterations 28-31: Risk Management

## Running Baseline (from Iter 27)
`--regime-threshold "uptrend+high:3.5,uptrend+normal:5.0,downtrend+low:5.0"` → **61.9% pass rate, +212.19% PnL, 50.4% WR**

## Iter 28: Volatility-Scaled PnL (Position Sizing Proxy)
Scale trade PnL by inverse ATR percentile.

| Config | Pass Rate | PnL |
|--------|-----------|-----|
| Disabled (baseline) | **61.9%** | +212.19% |
| --vol-sizing | 61.9% | +75.30% |

**Result**: Same pass rate, massively lower PnL. Vol-sizing compresses returns without improving quality.
**Decision**: Keep disabled.

## Iter 29: Window Drawdown Limit
Stop trading in a window after cumulative PnL drops below threshold.

| Max DD | Pass Rate | PnL |
|--------|-----------|-----|
| None (baseline) | **61.9%** | +212.19% |
| -5% | 41.2% | +40.15% |
| -10% | 58.8% | +429.33% |
| -15% | 60.8% | +305.27% |
| -20% | 61.9% | +245.80% |

**Result**: Tight limits destroy pass rate (stops trading in recoverable windows). -20% is neutral.
**Decision**: Keep disabled.

## Iter 30: Streak-Aware Sizing (Anti-Martingale)
After consecutive wins, increase position. After consecutive losses, decrease.

| Streak Config | Pass Rate | PnL |
|---------------|-----------|-----|
| None (baseline) | **61.9%** | +212.19% |
| 2-streak, 1.5×/0.5× | 56.7% | +293.97% |
| 3-streak, 2.0×/0.33× | 51.5% | +139.88% |

**Result**: Streak sizing actively hurts pass rate. Win/loss streaks are not persistent enough at hourly frequency to exploit.
**Decision**: Keep disabled.

## Iter 31: Best Risk Combo
No risk management features improved pass rate. The existing regime suppression + per-regime thresholds already handle risk effectively.

## Phase D Summary
None of the risk management features improved walk-forward pass rate. The system's edge comes from trade selection (confluence + regime), not position management.

### Running Baseline (unchanged from Iter 27)
```bash
npx tsx scripts/backtest-confluence.ts --strategy ob --sl-mode dynamic_rr \
  --friction 0.0007 --suppress-regime "ranging+normal,ranging+high,downtrend+high" \
  --threshold 4.0 --exit-mode simple --partial-tp "0.5,1.0" --atr-extension 2.5 \
  --regime-threshold "uptrend+high:3.5,uptrend+normal:5.0,downtrend+low:5.0"
```
**61.9% pass rate, +212.19% PnL, 50.4% WR** (768 trades)

---
_Generated: 2026-02-08_
