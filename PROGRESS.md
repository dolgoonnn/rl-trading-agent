# Overnight Loop Progress — Bot Survival Hardening

**Session start:** 2026-06-14
**Branch:** `ftr/overnight-bot-hardening` (checkpoint commit `ffc3676`)
**Plan:** `docs/superpowers/plans/2026-06-14-bot-survival-hardening.md`
**Mode:** Autonomous Implement→Evaluate→Research loop. Runs until the user says STOP.

## How this loop works (read FIRST each iteration)
1. Read this file + the plan. Find the **next unchecked `- [ ]` task/step**.
2. **Implement** it via a subagent doing strict TDD (failing test → implement → green).
3. **Evaluate** in the main thread, paste REAL output. The repo has ~230 PRE-EXISTING typecheck errors in unrelated files, so NEVER gate on global `pnpm typecheck` exit code. Instead: (a) `npx vitest run <task test files>` MUST pass; (b) NEW-errors-only typecheck — `pnpm typecheck 2>&1 | grep -E "<edited files>"` must show no error that isn't already on the baseline commit `47a6e76` (use `git show 47a6e76:<file>` to confirm pre-existing); (c) `npx eslint <edited files>` clean. Red→fix before commit. Never claim pass without output.
4. **Commit** with `gmp "<msg>" <type> backend` (never raw git).
5. Tick the box in the plan, append an entry to the Iteration Log below, update the pointer.
6. When all plan tasks are checked → **Research phase** (see plan footer + preference memory): ground in a reputable source first, save knowledge to `experiments/*.md` + `KNOWLEDGE.md` even on null results, queue candidates for next review — never touch the live book.

## Hard constraints
- **Paper only.** No real orders, no real-money keys, no live flip.
- TDD, no `any`, DI the clock/IO, one task = one commit.
- Stay on `ftr/overnight-bot-hardening`. Never `deploy`, never force-push, never touch `main`/`docs/*`.
- If a task is genuinely blocked (needs a human decision or external resource), mark it `BLOCKED` with the reason, skip to the next task — do not spin.

## Pointer
**NEXT:** Task 3b (Gold/XAU paper sleeve) — Step 1 (read `src/lib/gold/*` + `scripts/run-{gold,metals}-bot.ts`, write design note naming exact strategy+symbol, then TDD).

## Task status
- [x] Task 1 — Safety Gate ✅ `7e638c2` (12/12 tests, 0 new typecheck errors)
- [x] Task 2 — Migration 0004 ✅ `9ce61e5` (10/10 tests; also fixed pre-existing empty `__drizzle_migrations` drift that blocked all migrations; gitignored `.claude/`)
- [x] Task 3 — Forward Loop + hourly snapshots ✅ `f14241d` (13/13 tests; pure snapshot.ts helpers, mark-to-market equity, migrate-on-startup, replay-bot.ts dump gate, paper-forward mode + PM2 app)
- [ ] Task 3b — Gold/XAU paper sleeve
- [ ] Task 4 — Review Loop + funding-ledger keystone
- [ ] Task 5 — Kill-Switch
- [ ] Task 6 — Risk Hardening
- [ ] Task 7 — Tradeability + regime re-fit
- [ ] Task 8 — PROBE funding-charged backtest
- [ ] Task 9 — PROBE ATR-stop arms
- [ ] Research phase (continuous after Task 9)

## Decisions log
- Execution mode = **PAPER forward** (live prices, simulated fills). Real-money/testnet is a separate gated decision (assumed; user did not pick live).
- Gold = include **XAU paper sleeve** (Task 3b); default to charter F2F + metals legs on **XAUTUSDT**, NOT dropped Run-12 asian_range_gold. Confirm exact strategy by reading `src/lib/gold/*` + `scripts/run-{gold,metals}-bot.ts` at Task 3b.
- Schema = additive Drizzle migration 0004 (user approved).
- Git = isolated branch; user WIP checkpointed at `ffc3676` (reversible).

## Risk register (from planning brief — watch these)
1. Charter-window race: ~89 days to 2026-09-11; live DSR likely still DE-RISK-only at review → rely on E[MaxDD] absolute-stop + bootstrap p5 path.
2. Run-20 may NOT survive funding (Task 8 gate) → sequence Tasks 4+8 early; if net-WF<60%, flag Run-20 re-opened, don't patch.
3. E[MaxDD] needs funding-net sigma+Sharpe (Task 4) — don't compute hardKillDD off gross.
4. Mark-collar false rejects could starve fills (low signal freq) → start loose 50bps, tighten via skipped-signal log.
5. decision_log immutability is app-enforced only → code-review rule.
6. Backtest-dump path must be hard-gated behind non-live config (Knight lesson).
7. SQLite single-writer: weekly cron + loop contention → run cron in-process / accept brief stalls.
8. L2 orderbook adds a REST call/entry → rate-limit risk.
9. No-trade-band + CPPI + vol-target can stack to ~0 exposure at a DD bottom → bound each multiplier; keep circuit-breaker independent.

## Research queue (after Task 9; ground each in a reputable source first)
- Net-of-cost predictive OFI/CVD probe on the collected Bybit L2 (the one untested data axis; prior: OBI/CVD scalp OOS Sharpe 0.12 — must beat ~11bp round-trip).
- Liquidation-cascade-fade event study (needs ≥30–60d collection + 2-vintage holdout; harness-only for now).
- Pre-FOMC drift US500 candidate (+16.8bp/event t=2.61) re-validation per fomc-drift.md.
- Funding/basis carry sleeve as a structural risk-premium (BIS WP 1087) — net-of-cost feasibility.

## Iteration log
_(append one line per loop iteration: timestamp · task · result · commit)_
- 2026-06-14 · setup · branch + checkpoint `ffc3676`, plan + PROGRESS written · —
- 2026-06-14 · Task 1 Safety Gate · guards.ts (computePositionSize + checkPreTradeGuards), wired order-manager/data-feed/config, 12/12 vitest pass, 0 new typecheck errors · `7e638c2`
- 2026-06-14 · Task 2 Migration 0004 · 4 new tables + 5 bot_trades cost cols, additive-only SQL, 10/10 tests; fixed empty __drizzle_migrations drift; gitignored .claude/ · `9ce61e5`
- 2026-06-14 · Task 3 Forward Loop · hourly mark-to-market snapshots (pure snapshot.ts), migrate-on-startup, backtest-dump gated to non-forward modes, paper-forward mode + PM2 app, 13/13 tests · `f14241d`
