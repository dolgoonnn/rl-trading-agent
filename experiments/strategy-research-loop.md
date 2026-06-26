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
| 3 | **Stat-arb cointegration pairs** (spread mean-reversion, multi-day hold) | relative-value | med | Fil/Kristoufek 30%/yr; intraday HF variants | MED (longer hold = lower turnover) | ❌ **KILLED** (iter 3, by walk-forward) |
| 4 | **Lead-lag cross-predictability** (BTC→alt; intraday *negative* lead-lag) | relative-value | high | LASSO profits "net of realistic costs" | HIGH (intraday turnover) | ❌ **KILLED** (iter 4, cost wall + decay) |
| 5 | Cross-sectional **momentum** (2–4wk) / longer-horizon reversal, size/illiquidity factors | factor | low (weekly=swing) | large & significant, not on std factors | LOW | ⏳ NEXT (low-turnover ⇒ should dodge the cost wall) |

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

## Iteration 3 — Stat-arb cointegration pairs — ❌ KILLED (by walk-forward)

**Script:** `scripts/statarb-pairs-pulse.ts` · 20-coin 1h panel, 12,875 common bars. Engle-Granger (OLS log-log hedge β + Dickey-Fuller t on residual), z-scored spread, enter |z|>2 / exit |z|<0.5, β-hedged, net of (1+β)×5bps per change. Three lenses: single 50/50 split, equal-weight basket, rolling walk-forward.

**The trap and the catch:**
- **Single 50/50 split looked like a strong survivor:** all-pairs basket net Sharpe **1.52**, 27%/yr, 9.2% maxDD; *cost-robust* (Sharpe 1.52→1.48→1.41 at 5/10/20 bps — the multi-day hold dodges the turnover wall that killed reversal); corr −0.26 to BTC. The cointegration FILTER never helped (cointegrated basket 1.26 < all-pairs 1.52 — breadth/diversification beats DF-selection; the ADF test is theater).
- **Walk-forward KILLED it:** rolling IS=3000→OOS=1500, β re-estimated per window ⇒ **1/6 windows positive, mean Sharpe −0.86** (−1.31, +0.95, −1.56, −0.64, −0.25, −2.32). Long IS=6000 is *worse* (1/6, mean −1.53 — not an estimation-length problem). Reactive short OOS=750 is a coin-flip (6/11, mean −0.57). The 50/50's OOS half simply happened to be a mean-reverting regime.

**Verdict:** the mean-reversion is **regime-dependent, not a persistent edge** — it does not survive realistic rolling deployment. Classic single-split trap; the project's own WF gate (>60% windows positive + positive mean) is exactly what exposed it. **Lesson re-confirmed: never trust a single-split / full-sample backtest — walk-forward decides.** I was one commit from recording this as a winner.

**Why funding carry (iter 2) is NOT subject to this:** carry is a *mechanism* (funding contractually paid every 8h, 90% positive over 3yr, zero fitted params in always-on) — no estimation-window fragility. Stat-arb's edge was a *fitted* statistical relationship → regime-fragile. Different robustness class.

---

## Iteration 4 — Lead-lag cross-predictability — ❌ KILLED (cost wall + decay)

**Script:** `scripts/leadlag-pulse.ts` · leader=BTC, 19 alts, 12,874 1h return bars. pos_A[t] = sign(IS corr(r_A[t], r_BTC[t-1]))·clip(r_BTC[t-1]/σ_IS, ±3); equal-weight basket; rolling WF IS=3000/OOS=1500; cost 5bps·|Δpos|/bar. Reports GROSS (signal exists?) and NET (survives turnover?).

| | windows positive | mean Sharpe |
|---|---|---|
| GROSS | **6/6** | **2.24** |
| NET | **0/6** | **−6.84** |

GROSS Sharpe by window: 3.73, 5.16, 3.41, 0.30, 0.11, 0.74 (decaying). NET: −1.47 … −25.07 (worsening).

**Verdict:** the lead-lag signal is **real** (6/6 gross windows positive — BTC's last bar predicts alts' next bar, the spillover/seesaw exists) but it lives at **1h turnover** and is **entirely eaten by cost** (position flips nearly every bar). Plus it's **decaying** (gross Sharpe 3.7→0.1 across the sample — classic lead-lag erosion as the market gets more efficient). Same signature as reversal (iter 1): a real GROSS signal that is an **execution/microstructure edge, not a candle edge** — capturable only with maker rebates / L2 / sub-second reaction, which we don't have.

---

## Standing scorecard (after 4 iterations)

| # | candidate | family | verdict | why |
|---|---|---|---|---|
| 1 | reversal | relative-value | ❌ KILLED | gross @1-bar only; cost 23× signal |
| 2 | funding carry | mechanism | ✅ PARKED | real ~5%/yr unlevered, ρ≈0; Sharpe artifact; needs basis/tail data to deploy |
| 3 | stat-arb pairs | relative-value | ❌ KILLED | 50/50 looked great but WF 1/6 — regime-fragile fitted relationship |
| 4 | lead-lag | relative-value | ❌ KILLED | real gross (6/6) but cost wall @1h + decay → execution edge |

**Pattern (now empirically re-confirmed in the cross-sectional space the project never tested):** every SIGNAL dies — to cost (1,4), regime-fragility (3), or both. The only survivor is a MECHANISM (2, funding). This *is* the project's standing thesis (edge = execution/microstructure or mechanism, not OHLC signals) — and it now holds beyond single-asset OHLC. **The common kill switch is turnover×cost or estimation-window fragility; the common survivor trait is "no fitted signal, just harvest a structural payment."**

---

## Next (iteration 5): Cross-sectional momentum (low-turnover factor)

**Why it's the strongest remaining candidate:** it is the one family that *structurally dodges the kill switches above* — **weekly rebalance** (swing, not intraday) ⇒ low turnover ⇒ no cost wall (killed 1,4); and it's a **risk-premium factor** (rank by trailing 2–4wk return, hold winners), not a fitted pairwise relationship ⇒ less regime-fragile than stat-arb (3). Lit prior strong (Dobrynskaya: large & significant crypto momentum, not spanned by standard factors). **Honest design:** rolling WF, weekly rebalance, long top-tercile / short bottom-tercile (and long-only variant — shorting alts is hard), net of realistic cost, demand >60% windows positive + positive mean, and corr to the directional book (combine-candidate check).
