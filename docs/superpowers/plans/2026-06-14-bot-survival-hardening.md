# Bot Survival Hardening — Implementation Plan

> **For agentic workers:** Execute task-by-task with TDD (vitest). Steps use checkbox (`- [ ]`) syntax. This plan is the spec the overnight Implement→Evaluate→Research loop follows. Update `PROGRESS.md` after every task.

**Goal:** Make the paper-trading bot *safe, observable, honestly-costed, and self-halting* so it can accumulate a real forward track record before the 2026-09-11 charter review — without chasing new alpha.

**Architecture:** Pure, dependency-injected guard/cost/sizing modules (no `Date.now()`/`fetch` inside — clock & prices passed as args) so every rule is unit-testable. Two cross-cutting keystones built once and reused everywhere: `src/lib/cost/funding-ledger.ts` (shared by live + backtest = zero sim/live mismatch) and a single additive migration `0004` adding all new tables/columns. Live-only safety code never touches the backtest path (Run-20 edge measurement must not shift).

**Tech Stack:** TypeScript (strict), Node, Bybit REST, SQLite via Drizzle, vitest. Commits via `gmp "msg" type scope` (never raw git). Verify: `pnpm typecheck && pnpm lint && pnpm test`.

---

## Operating Constraints (apply to EVERY task)

- **Paper only.** Never place real orders, never read/require real-money exchange keys, never flip to live. Real-money is an explicitly-gated future decision.
- **TDD, Red→Green.** Write the failing test first, run it, see it fail for the right reason, implement minimally, run it green. Then verify: `npx vitest run <task tests>` green + **new-errors-only** typecheck (`pnpm typecheck 2>&1 | grep <edited files>` shows nothing absent from baseline `47a6e76` — the repo carries ~230 pre-existing errors, so global `pnpm typecheck` exit code is NOT a gate) + `npx eslint <edited files>` clean.
- **No `any`.** Real types or `unknown` + narrowing.
- **DI the clock and I/O.** Guard/cost/sizing functions take `nowMs`, `markPrice`, candle timestamps as arguments. No internal `Date.now()`/`fetch` in pure logic.
- **Commit per task** with `gmp "<msg>" <type> backend` after green + typecheck + lint. One task = one commit.
- **Research per the preference memory:** every research/PROBE experiment is grounded in a reputable primary source first (cite it, follow its spec, compare to published). Save knowledge to `experiments/*.md` + `experiments/KNOWLEDGE.md` even when the result is null — a failed strategy that surfaces a mechanism is a win.
- **Never auto-apply research to the live book.** New candidates queue for the next review cycle.

## File Structure (created/modified)

- `src/lib/bot/guards.ts` **(NEW)** — pure pre-trade reject + sizing math (Task 1, extended Task 6).
- `src/lib/bot/kill-switch.ts` **(NEW)** — latched file+DB kill flag (Task 4-kill).
- `src/lib/cost/funding-ledger.ts` **(NEW keystone)** — settlement counting + signed funding return (Task 3-review, reused Task 5/7/8).
- `src/lib/bot/review.ts` **(NEW)** — per-cell decomposition, cold-cohort DSR, score-reliability diagnostic.
- `src/lib/data/schema.ts` **(MODIFY)** — migration `0004`: `bot_kill_switch`, `decision_log`, `skipped_signals`, `pnl_cells` + nullable columns on `bot_trades`.
- `src/lib/bot/{order-manager,data-feed,position-tracker,risk-engine,config}.ts` **(MODIFY)** — wire guards, mark price, snapshots, funding debit, halts, sizing.
- `scripts/{run-bot,run-weekly-review,research-funding-cost,atr-stop-counterfactual,refit-regime-thresholds}.ts` — loop fixes, cron, PROBES.
- `tests/{bot,cost,risk,research}/*.test.ts` **(NEW)** — one test file per unit.

---

## Build Order (dependency-correct)

1. Task 1 — Safety Gate (PLAN-A, no deps)
2. Task 2 — Migration 0004 (shared additive schema for all later tables/columns)
3. Task 3 — Forward Loop + hourly snapshots (PLAN-B) + Task 3b Gold/XAU sleeve
4. Task 4 — Review Loop + funding-ledger keystone + decision log + skipped signals (PLAN-D)
5. Task 5 — Kill-Switch (PLAN-C, needs snapshots + funding-net returns)
6. Task 6 — Risk Hardening (PLAN-C, needs funding-net returns + E[MaxDD])
7. Task 7 — Tradeability gate + regime re-fit script (PLAN-A sibling)
8. Task 8 — PROBE: funding-charged backtest re-confirm Run-20 (PLAN-E)
9. Task 9 — PROBE: ATR-stop multi-arm counterfactual (PLAN-E)

---

## Task 1: Pre-Trade Safety Gate — ✅ DONE (`7e638c2`, 12/12 tests, 0 new typecheck errors)

**Plan group:** PLAN-A. **Depends on:** none (build first — only live money-risk in the deployed bot).

**Files:**
- Create: `src/lib/bot/guards.ts`
- Create: `tests/bot/guards.test.ts`, `tests/bot/data-feed-freshness.test.ts`
- Modify: `src/lib/bot/order-manager.ts` (openPosition:55-110, openLTFPosition:117-173 call guards), `src/lib/bot/data-feed.ts` (getLatestPrice:325-331; NEW getMarkPrice), `src/lib/bot/config.ts` (NEW SAFETY_GATE_CONFIG), `src/types/bot.ts` (NEW SafetyGateConfig, GuardResult, RejectReason)

**Design:** Hard REJECTS (per-order, no human in loop), per SEC 15c3-5 / Knight Capital. Extract sizing+guards into pure `guards.ts`:
- `computePositionSize({equity,riskPerTrade,symbolAlloc,riskDistance,entryPrice,maxNotionalPctEquity,minStopPct})` → `{ok:true,size,notionalUsdt} | {ok:false,reason}`. Root-cause fix for the unbounded-size bug (`order-manager.ts:79 positionSize=riskAmount/riskDistance`): floor `riskDistance` at `max(minStopPct*entry, riskDistance)` AND reject if `notionalUsdt > maxNotionalPctEquity*equity` (defense in depth).
- `checkPreTradeGuards({signalEntry,markPrice,candleCloseMs,nowMs,maxDeviationBps,maxCandleAgeMs})` → reject `mark_deviation` if `|signalEntry-mark|/mark*1e4 > maxDeviationBps` (collar against **mark**, not last — Bybit dual-price/liquidation mechanic); reject `stale_candle` if `nowMs-candleCloseMs > maxCandleAgeMs`.
- `data-feed.ts`: `getLatestPrice(symbol, nowMs, maxAgeMs)` returns `null` when stale instead of blind close; add crossed/zero-volume sanity (`high>=low>0, low<=close<=high`). NEW `getMarkPrice(symbol)` via `/v5/market/tickers` `markPrice`, cached 5s.
- `openPosition`/`openLTFPosition` become thin callers: on `!ok` return null (+ emit skipped_signal once Task 4 table exists; until then log+alert).
- **Live-only.** Do NOT add to `backtest-confluence.ts`.

**Defaults:** `maxNotionalPctEquity=2.0`, `minStopPct=0.001` (0.10%), `maxDeviationBps=50` (0.50%, start loose, tighten via skipped-signal log), `maxCandleAgeMs=5_400_000` (90 min = 1.5× 1h bar).

- [ ] **Step 1 — Failing tests** `tests/bot/guards.test.ts` (table-driven `it.each`):
  1. REGRESSION: `riskDistance=0.0001, equity=10_000, riskPerTrade=0.003, symbolAlloc=0.40` → expect `reason==='unbounded_size'` or size clamped so `notionalUsdt<=cap` (fails on current `order-manager.ts:79`).
  2. `riskDistance` exactly at `minStopPct*entry` floor → `ok:true` (pin `>` vs `>=`).
  3. deviation `=== maxDeviationBps` → ok; `+1bp` → `mark_deviation` (boundary both sides).
  4. candle age `=== maxAgeMs` → ok; `+1ms` → `stale_candle`.
  5. notional `=== cap` → ok; `+epsilon` → `max_notional`.
  6. crossed candle `high<low` → sanity reject.
  7. healthy signal → `ok:true` with expected size = `equity*riskPerTrade*symbolAlloc/riskDistance`.
  `tests/bot/data-feed-freshness.test.ts`: mock `fetchCandles` → stale-timestamp candle ⇒ `getLatestPrice(now,maxAge)` returns null; fresh ⇒ returns close.
- [ ] **Step 2 — Run, verify fail:** `npx vitest run tests/bot/guards.test.ts tests/bot/data-feed-freshness.test.ts`
- [ ] **Step 3 — Implement** `guards.ts` + types + wire `order-manager`/`data-feed`/`config`.
- [ ] **Step 4 — Run, verify green.**
- [ ] **Step 5 — `pnpm typecheck && pnpm lint`.**
- [ ] **Step 6 — Commit:** `gmp "add pre-trade safety gate: notional cap, stop floor, mark collar, stale-candle guard" feat backend`

## Task 2: Migration 0004 — additive schema (shared keystone) — ✅ DONE (`9ce61e5`, 10/10 tests)

**Plan group:** PLAN-B/C/D shared. **Depends on:** none structurally (build before Tasks 3–9 that persist).

**Files:** Modify `src/lib/data/schema.ts`; generate `drizzle/0004_*.sql` via `pnpm db:generate`; apply `pnpm db:migrate`. Test `tests/data/migration-0004.test.ts`.

**Design:** One reviewed additive migration adding ALL new persistence at once (avoids 4 conflicting migrations):
- NEW `bot_kill_switch` `{id integer PK default 1, halted integer default 0, reason text, source text, haltedAt integer, manualReview integer default 1}` (singleton row id=1).
- NEW `decision_log` `{id PK auto, createdAt integer, type text, symbol text, detail text(JSON)}` (append-only at app layer).
- NEW `skipped_signals` `{id PK auto, ts integer, symbol text, reason text, signalEntry real, score real, regime text, detail text(JSON)}`.
- NEW `pnl_cells` `{id PK auto, weekOf integer, regime text, symbol text, confluenceBucket text, exitReason text, n integer, meanNet real, sumNet real, winRate real, sumGross real, sumFunding real, sumFriction real, fundingPctOfGross real}`.
- NEW nullable columns on `bot_trades` (SQLite ALTER ADD COLUMN requires DEFAULT): `grossReturn real default 0, frictionReturn real default 0, fundingReturn real default 0, netReturn real default 0, fundingPaidUsdt real default 0`.
- Optional `bot_ltf_setups` if LTF live.

- [ ] **Step 1 — Failing test** `tests/data/migration-0004.test.ts`: `:memory:` DB + `migrate(db,{migrationsFolder:'./drizzle'})`, assert insert/select round-trips on each new table + new `bot_trades` columns default 0.
- [ ] **Step 2 — Run, verify fail** (`npx vitest run tests/data/migration-0004.test.ts`).
- [ ] **Step 3 — Edit `schema.ts`; `pnpm db:generate`; inspect generated SQL is additive-only (no DROP/RENAME); `pnpm db:migrate`.**
- [ ] **Step 4 — Run, verify green.**
- [ ] **Step 5 — typecheck + lint.**
- [ ] **Step 6 — Commit:** `gmp "add migration 0004: kill-switch, decision-log, skipped-signals, pnl-cells, bot_trades cost columns" feat db`

## Task 3: Forward Trading Loop + hourly equity snapshots — ✅ DONE (`f14241d`, 13/13 tests)

**Plan group:** PLAN-B. **Depends on:** Task 2.

**Files:** Modify `scripts/run-bot.ts` (tick:314 hourly snapshot checkpoint; main() migrate-on-startup; gate the 431-row backtest-dump path behind non-live config), `src/lib/bot/position-tracker.ts` (recordSnapshot:223 mark-to-market open positions; NEW markToMarketEquity), `src/lib/bot/data-feed.ts` (expose lastFeedUpdate), `package.json` (NEW `bot:start`), NEW `ecosystem.config.cjs` (PM2). Tests `tests/bot/forward-loop.test.ts`, `tests/bot/snapshot-cadence.test.ts`, fixture `src/lib/bot/__fixtures__/candles.ts`.

**Design:** Loop code exists but `recordSnapshot()` only fires at start/shutdown/trade-close (→ 2 rows). Fix: record an equity snapshot **once per closed 1h bar** (dedupe by `floor(now/3_600_000)`), mark-to-market of open positions included (matters: `getRollingSharpe` annualizes off snapshot interval). Migrate-on-startup. **Hard-gate the backtest-dump importer behind `mode!=='live'&&mode!=='paper-forward'`** (Knight dead-code lesson) so a forward run can't re-pollute `bot_trades`. PM2 ecosystem for reproducible daemon. Tick interval stays 30s; snapshots hourly. Target: run 2026-06-14 → 2026-09-11 (~2136 hourly snapshots).

- [ ] **Step 1 — Failing tests** (vitest `vi.useFakeTimers()`+`vi.setSystemTime`, `afterEach(vi.useRealTimers())`):
  - `snapshot-cadence.test.ts`: drive 5 simulated hourly bars ⇒ exactly 5 deduped snapshots in `:memory:` DB (not 0, not per-30s).
  - `forward-loop.test.ts`: deterministic `makeSeries` fixture producing one signal ⇒ position opened (bot_positions row), exit hit ⇒ bot_trades row with pnlUSDT, equity updated, snapshot recorded. Mark-to-market: open position + adverse candle ⇒ snapshot equity reflects unrealized loss. Migrate-on-startup round-trips.
- [ ] **Step 2 — Run, verify fail.**
- [ ] **Step 3 — Implement.**
- [ ] **Step 4 — Run, verify green.**
- [ ] **Step 5 — typecheck + lint.**
- [ ] **Step 6 — Commit:** `gmp "forward loop: hourly mark-to-market snapshots, migrate-on-startup, gate backtest-dump path" feat backend`

## Task 3b: Gold / XAU paper sleeve in forward bot

**Depends on:** Task 3. **Open decision (resolve by reading code first):** which gold strategy. Default = **charter sleeves** (F2F daily gold + session/metals legs), **paper**, symbol **XAUTUSDT** (XAUUSDT delisted). **Explicitly NOT** the dropped Run-12 `asian_range_gold` (0/6 on the 11-yr holdout).

**Files:** read `scripts/run-gold-bot.ts`, `scripts/run-metals-bot.ts`, `src/lib/gold/*` first; then wire a gold sleeve into the forward persistence so XAU trades + equity accumulate in the same forward DB for the Sept review. Tests `tests/bot/gold-sleeve.test.ts`.

- [ ] **Step 1 — Read gold modules; write a 6-line design note in PROGRESS.md naming the exact strategy+symbol+cadence chosen and why.**
- [ ] **Step 2 — Failing test:** a deterministic gold candle fixture produces an F2F (or metals) signal ⇒ a paper position persists to the forward DB with `strategy` tagged gold.
- [ ] **Step 3 — Run fail → implement → green → typecheck/lint.**
- [ ] **Step 4 — Commit:** `gmp "add gold/XAU paper sleeve to forward bot (charter F2F+metals, XAUTUSDT, paper)" feat backend`

## Task 4: Review Loop + funding-ledger keystone

**Plan group:** PLAN-D. **Depends on:** Tasks 2, 3.

**Files:** Create `src/lib/cost/funding-ledger.ts` (shared), `src/lib/bot/review.ts`, `scripts/run-weekly-review.ts`; modify `src/lib/bot/position-tracker.ts` (closePosition:152 debit funding, store 4 components, logSkippedSignal, appendDecisionLog), `src/lib/bot/order-manager.ts` (emit skipped_signals on guard reject). Tests `tests/cost/funding-ledger.test.ts`, `tests/bot/review-decomposition.test.ts`, `tests/bot/decision-log-immutable.test.ts`.

**Design:**
- **`funding-ledger.ts` (keystone):** `countFundingSettlements(entryTs,exitTs)` counts 00/08/16 UTC instants in **half-open `(entry,exit]`** (no proration — the canonical backtest overcount bug). `fundingReturn = sign*Σ fundingRate@boundary`, `sign=-1 long / +1 short`. Used by BOTH live `closePosition` and Task 8 backtest = zero sim/live mismatch.
- **4-component decomposition** per trade with audit invariant `gross+friction+funding === net` (float epsilon).
- **Per-cell decomposition** over `(regime × symbol × confluenceBucket × exitReason)`, bucket `confluenceScore` into `[<5,5-6,6-7,7+]`; emit `n, meanNet, sumNet, winRate, sumGross, sumFunding, sumFriction, fundingPctOfGross`; flag `fundingPctOfGross>0.35` or net-flips-negative; require `n>=20` before conclusions.
- **Immutable `decision_log`** (append-only at app layer; code-review rule — no update/delete path). **Skipped-signal logging** for every reject (guards, funding-filter, no-trade-band, regime-suppress).
- **Weekly cron** (`run-weekly-review.ts`, Mondays 00:30 UTC): per-cell report + cold-cohort decay scan (bucket by entry-month, rolling DSR per cohort).

**Defaults:** settlements 00/08/16 UTC half-open; bucket edges `[<5,5-6,6-7,7+]`; `fundingPctOfGross` flag 0.35; min-n 20; cold-cohort window last 60 trades, gate on DSR not raw Sharpe.

- [ ] **Step 1 — Failing tests (funding-ledger FIRST, DI all timestamps):** entry 07:59→exit 08:30 UTC = 1 settlement; 08:01→15:59 = 0; 23:00→next-day 09:00 = 2 (00:00+08:00); entry exactly on 08:00 boundary ⇒ not double-counted (half-open). SIGN: long in positive-funding ⇒ `fundingReturn<0`; short ⇒ `>0`. `review-decomposition`: 3-trade fixture ⇒ `gross+friction+funding===net` per trade and per cell; `fundingPctOfGross` computed; cells `n<20` flagged. `decision-log-immutable`: insert ⇒ no exported update/delete mutates; reads chronological.
- [ ] **Step 2 — Run, verify fail.**
- [ ] **Step 3 — Implement ledger + review + wiring + cron.**
- [ ] **Step 4 — Run, verify green.**
- [ ] **Step 5 — typecheck + lint.**
- [ ] **Step 6 — Commit:** `gmp "review loop: funding ledger keystone, 4-component decomposition, per-cell report, immutable decision log, skipped signals" feat backend`

## Task 5: Retirement Kill-Switch

**Plan group:** PLAN-C. **Depends on:** Tasks 3 (snapshots), 4 (funding-net returns), 1 (heartbeat escalates stale reject).

**Files:** Create `src/lib/bot/kill-switch.ts`; modify `src/lib/bot/risk-engine.ts` (canTrade:51 kill-first; getSharpeMultiplier:373 → deflated; NEW checkRetirementHalt, perSymbolEntryCap), `src/lib/bot/position-tracker.ts` (recordEntry per-symbol, getEntriesInWindow, getRollingDeflatedSharpe), `src/lib/rl/utils/deflated-sharpe.ts` (NEW minTrackRecordLength), `src/lib/bot/config.ts` (NEW RETIREMENT_CONFIG), `scripts/run-bot.ts` (tick:314 read kill before processSymbol; record lastFeedUpdate). Tests `tests/bot/kill-switch.test.ts`, `tests/bot/retirement-halt.test.ts`.

**Design:** Pre-committed halts; do NOT trade the live equity curve. HALT sources (latched, manual reset): (a) out-of-band flag from filesystem sentinel `data/KILL`/`env KILL_SWITCH=1` AND `bot_kill_switch` DB row (survives restart, dashboard-flippable); (b) drawdown ≥ `hardKillDD`; (c) charter 5th-pct path breach (sustained); (d) rolling DSR conclusively insignificant. Anchor `hardKillDD` to **chosen live vol** via `E[MaxDD]=sigma*sqrt(2*ln(T*252))/SR`, `hardKillDD=1.5*max(E[MaxDD], bootstrap-5th-pct-DD)` — frozen at deploy. NOT raw in-sample 63.3% (too deep). Confluence: single Layer-2/regime trip ⇒ SOFT de-risk (halve gross); HARD only when absolute-stop hit OR (DSR conclusive AND regime cause). **MinTRL gate:** until live `n>=MinTRL`, DSR layer only DE-RISKs. Replace raw-Sharpe `getSharpeMultiplier` with deflated (feed rolling Sharpe + trial count into `calculateDeflatedSharpe`, test PSR vs `minAcceptableSharpe`, not zero). Per-symbol entry cap (independent of strategy `cooldownBars`). Kill is **reduce-only** (stops new entries; manages/closes existing).

**Defaults:** `E[MaxDD]≈12.7%` at 12% vol SR~2; `hardKillDD≈19–25%` (NOT 63.3%); `minAcceptableSharpe c=0.5`; PSR 0.95; `maxEntriesPerDay=3/symbol`; `maxConsecutiveLossesPerSymbol=4`→pause symbol; `heartbeatTimeoutMs=7_200_000` (2× bar).

- [ ] **Step 1 — Failing tests** (DI nowMs, in-memory DB): file sentinel ⇒ `canTrade` blocks regardless of equity; DB halted ⇒ same; survives reload; reduce-only (open positions still managed). `retirement-halt`: DD<E[MaxDD] ⇒ no halt; between ⇒ soft mult 0.5; ≥hardKillDD ⇒ HARD. DSR insignificant but `n<MinTRL` ⇒ DE-RISK only; insignificant AND `n>=MinTRL` AND regime cause ⇒ HARD. cumPnl below charter p5 once ⇒ yellow; k consecutive ⇒ red. per-symbol: 3rd entry/24h ⇒ reject, book still trades others. RED-GREEN on `getSharpeMultiplier`: 0.3 rolling Sharpe @100 trials now reduces sizing (DSR≤0) where raw-Sharpe did not.
- [ ] **Step 2 — Run, verify fail.**
- [ ] **Step 3 — Implement.**
- [ ] **Step 4 — Run, verify green.**
- [ ] **Step 5 — typecheck + lint.**
- [ ] **Step 6 — Commit:** `gmp "retirement kill-switch: latched file+DB flag, E[MaxDD] hard halt, deflated-Sharpe de-risk, per-symbol entry cap, reduce-only" feat backend`

## Task 6: Risk Hardening (vol-target, no-trade band, fractional-Kelly, CPPI)

**Plan group:** PLAN-C. **Depends on:** Tasks 4 (funding-net returns — HARD prereq), 5 (shared E[MaxDD]/DSR).

**Files:** Modify `scripts/combine-strategies.ts` (no-trade band in runMethod:287; fractional-Kelly off rolling DSR at vol-target 323-337; rebalance-cost debit), `scripts/run-allocator.ts` (computeSizing:76 CPPI drawdown cut, trailing peak), `src/lib/bot/risk-engine.ts` (NEW getCppiExposureMultiplier). Tests `tests/risk/{vol-targeting,no-trade-band,cppi-cushion}.test.ts`.

**Design:** Mostly hardening existing vol-normalization. **Do NOT build a weighting optimizer** — handcraft is a coin-flip vs equal-weight on the crypto sleeve; lock to equal-weight/ERC. Four layers, all from data strictly **before the bar**: (a) constant-vol targeting — confirm annualization uses true bars/yr (hourly ⇒ ~8760, NOT sqrt(252)); (b) **no-trade band** (NEW) — rebalance only if `|cur_lev-tgt_lev|>band`, `band=max(0.10, 0.20*tgt_lev)`; (c) fractional-Kelly off **rolling deflated Sharpe** — `targetVol_used=frac*SR_deflated_rolling`, `frac=0.5`, stand down to 0 if `SR_deflated<=0`; (d) **CPPI** continuous drawdown cut — `exposureMult=clamp(1-(DD-E[MaxDD])/(hardKillDD-E[MaxDD]),0,1)`, trailing-peak floor. **CRITICAL:** all computed on **funding-debited returns** (Task 4 ledger) or Kelly/DSR over-levers. Bound each multiplier; keep discrete circuit-breaker independent so sizing + kill-switch can't deadlock flat. Add ~5bps rebalance-cost debit.

- [ ] **Step 1 — Failing tests:** `vol-targeting`: leverage=`min(targetVol/realizedVol,cap)`, annualization regression (hourly must NOT use sqrt(252)). `no-trade-band`: within band ⇒ 'hold'; outside ⇒ rebalance; turnover reduced vs unconditional. `cppi-cushion`: DD<E[MaxDD] ⇒ 1.0; midpoint ⇒ linear taper; ≥hardKillDD ⇒ 0; trailing-peak floor rises with equity. Fractional-Kelly: `SR_deflated<=0` ⇒ targetVol 0. All assert funding-net inputs (over-levers on gross fixture).
- [ ] **Step 2–4 — fail → implement → green.** **Step 5 — typecheck + lint.**
- [ ] **Step 6 — Commit:** `gmp "risk hardening: no-trade band, fractional-Kelly off rolling DSR, CPPI drawdown cut, funding-net sizing" feat backend`

## Task 7: Tradeability Gate + Regime Re-fit script

**Plan group:** PLAN-A sibling. **Depends on:** Tasks 1 (guards), 4 (skipped_signals).

**Files:** Create `scripts/refit-regime-thresholds.ts` (charter-cadence only, proposes diff, NO auto-apply), modify `src/lib/bot/data-feed.ts` (NEW getOrderbook → spreadBps+depth), `src/lib/bot/guards.ts` (NEW checkTradeability), `src/lib/bot/review.ts` (scoreReliabilityCurve diagnostic), `src/lib/ict/regime-detector.ts` (expose threshold config). Tests `tests/bot/tradeability-gate.test.ts`, `tests/bot/score-reliability-isolation.test.ts`.

**Design:** (a) L2 tradeability reject: `getOrderbook` via `/v5/market/orderbook`; gate `openPosition` — `spreadBps>maxSpreadBps` OR `depthUsdt<minDepthUsdt` at intended notional ⇒ skip + skipped_signal `l2_tradeability`. (b) Regime re-fit: recompute ATR-percentile breakpoints on refreshed data, emit a **proposed `regimeThresholds` diff for human review — never auto-applies** (recency-overfit guard); run only on charter calendar. (c) Score-reliability curve: bin trades by confluenceScore, realized win-rate/expectancy per bin — **DIAGNOSTIC ONLY**, a test asserts sizing is independent of it.

**Defaults:** `maxSpreadBps=5` (majors), `minDepthUsdt=2× intended notional` in top-10 levels; re-fit cadence = 2026-09-11 only; bins `[<5,5-6,6-7,7+]`.

- [ ] **Step 1 — Failing tests:** `tradeability-gate`: tight spread+deep ⇒ ok; wide spread ⇒ reject `l2_tradeability`; thin depth ⇒ reject; both logged. `score-reliability-isolation`: two different reliability inputs ⇒ identical position size. Re-fit: on frozen dataset outputs a diff, does NOT mutate RUN20_STRATEGY_CONFIG.
- [ ] **Step 2–4 — fail → implement → green.** **Step 5 — typecheck + lint.**
- [ ] **Step 6 — Commit:** `gmp "tradeability gate (L2 spread/depth reject) + charter-cadence regime re-fit proposal + score-reliability diagnostic" feat backend`

## Task 8: PROBE — funding-charged backtest, re-confirm Run-20

**Plan group:** PLAN-E. **Depends on:** Task 4 (funding-ledger). **Grounding:** cite the funding-cost mechanism; compare net-WF to the published 69.7% gross.

**Files:** Modify `scripts/backtest-confluence.ts` (calculatePnlPercent:219 add fundingReturn; split friction into maker/taker; CLI `--charge-funding --maker-bps --taker-bps`), reuse `src/lib/cost/funding-ledger.ts`, `src/lib/rl/strategies/confluence-scorer.ts` (expose fundingRateMap lookup by ts), NEW `scripts/research-funding-cost.ts` (emit `experiments/runs/funding-cost-run20.json` + write-up `experiments/funding-cost.md`). Test `tests/cost/backtest-funding-debit.test.ts`.

**Design:** `netPnlPercent = grossPnlPercent + fundingReturn` (realized rate at each crossed settlement, not entry rate, no proration). **GATE:** re-run the exact Run-20 command (MEMORY.md) with funding charged; pass = WF pass-rate stays >60% AND net PnL clearly positive. Document net-WF% beside 69.7% gross. THEN (only if survives) model passive TP as maker, entry/SL as taker; measure post-only TP recovery. Re-check whether the funding entry-filter is still additive once funding is a real cost.

- [ ] **Step 1 — Failing test:** fixture trade spanning known 00/08/16 boundaries ⇒ `netPnl=grossPnl+fundingReturn`, sign flips with direction; funding=0 for sub-8h no-boundary trade; TP-exit uses makerBps, SL-exit takerBps.
- [ ] **Step 2–4 — fail → implement → green.** **Step 5 — typecheck + lint.**
- [ ] **Step 6 — Run gate:** `npx tsx scripts/research-funding-cost.ts`; record net-WF% + verdict in `experiments/funding-cost.md` + PROGRESS.md. If gate FAILS, do NOT patch Run-20 — log that Run-20 is re-opened and flag for review.
- [ ] **Step 7 — Commit:** `gmp "PROBE: charge funding in backtest, re-confirm Run-20 net-of-funding edge, maker/taker friction split" feat backend`

## Task 9: PROBE — ATR-stop multi-arm counterfactual

**Plan group:** PLAN-E. **Depends on:** Task 4. Parallelizable with Task 8.

**Files:** Extend `scripts/atr-stop-counterfactual.ts` (chandelier + vertical-barrier arms; per-arm funding debit; emit `experiments/runs/atr-stop-arms.json` + `experiments/atr-stop-arms.md`), reuse `funding-ledger.ts`. Test `tests/research/atr-stop-arms.test.ts`.

**Design:** Multi-arm replay on the SAME Run-20 trade log (no strategy logic recreated): ARM A baseline; ARM B ATR-floored stop (existing); ARM C chandelier (`trail = highest-high-since-entry - k*ATR`, mirror short); ARM D vertical-barrier/time-stop (exit at `min(SL,TP,N-bar)`). **Debit funding per arm** (wider/chandelier hold longer ⇒ more funding; gross comparison falsely favors longest hold). Each arm reports `n, winRate, slRate, meanNetR, fastStopRate, meanFundingR`. DIAGNOSTIC — a winning arm must survive WF/PBO before any live exit change.

**Defaults:** ATR floor k=1.5 (sweep 1.0–3.0); chandelier k=3.0 (2.5–4.0); vertical horizons `[40,80,120,160]`; ATR period 14; maxBars 160.

- [ ] **Step 1 — Failing test:** chandelier long retraces k*ATR below peak ⇒ exit at chandelier level, correct R; vertical-barrier no SL/TP in N bars ⇒ exit at bar-N close; long across 3 positive-funding boundaries ⇒ `meanNetR<grossR`, longer-hold arm shows more funding than baseline; atr_floor RR-preservation invariant.
- [ ] **Step 2–4 — fail → implement → green.** **Step 5 — typecheck + lint.**
- [ ] **Step 6 — Run:** emit JSON + `experiments/atr-stop-arms.md` (compare arms, cite triple-barrier source). **Step 7 — Commit:** `gmp "PROBE: ATR-stop multi-arm counterfactual (chandelier, vertical-barrier) with per-arm funding debit" feat backend`

---

## After all tasks: Research phase (loop continues per preference memory)

When Tasks 1–9 are checked, the loop enters Research mode (does NOT touch the live book):
1. Pick the next-highest-value research track from `experiments/KNOWLEDGE.md`'s open questions, prioritized by mechanism prior (time/mechanism/structural > chart patterns).
2. Ground it in a reputable primary source FIRST (web-verify, cite, follow the published spec).
3. Build the experiment as a script under `scripts/research-*.ts`, save results to `experiments/runs/*.json` + a write-up `experiments/*.md`, update `KNOWLEDGE.md`. Failed-but-mechanism-revealing = a win to record.
4. Queue any surviving candidate for the next review cycle. Never auto-deploy.

## Self-Review (run by author)

- **Spec coverage:** Tasks map 1:1 to roadmap items 1–6 + PROBES 7,8,10→Tasks 8,9; item 9 order-flow is harness-only (collector already running) and lives in the Research phase, not a build task. Gold/XAU added as Task 3b. ✓
- **Keystones built once:** `funding-ledger.ts` (Task 4) reused by Tasks 5,6,8,9; migration 0004 (Task 2) holds all new tables/columns. ✓
- **Type consistency:** `GuardResult`/`RejectReason` (Task 1) reused by Task 7 tradeability; `ReturnDecomposition` (Task 4) reused by Tasks 8/9; `E[MaxDD]`/`hardKillDD` shared Tasks 5/6. ✓
- **Open risks tracked:** charter-window race, Run-20-may-not-survive-funding (sequence 4+8 early), E[MaxDD] needs funding-net sigma, over-collaring starves fills, decision-log app-immutability, backtest-dump re-pollution, SQLite single-writer, L2 rate-limits, sizing-stack deadlock-to-flat → all noted in PROGRESS.md risk register.
