# ICT gold scalp model — full implementation and walk-forward verdict

**Date**: 2026-08-03. Owner directive: implement the ICT gold scalping model
("OT theory" family — see memory `gold-scalp-deep-dig-2026-08` for the
ochiroo.ot recon) despite the prior closure of the space. Implemented
faithfully and tested honestly; results below are the record.

## What was built

- **`src/lib/scalp/strategies/sweep-displacement-fvg.ts`** (new): the full
  textbook composite — liquidity sweep of an untouched swing → displacement-
  flagged FVG in the trade direction (module's own displacement gate) →
  FIRST retrace to the FVG consequent encroachment with a reacting close →
  SL beyond the sweep wick ± ATR buffer, fixed-R target, London→NY session.
  Two modes: `reversal` (textbook: fade the sweep) and `continuation`
  (this repo's own OOS finding: gold sweeps continue). Wired into
  `backtest-scalp.ts` as `--strategy sweep_disp_fvg --sdf-mode <mode>`.
- **`silver-bullet.ts` DST fix**: window is now 10-11am NEW YORK (was fixed
  15:00-16:00 UTC — an hour late half the year).

## Test conditions

XAUUSD 1m 2020-2026 aggregated to 5m (456,521 bars), 314 walk-forward
windows (15d train / 5d val), harness fill model (`allowHeuristic:false`),
friction 0.5bp/side — MORE generous than any retail CFD (typical 1-2.5bp)
and roughly MGC futures tier. Deployability reference: the deployed crypto
config required 69.7% WF pass rate.

## Results — five formulations, all negative

| Model | Trades | Win rate | Avg P&L/trade | WF pass rate |
|---|---|---|---|---|
| ict_5m (OB+FVG+structure+KZ+1H bias) | 2,724 | — | −0.7bp | 44.6% |
| silver_bullet (correct NY-clock window) | 646 | 40.6% | −1.3bp | 41.0% |
| silver_bullet (old UTC window, for reference) | 580 | — | −0.4bp | 40.9% |
| sweep_choch (vendor-clone, choch bias) | 5,022 | — | −1.4bp | 37.3% |
| **sweep_disp_fvg REVERSAL (textbook)** | 1,780 | 39.3% | **−0.9bp** | 43.1% |
| **sweep_disp_fvg CONTINUATION** | 2,288 | 36.4% | **−1.7bp** | 41.1% |

## Interpretation

1. The composite loses in BOTH directions. This is the strongest form of the
   null: if sweep/FVG events carried directional information at the 5m
   horizon, at least one sign would win. Neither does — the events are
   informationally empty after spread at this granularity, not mispriced.
2. Fixing the silver-bullet window to the methodologically-correct NY clock
   made it WORSE (−0.4 → −1.3bp), eliminating the "you tested the wrong
   window" objection.
3. Costs are not the binding constraint here — these lose at 0.5bp/side,
   which no retail gold trader gets. There is no cost tier at which
   −0.7..−1.7bp/trade gross-ish edges become deployable.
4. Consistent with: 40+ prior gold experiments (kill zones, Judas, ORB,
   sweeps), the 2026-08 18-agent dig (zero verified gold scalpers exist),
   and the ochiroo.ot recon (the promoted account's visible P&L engine is a
   martingale grid at ~690x notional, not the taught entries).

## Standing verdict

The ICT gold scalp model is IMPLEMENTED (code stays in the repo, reusable),
and it is NOT deployable in any tested formulation. Parameter tuning within
this family is the exhausted space — do not iterate further without a NEW
information source (order flow, mechanism, or flow data), per
edge-source-vs-signal-hunting.
