# Prop-rule Monte Carlo — metals sleeve through verified 2026 firm rulesets

**Date**: 2026-08-03. Script: `scripts/prop-rule-mc.ts`. Test 1 of the
gold-scalp deep dig (memory: `gold-scalp-deep-dig-2026-08`). Supersedes the
open questions left by `prop-barrier-sim.md` (2026-06-11, SHELVED pending
per-firm rule check — now done).

## What this models that the June sim did not

- Stationary block bootstrap (seeded, mean block 10d) over union-calendar
  day-vectors of the 6 metals legs (A,B,C,D,I,F) — preserves cross-leg
  same-day correlation; 1000 attempts per config vs every-5th-day starts.
- Verified 2026-08 rulesets: **Topstep 50K Combine** (no weekend holds →
  overnight legs rebuilt `weekendGap=false`; eval consistency best-day <50%;
  $49/mo + $149 activation; first payout gated on 5 winning days ≥$200;
  100% of first $10k then 90/10; P(paid)=0.95) vs **MFFU Rapid 50K**
  (weekend holds OK, no consistency, $129/mo, 90/10, P(paid)=0.85).
  MFFU Core is legacy since Jul-2026.
- MGC/SIL micro-futures friction (0.45/0.60bp MGC RTH/ETH, 1.0/1.3bp SIL)
  replacing the spot-tier 0.3/1bp bake-in.
- **Integer-contract tier** at today's prices (MGC=$42.2k, SIL=$64.9k).

## Result

| Variant | Best config (int $50k) | P(pass) | EV/attempt |
|---|---|---|---|
| base (f=0.5, fric x1.0, 2015+) | MFFU / Topstep | 57% / 53% | $1,314 / $1,409 |
| stress-hard (f=1.0) | MFFU / Topstep | 52% / 49% | $1,098 / $1,131 |
| friction x1.5 | MFFU / Topstep | 44% / 41% | $382 / $456 |
| recent regime (2020+) | MFFU / Topstep | 52% / 47% | $760 / $766 |
| worst-case (f=1.0, x1.5, 2020+) | MFFU / Topstep | 35% / 31% | $107 / $164 |

Gate (pre-registered): E[net] > 3x fees AND P(pass) > 50%, robust across all
variants. **Best configs pass only 1-2 of 5 variants. GATE FAIL → prop path
stays SHELVED.**

## Findings worth keeping

1. **EV never goes negative at int-$50k** (capped-loss lottery structure), but
   the worst-case EV (~$100-160) is fee-recycling, not income. The base-case
   $1.3-1.4k/attempt is carried by the 2015-19 regime and x1.0 friction.
2. **Integer rounding beats fractional sizing at $50k** because it drops
   silver overnight (B=0: one SIL = $65k ≫ the $25k leg target) — and leg B
   at SIL ETH friction (1.3bp/side) is a net drag. Silver-fix leg I runs 1.3x
   overweight ($65k on a $50k slot). The "granularity vise" from the June sim
   partially resolves itself by amputating the weakest leg.
3. **100% of funded paths eventually blow at ≥$50k sizing** (86-100%) — the
   model remains extract-then-blow; median funded survival is short. All EV
   comes from sweeps before the blow. This is prop-farming, not a durable
   funded account.
4. Topstep vs MFFU is roughly a wash: Topstep's weekend ban costs a little
   edge (weekend-gap leg removed), MFFU's higher monthly fee and payout
   haircut (0.85) costs about the same.

## Caveats

- Consistency rule modeled at eval only (Topstep); funded-phase payout
  consistency windows (post-Nov-2025 two-rule structure) approximated by the
  5-winning-day gate + monthly sweeps.
- Intraday stress f·σ is still a proxy for true intraday troughs (EOD data).
- Automation ToS risk (Topstep VPS ban vs Railway fleet) is NOT in the EV —
  it would only lower it.

## Verdict

SHELVED, again — now with the June sim's open items closed. The honest read:
prop capital on this sleeve is a positive-EV lottery ticket whose EV is too
assumption-sensitive to clear a 3x-fee bar robustly. Re-run this script if
(a) the metals sleeve's live Railway record accumulates 3+ months at paper
Sharpe, or (b) a firm ships materially better rules (bigger trail, cheaper
eval). Next test in the dig sequence: LETF settlement-flow event study
(~$100 data) — independent of this result.
