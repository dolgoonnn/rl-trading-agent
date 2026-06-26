# Gold scalp/intraday scorecard — definitive (2026-06-26)

**Question:** does ANY scalp/intraday strategy win on gold? Run the non-ICT statistical
scalp sandbox on `XAUUSD_1m` (gold spot, 2.28M 1m candles, 2020–2026 IS; a true
2015–2019 OOS holdout exists in `XAUUSD_1m_holdout.json`). ICT-directional intraday
gold is the CLOSED book (40+ nulls, "do not re-test") — excluded.

**Harness:** `scripts/backtest-scalp.ts --symbol XAUUSD --strategy <s>` (1m→5m aggregate,
walk-forward). Friction 2bps/side (≈4bps round-trip — realistic-to-generous for retail
XAUUSD spreads).

## NET (friction 2bps/side), IS 2020–2026

| strategy | trades | total PnL | Sharpe | WF pass |
|---|---|---|---|---|
| mean_reversion | 3002 | **−117.4%** | −16.48 | 27.2% |
| bb_squeeze | 200 | −8.7% | −19.71 | 39.9% |
| atr_breakout | 553 | −18.8% | −11.20 | 40.6% |
| session_range | 570 | −0.6% | −0.24 | 43.1% |
| silver_bullet | 580 | −19.9% | −16.09 | 34.0% |

**All five net-negative; all WF pass < 50% (bar is 60%).** None earns an OOS holdout test.

## GROSS (zero friction) — locating WHERE each dies

| strategy | gross PnL | gross Sharpe | gross WF | read |
|---|---|---|---|---|
| mean_reversion | +2.7% (3002 tr) | 0.37 | 47.4% | **no edge even gross** (~0.0009%/trade = noise). The "gold ranges intraday" hypothesis fails at the signal level. |
| session_range | +22.2% (570 tr) | **8.78** | 49.3% | **real gross edge** (~0.039%/trade) but ≈ the 4bps round-trip cost → 100% eaten (net −0.6%); not WF-robust even gross. Execution-frontier edge. |

## Verdict — NO gold scalp/intraday winner

Gold intraday dies **two** ways, both fatal:
1. **No gross signal** (mean_reversion, the live hypothesis) — gold's intraday ranging is not exploitable directionally on candles.
2. **Gross signal entirely consumed by spread** (session_range, gross Sharpe 8.78 → net −0.6%) — same execution-frontier story as crypto intraday (reversal/lead-lag/order-flow). Even at a tight 1.5bps/side, session_range is ~breakeven and only 49% WF-robust → not deployable.

**Consistent with the project-wide law:** the short-horizon edge is execution/microstructure (here: gold's session-range structure is *real* but below the retail-spread frontier), not a tradeable candle signal. Gold candles carry no order-flow (spot metals = no centralized taker volume), so even the microstructure proxy that crypto allows is unavailable for gold.

**The only gold edge that survives is SESSION/SWING horizon** (overnight hold + fix-short = the METALS BOOK, ~17%/yr deployable) — NOT intraday. Do not pursue gold scalp/intraday further; the answer is the cost/execution frontier.

---

# DEEP ANALYSIS — gold intraday loop ("find one, no false hope") — 2026-06-26

Ran the full research→implement→improve→notes loop on gold scalp/intraday, depth-first, with the untouched **2015–2019 holdout** as the OOS test.

## Research — `scripts/gold-intraday-diagnostic.ts` (XAUUSD 1m→hourly, 2020–26)
- **Gold intraday is ~a random walk:** lag-1 hourly autocorrelation = **−0.009** (≈0) → no systematic intraday trend OR reversion. (Explains why mean_reversion had no gross edge.)
- **Hour-of-day drift:** real but tiny (~1bp/hr; hr-23 Sharpe 5.45, hr-1 3.77) — far below the ~4bp cost frontier; 24-hours-tested invites mining. Not tradeable.
- **Asian-range (00–07 UTC) breakout:** the strongest structure — post-break continuation **+4.79bp/break, Sharpe 0.055/day (~0.87 ann gross)**. Direction 50/50 (edge is magnitude, not hit-rate). The ONE candidate worth deep analysis.

## Implement + OOS — `scripts/gold-session-breakout.ts` (clean, ≤1 trade/day, 4bp RT cost)
| set | n | grossBp | netBp | gross Sharpe | net Sharpe | netTotal% |
|---|---|---|---|---|---|---|
| IS 2020–26 | 1614 | 4.97 | **+0.97** | 0.93 | 0.18 | +10.3% |
| **OOS 2015–19** | 1266 | 2.67 | **−1.33** | 0.66 | **−0.33** | **−17.7%** |

IS marginally positive (the screening illusion); **OOS negative**. Gross edge *decayed* 4.97→2.67bp OOS (below cost).

## Improve — 4 a-priori principled variants (judged on OOS, holdout touched minimally)
| variant | OOS netBp | OOS net Sharpe |
|---|---|---|
| baseline hold-to-close | −1.33 | −0.33 |
| target 1R | −2.32 | −0.71 |
| London-only window | −3.06 | −1.78 |
| stop 0.5R | −3.33 | −1.20 |
| target+stop bracket | −2.96 | −1.11 |

**Every refinement made it worse.** The most diffuse version (baseline) was least-bad — the textbook signature of fitting NOISE, not refining an edge.

## VERDICT — DEAD (no false hope)
The single best gold-intraday candidate is **marginally positive in-sample, negative out-of-sample, and degrades under every principled refinement.** There is **no gold scalp/intraday winner** — now proven on a real 5-year OOS holdout, not assumed. Gold's intraday is a random walk; its only edge is session/swing (overnight + fix-short, the METALS BOOK). Closing gold intraday for good.
