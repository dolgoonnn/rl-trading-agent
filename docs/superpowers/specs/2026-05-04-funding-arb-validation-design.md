# Funding-Rate Arbitrage — Validation Pipeline

**Date:** 2026-05-04
**Scope:** Path B from the project-plateau brainstorm. Validate the existing (coded but never validated) funding-arb strategy at its shipped defaults using the same statistical pipeline as ICT/F2F.
**Out of scope:** Strategy redesign, parameter optimization, hedge-leg execution, deployment to bot. All deferred to v2 if validation passes.

---

## Why

The codebase has a complete funding-arb implementation (~912 LOC: `src/lib/bot/funding-arb-{bot,engine,tracker}.ts`, `src/types/funding-arb.ts`, full DB schema, `--funding-arb` CLI flag wired into `run-bot.ts`) plus a 437-LOC backtest script. None of it has ever been run end-to-end and no validation artifacts exist. Before deploying — or before spending weeks redesigning — we need to know whether there is an exploitable funding edge in the data we already have.

Funding arb is a fundamentally different shape of strategy from ICT or F2F: most of the return is *predictable funding payments* on positions held across the 8h settlement schedule, not entry-timing alpha. So the validation pipeline can be smaller than ICT's. PBO and parameter-fragility checks add little when there is only one configuration being tested and almost nothing to overfit to.

## Goals

1. **Run the existing baseline backtest** end-to-end at shipped defaults and capture the trade ledger.
2. **Walk-forward validate** across rolling 6mo/1mo windows.
3. **Apply DSR + Monte Carlo** (bootstrap + skip-trades) to the trade series.
4. **Produce a structured validation results JSON** in the same shape as `experiments/f2f-validation-results.json`, so the existing `bootstrap-floors.ts` loader (path A) can consume it later if/when the strategy deploys.
5. **Verdict:** ≥ 4/5 checks pass → green-light deployment design (separate spec). Anything less → write up findings, don't deploy.

## Non-goals

- No parameter optimization (CMA-ES, grid search, sweeps). Single config validation only. If a marginal failure motivates a follow-up sweep, that's a separate spec.
- No PBO (only one config tested → no selection bias to estimate).
- No parameter-fragility test (no parameters to perturb meaningfully without running the same single config).
- No spot-leg/hedge execution. The backtest already assumes "perfect hedging, delta-neutral, no directional P&L". This is a *backtest convention*, not a production guarantee. Hedge engineering is a deployment-design concern.
- No bot integration, no PM2 entry, no allocator/monitor wiring. All deferred to a deployment spec contingent on validation passing.
- No new strategy code. Validation is read-only on the strategy.

---

## Architecture

A single new orchestration script that drives the validation, reusing existing utilities. No library code added. No bot code modified.

```
                 shipped defaults                experiments/funding-arb-validation-results.json
data/*_futures_1h.json ─┐
                        │
                        ▼
        scripts/validate-funding-arb.ts
                        │
        ┌───────────────┼────────────────┬──────────────────────┐
        ▼               ▼                ▼                      ▼
  [baseline       [walk-forward    [Deflated Sharpe       [Monte Carlo:
   backtest        loop: 6mo        from src/lib/rl/        bootstrap + skip
   via existing    train, 1mo       utils/                  from src/lib/rl/
   script-as-     val, 1mo slide]   deflated-sharpe.ts]     utils/monte-carlo.ts]
   library]
```

**Key boundary decisions:**
- **The orchestration script is the only new code.** No additions to `src/lib/`, no changes to `src/lib/bot/funding-arb-*.ts`, no changes to `scripts/backtest-funding-arb.ts` *unless* it must be refactored to expose its core loop as a callable function for the walk-forward loop.
- **If `backtest-funding-arb.ts` cannot be cleanly imported** as-is (it's currently CLI-only), extract its core run loop into a small `runFundingArbBacktest(config, windowStart, windowEnd): TradeLedger` function. Both the existing CLI script and the new validation script call it. This is the only structural change tolerated.
- **Validation results JSON is shape-compatible** with `experiments/f2f-validation-results.json` so path A's `bootstrap-floors.ts` parser works on it without changes when the strategy eventually deploys.

## Components

### `scripts/validate-funding-arb.ts` (~250 LOC)

Single orchestration script. CLI flags for symbols + window sizing only — strategy parameters are NOT exposed (the whole point is to validate the shipped defaults, not re-tune).

Pipeline (sequential):

1. **Pre-flight:** print data span per symbol, confirm ≥2.5 years available across all configured symbols, confirm `data/*_futures_1h.json` files have a `fundingRate` field.
2. **Baseline backtest:** run on the full dataset with shipped defaults. Save the full trade ledger to `experiments/funding-arb-baseline.json`. Print summary (total trades, total funding collected, net PnL, average APY, average hold time).
3. **Walk-forward loop:** train window 6mo (purely by date, used for nothing — funding arb has no parameters to fit; included only so the test mirrors ICT's structure for cross-comparability), val window 1mo, slide 1mo. For each val window, count net PnL > 0 as a "passing" window. Compute pass rate.
4. **Deflated Sharpe Ratio:** feed the baseline trade ledger into `computeDeflatedSharpe` from `src/lib/rl/utils/deflated-sharpe.ts`. Trial count for selection-bias correction = 1 (single configuration). DSR floor: > 0.
5. **Monte Carlo bootstrap:** 1000 trade-level resamples via `src/lib/rl/utils/monte-carlo.ts`. Record 5th-percentile Sharpe and 5th-percentile PnL.
6. **Monte Carlo skip-trades:** drop a random 20% of trades, repeat 1000×, count how many of the 1000 still produce positive PnL. Threshold: ≥ 95%.
7. **Verdict + report:** assemble all checks into a `checks: [{name, value, threshold, pass}]` array, write `experiments/funding-arb-validation-results.json` (same shape as `experiments/f2f-validation-results.json`), and a `details` object with the raw numbers (Sharpe, PnL, trade count, MC distributions). Log a one-line verdict: `5/5 PASS — green-light deployment design` or `N/5 — see details`.

### Pass Criteria (5 checks)

| # | Name | Threshold | Source |
|---|------|-----------|--------|
| 1 | Walk-Forward ≥60% | ≥60% of val windows have positive PnL | walk-forward loop |
| 2 | DSR > 0 | Deflated Sharpe Ratio positive after 1-trial selection bias correction | `deflated-sharpe.ts` |
| 3 | MC Bootstrap Sharpe 5th > 0 | 5th percentile of bootstrapped Sharpe distribution positive | `monte-carlo.ts` |
| 4 | MC Bootstrap PnL 5th > 0% | 5th percentile of bootstrapped PnL distribution positive | `monte-carlo.ts` |
| 5 | MC Skip 20% ≥95% | At least 95% of trade-skip resamples remain profitable | `monte-carlo.ts` |

Pass = ≥4/5 deploys, =5/5 deploys with confidence, ≤3/5 documents findings and stops.

### Output: `experiments/funding-arb-validation-results.json`

Identical shape to F2F:

```json
{
  "timestamp": "2026-05-XX...",
  "dataRange": { "start": "2023-02-23", "end": "2026-02-01", "bars": <count> },
  "config": { "symbols": [...], "minFundingRate": 0.0002, "closeBelowRate": 0.00005, ... },
  "checks": [ { "name": "...", "value": "...", "threshold": "...", "pass": <bool> }, ... ],
  "details": {
    "totalTrades": <n>,
    "totalFundingCollected": <usd>,
    "netPnl": <usd>,
    "sharpe": <num>,
    "deflatedSharpe": <num>,
    "bootstrapSharpe5": <num>,
    "bootstrapPnl5Pct": <num>,
    "skip20PassRate": <num>,
    "wfWindowsPass": <n>,
    "wfWindowsTotal": <n>
  }
}
```

The `bootstrapSharpe5` field naming matches F2F so the path A bootstrap-floors loader picks it up automatically when funding-arb is added as a `StrategyId`.

## Data flow

1. CLI invocation → load configured symbols' `_futures_1h.json` files.
2. Run baseline backtest function (extracted from existing script). Get `Trade[]`.
3. Loop walk-forward windows by date filter on the trade timestamps (no need to re-run the strategy per window since funding arb has no fit step — just slice the realized trade ledger by val-window date range).
4. Run all stat tests on either the full `Trade[]` or window-sliced subsets.
5. Write JSON, print verdict.

## Error handling

- **Insufficient data:** if any configured symbol has < 2.5 years of data, error and exit 1 before any computation. The cross-window stats need enough trades.
- **Zero trades in baseline:** if backtest produces 0 trades at the shipped config, error and exit 1 with "strategy never triggered — check data shape and `fundingRate` field." Don't write a misleading 0-trade validation result.
- **Tiny trade count overall:** if total trades < 30, write the result file but flag DSR + MC results as "insufficient sample" in the `value` strings (still report the numbers, but the verdict line says "insufficient data for confidence").
- **Walk-forward windows with 0 trades:** count as neither pass nor fail (excluded from denominator), same as ICT's pattern.
- **`scripts/backtest-funding-arb.ts` not refactorable cleanly:** if extracting the run loop is messier than expected (>30 LOC of net change), report and ask the user before proceeding rather than rewriting the script.

## Testing

Vitest is now installed (path A, Task 0). For this validation pipeline:

- **Unit-test the walk-forward window slicer** (a pure function over a `Trade[]` and date range pair).
- **Unit-test the verdict assembler** (input: array of {pass: bool}; output: pass rate + verdict string).
- **Do not unit-test** the backtest core, DSR, or MC — they're either existing code or thin wrappers over existing utils.
- **Integration verification** is the script run itself: it must produce a real validation JSON on the actual data.

## Migration / rollout

1. Land the script + tests.
2. Run it against current data. Capture results.
3. **Stop.** This spec ends here.
4. If 5/5 (or 4/5): write a follow-up *deployment* spec covering: PM2 entry, allocator integration (add `'funding-arb'` to `StrategyId`), bootstrap-floors.ts entry, hedge-leg engineering, monitor wiring.
5. If ≤3/5: write a findings memo. Decide whether to redesign the strategy (path B option 2 or 3 from the brainstorm) or move on to a different orthogonal alpha.

## Open questions deferred to v2

- **Hedge leg in production.** Backtest assumes delta-neutral; bot only opens the perp. A real deployment either needs spot-leg execution (operationally complex) or accepts directional risk (and must size accordingly).
- **Cross-exchange arbitrage.** Funding rates differ between Bybit/Binance/OKX. Single-venue validation here; multi-venue is a separate larger initiative.
- **Higher-resolution funding data.** `scripts/sync-bybit-funding.ts` exists; if validation is borderline, more accurate funding data could change the verdict.
- **Symbol expansion.** Funding edge is typically larger on smaller-cap symbols. Adding more symbols is also a separate investigation.
