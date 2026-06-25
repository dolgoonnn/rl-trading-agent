# Reconcile Partial-TP Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every code task below — write the failing test FIRST, watch it fail for the right reason, then minimal green. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the sim↔live reconciliation drift from **~50.5 bps mean |netDelta| down to < 5 bps** by replaying each live `bot_trades` row through the exit configuration its strategy actually used (the deployed Run-20 bot takes **partial TPs**), instead of the hardcoded `exitMode:'simple'` the reconcile harness uses today.

**Context — the precise defect (grounded in merged code):**
- `scripts/reconcile-sim.ts:66` builds `SIM_CONFIG = { exitMode: 'simple', ... }` and replays **every** live trade through it.
- The deployed Run-20 bot takes partial TPs: `OrderManager.checkPositionExit` (`src/lib/bot/order-manager.ts:470`) runs the `exitMode === 'partial_tp'` branch and blends `fraction*partialPnl + (1 - fraction)*exitPnl` (`order-manager.ts:544-546`).
- `simulatePosition` implements the **identical** blend (`src/lib/sim/simulator.ts:108` → `finishBlended`). The sim CAN reproduce partial TPs — reconcile simply isn't asking it to.
- `bot_trades` (`src/lib/data/schema.ts:364`) persists `netReturn / exitReason / barsHeld` but **no exit-mode or partialTP params**, so reconcile cannot reconstruct per-trade config from the row.
- Net effect: partial-TP trades are replayed as full-position simple exits → the locked-in partial leg is never modeled → ~50 bps divergence, concentrated on partial-exit trades (matches the 2026-06-24 reconcile run: 96.4% reason match, 93.8% barsHeld, **50.5 bps netDelta FAIL**, outliers all `bars=MISMATCH`).

**This is a harness-config + data-persistence bug, not a missing-sim-capability bug.**

**Tech Stack:** TypeScript (strict), Vitest, Drizzle ORM + better-sqlite3, pnpm. Path alias `@/` → `src/`. Tests under `tests/sim/`.

## Acceptance Gate (green target)

`npx tsx scripts/reconcile-sim.ts` over a representative dataset:
- mean |netDelta| ≤ **5 bps**  (currently ~50.5)
- reasonRate ≥ 95%  (already 96.4%)
- barsRate ≥ 90%  (already 93.8%, expected to rise)

## Global Constraints

- **TDD Iron Law:** NO production code without a failing test first. Watch each test fail for the expected reason before writing green.
- **TypeScript strict; no `any`.** Use narrowing or `unknown`. `as any` is banned.
- **Sim core stays PURE + DI:** no `Date.now()` / `fetch` / DB inside `src/lib/sim/{types,intrabar,cost-model,fill-model,simulator}.ts`. The new `resolveSimConfig` is a pure function.
- **Compose, do not duplicate:** funding via `src/lib/cost/funding-ledger.ts`.
- **No schema change in this task.** Per-row config persistence is the durable follow-up (below).
- **Commits:** `gmp "message" type scope` (raw `git commit` is banned). Scope `backend` for code, `docs` for docs.
- **Known-red baseline (do not "fix" here):** `tests/bot/exchange-exit-manager.test.ts` (unfinished WIP) and `tests/bot/retirement-halt.test.ts` (pre-existing missing-table). Unrelated — do not touch.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/sim/resolve-config.ts` | NEW — pure `resolveSimConfig(strategy): SimConfig` mapping strategy → deployed exit config |
| `src/lib/sim/index.ts` | MODIFY — export `resolveSimConfig` |
| `scripts/reconcile-sim.ts` | MODIFY — call `resolveSimConfig(row.strategy)` per row instead of the hardcoded `SIM_CONFIG` |
| `tests/sim/resolve-config.test.ts` | NEW — Cycle 1 |
| `tests/sim/reconcile-partial.test.ts` | NEW — Cycles 2–4 |

## Prerequisites (setup — not TDD)

- [x] Branch off updated main (worktree on `origin/main`, sim engine present).
- [ ] Regenerate a clean reconcile dataset for the Cycle-5 gate — live DB rows are stale. Use `replay-bot.ts --fresh --start-date 2024-06-01` in this worktree's DB (`pnpm db:migrate` first) → ~418 trades. (Cycles 1–4 use synthetic fixtures.)

## TDD Tasks

### Cycle 1 — pure config resolver
- [ ] **RED:** `tests/sim/resolve-config.test.ts` — assert `resolveSimConfig('order_block')` returns `{ exitMode:'partial_tp', partialTP:{ fraction:0.50, triggerR:1.41, beBuffer:0.20 }, maxBars:160, entryTiming:'signal_close', barMs:3_600_000 }`. Run — fails (fn absent).
- [ ] **GREEN:** add pure `resolveSimConfig(strategy: string): SimConfig` in `src/lib/sim/resolve-config.ts`; export from `index.ts`. Unknown strategy → throw (fail-closed).

### Cycle 2 — replay blends a partial-TP trade to the live formula
- [ ] **RED:** construct a `SimPosition` + 1h slice where price reaches `triggerR` then reverses to SL. Replay with OLD `{exitMode:'simple'}` and assert delta vs `0.50*partialPnl + 0.50*remainderPnl` is large (watch FAIL). Then assert with `resolveSimConfig('order_block')` `netReturn` matches the blend within `1e-9`.
- [ ] **GREEN:** rewire `scripts/reconcile-sim.ts` to call `resolveSimConfig(row.strategy)` per row.

### Cycle 3 — barsHeld parity on partial trades
- [ ] **RED:** same scenario asserts `simBarsHeld === live.barsHeld` (final exit bar).
- [ ] **GREEN:** confirm partial replay derives barsHeld from final exit; catch off-by-one.

### Cycle 4 — funding & friction residuals
- [ ] **RED:** trade spanning a funding settlement asserts sim `fundingReturn` matches stored `funding_return`; friction parity via `--friction`.
- [ ] **GREEN:** align reconcile's funding-rate source + friction with the recorded values.

### Cycle 5 — integration gate
- [ ] **RED:** run `reconcile-sim.ts` over the ~418-trade dataset; assert mean |netDelta| < 5 bps (exit code is the gate).
- [ ] **GREEN:** close residual; if dominated by candle-source mismatch, characterize and bound it.

## Durable Follow-up (SEPARATE task — flag, do not do here)

Persist exit config on `bot_trades` (`exit_mode`, `partial_taken`, `partial_pnl_percent`, or JSON `exit_config`) + write at close + reconcile reads per-row. Removes Cycle-1's single-config assumption — required before a second live strategy ships.

## Risks / Honest Unknowns

- **Candle-source mismatch:** residual drift may persist from reconcile's `data/{symbol}_1h.json` vs the Bybit candles the live bot saw. Data-provenance fix, not sim. **<5 bps expected but unconfirmed until run.**
- **`breakeven` / `trailing` modes** not on the current deployment path; `breakeven` may be unimplemented standalone in `simulatePosition`. Out of scope.
