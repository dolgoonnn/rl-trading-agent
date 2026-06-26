# Crypto funding/basis carry — HONEST un-parking (2026-06-26)

The funding carry was parked (strategy-research-loop iter 2) because the headline Sharpe 16-22
was an artifact of summing the smooth funding stream while ignoring the basis mark-to-market.
Step 2 of the systems loop: downloaded spot+perp 1h klines (`download-basis-data.ts` → Bybit
spot + linear, BTC/ETH/SOL, 2023-02→2026, ~29.8k aligned bars each) and built the honest
delta-neutral P&L (`basis-carry-analysis.ts`): r = funding_credit − Δbasis (long spot/short perp).

## Result — real edge, but the Sharpe was ~4× inflated
| | funding-only (artifact) | delta-neutral always-on (honest) | ann.ret |
|---|---|---|---|
| BTC | Sharpe 22.4 | **6.0** | 8.2% |
| ETH | Sharpe 22.1 | **5.8** | 8.5% |
| SOL | Sharpe 11.0 | **1.8** | 6.3% |
| EW (3 sym) | — | **5.1** | 7.7% |

- Basis mark-to-market cuts Sharpe ~4× (22→6) — the artifact is confirmed and quantified.
- **A real market-neutral carry survives**: ~8%/yr unlevered (BTC/ETH), honest Sharpe ~5-6.
- **corr(carry, perp) = −0.07 to −0.22** → not just market-neutral, slightly NEGATIVE beta
  (basis compresses when perp sells off / de-risks) → a genuine diversifier vs the directional book.
- Funding-gating (hold only when trailing funding > 0) barely changes it (BTC 6.04→5.91): funding
  is positive 89% of the time, so always-on ≈ gated. SOL gating helps (1.82→2.19, more neg-funding).

## Two honest red flags (do NOT treat Sharpe 5 as a directional Sharpe 5)
1. **DECAYING.** EW IS 2023-24: 10.1%/yr, Sharpe 6.38 → OOS 2025-26: **3.5%/yr, Sharpe 2.65.**
   Funding has compressed as more capital crowds the carry. The recent, forward-relevant number
   is ~3.5%/yr unlevered — modest.
2. **The price-Sharpe hides the real risk.** A delta-neutral carry has ~zero price risk (maxDD
   0.4-1.2% in the series) — but its dominant risk is COUNTERPARTY / OPERATIONAL (exchange
   blowup à la FTX, stablecoin de-peg, withdrawal halts) + sustained negative-funding regimes,
   NONE of which appear in a price series. This is the classic "pennies in front of a steamroller":
   Sharpe 5 right up until the tail event. Not comparable to a directional Sharpe.

Unmodeled costs (all adverse): hedge-rebalance drag (~0.5-1%/yr to hold delta-neutral as price
moves), spot-capital opportunity cost, borrow. Net forward expectation ≈ 2.5-3%/yr unlevered.

## Step-4 hunt: basis as a DIRECTIONAL signal — NULL (`scripts/basis-signal-pulse.ts`)
Thesis: extreme basis (crowded leveraged longs) → squeeze → negative forward perp return
(contrarian). Pulse: rolling-168h z-score of basis vs forward 8h/24h perp return, IS/OOS.
| | corr z→fwd IS | corr z→fwd OOS | read |
|---|---|---|---|
| BTC | −0.04/−0.05 | −0.018/−0.015 | weak contrarian, decays to ~0 |
| ETH | −0.008/−0.015 | **+0.008/+0.020** | flips sign OOS — dead |
| SOL | −0.010/+0.004 | −0.005/−0.002 | noise |
Inconsistent across symbols, decays/flips OOS; OOS decile spreads (5-11bp BTC) barely cover
cost. **Confirms the prior "funding = zero predictive power" null with proper basis data.** The
basis is real as a CARRY mechanism but useless as a directional timing signal. Don't re-test.

## VERDICT — un-parked: real, modest, counterparty-risk-dominated diversifier
The funding carry is a GENUINE market-neutral edge (~3.5%/yr unlevered recently, ρ≈0/slightly
negative to crypto) — NOT the Sharpe-16 free lunch the pulse suggested. Deployable only as a
SMALL UNLEVERED sleeve where Bybit counterparty risk is explicitly accepted; the temptation to
lever it 3-5× (standard carry practice) is exactly what converts the hidden tail into ruin. For
this project's risk budget, the honest read is: real but marginal — the diversification value
(ρ≈0) is the only reason to consider it, and only unlevered. Consistent with the loop thesis:
mechanisms are real but the edge is thin and the risk is in execution/tails, not the headline.
