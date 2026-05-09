# Funding-Arb Parameter Sweep — Findings

**Date:** 2026-05-10
**Scope:** Path B-2 — sweep `(minFundingRate, closeBelowRate)` over a 6×4 grid (24 cells, 21 valid configs after `closeRate < minRate` filter), rank by deflated Sharpe with proper selection-bias correction (numTrials=21).

## Headline

**No optimization win available in the tested grid. Ship the shipped defaults.**

All 21 valid configs produce **identical trade ledgers**: 13 trades, $120 net PnL, Sharpe ~2.61, walk-forward 50% (using sweep's trade-range windowing) or 85.7% (using validation script's data-range windowing — which is the methodologically correct one).

## Why the parameters don't matter

The funding-arb engine (`src/lib/bot/funding-arb-engine.ts`) applies three entry filters in series:

1. `|fundingRate| ≥ minFundingRate` (the swept parameter)
2. `spread ≤ maxEntrySpread`
3. `breakEvenHours ≤ 16` — where `breakEvenHours = (spread + 2*commission) / (|rate|/8)`

For BTC at the configured spread (0.0002) and commission (0.00055 per side), filter #3 implies `|rate| ≥ 0.000813` ≈ 0.081%. This is **much higher than any `minFundingRate` in the swept grid (0.005%–0.05%).**

The break-even filter is the binding constraint. Changing `minFundingRate` between 0.005% and 0.05% has zero effect because filter #3 already requires a higher rate. Similarly, `closeBelowRate` only affects exits and rarely triggers in practice (rates that pass entry tend to mean-revert before they cross the close threshold).

## DSR with proper 21-trial correction

To test whether the original validation's DSR=2.11 was misleading (because we'd later test more configs and create implicit selection bias), I re-ran validation on the shipped defaults with `numTrials=21`:

| Metric | 1-trial (original) | 21-trial (post-sweep) |
|---|---|---|
| Sharpe | 2.11 | 2.11 |
| Haircut | 0.00 | 1.60 |
| Deflated Sharpe | 2.11 | **0.51** |
| Bootstrap Sharpe 5th | 1.37 | 1.39 |
| Bootstrap PnL 5th | 3.4% | 3.4% |
| Skip 20% profitable | 100% | 100% |
| Verdict | 5/5 PASS | **5/5 PASS** |

The strategy survives even pessimistic selection-bias correction. DSR drops from 2.11 to 0.51 but remains positive, meaning the post-correction Sharpe is still significantly better than zero.

## What would actually move the needle

The break-even filter is the right place to look for improvement. Three honest paths:

1. **Better execution → lower effective spread.** Limit orders at the maker tier (commission ~0% instead of 0.055%) would relax the binding constraint. This is an *operational* change, not a parameter sweep.
2. **Raise the 16h break-even cap.** Currently hardcoded in the engine. Relaxing to 24h or 48h would admit more trades but also accept longer payback risk (rates can flip during a long hold).
3. **Multi-venue funding capture.** Different exchanges have different funding rates. The current backtest is single-venue; a cross-exchange version could find rate dislocations the single-venue scan misses.

None of these are parameter tunes. They're strategy/infrastructure changes outside the scope of "validate path B."

## Recommendation

**Ship the shipped defaults.** The strategy validates cleanly under both 1-trial and 21-trial correction. Don't tune further. If the next research budget opens up, spend it on the execution + multi-venue fronts (1, 2, 3 above), not on grid sweeps over (minFundingRate, closeBelowRate).

## Artifacts

- `experiments/funding-arb-sweep-results.json` — all 21 sweep configs with metrics
- `experiments/funding-arb-validation-results.json` — original 1-trial validation
- `experiments/funding-arb-validation-21trial.json` — same config, 21-trial DSR correction
- `experiments/funding-arb-baseline.json` — full trade ledger
