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
