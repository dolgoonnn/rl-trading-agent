# Prop-firm barrier simulation — session book through Topstep-style rules

**Date**: 2026-06-11. Script: `scripts/research-prop-barrier.ts` (every 5th
historical day as a start, 2015–2026, sessionBookRetail at venue-realistic
costs). Rules: $50k account, +$3k target, $2k EOD-trailing MLL (locks at
start), $1k daily loss limit, $165 fee, $2k payout cushion.

## Results (intraday-stress f=0.5 / pure-EOD f=0)

| Book notional | Eval pass % | Med eval days | Med funded months | Mean withdrawn | EV/attempt |
|---|---|---|---|---|---|
| $25k | 55 / — | 116 | 25 | $9,153 | +$4,866 |
| $50k | 43 / 45 | 39 | 3 | $5,226 | +$2,081 |
| $75k | 31 / 46 | 20 | 1–2 | $1,961–5,911 | +$439–2,578 |
| $100k | 23 / 39 | 11–14 | 0–1 | $947–2,653 | +$57–875 |
| $150k | 16 / 35 | 5–8 | 0 | $397–1,717 | −$100–438 |

- **Pass rates 2–3× the Topstep population base rate (16.8%)** — a systematic
  book with designed ~10% DD is exactly the shape that survives evaluations.
- **100% of paths eventually blow** at every size: a $2k trailing barrier is
  tiny vs book vol — the model is extract-then-blow-then-re-evaluate, which is
  how professional "prop farmers" actually operate. EV stays positive because
  mean withdrawals ≫ fees.

## The implementation vise (why this is NOT a green light)

1. **Contract granularity vs optimal size.** The EV-optimal notional is
   $25–50k/account — but 1 MGC = $42k, 1 SIL = $64k, MES = $37k notional.
   At $25k book notional the per-leg notionals are below ONE micro contract.
   Implementable futures-prop floor is ≈ $100k notional (and silver still
   doesn't fit) — where EV is only ~$57–875/attempt.
2. **CFD prop firms** (FTMO-style) fix granularity (0.01-lot gold = ~$4k) but
   their friction (~1.5–2.5bp/side metals) kills the fix legs and makes
   overnight marginal (breakeven 1.89bp/side post-re-anchor).
3. **Not modeled, all adverse**: monthly fees during the 116-day slow pass
   (~$500+ at $25k notional), payout consistency rules (winning-day minimums),
   Apex-style intraday trailing (stricter than f=0.5 in fast markets),
   per-firm bans on holding through closes/news (some firms prohibit exactly
   our overnight holds — RULE CHECK REQUIRED per firm before any attempt).

## Verdict
The barrier-option math works for our book's DD profile, but the practical
edition is a **MES+MGC subset at ~$100k notional** with EV ≈ breakeven-to-thin,
OR waiting for the book to be validated live first. Status: SHELVED pending
(a) per-firm rule check on overnight/news holding, (b) 3-month paper results.
Not a substitute for the FCM account; possibly a cheap supplement later.
