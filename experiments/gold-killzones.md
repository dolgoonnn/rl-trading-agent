# ICT Kill Zones on Gold — Measured Null (11.4 years, n=2,950 days)

**Date**: 2026-06-11 · **Script**: `research-gold-killzones.ts` · NY-clock, DST-aware
**Verdict**: ❌ NO directional information in any kill zone, unconditional or conditional.

| Claim | Test | Result |
|---|---|---|
| KZ directional drift | Asian/LondonKZ/NYKZ/SB windows × split halves | all \|t\|<2.2, signs flip between halves |
| "NY continues London" | sign(LondonKZ ret) → NYKZ ret, n=2,949 | t=0.75, flips across halves |
| "London fades Asia" | sign(Asian) → LondonKZ | t=1.54, flips |
| **Judas swing** | London KZ wicks Asian extreme & closes back inside → fade to 17:00 ET, **n=1,205** | **mean −0.33bps, t=−0.15, WR 49.6%** |
| Silver Bullet (10–11 ET) | unconditional + conditional on NYKZ | t≤0.86 |

Kill zones ARE high-volatility windows (why `killZoneActive` worked as a confluence
factor in the crypto 1H system) but carry zero direction on gold. Consistent with the
sweep null (`gold-1m-research.md`: 65k events, negative alpha) — session-anchoring does
not rescue pattern entries. Gold's only stable intraday structure remains time/mechanism
based: overnight drift (22→07) + PM-fix hour (`gold-session-hold.md`).

**Family closed: ICT session-conditional entries on gold.**

## Addendum: NFP event study (`research-gold-nfp.ts`, 132 NFP Fridays vs 448 controls)

- Release vol is REAL: 08:30→09:00 ET moves 1.9× ordinary Fridays (31 vs 17 bps)
- Direction is NOT exploitable: 5-min momentum t=0.23 (halves flip), fade t=0.57,
  pre-release drift t=−1.78 (weak, n=132)
- Only flicker: sign(08:30→09:00) → 09:00→12:00 = +7.1bps, WR 57.6%, t=1.33,
  same sign both halves — but ≈0.9%/yr even if real. Not actionable.

**Intraday gold is now fully mapped**: time/mechanism windows (overnight 22→07, PM-fix
hour) carry the edge; patterns, kill zones, session conditionals, and macro-release
momentum carry none.

## Addendum 2: Opening Range Breakout (`research-gold-orb.ts`, Zarattini-Aziz port)

6 variants (08:20/09:30 ET × 5/15/30m), ~2,900 trades each, 10R target per paper:
best cell 09:30ET/30m = +39.5%/11.4yr (~3.5%/yr), Sharpe 0.53, 5/12 years negative,
P&L concentrated in 2020+2022. All other cells ≈0 or negative. The QQQ engine
(positive intraday drift + open-driven trend days) does not exist in gold's
negative-drift US session. Pending: "in-play" relative-volume gate (authors' follow-up).

## Addendum 3: ORB in-play gate (relative tick-volume, trailing 20d)

RV≥1.5: both cells flip sign between halves (09:30/30m: −4.8/+8.4; 08:20/15m: +11.4/−1.9).
RV≥2: n=42–70, unstable (Sharpe 2.76 cell = small-n mirage, one-half concentration).
**ORB family fully closed on gold. The candle-based intraday-directional playbook
(patterns, kill zones, session conditionals, NFP, ORB±in-play) is now exhausted —
all measured null. Intraday gold edge = time/mechanism windows only.**
