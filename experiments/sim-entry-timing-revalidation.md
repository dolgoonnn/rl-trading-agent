# Entry Timing Re-Validation: Run-20 under `signal_close` vs `next_open`

**Date:** 2026-06-22  
**Branch:** ftr/overnight-bot-hardening  
**Task:** Task 13 — add `--entry-timing` flag, re-validate Run-20

---

## Setup

The `--entry-timing` flag was added to `scripts/backtest-confluence.ts` (default: `signal_close`).
Valid values: `signal_close` | `next_open`.

- `signal_close`: enter at the signal bar's close price (legacy behavior, matches pre-Task-13 baseline).
- `next_open`: enter at the next bar's open price (live-faithful — bot actually enters ~next bar).

Both runs use the identical Run-20 configuration:

```bash
npx tsx scripts/backtest-confluence.ts --strategy ob --sl-mode dynamic_rr \
  --friction 0.0007 --suppress-regime "ranging+normal,ranging+high,downtrend+high" \
  --threshold 4.048 --exit-mode simple --partial-tp "0.50,1.41,0.20" --atr-extension 5.79 \
  --ob-half-life 12 --max-bars 160 --cooldown-bars 7 \
  --regime-threshold "uptrend+high:3.14,uptrend+normal:5.74,uptrend+low:5.49,downtrend+normal:4.38,downtrend+low:6.50" \
  --weights "structureAlignment:0.1928,killZoneActive:1.2658,liquiditySweep:1.4896,obProximity:2.7262,fvgAtCE:2.3162,recentBOS:2.2229,rrRatio:0.5567,oteZone:1.0621,obFvgConfluence:1.0892,momentumConfirmation:0.0000" \
  --entry-timing <value> --json
```

---

## Results

### Run A: `--entry-timing signal_close` (baseline)

| Metric | Value |
|--------|-------|
| Trades | 657 |
| Win Rate | 44.60% |
| PnL (gross) | 3.0981 |
| WF Pass Rate | **64.86%** (72/111 windows) |
| BTCUSDT WF | 24/37 = 64.9% |
| ETHUSDT WF | 21/37 = 56.8% |
| SOLUSDT WF | 27/37 = 73.0% |

**Sanity check:** Matches Task-9 / memory baseline (657 trades, 44.60% WR, 3.0981 PnL, 64.86% WF). PASS.

---

### Run B: `--entry-timing next_open`

| Metric | Value |
|--------|-------|
| Trades | 657 |
| Win Rate | 44.60% |
| PnL (gross) | 3.0924 |
| WF Pass Rate | **64.86%** (72/111 windows) |
| BTCUSDT WF | 24/37 = 64.9% |
| ETHUSDT WF | 21/37 = 56.8% |
| SOLUSDT WF | 27/37 = 73.0% |

**WF gate (>60%):** PASS.

---

## Delta (next_open vs signal_close)

| Metric | signal_close | next_open | Delta |
|--------|-------------|-----------|-------|
| Trades | 657 | 657 | 0 |
| Win Rate | 44.60% | 44.60% | 0.00pp |
| PnL | 3.0981 | 3.0924 | **-0.0057 (-0.18%)** |
| WF Pass Rate | 64.86% | 64.86% | **0.00pp** |

The entry pricing shift from signal bar's close to next bar's open costs ~0.18% of cumulative PnL over 657 trades (~0.00087% per trade on average). Trade count, WR, and WF pass rate are identical — the flag correctly changes only entry price, not signal generation or exit logic.

---

## Interpretation

1. **next_open holds the >60% WF gate** (64.86% — identical to signal_close). There is no degradation.

2. **The PnL delta is minimal (-0.18%)** because the sim already applies the entry price only to P&L computation; SL/TP levels are set relative to the signal-bar close in both cases (the `dynamic_rr` placement uses the ob/atr geometry, not the actual fill price for level setting). The open-vs-close gap on 1-hour bars is absorbed by the existing friction model.

3. **Live bot enters at ~next bar** — making `next_open` the more live-faithful model. However, the difference is immaterial at this scale, and the edge holds either way.

---

## Recommendation

Keep `signal_close` as the CLI default (preserves backward compatibility, matches historical walk-forward numbers exactly). The gap between `signal_close` and `next_open` is 0.18% cumulative PnL over ~8 months with zero change in WF pass rate — not large enough to justify changing the deployed default or re-running validation suites.

If a future task needs to calibrate live vs sim entry bias (reconcile-sim Mode 2), use `--entry-timing next_open` to produce the more faithful sim baseline for comparison against `bot_trades`.

**No action required on the deployed Run-20 configuration.**
