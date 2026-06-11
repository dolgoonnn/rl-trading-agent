# How Real Intraday Traders Actually Make Money — Practitioner Research

**Date**: 2026-06-11 (trader loop) · Sources: prop-firm industry data, SMB/Trillium practitioner record

## The base rates (the part X threads never show)

- 5–10% pass prop-firm challenges; **~7% of 300,000 funded accounts ever received a payout**
  (FPFX Tech data via Finance Magnates); average earnings of those ≈4% of allocated capital.
- The visible "profitable scalpers" on X are the survivors of a ~1-in-15 to 1-in-30 funnel,
  plus unverifiable claims. Survivorship is the product being sold.

## What the successful minority actually does (3 pillars)

1. **Instrument selection >> setups** (Breitstein/SMB: "99.9% of tickers are noise") —
   the edge is WHICH instrument is in play that day (catalyst, theme, abnormal relative
   volume), not the pattern on the chart. A chart alone is not a setup.
2. **Microstructure execution** — tape/DOM/order-flow imbalances, 1–4 tick targets,
   30–100 trades/day, economics dominated by commissions and queue position. This is a
   DATA class (L2/prints), not a candle technique.
3. **Process discipline** — playbooking, post-trade review, cutting counter-momentum
   trades. Meta-skill, not signal.

## Mapping to this repo's measured results

- Their pillar 1 = why the ORB "in-play" gate works on equities and why nothing works on
  always-the-same-instrument gold candles. Gold is never "in play" by selection — you
  can't select it; you can only time it (which is exactly our surviving edge family).
- Their pillar 2 = the domain our 12 nulls never touched: candles cannot see pending
  intent, queue dynamics, or aggressive flow. Tape edges are invisible in OHLCV by
  construction.
- Their pillar 3 = `experiments/KNOWLEDGE.md` — we already run their review process,
  mechanically.

## Actionable directions (only if pursued deliberately)

1. **Crypto order-flow**: Bybit exposes free L2/trade streams — the one venue where
   microstructure data costs nothing. An orderbook-imbalance study on BTC would be this
   repo's first pillar-2 experiment (taker fees remain the enemy).
2. **Catalyst-day selection** on equities (in-play scanning) — out of current scope/data.
3. Keep systematizing pillar-1-for-macro: our time/mechanism windows ARE "knowing when
   your instrument is in play" — the metals book and EUR legs are that, formalized.

**Bottom line**: real profitable intraday humans exist (~7% of funded attempts), and they
monetize selection, microstructure, and discipline — none of which is chart-pattern
reading. Our nulls and their practice agree with each other.
