# How Retail-Sized Systematic Traders Actually Make Money, 2024–2026

**Date**: 2026-06-11. Deep web research (5 threads, ~50 searches, ~35 primary sources,
key claims independently re-verified). Companion to practitioner-research.md.

**Headline**: surviving retail edges in 2025–26 are almost all **flow-anchored**
(someone is FORCED to trade: pension rebalancing, fix hedging, forced liquidations,
leverage demand, uncertainty hedging) and **slow** (minutes to days). Fast edges are
structurally captured by firms with queue priority. Everything price-pattern-shaped
the literature has falsified matches our own graveyard.

## Top 5 programs ranked by (edge × testability with our stack ÷ effort)

1. **Turn-of-month US500 + signed month-end FX fix (USDJPY/EURUSD)** — "Dash for Cash"
   program. Etula et al. RFS 2020; ~7.2%/yr, Sharpe ~1.0, in-market ~20% of days
   (futures-level studies). Month-end FX fix eroding (−44% dislocation 2024, T+1
   settlement) — USDJPY is the residual live pair. Days of work, have all data.
2. **FOMC event suite** — vol-gated pre-FOMC drift on US500 (verified alive 2020–24:
   SPY ~4% CAGR, Sharpe 0.5–0.6 on 5% of days; 109bp when implied vol > median vs
   9.7bp below) + post-FOMC gold drift (adjusts >5min after shock, easing-asymmetric,
   IRFA 2024) — sister of our validated gold NFP-momentum. Days of work.
3. **Bybit liquidation-flush mean reversion (1–60min)** — real forced-flow premium
   (Hyperliquid HLP made ~$41.5M in one weekend fading Oct 10 2025); peer-reviewed
   mechanism (JBF 2025); premium partly reserved for backstop liquidators — test
   with our RECORDED depth for slippage. 1–2 weeks; collector already running.
4. **Funding-extreme conditioning** — passive carry compressed to ~2–6% net
   (BIS WP 1087: Sharpe 6.45 full-sample → NEGATIVE 2025; sUSDe ~4–9% 2026;
   46 consecutive days negative funding to Apr 2026). Only the CONDITIONAL version
   (crowding → reversal) is interesting. Days of work, free data.
5. **Crypto VRP measurement on Deribit** — BTC VRP ~14%/yr gross (arXiv 2410.15195,
   stale 2017–22 sample). Measurement project first; needs options P&L engine.
   2–4 weeks.

**Free bonus tests**: Krohn-Mueller-Whelan Tokyo-fix W-pattern USDJPY (JF 2024,
~2bp/leg); post-2020 overnight subsample USTEC/DEU40; CPI-day gold null-check;
METALS BOOK through prop-firm trailing-DD barrier sim (funded account = barrier
option on a strategy; Topstep 2025: 0.71% of Express Funded reach Live).

## Hard skips (with measured evidence)

- OBI/CVD scalping: <10bp signal over 10s vs ~20bp round-trip; OOS Sharpe 0.12 — dead at retail
- Retail CEX market making: Hummingbot liquidity-mining subsidy ENDED 2026-03-16
- Passive DEX LP: bleeds LVR ≈ σ²/8, >$500M/yr to arbitrageurs; majority underperform HODL
- Cross-exchange arb: 3 searchers capture 75% of $233.8M (arXiv 2507.13023); builder integration required
- SPX short-vol/0DTE: audited ceiling = Cboe PUT Sharpe 0.5 < SPX TR 0.6 since 2007 (verified
  Apr 2026 factsheet); retail 0DTE loses 4.7%/trade to spreads; rolling VRP currently NEGATIVE
- PEAD (dead outside microcaps since ~2006), index add/delete (Greenwood-Sammon), LETF
  front-running (2008 artifact), unconditional overnight drift (NY Fed: Sharpe 1.1 gross,
  −0.5 NET), day-of-week (mined)

## Key risk evidence for anything carry/liquidation shaped

Oct 10 2025: $19B liquidated, order-book depth −90%, USDe $0.65 print on Binance, ADL
force-closed PROFITABLE short hedges leaving naked spot. Any basis/carry backtest must
model an ADL haircut on the hedge leg and multi-month negative-funding regimes.

## Prop-firm reality (verified numbers)

Topstep 2025: 16.8% complete Combine, 33.3% of funded get ≥1 payout, 0.71% reach Live.
My Forex Funds (CFTC 8771-23): $310M fees in / $137M out; <100 of 24,000 "live" accounts
had a single profitable trade. CFTC OCE 2024 (36,538 accounts): median loses $100–200,
no learning curve. Business model = fee recycling. One genuine use: simulate METALS BOOK
against trailing-DD barrier → cheap leveraged capital IF the DD profile fits.

(Full source URLs in the research agent transcript; primary ones embedded above.)
