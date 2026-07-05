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

## Cross-metal confirmation — SILVER fix (`scripts/silver-fix-systems.ts`, 12:00 London auction)

Silver has its own LBMA auction (12:00 London). The METALS BOOK already deploys "Ag fix-short
11-12"; scanned the tighter-window + post-fix-bounce structure (never done on silver). At
0.5bp/side (silver futures-tight):
| silver window | IS Sharpe | OOS Sharpe | survive |
|---|---|---|---|
| pre-fix 11-12 SHORT (deployed) | 0.76 | **3.11** | ✅ |
| pre-fix 11:30-12 SHORT (tighter) | 0.84 | 2.94 | ✅ |
| pre-fix 10-12 SHORT | 0.72 | 2.33 | ✅ |
| post-fix 12-12:30 LONG (bounce) | 0.50 | 0.76 | ✅ |

The identical **pre-fix-short + post-fix-bounce** structure now confirmed across THREE
independent auctions (gold PM 15:00, gold AM 10:30, silver 12:00) — strong mechanistic evidence
the fix-flow edge is real, not mined. Silver's is the strongest (deployed leg OOS 3.11). The
tighter 11:30-12 does NOT beat the deployed 11-12 (unlike gold, where 14:30-15 did) — silver's
deployed window is already optimal. Post-fix 12-12:30 bounce = a coherent but weak (0.5-0.76)
additive candidate for the futures-tier book.

Two caveats (both honesty-critical): (1) **futures-tier only again** — at 2bp/side retail the
*recent* 2020-26 (IS) period goes negative (deployed leg IS −0.41); only the older 2015-19 still
clears. (2) **The edge is DECAYING** — on BOTH metals the 2015-19 (OOS) fix-drift is markedly
stronger than 2020-26 (IS): gold 14:30-15 IS 0.39→OOS 1.06; silver 11-12 IS 0.76→OOS 3.11.
Consistent with post-reform auction electronification reducing informed-flow leakage. Forward
expectation should be anchored to the WEAKER recent (IS) numbers, not the OOS headline.

## SYSTEMS-LOOP TERMINAL VERDICT (metals intraday)
The only metals intraday SYSTEM is the **fix mechanism** (pre-fix short + post-fix bounce),
confirmed across THREE auctions (gold PM 15:00, gold AM 10:30, silver 12:00): real, OOS-robust,
mechanistically coherent, independently replicated — but **institutional/futures-only** (alive at
0.3–0.5bp/side, dead at retail spot). No retail-deployable form exists (cost sensitivity +
month-end + silver-retail all confirm). Candle patterns (~22 hyps), calendar (ToM/DOW/momentum),
and events (FOMC/NFP) are all dead.

**Deployable takeaways (futures-tier book):**
1. Validates the two deployed METALS BOOK legs on the true 2015-19 holdout: gold fix-short
   (OOS 0.57) and silver fix-short (OOS **3.11**, the strongest).
2. Actionable refinement: gold's tighter **14:30–15:00** window (OOS 1.06 vs deployed 0.57) —
   forward-test candidate. (Silver's deployed 11-12 is already optimal; no refinement.)
3. New additive candidate: **post-fix bounce** (gold 15-15:30 LONG, silver 12-12:30 LONG) —
   coherent across auctions but weak (Sharpe 0.5-0.76), futures-tier only.
4. Caveat for sizing: the edge is **decaying** (2020-26 IS << 2015-19 OOS on both metals) —
   anchor forward expectations to the weaker recent numbers.
