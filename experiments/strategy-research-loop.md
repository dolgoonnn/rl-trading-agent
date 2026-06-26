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
| 5 | Cross-sectional **momentum** (2–4wk) / longer-horizon reversal, size/illiquidity factors | factor | low (weekly=swing) | large & significant, not on std factors | LOW | ✅ **SURVIVES — strongest** (iter 5); combine-candidate |

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

## Iteration 5 — Cross-sectional momentum — ✅ SURVIVES (strongest result of the loop)

**Script:** `scripts/xs-momentum-pulse.ts` · 20-coin 1h panel, weekly (HOLD=168) rebalance. Rank by trailing LOOKBACK return; long top tercile / short bottom tercile (and long-only). Cost charged on ACTUAL name turnover/rebalance.

**Long-short (market-neutral):**
| lookback | grossSharpe | netSharpe | netAnn | maxDD | split-half (1st/2nd) |
|---|---|---|---|---|---|
| 1wk | 0.37 | 0.25 | 8.5% | 24.3% | −0.42 / 0.74 |
| **2wk** | 1.55 | **1.49** | **58.0%** | 15.8% | **1.48 / 1.50** |
| 4wk | 1.15 | 1.10 | 40.3% | 24.6% | 1.39 / 0.87 |
| 8wk | 1.52 | 1.48 | 57.9% | 17.4% | 1.96 / 0.89 |

**Long-only beats market** (selection, not just beta): momo−market excess Sharpe +0.76/+0.84/+1.40 at 2/4/8wk.

**Deep-dive on 2wk long-short (the winner):**
- **Rolling 20-week Sharpe: 52/55 windows positive (95%)** — median 2.47, min −1.71, max 3.58. *This is the rolling-WF robustness stat-arb FAILED (1/6) and momentum PASSES decisively.*
- **corr to BTC weekly return = 0.069** — genuinely market-neutral ⇒ real diversifier.
- **cost-robust**: at 20bps/name net Sharpe still 1.31 / 50.8%/yr / split-half 1.28/1.33 (low weekly turnover dodges the cost wall).
- not a lucky lookback: 2/4/8wk all net >1; only 1wk fails (too short → reversal noise).

**Verdict: real, robust, market-neutral, combinable momentum factor.** It structurally dodges BOTH kill switches — low turnover (survives cost, unlike 1,4) and a fixed ranking rule with no fitted params (not regime-fragile, unlike 3). Momentum is also the single most robust premium in cross-market asset pricing, so the EFFECT is not a fluke.

**The one material caveat — survivorship bias:** the 20-coin universe is coins alive *today* with full history; a point-in-time universe (including delisted/dead coins) would lower the magnitude (winners that kept winning are over-represented; coins that went to zero are excluded). The *existence* of the premium (52/55 rolling, 0.07 BTC corr) is not a survivorship artifact, but the **~50–58%/yr level is almost certainly inflated** — treat as upper bound pending a survivorship-free universe. Short-leg also assumes alt shortability (borrow cost/availability); long-only is more deployable but carries 43–53% maxDD (long beta into bears).

---

## Standing scorecard (after 5 iterations — all candidates tested)

| # | candidate | family | verdict | one-line why |
|---|---|---|---|---|
| 1 | reversal | relative-value | ❌ KILLED | gross @1-bar only; cost 23× signal |
| 2 | funding carry | mechanism | ✅ PARKED | real ~5%/yr unlevered, ρ≈0; Sharpe artifact; needs basis data to deploy |
| 3 | stat-arb pairs | relative-value | ❌ KILLED | 50/50 looked great, WF 1/6 — regime-fragile fitted relationship |
| 4 | lead-lag | relative-value | ❌ KILLED | real gross (6/6) but cost wall @1h + decay → execution edge |
| 5 | **xs-momentum** | **factor** | ✅ **SURVIVES (strongest)** | net Sharpe 1.3–1.5, 52/55 rolling, ρ=0.07 BTC, cost-robust |

**Refined thesis:** NOT "all signals are dead." The precise law: **high-turnover signals die to cost (1,4); fitted statistical relationships die to regime shift (3); a LOW-turnover risk-premium FACTOR survives (5), as does a structural MECHANISM (2).** The two survivors are both market-neutral and ~uncorrelated to the directional book → genuine "combine" candidates. Momentum (5) is the prize: real return, clean robustness, deployable shape.

---

## Iteration 6 — COMBINE: book + xs-momentum — ✅ REAL DIVERSIFICATION GAIN

**Scripts:** `scripts/add-momentum-sleeve.ts` (emits the validated 2wk LS momentum as daily log returns + a survivorship-haircut variant) → reuses the tested `scripts/combine-strategies.ts` (handcraft/ERC/DM/vol-target) via a new `RETURNS_FILE` env + gated Universes E/F.

**First, a data correction that mattered:** all iters 1–5 ran on a 20-coin panel whose common timeline was truncated to **Sep-2024** by MATICUSDT (MATIC→POL rebrand, data ends 2024-09-10 — the single limiting coin). Dropping MATIC (rebrand/data artifact, not a zero) extends the panel to **Feb-2026 (full ~3yr window)**. Re-validated momentum on the full window:
- **2wk LS holds: net Sharpe 1.51** (was 1.49 on the short window), 64.5%/yr, maxDD 29.6% (more realistic), split-half 1.74/1.30, **rolling 112/129 (87%) positive**, ρ=0.08.
- **4wk/8wk BROKE in the recent regime** (2nd-half Sharpe −0.29/−0.26) — the edge is concentrated at the **1–2wk horizon**; 2wk is robust on both windows. Mild horizon-sensitivity noted.

**Combine result — EW book, same window (2023-05-29→2026-01-08), same 3 base sleeves ± momentum:**
| book (EW) | annRet | raw Sharpe | vol-targeted Sharpe |
|---|---|---|---|
| A: crypto+sessionBook+f2f | 31.9% | 2.93 | 2.79 |
| **E: + xsMomentum** | 33.6% | **3.23** | **3.40** |
| F: + xsMomentum (Sharpe halved to 0.79) | 30.8% | 2.96 | **3.14** |

momentum's correlation to every sleeve ≤ |0.08| (crypto −0.02, sessionBook −0.08, f2f +0.02) → DM 1.72→1.97. Adding it lifts EW Sharpe **2.93→3.23 (+0.30 raw, +0.61 vol-targeted)** at ~flat drawdown. EW beats handcraft/ERC (P<50%) — consistent with the project's robust-EW finding.

**Survivorship-robustness (the key honest check):** even with momentum's Sharpe **halved to 0.79** (conservative survivorship floor), the **vol-targeted book still improves 2.79→3.14 (+0.35)** (raw ~flat +0.03). Because ρ≈0 is *structural* (market-neutral), the diversification benefit survives the haircut — only its magnitude scales with momentum's true Sharpe. Realistic outcome sits between E and F: **the book improves, most clearly vol-targeted (the deployable config).**

**Verdict:** xs-momentum LS is a genuine, combinable, ~uncorrelated sleeve that improves the existing book even under a conservative survivorship haircut. The loop's "combine if needed" mandate is satisfied with a real result.

---

## Loop summary (6 iterations)

Tested 5 candidates in the relative-value/cross-sectional/mechanism space the project had never touched, then combined the winner:
- **KILLED (3):** reversal (cost wall), stat-arb pairs (regime-fragile, WF 1/6), lead-lag (cost wall @1h + decay). All *signals*; all die to turnover×cost or estimation-window fragility.
- **PARKED (1):** funding carry — real mechanism (~5%/yr, ρ=0.04) but Sharpe is an artifact; needs basis/tail data to deploy.
- **SURVIVED + COMBINED (1):** xs-momentum 2wk LS — net Sharpe ~1.5, 87% rolling windows, ρ≈0.08; adds +0.30–0.61 to book Sharpe, robust to a survivorship haircut (vol-targeted).

**Final refined thesis:** the project's "edge = execution/mechanism, not signals" is *mostly* right but **incomplete** — a **low-turnover risk-premium FACTOR (cross-sectional momentum)** also survives, and uniquely it *combines* with the directional book for a real diversification gain. The kill switches are universal (turnover×cost; estimation-window/regime fragility); the survivor traits are: no per-trade fitting, low turnover, market-neutral, structurally uncorrelated.

## Iteration 7 — Time-series (absolute) momentum / trend — ⚠️ real but redundant

**Script:** `scripts/ts-momentum-pulse.ts` · 19-coin 1h panel, weekly rebalance, inverse-vol sized, long/short each coin on its own trailing trend (Moskowitz-Ooi-Pedersen).

| lkbk | netSharpe | netAnn | maxDD | avgNetExp | splitH | corr→BTC |
|---|---|---|---|---|---|---|
| 1wk | 0.49 | 23% | 52% | −0.05 | 0.14/0.76 | 0.04 |
| 2wk | 0.70 | 32% | 51% | −0.10 | 0.44/0.91 | 0.01 |
| **4wk** | **1.11** | 49.6% | 33.8% | −0.11 | 1.52/0.77 | 0.01 |
| 8wk | 0.79 | 36% | 37% | −0.10 | 0.39/1.11 | −0.20 |
| 12wk | 0.68 | 34% | 44% | −0.07 | 0.28/1.00 | −0.06 |

**Verdict:** a real edge AND a surprise — it's **market-neutral, not long beta** (inverse-vol weighting across 19 coins → avg net exposure ≈ −0.1, corr→BTC ≈ 0.01). Best at 4wk (net Sharpe 1.11, both split-halves positive). **But weaker and more lookback-sensitive than xs-momentum** (only 4wk clears 1.0 vs xs-momentum robust across 1–2wk; xs 1.51 > ts 1.11) and it's the **same factor family** ⇒ almost certainly captures the same premium. Not promoted as an independent sleeve — **xs-momentum dominates as the momentum representative.** (Could revisit a momentum *composite* of xs+ts if ever chasing marginal robustness, but YAGNI now.)

## Iteration 8 — Low-volatility / betting-against-beta (BAB) — ❌ KILLED (doesn't transfer to crypto)

**Script:** `scripts/bab-pulse.ts` · 19-coin panel, weekly, long low-vol tercile / short high-vol tercile, dollar-neutral.

| volWin | netSharpe | netAnn | splitH | corr→BTC |
|---|---|---|---|---|
| 7d | −0.10 | −3.6% | −0.49/0.32 | −0.37 |
| 14d | 0.11 | 4.2% | 0.06/0.17 | −0.27 |
| 30d | 0.18 | 8.5% | −0.34/0.55 | −0.11 |
| 60d | −0.23 | −12.2% | −0.82/0.29 | −0.35 |

**Verdict:** no premium (net Sharpe ~0–0.18, unstable split-halves with negative first halves). The equity low-vol anomaly **does not transfer to crypto** — consistent with crypto's lottery/speculative character: high-vol alts aren't penalized, they often have the biggest runs (MAX/lottery preference dominates the low-vol effect). Clean kill of a genuinely new factor family.

## Iteration 9 — Order-flow imbalance (takerBuyVolume) — ❌ no candle edge, ✅ thesis-confirming

**Script:** `scripts/flow-imbalance-pulse.ts` · 19-coin panel, imbalance=(2·takerBuy−vol)/vol (1h-aggregated order-flow proxy), cross-sectional long-short, both directions, holds 24h/168h.

| dir | look/hold | grossSharpe | netSharpe | splitH |
|---|---|---|---|---|
| momentum | 24/24 | −0.63 | −1.24 | −1.32/−1.18 |
| reversal | 24/24 | **+0.63** | **+0.01** | 0.02/0.01 |
| momentum | 336/168 | 0.60 | 0.54 | 0.32/0.73 |
| reversal | 168/168 | 0.48 | 0.39 | 1.05/−0.37 |

**Verdict:** at fast (24h) frequency there's a real GROSS flow-reversal signal (Sharpe +0.63) **entirely eaten by turnover cost (net +0.01)** — the textbook signature of a microstructure edge that needs sub-hour/L2 execution, not candles. The only net-positive config (slow weekly flow-momentum, net 0.54) is a noisy proxy for price momentum (redundant). **No tradeable candle edge, BUT a clean empirical confirmation of the project thesis using order-flow data directly:** the edge is real and lives *below the candle/cost frontier*. Reinforces [[edge-source-vs-signal-hunting]] — order-flow IS where signal is, but harvesting it needs L2/maker execution we don't have.

## Hard stop (set 2026-06-26 after user chose "keep searching")
**Loop ends after iteration 10.** One iteration remaining: 10 (Amihud illiquidity — the most orthogonal new factor left). After that → stop searching, pivot to deploying xs-momentum (the one validated, combinable winner).

## Possible next iterations (open backlog)
- **Deploy path for xs-momentum:** point-in-time (survivorship-free) universe to nail the true magnitude; shortability/borrow-cost model for the LS leg (long-only is more deployable but 64% maxDD); wire as a paper sleeve.
- **Funding carry:** source spot+perp basis data → model the tail → revisit deploy.
- **New families not yet tested:** time-series (not cross-sectional) momentum/trend on the panel; vol-risk-premium (sell rich realized-vs-implied); on-chain/flow factors. Same discipline: pulse → WF → cost → combine.
