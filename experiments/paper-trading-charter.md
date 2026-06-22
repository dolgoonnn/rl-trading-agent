# Paper-Trading Charter — Combined Book

**Signed**: 2026-06-11 (before any meaningful paper P&L exists — that is the point)
**Review date**: **2026-09-11** (3 months). No funding decision before this date.
**Book**: crypto OB (Run 20) + session book (6 deployable legs + marginal Ag overnight on watch) + F2F gold
**Reference docs**: `strategy-combination.md`, `execution-audit.md`, validation JSONs in `runs/`

## What we believe going in (so we can't move the goalposts later)

| | Expectation (backtest, venue-realistic) |
|---|---|
| Combined book | ~37%/yr at 12% vol target, Sharpe ~2.5, maxDD ~10% |
| Worst NORMAL 6 months | ≈ flat (−0.3% to +1.5%) — **a flat half-year is not a failure** |
| Worst NORMAL 12 months | ≈ +6% |
| Sleeve calendar-day Sharpes | crypto ~1.9, session book ~1.3, F2F ~1.1 (vol-normalized) |
| Correlations | all pairwise |ρ| < 0.05; edge survives to ρ=0.5 |

## Pre-registered gates (decided now, applied mechanically at review)

### During the run (weekly allocator check: `npx tsx scripts/run-allocator.ts`)
- **WATCH** — sleeve rolling 30d Sharpe < 0. Action: none. Log it. This is expected
  to happen multiple times.
- **BREACH** — sleeve rolling 60d Sharpe < −1.0. Action: written review within a week
  (mechanism broken? venue issue? regime?). Sleeve may be paused ONLY with a written
  reason referencing a mechanism, not a P&L number.
- **Bot integrity failure** (missed/duplicated entries, stale-quote fills, clock bugs):
  fix immediately; if >5% of a sleeve's trades are corrupted, that sleeve's paper
  clock restarts.

### At review (2026-09-11)
- **FUND** a sleeve if: live trades executed as designed (times, directions, frictions)
  AND cumulative paper PnL is above the sleeve's bootstrap 5th-percentile path
  AND no unresolved BREACH.
- **DROP** a sleeve if: below the 5th-percentile path with a plausible mechanism
  failure, or unresolved integrity issues. Re-run the combination without it before
  funding the rest.
- **EXTEND 3 months** if: results ambiguous (in-band but ugly) or fewer than ~30
  trades in a sleeve. Extension is the default for ambiguity — funding is not.
- **Ag-overnight (marginal, 0.27 at real costs)**: funds ONLY if its live paper
  Sharpe over the period is > 0.3 — it must earn its way back in.

### Hard rules until review (the operator-override defense)
1. **No parameter changes** to any sleeve. None. A "small improvement" mid-run
   invalidates the test (and ~250 archived experiments say it won't work anyway).
2. **No new legs/sleeves** added to the live book mid-run (research in a sandbox is
   fine; deployment waits for the next review cycle).
3. **No reacting to any window shorter than 60 days.**
4. Allocator weights stay crypto 0.50 / book 0.30 / f2f 0.20, DM and vol target as
   computed — re-run the allocator monthly, rebalance only if a sleeve's target
   notional drifts >10% relative.
5. Any deviation from these rules gets written down in this file with a date and
   reason BEFORE acting, not after.

## Known caveats accepted at signing
- Combined-window evidence is only ~1.9yr; crypto sleeve carries Run 20's parameter
  fragility (re-validated on data through 2026-06-11 at signing — see addendum).
- Session-book paper fills use a ~10min-delayed Yahoo feed (validated unbiased for
  these windows by the jitter test, but it is not a real fill engine).
- Yahoo GC=F/SI=F/ES=F are front-month contiguous quotes; live trading would face
  roll costs ~4×/yr (≈1–2bp/roll) not modeled in paper PnL. Immaterial at this scale;
  noted for honesty.

## Log

- 2026-06-11 — Charter signed. Bots: crypto-bot, gold-f2f-bot, session-book-bot
  (restarted with venue-realistic frictions + US500/NFP legs). Disk cleaned.
  Broker account deferred until review passes.
- 2026-06-11 — Crypto 1H data refreshed to 2026-06-11 (`refresh-crypto-1h.ts`).
  Run 20 on the new window: 64.9% WF (was 69.7%), ETH weakest at 56.8%. Per the
  window-sensitivity canon, CMA-ES Run 21 launched warm-started from Run 20
  (`logs/cmaes-run21.log`). If Run 21 validates better than Run 20 it replaces
  the crypto sleeve config BEFORE the paper clock starts; this is pre-start
  setup, not a mid-run parameter change.
- 2026-06-11 — NFP-leg INTEGRITY BUG caught pre-firing by full historical replay
  (`research-nfp-bot-sim.ts`, 132 events): with the real ~10min-delayed Yahoo
  feed the bot's original windows destroyed the signal (direction match 67%,
  edge +8.2%→+0.4%). Fixed with delay-aware windows (signal ticks 09:12–09:22,
  exit ≥12:12); replay with real late fills: t=1.98, +13.7%. Per charter
  integrity rule this is a fix, not a parameter change. **Bot restart required
  to pick it up.** Lesson: any leg whose DIRECTION depends on a fast intraday
  move must be replayed against the actual feed latency before first live fire
  (clock-window legs are jitter-immune, validated previously).
- 2026-06-11 — CMA-ES Run 21 (warm-started from Run 20, 30 gens, refreshed data)
  REJECTED: best candidate fitness 855.1 but WF pass 59.5% vs Run 20's 64.9% on
  identical data — fitness gain was PnL concentration, and it zeroed
  liquiditySweep (the one factor with external academic backing) in favor of
  recentBOS, a window-fitting signature. Decision per canon: WF pass rate
  decides. **Run 20 stays deployed** (64.9% on data through 2026-06-11, above
  the 60% gate). Trial count for DSR: 238 → 239.
- 2026-06-11 — 3-month review scheduled as a cloud routine (runs 2026-09-11
  09:00 ULAT): https://claude.ai/code/routines/trig_01Gx4HbtnrsStENw6LG9ng6k
  DEPENDENCY: charter + scripts + (ideally) bot state snapshots must be
  committed to GitHub before the review date — the cloud agent only sees the repo.
- 2026-06-12 — Overnight research loop complete (12 verdicts, all in KNOWLEDGE.md).
  DSR trial ledger: +8 pre-registered tests tonight (silver transfer, Tokyo-fix W ×2
  windows counted as 1, funding extremes, CPI gold, Melvin-Prins EOM reversal,
  dash-for-cash, OpEx week, ICT entry timing counted previously) → honest count ~247.
  Universe D (fix-gated book) = the September review package: combined Sharpe 2.61,
  5/5 gates. No live-book changes were made.
