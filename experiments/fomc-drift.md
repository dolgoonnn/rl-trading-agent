# FOMC event suite — pre-FOMC drift CANDIDATE, post-FOMC gold dead

**Date**: 2026-06-11. Script: `scripts/research-fomc.ts`, calendar: `data/fomc-calendar.json`
(90 scheduled announcements 2015–2026, emergency cuts excluded). Pre-registered from
literature (Lucca-Moench 2015, QuantSeeker 2024, Quantpedia uncertainty gate) — 1 trial,
no window mining.

## T1 — Pre-FOMC drift on US500: ✅ CANDIDATE
Long US500 from 14:00 ET day-before to 13:55 ET announcement day (exit BEFORE statement),
MES friction 0.5bp/side:
- All events: n=90, **+16.8bp/event, t=2.61, 58% WR**, h1 +2.71% / h2 +12.44% (sign-stable)
- Vol-gated (trailing 5d realized vol > trailing 252d median, no lookahead):
  n=31, **+36.7bp/event, t=2.78, 74% WR**
- Scale: ~8 events/yr ungated ≈ 1.3%/yr on full notional — same class as the NFP-mom leg.
  Mechanism: uncertainty-premium unwind into the announcement (flow/hedging anchored).

**Status**: queue for session-book inclusion at the NEXT review cycle (charter forbids
mid-run additions). Needs: marginal-contribution test vs existing book + correlation
with the US500-overnight leg (both long US500; the FOMC window partially overlaps the
overnight hold — check double-counting).

## T2 — Post-FOMC gold drift (IRFA 2024): ❌ DEAD
Sign of 14:00→14:05 ET move held to 15:00 ET: n=50 (gold 1m starts 2020), mean −1.5bp,
t=−0.18. The claimed easing-asymmetry REVERSES in our data (cuts: −26bp, 17% WR).
Another confirmation: candle-directional intraday gold has no edge. Do not re-test.

## Overlap homework (2026-06-12 overnight loop, `runs/fomc-overlap-results.json`)
**82% of the pre-FOMC window's mean return is the overnight segment** (T−1 16:00 →
T 09:31), corr(full, overnight) = 0.78 — the deployed US500-overnight leg (J)
already captures most of this edge on FOMC eves. Marginal book contribution of
adding the full FOMC leg at 0.5 weight: Sharpe 1.340 → 1.387, +7.6pp total —
real but small, and mostly FOMC-day exposure concentration rather than new alpha.
**Status DOWNGRADED**: not a standalone leg. Review decision becomes: (i) keep as-is
(leg J already harvests it), or (ii) test the non-overlapping remainder
(T−1 14:00–16:00 + FOMC-day 09:31–13:55 intraday continuation, ~18% of effect)
as a small FOMC-day extension. Remainder decomposition queued.

## FINAL (2026-06-12): remainder decomposition closes the candidate
Non-overnight remainder (T−1 14:00–16:00 + FOMC-day 09:31–13:55): n=90,
+1.1bp/event, t=0.29 — NOTHING outside leg J's window. Pre-FOMC drift was the
US500-overnight edge concentrated on FOMC eves. **Candidate CLOSED as redundant;
no new leg.** (Positive side effect: independent confirmation that leg J's edge
is event-flow anchored.)

---

## GROUNDED RE-VALIDATION (2026-06-14) — verdict holds, with a sharper why

Script: `scripts/research-fomc-revalidation.ts` (pure logic + tests in
`scripts/lib/fomc-drift-core.ts`, `tests/research/fomc-drift.test.ts`).
Artifact: `experiments/runs/fomc-drift-revalidation.json`.

### Primary source (the published anomaly)
- **Lucca & Moench (2015), "The Pre-FOMC Announcement Drift," J. Finance 70(1):329–371.**
  US equities drift **UP +49bp** over the **~24h ending 15 min before** a scheduled
  FOMC announcement; sample **Sep-1994 → Mar-2011**; the window accounts for **~80%
  of annual realized equity returns**. (NY Fed Staff Report 512.)
- **Kurov, Gilbert & Wolfe (2021), "The disappearing pre-FOMC announcement drift,"
  Finance Research Letters 40.** Post-publication **DECAY**: the per-meeting drift
  fell from **~0.5% → ~0.1% and became insignificant after the Dec-2015 ZLB
  liftoff**; what survives is **press-conference-only** and is explained by **reduced
  uncertainty** (VIX 17.7 → 14.7, the post-liftoff dummy goes insignificant once VIX
  is added). NY Fed Liberty St. update (2018): **~40bp on presser days, ~0bp on
  non-presser days**, Apr-2011 → 2018.
- **Takeaway from grounding:** our entire 2015+ sample sits in the regime where the
  literature says the anomaly has *largely decayed*. So the burden of proof is on us.

### Reproduced (matches the prior exactly)
- Our window (T−1 14:00 → T 13:55 ET, 0.5bp/side): **n=90, +16.8bp, t=2.61, 58% WR.** ✓
- **Window is NOT mined:** re-running the *published* LM window (T−1 13:45 → T 13:45)
  gives **+16.4bp, t=2.56** — essentially identical. Our window IS the published one.

### Adversarial results
1. **Magnitude vs paper — DECAYED.** 17bp vs the paper's 49bp ≈ **one-third**. Exactly
   the partial-decay the "disappearing drift" literature predicts for a 2015+ sample.
2. **Out-of-sample is unstable, and the strength is in the WRONG place.** Effect is
   weak/null 2015–2019 (pre-2020 half: **+6.8bp, t=1.15**; 2015–18: +11.1bp t=1.73) and
   concentrated post-2020 (**+24.9bp t=2.36**) and post-2022 (**+29.8bp t=2.60**). The
   literature says the drift should be *weaker* after 2015, not stronger — so the
   modern strength is suspicious of regime effects, not the documented anomaly.
3. **PLACEBO clears it of being generic bull-drift (the one point in its favor).**
   Same 24h window on **all 2,750 non-FOMC trading days = +3.0bp, t=1.51**; FOMC days
   = +16.8bp. In 2022+ the gap is starkest: **FOMC +29.8bp vs non-FOMC +1.6bp (t=0.50).**
   So the effect **is FOMC-specific**, not just intraday bull drift — the phenomenon is real.
4. **Press-conference split is directionally consistent but not significant.** Presser
   +18.8bp (t=2.47) vs non-presser +7.8bp (t=0.87); but the clean 2015–18 presser
   subset is only **t=1.53**. Matches LM-update's "presser-only" story weakly.
5. **Vol-gate headline (+36.7bp) is a MULTIPLE-TESTING ARTIFACT.** t=2.85 survives a
   naive Bonferroni-8 (crit 2.73) but **fails the Harvey-Liu √(2·lnN) deflation
   (deflated t ≈ 0.81 ≪ 1.96)**. And the gate *removes* aggregate PnL (gated total
   11.7% vs ungated 15.2%) — it concentrates the mean by dropping events, the classic
   selected-subset tell. **The vol-gate is not a real second edge.**
6. **Cost: survives in isolation.** Breakeven friction ≈ **8.9bp/side**; at MES 0.5bp/side
   the net is +16.8bp. Cost is not what kills it.

### VERDICT — CLOSED as a standalone leg (prior stands), corrected understanding
The pre-FOMC drift here is a **genuine, FOMC-specific but DECAYED remnant** (~1/3 of
paper magnitude) of the Lucca-Moench anomaly. It is **not deployable as a new leg**
because **~82% of it is already harvested by the deployed US500-overnight leg J**
(corr 0.78; non-overnight remainder +1.1bp, t=0.29 — §"overlap homework" above), and
its only "boost" (the vol-gate) does not survive multiple-testing correction.
Net new alpha over the existing book ≈ **0**. **No new leg. The MEMORY.md "queued
next review" label is STALE — this candidate was closed 2026-06-12 and the grounded
re-validation confirms the close.** (Bonus: the placebo is fresh independent evidence
that leg J's edge is event-flow anchored, not bull-beta.)
