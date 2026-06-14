# ICT as Execution Layer on Gold — program verdict

**Date**: 2026-06-11. Design + external evidence: `ict-validation-research.md`.
Scripts: `research-ict-entry-timing.ts`, fix-sweep gate (inline, results below).

## Experiment 1 — overnight entry timing A/B: ❌ FALSIFIED (decisively)
Clock 18:05 ET vs sweep+reversion-bar entry (fallback 19:35 ET), same exit,
n=2949, MDE 0.70bp:
- ALL: **−0.99bp/day, t=−3.97** (ICT timing LOSES, statistically significant)
- Decomposition: triggered days +3.31bp (t=17.5) but fallback days −8.07bp
  (t=−15.6) — the missed-fill opportunity cost dominates, exactly as the
  execution literature predicted. **On a positive-drift window, waiting for a
  better entry forfeits the drift that IS the edge.**
- Nagel state prediction FAILED: high-vol tercile most negative (−1.53bp).
  Both halves negative. No state in which the timing layer wins.

## Experiment 2 — fix-short pre-fix sweep gate: SIGN REVERSED (post-hoc candidate)
Pre-registered (Savaser continuation → sweep improves short): **opposite observed.**
- Sweep days (pre-fix 13-14h high > 08-13h session high): −1.47bp, t=−1.55, n=1222
- No-sweep days: **+2.22bp, t=2.83, n=1728** — the whole fix edge lives here
- Read: upward breakout into the fix = continuation (Osler confirmed in our
  data); the ICT "sweep the highs then short" framing is exactly backwards.
- Status: AVOID-after-sweep gate = candidate leg improvement, but it is a
  POST-HOC finding (pre-registration failed in the registered direction).
- **VALIDATED 2026-06-12** (overnight loop, `runs/fix-sweep-filter-validation.json`):
  ordering (no-sweep > sweep) holds in BOTH halves (h1 +0.98 vs +0.30bp;
  h2 +3.22 t=2.72 vs −2.78 t=−2.08) and 4/5 rolling 2y windows (fails only
  2017-18 where both ~flat). Caveat: benefit is post-2020-concentrated.
  **REVIEW-READY** for the Sept cycle as a fix-short leg gate.

## Experiment 3 — daily bias + LTF FVG/OB fill: NOT RUN (de-prioritized)
Designated falsification arm with the weakest prior; Exp 1 already established
that delay-based entries on drift windows pay more in opportunity cost than
they collect in entry improvement, and gold structure carries no documented
information (40 prior experiments + external research). Run only if someone
produces a NEW mechanism argument.

## Program conclusion (the durable knowledge)
1. On gold mechanism edges, **take the edge at the clock**. Any scheme that
   delays entry to "improve" it pays the drift as opportunity cost — measured
   at −1bp/day net against +3.3bp/day of apparent entry improvement.
2. Sweeps on gold are CONTINUATION information, not reversal — consistent with
   Osler 2005, the ORB literature, and now two of our own datasets. The one
   honest use is as an avoid/regime filter on counter-trend legs (fix-short).
3. This closes the ICT-on-gold question across BOTH formulations:
   signal layer (40 experiments, dead) and execution layer (this program,
   dead for entry timing; one inverted filter candidate). The ICT vocabulary
   that survives on gold: kill-zone TIME windows and liquidity events as
   STATE — both already embedded in the session book.

## Transfer test (2026-06-12): gate does NOT transfer to silver own-fix
Pre-registered analog (pre-fix 10-11h Ldn high > 08-10h session high) on leg I:
sweep days BETTER for the short (+2.72bp t=2.77 vs +1.62bp t=2.05 no-sweep),
both halves. Third confirmation fix effects are fix-specific. Gate stays
gold-fix-only (Universe D composition correct). WATCH ITEM: silver own-fix
edge soft post-2020 (h2 t≈0.5-1.0) — monitor in paper run.
