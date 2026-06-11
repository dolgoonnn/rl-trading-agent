# Gold 1m Exploratory Research — Conditional Structure Survey

**Date**: 2026-06-10
**Script**: `scripts/research-gold-1m.ts` → `experiments/runs/gold-1m-research.json`
**Data**: 2.28M 1m candles, 2020-01-01 → 2026-06-09 (gap-aware: returns across >5min gaps excluded)

## Findings

### 1. Time-of-day seasonal — THE real structure (★)

Of +61.3% total captured intraday log return, the **22:00–07:00 UTC window carries +62.6%**
— i.e., effectively all of it. The US session (13:00–21:00 UTC) is a NET DRAG of −19.5%
across a period when gold roughly doubled.

Per-year stability (cumulative % per window):

| Window | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 | Years + |
|---|---|---|---|---|---|---|---|---|
| Asian/overnight 22–07 | +5.6 | +10.4 | −3.6 | +9.9 | +12.2 | +25.0 | +3.1 | **6/7** |
| US 13–21 | +0.2 | −13.6 | +6.2 | −3.2 | −1.2 | +11.4 | −19.3 | 2/7 |
| London 7–13 | +4.8 | −9.1 | −7.3 | +2.2 | +9.3 | +11.5 | +4.7 | 4/7 |

- Hour 23 UTC alone (Globex reopen): +36.1% cumulative, **positive 7/7 years** — the
  single strongest cell in the table.
- This is NOT just "gold went up": if it were trend, every hour would be proportionally
  positive. US afternoon hours are net negative through a +100% bull market.
- Matches the documented "overnight gold drift" anomaly in the literature.
- Additionally ~40% of gold's total return is NOT in the intraday sum at all — it lives
  in weekend/holiday gaps (also a hold-through-closes effect).
- **Honest economics (unleveraged)**: 22–07 hold ≈ 9.7%/yr gross, 1 round trip/day at
  0.5–1.5 bps/side ⇒ 1.7–5%/yr friction ⇒ thin as standalone return, but the avoided
  US-session vol (4–4.8 bps/min vs 2–3 overnight) means the Sharpe/DD case may be
  stronger than the return case.

### 2. Sweep events carry NO information — negative alpha vs drift (definitive kill)

65,284 sweep events (same detector as `sweep_choch`), forward returns at 15/30/60/240 min:

- Long sweeps: +0.24 bps @15m (t=3.74) — statistically significant but **below the
  unconditional drift of ≈0.42 bps/15m**. The "signal" is the uptrend, minus a bit.
- Short sweeps: negative at every horizon (−0.86 bps @240m, t=−3.44) — shorting a
  swept high loses because drift dominates.
- Conditioning on session or daily EMA bias does not rescue any cell to economic size
  (best cell ≈ 1 bp @4h vs 1–3 bps friction).

**Closes the entire sweep/liquidity-grab family on gold at LTF: the event is drift-noise.**

### 3. Asian range breakout: dead

1,661 days: continuation WR 50.6%/48.3% (up/down), t < 0.9 both directions.
Wide-range tercile mildly positive (+10 bps, 53%) — vol-proportional, not actionable.
Consistent with the 1H asian-range model's OOS collapse.

## Round 2: event anomalies (`scripts/research-gold-events.ts`, 2015–2026, n≈2,950 days)

1. **London PM-fix down-drift REPLICATES** (lit: Caminschi & Heaney 2014): 14:00→15:00
   London = **−1.59 bps/day, t=−2.62**, regime-stable (−1.60 / −1.58 across halves).
   Post-AM-fix bounce +0.98 bps (t=3.12). Likely the mechanism behind the US-session drag.
   Economics: below retail friction; viable only as futures-tier short overlay
   (~1 bp/day net, ann. Sharpe ≈0.8) or session-hold exit-timing refinement.
2. **Intraday momentum (Gao et al. JFE 2018) does NOT transfer to gold**: first-30min →
   last-30min follow t=0.25–0.95, both NY-clock variants, both halves. Dead.
3. Last 30 min of NY day negative on ALL days (−1.6 to −1.8 bps) — drag confirmation.

## Implications

1. Gold's exploitable structure at intraday scale is **calendar/session-based, not
   pattern-based** — consistent with CMA-ES zeroing `structureAlignment` in every gold run.
2. The candidate pivot: session-timing as (a) a standalone "long 22–07 UTC" strategy, or
   (b) an execution overlay on the validated F2F daily model (same exposure, skip the
   US-session drag). The overlay version adds friction daily — net benefit must be measured.
3. The 1m dataset's role confirmed: falsification sandbox + execution research, not a
   pattern-signal source.
