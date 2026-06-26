# Strategy Research Loop — research → implement → improve → notes

**Started:** 2026-06-26 · **Branch:** `ftr/strategy-research-loop`
**Mandate:** open-minded but rigorous. Find & TEST strategies (not just "edges"); combine if useful. Each candidate gets a cheap *pulse check* (does it have a gross signal? does it survive cost?) BEFORE any full build. Kill fast, honestly.

**The reframe that justifies this loop:** the project tested **single-asset OHLC patterns** to exhaustion (~230 experiments, all signal families dead) and proved scalp/intraday OHLC dies to costs + low SNR. But it never systematically tested **relative-value / cross-sectional / mechanism-harvest** families — a structurally different space. That's where open-minded search belongs.

---

## Candidate backlog (priors + project-fit + sources)

| # | Candidate | Family | Intraday fit | Prior (lit) | Survives-cost risk | Status |
|---|---|---|---|---|---|---|
| 1 | Cross-sectional short-term **reversal** (long losers/short winners) | relative-value | high | strong (CO-OC reversal "robust") | HIGH (turnover) | ❌ **KILLED** (iter 1) |
| 2 | **Funding-carry delta-neutral** (collect funding, market-neutral) | mechanism harvest | n/a (carry) | strong: 10–20% APY, 0.8% maxDD 2025 | LOW | ✅ **SURVIVES** (iter 2) — parked as combine-candidate |
| 3 | **Stat-arb cointegration pairs** (spread mean-reversion, multi-day hold) | relative-value | med | Fil/Kristoufek 30%/yr; intraday HF variants | MED (longer hold = lower turnover) | ⏳ NEXT |
| 4 | **Lead-lag cross-predictability** (BTC→alt; intraday *negative* lead-lag) | relative-value | high | LASSO profits "net of realistic costs" | HIGH (intraday turnover) | queued |
| 5 | Cross-sectional **momentum** (2–4wk) / longer-horizon reversal, size/illiquidity factors | factor | low (weekly=swing) | large & significant, not on std factors | LOW | queued (swing, not intraday) |

Sources: cross-sectional crypto factors ([Dobrynskaya SSRN 3913263](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3913263); factor-momentum 3,900 coins); stat-arb ([Springer 978-3-031-68974-1_16](https://link.springer.com/chapter/10.1007/978-3-031-68974-1_16); Fil & Kristoufek); funding carry ([market-neutral funds +14.4% 2025](https://www.tv-hub.org/guide/market-neutral-strategy-crypto), [arbitragescanner guide](https://arbitragescanner.io/blog/crypto-funding-rate-arbitrage-guide)); lead-lag ([intraday cross-predictability, ScienceDirect S1062940822000833](https://www.sciencedirect.com/science/article/abs/pii/S1062940822000833); [seesaw effect S0927539823000956](https://www.sciencedirect.com/science/article/abs/pii/S0927539823000956)); short-term reversal robustness (QuantPedia CO-OC).

---

## Iteration 1 — Cross-sectional short-term reversal — ❌ KILLED

**Script:** `scripts/xs-reversal-pulse.ts` · 20-coin 1h panel, 28,878 bars. Long bottom tercile / short top tercile by trailing-k return, hold h, dollar-neutral. Cost = 4 legs × 5bps = 0.20%/rebalance.

| k | h | gross/reb | grossSharpe | netSharpe |
|---|---|---|---|---|
| 1 | 1 | +0.0085% | **1.91** | **−43.3** |
| 1 | 4 | +0.0110% | 0.65 | −11.1 |
| 1 | 24 | −0.0091% | −0.09 | −2.0 |
| 12 | 24 | +0.0237% | 0.22 | −1.6 |

**Verdict:** a real but tiny **gross** reversal premium exists *only* at 1-bar frequency (Sharpe 1.91) — cost is **~23× the signal** (0.0085% gross vs 0.20% cost), so net Sharpe −43. Slowing the hold to cut turnover **kills the gross premium** (Sharpe →0). That 1-bar premium *is* the bid-ask bounce → capturable only with **L2 / maker-rebate execution**, not candles. **Reinforces the standing thesis:** short-horizon edge = execution/microstructure, not OHLC. No candle-level cross-sectional reversal strategy here.

---

## Iteration 2 — Funding-carry delta-neutral — ✅ SURVIVES (parked as combine-candidate)

**Script:** `scripts/funding-carry-pulse.ts` · settlement-grid (8h) funding from `data/{BTC,ETH,SOL}USDT_futures_1h.json`, n=3,219 settlements/coin (~3yr). Long-spot / short-perp delta-neutral; carry P&L ≈ Σ funding − 2bps/settle rehedge. Tests always-on, funding-timed, combined-ew, + corr to BTC spot.

| book | n | annGross | annNet | Sharpe* | maxDD | %pos | totalNet |
|---|---|---|---|---|---|---|---|
| BTC always-on | 3219 | 8.2% | **6.0%** | 21.1* | 0.3% | 90 | 19% |
| ETH always-on | 3219 | 8.5% | **6.3%** | 21.0* | 0.2% | 90 | 20% |
| SOL always-on | 3219 | 6.3% | **4.1%** | 7.5* | 2.2% | 74 | 13% |
| BTC funding-timed | 3218 | 8.1% | 5.9% | 21.1* | 0.2% | 84 | 19% |
| SOL funding-timed | 3218 | 7.6% | 5.4% | 12.2* | 0.6% | 65 | 17% |
| **COMBINED ew** | 3219 | 7.7% | **5.5%** | 16.3* | 0.6% | 86 | 17% |

**Combined-carry vs BTC-spot return corr = 0.040** ⇒ genuinely market-neutral.

**Verdict:** the carry is **real and robust** — 90% of 3,219 settlements positive across all three coins; gross 8.2%/yr BTC matches the known ~0.01%/8h funding rate (conservative, not mined). It is genuinely **market-neutral** (ρ=0.04). funding-timing only helps the noisy coin (SOL 4.1→5.4%); BTC/ETH funding is ~always positive so timing is moot.

***The Sharpe 16–21 is an ARTIFACT — do NOT treat as deployable.** The funding stream is mechanically smooth, so the ratio explodes, but the true risk of delta-neutral carry lives in **basis blow-ups, spot-hedge cost/availability, and negative-funding regimes** — none of which a pure funding-rate series contains. Honest deployable read: **~5%/yr unlevered, near-zero spot correlation** — the textbook diversifier, opposite profile to the directional book.

**Why parked (not built out now):** a deployable carry book needs spot+perp **basis** data to model the tail (the part that actually hurts); I can't manufacture a real combination-Sharpe from the funding series alone, and plugging the artifact Sharpe into a portfolio formula would massively overstate the benefit. Promote to a full build IF/when basis data is sourced. As a *pulse* (does a gross, cost-surviving, uncorrelated carry exist?) the answer is decisively YES — unlike reversal.

**Data-bug caught & fixed (the "improve" step):** first run returned n=42 because the filter gated on `openInterest>0`, but OI is placeholder-zero across this file. Re-gated on real funding (drop leading zero-funding placeholder rows) → n=3,219. Lesson: validate sample size before trusting a pulse.

---

## Next (iteration 3): Stat-arb cointegration pairs

**Why:** relative-value family, but **multi-day hold** dodges the turnover wall that killed reversal (iter 1) — the cost ÷ signal ratio is the whole game. Lit prior strong (Fil & Kristoufek ~30%/yr gross). Pulse plan: screen the 20-coin panel for cointegrated pairs (Engle-Granger / rolling OLS hedge ratio + ADF on residual), trade the z-scored spread (enter |z|>2, exit |z|<0.5), hold days not hours → report gross vs net Sharpe at realistic 4-leg cost, and **% of pairs whose cointegration survives out-of-sample** (the real failure mode is spurious in-sample cointegration). Combine survivors into the book.
