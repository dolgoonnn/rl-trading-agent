# Execution feasibility audit — session book + combined portfolio

**Date**: 2026-06-11
**Scripts**: `scripts/audit-leg-friction.ts` (friction ladder, emits `sessionBookRetail`)
**Research**: web agent, June 2026 prices/fees (MGC/SIL/MES specs, Bybit live order books)

## Venue verdicts vs backtest assumptions

| Instrument | Assumed bp/side | Realistic bp/side (venue) | Verdict |
|---|---|---|---|
| Gold | 0.30 | **0.45–0.55** (CME MGC, $0.60 comm + 1–2 tick spread on $41.6k notional) | assumption FAILS — re-priced below |
| Silver | 1.0 | **1.0 fix window / 2.0 overnight** (CME SIL — thin, 20–25k/day; new %-based margin ≈ $4–7k) | overnight FAILS at 1bp — re-priced |
| US500 | 0.5 | **~0.5** (CME MES; both timestamps are peak liquidity) | PASS borderline |
| EURUSD | 0.15 | **0.35 London / 0.6–1.2 at 22:00 UTC rollover** (raw-spread ECN; commission alone = 0.26bp) | FAILS — morning leg re-priced, 22h leg dead |
| Crypto perps | 7.0 | 5.5–6.5 taker (Bybit non-VIP) | PASS — assumption conservative |
| XAUT (F2F bot) | 5.0 | **10.2 spot / 3.2 maker perp** (Bybit) | spot FAILS — switch F2F bot to perp maker or accept ~half the thin edge |

Capital: MGC + MES fine at $25k (margins ~$2k each). SIL needs ~$50k/contract
after the 2026 percentage-based margin change. EURUSD 1 lot ≈ $3.8k margin at 30:1.

## Friction ladder (re-run at researched costs)

Breakeven = avg gross return per active day ÷ 2 (the per-side cost that zeroes the leg).

| Leg | breakeven bp/side | validated Sharpe | venue-realistic Sharpe | pessimistic Sharpe | verdict |
|---|---|---|---|---|---|
| A: Au overnight | 2.28 | 1.21 | 1.06 (0.55bp) | 0.91 (0.8bp) | PASS |
| B: Ag overnight | 3.60 | 0.81 | 0.50 (2.0bp) | 0.34 (2.5bp) | PASS |
| C: Au fix-short | 0.79 | 0.48 | 0.33 (0.45bp) | −0.01 (0.8bp) | PASS (thin) |
| D: Au AM-fix long | 0.49 | 0.35 | 0.07 (0.45bp) | −0.58 (0.8bp) | MARGINAL — cut |
| I: Ag own-fix short | 1.98 | 0.92 | 0.92 (1.0bp) | 0.45 (1.5bp) | PASS |
| F: Au NFP-mom | 3.57 | 1.69 | 1.61 (0.45bp) | 1.43 (0.8bp) | PASS |
| J: US500 overnight | 1.32 | 0.37 | 0.37 (0.5bp) | 0.23 (0.8bp) | PASS (thin) |
| K: EUR morning short | 0.85 | 1.25 | 0.90 (0.35bp) | 0.63 (0.5bp) | PASS |
| L: EUR h22 long | **0.29** | 0.95 | **−4.04 (0.9bp)** | −8.04 | **FAIL — cut** |

Deployable book (PASS legs at venue-realistic costs): **standalone Sharpe 1.27,
+237.7%** (vs 1.6/+317% at validated friction).

## Combined portfolio at realistic costs (Universe C)

crypto (Bybit, costs already realistic) + sessionBookRetail + f2f:
**handcraft + DM + 12% vol target → 37.2%/yr, Sharpe 2.53, 11.7% maxDD —
5/5 stress gates** (bootstrap, skip-days, ρ-stress to 0.5, tail coincidence,
DSR 2.16). This is the deployment number.

## RESOLVED (2026-06-11) — re-anchor done, numbers below superseded by remeasure

`remeasure-anchor.ts` + `analyze-combo-portfolio.ts` now use the 18:05 ET
DST-aware anchor. Gold overnight 1.09→0.85, silver 0.81→0.59 (validated
friction). Silver overnight at venue-realistic 2bp → Sharpe 0.27 = MARGINAL,
out of the deployable set (still paper-traded). Deployable book is now 6 legs
(A, C, I, F, J, K), standalone Sharpe 1.34; combined book 36.7%/yr, Sharpe
2.46, 5/5 gates. The paper bot (`run-metals-bot.ts`) books venue-realistic
per-leg friction and trades all surviving legs + marginal silver overnight.

## Original finding — the 22:00 UTC entry was partially fictional

CME maintenance break is 17:00–18:00 ET daily: **22:00–23:00 UTC in winter
(market CLOSED at our entry timestamp), 21:00–22:00 UTC in summer (entry lands
on the reopen minute — widest spreads of the day)**. Same hour kills retail
spot metals quotes and is the FX rollover dead zone. The overnight legs (A, B)
were backtested with fills at 22:01 UTC year-round.

**Required before deployment**: re-run `extractTrades` for legs A/B anchored to
18:05 ET (DST-aware) instead of 22:01 UTC, and EUR legs offset 10min from
rollover. Expectation: small effect on the edge (the overnight drift mechanism
doesn't care about 5–65 min of anchor shift) but it must be measured, not
assumed. The venue-realistic friction tier (0.55bp gold incl. overnight
spread) already prices the wider reopen spread.

## Recommended live structure

| Sleeve | Venue | Cost basis |
|---|---|---|
| crypto OB (Run 20) | Bybit perps (existing bot) | 7bp/side assumed ≥ 5.5–6.5 actual |
| Au overnight + fix-short + NFP | CME MGC via discount FCM | 0.45–0.55bp/side |
| Ag overnight + own-fix short | CME SIL (needs ~$50k allocation) | 1–2bp/side |
| US500 overnight | CME MES | 0.5bp/side |
| EUR morning short | raw-spread ECN (IC/Pepperstone tier) | 0.35bp/side |
| F2F gold | Bybit XAUT **perp, maker entries** | ~3.2bp/side (NOT spot at 10bp) |

Minimum sensible total: ~$100k ($50k SIL + $25k MGC/MES margin pool + crypto).
Below that, drop the silver legs and re-run the book.
