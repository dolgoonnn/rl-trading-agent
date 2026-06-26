# Gold intraday SYSTEMS loop (mechanism/time, NOT candle patterns) — 2026-06-26

After ~23 candle-based intraday hypotheses died (see `gold-scalp-scorecard.md`), re-ran
the loop with **systems** = mechanism/time/information edges. The one academically-grounded
lead was the LBMA **fix window** (Caminschi-Heaney 2014, "Fixing a Leaky Fixing": informed-flow
move around the fix). `scripts/gold-fix-systems.ts`, DST-aware London clock, IS 2020-26 +
OOS 2015-19 holdout.

## Result — the fix-window IS a real edge (first OOS survivor in the whole gold search)

At **0.3bp/side** (institutional/futures-tight cost — matches the deployed fix-short):
| system | OOS bp/day | OOS Sharpe | survive |
|---|---|---|---|
| pre-fix 14:00–15:00 SHORT (deployed METALS BOOK leg) | +1.00 | 0.57 | ✅ |
| **pre-fix 14:30–15:00 SHORT** (tighter) | +1.43 | **1.06** | ✅ |
| pre-fix 13:00–15:00 SHORT | +1.46 | 0.56 | ✅ |
| post-fix 15:00–15:30 LONG (bounce) | +0.61 | 0.54 | ✅ |
| **AM pre-fix 10:00–10:30 SHORT** | +0.37 | 0.64 | ✅ |
| AM post-fix 10:30–11:00 LONG (bounce) | +0.33 | 0.58 | ✅ |

**Credible, not data-mined:** (1) the tighter 14:30–15:00 window is STRONGER OOS than the
deployed 14:00–15:00 — the down-drift concentrates right before the fix; (2) the identical
pattern (pre-fix short + post-fix bounce) repeats independently at the **AM fix** — same
mechanism, two separate auctions ⇒ strong robustness. The pre-fix down-drift + post-fix
bounce is the documented fix microstructure (positioning into the auction, reversion after).

## The catch — INSTITUTIONAL/FUTURES ONLY (cost sensitivity)

The edge is small (~1–2bp/day gross) and execution-gated:
| cost/side | 14:30–15 SHORT OOS Sharpe | AM pre-fix OOS Sharpe |
|---|---|---|
| 0.3bp (GC futures / institutional spot) | **1.06** ✅ | 0.64 ✅ |
| 1bp (tight retail) | 0.02 (gone) | −1.78 ❌ |
| 2bp (retail spot XAUUSD) | −1.46 ❌ | −5.23 ❌ |

At retail spot gold spread (2–4bp RT) it's **dead**. It's only alive at ~0.6–0.8bp RT — which
is achievable on **COMEX GC futures** (≈1 tick + commission), NOT retail spot. This matches
how pros actually trade it (GC futures, around the fix) and matches the project's METALS BOOK
deploying fix-short at a 0.3bp/side assumption.

## VERDICT
The systems loop succeeded where candle patterns failed: there IS a real, OOS-confirmed,
mechanistically-coherent gold intraday edge — the **fix-window drift** (pre-fix short + post-fix
bounce, AM & PM). It is **not a retail scalp edge** (dies at spot spread); it is an
**institutional/futures execution edge**, ~1–2bp/day, already harvested by the METALS BOOK.
The loop's refinement: the **14:30–15:00 pre-PM-fix window** (OOS Sharpe 1.06) is tighter and
stronger than the deployed 14:00–15:00 — a candidate tweak for the deployed fix-short leg.

This is the honest "how people do it": the edge is mechanism + execution (the fix, on futures),
exactly as the project thesis and the web research said — never a spot-candle pattern.

## Improve step — month-end concentration REJECTED by holdout (`scripts/gold-fix-monthend.ts`)

Mechanism prediction: benchmark/index rebalancing flow is largest at month-end ⇒ the fix
down-drift should concentrate in the last K business days, giving a cost-robust subset
(bigger move, ~5× fewer trades). Tested 14→15 London short split by business-days-to-month-end.
| | month-end (last K bd) | rest-of-month |
|---|---|---|
| IS 20-26 K=5 | **4.02bp, Sharpe 1.85, t=2.30** | 0.04bp ≈ 0 |
| OOS 15-19 K=5 | 0.45bp, Sharpe 0.27 | **1.17bp, Sharpe 0.65** |
| OOS 15-19 K=3 | 2.05bp, Sharpe 1.40, **t=1.18 (insig)** | 0.84bp |

In-sample the edge is *entirely* month-end (rest ≈ 0) — a perfect mechanism story. OOS it
**vanishes**: month-end is NOT specially strong (rest-of-month is stronger at K=5), the K=3
point estimate is insignificant (t=1.18) and flips sign vs K=5 = noise. At 1bp/side all gone.
**No cost-robust retail subset.** The fix edge is real but *diffuse* across the month, not
concentrable — same IS-strong/OOS-gone signature as time-of-day. Refinement closed.

## Cross-check — replicates prior independent work
`experiments/calendar-research.md` (2026-06-10, independent) found the identical conclusion:
gold London PM-fix down-drift −1.59bp/d into 15:00, t=−2.62, regime-stable, "below retail
friction — futures-tier overlay only." Two independent passes ⇒ the fix mechanism is solid;
both reach "institutional/futures-tier only." Turn-of-month gold there = regime-unstable (dead).

## SYSTEMS-LOOP TERMINAL VERDICT (gold intraday)
The only gold intraday SYSTEM is the **fix mechanism** (pre-fix short + post-fix bounce, AM &
PM): real, OOS-robust, mechanistically coherent, independently replicated — but **institutional/
futures-only** (~0.6bp RT). No retail-deployable form exists (cost sensitivity + month-end both
confirm). Candle patterns (~22 hyps), calendar (ToM/DOW/momentum), and events (FOMC/NFP) are all
dead. Deployable gold edge stays the overnight/fix METALS BOOK; the loop's one actionable
refinement is the tighter **14:30–15:00 pre-PM-fix window** (OOS 1.06 vs deployed 0.57) as a
forward-test candidate for the existing fix-short leg.
