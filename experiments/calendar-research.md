# Calendar Anomaly Research — Gold ToM + Crypto Hour-of-Day

**Date**: 2026-06-10 (trader-loop iterations)
**Scripts**: `research-gold-events.ts`, `research-calendar.ts` → `runs/gold-events-research.json`, `runs/calendar-research.json`

## Verdicts

| Anomaly | Result | Verdict |
|---|---|---|
| Gold London PM-fix down-drift | −1.59 bps/d into 15:00 London, t=−2.62, regime-stable | ✅ Replicates; below retail friction — futures-tier overlay only |
| Gold intraday momentum (Gao et al.) | follow t=0.25–0.95 | ❌ Does not transfer |
| Gold turn-of-month | +1..+3 days t=3.37 (2016–26) but t=0.39 (2005–15) | ❌ Regime-unstable |
| **Crypto hour-of-day** | **Hour 22 UTC +7.0 bps t=5.40 pooled** (BTC 3.91 / ETH 3.47 / SOL 2.72); hours 13/16/19 negative t≈−2..−3 | ✅ **Candidate** — survives Bonferroni (24 cells), matches pre-2019 literature (time-OOS prior) |

## Crypto hour-of-day detail (2023-02 → 2026-02, pooled 3 symbols, 1h bars)

Significant cells (|t|≥2): +3h(2.49) +8h(2.80) +9h(2.40) +11h(2.20) **+21h(3.67) +22h(5.40)**
−13h(−3.15) −16h(−2.13) −19h(−2.38) −23h(−3.18). DoW: nothing meaningful (Wed +, Thu −, |t|<2.4).

Cross-asset echo of the gold finding: US-session drag + post-US-close drift, in a second
asset class, with an independent published prior (Quantpedia/Baur et al. documented
21:00–23:00 strength pre-2019; in our sample the window tightened to 21–22h, 23h flipped).

**Economics**: 21:00→23:00 long ≈ 11.7 bps/day gross. Taker (5.5 bps/side) → ~0.
Maker/limit (~1 bp/side) → ~9.7 bps/day ≈ 25–35%/yr at 2h/day exposure. Execution-style
dependent, like everything in this family.

**Caveats**: 3 years only, predominantly bull regime; needs longer history (Bybit/Binance
backfill) and the cheap-kill ladder before any sizing talk.

## Strategy test (`research-crypto-session.ts`, 2023-02→2026-02, runs/crypto-session-results.json)

**21:00→23:00 UTC long, 1bp/side (maker):**

| Symbol | Total | Sharpe | MaxDD | Years + | Halves | B&H comparison |
|---|---|---|---|---|---|---|
| BTC | +79.5% | 2.03 | 8.6% | 4/4 | +/+ | B&H +102.7%, Sharpe 0.73, DD 68% |
| ETH | +116.6% | 2.20 | 12.5% | 4/4 | +/+ | B&H +14.5%, Sharpe 0.07, DD 101.5% |
| SOL | +121.8% | 1.55 | 40.9% | 4/4 | +/+ | B&H +121%, Sharpe 0.47, DD 122% |

- Taker (5.5bp/side): negative everywhere → **maker/limit execution mandatory**.
- Gold-style 22→07 overnight is WORSE on crypto (Sharpe 0.4–1.4): the edge concentrates
  in 21–23h. Same phenomenon as gold, asset-specific clock shape.
- ~26%/yr net equal-weight at 2h/day exposure.

## HOLDOUT VERDICT (2020-03 → 2023-02, incl. 2022 bear): ❌ KILLED

`download-crypto-1h-holdout.ts` → `research-crypto-session.ts --holdout`
(`runs/crypto-session-results-holdout.json`):

| Symbol @1bp | Selection 2023–26 | Holdout 2020–23 |
|---|---|---|
| BTC | +79.5%, Sharpe 2.03, 4/4 yrs | +45.9%, Sharpe 0.83, 2/4 yrs (bear half −24%) |
| ETH | +116.6%, Sharpe 2.20 | **−6.4%, Sharpe −0.12** |
| SOL | +121.8%, Sharpe 1.55 | **−86.6%, Sharpe −1.76** |

The pooled t=5.4 was bull-regime beta concentration, not structure. Crypto hour-of-day
drift follows the prevailing trend (matches Mueller 2024: crypto seasonals weak/unstable).
Key contrast: gold's overnight hold SURVIVED its bear-inclusive holdout — it has a
mechanism (fix flows, COMEX close); crypto's hours don't.

**Family closed: crypto time-of-day session holds. Do not revisit without a regime gate
that itself passes a holdout.**
