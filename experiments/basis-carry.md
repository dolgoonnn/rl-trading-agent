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

## CROSS-SECTIONAL funding carry (19-coin panel) — real gross edge, execution-blocked
`scripts/{download-xs-carry-data,xs-carry-analysis}.ts`. Downloaded funding + spot/perp basis
for 19 coins (BTC…ICP, 2023-26, ~29.8k bars each; funding dispersion BNB −0.0019%/8h → ARB
+0.0093%/8h). Each 8h: rank by trailing(EMA) funding, long-carry top-5 / short-carry bottom-5,
dollar-neutral, honest basis MtM.

**Gross edge is REAL and OOS-STABLE** (the differential persists where the level decays):
| rebalance | gross OOS | net@6bp OOS | net@12bp OOS |
|---|---|---|---|
| 8h (HOLD=1) | 8.7% Sh 6.78 | **−21.9%** | −52% |
| daily (HOLD=3) | — | −5.0% | — |
| 3-day (HOLD=9) | — | +4.0% Sh 2.72 | — |
| weekly (HOLD=21) | — | **+6.6% Sh 4.45** | +5.3% Sh 3.40 |
| 2-week (HOLD=42) | — | +7.2% Sh 4.89 | — |

Turnover wall: at 8h rebalance the funding ranking churns → gross +8.7% becomes net −22% (cost
~24%/yr). Slowing to weekly tames it → net +6.6% OOS, cost-robust, IS≈OOS (stable, NOT decaying
like the absolute level). The best gross signal of the whole session.

**BUT killed by alt-spot borrow** (the L/S short leg = short SPOT + long perp; alt spot must be
borrowed). Modeling borrow on the short legs:
| alt-spot borrow | OOS net (HOLD=21, 6bp) |
|---|---|
| 0% | +6.6% |
| 10% | **−3.4%** |
| 20% | −13.4% |
| 30% | −23.4% |
Real alt-spot borrow is 15-50%/yr → the market-neutral L/S is NOT deployable. Execution wall.

**Borrow-free deployable form = LONG-ONLY top-5 selection** (long spot/short perp only, no
borrow): OOS **3.1%/yr Sharpe 2.77** vs absolute-EW OOS 1.6% — selection adds ~1.5pp but keeps
the decaying common funding-level beta (corr 0.78 to absolute carry; IS 13.4%→OOS 3.1% = decays).

## Aggregate-funding REGIME signal — NULL (`scripts/funding-regime-pulse.ts`)
Distinct test from per-coin directional: panel-mean funding (EMA) as a leverage-sentiment gauge
vs forward BTC return (1d/3d/7d). corr is tiny (−0.016..−0.029 IS) and flips OOS (+0.028 at 7d);
quintile spreads ~0. No timing edge. Combined with the per-coin null, **funding has NO predictive
value at any level (per-coin or aggregate) — it is a CARRY mechanism only, never a signal.** Closes
funding-as-predictor for good.

### XS carry verdict
Real, OOS-stable GROSS edge (funding differential) — but the clean market-neutral form is
borrow-blocked and the borrow-free residual (long-only ~3%/yr OOS, decaying) is marginal.
Textbook confirmation of the loop thesis: real gross edge, binding constraint = execution
(turnover + alt-spot borrow), thin deployable residual. Do not deploy the L/S; the only
borrow-free carry is the modest long-only high-funding tilt.

## VERDICT — un-parked: real, modest, counterparty-risk-dominated diversifier
The funding carry is a GENUINE market-neutral edge (~3.5%/yr unlevered recently, ρ≈0/slightly
negative to crypto) — NOT the Sharpe-16 free lunch the pulse suggested. Deployable only as a
SMALL UNLEVERED sleeve where Bybit counterparty risk is explicitly accepted; the temptation to
lever it 3-5× (standard carry practice) is exactly what converts the hidden tail into ruin. For
this project's risk budget, the honest read is: real but marginal — the diversification value
(ρ≈0) is the only reason to consider it, and only unlevered. Consistent with the loop thesis:
mechanisms are real but the edge is thin and the risk is in execution/tails, not the headline.
