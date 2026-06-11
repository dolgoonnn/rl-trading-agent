# Gold 1m/3m Sweep + CHoCH ("Bullish Traders AI" Reverse-Engineer) — Results

**Date**: 2026-06-10
**Verdict**: **NO EDGE — all 12 configs fail the kill gate decisively.**
**Spec**: `docs/superpowers/specs/2026-06-10-gold-1m-sweep-choch-design.md`

## What was tested

The entry model reverse-engineered from the invite-only "Bullish Traders AI" TradingView
indicator (its bracket math was verified exactly from 6 vendor screenshots: TP1 = 1.5R
partial, TP2 = 4R runner, SL at sweep wick ± buffer):

- Swing pivots (3-bar lookback), most recent unswept swing level as liquidity
- Entry on sweep: wick through the level, close back inside; fill at next bar open
- Bias variants: `choch` (latest BOS/CHoCH must align) and `none` (pure sweep reversal)
- Vendor bracket: 50% off at 1.5R, SL→breakeven, runner to 4R (`--partial-tp "0.5,1.5,0"`, `--target-r 4`)
- SL: sweep wick ± 0.3×ATR(14); session filter 07–21 UTC; cooldown/timeout scaled per TF

**Data**: Dukascopy XAU/USD spot 1m, 2020-01-01 → 2026-06-09, 2,281,968 candles,
0 OHLC errors, spot-checked vs known prices (`data/XAUUSD_1m.json`, `scripts/download-gold-1m.ts`).
Covers COVID, the 2021–2023 chop, and the 2024–2026 bull — no regime cherry-pick.

**Framework**: `scripts/backtest-scalp.ts` with new `--tf` support; walk-forward
~15d train / 5d val / 5d slide (~310 windows), threshold 0 (the vendor model is binary).
Inherits the Phase 2 look-ahead fixes (next-bar-open entry, closed-HTF-bars only).

**Friction context**: XAUUSD spot spread is ~$0.20–0.35 at $2,000–4,200 gold,
i.e. ~0.5–1.5 bps per side. The 0.5 bps level is *charitable* (institutional-grade fill,
zero slippage). 2 bps/side is a realistic retail CFD round trip.

## Results — all 12 configs

| TF | Bias | Friction/side | Trades | WR | Total PnL | Sharpe | MaxDD | WF pass |
|----|------|--------------|--------|-----|-----------|--------|-------|---------|
| 1m | choch | 0.5 bps | 19,512 | 37.5% | −186.4% | −13.5 | 84.6% | 8.3% |
| 1m | choch | 1 bps | 19,512 | 28.5% | −381.5% | −27.7 | 97.8% | 1.0% |
| 1m | choch | 2 bps | 19,512 | 17.4% | −771.7% | −56.1 | 100% | 0.3% |
| 1m | none | 0.5 bps | 37,419 | 37.6% | −342.3% | −13.0 | 96.8% | 5.8% |
| 1m | none | 1 bps | 37,419 | 28.7% | −716.5% | −27.2 | 99.9% | 0.6% |
| 1m | none | 2 bps | 37,419 | 17.4% | −1464.9% | −55.6 | 100% | 0.3% |
| 3m | choch | 0.5 bps | 8,017 | 39.3% | −96.9% | −10.2 | 63.4% | **24.8% (best)** |
| 3m | choch | 1 bps | 8,017 | 35.4% | −177.1% | −18.7 | 83.3% | 14.6% |
| 3m | choch | 2 bps | 8,017 | 25.2% | −337.4% | −35.6 | 96.6% | 2.5% |
| 3m | none | 0.5 bps | 18,147 | 40.5% | −172.0% | −7.9 | 83.0% | 23.2% |
| 3m | none | 1 bps | 18,147 | 36.5% | −353.5% | −16.3 | 97.1% | 9.9% |
| 3m | none | 2 bps | 18,147 | 26.6% | −716.5% | −33.0 | 99.9% | 1.3% |

**Kill gate: WF pass < 40% or negative PnL ⇒ no edge.** Best config (3m/choch/0.5bps)
fails both: 24.8% pass, −96.9% PnL.

## Zero-friction diagnostic

To separate "bad entry" from "good entry killed by costs", the choch configs were
re-run at friction = 0 (impossible in reality — no spread, no fees, no slippage):

| TF | Trades | WR | Total PnL | Sharpe | WF pass |
|----|--------|-----|-----------|--------|---------|
| 1m | 19,512 | 40.7% | +8.8% | 0.64 | 51.8% |
| 3m | 8,017 | 39.6% | −16.7% | −1.77 | 45.5% |

+8.8% across 19,512 trades is +0.00045% per trade — indistinguishable from zero.
**The entry logic itself is a coin flip.** The vendor bracket merely converts a
zero-edge entry into a guaranteed loss at any real spread.

## Why it loses

1. **Risk distances are friction-scale.** Avg hold is ~11–12 bars; SL sits just under a
   1m/3m wick (~0.05–0.15% away). At 1 bp/side, the round trip consumes 13–40% of one R —
   so even a genuinely 50/50 entry bleeds out mechanically.
2. **Win rate sits at the bracket's breakeven before costs.** The 50%@1.5R + 4R-runner
   bracket needs roughly high-30s% WR to break even with the BE-stop give-backs. The
   raw model delivers 37.5–40.5% at near-zero friction — there is no margin for spread.
3. **Friction sensitivity is monotonic and steep**: each friction doubling knocks ~9–11pp
   off win rate (partial TPs at 1.5R stop clearing the spread) — the signature of a
   no-edge system whose PnL is a pure function of costs.

## Comparison with prior experiments

Consistent with `experiments/scalp-phase2-results.md`: no LTF scalp strategy
(ICT 5m, silver bullet, ATR breakout, mean reversion, BB squeeze, session range)
survived once look-ahead bugs were fixed. The vendor's "AI" model is the same
sweep/structure family — and gold's spread-to-volatility profile on 1m makes it
*worse* than the crypto 5m variants, not better.

## Conclusion

The "Bullish Traders AI" entry model, reproduced faithfully (bracket math verified to
the cent against vendor screenshots), has **no edge on 6.5 years of 1m gold data**.
Its marketing screenshots are survivorship: with ~20K signals/year on 1m, dozens of
4R winners occur weekly by chance — that's what gets posted. No optimizer pass was
run: per the spec, parameters are not tuned on a model that can't beat friction.

## Reproduction

```bash
npx tsx scripts/download-gold-1m.ts --from 2020-01-01
npx tsx scripts/backtest-scalp.ts --symbol XAUUSD --strategy sweep_choch \
  --tf 3 --bias-mode choch --friction 0.00005 --threshold 0 \
  --partial-tp "0.5,1.5,0"
```

Raw JSON results: `experiments/runs/gold-sweep-choch/`.
Strategy: `src/lib/scalp/strategies/sweep-choch.ts` (unit tests: `tests/scalp/sweep-choch.test.ts`).
