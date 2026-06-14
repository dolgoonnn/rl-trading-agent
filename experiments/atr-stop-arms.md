# PROBE — ATR-Stop Multi-Arm Counterfactual (net of funding)

**Date:** 2026-06-14
**Status:** DIAGNOSTIC — null result. NO arm beats baseline on mean net-of-funding R.
**Script:** `scripts/atr-stop-counterfactual.ts` · **Engine:** `src/lib/research/atr-stop-arms.ts` · **Tests:** `tests/research/atr-stop-arms.test.ts`
**Data:** `experiments/runs/atr-stop-arms.json` (432 closed Run-20 `bot_trades`, all 432 replayed, 0 skipped)

## What this is

A pure replay of the SAME Run-20 trade log (no strategy/entry logic recreated) under four exit rules. Each arm
holds the position a different length, so each crosses a different number of 00/08/16 UTC funding settlements ⇒
pays different funding. **Funding is debited per arm over that arm's ACTUAL hold** via the shared
`src/lib/cost/funding-ledger.ts` keystone. The headline metric is therefore **net-of-funding R** — comparing arms
on gross R would falsely reward the longest-hold arm (it crosses the most settlements and "earns" nothing for the
extra carry). R is normalized by the ORIGINAL stop distance (1R = stored `slDist`) so all arms are comparable.

**Arms**
- **A baseline** — current SL/TP as stored, replayed over the same 160-bar horizon.
- **B atr_floor** — `SL = max(SL_orig, k·ATR14@entry)`, R:R preserved (existing harness logic). `k=1.5`.
- **C chandelier** — trailing stop `highest-high-since-entry − k·ATR` (long; mirror `lowest-low + k·ATR` for a short); exit when a bar crosses the trail. `k=3.0`.
- **D vertical_barrier** — exit at `min(SL, TP, N-bar horizon)`; horizons `[40, 80, 120, 160]`. The vertical/time
  barrier is the third barrier of the **triple-barrier method**, Marcos Lopez de Prado, *Advances in Financial
  Machine Learning* (Wiley, 2018), §3.

## Aggregate results (all 3 symbols, n=432) — meanNetR is the headline

| Arm | n | WR | SL% | fastSL% | **meanNetR** | Δ vs A | meanGrossR | meanFundR | meanBars |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **A baseline** | 432 | 44.0% | 53.0% | 12.7% | **0.2018** | +0.0000 | 0.2045 | −0.00273 | 60.9 |
| B atr_floor (k=1.5) | 432 | 44.0% | 53.0% | 12.7% | **0.2018** | +0.0000 | 0.2045 | −0.00273 | 60.9 |
| C chandelier (k=3.0) | 432 | 41.7% | 100.0% | 53.5% | **0.1037** | **−0.0981** | 0.1050 | −0.00135 | 21.0 |
| D vertical (N=40) | 432 | 48.8% | 32.2% | 12.7% | **0.1449** | **−0.0569** | 0.1462 | −0.00125 | 30.2 |
| D vertical (N=80) | 432 | 47.2% | 43.5% | 12.7% | **0.1744** | **−0.0274** | 0.1763 | −0.00194 | 46.0 |
| D vertical (N=120) | 432 | 43.8% | 50.2% | 12.7% | **0.1791** | **−0.0227** | 0.1814 | −0.00234 | 55.2 |
| D vertical (N=160) | 432 | 44.0% | 53.0% | 12.7% | **0.2018** | +0.0000 | 0.2045 | −0.00273 | 60.9 |

## Verdict: NO arm beats baseline on mean net-of-funding R

This confirms **Run-20's `partial_tp` exits are already near-optimal on this window**. Detail:

1. **B atr_floor (k=1.5) is an exact no-op.** It is byte-identical to baseline because Run-20 stops are already
   wide (~2–4% of price ≈ the `atr-extension 5.79` dynamic-RR stop), so `1.5·ATR14` never exceeds the stored
   `slDist` ⇒ the floor never binds. A floor only starts to widen stops at a much larger `k` (≈4–6); a follow-up
   sweep would need that range to produce any change, and widening a stop that is already 5.8×ATR-extended has no
   prior to help.
2. **C chandelier (k=3.0) is the worst arm (−0.098R).** Every single exit is a trailing stop (SL%=100%) and 53.5%
   of them trigger within 15 bars — the trail repeatedly clips trends that the fixed TP would have let run. WR
   barely moves (41.7%) while mean R nearly halves. Chandelier trades give back too much open profit on this
   trend-heavy crypto window.
3. **D vertical_barrier degrades monotonically as the horizon shortens** (N=40 −0.057R → N=80 −0.027R →
   N=120 −0.023R → N=160 ≡ baseline). Short time-stops lift hit-rate (N=40 WR 48.8%) but cut winners short, and the
   net effect is always negative. N=160 converges to baseline by construction (same horizon).
4. **Funding is a real but tiny tax** here: −0.0013R to −0.0027R per trade (≈0.6–1.3% of mean gross R). It correctly
   scales with hold length — the 21-bar chandelier pays the least funding (−0.00135R), the 61-bar baseline pays the
   most (−0.00273R). It is not large enough to change any arm's ranking, but it is the right discipline: on a
   slower / higher-funding instrument the longest-hold arm's apparent edge would erode here.

Per-symbol (`atr-stop-arms.json`): the pattern holds on SOL and ETH. **BTC** is the only place any alt arm edges
baseline — vertical N=80 (+0.045R) and N=120 (+0.027R) — but baseline still wins at the full horizon and the BTC
sub-sample is only n=97. That is exactly the kind of single-symbol, single-window blip that WF/PBO exists to reject.

## Caveats (read before acting)

- **In-sample, one trending window.** This is a replay of 432 trades from the live Run-20 log on a predominantly
  trending crypto window — not an out-of-sample test. Hit rates and R-multiples here are descriptive, not predictive.
- **DO NOT auto-wire any result.** Per project canon, **WF pass-rate decides** — any candidate exit change must
  clear walk-forward AND PBO (< 25%) before touching the live book. Nothing in this PROBE is wired into the live
  exit, and the null result means there is no candidate to queue.
- **Replay assumptions:** conservative intrabar ordering (SL checked before TP each bar; a chandelier trail formed
  from a bar's extreme is not crossed by that same bar's opposite extreme); ATR14 simple-mean; baseline reconstructed
  through the SAME replay engine (not stored fields) so all arms share identical bar-stepping semantics.

## Bottom line

Run-20's fixed-TP / partial-TP exit structure is not improved by an ATR-floored stop, a chandelier trail, or a
time-stop on this trade log — net of funding, all alternatives are flat-or-worse. The exit layer looks
near-optimal; the survival-hardening effort should stay on sizing/kill-switch/cost-honesty, not exit re-engineering.
