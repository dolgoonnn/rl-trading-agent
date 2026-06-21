# Simulation Engine — Spec 1: Shared Core, Correctness, Reconciliation

- **Status:** Draft for review
- **Date:** 2026-06-21
- **Author:** Claude + dolgoonnn
- **Branch:** TBD at implementation (proposed `ftr/sim-engine-core`)
- **Supersedes:** none (new initiative)

## Context

The statistics layer of this project is strong (PBO, DSR, walk-forward, Monte Carlo).
The weak layer is **execution simulation**. Three concrete problems:

1. **The simulator is copy-pasted ~5 times.** `simulatePositionSimple/Breakeven/PartialTP/
   MultiTP/Enhanced` in `scripts/backtest-confluence.ts`, two copies in
   `scripts/backtest-scalp.ts`, and the live `OrderManager.checkPositionExit` in
   `src/lib/bot/order-manager.ts`. SL/TP/partial/max-bars logic drifts between them.
2. **Intrabar fills are resolved by a static guess.** `checkSLTPMaxBars`
   (`backtest-confluence.ts:318-332`) and `OrderManager.checkPositionExit`
   (`order-manager.ts:448-461`) check SL→TP within a single candle by fixed ordering
   (SL always wins ties). The 346K 1m candles per crypto symbol that could resolve the
   true intrabar order are ignored.
3. **The backtest is systematically optimistic vs live on entry timing.** The confluence
   backtest enters at the *signal bar's close* (`backtest-confluence.ts` ~line 1108),
   while the live bot acts when a bar closes and fills ~next-bar. The scalp engine already
   enters next-bar-open (`backtest-scalp.ts` ~409-413); confluence never got the fix.

What is already correct and must be **composed, not replaced**:

- `src/lib/cost/funding-ledger.ts` — pure, dependency-injected funding accounting with a
  non-tautological audit invariant. Settlement at 00/08/16 UTC, half-open `(entry, exit]`,
  `-1 long / +1 short` sign, no proration. Shared today by live close + funding backtest.
- `src/lib/cost/trade-cost.ts` — `frictionForExitSide` (maker/taker split) and
  `applyFundingToPnl`. Same purity discipline.

## Goals

- One execution simulator (`simulatePosition`) that is the single source of truth for
  fills, SL/TP resolution, friction, and funding. All backtests and the live exit-check
  delegate to it.
- A pluggable `FillModel` "ladder" that resolves intrabar fills at the **best fidelity the
  available data supports**, reports the tier it achieved, and degrades gracefully to a
  guaranteed pessimistic floor.
- A **reconciliation harness** that diffs simulated fills against the live bot's real
  `bot_trades`, used both as a behavior-preserving safety net for the refactor and as a
  committed regression test for fidelity.

## Non-Goals (explicitly deferred)

- **Event-driven engine** + `IClock` / `IDataFeed` / `IExecutionClient` / `IEventBus`
  abstractions and backtest-live code sharing below the strategy → **Spec 3**.
- **L2-depth fills, signal→fill latency model, LOB queue position.** These require the
  event loop (latency = an inflight-command queue; queue = a matching engine) and cannot
  live in a bar loop. The `FillModel` interface *reserves the seam* for them; they are
  implemented in **Spec 3** and fed by **Spec 5**.
- **Speed work** (columnar `Float64Array`, `worker_threads`/`SharedArrayBuffer`,
  incremental indicators) → **Spec 4**.
- **L2 data collection expansion** (more symbols, continuous capture) → **Spec 5**.

## Architecture

New package `src/lib/sim/`, the single source of execution truth:

```
src/lib/sim/
  types.ts        SimPosition, Fill, ExitReason, FidelityTier, BarFillRequest, FillResult,
                  SubBarProvider, SpreadProvider
  fill-model.ts   FillModel interface + DefaultFillModel (ladder selector + cost application)
  intrabar.ts     subBarResolve(), ohlcHeuristicResolve(), pessimisticResolve()
  cost-model.ts   applyCost(): spread + fee + sqrt-impact; composes trade-cost.ts
  simulator.ts    simulatePosition(): the ONE loop replacing all 5 copies
  reconcile.ts    loadLiveTrades(), replayTrade(), diffTrades(), reconcileReport()
  index.ts        public exports
scripts/
  reconcile-sim.ts   CLI: per-symbol/per-window reconciliation report + tolerance gate
```

Consumers refactored to delegate: `backtest-confluence.ts`, `backtest-scalp.ts`,
`order-manager.ts:checkPositionExit`.

The simulator is **pure and dependency-injected** — no `Date.now`, no `fetch`, no DB.
Sub-bars, funding rates, and spreads arrive through injected providers, exactly like the
existing cost keystones.

## Component design

### `types.ts`

```ts
export type ExitReason = 'stop_loss' | 'take_profit' | 'max_bars' | 'strategy';
export type FidelityTier = 'l2_depth' | 'subbar_1m' | 'ohlc_heuristic' | 'pessimistic';
export type EntryTiming = 'signal_close' | 'next_open';

export interface SimPosition {
  direction: 'long' | 'short';
  entryPrice: number;        // raw signal price (pre-cost)
  entryTimestamp: number;
  entryIndex: number;
  stopLoss: number;
  takeProfit: number;
  currentSL: number;         // mutable for breakeven/trailing
  strategy: string;
  partialTaken: boolean;
}

export interface BarFillRequest {
  position: SimPosition;
  bar: Candle;               // execution-TF bar (e.g. 1h)
  barMs: number;
  barsHeld: number;
  maxBars: number;
  subBars?: Candle[];        // 1m candles inside `bar`, when available
}

export interface FillResult {
  exitPrice: number;         // pre-cost fill level (SL/TP level or close)
  exitReason: ExitReason;
  fillTimestamp: number;
  tier: FidelityTier;        // fidelity actually achieved for THIS resolution
}

/** 1m candles strictly inside [barTs, barTs + barMs). Empty when none exist. */
export interface SubBarProvider {
  subBarsFor(symbol: string, barTs: number, barMs: number): Candle[];
}
/** Estimated half-spread (fraction) at a timestamp; from orderflow or a candle proxy. */
export interface SpreadProvider {
  halfSpreadAt(symbol: string, ts: number): number;
}
```

### `fill-model.ts`

```ts
export interface FillModel {
  /** Resolve whether/where this bar exits the position. null = still open. */
  resolveExit(req: BarFillRequest): FillResult | null;
  /** Realized fill price after spread + fee + impact for an order at `refPrice`. */
  applyCost(refPrice: number, side: 'entry' | 'exit', dir: 'long' | 'short',
            ctx: CostContext): number;
}
```

`DefaultFillModel.resolveExit` selects the tier **best-available-wins, with a floor**:

| Tier | Driven by | Spec 1 status |
|---|---|---|
| `subbar_1m` | 1m candles inside the exec bar → true SL-vs-TP order | **Implemented** |
| `ohlc_heuristic` | open-proximity O→H→L→C guess (~75-85% sequence accuracy) | **Implemented** |
| `pessimistic` | SL-first worst case (current behavior) | **Implemented** (floor) |
| `l2_depth` | orderflow depth + spread, queue, latency | **Interface reserved** (Spec 3) |

Selection logic: if `req.subBars` non-empty → `subBarResolve`; else if config allows the
heuristic → `ohlcHeuristicResolve`; else `pessimisticResolve`. Max-bars timeout is checked
in all tiers (exit at bar close when `barsHeld >= maxBars`).

### `intrabar.ts`

- `pessimisticResolve` — current logic: SL checked before TP; on tie, SL fills. The
  guaranteed floor and the back-compat default.
- `ohlcHeuristicResolve` — if `|open-high| < |open-low|` assume path `O→H→L→C`, else
  `O→L→H→C`; resolve whichever of SL/TP the assumed path reaches first.
- `subBarResolve` — walk the injected 1m candles in order; the first 1m candle whose
  range touches SL or TP determines the exit level, reason, and timestamp. This is the
  most accurate input and uses data already owned. When a 1m candle straddles both levels,
  fall back to `pessimisticResolve` *within that 1m candle* (recursion floor — we have no
  sub-1m data).

### `cost-model.ts`

`applyCost` replaces the flat `--friction` markup with a layered, calibration-ready model:

1. **Fee + half-spread floor (always):** taker fee per side + half-spread on both legs.
   Half-spread from `SpreadProvider` (orderflow `spreadBps` when present, else a
   per-symbol candle-derived proxy). A passive TP exit pays the maker leg
   (reuse `frictionForExitSide`).
2. **Square-root market impact (gated):** add `Y · σ · sqrt(Q/V)` only when order size Q is
   a non-trivial fraction of bar volume V; ~0 for small Q/V. `Y` per-symbol, default ~0.5.
3. **Fill-volume cap:** reject/penalize fills exceeding ~2.5% of bar volume.

Funding is **not** in `applyCost`; it is applied once at trade close over `(entry, exit]`
via the existing `applyFundingToPnl` / `funding-ledger`. The simulator returns the full
`gross / friction / funding / net` decomposition through `decomposeReturn`.

**Calibration contract:** the cost model's defaults are tuned so the reconciliation harness
(Mode 2) reproduces live `bot_trades` within tolerance; it ships ~slightly pessimistic
relative to the calibrated point (safety margin).

### `simulator.ts`

```ts
export function simulatePosition(
  position: SimPosition,
  candles: Candle[],
  startIndex: number,
  deps: {
    fillModel: FillModel;
    subBars?: SubBarProvider;
    funding?: FundingSettlementSeries;
    symbol: string;
    config: SimConfig;   // entryTiming, maxBars, partialTP, exitMode, costs...
  },
): TradeResult | null;
```

Flow:

1. **Entry:** `refEntry = config.entryTiming === 'next_open' ? candles[startIndex].open :
   position.entryPrice`; `adjustedEntry = fillModel.applyCost(refEntry, 'entry', dir, ctx)`.
2. **Loop bars** from `startIndex`: build `BarFillRequest` (inject `subBars` for the bar);
   handle partial-TP / breakeven / trailing mutations of `currentSL`; call
   `fillModel.resolveExit`. On a `FillResult`, `adjustedExit = applyCost(exitPrice, 'exit',
   …)`, compute gross PnL, then funding over `(entryMs, exitMs]`, then `decomposeReturn`.
3. **End:** if no exit, close at last candle close (`closeAtEnd` semantics preserved).

The strategy-specific exits (`enhanced` mode) are injected as an optional
`strategyExit(position, candle): ExitReason | null` hook so the one loop covers all modes
without re-duplicating.

### `reconcile.ts` + `scripts/reconcile-sim.ts` — the oracle

Two modes:

- **Mode 1 — Parity regression (characterization safety net).** Before changing behavior:
  capture golden JSON outputs of the current backtests (Run 20 config) and the current
  `bot_trades`. The 5→1 consolidation must reproduce the golden backtest outputs
  **bit-for-bit** (Red→Green: write golden test, refactor, stays green). This is how the
  duplicated simulators are collapsed safely.
- **Mode 2 — Live calibration / regression.** For each `bot_trades` row, reconstruct the
  entry context (we have `entryPrice`, `stopLoss`, `takeProfit`, `strategy`,
  `confluenceScore`, `entryTimestamp`, `barsHeld`) and replay it through the sim. Diff
  `exitPrice`, `exitReason`, `barsHeld`, and `gross/friction/funding/net` per trade.
  Emit a report: per-trade deltas, distributions, and pass/fail vs tolerances. Suggested
  starting tolerances (revise once real deltas are observed): per-trade
  `|sim_net − live_net| < 5 bps`, exit-reason match-rate `> 95%`, `barsHeld` exact match
  `> 90%`. Commit it as a regression test so fidelity cannot silently rot.

## Correctness fixes (all behind explicit config, all re-validated)

1. **Intrabar tie resolution** — `subbar_1m` replaces the static SL-first guess wherever 1m
   exists; falls back to `pessimistic` (today's behavior) when absent, so gold/forex are
   unchanged silently.
2. **Entry timing** — `entryTiming` defaults to `signal_close` initially (existing numbers
   reproducible). Reconciliation quantifies the live gap; then flip to `next_open` and
   **re-validate Run 20** under the corrected model rather than silently moving the deployed
   edge. The re-validation result is recorded in memory/experiments.
3. **5 → 1 consolidation** — collapse all simulator copies into `simulatePosition` with the
   `strategyExit` hook. `OrderManager.checkPositionExit` delegates to `FillModel.resolveExit`
   / `applyCost` (highest-risk change; gated by characterization tests proving identical
   live-path behavior).

## Testing & verification

- **Unit:** `intrabar.ts` — synthetic bars where the 1m path makes SL-first *wrong*
  (proves the fix bites); `cost-model.ts` — spread/fee/impact math; funding composition
  (reuse existing ledger tests).
- **Characterization:** golden backtest outputs for Run 20 — refactor preserves them.
- **Reconciliation:** the harness on real `bot_trades`, asserted under tolerance.
- **Gate (CLAUDE.md rule):** `pnpm typecheck` + `pnpm test` green, with before/after
  backtest output diffs shown, before anything is called done. No `any`.

## Risks

- **Live path refactor** (`OrderManager.checkPositionExit`) touches production trading code.
  Mitigation: characterization tests + Mode-1 parity regression must pass before merge.
- **Entry-timing flip invalidates Run 20's published numbers.** Mitigation: it is a
  deliberate, measured re-validation, not a silent change; default stays `signal_close`
  until the re-validation is done and recorded.
- **Cost-model over-fitting to 5 days / one symbol of orderflow.** Mitigation: ship
  conservative defaults; calibration is bounded by tolerance, not point-matched; broaden
  with Spec 5 data.

## Definition of done

- `src/lib/sim/` exists; all five simulator copies deleted and delegating to it.
- `subbar_1m` intrabar resolution active for crypto; `pessimistic` floor for the rest.
- `entryTiming` configurable; live gap quantified; Run-20 re-validation under `next_open`
  recorded.
- Reconciliation harness committed, run on `bot_trades`, passing under tolerance, wired as
  a regression test.
- `pnpm typecheck` + `pnpm test` green; before/after backtest diffs shown.
