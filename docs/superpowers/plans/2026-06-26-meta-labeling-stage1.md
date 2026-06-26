# Meta-Labeling on bot_trades — Stage 1 (OOS-signal probe)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development for every code task — failing test FIRST, watch it fail, minimal green.

**Goal:** Cheaply and honestly answer ONE question: *does a meta-labeler predict Run-20 trade outcomes out-of-sample, on the 7-symbol broad universe?* Meta-labeling = the confluence scorer decides SIDE (which trades); a secondary classifier predicts win/loss to later decide SIZE. Stage 1 builds only what's needed to measure OOS predictive lift with leakage-free CV; the bet-sizing + full PBO/DSR/MC gauntlet + 3-symbol transfer are **Stage 2, conditional on Stage 1 passing**.

**Honest framing (shapes the design):** the `factorBreakdown` features ALREADY drove trade selection (the scorer used them to pass threshold), so a linear re-use adds little — residual edge, if any, lives in non-linear interactions + **augmented context the scorer ignored** (prior-trade outcome, vol regime, time-of-day). This is the project's first genuinely-different mechanism, but it may still die under validation like the other ~236 trials. Build so a negative is a CLEAN negative (no leakage, no overfit), not a fake edge.

**Acceptance gate (Stage 1):** aggregated **OOS AUC > 0.55** (and a positive top-quantile win-rate lift vs base rate) on the 7-symbol set → proceed to Stage 2. Otherwise → honest negative, STOP.

## Data & features (grounded)
- `ScoredSignal.factorBreakdown: Record<string, number>` (`confluence-scorer.ts:290`) = the 10 Run-20 factors (structureAlignment, killZoneActive, liquiditySweep, obProximity, fvgAtCE, recentBOS, rrRatio, oteZone, obFvgConfluence, momentumConfirmation). Plus `confluenceScore`, `regime`, `direction`.
- **Label:** binary win = `netReturn > 0` (net of friction/funding — the realized sim outcome).
- Universe: 7-symbol Broad Run-4 (BTC/ETH/SOL/LINK/DOGE/NEAR/ADA), ~1687 trades.

## Global Constraints
- TDD Iron Law. TS strict, no `any`/`as any`.
- **PURE + DI for the ML core** (features, CV, model, AUC) — no Date.now/fetch/DB; deterministic given inputs. Reproducible seeds passed in (no Math.random in the pure core — pass a seeded RNG or sort deterministically).
- **NO LEAKAGE** is the whole point: the CV must purge train samples whose label window overlaps the test fold + embargo. A model evaluated without purging is a FAIL regardless of AUC.
- Compose: reuse the `--dump-positions` pattern (leverage work) for the dumper; reuse existing `pbo`/`deflated-sharpe`/`monte-carlo` in Stage 2 (not Stage 1).
- Commit `gmp "msg" type scope` (raw git commit banned). Scope `backend`/`docs`.
- Known-red baseline (do not touch): pre-existing `tests/bot/*` + unrelated `scripts/` typecheck errors.

## File Structure
| File | Responsibility |
|---|---|
| `scripts/dump-trade-features.ts` (or a `--dump-features` flag on backtest-confluence) | emit per-trade `{features, label}` JSON for a universe |
| `src/lib/meta/features.ts` | NEW — augmented feature engineering (pure) |
| `src/lib/meta/purged-cv.ts` | NEW — purged + embargoed k-fold split (pure) |
| `src/lib/meta/logistic.ts` | NEW — logistic-regression classifier (pure, seeded) |
| `src/lib/meta/eval.ts` | NEW — AUC + top-quantile lift (pure) |
| `scripts/meta-label-probe.ts` | Stage-1 runner: dataset → CV → model → OOS AUC/lift + gate |
| `tests/meta/*.test.ts` | unit tests per pure module |

## Tasks

### Task 1 — feature/label dataset dumper
- [ ] Pure `buildTradeFeatureRow(scored, regime, direction, netReturn, entryTimestamp, symbol)` → `{ symbol, entryTimestamp, exitTimestamp, features: Record<string,number>, direction, label: 0|1 }` (label = netReturn>0). TDD the pure mapping.
- [ ] Gated `--dump-features <path>` on `backtest-confluence.ts` (additive, byte-identical when absent) capturing `selectedSignal.factorBreakdown` + confluenceScore + regime at selection and the realized `netReturn`/timestamps after the sim. Verified by a controller run (count > 0, shape).

### Task 2 — augmented features (pure)
- [ ] `src/lib/meta/features.ts`: pure functions adding context the scorer didn't use — `priorTradeOutcome` (win/loss of the previous trade on that symbol, −1/0/+1), `volRegime` (ATR percentile bucket from candle context), `hourOfDay`/`killZone` flag. TDD each on synthetic inputs. Returns an extended feature record; never references future bars (no leakage).

### Task 3 — purged + embargoed k-fold CV (pure)
- [ ] `src/lib/meta/purged-cv.ts`: `purgedKFold(samples, {k, embargoFrac})` → folds of `{trainIdx, testIdx}`. Each sample has `[entryTimestamp, exitTimestamp]`. For each test fold, REMOVE from train any sample whose [entry,exit] overlaps the test fold's time span, plus an embargo gap after. TDD: construct overlapping samples and assert the overlapping train indices are purged; assert every index is tested exactly once; assert determinism.

### Task 4 — meta-model + OOS eval (pure) + the probe runner
- [ ] `src/lib/meta/logistic.ts`: pure logistic regression (standardize features, gradient descent with a passed-in seed/iterations, L2 reg) → `fit(X,y)` / `predictProba(X)`. TDD on a synthetic separable set (AUC≈1) and a pure-noise set (AUC≈0.5).
- [ ] `src/lib/meta/eval.ts`: pure `auc(scores, labels)` (rank-based) + `topQuantileLift(scores, labels, q)` (win-rate of top-q vs base rate). TDD with hand-checked literals.
- [ ] `scripts/meta-label-probe.ts`: load the 7-sym feature dump → build augmented features → purged k-fold → fit per train fold, predict OOS test fold → aggregate OOS predictions → print AUC + top-decile lift + the gate verdict (PASS if AUC>0.55 & lift>0).

## Risks / Honest Unknowns
- **Residual signal may be ~0** (features already used by the scorer) → expected possible negative. That IS a valid result.
- **Sample size** ~1687 is modest; logistic + L2 + purged CV is the disciplined choice. Do NOT reach for deep models in Stage 1.
- Class imbalance (Run-20 win rate ~48–53%) is mild; report base rate alongside lift.
- Stage 1 deliberately omits bet-sizing economics + PBO/DSR — a high OOS AUC is necessary, not sufficient; Stage 2 is the real economic + deflation test.
