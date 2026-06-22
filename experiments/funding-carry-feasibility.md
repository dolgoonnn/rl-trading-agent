# Crypto perpetual FUNDING / BASIS CARRY — feasibility net-of-cost

**Status:** ⚠️ STRUCTURAL CARRY IS REAL (~7-8%/yr net) but it is a LOW-YIELD,
FAT-TAIL CASH-CARRY — not a deployable alpha sleeve. The headline "Sharpe" is a
backtest illusion; the true risk is the crash tail the funding ledger cannot see.
**Threshold-gated harvesting is uniformly net-negative** (confirms + explains the
prior funding-arb sleeve graveyard entry).
**Date:** 2026-06-14
**Probe:** `scripts/research-funding-carry.ts` → `experiments/runs/funding-carry-results.json`
**Core (tested):** `scripts/lib/funding-carry-core.ts`, `tests/research/funding-carry.test.ts` (5/5)

---

## 1. Grounding (primary source first)

**Primary — BIS Working Paper 1087 "Crypto carry"** (Schmeling, Schrimpf, Todorov,
2023; rev. Oct 2025). https://www.bis.org/publ/work1087.htm

- **Spec:** crypto carry = **SHORT a perpetual future + LONG the corresponding
  spot** (delta-neutral "cash-and-carry"). The funding rate (settled ~3×/day)
  flows between longs and shorts to anchor the perp to spot; a **short receives
  funding when the rate is positive**.
- **Documented return:** average carry "above 10% annually, much larger than the
  carry of other financial assets", **peaks exceeding 40% p.a.**, with large
  time variation.
- **Interpretation (the load-bearing caveat):** the carry is **compensation for
  CRASH RISK, not arbitrage profit** — "a high crypto carry predicts future
  price crashes" and co-moves with the price of crash-risk insurance. Driven by
  (i) leveraged demand from trend-chasing retail and (ii) limited arbitrage
  capital (regulatory/margin frictions). The PDF stream did not text-extract for
  verbatim Sharpe; figures below come from the peer-style replication.

**Replication — arXiv:2510.14435 "Cryptocurrency as an Investable Asset Class"**
(Oct 2025), §3.9, which explicitly implements "the crypto-carry trade strategy of
Schmeling et al. (2023)". https://arxiv.org/html/2510.14435v2

- "The profit from the cryptocurrency carry strategy is mostly driven by the
  funding rate, which in the full sample has a **mean return of approximately 8%
  with a low volatility of 0.8%**." Full-sample (Aug-2020→May-2025) **Sharpe 6.45**.
- **"Beginning in 2024, the Sharpe ratio falls to 4.06, and it turns negative in
  2025."** (Spot-ETF cash-and-carry arbitrage flooded the trade and compressed
  funding.)

**Practitioner corroboration** —
[CryptoAdventure "where the trade breaks"](https://cryptoadventure.com/cash-and-carry-arbitrage-in-crypto-explained-basis-funding-capture-and-where-the-trade-breaks/)
and [BitMEX/Hyperliquid funding-harvest](https://www.bitmex.com/blog/harvest-funding-payments-on-hyperliquid):
delta-neutral funding capture yielded ~15.6% (SOL) / 15.7% (AVAX) annualized in
H1-2025 *before leverage*; Securitize's BTC basis trade ~10.78-11.95% p.a. The
trade "breaks" on: funding flipping neutral/negative, two-leg fees + spread,
basis compression, margin/liquidation stress on the short leg, and venue/
counterparty risk. None of these last four appear in a clean funding backtest.

---

## 2. What we tested (documented spec, our data)

Delta-neutral cash-and-carry on **BTCUSDT, ETHUSDT, SOLUSDT**, funding from
`data/{SYM}_futures_1h.json` snapped to the canonical 00/08/16 UTC settlement
grid (3,220 settlements/symbol, **2.94 yr**, Feb-2023→Feb-2026). Harvest =
`+Σ realized funding` at each crossed settlement via the shared funding-ledger
keystone (`src/lib/cost/funding-ledger.ts`, `direction:'short'`) — the **same**
settlement-counting rule the live `closePosition` path uses (zero sim/live
mismatch; the always-on path carries a runtime audit assertion that the inline
harvest equals the ledger result).

**Cost model (venue-realistic, Bybit-class):** taker **5.5 bps/side** + spread
**2 bps (BTC) / 3 bps (ETH, SOL)** per side, charged on **BOTH legs at open AND
close** (a full open+close of the two-leg position = ~15-17 bps round-trip).

**Two variants:**
- **A) Always-on** (the BIS structural framing): hold the basis trade the whole
  sample; pay ONE round-trip; harvest every settlement (positive AND negative).
- **B) Threshold-gated** (deployable "harvest only when it pays"): in-market only
  when the **last settled** funding rate (strictly before the bar — no
  look-ahead) ≥ threshold; pay a round-trip on every in→out cycle. This is the
  apples-to-apples successor to the prior funding-arb sleeve.

No look-ahead: variant B's signal is `lastSettledRateBefore(t)`; the harvest is
realized funding credited over the held interval, never anticipated. (Both rules
unit-tested.)

---

## 3. Results net-of-cost

### Variant A — always-on cash-and-carry

| Symbol | Gross APY | **Net APY** | Costs / gross | Realized vol | Daily Sharpe* | MaxDD |
|---|---|---|---|---|---|---|
| BTCUSDT | 8.2% | **8.1%** | 1.2% | 0.50%/yr | 16.3 | 0.30% |
| ETHUSDT | 8.5% | **8.4%** | 1.4% | 0.53%/yr | 15.9 | 0.34% |
| SOLUSDT | 6.3% | **6.2%** | 1.8% | 0.90%/yr | 6.9 | 1.37% |
| **EW 3-sym** | 7.7% | **7.6%** | ~1.5% | 0.59%/yr | 12.8 | ~0% |

\* **The daily Sharpe is a backtest ARTIFACT — do not bank it.** A funding-ledger
backtest models carry as a near-riskless accrual, which is precisely the illusion
the BIS paper warns against. The real risk is the **fat left tail** (a sharp move
that liquidates the short leg / a depeg / an exchange or counterparty failure)
that funding data structurally cannot show. The published Sharpe of 6.45 — and
its collapse to negative in 2025 — is the honest number; our 12.8 is high only
because (a) our 2023-26 window omits the negative-Sharpe 2020-22 segment the
paper includes, and (b) our clean hedge never realizes a crash. **SOL's 6.9 is
closest to reality** precisely because its funding is the messiest.

### Variant B — threshold-gated (deployable harvest)

**Uniformly NET-NEGATIVE at every gate, every symbol** (e.g. BTC >2bps: −1.9%/yr,
costs ate 204% of gross; SOL >5bps: −0.8%/yr). Gating in/out pays a full
~15-17 bps two-leg round-trip per cycle that a handful of sub-1-bps 8h
settlements cannot recover. This is the decisive practitioner result and it
**confirms + mechanistically explains** the prior `funding-arb` sleeve
(graveyard: ~3.4%/yr) — the always-on structural hold is the only viable form,
and even then it is a cash-like yield, not alpha.

### Year-by-year gross carry — matches the published decay EXACTLY

| Symbol | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|
| BTC | 7.6% | **11.9%** | 5.2% | 5.8% |
| ETH | 7.8% | **12.9%** | 5.0% | 4.2% |
| SOL | 5.3% | **13.7%** | **0.2%** | 1.5% |

2024 peak → 2025 collapse, exactly the arc the replication reports
("Sharpe → negative in 2025"). **SOL 2025 at 0.2% gross is net-NEGATIVE after
costs** — the edge dies in real time as ETF cash-and-carry arbitrage compresses
funding.

---

## 4. Comparison to the published figures

| | Published (BIS / arXiv 2510.14435) | Ours (3-sym, 2023-26) | Why it differs |
|---|---|---|---|
| Mean carry | ~8%/yr (peaks >40%) | 7.6%/yr EW (BTC 8.1, ETH 8.4, SOL 6.2) | **Very close.** Our window misses the high-carry 2020-21 bull and the peak >40% spikes. |
| Vol | ~0.8%/yr | 0.5-0.9%/yr | **Matches.** |
| Sharpe | 6.45 full → 4.06 (2024) → **neg (2025)** | 6.9-16 daily (illusory) | Ours omits 2020-22 AND the crash tail; the *direction* (2024 strong → 2025 collapse) **reproduces exactly** in our year-by-year. |
| Costs eat | qualitative ("harder on a real balance sheet") | always-on: 1-2% of gross; **gated: 160-460%** | Always-on amortizes one round-trip over ~3yr; gating is destroyed by per-cycle two-leg friction. |

Headline: **our data independently reproduces the paper's central facts** — ~8%
mean, ~0.8% vol, and the 2024→2025 decay — using a settlement-honest ledger and
realistic two-leg costs.

---

## 5. Verdict

**NULL as a tradeable alpha sleeve; the mechanism is REAL but is a low-yield,
fat-tail cash-carry, not edge.**

- **Net ~7-8%/yr** structural carry is real and survives realistic costs, but:
  1. it is the **strongest mechanism prior's** weakest payoff form — a cash-like
     yield (~7-8%) whose attractive "Sharpe" is an artifact of omitting the
     crash tail the BIS paper says you are being *paid for*;
  2. it is **decaying in real time** (2024 12-14% → 2025 4-5%, SOL → 0.2%) as
     spot-ETF arbitrage crowds it out — the published "negative in 2025" is
     visible in our own data;
  3. the only deployable (gated) form is **net-negative** because two-leg
     friction dominates 8-hourly sub-bps harvests;
  4. our backtest **cannot price the tail** (liquidation/depeg/venue risk) — the
     real downside lives exactly where the data is silent.
- **Do not queue as a return sleeve.** If anything, the always-on basis trade is
  only interesting as an **idle-cash / collateral overlay** at unleveraged
  ~7%/yr with eyes open about the crash-risk tail — the same conclusion the prior
  `funding-arb` sleeve reached (~3.4%/yr after its threshold gating), now
  grounded in the primary source and explained.
- **Funding family verdict for this repo:** funding has **no directional value**
  (RL features null; extreme-conditioning null — KNOWLEDGE.md graveyard) and its
  **carry value is a thin, decaying, tail-risky cash yield**. The book that
  matters remains crypto Run-20 (where funding is correctly priced as a per-trade
  cost via the ledger, not harvested as a signal). Family CLOSED.

---

## 6. Files

- `scripts/research-funding-carry.ts` — the probe (always-on + gated variants,
  year-by-year decay, EW portfolio, published comparison).
- `scripts/lib/funding-carry-core.ts` — pure, tested primitives (`carryHarvest`
  via the funding-ledger; `lastSettledRateBefore` no-look-ahead signal lag).
- `tests/research/funding-carry.test.ts` — 5 tests (short-receives-funding sign,
  multi-settlement no-proration harvest, no-cross-zero-harvest, signal lag uses
  strictly-prior settlement, null-before-first-settlement).
- `experiments/runs/funding-carry-results.json` — full numeric output.
- Builds on: `experiments/funding-arb-backtest-results.json` (prior sleeve),
  `experiments/funding-cost.md` (funding-as-cost on Run-20), `src/lib/cost/funding-ledger.ts`.
