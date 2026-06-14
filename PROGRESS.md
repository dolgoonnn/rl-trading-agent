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
**NEXT:** RESEARCH PHASE (all 9 build tasks done). First item: funding/basis carry sleeve net-of-cost feasibility, grounded in BIS WP 1087 (structural risk-premium = strongest mechanism prior). Ground in the paper FIRST, then backtest on data/*_futures_1h.json, save knowledge to experiments/ even on null.
**Task 8 result:** GATE PASS — Run-20 survives funding (net WF 64.9%, +262.4% PnL, drag −1.96bps/trade). Risk #2 closed.
**Task 9 result:** NULL — no exit arm (chandelier/vertical-barrier) beats Run-20 partial_tp net-of-funding → exits already near-optimal.

## 🏁 MILESTONE: survival-hardening plan complete (9/9 tasks, branch ftr/overnight-bot-hardening)
Commits ffc3676(checkpoint) → 7e638c2 → 9ce61e5 → f14241d → 66227c8 → 954a03d → c7f7544 → fc6b283 → 6c87f39 → 31346c6 → e2581e7 → 1100e5a → 87e65c8 (+ doc commits). Adversarial review caught 3 real defects single-pass would have shipped: frictionReturn=0; kill-switch automatic halts unwired (dead code); CPPI fed backtest not live equity. All TDD, ~all green, 0 net-new typecheck errors (baseline 228).
**Carried TODOs into Task 7+:** `consumeRegimeCause()` returns false until a regime-decay detector feeds it (Task 7); `bootstrapP5DD=0.10` placeholder → wire from validate-monte-carlo; `charterBreachConsecutive` needs a real charter p5-path feed.
**Task 5b spec (from 2-lens adversarial review of 5a):**
- HIGH: `checkRetirementHalt`/`setKillFlag` are never called at runtime → wire into run-bot tick: on `halt` → `setKillFlag(source:'retirement')` + decision_log + alert; on `derisk` → apply sizing multiplier. (Issue 2)
- HIGH: heartbeat stale-feed only alerts, does NOT block entries → gate entries on `heartbeat.stale` (effectiveKill). (Issue 1)
- MED: feed PER-OBSERVATION Sharpe + T=observations to the DSR gate (annualized Sharpe is a scale mismatch making DSR coarse). (Issue D)
- MED: make per-symbol entry cap restart-durable — rebuild `entryTimestamps` in `loadState()` from bot_positions/bot_trades entryTimestamp <24h. (Issue 3)
- MED: add sustained-DSR hard-halt — `dsrBreachConsecutive >= dsrBreachK` with n>=MinTRL halts even without regimeCause (mirror charter-path). (Issue B)
- MED: `regimeCause` must be EDGE-triggered, not level-latched (else healthy book pinned at 0.5x forever). (Issue A)
- LOW/doc: `bootstrapP5DD=0.10` is a placeholder → comment + TODO wire from validate-monte-carlo. (Issue C); wire per-symbol consecutive-loss pause `isSymbolPaused` (Issue 4).
**Flagged for Task 5:** add `'degradation_alert'` to the `AlertEvent` union in `src/lib/bot/alerts.ts` (pre-existing type error; Task 5 owns alerts/halts).
**Flagged (review finding, defer):** live crypto `closePosition` passes no funding series today, so live `fundingReturn=0` until funding wiring; the keystone is exercised by the Task 8 backtest. Wire a live `FundingSettlementSeries` when convenient.

## Task status
- [x] Task 1 — Safety Gate ✅ `7e638c2` (12/12 tests, 0 new typecheck errors)
- [x] Task 2 — Migration 0004 ✅ `9ce61e5` (10/10 tests; also fixed pre-existing empty `__drizzle_migrations` drift that blocked all migrations; gitignored `.claude/`)
- [x] Task 3 — Forward Loop + hourly snapshots ✅ `f14241d` (13/13 tests; pure snapshot.ts helpers, mark-to-market equity, migrate-on-startup, replay-bot.ts dump gate, paper-forward mode + PM2 app)
- [x] Task 3b — Gold/XAU paper sleeve ✅ (F2F daily, XAUTUSDT, paper; mirrored to bot_trades/equity tagged f2f_gold; 4/4 tests)
- [x] Task 4a — Funding-ledger keystone + 4-component decomposition ✅ `954a03d` (22 tests; adversarial review caught + fixed frictionReturn=0 → real friction attribution consistent with gold sleeve)
- [x] Task 4b — Review report (per-cell) + decision_log + skipped_signals + weekly cron ✅ `c7f7544` (17 tests; review.ts per-cell + cold-cohort, append-only decision-log.ts, onSkip seam in order-manager, run-weekly-review.ts)
- [x] Task 5a — Kill-switch core (manual flag + pure halt logic) ✅ `fc6b283` (46 tests; 2-lens adversarial review confirmed manual flag correct, found automatic-halt wiring missing → 5b)
- [x] Task 5b — Wire automatic halts + heartbeat into tick loop ✅ `6c87f39` (12 end-to-end tests, 111 bot tests; tick now calls evaluateRetirement→setKillFlag, heartbeat→effectiveKill blocks entries, derisk→sizing mult, durable cap)
- [x] Task 6 — Risk Hardening ✅ `31346c6` (38 risk tests; adversarial review confirmed no look-ahead + caught CPPI fed backtest-equity → fixed to LIVE equity, + band stand-down-to-zero fix)
- [x] Task 7 — Tradeability + regime re-fit ✅ `e2581e7` (15 tests; L2 checkTradeability reject, getOrderbook, charter-cadence refit proposal (no auto-apply), score-reliability diagnostic with isolation guardrail)
- [x] Task 8 — PROBE funding-charged backtest ✅ `1100e5a` (GATE PASS: Run-20 survives funding, net WF 64.9%, +262.4% PnL, −1.96bps/trade; grounded in Bybit funding mechanics; experiments/funding-cost.md)
- [x] Task 9 — PROBE ATR-stop arms ✅ `87e65c8` (NULL: no arm beats baseline net-of-funding; Run-20 exits near-optimal; 8 tests, cites LdP triple-barrier)
- [~] Research phase (continuous) — IN PROGRESS, first: funding-carry feasibility

## Decisions log
- Execution mode = **PAPER forward** (live prices, simulated fills). Real-money/testnet is a separate gated decision (assumed; user did not pick live).
- Gold = include **XAU paper sleeve** (Task 3b); default to charter F2F + metals legs on **XAUTUSDT**, NOT dropped Run-12 asian_range_gold. Confirm exact strategy by reading `src/lib/gold/*` + `scripts/run-{gold,metals}-bot.ts` at Task 3b.
- Schema = additive Drizzle migration 0004 (user approved).
- Git = isolated branch; user WIP checkpointed at `ffc3676` (reversible).

### Task 3b gold design decision
- Strategy = **F2F daily** (`src/lib/gold`, forecast-to-fill, λ=0.95 θ=0.91, zscore50 regime filter) — NOT dropped Run-12 `asian_range_gold` (0/6 on the 11-yr holdout: WF 46.6%, DSR −0.15).
- Symbol = **XAUTUSDT** (Tether Gold; XAUUSDT delisted from Bybit). Cadence = daily poll (~00:05 UTC, after Bybit daily close), PAPER only (live prices, simulated fills, no real-money keys).
- Persistence: the existing `run-gold-bot.ts` wrote forward trades+equity ONLY to `data/gold-bot-state.json`, which the Sept charter review (reads `data/ict-trading.db`) cannot see. Task 3b adds a thin seam `src/lib/gold/paper-sleeve.ts` that maps each F2F paper trade/equity tick into `bot_trades` + `bot_equity_snapshots` (same DB+tables as the crypto loop), tagged `strategy='f2f_gold'`, `symbol='XAUTUSDT'` so Task 4 per-symbol/per-strategy review can separate sleeves.
- Deferred: keeping the JSON state file as the bot's source of truth (DB rows are an append-only mirror for review); no dedup/replay guard beyond the existing `lastTickTimestamp` skip; metals-book legs stay on their own JSON track (separate sleeve, out of scope here).

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
- [DONE `86dac43`] Funding/basis carry (BIS WP 1087) — NULL net-of-cost; funding family CLOSED (stays a cost, not harvested).
- [DONE `2f3dfa8`] Pre-FOMC drift US500 — CLOSED (grounded Lucca-Moench 2015 + Kurov 2021): decayed to 1/3, vol-gate fails Harvey-Liu, 82% redundant with leg J. No new leg.
- [BLOCKED — needs ≥30–60d L2 collection via collect-btc-orderflow.ts] Net-of-cost predictive OFI/CVD probe (prior OOS Sharpe 0.12).
- [BLOCKED — needs ≥30–60d collection + 2-vintage holdout] Liquidation-cascade-fade event study.

## Iteration log
_(append one line per loop iteration: timestamp · task · result · commit)_
- 2026-06-14 · setup · branch + checkpoint `ffc3676`, plan + PROGRESS written · —
- 2026-06-14 · Task 1 Safety Gate · guards.ts (computePositionSize + checkPreTradeGuards), wired order-manager/data-feed/config, 12/12 vitest pass, 0 new typecheck errors · `7e638c2`
- 2026-06-14 · Task 2 Migration 0004 · 4 new tables + 5 bot_trades cost cols, additive-only SQL, 10/10 tests; fixed empty __drizzle_migrations drift; gitignored .claude/ · `9ce61e5`
- 2026-06-14 · Task 3 Forward Loop · hourly mark-to-market snapshots (pure snapshot.ts), migrate-on-startup, backtest-dump gated to non-forward modes, paper-forward mode + PM2 app, 13/13 tests · `f14241d`
- 2026-06-14 · Task 3b Gold sleeve · F2F daily XAUTUSDT paper, src/lib/gold/paper-sleeve.ts mirrors trades+equity into bot_trades/snapshots tagged f2f_gold, 4/4 tests · `66227c8`
- 2026-06-14 · Task 4a Funding-ledger keystone · half-open settlement counting (math reviewer: fuzz-clean), 4-component decomposition; ADVERSARIAL REVIEW caught frictionReturn=0 defect → fixed to -(nSides·frictionPerSide), 22 tests · `954a03d`
- 2026-06-14 · Task 4b Review layer · per-cell decompose + cold-cohort decay, append-only decision-log, skipped-signal onSkip seam, weekly cron, 17 tests · `c7f7544`
- 2026-06-14 · Task 5a Kill-switch core · manual file/DB/env latched flag (reduce-only, restart-durable) + pure retirement-halt logic + per-symbol cap, 46 tests; 2-lens adversarial review caught automatic halts unwired (→5b) · `fc6b283`
- 2026-06-14 · Task 5b Wire automatic halts · tick→evaluateRetirement→setKillFlag latch, heartbeat→effectiveKill blocks entries, per-obs DSR scale fix, durable per-symbol cap, sustained-DSR escalation; 12 e2e tests, 111 bot tests · `6c87f39`
- 2026-06-14 · Task 6 Risk hardening · src/lib/risk/sizing.ts (vol-target, no-trade band, fractional-Kelly off rolling DSR, CPPI); review: no look-ahead, fixed CPPI→live equity + band stand-down; 38 risk tests · `31346c6`
- 2026-06-14 · Task 7 Tradeability+regime · checkTradeability L2 reject + getOrderbook, charter-cadence refit proposal (no auto-apply), score-reliability diagnostic (sizing-isolation proven), 15 tests · `e2581e7`
- 2026-06-14 · Task 8 Funding-cost PROBE · funding wired into backtest (default off) via Task-4a ledger; Run-20 SURVIVES (net WF 64.9% > 60%, +262.4% PnL, drag −1.96bps/trade); maker/taker split; 25 cost tests · `1100e5a`
- 2026-06-14 · Task 9 ATR-stop arms PROBE · chandelier + vertical-barrier + per-arm funding debit on Run-20 log; NULL (no arm beats baseline net-of-funding); 8 tests · `87e65c8`
- 2026-06-14 · RESEARCH funding-carry · grounded BIS WP1087 + arXiv replication; reproduced 7.6% net APY + 2024→2025 decay; NULL tradeable alpha (gated harvest net-negative, Sharpe is illusion); funding family closed; 5 tests · `86dac43`
- 2026-06-14 · RESEARCH pre-FOMC drift · grounded Lucca-Moench 2015 + Kurov 2021; CLOSED (decayed 1/3, vol-gate fails Harvey-Liu deflation, 82% redundant w/ leg J); placebo confirms FOMC-specificity; 9 tests · `2f3dfa8`

## 🛑 LOOP STATUS (2026-06-14): feasible work EXHAUSTED — disciplined idle, NOT spinning
All 9 build tasks done + 2 grounded research items closed. Remaining work is genuinely gated, NOT skipped lazily:
- Research queue: OFI/CVD predictive probe + liquidation-fade are BLOCKED on ≥30–60d Bybit L2 collection (collect-btc-orderflow.ts must accumulate first) — attempting now = underpowered/premature, forbidden by the loop's own rules.
- Carried TODOs (consumeRegimeCause regime-decay detector, bootstrapP5DD-from-MC, live funding-series wiring, charter p5-path feed) are deferred-by-design: the regime-decay detector is a NEW signal component (preference: queue for review, never auto-add to live book), bootstrapP5DD is non-binding (eMaxDD 0.194 > placeholder 0.10), live-funding wiring needs a source/cadence decision best made with the user awake.
- Per the loop's "mark blocked, never spin" rule, the loop now IDLES rather than manufacture low-value work. Awaiting user wake / STOP. To resume productive autonomous work, unblock L2 collection or greenlight a carried TODO.

⚠️ **ACTION NEEDED to unblock microstructure research:** `data/orderflow/` has only 2 PARTIAL days (BTCUSDT 2026-06-11 ~48k + 2026-06-12 ~19k snapshots) — **the collector (collect-btc-orderflow.ts) STALLED on 2026-06-12** (no 06-13/06-14 files). It writes NDJSON per day to data/orderflow/ (mid, spreadBps, bidDepth5/askDepth5, imb5/25, + publicTrade + allLiquidation). To unblock the OFI/CVD + liquidation-fade research it must be RESTARTED and kept alive (add a PM2 entry) to accumulate ≥30–60 days. Only ~10 liquidation events captured so far (per practitioner-mechanisms.md) — far short of an event study.
