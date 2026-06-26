# Meta-Labeling Stage 1 — OOS probe (2026-06-26)

**Question:** Does a meta-labeler (López de Prado) predict which Run-20 trades win, out-of-sample? Stage 1 = the cheap, leakage-free probe; Stage 2 (bet-sizing + PBO/DSR gauntlet + 3-sym transfer) was gated on Stage 1 passing.

**Result: ROBUST HONEST NEGATIVE — no OOS signal. Stage 2 NOT pursued.**

## Method
- **Data:** 1,860 Run-20 (Broad Run-4, 7-symbol BTC/ETH/SOL/LINK/DOGE/NEAR/ADA) trades dumped via `backtest-confluence --dump-features` → `{features, label}` per trade. Label = `pnlPercent > 0` (win). Base rate 48.7%.
- **Features:** the 10+ confluence factors + `confluenceScore` + `dirLong` + regime one-hot (encodes vol bucket), **plus augmented context** (`priorOutcome`, `recentWinRate`, `priorCount`, hour/day) — all leakage-free (`exitTimestamp <= entryTimestamp`).
- **Validation:** purged + embargoed k-fold CV (López de Prado) — ~20 train samples purged per fold for label-window overlap. Logistic regression (standardize-on-train, L2), out-of-fold AUC + top-quantile lift.

## The number
| Config | OOS AUC |
|---|---|
| k=5, L2=1.0 (default) | 0.4895 |
| k=5, L2=0.01, iters=3000 | 0.4871 |
| k=3 | 0.4872 |
| k=10 | 0.5023 |
| embargo=0.05 | 0.4989 |
| top-q=0.1 | 0.4895 |

OOS AUC ∈ **[0.487, 0.502]** across all configs — indistinguishable from 0.50. Top-20% lift ≈ 1.3% (noise). **Gate (AUC>0.55 & lift>0): FAIL.**

## Interpretation
1. The confluence factors **already drove selection**, so no residual *linear* signal remains for a secondary model.
2. The augmented context added nothing → Run-20's win/loss sequence is **essentially serially independent** (no exploitable streaks) — the signature of a reasonably-efficient edge.
3. Robust across fold count / regularization / iterations / embargo → not a weak-model or leakage artifact. Clean negative.
4. Consistent with the project track record (~236 trials; edges die under honest validation).

## Caveats (what is NOT ruled out)
- **Feature-set-specific:** tested on confluence factors + basic context. The flagged frontier — **microstructure / order-flow (Bybit L2)** — was NOT in the features. The null is on these features, not on meta-labeling forever.
- A non-linear model (RF/GBM) might find interaction signal, but at higher overfit risk on ~1,860 samples; the robust linear null makes a durable non-linear edge unlikely.

## Reusable harness (the durable value)
`src/lib/meta/`: `dataset.ts` (dumper), `features.ts` (leakage-free augmented features), `purged-cv.ts` (López de Prado CV), `vectorize.ts`, `logistic.ts`, `eval.ts` (AUC/lift), `probe-core.ts`. CLI `scripts/meta-label-probe.ts`. Point it at a different feature set / label / strategy → honest OOS AUC in one run.

## Reproduce
```bash
npx tsx scripts/backtest-confluence.ts <Broad Run-4 flags> --dump-features /tmp/feat.json
npx tsx scripts/meta-label-probe.ts --features /tmp/feat.json [--k 5] [--l2 1.0]
```

**Strategic takeaway:** meta-labeling on OHLC-derived confluence features is null → redirect to NEW data (microstructure), not new models on the same features.
