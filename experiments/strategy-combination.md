# Strategy Combination — running all validated edges as one book

**Date**: 2026-06-11
**Scripts**: `scripts/extract-strategy-returns.ts` → `scripts/combine-strategies.ts`
**Artifacts**: `experiments/runs/strategy-daily-returns.json`, `experiments/runs/strategy-combination-results.json`

## Question

We have three independent validated/candidate edges. What is the best way to run
them together, and how much does combining add over the best single strategy?

| Sleeve | What it is | Standalone (calendar-day basis) |
|---|---|---|
| `crypto` | 1H OB confluence, CMA-ES Run 20, BTC/ETH/SOL, OOS walk-forward trades only, 1/3 capital per symbol, trade pnl spread over holding days | 555 trades, Sharpe 1.44 (2023-05 → 2026-02) |
| `sessionBook` | 9-leg session book (Au/Ag overnight, Au fix-short, Au AM-fix-long, Ag own-fix-short, Au NFP-mom, US500 overnight, EUR×2) — suitable legs, notional weights | Sharpe 1.6, +317% (2015 → 2026) |
| `f2f` | F2F daily gold, NON-overlapping WF (slide 126), zscore50, long-only, exact per-bar equity | Sharpe 0.34 on all days (the honest calendar-true number; ~2 when invested) |

Note the calendar-day Sharpes are far below the headline per-trade numbers
(crypto "Sharpe 7" → 1.44). This is the correct basis for combination — flat
days count, capital per symbol counts.

## Method (literature-driven; see web-research summary below)

Scaffold applied to all variants, **strictly walk-forward** (every estimate
from trailing data only; weights frozen for one month):

1. Calendar-align daily **log** returns, 0 when flat.
2. Vol-normalize each sleeve to 10% ann using trailing blended vol
   (EWMA λ=0.97 + 252d simple, 70/30), per-sleeve leverage cap 4×.
3. Weight methods: `ew` (1/N), `handcraft` (Carver: bucketed correlations
   {0,0.5,0.9} + damped SR tilt ±15%), `erc` (equal risk contribution,
   trailing 2y covariance), `mvshrunk` (tangency with 75% mean-shrink,
   50% cov-shrink, bounds [0.1,0.6] — falsification arm).
4. Carver diversification multiplier DM = 1/√(wᵀHw), ρ floored at 0, cap 2.5.
5. Optional portfolio vol-target overlay: 12% ann, 20d EWMA, leverage cap 3×.
6. 252d warmup excluded from evaluation. Stationary-block bootstrap (2000
   iters) on Sharpe differences vs EW.

## Results

### Universe A — all three sleeves (2023-05-29 → 2026-01-08, eval ≈ 1.9yr)

Pairwise correlations: crypto×book −0.022, crypto×f2f −0.020, book×f2f 0.017.
**The sleeves are uncorrelated — combination is nearly free diversification.**

Vol-normalized single-sleeve benchmarks: crypto Sharpe 1.88, book 2.16, f2f 1.15.

| method | raw annRet% | raw Sharpe | raw maxDD% | vt annRet% | vt Sharpe | vt maxDD% | avgDM |
|---|---|---|---|---|---|---|---|
| **ew** | 32.1 | **2.94** | 7.1 | 41.2 | 2.86 | 10.0 | 1.72 |
| handcraft | 31.3 | **2.94** | 8.2 | 40.4 | **2.89** | 10.8 | 1.70 |
| erc | 32.5 | 2.89 | 7.1 | **42.4** | 2.72 | 10.2 | 1.71 |
| mvshrunk | 32.4 | 2.90 | 8.2 | 42.1 | 2.76 | 10.8 | 1.70 |

Bootstrap vs EW: nothing beats it (handcraft P=52%, erc P=27%, mvshrunk P=38%)
— exactly the DeMiguel 1/N prediction on a short window.

**Combination lifts Sharpe 2.16 → 2.94 (+36%) over the best single sleeve at
lower drawdown.** That is the headline: the gain comes from the DM (~1.72,
near the √3 theoretical max for 3 uncorrelated sleeves), not from clever
weights.

### Universe B — sessionBook + f2f, long history (2015 → 2026, eval ≈ 10.7yr)

Correlation −0.004. Benchmarks: book 1.74, f2f 0.60.

| method | raw annRet% | raw Sharpe | raw maxDD% | vt annRet% | vt Sharpe | vt maxDD% |
|---|---|---|---|---|---|---|
| ew | 16.9 | 1.67 | 11.0 | 28.2 | 1.74 | 18.8 |
| **handcraft** | 17.6 | **1.75** | 11.9 | 26.5 | **1.80** | 18.0 |
| erc | 16.5 | 1.60 | 11.2 | 29.0 | 1.65 | 19.7 |
| mvshrunk | 16.7 | 1.63 | 11.3 | 27.7 | 1.65 | 18.8 |

Bootstrap vs EW: **handcraft wins with P=99.1%, 5th-pct Δ=+0.03** — the only
statistically significant method difference in the whole study. The damped SR
tilt (avg 0.565/0.435 toward the session book) is enough signal on 10+ years;
ERC and shrunk-MV lose to EW even here (P=1.5% / 10.5%).

## Verdict — the combination to run

**Carver handcraft weights + diversification multiplier + 12% vol target**:
- Universe A: **40.4%/yr, Sharpe 2.89, 10.8% maxDD** (EW is statistically
  indistinguishable and simpler; either is defensible).
- The only method that also wins on long history (P=99.1%).
- Practical weights ≈ crypto 0.37 / book 0.32 / f2f 0.31 of vol-normalized
  sleeves, DM ≈ 1.7, then scale book to 12% ann vol.

Fractional Kelly enters as the vol-target level, not the weights: believed
combined SR after a 50% backtest haircut ≈ 1.4 → half-Kelly vol ≈ 70%/yr,
so the binding constraint is drawdown tolerance, not Kelly. 12% ann is
conservative; returns scale ~linearly up to ~20% if 18% maxDD is acceptable.

## Caveats (honest list)

1. **Universe A eval is only ~1.9yr** (crypto OOS starts 2023-05, F2F series
   ends 2026-01). The +36% Sharpe uplift rests on correlations staying ≈ 0.
2. The crypto sleeve inherits Run 20's known parameter fragility (MC
   perturbation FAIL); the combined book's crypto third is only as real as
   Run 20.
3. sessionBook assembly was full-sample (legs validated individually with
   halves-stability, but the book composition itself was chosen in-sample).
4. f2f and sessionBook share gold as underlying. Daily correlation 0.017, but
   tail/regime correlation (gold crash) is untested — handcraft's grouping is
   the mitigation.
5. Strategy-equity-curve momentum / switching deliberately NOT tested:
   Allocate Smartly's 100-strategy study found every switching overlay
   underperformed always-on. HRP skipped: degenerate at N=3.

## Web-research summary (sources in agent report, 2026-06-11)

- DeMiguel/Garlappi/Uppal 2009: 14 optimizers, none beat 1/N OOS → confirmed here on Universe A.
- Carver handcrafting (qoppac): vol-normalize → bucketed correlations → damped SR tilt → DM, cap 2.5 → confirmed best here on Universe B.
- Maillard/Roncalli ERC: between min-var and EW; ≈ inverse-vol at equal correlations → confirmed, no edge at N=3 ρ≈0.
- Rising/Wyner: fractional Kelly = full Kelly with shrunk means → used for vol-target level only.
- Cederburg et al. 2020: vol targeting does not reliably raise Sharpe (confirmed: raw 2.94 vs vt 2.86) but stabilizes realized risk — use as risk control, which is what the 12% overlay is.

## Stress validation of the combination layer (2026-06-11, `scripts/validate-combination.ts`)

| Gate | Universe A (futures-tier) | Universe C (retail-friction) | Universe B (11yr, 2 sleeves) |
|---|---|---|---|
| Bootstrap Sharpe/PnL 5th pct | 1.91 / +68% PASS | 1.41 / +47% PASS | 1.30 / +406% PASS |
| Skip 20/30% active days | 100/100% PASS | 100/100% PASS | 100/100% PASS |
| Correlation stress (Sharpe @ ρ=0.5) | 2.07 PASS | 1.78 PASS | 1.36 FAIL* |
| Tail coincidence (ratio < 2) | 0.69d/1.78w PASS | 1.64d/0.00w PASS | **5.02d**/2.49w FAIL |
| DSR (4 trials) | 2.53 PASS | 2.22 PASS | 1.62 PASS |
| **Verdict** | **5/5** | **5/5** | 3/5 |

\* B's gate is informative-only: a 2-sleeve book with avg sleeve Sharpe ~1.2 cannot
reach 1.5 at ρ=0.5; it still holds 1.27 at ρ=0.7.

**The B tail finding matters**: sessionBook × f2f worst-5% days co-occur **5× more
than independence** on 11 years (both trade gold — COVID/2022 style events).
Mitigation tested on Universe A: gold-cluster weights (crypto 0.50 / book 0.25 /
f2f 0.25) cost nothing (Sharpe 2.94 vs 2.95 flat) while halving joint gold-tail
exposure. **Deployment weights should use the cluster structure**, ≈ crypto 0.50 /
book 0.30 / f2f 0.20 with the damped within-cluster tilt.

Worst-case expectations (sets paper-trading thresholds): worst rolling 6mo ≈ flat
(A: +1.5%, C: −0.3%), worst rolling 12mo ≈ +6.5–10%. A flat half-year is normal,
not a broken book.

## Universe C — the deployable book at REALISTIC venue costs

`scripts/audit-leg-friction.ts` re-priced every session-book leg at the costs
from the execution research (`experiments/execution-audit.md`): MGC gold
0.45–0.55bp/side, SIL silver 1–2bp, MES 0.5bp, EURUSD 0.35bp London / 0.9bp
at the 22h rollover. Result: 7/9 legs survive (EUR-h22 dead at −4.0 Sharpe,
Au-AM-fix marginal at 0.07 — both cut). Deployable book standalone Sharpe 1.27.
Combined with crypto + F2F:

**handcraft + DM + 12% vol target → 37.2%/yr, Sharpe 2.53, 11.7% maxDD, 5/5
stress gates (DSR 2.16).** This is the number to deploy against, not the
40.4%/2.89.

**Re-anchor update (2026-06-11, post `remeasure-anchor.ts`)**: the overnight
legs were re-anchored from the untradeable 22:01 UTC to 18:05 ET DST-aware
(CME reopen +5m). Gold overnight Sharpe 1.09→0.85 at validated friction,
silver 0.81→0.59 — edge survives, shrunk. At venue-realistic costs silver
overnight drops to 0.27 (MARGINAL, below the 0.3 gate) and leaves the
deployable set (kept in the paper bot for live evidence). Refreshed deployable
book (6 legs): standalone Sharpe 1.34; combined **handcraft + DM + 12% vol
target → 36.7%/yr, Sharpe 2.46, 9.9% maxDD — still 5/5 stress gates**
(bootstrap Sharpe 5th pct 1.53, ρ=0.5 stress 1.75). The anchor fix cost the
book almost nothing.

## Reproduction

```bash
npx tsx scripts/extract-strategy-returns.ts   # ~6 min (crypto WF is the slow part)
npx tsx scripts/combine-strategies.ts         # seconds
```
