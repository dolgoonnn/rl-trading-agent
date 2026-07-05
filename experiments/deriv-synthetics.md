# Deriv Synthetic Indices — Bot Simulation (CLOSED, null)

**Date:** 2026-06-29
**Question:** Can our deployed bots (ICT order-block confluence + scalp `ict_5m`) make money on Deriv synthetic indices (Boom/Crash, Volatility)?
**Answer:** No. Every bot fails on every synthetic, at every friction level. These are RNG martingales with no order-flow mechanism — the exact process class our research framework predicts pattern strategies cannot beat. **Do not deploy or re-test.**

---

## What Deriv synthetics are

Audited RNG processes, **not markets**. No order flow, no liquidity, no institutions, no volume.

| Family | Symbols | Process | Structural feature |
|---|---|---|---|
| Volatility | `R_25` `R_75` `R_100` | Constant-vol GBM (martingale) | None — symmetric, zero autocorrelation |
| Spike (Boom) | `BOOM500` `BOOM1000` | Drift down + Poisson up-spike (~1 / 500 or 1000 ticks) | Positive skew (up-spikes) |
| Spike (Crash) | `CRASH500` `CRASH1000` | Drift up + Poisson down-spike | Negative skew (down-spikes) |

The house edge lives in the **spread**; the price processes are calibrated to ~zero EV net of cost.

## Tooling built (reusable)

- `src/lib/deriv/downloader.ts` — Deriv WebSocket `ticks_history` (style:candles), backward pagination, public app_id 1089, no auth. Synthetics have **no volume** → set `volume = 1` uniform so VWAP/volume-ratio degenerate to neutral/price-only instead of NaN (injects no information).
- `scripts/download-deriv-data.ts` — CLI → `data/{SYMBOL}_{tf}.json` (matches `Candle[]`, drops straight into existing harnesses).
- `scripts/deriv-null-test.ts` — autocorrelation / drift / skew falsification.

**Data retention:** 1h capped at exactly **1 year** (8,761 candles); 1m goes back ~10+ weeks. Data is pristine (0 gaps, 0 OHLC errors). Trades 24/7.

---

## Step 1 — Null test (1h, the falsification gate)

```
symbol         annRet%  annVol%  Sharpe   skew  exKurt   ac1     ac2     ac3     ac5    ac10
BOOM500          25.8     30.8    0.84    0.59    0.4   +0.003  +0.000  +0.006  +0.001  -0.007
CRASH500        -10.1     30.4   -0.33   -0.53    0.2   -0.011  -0.004  -0.014  -0.022* -0.007
BOOM1000         -9.8     21.3   -0.46    0.74    0.6   -0.020  -0.018  -0.001  +0.012  -0.007
CRASH1000        10.9     21.6    0.51   -0.74    0.6   +0.003  +0.000  +0.001  +0.004  -0.002
R_25             -7.6     24.8   -0.30    0.07    0.0   -0.012  +0.036* +0.024* -0.005  -0.012
R_75            -66.2     74.6   -0.89   -0.01    0.0   -0.006  +0.017  +0.008  -0.017  +0.005
R_100          -145.7     99.5   -1.46   -0.01   -0.1   +0.001  +0.000  +0.014  -0.005  -0.002
```
\* = exceeds 2/√N ≈ 0.021 noise band.

- **Autocorrelation ≈ 0 at all lags, all symbols.** The 3 marked values out of 35 are the ~5% expected false positives. **No serial dependence → no timing edge is mathematically possible** (same wall as gold intraday, autocorr ≈ −0.009).
- **Skew confirms the design:** Boom +, Crash −, GBM ≈ 0. Real distributional asymmetry — but you cannot predict *when* the spike comes, so it is not a timing signal.
- **Drift is just the realized single-path random walk** (R_100 −145%/yr is pure −σ²/2 volatility drag at 99% vol). No stable predictable drift.

The null test alone closes the question. We ran the bots anyway to demonstrate it.

## Step 2 — ICT confluence bot (deployed Run 20 config), 1h

| Variant | Trades | WR | PnL | WF pass | Verdict |
|---|---|---|---|---|---|
| All 7, friction 7bp (crypto level) | 250 | 39.6% | **−72.9%** | 47.3% | FAIL |
| All 7, **friction 0** (coin-flip test) | 250 | 39.6% | **−61.9%** | 47.3% | FAIL |
| Boom/Crash only | 288 | 31.9% | −54.3% | 26.5% | FAIL |
| GBM nulls only | 562 | 29.5% | −85.1% | 33.3% | FAIL |

**Same config on crypto: 69.7% WF, +1573% PnL.** On Deriv the edge fully evaporates. It loses **even at zero friction** → the ICT entry is worse than a coin flip given the R:R. The structural Boom/Crash does **no better** than the pure-GBM nulls — the spike asymmetry gives a directional pattern strategy zero advantage (the rare violent spikes mostly just blow through stops).

## Step 3 — Scalp `ict_5m` bot, 5m (aggregated from 1m)

| Group | Trades | WR | PnL | Sharpe | WF pass | Verdict |
|---|---|---|---|---|---|---|
| Boom/Crash | 376 | 29.8% | −39.7% | −49.81 | **2.9%** | FAIL |
| GBM nulls | 43 | 30.2% | −6.8% | −37.10 | 20.0% | FAIL |

Total wipeout — consistent with `ict_5m` already having negative edge on crypto (`leverage-liquidation-sweep`).

---

## Conclusion

Deriv synthetics are the **purest possible instance of the trap in `edge-source-vs-signal-hunting`**: OHLC patterns on a process with no underlying mechanism. It is *strictly worse* than real markets — mechanism-free, the counterparty defines the parameters, and EV is calibrated negative net of spread. The one real structural feature (Boom/Crash jump asymmetry) is a distribution shape, not a timing edge, and helps the bots not at all.

**This is a successful falsification, not a failure — the bots dying on RNG is validation working.**

**Do NOT re-test Deriv synthetics with pattern/param strategies.** The only thing here that was ever non-trivial — the spike asymmetry — is now checked and dead for directional bots. Tooling is kept for any future *mechanism* question (e.g. options/volatility structure), not signal hunting.

---

## Addendum — "think like a real trader": spike structure + Monte Carlo (2026-06-29)

Reframed from *prediction* to *trading* (a profitable discretionary spike-rider manages risk, doesn't predict). Tools: `scripts/deriv-spike-analysis.ts` (hazard + drift), `scripts/deriv-spike-rider-mc.ts` (R-multiple extraction + bootstrap equity curves with proper intrabar OHLC fills).

**Spike timing is memoryless.** Empirical hazard P(spike at gap k | survived to k) is FLAT for all Boom/Crash (BOOM500 ≈0.11, BOOM1000 ≈0.06 at every k). The "overdue entry" EV test is flat (−2.5 to −2.7 bp/trade independent of bars-since-spike). The most common retail thesis — "wait, the spike is due" — is empirically false.

**It is a fair martingale before cost.** Full-direction close-to-close drift = −0.01 to +0.02 bp/bar ≈ 0 (the down-drift on Boom exactly offsets the up-spikes). Buy-and-hold (no barriers) MC: EV = **−0.002R ≈ 0** → confirmed fair coin minus spread.

**Tight stops convert the fair game into a big loser (counterintuitive, important):** the positive expectation lives entirely in rare spikes, so a tight stop guarantees you are shaken out by the drift before the spike that makes you whole.
| Spike-rider config (long Boom / short Crash, 1% risk) | EV/trade |
|---|---|
| No stop (buy & hold) | −0.002R (≈ −spread) |
| Wide stop 20R + TP 3R | −0.11R |
| Tight stop 1R + TP 3R (textbook "discipline") | −0.87R |
| Tight stop 1R + TP 30R | −0.58R |

**Monte Carlo (bootstrap, 20k sims, 1% risk):** positive skew (+1 to +3) ⇒ median path DOWN while a minority catch enough spikes to be up.
- Buy-and-hold ceiling: P(up) 11–15% @250 trades → 1% @1250 → 0% @5000; equity just bleeds the spread (median 0.88–0.90× after 5000, max DD ~10%).
- Kindest active (wide stop): P(up) 1–6% @250, P(ruin) 42–98% @1250, 100% @5000.
- Tight stop: ruin within ~250 trades.

**Conclusion on a "profitable brother":** a real, disciplined spike-rider sits in the **shrinking lucky minority** of a positive-skew, ≈zero-EV (minus spread) lottery. It is variance + discipline, not a repeatable edge; P(up) decays toward 0 with trade count and the spread guarantees the population bleeds down. Survivable only while withdrawing aggressively and never martingaling. The one genuinely actionable, data-backed (and anti-guru) finding: **on Boom/Crash, tight stops are the worst choice — wide/no stop is strictly less-bad.** Real edge still requires a real mechanism → Deriv MT5 real-market CFDs, not synthetics.

---

## Addendum 2 — reverse-engineering his actual setup from 49 trade screenshots (2026-06-29)

Screenshots revealed: M1, a **GMMA multi-EMA ribbon + trigger line + ADX-ish oscillator**, traded WITH trend across Vol/Step/Boom/Crash/Jump **and XAUUSD (gold)**, scaling in, with stops. The **History tab is the honest ledger**: 20k→30.5k (+52%) **dominated by 3 gold sell trades (+3,030/+2,718/+3,158 ≈ 85% of all profit)** with real losers (−1,668, −238). → trend-following positive-skew; the money is on the REAL market (gold), not synthetics.

Built `scripts/backtest-ribbon.ts` (GMMA fast[3,5,8,10,12,15]/slow[30,35,40,45,50,60], ADX/ATR, chandelier-trailing + ribbon-flip exit, `--slip` gap model). Results:
- **Synthetics looked hugely +EV (Boom1000 +2834R) — a FILL ARTIFACT.** Tell: pure-GBM R_75/R_100 correctly showed ≈0 while only the *spike* instruments showed fake profit. With realistic spike-gap slippage (`--slip 1`, a synthetic spike jumps THROUGH the stop) they invert to deeply negative (−3182R). Confirms martingale: no edge.
- **Gold M1: the mechanical ribbon LOSES** (−464R at slip=0, negative every quartile, 2,713 trades ≈13/day vs his ~15 selective). Param sweep: tunable only to a marginal +9.9R by overfiltering (ADX≥40, best of 12 configs) = overfit, not edge.
- **Gold M1 is a random walk** (autocorr ac1..10 all ≈0 within noise; kurtosis 82 = fat tails) → mechanical trend-following structurally hopeless (matches [[gold-intraday-closed]]).
- **11-yr gold 1h durability: ribbon negative** (−70R, PF 0.94); only the most-recent quartile (+34.5R) is positive = the **2026 gold-bull regime**, i.e. regime luck.

**Verdict: the indicators are NOT the edge — they are lagging decoration that mechanically LOSES on gold and synthetics.** His real P&L = discretionary trade selection (a human whipsaw-filter the ADX can't replicate) + holding a few big winners (tail capture) + the 2026 gold trend regime + risk discipline. **Not reverse-engineerable into a copyable mechanical system** — the profitable part is judgment on a near-random process, not a parameter set. Copyable parts are *process* (trade-with-trend, cut losers, ride/scale winners, real markets > synthetics, higher TF > M1), not signal.

---

## Addendum 3 — decoding his ACTUAL entry method: fade-the-extension + ride (2026-06-29)

Re-read the 49 screenshots by **entry LOCATION** (not just indicators) and found the first reconstruction used the wrong entry side. He is **not** a continuation/trend-flip trader — he is a **reversal-at-extension** trader: sell the up-spike exhaustion as the fast line rolls over (Vol/Step/gold tops), buy the down-flush as it turns up (Vol75 V-bottom +718 w/ SL just below), buy dips on Boom / sell rallies on Crash (positioned for the next spike). Entry = mean-reversion at a stretch; exit = momentum ride (trail the winner). This is what creates the positive-skew "few big winners" profile.

Added a faithful `--mode fade` to `backtest-ribbon.ts`: enter the reversal when price is ≥`ext`×ATR from the slow-ribbon centre AND the close ticks back toward it; ride via chandelier trail. **Result is the cleanest random-walk proof yet** — as the extension filter widens (fade only deeper flushes), gold M1 **converges monotonically to break-even-minus-spread**:

| ext (ATR from ribbon) | trades | winRate | totalR | avgR | PF |
|---|---|---|---|---|---|
| 2.0 | 5370 | 32.7% | −245.5 | −0.046 | 0.93 |
| 2.5 | 4551 | 32.7% | −124.9 | −0.027 | 0.96 |
| 3.0 | 3463 | 32.9% | −28.2 | −0.008 | 0.99 |
| 3.5 | 2470 | 33.4% | **−5.0** | **−0.002** | **1.00** |

Positive skew IS present (4.13 at ext 2.5) — the method genuinely produces the rare-big-winner shape — but the **mean is zero**. The fade entry has no statistical edge on a random walk; widening the filter just removes trades and the EV asymptotes to −spread. Quartiles flip sign (Q1/Q2 + , Q3/Q4 −) = regime noise. Synthetics under fade + realistic spike-gap slip: BOOM1000 −1603R (avgR −0.523, every quartile negative) — martingale, worse than gold.

**Sharper verdict:** his exact entry *recipe*, mechanized, is a zero-EV positive-skew lottery on gold M1. The profit is therefore located entirely in the parts a backtest can't hold: **(1) which stretch he chooses to fade** (he takes ~15 of the ~4500 the machine takes — extreme selectivity at confluence/regime), **(2) holding the one monster** (tail capture), **(3) the 2026 gold uptrend**, **(4) sizing/scale-in/withdrawal discipline**. The indicators are a *framework for attention*, not a signal generator. Learnable = the process + discretionary rep-building (journal real-market fade-and-ride on higher TF), not the parameter set.
