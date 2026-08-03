# LETF close-flow — event study, strategy, and paper bot

**Date**: 2026-08-03 (overnight autonomous loop). Test 2 of the gold-scalp
deep dig (memory: `gold-scalp-deep-dig-2026-08`, candidate score 55).
Scripts: `research-letf-settlement-flow.ts` (event study),
`research-letf-close-strategy.ts` (no-lookahead rule), `run-letf-bot.ts`
(paper bot) + `build-letf-seed.ts`.

## Mechanism

Leveraged metal ETFs (AGQ/ZSL 2x/-2x silver, UGL/GLL gold) must rebalance
AUM x (L^2-L) x r_day daily — forced, price-insensitive, SAME direction as the
day's move — executed in the final 30-60 min before the 16:00 ET NAV strike
(Todorov RoF 2024; BIS QR Mar-2026 Box C: flow multiplier doubled in 2025,
amplified the Jan-2026 silver crash).

## Event study (spot 1m 2015-2026, $0 — no purchased data)

- **COMEX settle window (13:00-13:30 ET): NO footprint.** First spec tested
  the wrong window; web check confirmed rebalancing prints at the equity
  close, not the futures settle.
- **Close window (15:00-16:00 ET, signal = prior-16:00 -> 15:00 move):**
  top-|move|-decile signed continuation, silver: 2015-19 +0.2bp (nothing) ->
  2020+ +15.2bp (t=2.9) -> 2024+ +30.7bp (t=2.7) -> 2025+ +42.0bp (t=3.1).
  Gold same shape, ~half size. Effect scales with the LETF-AUM regime —
  the causal variable — and is absent pre-boom.
- **Robustness:** survives excluding Jan-Feb 2026 (+14.6bp, t=1.8); 75-86% of
  top-decile events positive (not 5 outliers, though top-5 = 52% of P&L).
  By year: 2024 weak-positive, 2025 flat/negative, 2026 strong (+53bp/event,
  86% hit). Pre-2024 gold close-window was a significant REVERSAL regime
  (t=-5.6 at p90) — the sign flipped when AUM boomed. Regime-flip is the #1
  risk; any deployment needs a trailing kill-switch.

## No-lookahead strategy (rolling 250-day p95 |sig| threshold, 15:00->16:00)

Silver, 4bp RT cost: **2024+ 41 trades, +21.4bp/trade (t=2.2), 66% hit,
~3.9%/yr; bootstrap P(mean<=0)=1.4%.** At 11bp taker: +14.4bp (t=1.5).
p98 variant: 17 trades, +36.5bp (t=2.2), 88% hit. Profitable years align with
leveraged-retail episodes (2020 COVID squeeze, 2021 WSB silver, 2026 LETF
boom); flat-to-negative otherwise. Gold weaker (+10.1bp t=1.7 at p95/4bp).

## Honest status

- ~41-75 qualifying trades since 2024; formal per-obs DSR/PBO gates are
  UNREACHABLE at this sample size. This is a regime-young mechanism signal,
  not a validated edge. **Paper forward record only; no real money.**
- Not orthogonality-checked against the F2F daily model / metals book yet.
- AUM-weighted flow ranking (real ProShares shares x NAV) is the pass-2
  sharpening — current |move| proxy conflates flow size with volatility.

## Paper bot (run-letf-bot.ts)

Silver-only, p95/250d threshold (seeded from history via `build-letf-seed.ts`
-> `scripts/letf-seed.json`, shipped in the image because the Railway volume
shadows /app/data), enter 15:00-15:30 ET window sign(sig), exit 16:00 ET mark,
1 trade/day, 2bp/side paper friction, delay-aware marks (bar timestamps, not
wall clock — Yahoo SI=F feed lags ~10min). **Kill-switch: entries stop when
trailing-20 mean net <= 0** (regime-dependence is the design assumption).
Wired into `docker-entrypoint.sh` as a NON-FATAL 7th process with separate
state (`data/letf-bot-state.json`) — zero impact on session-book attribution.

## Instrument breadth scan (2026-08-03 morning — the "more volume" question)

Volume scales horizontally (more instruments at the tail threshold), never by
lowering the threshold (p90 already dilutes to ~cost; daily trading is
negative). Scan results, same close-anchored event study:

| Instrument | LETF complex | Top-decile V1+V2 | Verdict |
|---|---|---|---|
| Silver | AGQ/ZSL | +15bp t=2.9 (2020+), +42bp t=3.1 (2025+) | **DEPLOYED, full weight** |
| Gold | UGL/GLL | +8.8bp t=3.6 (2020+); strategy +10.1bp t=1.7 | **DEPLOYED, half weight** |
| US500 | SPXL/UPRO/TQQQ-class | +18.9bp t=1.8 (2025+) but top-5 events = 167% of P&L, 55% hit, holdout 0 | NO — too concentrated under \|move\| proxy; revisit with real AUM flow |
| BTC | BITX 2x | −20bp (negative), noise | **DEAD — flow tiny vs $30B/day depth** |

Pattern confirms the mechanism's selection rule: edge ∝ LETF-AUM / market
depth. Silver #1 (why the BIS wrote about it), gold half, index arbed away,
BTC negligible.

**Oil/natgas scan (2026-08-03, Dukascopy CFD 1m 2022+, $0):**

| Instrument | Complex | Top-decile V1+V2 | Verdict |
|---|---|---|---|
| NATGAS | BOIL/KOLD | +18.5bp t=2.0 (2024+), **+33.1bp t=3.3 (2025+)**; 2025 alone +29.8bp t=3.2, 83% hit | **CONFIRMED #2 — but venue-blocked** (no Bybit perp; needs NG/QG futures access) |
| WTI | UCO/SCO | −11..−17bp, 31% hit, 15:00-15:30 leg t=−2.3 | NO — REVERTS (CL settles 14:30 ET; 16:00-strike mechanism doesn't map). Fade signature noted, not pursued (sign-flip fishing risk) |

Cross-instrument confirmation is the headline: natgas's strong year is 2025,
silver's is 2026 — each matching its OWN complex's AUM boom, not one shared
lucky window. The mechanism generalizes; the venue list is the constraint.
Natgas joins the futures-access decision (same door as MGC/prop), not the
Bybit bot.

## Pass 2 — real AUM flow ranking (2026-08-03, ProShares official CSVs, $0)

Daily NAV/SO/AUM back to 2008-12 for AGQ/ZSL/UGL/GLL from
accounts.profunds.com (data/proshares/). Signal: lagged-AUM x (L^2-L) x sig,
with (L^2-L)=2 for 2x and 6 for -2x (inverse funds rebalance 3x harder per
dollar). Script: research-letf-aum-flow.ts.

- **Mechanism CONFIRMED a third way:** the dollar-flow threshold finds the
  SAME profitable episodes across eras — silver >=$50M flow days in the
  pre-boom years (2020-23) were +11.6bp/trade (n=42) in exactly the years
  where the |sig|-only rule bled (2022: -0.4bp, 2023: -8.7bp under p95).
  Conditioning on the causal variable fixes year-consistency.
- **But as a live rule upgrade: NO WIN in 2024+.** Flow-ranked and
  sig-ranked top deciles coincide (silver +19.8 vs +20.5bp; gold flow-rank
  is WORSE, +10.0 vs +14.5bp t=3.3) because AUM is now uniformly high — the
  rankings only diverge when AUM varies, i.e., across eras, not within the
  current one. Deployed p95-|sig| rule STANDS (silver 2024+: n=53, +15.9bp,
  t=2.0 — the no-lookahead benchmark).
- **Actionable residue:** an AUM floor (e.g., silver complex 2xAUM_AGQ +
  6xAUM_ZSL < ~$1B for N weeks) is a LEADING regime-exit indicator — the
  P&L kill-switch is lagging; the AUM print is the mechanism's fuel gauge.
  Future bot enhancement: weekly poll of the ProShares CSV as a
  regime-health check. US500 rescue via SPXL/UPRO/TQQQ-complex AUM remains
  untested (many funds; only worth it if metals forward record confirms).

## Next steps (owner decisions)

1. Review + `deploy` the branch to put the paper leg on Railway.
2. Pass-2: real AUM flow series (ProShares daily shares outstanding x NAV) to
   replace the |move| proxy; re-rank events by computed flow.
3. Orthogonality check vs deployed gold sleeves before it ever joins the book.
4. Revisit formal validation once ~100+ forward/paper events exist.
