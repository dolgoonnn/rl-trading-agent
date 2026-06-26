# Leverage / Liquidation Sweep on Run-20 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development for every code task — failing test FIRST, watch it fail, minimal green. Checkbox (`- [ ]`) steps track progress.

**Goal:** Turn the "full-margin scalp" question into a hard number. Build a pure liquidation+leverage model into the sim, then sweep leverage on the **validated** Run-20 `order_block` edge (BTC/ETH/SOL, 1h) and emit a leverage curve: for each `L`, terminal wealth, **liquidation rate**, max drawdown, Sharpe, DSR.

**Context — the wild idea, made empirical:** Leverage does not create edge; it scales return and risk equally until liquidation truncates the downside at the margin and destroys compounding. The combined-book work already found optimal sizing ≈ 12% ann vol target (~70% half-Kelly) — low single-digit effective leverage. This experiment measures the *whole curve* so the claim is data, not opinion. We sweep the validated edge ONLY — leveraging the no-edge scalp sandbox would just confirm faster ruin and is out of scope.

**Honest prior (falsifiable):** terminal wealth peaks at low single-digit L; liq rate ~0 until ~10×, then climbs; full margin → ~100% ruin. Run-20 stops are ~1 ATR (1–3% on 1h crypto), which sits *outside* the liq distance once L ≳ 30×, so high-L trades liquidate before the stop. If the curve instead peaks at 10–20× with tolerable DD, the prior is wrong and we've found something.

**Tech Stack:** TypeScript strict, Vitest, tsx, pnpm. `@/` → `src/`. Tests under `tests/sim/`.

## The math (Bybit isolated USDT-perp — use verbatim)

- Margin per trade `m = f·E` (f = equity fraction posted as margin); notional `N = L·m`.
- Initial margin rate = `1/L`. Maintenance margin rate `MMR` from the risk-limit tier (default **0.5%** for the small BTC/ETH/SOL sizes in scope; parameterize).
- Adverse-move-to-liquidation `d_liq = 1/L − MMR`. Liquidation price:
  - long: `liqPrice = entry · (1 − d_liq)`
  - short: `liqPrice = entry · (1 + d_liq)`
- Per-trade equity update (compounding):
  - non-liquidated: `E ← E · (1 + L·f·r)` where `r` = the sim's net-of-friction/funding **notional** return (friction & funding scale with L automatically because they live inside `r`).
  - liquidated: `E ← E · (1 − f − liqFeeFrac)` (isolated mode caps the loss at the posted margin; `liqFeeFrac` = liquidation/bankruptcy fee, default ~MMR).

## Acceptance Gate (deliverable)

`npx tsx scripts/leverage-sweep.ts` emits a table over the real Run-20 trade set for `L ∈ {1,2,5,10,25,50}`:
`L | terminalWealth | liqRate% | maxDD% | Sharpe | DSR`, plus the L that maximizes terminal wealth and the L where liqRate first exceeds 1%.

## Global Constraints

- **TDD Iron Law:** no production code without a failing test first.
- TS strict; no `any`/`as any`.
- **Sim core stays PURE + DI:** `liquidation.ts` is pure (no Date.now/fetch/DB). The liq check inside `simulatePosition` adds only arithmetic + uses the EXISTING intrabar resolvers — do not add I/O to the pure surface.
- **Compose, don't duplicate:** reuse `simulatePosition`'s bar/intrabar walk and the Run-20 trade generation from `backtest-confluence`; do not re-implement the strategy or the fill model.
- Commit with `gmp "msg" type scope` (raw `git commit` banned). Scope `backend` for code, `docs` for docs.
- **Known-red baseline (do not touch):** pre-existing failures in unrelated `tests/bot/*` and `scripts/*` typecheck errors — out of scope.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/sim/liquidation.ts` | NEW — pure `liquidationPrice(entry,dir,L,MMR)`, `liqAdverseMove(L,MMR)` |
| `src/lib/sim/types.ts` | MODIFY — add optional `leverage`/`mmr` to `SimConfig` (default undefined = no liq modeling, current behavior) |
| `src/lib/sim/simulator.ts` | MODIFY — when leverage set, flag `liquidated` if the adverse intrabar extreme crosses `liqPrice` before the real exit |
| `src/lib/sim/index.ts` | MODIFY — export liquidation helpers |
| `scripts/leverage-sweep.ts` | NEW — build per-L equity curve over the Run-20 trade set + metrics table |
| `tests/sim/liquidation.test.ts`, `tests/sim/simulator-liquidation.test.ts` | NEW |

## Prerequisites (setup — not TDD)

- [x] Fresh worktree off `origin/main` (sim engine + reconcile present).
- [ ] Confirm the Run-20 trade source: `backtest-confluence` with the deployed Run-20 flags (from MEMORY.md) produces the trade list the sweep consumes. Pin the exact invocation in `leverage-sweep.ts`.

## TDD Tasks

### Task 1 — pure liquidation model
- [ ] RED: `tests/sim/liquidation.test.ts` — `liqAdverseMove(50, 0.005) === 0.015`; `liqAdverseMove(100, 0.005) === 0.005`; `liquidationPrice(100,'long',50,0.005) === 98.5`; short symmetric (101.5). Assert a high-L guard: `liqAdverseMove(200,0.005)` → 0 (or throws) when `1/L ≤ MMR`.
- [ ] GREEN: implement pure helpers in `src/lib/sim/liquidation.ts`; export from `index.ts`.

### Task 2 — liquidation flag in simulatePosition
- [ ] RED: `tests/sim/simulator-liquidation.test.ts` — add optional `leverage`/`mmr` to `SimConfig`. Synthetic long where the adverse intrabar extreme pierces `liqPrice` BEFORE the stop → result flagged `liquidated:true` with the liq exit. A second case where the stop is hit first (liq not reached) → `liquidated:false`. With `leverage` unset → behavior identical to today (regression).
- [ ] GREEN: in `simulatePosition`, when leverage is set, compute `liqPrice` and check it with priority in the intrabar resolution (reuse subbar/OHLC/pessimistic ordering). Add `liquidated:boolean` to `SimTradeResult`.

### Task 3 — equity-curve builder
- [ ] RED: `scripts/` helper (pure, exported for test) `buildLeverageEquityCurve(trades, {L, f, mmr, liqFeeFrac})` — hand-checked 3-trade curve including one liquidation: assert terminal wealth, liqRate, maxDD match first-principles.
- [ ] GREEN: implement the compounding rule above.

### Task 4 — the sweep
- [ ] RED: a small fixture trade set → assert the sweep emits one row per L with monotone-sane fields (e.g. liqRate non-decreasing in L for a fixed adverse-move distribution).
- [ ] GREEN: `scripts/leverage-sweep.ts` — generate the Run-20 trade set, run the sweep, print the table + the two summary L's.

## Risks / Honest Unknowns

- **Sizing assumption `f`:** results depend on equity-fraction-as-margin `f`. Report the curve at a couple of `f` values (e.g. risk-per-trade matched to the deployed book) so the answer isn't a single arbitrary point.
- **Isolated vs cross / ADL:** model isolated only (loss capped at margin). Cross-margin and auto-deleverage are out of scope — note that cross would be *worse* (account-wide liquidation).
- **MMR tiers:** fixed 0.5% default; large notionals would hit higher tiers — fine for the in-scope sizes, parameterized for later.
