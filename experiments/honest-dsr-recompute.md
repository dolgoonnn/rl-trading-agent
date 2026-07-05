# Honest per-observation DSR recompute (2026-07-06)

## The bug

`calculateSharpe(returns)` multiplies the per-observation Sharpe by
`ANNUALIZATION_FACTOR = sqrt(365·24) ≈ 93.6`. The DSR validation
(`scripts/validate-dsr.ts`, `experiments/dsr-results.json`) then fed that
**annualized** Sharpe into Lo's per-observation variance formula
`Var(SR) ≈ (1 + 0.5·SR²)/T` with `T = trade count`. SR and T at mismatched
frequencies inflate the deflated Sharpe by ~50–80×, so every config "PASSED".

The deflation math (`calculateDeflatedSharpe`) is correct; the callers passed the
wrong-frequency Sharpe. Fix = deflate the **per-observation** Sharpe with the
observation count. New guardrails: `deflatedSharpePerObs()`, `annualizedToPerObs()`,
`HOURLY_ANNUALIZATION_FACTOR` in `src/lib/rl/utils/deflated-sharpe.ts`; recompute in
`scripts/recompute-honest-dsr.ts`.

## Honest results (238 trials, real stored inputs)

| Config | Stored (inflated) | Honest per-obs | Verdict flip |
|---|---|---|---|
| 3-sym Run 20 (555 trades) | annualized 8.77 → DSR **7.58 PASS** | per-trade 0.094 → DSR **−0.043** | **FAIL** |
| 7-sym Broad Run 4 (1699 trades) | annualized 2.42 → DSR **2.21 PASS** | per-trade 0.026 → DSR **−0.054** | **FAIL** |
| **Deployed book** (Universe C handcraft, 681 daily) | — | per-day 0.143 → DSR **+0.089 @4 / +0.071 @12** | **PASS** (thin) |

## What this means (and doesn't)

- **The single-config DSR "PASS" numbers were artifacts.** At an honest 238-trial
  count on the per-trade frequency, neither Run 20 nor Broad Run 4 clears zero. The
  memory's "DSR 7.58 PASS / 3.41 PASS" should be read as inflation.
- **The deployed book still passes honestly — barely.** On its native daily
  frequency (681 days of real combined-book returns), the diversified handcraft
  book has per-day Sharpe 0.143 and honest DSR +0.07 to +0.09 (thin but positive).
  This is the "diversification IS the edge" thesis holding up: the book was never
  justified by the single-config numbers, and the honest recompute confirms that.
- **Caveat:** the book DSR uses only its own 4–12 combination trials, not 238. And
  skew 3.4 / kurt 35.5 = heavy jump risk in the daily book. The +0.07 margin is
  real but not comfortable — this is a book that survives, not one that dominates.

## Decision point — LIVE Kelly sizing (needs owner judgment, NOT auto-fixed)

`scripts/combine-strategies.ts:364` feeds the **same inflated DSR** into the LIVE
fractional-Kelly vol target (`fractionalKellyVolTarget`, `src/lib/risk/sizing.ts`).
That function returns **0 exposure whenever DSR ≤ 0**, and the honest rolling
per-day DSR hovers near zero. So naively correcting the convention there would make
the book **size to zero** most of the time — because `KELLY_FRACTION` and the DSR→
target mapping were (unknowingly) calibrated to the inflated number.

This is a sizing-policy recalibration, not a mechanical bug fix, so it is **left for
an explicit decision**. Options:
1. Recalibrate `KELLY_FRACTION` / the DSR→vol-target map to the honest per-day DSR
   scale (keeps Kelly sizing, honestly parameterized).
2. Drop the DSR-driven Kelly leg entirely and size at a fixed vol target
   (simpler; removes a fragile input the book barely clears).
3. Gate Kelly on the book-level daily DSR (which passes) instead of a per-config or
   annualized proxy.

Until decided, the live path keeps its current (inflated-DSR) behavior — which is
equivalent to "always full base vol target", i.e. no Kelly de-sizing. That is a
known, bounded behavior (the vol target itself caps exposure), not a latent blow-up.
