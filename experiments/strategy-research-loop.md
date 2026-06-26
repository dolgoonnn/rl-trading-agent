# Strategy Research Loop — research → implement → improve → notes

**Started:** 2026-06-26 · **Branch:** `ftr/strategy-research-loop`
**Mandate:** open-minded but rigorous. Find & TEST strategies (not just "edges"); combine if useful. Each candidate gets a cheap *pulse check* (does it have a gross signal? does it survive cost?) BEFORE any full build. Kill fast, honestly.

**The reframe that justifies this loop:** the project tested **single-asset OHLC patterns** to exhaustion (~230 experiments, all signal families dead) and proved scalp/intraday OHLC dies to costs + low SNR. But it never systematically tested **relative-value / cross-sectional / mechanism-harvest** families — a structurally different space. That's where open-minded search belongs.

---

## Candidate backlog (priors + project-fit + sources)

| # | Candidate | Family | Intraday fit | Prior (lit) | Survives-cost risk | Status |
|---|---|---|---|---|---|---|
| 1 | Cross-sectional short-term **reversal** (long losers/short winners) | relative-value | high | strong (CO-OC reversal "robust") | HIGH (turnover) | ❌ **KILLED** (iter 1) |
| 2 | **Funding-carry delta-neutral** (collect funding, market-neutral) | mechanism harvest | n/a (carry) | strong: 10–20% APY, 0.8% maxDD 2025 | LOW | ⏳ NEXT |
| 3 | **Stat-arb cointegration pairs** (spread mean-reversion, multi-day hold) | relative-value | med | Fil/Kristoufek 30%/yr; intraday HF variants | MED (longer hold = lower turnover) | queued |
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

## Next (iteration 2): Funding-carry delta-neutral

**Why promoted to #1:** it's a *strategy*, not a chart edge — a structural **carry** (collect perp funding while spot-hedged), market-neutral, documented persistent (10–20% APY, ~0.8% maxDD in 2025), and it **combines** with the directional swing book as an uncorrelated sleeve (exactly the "combine if needed" mandate). The project already has a `funding-arb-engine` (bot) and `data/*_futures_1h.json` funding history — testable now.

**Pulse plan:** load `data/{BTC,ETH,SOL}USDT_futures_1h.json` funding series → simulate delta-neutral carry (long spot / short perp, or vice-versa by funding sign) → net of taker/maker fees + rebalance → report APY, maxDD, % months positive, and **correlation to the Run-20 book** (the real value is ρ≈0 diversification). Honest cost modeling (the carry is small per-period; fees can eat it — same discipline as everything else).

Then iter 3+: stat-arb pairs (multi-day hold to dodge the turnover wall), lead-lag pulse. Combine survivors into the book.
