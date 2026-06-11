# Metals Overnight Session Hold — OOS-Confirmed Seasonal (Gold + Silver + Fix Overlay)

**FINAL STACK — DEPLOYABLE NUMBERS (futures tier, 1-min-delayed entries, 2015–2026):**
50% gold (22→07+wknd, 0.3bp) + 50% silver (same, 1bp) + gold fix-short (0.3bp) =
**+164.1% (~14.4%/yr), Sharpe 1.13, MaxDD 21%, corr(Au,Ag)=0.76.**
Battery: bootstrap Sharpe 5th 0.65 PASS · PnL 5th +95.4% PASS · skip-20% 100% PASS ·
DSR 0.54 PASS (20 trials, fat tails accounted).

**EXECUTION-ARTIFACT CORRECTION (`research-session-jitter.ts`)**: ~35–40% of the raw
backtest P&L sat in the FIRST 1-minute bar at the 22:00 reopen — a depressed/wide-spread
bid print that is not a real fill. Delays of 1–60 min form a flat plateau (the seasonal
is robust; the reopen print was not). All deployable numbers use delayMin=1
(`extractTrades(..., delayMin)`); the raw delay-0 figures below are kept for history
but must NOT be used for sizing. Raw stack was +237% / Sharpe 1.62.

Zero optimized parameters; every component OOS-confirmed (gold: era holdout; silver:
instrument+era transfer; fix-short: literature replication, regime-stable).

---

**Date**: 2026-06-10
**Status**: HOLDOUT-CONFIRMED — strongest new finding since F2F. Pending full battery + venue decision.
**Scripts**: `scripts/backtest-gold-session.ts`, research basis `experiments/gold-1m-research.md`
**Raw results**: `experiments/runs/gold-session-results*.json`

## Rule (parameter-free)

Long XAUUSD at the open of the first 1m bar ≥22:00 UTC; exit at the open of the first
bar ≥07:00 UTC. No indicators, no thresholds, no optimizer. One trade/day (Sun–Thu nights;
gold closes Friday ~21:00 before the entry time).

Origin: hour-of-day decomposition on 2020–2026 (`gold-1m-research.md`) — 22–07 UTC carried
~all intraday return while the US session was a net drag. Window selected on that data,
then tested UNCHANGED on a 2015–2019 holdout downloaded afterwards. Matches the documented
overnight-gold-drift anomaly (literature prior).

## Results

### Selection period 2020-01 → 2026-06 (1,661 trades)

| Friction/side | Total | Sharpe | MaxDD | WR | Years + | 3mo pass | Boot Sharpe 5th |
|---|---|---|---|---|---|---|---|
| 0 | +102.3% | 1.72 | 11.1% | 56.0% | 7/7 | 76.9% | +1.05 |
| 0.5 bp | +85.6% | 1.44 | 11.1% | 54.9% | 6/7 | 76.9% | +0.80 |
| 1 bp | +69.0% | 1.16 | 11.1% | 53.8% | 73.1% | 6/7 | +0.52 |
| 2 bp | +35.8% | 0.60 | 13.1% | 51.9% | 6/7 | 69.2% | −0.02 |

Benchmark B&H: +102.3%, Sharpe 0.78, MaxDD 26.7%. Same total return at zero friction with
**2.2× Sharpe, 0.4× drawdown, 37% market exposure**. 2026 YTD: +9.6% vs B&H −2.3%.

### HOLDOUT 2015-01 → 2019-12 (1,288 trades — selection never saw this data)

| Friction/side | Total | Sharpe | MaxDD | Years + | Boot Sharpe 5th |
|---|---|---|---|---|---|
| 0 | +63.4% | 2.07 | 7.2% | 5/5 | +1.43 |
| 0.5 bp | +50.5% | 1.65 | 7.9% | 4/5 | +0.98 |
| 1 bp | +37.6% | 1.23 | 8.7% | 3/5 | +0.54 |
| 2 bp | +11.9% | 0.39 | 19.4% | 3/5 | −0.37 |

Benchmark B&H 2015–19: +24.6%, Sharpe 0.36, MaxDD 21.2%. **2015 (gold −11.2%): strategy +12.8% net of 1bp.**

### Combined: 12/12 years positive at zero friction, 2,949 trades over 11.4 years.

## Iteration 2 (loop, same day): weekend-gap leg + robustness battery

**`wknd-gap` variant** (adds Friday 20:00 → Monday 07:00 hold; same trade count, weekend
absorbed into the Friday entry):

| Period | Friction | Total | Sharpe | Years + | 3mo pass | Skip-20% |
|---|---|---|---|---|---|---|
| 2020–26 | 0.5 bp | **+99.3%** (base +85.6%) | **1.58** | **7/7** (flips 2022 +) | 84.6% | 100% |
| 2015–19 holdout | 0.5 bp | +50.6% (≈ base) | 1.59 | 4/5 | 65% | 100% |

**Hour-grid robustness** (entries 21/22/23 × exits 06/07/08, 0.5 bp): all 18 cells positive
across both periods, Sharpe 0.65–1.94. Flat basin — the 22→07 selection is not a lucky cell.
**Skip-20%**: 95.8–100% profitable everywhere. **Verdict: adopt `wknd-gap` as the headline
variant.** Combined 2015–2026 ≈ +150% net of 0.5bp, 11/12 years positive, MaxDD 7–13%.

## Iteration 3 (loop): DSR + F2F portfolio analysis

**DSR (honest 15-trial count, fat-tail-adjusted: skew −1.84, kurt 53.5):**
Sharpe 1.55 → haircut 0.26 → **DSR = 1.29, significant** (`analyze-session-portfolio.ts`).

**Correlation with F2F daily returns: −0.025** — effectively zero, despite both being
long-gold. Different return sources (overnight drift vs multi-day trend capture) →
genuine diversification: 50/50 blend Sharpe 1.57 > session 1.42 > F2F-replay 0.65
on the 2015–2026 window, blend MaxDD 6.0% vs session 13.4%.

*Caveat*: the F2F leg here is a fixed-param replay (λ=0.95/θ=0.91, train stats frozen
2005–14, 163 trades) — much weaker than F2F's own walk-forward (Sharpe 2.08, which
retrains stats each window). The correlation finding stands; the blend weights need a
re-run against F2F's true WF equity curve before being quoted.

Results JSON: `experiments/runs/gold-session-portfolio.json`.

## Iteration 4 (loop): calendar-honest F2F comparison — GOAL RESOLVED

F2F's true walk-forward was re-run (sanity: reproduces passRate 51.1%, 1,097 OOS trades,
aggregate Sharpe 2.08 exactly). **Critical discovery**: F2F's val windows overlap 6×
(126-bar val, 21-bar slide), so its headline "+197% PnL / Sharpe 2.08" counts most
calendar days ~6 times. De-overlapped (32/188 windows, each OOS day counted once),
F2F's **calendar-true** record 2013–2026 is **+16.3% total, Sharpe 0.46, MaxDD 5.6%**.

Calendar-equivalent comparison (`analyze-session-portfolio.ts --f2f-wf`, 3,366 days):

| Leg | Total | Sharpe | MaxDD |
|---|---|---|---|
| **Session-hold (wknd-gap, 0.5bp)** | **+149.8%** | **1.45** | 13.4% |
| F2F (de-overlapped WF) | +16.3% | 0.46 | 5.6% |
| 50/50 blend | +83.1% | 1.42 | 6.7% |

Correlation 0.252. Blending no longer beats the session leg on Sharpe — it's a drawdown
reducer only. **On identical accounting, the session-hold's P&L is ~9× F2F's.**

Caveats on the F2F leg: daily distribution is weight×Δlog(close) (approximation of their
compounding); non-overlapping window subset is one of 6 possible offsets and F2F's 51%
pass rate means subset variance is real. Neither caveat is close to a 9× gap.
**Follow-up required**: re-examine F2F's validated metrics for overlap inflation before
trusting its deployment sizing (`scripts/validate-f2f.ts`).

## Iteration 5 (trader loop): pre-PM-fix short overlay — ADOPT at futures tier

`research-gold-fix-overlay.ts` (0.3bp/side, 2015–2026): leg B = short 14:00→15:00 London
daily (the replicated fix drift). B alone: +29.2% (~2.5%/yr), Sharpe 0.48, 10/12 years.
**A+B combo: +190.8% vs A's +161.6% — same Sharpe (1.67), same MaxDD (13.4%), corr −0.002.**
Pure return addition at zero risk-adjusted cost; futures-tier only. Combo worst year −1.4% (2022).

## Iteration 6 (trader loop): SILVER REPLICATION — mechanism generalizes

XAGUSD 1m (2020–2026, 2.27M candles, `gold-session-results-XAGUSD_1m.json`), the
unchanged gold rule (window selected on gold only — silver never voted):

| wknd-gap | 0.5bp | 1bp | 2bp |
|---|---|---|---|
| Total | +167.7% | **+151.1%** | +117.8% |
| Sharpe | 1.27 | 1.15 | 0.90 |
| Years + | 7/7 | 7/7 | 7/7 |
| 3mo pass | 88.5% | 88.5% | 80.8% |

Per-year at 1bp all positive incl. **2022 +8.7%** (gold's down year). Hour grid 9/9
cells positive. MaxDD ~26% (silver vol). 2015–19 silver holdout downloading.
**Metals overnight portfolio = gold + silver + fix-short overlay.**

## What does NOT work

- **Daily EMA trend gate (λ=0.95)**: hurts in BOTH periods (filters profitable nights;
  holdout Sharpe 1.12 vs 2.07 unfiltered). The drift does not want trend conditioning.
- **Weekend-hold variant**: a no-op as implemented — gold closes Friday ~21:00 before the
  22:00 entry, so no position spans a weekend. The weekend-gap return (~40% of gold's
  total return sits in weekend/holiday gaps per `gold-1m-research.md`) is UNTESTED —
  needs an "enter Friday before close" variant. Open follow-up.

## Execution economics (the deciding factor)

Round trip cost = 2 × per-side friction, one trade/day:

| Venue | Per-side | Verdict |
|---|---|---|
| GC/MGC futures | ~0.2–0.4 bp (tick + commission) | Works (~Sharpe 1.3–1.7 expected) |
| Spot via tight ECN | ~0.5–1 bp | Marginal-to-OK |
| Retail CFD | ~1–2 bp | Dies |
| Crypto rails (XAUT/PAXG) | >3 bp | Dead |

## Caveats / open items

1. 2018–2019 weakened to ~flat net of 1bp (per-year at 1bp: 2018 −2.6%, 2019 −1.3%) before
   strengthening sharply 2020+. The effect breathes; sizing must assume flat stretches.
2. Long-only expression of a structural drift — correlated with F2F's exposure. Portfolio
   role is overlay/complement, not diversifier.
3. Full battery still pending: DSR (trial count: ~5 — 4 variants + window choice, mostly
   pre-registered), skip-20%, and a weekend-gap variant test.
4. Dukascopy bid-price data; live fills at 22:00 UTC reopen can see wider spreads —
   the 0.5–1bp column is the realistic planning row, not the 0bp row.

## Iteration 8 (combo loop): MULTI-LEG BOOK — Sharpe 1.24

`analyze-combo-portfolio.ts` (`runs/combo-book.json`). Six candidate legs, pre-registered
suitability (same sign both halves) + marginal-contribution test per the strategy-
diversification literature:

- **Book = Au-overnight + Ag-overnight + fix-short + AM-fix-bounce(NEW) + NFP-mom(NEW)**
- **Sharpe 1.24** (vs 1.13 metals stack), +196% total incl. dropped leg / per-year 10/12 positive
- D (AM-fix bounce 10:30→11:30 London long): standalone Sharpe 0.35 but ΔSharpe +0.07 —
  negative correlation with overnight core makes a thin leg valuable
- E (NY-open short 13:00→14:00 UTC): REJECTED by marginal test — corr 0.60 with fix-short
  (same hour under summer DST). Redundancy detection working as intended.
- 10/15 leg-pair correlations < |0.03|

## Iteration 9 (combo loop): SILVER'S OWN FIX + final book — Sharpe 1.53

New leg I: **silver pre-fix short 11:00→12:00 London (silver's own LBMA fix at noon)**:
+57.7% standalone, stable halves (42.1/15.6), ΔSharpe +0.29 — best non-core leg.
Mechanism confirmation: gold's fix windows applied to silver (G/H) FAILED suitability —
the effect is fix-specific, not time-of-day-generic. D×I corr −0.41 (natural hedge).

**FINAL BOOK (A+B+C+D+I+F, futures tier): +241.6%, Sharpe 1.53, MaxDD 19.8%.**
Without silver-overnight (B, marginal −0.11 due to 0.76 corr with A): Sharpe 1.63.
Inverse-vol weighting (prior leg set): Sharpe ~1.48 at MaxDD 11.6% — sizing matters.

Caveats: leg I = 1-of-3 trials this iteration (strong mechanism prior, halves-stable);
the BOOK assembly (selection+weights) is full-sample-fitted — freeze and judge forward.

## Iteration 10 (combo loop): platinum DATA-BLOCKED; bot upgraded to full book

Platinum (`xptcmdusd`) 1m exists on Dukascopy only from ~2022-2024 — too short for
halves-stability or holdout testing. Mechanism prediction recorded, not tested:
pre-fix shorts at platinum's own fixes (09:45/14:00 London) should show the effect
if the fix-flow mechanism is universal. Revisit with better data.

Paper bot (`run-metals-bot.ts`) now trades the full book: overnight Au+Ag + weekend
+ Au fix-short + Au AM-fix bounce + Ag own-fix short (NFP leg omitted: 12 ev/yr, Δ0.03).

## Iteration 11 (combo loop): US500 overnight tested — REJECTED by marginal; BOOK FROZEN

US500 close→open replicates the literature (overnight = ~2/3 of total return, halves
21.1/25.5) but Sharpe 0.37 / MaxDD 37.8% (2022: −18.8%) → book marginal Δ=−0.03 at
half weight. Rejected, like leg E. Platinum data-blocked. **Three asset classes tested;
the marginal framework now rejects all new candidates → book saturated.**

**FROZEN BOOK: A+B+C+D+I+F = Sharpe 1.53, +241.6%, MaxDD 19.8% (futures tier).**
Next information source: forward paper data (bot started 2026-06-11).

## Iteration 12 (loop): book risk-certification + bot babysitting begins

- **Book DSR = 0.90** at 40-trial honest count (haircut 0.60, skew −1.21, kurt 23.6) — significant.
- **Inverse-vol weighting: Sharpe 1.60, MaxDD 14.8%** — preferred deployment sizing.
- Paper bot live (nohup, 2026-06-11 02:08 UTC); log monitor armed; first fills expected
  at 10:30 London (AM-fix leg). Forward fills are now the only admissible new evidence.

## Iteration 13 (loop): BREEDON-RANALDO FX LEGS — book Sharpe 1.60, DSR 1.05

EURUSD 1m 2015–2026 (4.26M candles) confirms the JMCB-2013 home-hours effect fully
time-OOS (their sample ended 2007): EUR hours 09–11 UTC = −56% cumulative (hour 9:
0/12 years positive); hour 22 UTC +25.9% at 12/12 years (third asset class with the
post-US-close drift). New legs at 0.15bp/side:
- K: EUR-morning-short 09→12 UTC — standalone Sharpe 1.25, marginal Δ+0.18
- L: EUR-h22-long — Sharpe 0.95, Δ+0.05
**Book (9 suitable legs): Sharpe 1.60, +317%, DSR 1.05 (40 trials).** B and J remain
marginal-negative → pruned book ≈1.7. Trajectory: 1.13→1.24→1.53→1.60.

## Iteration 14 (loop): USDJPY does NOT replicate — EUR legs stand alone

Tokyo-hours yen depreciation (Breedon-Ranaldo's JPY prediction) is absent/inverted
2015–2026 (hour 1 UTC: −14.4%, 2/12 years; Tokyo morning net negative for USDJPY).
BoJ-era regime change. **No JPY leg.** The gate discriminating strengthens the EUR
result. Two book configs documented: MAX-SHARPE (drop B+J, ≈1.7) vs RETURN (keep B).
Bot upgraded with EUR legs K/L (EURUSD=X feed) while still flat.

## Iteration 15 (loop): DST ANCHOR BUG FIXED — deployable numbers re-based

Execution-audit gating item resolved (`remeasure-anchor.ts`, `extractTrades` gained
`entryClock: 'ny'`): old 22:01 UTC anchor sat on the CME maintenance break in winter.
Re-anchored to **18:05 ET DST-aware**:
- Gold overnight: Sharpe 1.09 → **0.85** (+81.8%, 11/12 yrs, halves +/+)
- Silver overnight: 0.81 → **0.59** (+109.9%, 7/12 yrs, halves +/+)
~22–28% of the old P&L was untradeable spot-only drift in the break hour. Edge survives.

**Re-based book (honest anchors): equal-weight Sharpe 1.44, DSR 0.89; INVERSE-VOL
Sharpe 1.85, MaxDD 6.6%** (iv auto-de-weights the weakened overnight legs).
Bot v3 live: 18:05–19:30 ET entry window, amfix-long + eur-h22 legs removed per audit.
Remaining reconciliation (real venue costs per leg, allocator) → other session's
execution-audit/allocator track.
