# Reconcile Partial-TP Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every code task below — write the failing test FIRST, watch it fail for the right reason, then minimal green. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the sim↔live reconciliation drift from **~50.5 bps mean |netDelta| down to < 5 bps** by replaying each live `bot_trades` row through the exit configuration its strategy actually used (the deployed Run-20 bot takes **partial TPs**), instead of the hardcoded `exitMode:'simple'` the reconcile harness uses today.

**Context — the precise defect (grounded in merged code):**
- `scripts/reconcile-sim.ts:62` builds `SIM_CONFIG = { exitMode: 'simple', ... }` and replays **every** live trade through it.
- The deployed Run-20 bot takes partial TPs: `OrderManager.checkPositionExit` (`src/lib/bot/order-manager.ts:470`) runs the `exitMode === 'partial_tp'` branch and blends `fraction*partialPnl + (1 - fraction)*exitPnl` (`order-manager.ts:544-546`).
- `simulatePosition` implements the **identical** blend (`src/lib/sim/simulator.ts:108` → `finishBlended`). The sim CAN reproduce partial TPs — reconcile simply isn't asking it to.
- `bot_trades` (`src/lib/data/schema.ts:364`) persists `netReturn / exitReason / barsHeld` but **no exit-mode or partialTP params**, so reconcile cannot reconstruct per-trade config from the row.
- Net effect: partial-TP trades are replayed as full-position simple exits → the locked-in partial leg is never modeled → ~50 bps divergence, concentrated on partial-exit trades (matches the 2026-06-24 reconcile run: 96.4% reason match, 93.8% barsHeld, **50.5 bps netDelta FAIL**, outliers all `bars=MISMATCH`).

**This is a harness-config + data-persistence bug, not a missing-sim-capability bug.** The memory note "breakeven/multiTP/enhanced still on legacy" is a broader future concern and is NOT the current driver.

**Tech Stack:** TypeScript (strict), Vitest, Drizzle ORM + better-sqlite3, pnpm. Path alias `@/` → `src/`. Tests under `tests/sim/`.

## Acceptance Gate (green target)

`npx tsx scripts/reconcile-sim.ts` over a representative dataset:
- mean |netDelta| ≤ **5 bps**  (currently ~50.5)
- reasonRate ≥ 95%  (already 96.4%)
- barsRate ≥ 90%  (already 93.8%, expected to rise)

## Global Constraints

- **TDD Iron Law:** NO production code without a failing test first. Watch each test fail for the expected reason before writing green. No exceptions.
- **TypeScript strict; no `any`.** Use narrowing or `unknown`. `as any` is banned.
- **Sim core stays PURE + DI:** no `Date.now()` / `fetch` / DB inside `src/lib/sim/{types,intrabar,cost-model,fill-model,simulator}.ts`. The new `resolveSimConfig` is a pure function. `reconcile.ts` + `scripts/reconcile-sim.ts` are the only impure edge.
- **Compose, do not duplicate:** funding via `src/lib/cost/funding-ledger.ts`; never re-derive the settlement rule.
- **No schema change in this task.** Per-row config persistence is the durable follow-up (below), deliberately deferred.
- **Branch off CURRENT `main`** (now has the sim engine via PR #5) — not `ftr/overnight-bot-hardening`.
- **Commits:** `gmp "message" type scope` (raw `git commit` is banned). Scope `backend` for code, `docs` for docs.
- **Known-red baseline (do not "fix" here):** `tests/bot/exchange-exit-manager.test.ts` (unfinished WIP) and `tests/bot/retirement-halt.test.ts` (pre-existing missing-table). Unrelated — do not let them block, do not touch.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/sim/resolve-config.ts` | NEW — pure `resolveSimConfig(strategy): SimConfig` mapping strategy → deployed exit config |
| `src/lib/sim/index.ts` | MODIFY — export `resolveSimConfig` |
| `scripts/reconcile-sim.ts` | MODIFY — call `resolveSimConfig(row.strategy)` per row instead of the hardcoded `SIM_CONFIG` |
| `tests/sim/resolve-config.test.ts` | NEW — Cycle 1 |
| `tests/sim/reconcile-partial.test.ts` | NEW — Cycles 2–4 (synthetic partial-TP scenarios) |

---

## Prerequisites (setup — not TDD)

- [ ] Branch off updated main: `gco main && git pull && newtask reconcile-partial-parity fix`. Confirm `src/lib/sim/` is present (sim engine merged via PR #5).
- [ ] Regenerate a clean reconcile dataset for the Cycle-5 gate — the live DB's 11 rows are stale (`net_return=0.0`). Use the 2026-06-24 method: `replay-bot.ts --fresh --start-date 2024-06-01` in an isolated worktree DB (`pnpm db:migrate` first) → ~418 trades. (Cycles 1–4 use synthetic fixtures and don't need this.)

## TDD Tasks

### Cycle 1 — pure config resolver
- [ ] **RED:** `tests/sim/resolve-config.test.ts` — assert `resolveSimConfig('order_block')` returns the Run-20 deployed config: `{ exitMode:'partial_tp', partialTP:{ fraction:0.50, triggerR:1.41, beBuffer:0.20 }, maxBars:160, entryTiming:'signal_close', barMs:3_600_000 }`. Run it — fails (function absent).
- [ ] **GREEN:** add pure `resolveSimConfig(strategy: string): SimConfig` in `src/lib/sim/resolve-config.ts`; export from `index.ts`. Minimal map: `order_block` → above; unknown strategy → throws (fail-closed, do not silently default to simple).

### Cycle 2 — replay blends a partial-TP trade to the live formula
- [ ] **RED:** in `tests/sim/reconcile-partial.test.ts`, construct a `SimPosition` + 1h candle slice where price reaches `triggerR` (taking the partial), then reverses to SL. First replay with the OLD `{exitMode:'simple'}` config and assert the delta vs the hand-computed `0.50*partialPnl + 0.50*remainderPnl` is large (watch it FAIL by ~tens of bps). Then assert that with `resolveSimConfig('order_block')` the `replayTrade(...).netReturn` matches the blend within `1e-9`.
- [ ] **GREEN:** rewire `scripts/reconcile-sim.ts` main loop to call `resolveSimConfig(row.strategy)` per row instead of the module-level `SIM_CONFIG`. Keep `--friction` handling.

### Cycle 3 — barsHeld parity on partial trades
- [ ] **RED:** same scenario asserts `simBarsHeld === live.barsHeld` (the partial trade's final exit bar, not the partial bar). With simple replay this mismatches; assert it.
- [ ] **GREEN:** confirm partial replay derives `barsHeld` from the final exit timestamp (already in `reconcile-sim.ts`); catch any off-by-one against `entryIndex + 1` convention.

### Cycle 4 — funding & friction residuals
- [ ] **RED:** a trade spanning a funding settlement asserts sim `fundingReturn` matches stored `funding_return` within tolerance; assert friction parity when the live recorded friction is passed via `--friction`.
- [ ] **GREEN:** align reconcile's funding-rate source + friction with what the live bot recorded at trade time.

### Cycle 5 — integration gate
- [ ] **RED:** run `reconcile-sim.ts` over the regenerated ~418-trade dataset; assert mean |netDelta| < 5 bps (script exit code is the gate).
- [ ] **GREEN:** close whatever residual remains after Cycles 1–4; iterate. If residual is dominated by candle-source mismatch (see Risks), characterize and bound it rather than forcing the number.

---

## Durable Follow-up (SEPARATE task — flag, do not do here)

Persist exit config on `bot_trades` so reconcile reconstructs config **per-row** instead of via a strategy→config map: schema migration adding `exit_mode` + `partial_taken` + `partial_pnl_percent` (or a single JSON `exit_config`), written at trade close, read by `reconcile.ts`. Removes Cycle-1's assumption that all trades used one config — **required before a second live strategy ships**.

## Risks / Honest Unknowns

- **Candle-source mismatch:** after the exitMode fix, residual drift may persist from reconcile's `data/{symbol}_1h.json` differing from the Bybit candles the live bot saw at trade time. That's a data-provenance fix, not a sim fix. Cycle 5 will expose it; **<5 bps is expected but unconfirmed until actually run.**
- **`breakeven` / `trailing` SimConfig modes** are not on the current deployment's path; `breakeven` may be unimplemented standalone in `simulatePosition` (only `partial_tp` + `trailing` branches exist). Out of scope here — note for when those strategies go live.
- **Single-config assumption:** Cycle 1's map is correct only while every live trade used Run-20 settings. True today; the durable follow-up removes the assumption.
