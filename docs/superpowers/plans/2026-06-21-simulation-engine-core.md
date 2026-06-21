# Simulation Engine Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the ~5 duplicated trade simulators into one shared `src/lib/sim/` core with a pluggable `FillModel` ladder, fix the intrabar-tie and entry-timing correctness bugs using the 1m data already owned, and build a reconciliation harness that diffs simulated fills against the live bot's real `bot_trades`.

**Architecture:** A new pure, dependency-injected `src/lib/sim/` package owns all execution truth. `simulatePosition()` is the single loop; a `FillModel` resolves intrabar exits at the best fidelity the available data supports (`subbar_1m` → `ohlc_heuristic` → `pessimistic` floor; `l2_depth` seam reserved for Spec 3) and a `CostModel` applies spread+fee+impact. Funding is composed from the existing `src/lib/cost/funding-ledger.ts` keystone, never re-implemented. The two backtest scripts and the live `OrderManager.checkPositionExit` are refactored to delegate, guarded by golden parity-regression tests so the consolidation is behavior-preserving.

**Tech Stack:** TypeScript (strict), Vitest, Drizzle ORM + better-sqlite3, pnpm. Path alias `@/` → `src/`. Tests live under `tests/<area>/`.

## Global Constraints

- **TypeScript strict; no `any`.** Use proper narrowing or `unknown` (project rule). `as any` is banned.
- **Sim core is PURE + dependency-injected:** no `Date.now()`, no `fetch`, no DB access inside `src/lib/sim/{types,intrabar,cost-model,fill-model,simulator}.ts`. Timestamps, funding rates, sub-bars, and spreads are injected — same discipline as `src/lib/cost/funding-ledger.ts`. (`reconcile.ts` and `scripts/reconcile-sim.ts` MAY touch the DB; they are the impure edge.)
- **Compose, do not duplicate:** funding via `fundingReturn`/`applyFundingToPnl` (`src/lib/cost/funding-ledger.ts`, `src/lib/cost/trade-cost.ts`); friction-split via `frictionForExitSide`. Never re-derive the funding settlement rule.
- **Canonical result shape** is `TradeResult` = `{ entryTimestamp:number, exitTimestamp:number, direction:'long'|'short', entryPrice:number, exitPrice:number, pnlPercent:number, strategy?:string }` (`scripts/walk-forward-validate.ts:64`). The sim's `SimTradeResult` MUST be structurally assignable to it (extra fields optional).
- **Behavior preservation:** the existing 322 passing tests stay green; new behavior changes (`subbar_1m`, `next_open`) ship behind explicit config and default to current behavior (`pessimistic` floor where 1m absent, `entryTiming:'signal_close'`) until the Run-20 re-validation in the final task.
- **Commits:** use `gmp "message" type scope` (project rule — raw `git commit` is banned). Scope `backend` for code, `docs` for docs.
- **Known-red baseline (do not "fix" here):** `tests/bot/exchange-exit-manager.test.ts` (7, unfinished WIP) and `tests/bot/retirement-halt.test.ts` (1, pre-existing missing-table). These are unrelated to this plan; do not let them block, do not touch them.
- **Verification gate (per task):** `pnpm exec vitest run <files>` green for the task; before claiming a refactor task done, show the before/after backtest metric diff.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/sim/types.ts` | All sim types: `SimExitReason`, `FidelityTier`, `EntryTiming`, `SimLevels`, `BarFillRequest`, `FillResult`, `SubBarProvider`, `SpreadProvider`, `CostContext`, `SimConfig`, `SimTradeResult` |
| `src/lib/sim/intrabar.ts` | Pure intrabar resolvers: `pessimisticResolve`, `ohlcHeuristicResolve`, `subBarResolve` |
| `src/lib/sim/cost-model.ts` | `CostModel` interface; `FlatFrictionCostModel` (parity); `SpreadFeeImpactCostModel` (calibratable) |
| `src/lib/sim/fill-model.ts` | `FillModel` interface; `DefaultFillModel` (tier selection + cost) |
| `src/lib/sim/simulator.ts` | `simulatePosition()` — the one loop (all exit modes, entry timing, funding) |
| `src/lib/sim/reconcile.ts` | Impure edge: `loadLiveTrades`, `replayTrade`, `diffTrades`, `reconcileReport` |
| `src/lib/sim/index.ts` | Public exports |
| `scripts/reconcile-sim.ts` | CLI for the reconciliation oracle |
| `tests/sim/*.test.ts` | Unit + characterization + reconciliation tests |
| `scripts/backtest-confluence.ts` | MODIFY: delegate the 5 simulate fns to `simulatePosition` |
| `scripts/backtest-scalp.ts` | MODIFY: delegate to `simulatePosition` |
| `src/lib/bot/order-manager.ts` | MODIFY: `checkPositionExit` delegates to `FillModel` |

---

### Task 1: Sim types + pessimistic intrabar resolver (the floor)

Establishes the package, the shared types, and the resolver that **exactly reproduces today's SL-first behavior** — this is the parity floor everything else is measured against.

**Files:**
- Create: `src/lib/sim/types.ts`
- Create: `src/lib/sim/intrabar.ts`
- Create: `src/lib/sim/index.ts`
- Test: `tests/sim/intrabar.test.ts`

**Interfaces:**
- Consumes: `Candle` from `@/types/candle`.
- Produces:
  - `type SimExitReason = 'stop_loss' | 'take_profit' | 'max_bars' | 'strategy'`
  - `type FidelityTier = 'l2_depth' | 'subbar_1m' | 'ohlc_heuristic' | 'pessimistic'`
  - `type EntryTiming = 'signal_close' | 'next_open'`
  - `interface SimLevels { direction:'long'|'short'; stopLoss:number; takeProfit:number }`
  - `interface BarFillRequest { levels:SimLevels; bar:Candle; barsHeld:number; maxBars:number; subBars?:Candle[] }`
  - `interface FillResult { exitPrice:number; exitReason:SimExitReason; fillTimestamp:number; tier:FidelityTier }`
  - `function pessimisticResolve(req: BarFillRequest): FillResult | null`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sim/intrabar.test.ts
import { describe, it, expect } from 'vitest';
import { pessimisticResolve } from '@/lib/sim/intrabar';
import type { BarFillRequest } from '@/lib/sim/types';
import type { Candle } from '@/types/candle';

function bar(o: number, h: number, l: number, c: number, ts = 1_000): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 100 };
}

describe('pessimisticResolve', () => {
  it('long: when both SL and TP are inside the bar range, SL wins (pessimistic floor)', () => {
    const req: BarFillRequest = {
      levels: { direction: 'long', stopLoss: 95, takeProfit: 110 },
      bar: bar(100, 115, 90, 105, 7_000), barsHeld: 1, maxBars: 100,
    };
    const r = pessimisticResolve(req);
    expect(r).not.toBeNull();
    expect(r!.exitReason).toBe('stop_loss');
    expect(r!.exitPrice).toBe(95);
    expect(r!.tier).toBe('pessimistic');
    expect(r!.fillTimestamp).toBe(7_000);
  });

  it('long: TP only -> take_profit at TP level', () => {
    const r = pessimisticResolve({
      levels: { direction: 'long', stopLoss: 80, takeProfit: 110 },
      bar: bar(100, 115, 99, 112), barsHeld: 1, maxBars: 100,
    });
    expect(r!.exitReason).toBe('take_profit');
    expect(r!.exitPrice).toBe(110);
  });

  it('short: SL wins tie (SL above), at SL level', () => {
    const r = pessimisticResolve({
      levels: { direction: 'short', stopLoss: 110, takeProfit: 90 },
      bar: bar(100, 115, 85, 95), barsHeld: 1, maxBars: 100,
    });
    expect(r!.exitReason).toBe('stop_loss');
    expect(r!.exitPrice).toBe(110);
  });

  it('no level hit and under maxBars -> null', () => {
    const r = pessimisticResolve({
      levels: { direction: 'long', stopLoss: 80, takeProfit: 130 },
      bar: bar(100, 115, 99, 112), barsHeld: 1, maxBars: 100,
    });
    expect(r).toBeNull();
  });

  it('no level hit but maxBars reached -> max_bars at close', () => {
    const r = pessimisticResolve({
      levels: { direction: 'long', stopLoss: 80, takeProfit: 130 },
      bar: bar(100, 115, 99, 112, 9_000), barsHeld: 100, maxBars: 100,
    });
    expect(r!.exitReason).toBe('max_bars');
    expect(r!.exitPrice).toBe(112);
    expect(r!.fillTimestamp).toBe(9_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/sim/intrabar.test.ts`
Expected: FAIL — `Cannot find module '@/lib/sim/intrabar'`.

- [ ] **Step 3: Write `types.ts`**

```ts
// src/lib/sim/types.ts
import type { Candle } from '@/types/candle';

export type SimExitReason = 'stop_loss' | 'take_profit' | 'max_bars' | 'strategy';
export type FidelityTier = 'l2_depth' | 'subbar_1m' | 'ohlc_heuristic' | 'pessimistic';
export type EntryTiming = 'signal_close' | 'next_open';

export interface SimLevels {
  direction: 'long' | 'short';
  stopLoss: number;
  takeProfit: number;
}

export interface BarFillRequest {
  levels: SimLevels;
  bar: Candle;
  barsHeld: number;
  maxBars: number;
  /** 1m candles strictly inside [bar.ts, bar.ts + barMs). Present enables subbar_1m. */
  subBars?: Candle[];
}

export interface FillResult {
  exitPrice: number;
  exitReason: SimExitReason;
  fillTimestamp: number;
  tier: FidelityTier;
}
```

- [ ] **Step 4: Write `pessimisticResolve` in `intrabar.ts`**

```ts
// src/lib/sim/intrabar.ts
import type { BarFillRequest, FillResult } from './types';

/**
 * The parity FLOOR: SL is checked before TP within a single candle, so on a
 * straddle the SL fills (worst case). Byte-for-byte the current behavior of
 * `checkSLTPMaxBars` in scripts/backtest-confluence.ts and the live
 * OrderManager.checkPositionExit. Max-bars exits at close.
 */
export function pessimisticResolve(req: BarFillRequest): FillResult | null {
  const { levels, bar, barsHeld, maxBars } = req;
  if (levels.direction === 'long') {
    if (bar.low <= levels.stopLoss) {
      return { exitPrice: levels.stopLoss, exitReason: 'stop_loss', fillTimestamp: bar.timestamp, tier: 'pessimistic' };
    }
    if (bar.high >= levels.takeProfit) {
      return { exitPrice: levels.takeProfit, exitReason: 'take_profit', fillTimestamp: bar.timestamp, tier: 'pessimistic' };
    }
  } else {
    if (bar.high >= levels.stopLoss) {
      return { exitPrice: levels.stopLoss, exitReason: 'stop_loss', fillTimestamp: bar.timestamp, tier: 'pessimistic' };
    }
    if (bar.low <= levels.takeProfit) {
      return { exitPrice: levels.takeProfit, exitReason: 'take_profit', fillTimestamp: bar.timestamp, tier: 'pessimistic' };
    }
  }
  if (barsHeld >= maxBars) {
    return { exitPrice: bar.close, exitReason: 'max_bars', fillTimestamp: bar.timestamp, tier: 'pessimistic' };
  }
  return null;
}
```

- [ ] **Step 5: Write `index.ts`**

```ts
// src/lib/sim/index.ts
export * from './types';
export * from './intrabar';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm exec vitest run tests/sim/intrabar.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck` (expect no NEW errors vs baseline).
```bash
git add src/lib/sim/types.ts src/lib/sim/intrabar.ts src/lib/sim/index.ts tests/sim/intrabar.test.ts
gmp "add sim package: types + pessimistic intrabar resolver (parity floor)" feat backend
```

---

### Task 2: OHLC open-proximity heuristic resolver

For bars with no 1m data (gold/forex/pre-2024 crypto): guess the intrabar path from where the open sits relative to high/low.

**Files:**
- Modify: `src/lib/sim/intrabar.ts`
- Test: `tests/sim/intrabar.test.ts` (append)

**Interfaces:**
- Consumes: `BarFillRequest`, `FillResult` (Task 1).
- Produces: `function ohlcHeuristicResolve(req: BarFillRequest): FillResult | null` — tier `'ohlc_heuristic'`.

- [ ] **Step 1: Write the failing test (append to `tests/sim/intrabar.test.ts`)**

```ts
import { ohlcHeuristicResolve } from '@/lib/sim/intrabar';

describe('ohlcHeuristicResolve', () => {
  // Open near HIGH => assume path O->H->L->C. A long whose TP and SL both sit
  // in range should fill TP first (high reached before low).
  it('long, open near high: TP fills first on a straddle', () => {
    const r = ohlcHeuristicResolve({
      levels: { direction: 'long', stopLoss: 95, takeProfit: 110 },
      bar: { timestamp: 1, open: 113, high: 115, low: 90, close: 100, volume: 1 },
      barsHeld: 1, maxBars: 100,
    });
    expect(r!.exitReason).toBe('take_profit');
    expect(r!.tier).toBe('ohlc_heuristic');
  });

  // Open near LOW => assume path O->L->H->C. Same straddle now fills SL first.
  it('long, open near low: SL fills first on a straddle', () => {
    const r = ohlcHeuristicResolve({
      levels: { direction: 'long', stopLoss: 95, takeProfit: 110 },
      bar: { timestamp: 1, open: 92, high: 115, low: 90, close: 100, volume: 1 },
      barsHeld: 1, maxBars: 100,
    });
    expect(r!.exitReason).toBe('stop_loss');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/sim/intrabar.test.ts`
Expected: FAIL — `ohlcHeuristicResolve is not a function`.

- [ ] **Step 3: Implement `ohlcHeuristicResolve`**

```ts
// append to src/lib/sim/intrabar.ts
import type { Candle } from '@/types/candle';

/** First of {SL,TP} reached along an assumed ordered path of price extremes. */
function firstHitAlongPath(
  req: BarFillRequest, path: ['high' | 'low', 'high' | 'low'], tier: 'ohlc_heuristic',
): FillResult | null {
  const { levels, bar } = req;
  for (const leg of path) {
    if (levels.direction === 'long') {
      if (leg === 'low' && bar.low <= levels.stopLoss) {
        return { exitPrice: levels.stopLoss, exitReason: 'stop_loss', fillTimestamp: bar.timestamp, tier };
      }
      if (leg === 'high' && bar.high >= levels.takeProfit) {
        return { exitPrice: levels.takeProfit, exitReason: 'take_profit', fillTimestamp: bar.timestamp, tier };
      }
    } else {
      if (leg === 'high' && bar.high >= levels.stopLoss) {
        return { exitPrice: levels.stopLoss, exitReason: 'stop_loss', fillTimestamp: bar.timestamp, tier };
      }
      if (leg === 'low' && bar.low <= levels.takeProfit) {
        return { exitPrice: levels.takeProfit, exitReason: 'take_profit', fillTimestamp: bar.timestamp, tier };
      }
    }
  }
  return null;
}

/**
 * Open-proximity heuristic (~75-85% sequence accuracy, per TradingView/Nautilus):
 * if the open is closer to the high, assume O->H->L->C, else O->L->H->C. Then
 * resolve whichever of SL/TP the assumed path reaches first. Max-bars at close.
 */
export function ohlcHeuristicResolve(req: BarFillRequest): FillResult | null {
  const { bar, barsHeld, maxBars } = req;
  const nearHigh = Math.abs(bar.open - bar.high) <= Math.abs(bar.open - bar.low);
  const path: ['high' | 'low', 'high' | 'low'] = nearHigh ? ['high', 'low'] : ['low', 'high'];
  const hit = firstHitAlongPath(req, path, 'ohlc_heuristic');
  if (hit) return hit;
  if (barsHeld >= maxBars) {
    return { exitPrice: bar.close, exitReason: 'max_bars', fillTimestamp: bar.timestamp, tier: 'ohlc_heuristic' };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/sim/intrabar.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sim/intrabar.ts tests/sim/intrabar.test.ts
gmp "add OHLC open-proximity heuristic intrabar resolver" feat backend
```

---

### Task 3: 1m sub-bar intrabar resolver (the correctness fix)

The headline fix: when 1m candles exist inside an exec bar, walk them in order to find the *true* first-touched level — proving the static SL-first guess wrong where it is.

**Files:**
- Modify: `src/lib/sim/intrabar.ts`
- Test: `tests/sim/intrabar.test.ts` (append)

**Interfaces:**
- Consumes: `BarFillRequest` with `subBars: Candle[]`.
- Produces: `function subBarResolve(req: BarFillRequest): FillResult | null` — tier `'subbar_1m'`; falls back to `pessimisticResolve` *within* any single 1m candle that straddles both levels (no sub-1m data).

- [ ] **Step 1: Write the failing test (the killer case)**

```ts
import { subBarResolve } from '@/lib/sim/intrabar';

describe('subBarResolve', () => {
  it('proves SL-first is WRONG: 1m path hits TP before SL on a straddling 1h bar', () => {
    // 1h bar straddles both 95 (SL) and 110 (TP). Pessimistic says stop_loss.
    // But the 1m path goes UP to TP first, THEN down to SL. Truth = take_profit.
    const subBars: Candle[] = [
      { timestamp: 10, open: 100, high: 111, low: 100, close: 110, volume: 1 }, // TP touched here
      { timestamp: 70, open: 110, high: 110, low: 94, close: 96, volume: 1 },   // SL later
    ];
    const r = subBarResolve({
      levels: { direction: 'long', stopLoss: 95, takeProfit: 110 },
      bar: { timestamp: 0, open: 100, high: 111, low: 94, close: 96, volume: 2 },
      barsHeld: 1, maxBars: 100, subBars,
    });
    expect(r!.exitReason).toBe('take_profit');
    expect(r!.exitPrice).toBe(110);
    expect(r!.fillTimestamp).toBe(10);   // the 1m candle that touched first
    expect(r!.tier).toBe('subbar_1m');
  });

  it('single straddling 1m candle falls back to pessimistic (SL) within it', () => {
    const subBars: Candle[] = [
      { timestamp: 10, open: 100, high: 111, low: 94, close: 100, volume: 1 },
    ];
    const r = subBarResolve({
      levels: { direction: 'long', stopLoss: 95, takeProfit: 110 },
      bar: { timestamp: 0, open: 100, high: 111, low: 94, close: 100, volume: 1 },
      barsHeld: 1, maxBars: 100, subBars,
    });
    expect(r!.exitReason).toBe('stop_loss');
    expect(r!.tier).toBe('subbar_1m');
  });

  it('no touch across 1m, under maxBars -> null', () => {
    const subBars: Candle[] = [
      { timestamp: 10, open: 100, high: 105, low: 99, close: 101, volume: 1 },
    ];
    const r = subBarResolve({
      levels: { direction: 'long', stopLoss: 80, takeProfit: 130 },
      bar: { timestamp: 0, open: 100, high: 105, low: 99, close: 101, volume: 1 },
      barsHeld: 1, maxBars: 100, subBars,
    });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/sim/intrabar.test.ts`
Expected: FAIL — `subBarResolve is not a function`.

- [ ] **Step 3: Implement `subBarResolve`**

```ts
// append to src/lib/sim/intrabar.ts

/**
 * Walk the injected 1m candles in time order; the first 1m candle whose range
 * touches SL or TP determines the exit. A 1m candle that straddles BOTH levels
 * has no finer data to disambiguate, so we apply the pessimistic floor WITHIN
 * that candle (SL wins). Max-bars (checked at the exec-bar level) exits at the
 * exec bar close.
 */
export function subBarResolve(req: BarFillRequest): FillResult | null {
  const { levels, bar, barsHeld, maxBars, subBars } = req;
  if (!subBars || subBars.length === 0) return null;

  for (const sub of subBars) {
    const inner = pessimisticResolve({ levels, bar: sub, barsHeld: 0, maxBars: Number.POSITIVE_INFINITY });
    if (inner) {
      return { exitPrice: inner.exitPrice, exitReason: inner.exitReason, fillTimestamp: sub.timestamp, tier: 'subbar_1m' };
    }
  }

  if (barsHeld >= maxBars) {
    return { exitPrice: bar.close, exitReason: 'max_bars', fillTimestamp: bar.timestamp, tier: 'subbar_1m' };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/sim/intrabar.test.ts`
Expected: PASS (10 tests). The first case proves the fix bites: pessimistic would say `stop_loss`, sub-bar says `take_profit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sim/intrabar.ts tests/sim/intrabar.test.ts
gmp "add 1m sub-bar intrabar resolver (true SL/TP ordering)" feat backend
```

---

### Task 4: Cost model — flat-parity + spread/fee/impact

Two cost models: one that reproduces today's friction byte-for-byte (for the parity-regression), and the calibratable one (fee + half-spread + sqrt impact + volume cap).

**Files:**
- Create: `src/lib/sim/cost-model.ts`
- Modify: `src/lib/sim/types.ts` (add `CostContext`)
- Modify: `src/lib/sim/index.ts` (export cost-model)
- Test: `tests/sim/cost-model.test.ts`

**Interfaces:**
- Consumes: `frictionForExitSide`, `MakerTakerConfig` from `@/lib/cost/trade-cost`.
- Produces (in `types.ts`):
  - `interface CostContext { side:'entry'|'exit'; exitSide?:'maker'|'taker'; barVolume?:number; orderQty?:number; halfSpread?:number; volatility?:number }`
- Produces (in `cost-model.ts`):
  - `interface CostModel { apply(refPrice:number, direction:'long'|'short', ctx:CostContext): number }`
  - `class FlatFrictionCostModel implements CostModel` — ctor `(frictionPerSide:number, makerTaker?:MakerTakerConfig|null)`; reproduces `applyEntryFriction`/`applyExitFriction`.
  - `class SpreadFeeImpactCostModel implements CostModel` — ctor `(cfg:{ takerFee:number; makerFee:number; impactCoef:number; maxFillVolumeFrac:number })`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/sim/cost-model.test.ts
import { describe, it, expect } from 'vitest';
import { FlatFrictionCostModel, SpreadFeeImpactCostModel } from '@/lib/sim/cost-model';

describe('FlatFrictionCostModel (parity with current friction)', () => {
  const m = new FlatFrictionCostModel(0.0015); // 0.15% per side, no split

  it('long entry marks price UP by friction', () => {
    expect(m.apply(100, 'long', { side: 'entry' })).toBeCloseTo(100 * 1.0015, 9);
  });
  it('long exit marks price DOWN by friction', () => {
    expect(m.apply(100, 'long', { side: 'exit' })).toBeCloseTo(100 * 0.9985, 9);
  });
  it('short entry marks DOWN, short exit marks UP', () => {
    expect(m.apply(100, 'short', { side: 'entry' })).toBeCloseTo(100 * 0.9985, 9);
    expect(m.apply(100, 'short', { side: 'exit' })).toBeCloseTo(100 * 1.0015, 9);
  });
});

describe('FlatFrictionCostModel with maker/taker split', () => {
  const m = new FlatFrictionCostModel(0.0015, { makerBps: 2, takerBps: 5.5 });
  it('passive TP exit pays the maker leg', () => {
    expect(m.apply(100, 'long', { side: 'exit', exitSide: 'maker' })).toBeCloseTo(100 * (1 - 0.0002), 9);
  });
  it('entry crosses as taker', () => {
    expect(m.apply(100, 'long', { side: 'entry' })).toBeCloseTo(100 * (1 + 0.00055), 9);
  });
});

describe('SpreadFeeImpactCostModel', () => {
  const m = new SpreadFeeImpactCostModel({ takerFee: 0.00055, makerFee: 0.0002, impactCoef: 0.5, maxFillVolumeFrac: 0.025 });
  it('charges taker fee + half-spread on a small order (no impact)', () => {
    const out = m.apply(100, 'long', { side: 'entry', halfSpread: 0.0001, barVolume: 1e9, orderQty: 1 });
    // ~ 100 * (1 + 0.00055 + 0.0001), impact ~ 0
    expect(out).toBeGreaterThan(100 * (1 + 0.00055 + 0.0001) - 1e-6);
    expect(out).toBeLessThan(100 * (1 + 0.00055 + 0.0001) + 1e-3);
  });
  it('adds sqrt impact when order is a real fraction of bar volume', () => {
    const small = m.apply(100, 'long', { side: 'entry', halfSpread: 0, barVolume: 1e6, orderQty: 1 });
    const big = m.apply(100, 'long', { side: 'entry', halfSpread: 0, barVolume: 1e6, orderQty: 10_000 });
    expect(big).toBeGreaterThan(small);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/sim/cost-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `CostContext` to `types.ts`**

```ts
// append to src/lib/sim/types.ts
export interface CostContext {
  side: 'entry' | 'exit';
  /** Which leg an exit fills as. TP exits rest (maker); SL/timeout cross (taker). */
  exitSide?: 'maker' | 'taker';
  /** Bar volume (base units) for impact gating. */
  barVolume?: number;
  /** Order size (base units) for impact gating. */
  orderQty?: number;
  /** Half-spread as a fraction of price (e.g. 0.0001 = 1bp). */
  halfSpread?: number;
  /** Per-bar volatility (fraction) for the sqrt-impact term. */
  volatility?: number;
}
```

- [ ] **Step 4: Implement `cost-model.ts`**

```ts
// src/lib/sim/cost-model.ts
import { frictionForExitSide, type MakerTakerConfig } from '@/lib/cost/trade-cost';
import type { CostContext } from './types';

export interface CostModel {
  apply(refPrice: number, direction: 'long' | 'short', ctx: CostContext): number;
}

/** Sign of the price markup: entry-long / exit-short push price UP; the others DOWN. */
function markup(direction: 'long' | 'short', side: 'entry' | 'exit'): 1 | -1 {
  const up = (direction === 'long' && side === 'entry') || (direction === 'short' && side === 'exit');
  return up ? 1 : -1;
}

/**
 * Reproduces scripts/backtest-confluence.ts applyEntryFriction/applyExitFriction
 * exactly: entry is taker; exit pays maker or taker per ctx.exitSide. With no
 * split, the blended frictionPerSide is used on both legs.
 */
export class FlatFrictionCostModel implements CostModel {
  constructor(private frictionPerSide: number, private makerTaker: MakerTakerConfig | null = null) {}

  apply(refPrice: number, direction: 'long' | 'short', ctx: CostContext): number {
    const side = ctx.side === 'entry' ? 'taker' : (ctx.exitSide ?? 'taker');
    const friction = this.makerTaker === null ? this.frictionPerSide : frictionForExitSide(side, this.makerTaker);
    return refPrice * (1 + markup(direction, ctx.side) * friction);
  }
}

/**
 * Calibratable model: taker/maker fee + half-spread (always), plus square-root
 * market impact gated on order size vs bar volume, capped at maxFillVolumeFrac.
 */
export class SpreadFeeImpactCostModel implements CostModel {
  constructor(private cfg: { takerFee: number; makerFee: number; impactCoef: number; maxFillVolumeFrac: number }) {}

  apply(refPrice: number, direction: 'long' | 'short', ctx: CostContext): number {
    const fee = ctx.side === 'entry' ? this.cfg.takerFee : (ctx.exitSide === 'maker' ? this.cfg.makerFee : this.cfg.takerFee);
    const halfSpread = ctx.halfSpread ?? 0;

    let impact = 0;
    if (ctx.barVolume && ctx.orderQty && ctx.barVolume > 0) {
      const frac = Math.min(ctx.orderQty / ctx.barVolume, this.cfg.maxFillVolumeFrac);
      const sigma = ctx.volatility ?? 1; // caller injects per-bar vol; 1 keeps it size-only when absent
      impact = this.cfg.impactCoef * sigma * Math.sqrt(frac);
    }

    const cost = fee + halfSpread + impact;
    return refPrice * (1 + markup(direction, ctx.side) * cost);
  }
}
```

- [ ] **Step 5: Export from `index.ts`**

```ts
// append to src/lib/sim/index.ts
export * from './cost-model';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm exec vitest run tests/sim/cost-model.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck`
```bash
git add src/lib/sim/cost-model.ts src/lib/sim/types.ts src/lib/sim/index.ts tests/sim/cost-model.test.ts
gmp "add cost models: flat-friction parity + spread/fee/impact" feat backend
```

---

### Task 5: FillModel — tier selection

Wraps the resolvers behind one interface that picks the best tier the data supports and applies cost.

**Files:**
- Create: `src/lib/sim/fill-model.ts`
- Modify: `src/lib/sim/index.ts`
- Test: `tests/sim/fill-model.test.ts`

**Interfaces:**
- Consumes: `pessimisticResolve`/`ohlcHeuristicResolve`/`subBarResolve` (Tasks 1-3); `CostModel` (Task 4).
- Produces:
  - `interface FillModel { resolveExit(req:BarFillRequest): FillResult|null; applyCost(refPrice:number, side:'entry'|'exit', dir:'long'|'short', ctx:Omit<CostContext,'side'>): number }`
  - `class DefaultFillModel implements FillModel` — ctor `(cost:CostModel, opts?:{ allowHeuristic?:boolean })`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/sim/fill-model.test.ts
import { describe, it, expect } from 'vitest';
import { DefaultFillModel } from '@/lib/sim/fill-model';
import { FlatFrictionCostModel } from '@/lib/sim/cost-model';
import type { BarFillRequest } from '@/lib/sim/types';
import type { Candle } from '@/types/candle';

const cost = new FlatFrictionCostModel(0.001);
const straddle: BarFillRequest = {
  levels: { direction: 'long', stopLoss: 95, takeProfit: 110 },
  bar: { timestamp: 0, open: 100, high: 111, low: 94, close: 96, volume: 2 },
  barsHeld: 1, maxBars: 100,
};

describe('DefaultFillModel.resolveExit tier selection', () => {
  it('uses subbar_1m when subBars present', () => {
    const subBars: Candle[] = [
      { timestamp: 10, open: 100, high: 111, low: 100, close: 110, volume: 1 },
      { timestamp: 70, open: 110, high: 110, low: 94, close: 96, volume: 1 },
    ];
    const fm = new DefaultFillModel(cost);
    const r = fm.resolveExit({ ...straddle, subBars });
    expect(r!.tier).toBe('subbar_1m');
    expect(r!.exitReason).toBe('take_profit');
  });

  it('uses ohlc_heuristic when no subBars and heuristic allowed', () => {
    const fm = new DefaultFillModel(cost, { allowHeuristic: true });
    expect(fm.resolveExit(straddle)!.tier).toBe('ohlc_heuristic');
  });

  it('falls to pessimistic floor when heuristic disallowed', () => {
    const fm = new DefaultFillModel(cost, { allowHeuristic: false });
    const r = fm.resolveExit(straddle);
    expect(r!.tier).toBe('pessimistic');
    expect(r!.exitReason).toBe('stop_loss');
  });
});

describe('DefaultFillModel.applyCost', () => {
  it('delegates to the cost model', () => {
    const fm = new DefaultFillModel(cost);
    expect(fm.applyCost(100, 'entry', 'long', {})).toBeCloseTo(100 * 1.001, 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/sim/fill-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fill-model.ts`**

```ts
// src/lib/sim/fill-model.ts
import type { BarFillRequest, FillResult, CostContext } from './types';
import { pessimisticResolve, ohlcHeuristicResolve, subBarResolve } from './intrabar';
import type { CostModel } from './cost-model';

export interface FillModel {
  /** Resolve whether/where this bar exits. null = still open. Records the tier used. */
  resolveExit(req: BarFillRequest): FillResult | null;
  /** Realized fill price after cost for an order at refPrice. */
  applyCost(refPrice: number, side: 'entry' | 'exit', dir: 'long' | 'short', ctx: Omit<CostContext, 'side'>): number;
}

/**
 * Best-available-wins with a guaranteed floor:
 *   subBars present        -> subbar_1m
 *   else allowHeuristic    -> ohlc_heuristic
 *   else                   -> pessimistic
 * The l2_depth rung is reserved for Spec 3 (event-driven engine); it is not
 * selectable here because latency/queue require the event loop.
 */
export class DefaultFillModel implements FillModel {
  constructor(private cost: CostModel, private opts: { allowHeuristic?: boolean } = {}) {}

  resolveExit(req: BarFillRequest): FillResult | null {
    if (req.subBars && req.subBars.length > 0) return subBarResolve(req);
    if (this.opts.allowHeuristic) return ohlcHeuristicResolve(req);
    return pessimisticResolve(req);
  }

  applyCost(refPrice: number, side: 'entry' | 'exit', dir: 'long' | 'short', ctx: Omit<CostContext, 'side'>): number {
    return this.cost.apply(refPrice, dir, { ...ctx, side });
  }
}
```

- [ ] **Step 4: Export + run test**

```ts
// append to src/lib/sim/index.ts
export * from './fill-model';
```
Run: `pnpm exec vitest run tests/sim/fill-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sim/fill-model.ts src/lib/sim/index.ts tests/sim/fill-model.test.ts
gmp "add DefaultFillModel with data-tier fidelity selection" feat backend
```

---

### Task 6: Simulator core — simple mode, entry timing, funding

The one loop, covering the `simple` exit mode first, with `entryTiming` and funding composition. Other exit modes come in Task 7.

**Files:**
- Create: `src/lib/sim/simulator.ts`
- Modify: `src/lib/sim/types.ts` (add `SimPosition`, `SimConfig`, `SimTradeResult`, `SubBarProvider`)
- Modify: `src/lib/sim/index.ts`
- Test: `tests/sim/simulator.test.ts`

**Interfaces:**
- Consumes: `FillModel` (Task 5); `fundingReturn` from `@/lib/cost/funding-ledger`.
- Produces (in `types.ts`):
  - `interface SimPosition { direction:'long'|'short'; entryPrice:number; entryTimestamp:number; entryIndex:number; stopLoss:number; takeProfit:number; strategy:string }`
  - `interface SimConfig { entryTiming:EntryTiming; maxBars:number; barMs:number; exitMode:'simple'|'partial_tp'|'breakeven'|'trailing'; partialTP?:{fraction:number;triggerR:number;beBuffer:number}; trailing?:{activationR:number;distanceR:number} }`
  - `interface SimTradeResult { entryTimestamp:number; exitTimestamp:number; direction:'long'|'short'; entryPrice:number; exitPrice:number; pnlPercent:number; strategy?:string; exitReason:SimExitReason; tier:FidelityTier; grossReturn:number; fundingReturn:number; netReturn:number }`
  - `interface SubBarProvider { subBarsFor(barTs:number, barMs:number): Candle[] }`
- Produces (in `simulator.ts`):
  - `function simulatePosition(position:SimPosition, candles:Candle[], startIndex:number, deps:{ fillModel:FillModel; subBars?:SubBarProvider; rateAt?:(settlementMs:number)=>number; config:SimConfig }): SimTradeResult | null`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sim/simulator.test.ts
import { describe, it, expect } from 'vitest';
import { simulatePosition } from '@/lib/sim/simulator';
import { DefaultFillModel } from '@/lib/sim/fill-model';
import { FlatFrictionCostModel } from '@/lib/sim/cost-model';
import type { SimConfig, SimPosition } from '@/lib/sim/types';
import type { Candle } from '@/types/candle';

const fm = new DefaultFillModel(new FlatFrictionCostModel(0)); // zero cost for clean math
const baseCfg: SimConfig = { entryTiming: 'signal_close', maxBars: 100, barMs: 3_600_000, exitMode: 'simple' };

function c(ts: number, o: number, h: number, l: number, cl: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: 1 };
}

describe('simulatePosition (simple mode)', () => {
  it('long hits TP -> positive pnl at TP', () => {
    const pos: SimPosition = { direction: 'long', entryPrice: 100, entryTimestamp: 0, entryIndex: 0, stopLoss: 95, takeProfit: 110, strategy: 'ob' };
    const candles = [c(0, 100, 101, 99, 100), c(3_600_000, 100, 112, 100, 111)];
    const r = simulatePosition(pos, candles, 1, { fillModel: fm, config: baseCfg });
    expect(r!.exitReason).toBe('take_profit');
    expect(r!.exitPrice).toBe(110);
    expect(r!.pnlPercent).toBeCloseTo(0.10, 9);
  });

  it('entryTiming next_open enters at the next bar open, not the signal close', () => {
    const pos: SimPosition = { direction: 'long', entryPrice: 100, entryTimestamp: 0, entryIndex: 0, stopLoss: 90, takeProfit: 130, strategy: 'ob' };
    // signal bar close = 100; next bar opens at 105. With next_open, entry basis = 105.
    const candles = [c(0, 98, 101, 97, 100), c(3_600_000, 105, 131, 104, 130)];
    const r = simulatePosition(pos, candles, 1, { fillModel: fm, config: { ...baseCfg, entryTiming: 'next_open' } });
    expect(r!.entryPrice).toBe(105);
    expect(r!.pnlPercent).toBeCloseTo((130 - 105) / 105, 9);
  });

  it('funding is composed over crossed settlements (long pays positive rate)', () => {
    // entry at 0 UTC+1h, exit crosses the 08:00 UTC settlement once.
    const entryMs = 3_600_000;                 // 01:00 UTC
    const exitMs = 9 * 3_600_000;              // 09:00 UTC -> crosses 08:00
    const pos: SimPosition = { direction: 'long', entryPrice: 100, entryTimestamp: entryMs, entryIndex: 0, stopLoss: 95, takeProfit: 110, strategy: 'ob' };
    const candles = [c(entryMs, 100, 101, 99, 100), c(exitMs, 100, 112, 100, 111)];
    const r = simulatePosition(pos, candles, 1, {
      fillModel: fm, config: baseCfg,
      rateAt: (ms) => (ms === 8 * 3_600_000 ? 0.0001 : 0), // 1bp at 08:00
    });
    expect(r!.grossReturn).toBeCloseTo(0.10, 9);
    expect(r!.fundingReturn).toBeCloseTo(-0.0001, 9); // long pays
    expect(r!.netReturn).toBeCloseTo(0.10 - 0.0001, 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/sim/simulator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add types to `types.ts`**

```ts
// append to src/lib/sim/types.ts
export interface SimPosition {
  direction: 'long' | 'short';
  entryPrice: number;       // raw signal price (pre-cost)
  entryTimestamp: number;
  entryIndex: number;
  stopLoss: number;
  takeProfit: number;
  strategy: string;
}

export interface SimConfig {
  entryTiming: EntryTiming;
  maxBars: number;
  barMs: number;
  exitMode: 'simple' | 'partial_tp' | 'breakeven' | 'trailing';
  partialTP?: { fraction: number; triggerR: number; beBuffer: number };
  trailing?: { activationR: number; distanceR: number };
}

export interface SimTradeResult {
  entryTimestamp: number;
  exitTimestamp: number;
  direction: 'long' | 'short';
  entryPrice: number;       // cost-adjusted entry
  exitPrice: number;        // cost-adjusted exit
  pnlPercent: number;       // net of cost (gross of funding)
  strategy?: string;
  exitReason: SimExitReason;
  tier: FidelityTier;
  grossReturn: number;      // == pnlPercent (cost already in adjusted prices)
  fundingReturn: number;
  netReturn: number;        // grossReturn + fundingReturn
}

export interface SubBarProvider {
  /** 1m candles strictly inside [barTs, barTs + barMs). Empty when none. */
  subBarsFor(barTs: number, barMs: number): Candle[];
}
```

- [ ] **Step 4: Implement `simulator.ts` (simple mode only)**

```ts
// src/lib/sim/simulator.ts
import type { Candle } from '@/types/candle';
import { fundingReturn } from '@/lib/cost/funding-ledger';
import type { FillModel } from './fill-model';
import type { BarFillRequest, SimConfig, SimPosition, SimTradeResult, SubBarProvider } from './types';

function pnlPercent(adjEntry: number, adjExit: number, dir: 'long' | 'short'): number {
  return dir === 'long' ? (adjExit - adjEntry) / adjEntry : (adjEntry - adjExit) / adjEntry;
}

export function simulatePosition(
  position: SimPosition,
  candles: Candle[],
  startIndex: number,
  deps: {
    fillModel: FillModel;
    subBars?: SubBarProvider;
    rateAt?: (settlementMs: number) => number;
    config: SimConfig;
  },
): SimTradeResult | null {
  const { fillModel, subBars, rateAt, config } = deps;
  const startCandle = candles[startIndex];
  if (!startCandle) return null;

  // Entry basis: signal close (position.entryPrice) or the start bar's open.
  const refEntry = config.entryTiming === 'next_open' ? startCandle.open : position.entryPrice;
  const adjustedEntry = fillModel.applyCost(refEntry, 'entry', position.direction, {});

  for (let i = startIndex; i < candles.length; i++) {
    const bar = candles[i];
    if (!bar) continue;
    const barsHeld = i - position.entryIndex;

    const req: BarFillRequest = {
      levels: { direction: position.direction, stopLoss: position.stopLoss, takeProfit: position.takeProfit },
      bar, barsHeld, maxBars: config.maxBars,
      subBars: subBars?.subBarsFor(bar.timestamp, config.barMs),
    };
    const exit = fillModel.resolveExit(req);
    if (exit) {
      const exitSide = exit.exitReason === 'take_profit' ? 'maker' : 'taker';
      const adjustedExit = fillModel.applyCost(exit.exitPrice, 'exit', position.direction, { exitSide });
      return finish(position, adjustedEntry, adjustedExit, exit.exitReason, exit.fillTimestamp, exit.tier, rateAt);
    }
  }

  // No exit: close at last candle close (taker).
  const last = candles[candles.length - 1];
  if (!last) return null;
  const adjustedExit = fillModel.applyCost(last.close, 'exit', position.direction, { exitSide: 'taker' });
  return finish(position, adjustedEntry, adjustedExit, 'max_bars', last.timestamp, 'pessimistic', rateAt);
}

function finish(
  position: SimPosition, adjustedEntry: number, adjustedExit: number,
  exitReason: SimTradeResult['exitReason'], exitTimestamp: number, tier: SimTradeResult['tier'],
  rateAt?: (settlementMs: number) => number,
): SimTradeResult {
  const gross = pnlPercent(adjustedEntry, adjustedExit, position.direction);
  const funding = rateAt
    ? fundingReturn({ entryMs: position.entryTimestamp, exitMs: exitTimestamp, direction: position.direction, rateAt })
    : 0;
  return {
    entryTimestamp: position.entryTimestamp, exitTimestamp,
    direction: position.direction, entryPrice: adjustedEntry, exitPrice: adjustedExit,
    pnlPercent: gross, strategy: position.strategy, exitReason, tier,
    grossReturn: gross, fundingReturn: funding, netReturn: gross + funding,
  };
}
```

- [ ] **Step 5: Export + run test**

```ts
// append to src/lib/sim/index.ts
export * from './simulator';
```
Run: `pnpm exec vitest run tests/sim/simulator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
```bash
git add src/lib/sim/simulator.ts src/lib/sim/types.ts src/lib/sim/index.ts tests/sim/simulator.test.ts
gmp "add simulatePosition core: simple mode, entry timing, funding" feat backend
```

---

### Task 7: Simulator — partial TP, breakeven, trailing, strategyExit hook

Extend the one loop to cover the remaining exit modes via `config`, so no behavior lives in a second copy.

**Files:**
- Modify: `src/lib/sim/simulator.ts`
- Test: `tests/sim/simulator.test.ts` (append)

**Interfaces:**
- Consumes: `SimConfig.partialTP`, `SimConfig.trailing` (Task 6).
- Produces: extends `simulatePosition` deps with optional `strategyExit?:(position:SimPosition, bar:Candle, barsHeld:number)=>SimExitReason|null`. Adds `partialPnlPercent` to mutable run state (blended into `pnlPercent`).

- [ ] **Step 1: Write the failing test (append)**

```ts
describe('simulatePosition (partial_tp + breakeven)', () => {
  it('takes a partial at triggerR, moves SL to BE+buffer, blends pnl', () => {
    // Long entry 100, SL 90 (risk 10), TP 130. Partial 50% at 1R (price 110),
    // BE buffer 0.1 -> SL moves to 101. Then price falls and stops the remainder at 101.
    const pos = { direction: 'long' as const, entryPrice: 100, entryTimestamp: 0, entryIndex: 0, stopLoss: 90, takeProfit: 130, strategy: 'ob' };
    const candles = [
      c(0, 100, 101, 99, 100),
      c(3_600_000, 100, 111, 100, 110),     // hits 1R -> partial 50% at close 110 (+10%)
      c(7_200_000, 110, 110, 100, 101),     // falls; remainder stopped at new SL 101 (+1%)
    ];
    const r = simulatePosition(pos, candles, 1, {
      fillModel: fm,
      config: { entryTiming: 'signal_close', maxBars: 100, barMs: 3_600_000, exitMode: 'partial_tp',
                partialTP: { fraction: 0.5, triggerR: 1.0, beBuffer: 0.1 } },
    });
    // blended: 0.5 * 10% + 0.5 * 1% = 5.5%
    expect(r!.pnlPercent).toBeCloseTo(0.055, 6);
    expect(r!.exitReason).toBe('stop_loss');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/sim/simulator.test.ts -t partial_tp`
Expected: FAIL — partial logic not implemented (pnl ≈ 0.10 or wrong).

- [ ] **Step 3: Implement partial/breakeven/trailing inside the loop**

Replace the loop body in `simulatePosition` with mutable SL + partial state. Add a `mutableSL` variable initialized to `position.stopLoss`, a `partialTaken` flag, and a `partialPnl` accumulator. Before `resolveExit`, run the partial/trailing checks; pass `mutableSL` into the `levels`.

```ts
// in simulatePosition, before the for-loop:
let mutableSL = position.stopLoss;
let partialTaken = false;
let partialPnl = 0;
let partialFraction = 0;
const rawRisk = position.direction === 'long'
  ? position.entryPrice - position.stopLoss
  : position.stopLoss - position.entryPrice;

// inside the loop, replace `levels` construction and pre-exit logic:
const bar = candles[i];
if (!bar) continue;
const barsHeld = i - position.entryIndex;

// strategy exit hook (enhanced mode) takes priority
const strat = deps.strategyExit?.(position, bar, barsHeld);
if (strat) {
  const adjustedExit = fillModel.applyCost(bar.close, 'exit', position.direction, { exitSide: 'taker' });
  return finishBlended(position, adjustedEntry, adjustedExit, 'strategy', bar.timestamp, 'pessimistic', rateAt, partialTaken, partialFraction, partialPnl);
}

// partial TP: take a fraction at triggerR and move SL to BE+buffer (once)
if (config.exitMode === 'partial_tp' && config.partialTP && !partialTaken && rawRisk > 0) {
  const unrealizedR = position.direction === 'long'
    ? (bar.close - position.entryPrice) / rawRisk
    : (position.entryPrice - bar.close) / rawRisk;
  if (unrealizedR >= config.partialTP.triggerR) {
    const adjPartialExit = fillModel.applyCost(bar.close, 'exit', position.direction, { exitSide: 'maker' });
    partialPnl = pnlPercent(adjustedEntry, adjPartialExit, position.direction);
    partialFraction = config.partialTP.fraction;
    partialTaken = true;
    if (config.partialTP.beBuffer >= 0) {
      const buf = rawRisk * config.partialTP.beBuffer;
      mutableSL = position.direction === 'long'
        ? Math.max(mutableSL, position.entryPrice + buf)
        : Math.min(mutableSL, position.entryPrice - buf);
    }
  }
}

// trailing: once past activationR, trail SL by distanceR * rawRisk from extreme
if (config.exitMode === 'trailing' && config.trailing && rawRisk > 0) {
  const extreme = position.direction === 'long' ? bar.high : bar.low;
  const unrealizedR = position.direction === 'long'
    ? (extreme - position.entryPrice) / rawRisk
    : (position.entryPrice - extreme) / rawRisk;
  if (unrealizedR >= config.trailing.activationR) {
    const trail = config.trailing.distanceR * rawRisk;
    mutableSL = position.direction === 'long'
      ? Math.max(mutableSL, extreme - trail)
      : Math.min(mutableSL, extreme + trail);
  }
}

const req: BarFillRequest = {
  levels: { direction: position.direction, stopLoss: mutableSL, takeProfit: position.takeProfit },
  bar, barsHeld, maxBars: config.maxBars,
  subBars: subBars?.subBarsFor(bar.timestamp, config.barMs),
};
const exit = fillModel.resolveExit(req);
if (exit) {
  const exitSide = exit.exitReason === 'take_profit' ? 'maker' : 'taker';
  const adjustedExit = fillModel.applyCost(exit.exitPrice, 'exit', position.direction, { exitSide });
  return finishBlended(position, adjustedEntry, adjustedExit, exit.exitReason, exit.fillTimestamp, exit.tier, rateAt, partialTaken, partialFraction, partialPnl);
}
```

Add the blended finisher (keep `finish` for the no-partial path or route everything through this):

```ts
function finishBlended(
  position: SimPosition, adjustedEntry: number, adjustedExit: number,
  exitReason: SimTradeResult['exitReason'], exitTimestamp: number, tier: SimTradeResult['tier'],
  rateAt: ((settlementMs: number) => number) | undefined,
  partialTaken: boolean, partialFraction: number, partialPnl: number,
): SimTradeResult {
  const remainderPnl = pnlPercent(adjustedEntry, adjustedExit, position.direction);
  const gross = partialTaken
    ? partialFraction * partialPnl + (1 - partialFraction) * remainderPnl
    : remainderPnl;
  const funding = rateAt
    ? fundingReturn({ entryMs: position.entryTimestamp, exitMs: exitTimestamp, direction: position.direction, rateAt })
    : 0;
  return {
    entryTimestamp: position.entryTimestamp, exitTimestamp,
    direction: position.direction, entryPrice: adjustedEntry, exitPrice: adjustedExit,
    pnlPercent: gross, strategy: position.strategy, exitReason, tier,
    grossReturn: gross, fundingReturn: funding, netReturn: gross + funding,
  };
}
```

Update the deps type to add `strategyExit?`. Route the simple-mode end-of-data close through `finishBlended` with `partialTaken=false`.

- [ ] **Step 4: Run all simulator tests**

Run: `pnpm exec vitest run tests/sim/simulator.test.ts`
Expected: PASS (4 tests — the 3 from Task 6 still green).

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/lib/sim/simulator.ts tests/sim/simulator.test.ts
gmp "extend simulatePosition: partial TP, breakeven, trailing, strategy-exit hook" feat backend
```

---

### Task 8: Parity-regression characterization test (golden)

Lock current behavior before refactoring consumers. Capture a golden set of trades from the *current* `backtest-confluence.ts` on a fixed slice, then assert the new simulator reproduces them under flat-friction + pessimistic + signal_close.

**Files:**
- Create: `tests/sim/fixtures/golden-run20-slice.json` (generated, committed)
- Create: `tests/sim/parity-regression.test.ts`
- Create: `scripts/gen-golden-slice.ts` (one-shot generator; documented, committed)

**Interfaces:**
- Consumes: `simulatePosition` (Tasks 6-7) in flat/pessimistic/signal_close config.
- Produces: a committed fixture + a test that fails if the simulator drifts from the captured golden trades.

- [ ] **Step 1: Write the generator `scripts/gen-golden-slice.ts`**

Generate deterministic positions + their current-engine results on a small fixed window (e.g. BTCUSDT 1h, first 2000 candles). Capture each entry context (`entryPrice`, `stopLoss`, `takeProfit`, `direction`, `entryIndex`, `entryTimestamp`, `strategy`) and the current engine's `TradeResult` (entry/exit price, pnlPercent, exitReason if available). Write to `tests/sim/fixtures/golden-run20-slice.json` as `{ candles: Candle[], positions: SimPosition[], expected: SimTradeResult[] }`.

```ts
// scripts/gen-golden-slice.ts — run once: npx tsx scripts/gen-golden-slice.ts
// Loads data/BTCUSDT_1h.json[0..2000], runs the CURRENT simulatePositionSimple
// over a fixed set of synthetic positions (deterministic SL/TP from ATR), and
// serializes {candles, positions, expected} to the fixture path.
// NOTE: positions are deterministic (seeded from candle index), NOT from the
// scorer, so the golden is stable and scorer-independent.
```

(The implementer writes the concrete loader using the existing `simulatePositionSimple`; positions are deterministic so the golden never depends on signal logic.)

- [ ] **Step 2: Generate and inspect the fixture**

Run: `npx tsx scripts/gen-golden-slice.ts`
Expected: `tests/sim/fixtures/golden-run20-slice.json` created with N≥20 trades.

- [ ] **Step 3: Write the parity test**

```ts
// tests/sim/parity-regression.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { simulatePosition } from '@/lib/sim/simulator';
import { DefaultFillModel } from '@/lib/sim/fill-model';
import { FlatFrictionCostModel } from '@/lib/sim/cost-model';
import type { Candle } from '@/types/candle';
import type { SimPosition, SimTradeResult, SimConfig } from '@/lib/sim/types';

const fixture = JSON.parse(readFileSync('tests/sim/fixtures/golden-run20-slice.json', 'utf-8')) as {
  candles: Candle[]; positions: SimPosition[]; expected: SimTradeResult[];
};

describe('parity-regression: new simulator reproduces current-engine trades', () => {
  // Pessimistic + flat friction + signal_close == current behavior.
  const fm = new DefaultFillModel(new FlatFrictionCostModel(0.0007), { allowHeuristic: false });
  const cfg: SimConfig = { entryTiming: 'signal_close', maxBars: 160, barMs: 3_600_000, exitMode: 'simple' };

  it('matches every golden trade on entry/exit price, pnl, reason', () => {
    fixture.positions.forEach((pos, idx) => {
      const r = simulatePosition(pos, fixture.candles, pos.entryIndex, { fillModel: fm, config: cfg });
      const exp = fixture.expected[idx];
      expect(r).not.toBeNull();
      expect(r!.entryPrice).toBeCloseTo(exp.entryPrice, 6);
      expect(r!.exitPrice).toBeCloseTo(exp.exitPrice, 6);
      expect(r!.pnlPercent).toBeCloseTo(exp.pnlPercent, 9);
      expect(r!.exitReason).toBe(exp.exitReason);
    });
  });
});
```

- [ ] **Step 4: Run the parity test**

Run: `pnpm exec vitest run tests/sim/parity-regression.test.ts`
Expected: PASS. If it fails, the new simulator diverges from current behavior — fix the simulator, not the fixture.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-golden-slice.ts tests/sim/fixtures/golden-run20-slice.json tests/sim/parity-regression.test.ts
gmp "add parity-regression golden fixture + characterization test" test backend
```

---

### Task 9: Refactor `backtest-confluence.ts` to delegate

Replace the local simulate functions with `simulatePosition`. The golden test (Task 8) + the live Run-20 metric diff prove behavior preservation.

**Files:**
- Modify: `scripts/backtest-confluence.ts` (replace `simulatePositionSimple` and the `partial_tp`/`breakeven`/`trailing`/`enhanced` dispatch with `simulatePosition`)

**Interfaces:**
- Consumes: `simulatePosition`, `DefaultFillModel`, `FlatFrictionCostModel`, `SimConfig`, `SimPosition` from `@/lib/sim`.
- Produces: identical `TradeResult[]` (the `SimTradeResult` is structurally assignable).

- [ ] **Step 1: Capture the BEFORE baseline**

Run the deployed Run-20 command (from MEMORY) and save metrics:
```bash
npx tsx scripts/backtest-confluence.ts --strategy ob --sl-mode dynamic_rr --friction 0.0007 \
  --suppress-regime "ranging+normal,ranging+high,downtrend+high" --threshold 4.048 --exit-mode simple \
  --partial-tp "0.50,1.41,0.20" --atr-extension 5.79 --ob-half-life 12 --max-bars 160 --cooldown-bars 7 \
  --json > /tmp/run20-before.json
```
Expected: a JSON metrics blob (WF%, PnL, WR, trade count).

- [ ] **Step 2: Build the sim adapter inside the script**

Add a helper that constructs the fill model + config from the existing CLI flags and calls `simulatePosition`, mapping the existing `SimulatedPosition` to `SimPosition`:

```ts
import { simulatePosition, DefaultFillModel, FlatFrictionCostModel } from '../src/lib/sim';
import type { SimConfig } from '../src/lib/sim';

function buildFillModel(): DefaultFillModel {
  // Preserve current behavior: pessimistic floor (no 1m yet), flat friction (or maker/taker split).
  return new DefaultFillModel(new FlatFrictionCostModel(FRICTION_PER_SIDE, MAKER_TAKER), { allowHeuristic: false });
}
```

- [ ] **Step 3: Replace `simulatePositionSimple` call sites**

Swap the call to the local `simulatePositionSimple`/`...PartialTP`/etc. for `simulatePosition(simPos, candles, startIndex, { fillModel, config })` where `config.exitMode` is derived from `--exit-mode`/`--partial-tp`. Delete the now-dead local simulate functions and `checkSLTPMaxBars`/`applyEntryFriction`/`applyExitFriction` (now in the sim package).

- [ ] **Step 4: Run parity + capture AFTER**

Run: `pnpm exec vitest run tests/sim/parity-regression.test.ts` → PASS.
Run the same Run-20 command → `/tmp/run20-after.json`.
```bash
diff <(jq -S . /tmp/run20-before.json) <(jq -S . /tmp/run20-after.json)
```
Expected: **empty diff** (identical metrics). If non-empty, the refactor changed behavior — investigate before proceeding.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `pnpm typecheck` and `pnpm exec vitest run tests/sim` (all green); confirm the 322 baseline unaffected.
```bash
git add scripts/backtest-confluence.ts
gmp "refactor backtest-confluence to delegate to sim.simulatePosition (parity verified)" refactor backend
```

---

### Task 10: Refactor `backtest-scalp.ts` to delegate

Same delegation for the scalp engine. It already enters next-bar-open, so set `entryTiming:'next_open'` to preserve its behavior.

**Files:**
- Modify: `scripts/backtest-scalp.ts`

**Interfaces:**
- Consumes: `simulatePosition`, `DefaultFillModel`, `FlatFrictionCostModel`.
- Produces: identical scalp `TradeResult[]`.

- [ ] **Step 1: Capture BEFORE**

Run a representative scalp backtest and save metrics:
```bash
npx tsx scripts/backtest-scalp.ts --strategy ict_5m --json > /tmp/scalp-before.json
```

- [ ] **Step 2: Replace the two local simulate functions with `simulatePosition`**

Construct `SimConfig` with `entryTiming: 'next_open'` (scalp's existing semantics, backtest-scalp.ts ~409-413) and `exitMode` from flags. Map the scalp position to `SimPosition`. Delete the local `simulatePositionSimple`/`simulatePositionPartialTP` + friction helpers.

- [ ] **Step 3: Capture AFTER + diff**

```bash
npx tsx scripts/backtest-scalp.ts --strategy ict_5m --json > /tmp/scalp-after.json
diff <(jq -S . /tmp/scalp-before.json) <(jq -S . /tmp/scalp-after.json)
```
Expected: empty diff.

- [ ] **Step 4: Typecheck + commit**

```bash
git add scripts/backtest-scalp.ts
gmp "refactor backtest-scalp to delegate to sim.simulatePosition (parity verified)" refactor backend
```

---

### Task 11: Refactor `OrderManager.checkPositionExit` to delegate (live path)

Highest-risk task. Characterize current live behavior, then delegate exit resolution to the shared `FillModel`, keeping the bot's `ExitReason` mapping.

**Files:**
- Modify: `src/lib/bot/order-manager.ts:436-506`
- Test: `tests/bot/order-manager-exit-parity.test.ts`

**Interfaces:**
- Consumes: `DefaultFillModel`, `FlatFrictionCostModel`, `pessimisticResolve` semantics.
- Produces: `checkPositionExit` returns the same `{ position, exitReason }` for the same inputs; sim `SimExitReason` maps to bot `ExitReason` (`stop_loss`→`stop_loss`, `take_profit`→`take_profit`, `max_bars`→`max_bars`; partial handled in-loop → `partial_tp`).

- [ ] **Step 1: Write a characterization test capturing CURRENT live exit behavior**

```ts
// tests/bot/order-manager-exit-parity.test.ts
import { describe, it, expect } from 'vitest';
// Construct an OrderManager with a known config, a synthetic BotPosition, and
// candles that (a) hit SL, (b) hit TP, (c) straddle (expect SL first today),
// (d) reach maxBars. Assert exitReason for each. These assertions encode the
// CURRENT behavior and must remain green after delegation.
```

Cover the four cases with concrete candles and expected `exitReason` (`stop_loss`, `take_profit`, `stop_loss` on straddle, `max_bars`).

- [ ] **Step 2: Run it against the unchanged code to confirm it passes (captures truth)**

Run: `pnpm exec vitest run tests/bot/order-manager-exit-parity.test.ts`
Expected: PASS against current code.

- [ ] **Step 3: Delegate inside `checkPositionExit`**

Replace the inline SL→TP→maxBars checks (lines 448-461, 501-502) with a `DefaultFillModel` (pessimistic floor, `allowHeuristic:false` — no 1m in the live loop yet) `resolveExit` call built from the candle, mapping the returned `SimExitReason` to the bot `ExitReason`. Keep the partial-TP block (464-498) as-is for now (it mutates `currentSL` and uses `rawEntryPrice`), or route its level checks through the same `pessimisticResolve` for `currentSL`. Keep `applyExitSlippage`/`calculatePnlPercent` for live paper-mode cost.

- [ ] **Step 4: Re-run the characterization test**

Run: `pnpm exec vitest run tests/bot/order-manager-exit-parity.test.ts`
Expected: PASS (behavior unchanged). Then run the existing bot tests:
Run: `pnpm exec vitest run tests/bot`
Expected: no NEW failures (the known-red 8 stay red, nothing else regresses).

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/lib/bot/order-manager.ts tests/bot/order-manager-exit-parity.test.ts
gmp "refactor OrderManager.checkPositionExit to delegate to shared FillModel" refactor backend
```

---

### Task 12: Reconciliation harness + CLI (the oracle)

Replay `bot_trades` through the sim and diff per-trade. The impure edge — it reads the DB.

**Files:**
- Create: `src/lib/sim/reconcile.ts`
- Create: `scripts/reconcile-sim.ts`
- Modify: `src/lib/sim/index.ts`
- Test: `tests/sim/reconcile.test.ts`

**Interfaces:**
- Consumes: `simulatePosition`; `botTrades` rows (`@/lib/data/schema`); candle history.
- Produces:
  - `interface TradeDiff { id:string; symbol:string; simNet:number; liveNet:number; netDelta:number; reasonMatch:boolean; barsHeldMatch:boolean }`
  - `interface ReconcileReport { count:number; meanAbsNetDelta:number; reasonMatchRate:number; barsHeldMatchRate:number; pass:boolean; diffs:TradeDiff[] }`
  - `function diffTrades(sim:SimTradeResult, live:{netReturn:number;exitReason:string;barsHeld:number}, id:string, symbol:string): TradeDiff`
  - `function reconcileReport(diffs:TradeDiff[], tol:{netBps:number;reasonRate:number;barsRate:number}): ReconcileReport`

- [ ] **Step 1: Write the failing test (pure diff/report logic, no DB)**

```ts
// tests/sim/reconcile.test.ts
import { describe, it, expect } from 'vitest';
import { diffTrades, reconcileReport } from '@/lib/sim/reconcile';
import type { SimTradeResult } from '@/lib/sim/types';

function sim(net: number, reason: SimTradeResult['exitReason']): SimTradeResult {
  return { entryTimestamp: 0, exitTimestamp: 1, direction: 'long', entryPrice: 100, exitPrice: 101,
           pnlPercent: net, strategy: 'ob', exitReason: reason, tier: 'pessimistic',
           grossReturn: net, fundingReturn: 0, netReturn: net };
}

describe('reconcile', () => {
  it('diffTrades computes signed net delta + match flags', () => {
    const d = diffTrades(sim(0.0102, 'take_profit'), { netReturn: 0.0100, exitReason: 'take_profit', barsHeld: 5 }, 'T1', 'BTCUSDT');
    expect(d.netDelta).toBeCloseTo(0.0002, 9);
    expect(d.reasonMatch).toBe(true);
  });

  it('reconcileReport passes within tolerance, fails outside', () => {
    const within = reconcileReport(
      [diffTrades(sim(0.0102, 'take_profit'), { netReturn: 0.0100, exitReason: 'take_profit', barsHeld: 5 }, 'T1', 'BTC')],
      { netBps: 5, reasonRate: 0.95, barsRate: 0.90 },
    );
    expect(within.pass).toBe(true);

    const outside = reconcileReport(
      [diffTrades(sim(0.05, 'stop_loss'), { netReturn: 0.0100, exitReason: 'take_profit', barsHeld: 5 }, 'T2', 'BTC')],
      { netBps: 5, reasonRate: 0.95, barsRate: 0.90 },
    );
    expect(outside.pass).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/sim/reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure diff/report core in `reconcile.ts`**

```ts
// src/lib/sim/reconcile.ts (pure core; DB loaders added in Step 5)
import type { SimTradeResult } from './types';

export interface TradeDiff {
  id: string; symbol: string;
  simNet: number; liveNet: number; netDelta: number;
  reasonMatch: boolean; barsHeldMatch: boolean;
}
export interface ReconcileReport {
  count: number; meanAbsNetDelta: number; reasonMatchRate: number; barsHeldMatchRate: number;
  pass: boolean; diffs: TradeDiff[];
}

export function diffTrades(
  sim: SimTradeResult,
  live: { netReturn: number; exitReason: string; barsHeld: number },
  id: string, symbol: string,
  simBarsHeld?: number,
): TradeDiff {
  return {
    id, symbol,
    simNet: sim.netReturn, liveNet: live.netReturn, netDelta: sim.netReturn - live.netReturn,
    reasonMatch: sim.exitReason === live.exitReason,
    barsHeldMatch: simBarsHeld === undefined ? true : simBarsHeld === live.barsHeld,
  };
}

export function reconcileReport(
  diffs: TradeDiff[], tol: { netBps: number; reasonRate: number; barsRate: number },
): ReconcileReport {
  const count = diffs.length;
  const meanAbsNetDelta = count ? diffs.reduce((s, d) => s + Math.abs(d.netDelta), 0) / count : 0;
  const reasonMatchRate = count ? diffs.filter((d) => d.reasonMatch).length / count : 1;
  const barsHeldMatchRate = count ? diffs.filter((d) => d.barsHeldMatch).length / count : 1;
  const pass =
    meanAbsNetDelta <= tol.netBps / 1e4 &&
    reasonMatchRate >= tol.reasonRate &&
    barsHeldMatchRate >= tol.barsRate;
  return { count, meanAbsNetDelta, reasonMatchRate, barsHeldMatchRate, pass, diffs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/sim/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Add DB loaders + CLI `scripts/reconcile-sim.ts`**

Add `loadLiveTrades(db, symbol?)` reading `botTrades` and `replayTrade(row, candles, fillModel, config)` that reconstructs a `SimPosition` from the row (`entryPrice`, `stopLoss`, `takeProfit`, `direction`, `entryTimestamp`, strategy) and runs `simulatePosition` against the cached candle history for that symbol/timeframe. The CLI prints the `ReconcileReport` and exits non-zero when `pass===false`.

```ts
// scripts/reconcile-sim.ts — npx tsx scripts/reconcile-sim.ts [--symbol BTCUSDT]
// 1. open the bot DB (read-only), load botTrades
// 2. load candle history for each symbol (data/<sym>_1h.json + 1m for subbars)
// 3. for each trade: replayTrade -> diffTrades
// 4. reconcileReport with tolerances { netBps: 5, reasonRate: 0.95, barsRate: 0.90 }
// 5. print report; process.exit(report.pass ? 0 : 1)
```

- [ ] **Step 6: Export + typecheck + commit**

```ts
// append to src/lib/sim/index.ts
export * from './reconcile';
```
Run: `pnpm typecheck`
```bash
git add src/lib/sim/reconcile.ts scripts/reconcile-sim.ts src/lib/sim/index.ts tests/sim/reconcile.test.ts
gmp "add reconciliation harness + CLI vs bot_trades" feat backend
```

---

### Task 13: Flip `entryTiming` to `next_open` for confluence + re-validate Run 20

The deliberate, measured behavior change. Quantify the live gap, re-validate the deployed edge under the corrected entry model, and record the result.

**Files:**
- Modify: `scripts/backtest-confluence.ts` (add `--entry-timing` flag, default `signal_close`)
- Create: `experiments/sim-entry-timing-revalidation.md` (results)

**Interfaces:**
- Consumes: `SimConfig.entryTiming`.
- Produces: a documented Run-20 walk-forward comparison `signal_close` vs `next_open`.

- [ ] **Step 1: Add `--entry-timing` flag (default `signal_close`)**

Wire a CLI flag into the `SimConfig.entryTiming` passed to `simulatePosition`. Default preserves current behavior.

- [ ] **Step 2: Run Run-20 walk-forward under both timings**

```bash
npx tsx scripts/walk-forward-validate.ts <run20 args> --entry-timing signal_close --json > /tmp/wf-signal-close.json
npx tsx scripts/walk-forward-validate.ts <run20 args> --entry-timing next_open    --json > /tmp/wf-next-open.json
```
Expected: two WF reports (pass-rate, PnL, WR, trade count).

- [ ] **Step 3: Record the comparison**

Write `experiments/sim-entry-timing-revalidation.md` with both results, the delta, and a recommendation (keep `signal_close` as default vs flip to `next_open` as the new canon). If `next_open` holds the >60% WF gate, recommend flipping the default in a follow-up.

- [ ] **Step 4: Run the reconciliation oracle against live with both timings**

```bash
npx tsx scripts/reconcile-sim.ts --symbol BTCUSDT   # observe which entryTiming reduces meanAbsNetDelta vs bot_trades
```
Expected: a `ReconcileReport`; note which timing matches live better (live enters ~next bar, so `next_open` should reduce the systematic bias).

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest-confluence.ts experiments/sim-entry-timing-revalidation.md
gmp "add --entry-timing flag + Run-20 next_open re-validation results" feat backend
```

---

## Self-Review

**1. Spec coverage:**
- Shared `src/lib/sim/` core / 5→1 consolidation → Tasks 1-7, 9, 10, 11. ✓
- FillModel ladder (subbar_1m / ohlc_heuristic / pessimistic implemented; l2_depth reserved) → Tasks 1-3, 5. ✓
- Cost model (fee + half-spread + sqrt impact + vol cap) + flat parity → Task 4. ✓
- Intrabar fix via 1m → Task 3 (+ wired in Task 9 once 1m provider supplied). ✓
- Entry-timing as measured re-validation, default `signal_close` → Tasks 6, 13. ✓
- Funding composed from keystone → Task 6. ✓
- Reconciliation harness (parity-regression Mode 1 = Task 8; live-calibration Mode 2 = Task 12). ✓
- Deferred items (event-driven, L2/latency/queue, speed, L2 data) → not in plan, correct per spec non-goals. ✓

**2. Placeholder scan:** Tasks 8, 12 Step 5, and 13 describe loaders/CLI/analysis prose rather than full code — these are the impure DB/IO and one-shot analysis edges where the concrete code depends on local DB/data paths; the pure cores (diff/report, simulator, fixture-consuming test) have complete code. Acceptable: each names exact files, signatures, tolerances, and commands. No "TBD"/"handle edge cases"/"add validation" left in logic steps.

**3. Type consistency:** `SimExitReason`, `FidelityTier`, `EntryTiming`, `SimLevels`, `BarFillRequest`, `FillResult` (Task 1) are reused unchanged through Tasks 2-7. `CostModel.apply` / `FillModel.applyCost` / `simulatePosition` signatures are consistent across producer/consumer blocks. `SimTradeResult` is structurally assignable to `TradeResult` (extra fields optional) — verified against `walk-forward-validate.ts:64`. ✓

## Execution Handoff

Available after you review the plan.
