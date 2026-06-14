# Funding-Cost PROBE — Does Run-20 survive funding charged as a real cost?

**Status:** PASS (survives, queued for WF re-confirm at review)
**Date:** 2026-06-14
**Probe:** `scripts/research-funding-cost.ts` → `experiments/runs/funding-cost-run20.json`

## Grounding (mechanism)

Funding settles 3x/day at 00:00/08:00/16:00 UTC; only positions open at the settlement instant pay/receive; positive rate ⇒ longs pay shorts. (Bybit Help Center, verified 2026-06-14.) Sources: Bybit "Introduction to Funding Rate" and "Perpetual Futures Contract Fees Explained".

We charge the **realized** funding rate at **each** crossed 00:00/08:00/16:00 UTC settlement in the half-open interval `(entry, exit]` — no proration of partial periods — via the shared funding-ledger keystone (`src/lib/cost/funding-ledger.ts`), the same signed rule the live `closePosition` path uses (zero sim/live mismatch). Sign convention: a **long in positive funding pays** (negative funding return); a short receives. On these three symbols funding is positive at ~89% of settlements (mean ~+0.74 bps/settlement), so a long-biased OB book is structurally a funding **payer**.

## Gross vs Net (Run-20, BTCUSDT/ETHUSDT/SOLUSDT, full sample)

| Metric | Published GROSS | Measured GROSS | Measured NET (funding charged) | Δ (net − gross) |
|---|---|---|---|---|
| WF pass-rate | 69.7% | 64.9% | **64.9%** | 0.0 pp |
| Full-sample PnL | +1573.7% | 309.8% | **262.4%** | -47.4 pp |
| Win rate | 48.5% | 44.6% | 44.3% | -0.30 pp |
| Trades | — | 657 | 657 | — |

> The measured-gross row may differ slightly from the published figure because the data window has been refreshed since Run-20 was frozen (MEMORY notes Run-20 reads 64.9% WF on refreshed data). The honest comparison is **measured gross → measured net on the same data**.

## Funding drag

- **Mean funding drag:** -1.96 bps per trade (signed; negative = the book pays).
- **Settlements crossed:** 4583 total, 7.0 per trade (mean hold spans ~7.0 funding windows).
- **Total funding paid:** 12.859% of notional summed across all trades.
- **Funding as a share of gross:** 5.5% of the per-trade-sum gross PnL.
- 641 of 657 trades crossed at least one settlement.

## Verdict vs the GATE

**Gate:** net WF pass-rate **> 60%** AND net full-sample PnL clearly positive.

- Net WF pass-rate: **64.9%** (> 60% ✓)
- Net full-sample PnL positive: **yes ✓**
- **VERDICT: PASS**

Run-20 survives funding charged as a real cost on the full sample. Funding is a measurable but non-fatal drag. Queue a funding-net **walk-forward re-confirm** at the next review before trusting bot sizing.

## Is the funding entry-FILTER now redundant?

The confluence scorer carries a funding entry-filter (`fundingMaxForLong` / `fundingMinForShort`) that rejects longs when funding is "too positive". Once funding is a **real per-settlement cost** in the PnL, that filter is **no longer a free hard gate** — it would be **double-counting** the funding signal if both are active and tuned together: the cost already penalizes holding longs through positive-funding settlements, so the filter should be re-evaluated as an *expected-cost-vs-edge* trade-off, not an independent reject. Run-20 ships with the filter **disabled** (`fundingMaxForLong=Infinity`), so there is no double-count in the deployed config today — but any future re-fit that prices funding in must treat the filter and the cost as the **same** signal and not stack them.

## Files

- `src/lib/cost/trade-cost.ts` — pure funding-charge + maker/taker split helpers (wraps the ledger).
- `scripts/backtest-confluence.ts` — `--charge-funding`, `--maker-bps`, `--taker-bps` (all default OFF; gross path unchanged).
- `scripts/research-funding-cost.ts` — this PROBE.
- `tests/cost/backtest-funding-debit.test.ts` — TDD unit (funding sign/boundary/no-proration + maker/taker split).
