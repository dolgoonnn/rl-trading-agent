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
