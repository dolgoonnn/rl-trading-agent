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

## CORRECTION (2026-07-06): the LIVE path is CLEAN — no live sizing bug

An earlier note in this session claimed the inflated DSR was "actively driving live
Kelly sizing." **That was wrong, and it is corrected here.** Verified:

- The **live governance** (`src/lib/bot/book-governance.ts`, `scripts/run-allocator.ts`)
  uses **rolling annualized Sharpe as thresholds** — WATCH < 0, BREACH < −1.0 — which
  is a correct use of annualized Sharpe against a constant. It uses **no DSR at all**.
  No inflation bug in live sizing or halting.
- `fractionalKellyVolTarget` / `calculateDeflatedSharpe` appear ONLY in
  `scripts/combine-strategies.ts`, an offline **research/backtest** script (not imported
  by any bot). The DSR inflation was confined to offline research/validation — it
  affected the NUMBERS used to justify deployment, never live behavior.

### combine-strategies.ts — mislabel, not a return-inflating bug (no numeric change made)

`combine-strategies.ts:364` deflates an **annualized** rolling Sharpe with a 4-trial
haircut and feeds it to `fractionalKellyVolTarget` with `KELLY_FRACTION = 0.5`. On the
annualized scale this acts as a **conviction ramp**: full 12% vol target once rolling
annualized Sharpe clears ~2, standing down only when it goes non-positive. Crucially:

- **This does not inflate the edge or the returns.** Sharpe is scale-invariant, so the
  honest book Sharpe (2.27 ann / DSR +0.07) is unaffected; the ~40%/yr headline is a
  LEVERAGE choice (lever a real, thin edge to 12% vol), which is honest.
- **Naively swapping in the honest per-day DSR (~0.07) with the same fraction would
  collapse the book to ~0.4% vol** — a 30× de-lever. That is a behavior change, NOT a
  bug fix, and would misrepresent the book. So the numeric path was left unchanged and
  a scale-note comment was added at the call site to prevent a future naive "fix".

### The only genuine owner decision left (low-stakes, research-only)

Whether to keep the current conviction-ramp sizing (annualized-Sharpe-gated 12% vol
target, consistent with the live governor) or re-express it as a recalibrated
per-observation fractional-Kelly. Either is defensible; the edge and the live path are
unaffected either way. Not urgent, not a safety issue.
