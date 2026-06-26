# US500 overnight-drift SYSTEM — real direction, sub-threshold (2026-06-26)

Systems-loop test of the documented equity-index overnight anomaly (Cooper-Cliff-Gulen;
Lou-Polk-Skouras "A Tug of War" 2019): index returns accrue overnight (close→open), the
intraday session drifts flat/negative. Mechanism = overnight risk premium + open-auction
order flow. `scripts/us500-overnight-system.ts`, US cash session 09:30-16:00 ET (DST-aware),
US500_1m 2015-2026, chronological split IS 2015-20 / OOS 2021-26.

## Result (net of cost)
| | overnight-long gross | overnight-long NET @1bp/side | intraday-long gross |
|---|---|---|---|
| IS 2015-20 | 2.68bp t=1.3 | 0.68bp, Sharpe 0.13 | 1.26bp t=0.6 |
| OOS 2021-26 | 2.66bp t=1.6 | 0.66bp, Sharpe 0.17 | 2.04bp t=0.9 |

- **Overnight drift is real and consistent** (gross ~2.67bp/day in BOTH periods ≈ most of the
  equity premium concentrated overnight — matches literature) — but **noisy (t≈1.3-1.6, not
  significant) and sub-threshold net**: Sharpe ~0.15 at 1bp/side, NEGATIVE at 2bp/side.
- **Intraday is NOT cleanly negative** here (positive but smaller) → the L/S "tug-of-war" is
  net-negative everywhere (−2.6 to −3.4bp), killed by 4 transitions/day of turnover cost.
- Weaker than the famous studies = documented post-2015 anomaly decay + CFD/futures-proxy
  open/close prints + honest cost. Same story as everything: real mechanism, below the frontier.

## VERDICT — not deployable standalone
Overnight drift exists and is IS/OOS-consistent in direction, but net Sharpe ~0.15 (1bp) /
negative (2bp) is below the deployment bar. Could only matter as a tiny ρ≈0 diversifier, and
even that turns negative at realistic equity-CFD cost — not worth a sleeve. Another systems
mechanism that is real but sits at/below the retail cost frontier.
