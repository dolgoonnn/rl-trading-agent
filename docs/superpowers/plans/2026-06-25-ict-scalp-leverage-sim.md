# ICT Scalp Leverage / Liquidation Simulator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated, liquidation-aware simulation layer that measures what leverage does to the existing `ict_5m` scalp on BTC/ETH/SOL/XAUUSD, producing the growth-rate-vs-leverage curve and ruin probability.

**Architecture:** Post-hoc re-simulation (Approach A). The existing scalp backtest emits a per-trade "tape" (with timestamps + 1x return). A new pure module re-walks each trade's **1m** candle path under each leverage level. Leverage's *only* effect is to introduce liquidation: if the 1m path reaches the liquidation price before the 1x exit, the trade is liquidated (lose full margin); otherwise the 1x outcome is amplified by `L × marginFraction`, minus funding. The signal layer is untouched.

**Tech Stack:** TypeScript (strict), tsx for scripts, vitest for tests. Reuses `Candle` type and existing `data/<symbol>_1m.json` files.

## Global Constraints

- TypeScript strict mode. **No `any`** — use proper types or `unknown` with narrowing (project rule).
- All new pure logic lives under `src/lib/scalp/leverage/`. Scripts under `scripts/`.
- Tests live under `tests/scalp/leverage/` mirroring source, using vitest (`describe/it/expect`) and the `@/` path alias.
- Targeted test run: `npx vitest run <path>`. Full suite: `pnpm test`.
- Commits use the mandated workflow: `gmp "message" type scope` (NEVER raw `git commit`). Scope: `backend`.
- Research only — no edits to `src/lib/bot/**`.
- Liquidation fidelity rule (pessimistic): 1m OHLC only; a bar liquidates if its adverse extreme (long: `low`; short: `high`) reaches the liquidation trigger. Slippage shifts the trigger *toward* entry (earlier liquidation).
- Universe: `BTCUSDT, ETHUSDT, SOLUSDT, XAUUSD`. Data files: `data/<symbol>_1m.json`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/scalp/leverage/types.ts` | `TradeTapeEntry`, `LeverageConfig`, `TradeOutcome`, `LeverageResult` |
| `src/lib/scalp/leverage/liquidation.ts` | Pure: `liquidationPrice`, `effectiveLiqTrigger`, `fundingCostFraction`, `resolveTradeUnderLeverage` |
| `src/lib/scalp/leverage/simulator.ts` | `simulateLeverage` (equity curve + stats), `ruinProbability` (MC) |
| `scripts/backtest-scalp.ts` | **Modify**: add `--emit-trade-tape <path>` flag |
| `scripts/leverage-sweep.ts` | **Create**: CLI runner — load tape + 1m candles, sweep grid, MC ruin, report |
| `tests/scalp/leverage/liquidation.test.ts` | Unit tests for liquidation/funding/resolve |
| `tests/scalp/leverage/simulator.test.ts` | Unit tests for sim, ruin, synthetic Kelly check |

---

## Task 1: Leverage types

**Files:**
- Create: `src/lib/scalp/leverage/types.ts`

**Interfaces:**
- Produces: `TradeTapeEntry`, `LeverageConfig`, `TradeOutcome`, `LeverageResult` (consumed by all later tasks).

- [ ] **Step 1: Create the types file**

```ts
// src/lib/scalp/leverage/types.ts

/** One trade from the 1x scalp backtest, with everything the leverage re-sim needs. */
export interface TradeTapeEntry {
  symbol: string;                 // maps to data/<symbol>_1m.json
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryTimestamp: number;         // ms, UTC — entry bar timestamp
  exitTimestamp: number;          // ms, UTC — 1x exit bar timestamp (inclusive walk bound)
  pnlPercent1x: number;           // per-unit cost-adjusted return from the 1x backtest (e.g. 0.012 = +1.2%)
}

export interface LeverageConfig {
  leverage: number;               // L
  marginFraction: number;         // fraction of equity committed as isolated margin per trade (0..1]
  mmr: number;                    // maintenance margin rate, e.g. 0.005
  slippageBps: number;            // adverse slippage applied to the liquidation trigger (bps of entry)
  fundingRate8h: number;          // flat funding per 8h on notional, e.g. 0.0001
  ruinThreshold: number;          // equity fraction of start that counts as ruin, e.g. 0.10
  mcIterations: number;           // Monte Carlo reshuffles for ruin probability, e.g. 1000
}

/** Per-trade result under a given leverage. equityMultiplier multiplies running equity. */
export type TradeOutcome =
  | { liquidated: true; equityMultiplier: number }    // 1 - marginFraction
  | { liquidated: false; equityMultiplier: number };  // 1 + marginFraction * L * (pnl - funding)

export interface LeverageResult {
  leverage: number;
  marginFraction: number;
  tradeCount: number;
  liquidations: number;
  totalReturn: number;            // terminal equity / start - 1
  meanLogGrowthPerTrade: number;  // mean ln(equityMultiplier)
  maxDrawdown: number;            // on the sequential equity curve, in [0,1]
  ruinProbability: number;        // fraction of MC paths breaching ruinThreshold
  equityCurve: number[];          // sequential, starts at 1
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no errors in the new file).

- [ ] **Step 3: Commit**

```bash
gmp "add leverage sim types" feat backend
```

---

## Task 2: Liquidation & funding math (pure)

**Files:**
- Create: `src/lib/scalp/leverage/liquidation.ts`
- Test: `tests/scalp/leverage/liquidation.test.ts`

**Interfaces:**
- Consumes: `TradeTapeEntry`, `LeverageConfig`, `TradeOutcome` from Task 1.
- Produces:
  - `liquidationPrice(entry: number, direction: 'long'|'short', leverage: number, mmr: number): number`
  - `effectiveLiqTrigger(entry: number, direction: 'long'|'short', leverage: number, mmr: number, slippageBps: number): number`
  - `fundingCostFraction(entryTs: number, exitTs: number, fundingRate8h: number): number`

- [ ] **Step 1: Write failing tests for liquidation price + trigger + funding**

```ts
// tests/scalp/leverage/liquidation.test.ts
import { describe, it, expect } from 'vitest';
import {
  liquidationPrice,
  effectiveLiqTrigger,
  fundingCostFraction,
} from '@/lib/scalp/leverage/liquidation';

describe('liquidationPrice', () => {
  it('long: entry 100, L=10, mmr=0.005 -> 90.5', () => {
    expect(liquidationPrice(100, 'long', 10, 0.005)).toBeCloseTo(90.5, 9);
  });
  it('short: entry 100, L=10, mmr=0.005 -> 109.5', () => {
    expect(liquidationPrice(100, 'short', 10, 0.005)).toBeCloseTo(109.5, 9);
  });
  it('long: L=100, mmr=0.005 -> 99.5 (0.5% from entry)', () => {
    expect(liquidationPrice(100, 'long', 100, 0.005)).toBeCloseTo(99.5, 9);
  });
});

describe('effectiveLiqTrigger', () => {
  it('long: slippage shifts trigger UP toward entry (earlier liquidation)', () => {
    const raw = liquidationPrice(100, 'long', 10, 0.005); // 90.5
    const trig = effectiveLiqTrigger(100, 'long', 10, 0.005, 10); // +0.10
    expect(trig).toBeGreaterThan(raw);
    expect(trig).toBeCloseTo(90.6, 9);
  });
  it('short: slippage shifts trigger DOWN toward entry', () => {
    const raw = liquidationPrice(100, 'short', 10, 0.005); // 109.5
    const trig = effectiveLiqTrigger(100, 'short', 10, 0.005, 10); // -0.10
    expect(trig).toBeLessThan(raw);
    expect(trig).toBeCloseTo(109.4, 9);
  });
});

describe('fundingCostFraction', () => {
  const H = 3_600_000;
  it('trade spanning exactly one 08:00 UTC boundary -> one charge', () => {
    // 1970-01-01 07:30 UTC .. 08:30 UTC crosses the 08:00 boundary once
    const entry = 7 * H + 30 * 60_000;
    const exit = 8 * H + 30 * 60_000;
    expect(fundingCostFraction(entry, exit, 0.0001)).toBeCloseTo(0.0001, 12);
  });
  it('trade within a single funding window -> zero', () => {
    const entry = 1 * H;       // 01:00
    const exit = 1 * H + 60_000; // 01:01
    expect(fundingCostFraction(entry, exit, 0.0001)).toBe(0);
  });
  it('trade spanning two boundaries (00:00 and 08:00) -> two charges', () => {
    const entry = 23 * H;          // day0 23:00
    const exit = 23 * H + 10 * H;  // day1 09:00 -> crosses day1 00:00 and 08:00
    expect(fundingCostFraction(entry, exit, 0.0001)).toBeCloseTo(0.0002, 12);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scalp/leverage/liquidation.test.ts`
Expected: FAIL — module `@/lib/scalp/leverage/liquidation` not found.

- [ ] **Step 3: Implement liquidation price, trigger, funding**

```ts
// src/lib/scalp/leverage/liquidation.ts
import type { Candle } from '@/types/candle';
import type { TradeTapeEntry, LeverageConfig, TradeOutcome } from './types';

const EIGHT_HOURS_MS = 8 * 3_600_000;

/**
 * Isolated-margin liquidation price for a linear perp.
 * Loss at liquidation = initialMargin - maintenanceMargin = notional * (1/L - mmr).
 * => P_liq_long  = entry * (1 - 1/L + mmr)
 *    P_liq_short = entry * (1 + 1/L - mmr)
 */
export function liquidationPrice(
  entry: number,
  direction: 'long' | 'short',
  leverage: number,
  mmr: number,
): number {
  const move = 1 / leverage - mmr;
  return direction === 'long' ? entry * (1 - move) : entry * (1 + move);
}

/** Liquidation trigger after adverse slippage — shifted TOWARD entry (liquidates earlier). */
export function effectiveLiqTrigger(
  entry: number,
  direction: 'long' | 'short',
  leverage: number,
  mmr: number,
  slippageBps: number,
): number {
  const raw = liquidationPrice(entry, direction, leverage, mmr);
  const shift = entry * (slippageBps / 10_000);
  return direction === 'long' ? raw + shift : raw - shift;
}

/**
 * Funding cost as a fraction of NOTIONAL for the trade's holding period.
 * Counts 8h boundaries (00:00 / 08:00 / 16:00 UTC) in (entryTs, exitTs].
 * Epoch (1970-01-01 00:00 UTC) is a multiple of 8h, so multiples of EIGHT_HOURS_MS
 * land exactly on those UTC boundaries.
 */
export function fundingCostFraction(
  entryTs: number,
  exitTs: number,
  fundingRate8h: number,
): number {
  const first = Math.ceil((entryTs + 1) / EIGHT_HOURS_MS) * EIGHT_HOURS_MS;
  let count = 0;
  for (let t = first; t <= exitTs; t += EIGHT_HOURS_MS) count++;
  return count * fundingRate8h;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scalp/leverage/liquidation.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
gmp "add liquidation price, trigger, and funding math" feat backend
```

---

## Task 3: Per-trade leverage resolver (1m walk)

**Files:**
- Modify: `src/lib/scalp/leverage/liquidation.ts` (add `resolveTradeUnderLeverage`)
- Modify: `tests/scalp/leverage/liquidation.test.ts` (add resolver tests)

**Interfaces:**
- Consumes: `TradeTapeEntry`, `LeverageConfig`, `TradeOutcome`, `Candle`.
- Produces: `resolveTradeUnderLeverage(trade: TradeTapeEntry, candles1m: Candle[], cfg: LeverageConfig): TradeOutcome`
  - Walks 1m candles with `entryTimestamp < ts <= exitTimestamp`. If the adverse extreme reaches the liquidation trigger → `{ liquidated: true, equityMultiplier: 1 - marginFraction }`. Else → `{ liquidated: false, equityMultiplier: 1 + marginFraction * L * (pnlPercent1x - fundingCostFraction) }`.

- [ ] **Step 1: Write failing tests for the resolver**

```ts
// append to tests/scalp/leverage/liquidation.test.ts
import { resolveTradeUnderLeverage } from '@/lib/scalp/leverage/liquidation';
import type { Candle } from '@/types/candle';
import type { TradeTapeEntry, LeverageConfig } from '@/lib/scalp/leverage/types';

function c(ts: number, o: number, h: number, l: number, cl: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: 1 };
}
const M = 60_000;
const baseCfg: LeverageConfig = {
  leverage: 10, marginFraction: 1, mmr: 0.005, slippageBps: 0,
  fundingRate8h: 0, ruinThreshold: 0.1, mcIterations: 100,
};
const longTrade: TradeTapeEntry = {
  symbol: 'X', direction: 'long', entryPrice: 100, stopLoss: 88, takeProfit: 130,
  entryTimestamp: 0, exitTimestamp: 3 * M, pnlPercent1x: 0.30,
};

describe('resolveTradeUnderLeverage', () => {
  it('no liquidation -> amplifies 1x pnl by marginFraction*L', () => {
    // L=10 long: P_liq = 90.5. Lows stay above 90.5 -> survives, resolves as 1x (+30%).
    const candles = [c(0, 100, 100, 100, 100), c(M, 100, 110, 95, 108), c(2 * M, 108, 132, 107, 130), c(3 * M, 130, 130, 129, 130)];
    const out = resolveTradeUnderLeverage(longTrade, candles, baseCfg);
    expect(out.liquidated).toBe(false);
    // 1 + 1 * 10 * 0.30 = 4.0
    expect(out.equityMultiplier).toBeCloseTo(4.0, 9);
  });

  it('liquidation when a 1m low pierces P_liq before exit -> lose full margin', () => {
    // bar at M dips to 90.0 < P_liq 90.5 -> liquidated even though 1x was a winner.
    const candles = [c(0, 100, 100, 100, 100), c(M, 100, 101, 90.0, 99), c(2 * M, 99, 132, 99, 130), c(3 * M, 130, 130, 129, 130)];
    const out = resolveTradeUnderLeverage(longTrade, candles, baseCfg);
    expect(out.liquidated).toBe(true);
    expect(out.equityMultiplier).toBeCloseTo(0, 9); // 1 - marginFraction(=1)
  });

  it('pessimistic: a bar spanning both stop and P_liq liquidates (does not stop out)', () => {
    // bar low 85 reaches both stopLoss 88 and P_liq 90.5 -> liquidation wins.
    const candles = [c(0, 100, 100, 100, 100), c(M, 100, 101, 85, 95), c(2 * M, 95, 96, 94, 95), c(3 * M, 95, 95, 94, 95)];
    const out = resolveTradeUnderLeverage(longTrade, candles, baseCfg);
    expect(out.liquidated).toBe(true);
  });

  it('low leverage: P_liq far away -> survives even on a losing 1x trade', () => {
    // L=2 long: P_liq = 100*(1-0.5+0.005)=50.5. A normal stop-out (1x = -12%) survives.
    const cfg: LeverageConfig = { ...baseCfg, leverage: 2 };
    const loser: TradeTapeEntry = { ...longTrade, pnlPercent1x: -0.12 };
    const candles = [c(0, 100, 100, 100, 100), c(M, 100, 100, 88, 88), c(2 * M, 88, 89, 87, 88), c(3 * M, 88, 88, 87, 88)];
    const out = resolveTradeUnderLeverage(loser, candles, cfg);
    expect(out.liquidated).toBe(false);
    // 1 + 1 * 2 * (-0.12) = 0.76
    expect(out.equityMultiplier).toBeCloseTo(0.76, 9);
  });

  it('funding reduces the surviving multiplier', () => {
    const cfg: LeverageConfig = { ...baseCfg, fundingRate8h: 0.01 };
    // entryTs 7.5h, exitTs 8.5h -> crosses 08:00 once -> funding 0.01 of notional.
    const H = 3_600_000;
    const t: TradeTapeEntry = { ...longTrade, entryTimestamp: 7 * H + 30 * M, exitTimestamp: 8 * H + 30 * M };
    const candles = [c(t.entryTimestamp, 100, 100, 100, 100), c(t.exitTimestamp, 100, 132, 99, 130)];
    const out = resolveTradeUnderLeverage(t, candles, cfg);
    // 1 + 1*10*(0.30 - 0.01) = 3.9
    expect(out.equityMultiplier).toBeCloseTo(3.9, 9);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scalp/leverage/liquidation.test.ts`
Expected: FAIL — `resolveTradeUnderLeverage` is not exported.

- [ ] **Step 3: Implement the resolver**

```ts
// append to src/lib/scalp/leverage/liquidation.ts

/**
 * Resolve one trade under leverage by walking its 1m path.
 * Leverage's ONLY effect is liquidation: if the adverse extreme reaches the
 * liquidation trigger within (entryTs, exitTs], the trade is liquidated
 * (lose full margin). Otherwise the 1x outcome is amplified, net of funding.
 */
export function resolveTradeUnderLeverage(
  trade: TradeTapeEntry,
  candles1m: Candle[],
  cfg: LeverageConfig,
): TradeOutcome {
  const trigger = effectiveLiqTrigger(
    trade.entryPrice, trade.direction, cfg.leverage, cfg.mmr, cfg.slippageBps,
  );

  for (let i = 0; i < candles1m.length; i++) {
    const bar = candles1m[i];
    if (bar.timestamp <= trade.entryTimestamp) continue;
    if (bar.timestamp > trade.exitTimestamp) break;
    const hit = trade.direction === 'long' ? bar.low <= trigger : bar.high >= trigger;
    if (hit) {
      return { liquidated: true, equityMultiplier: 1 - cfg.marginFraction };
    }
  }

  const funding = fundingCostFraction(trade.entryTimestamp, trade.exitTimestamp, cfg.fundingRate8h);
  const netReturn = trade.pnlPercent1x - funding;
  const multiplier = 1 + cfg.marginFraction * cfg.leverage * netReturn;
  return { liquidated: false, equityMultiplier: multiplier };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scalp/leverage/liquidation.test.ts`
Expected: PASS (all liquidation + resolver tests).

- [ ] **Step 5: Commit**

```bash
gmp "add per-trade leverage resolver with 1m liquidation walk" feat backend
```

---

## Task 4: Sequential simulator + Monte Carlo ruin

**Files:**
- Create: `src/lib/scalp/leverage/simulator.ts`
- Test: `tests/scalp/leverage/simulator.test.ts`

**Interfaces:**
- Consumes: `resolveTradeUnderLeverage` (Task 3); `TradeTapeEntry`, `LeverageConfig`, `LeverageResult`, `TradeOutcome` (Task 1); `Candle`.
- Produces:
  - `simulateLeverage(tape: TradeTapeEntry[], candlesBySymbol: Map<string, Candle[]>, cfg: LeverageConfig): LeverageResult`
  - `ruinProbability(multipliers: number[], ruinThreshold: number, iterations: number): number`

- [ ] **Step 1: Write failing tests (sim, ruin, synthetic Kelly)**

```ts
// tests/scalp/leverage/simulator.test.ts
import { describe, it, expect } from 'vitest';
import { simulateLeverage, ruinProbability } from '@/lib/scalp/leverage/simulator';
import type { Candle } from '@/types/candle';
import type { TradeTapeEntry, LeverageConfig } from '@/lib/scalp/leverage/types';

const M = 60_000;
function c(ts: number, o: number, h: number, l: number, cl: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: 1 };
}
function cfg(over: Partial<LeverageConfig>): LeverageConfig {
  return { leverage: 1, marginFraction: 1, mmr: 0.005, slippageBps: 0, fundingRate8h: 0, ruinThreshold: 0.1, mcIterations: 2000, ...over };
}

describe('simulateLeverage', () => {
  it('L=1, marginFraction=1: each multiplier equals 1 + pnlPercent1x (exact reconciliation)', () => {
    // Two winners that never approach P_liq (which at L=1 is ~entry*0.005).
    const tape: TradeTapeEntry[] = [
      { symbol: 'X', direction: 'long', entryPrice: 100, stopLoss: 90, takeProfit: 110, entryTimestamp: 0, exitTimestamp: M, pnlPercent1x: 0.10 },
      { symbol: 'X', direction: 'long', entryPrice: 100, stopLoss: 90, takeProfit: 110, entryTimestamp: 2 * M, exitTimestamp: 3 * M, pnlPercent1x: -0.05 },
    ];
    const candles = [c(0, 100, 100, 100, 100), c(M, 100, 110, 99, 110), c(2 * M, 100, 100, 100, 100), c(3 * M, 100, 100, 99, 95)];
    const r = simulateLeverage(tape, new Map([['X', candles]]), cfg({}));
    expect(r.liquidations).toBe(0);
    // equity: 1 * 1.10 * 0.95 = 1.045
    expect(r.totalReturn).toBeCloseTo(0.045, 9);
    expect(r.tradeCount).toBe(2);
  });

  it('throws on missing candle data for a symbol', () => {
    const tape: TradeTapeEntry[] = [
      { symbol: 'MISSING', direction: 'long', entryPrice: 100, stopLoss: 90, takeProfit: 110, entryTimestamp: 0, exitTimestamp: M, pnlPercent1x: 0.1 },
    ];
    expect(() => simulateLeverage(tape, new Map(), cfg({}))).toThrow(/MISSING/);
  });
});

describe('ruinProbability', () => {
  it('all-positive multipliers never ruin', () => {
    expect(ruinProbability([1.1, 1.1, 1.1], 0.1, 1000)).toBe(0);
  });
  it('a single zero multiplier (full-margin liquidation) always ruins', () => {
    expect(ruinProbability([1.5, 0, 1.5], 0.1, 1000)).toBe(1);
  });
});

describe('synthetic Kelly check', () => {
  it('p=0.6 win +1% / lose -1%, marginFraction=1: growth-maximizing L is ~20', () => {
    // Build 1000 trades that NEVER liquidate (lows only 1% from entry, P_liq far at these L).
    const tape: TradeTapeEntry[] = [];
    const candlesBySym = new Map<string, Candle[]>();
    const cs: Candle[] = [];
    for (let i = 0; i < 1000; i++) {
      const win = i % 5 < 3; // exactly 60%
      const t0 = i * 2 * M;
      const pnl = win ? 0.01 : -0.01;
      tape.push({ symbol: 'K', direction: 'long', entryPrice: 100, stopLoss: 90, takeProfit: 105, entryTimestamp: t0, exitTimestamp: t0 + M, pnlPercent1x: pnl });
      cs.push(c(t0, 100, 100, 100, 100));
      cs.push(c(t0 + M, 100, 101, 99, win ? 101 : 99)); // low 99 = 1% drop, far above any P_liq for L<=25
    }
    candlesBySym.set('K', cs);

    let bestL = 0, bestG = -Infinity;
    for (const L of [1, 5, 10, 15, 18, 20, 22, 25]) {
      const r = simulateLeverage(tape, candlesBySym, cfg({ leverage: L }));
      if (r.meanLogGrowthPerTrade > bestG) { bestG = r.meanLogGrowthPerTrade; bestL = L; }
    }
    // Analytic optimum is L=20 for ±1%, p=0.6.
    expect(bestL).toBeGreaterThanOrEqual(18);
    expect(bestL).toBeLessThanOrEqual(22);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scalp/leverage/simulator.test.ts`
Expected: FAIL — module `@/lib/scalp/leverage/simulator` not found.

- [ ] **Step 3: Implement the simulator + ruin**

```ts
// src/lib/scalp/leverage/simulator.ts
import type { Candle } from '@/types/candle';
import type { TradeTapeEntry, LeverageConfig, LeverageResult } from './types';
import { resolveTradeUnderLeverage } from './liquidation';

/** Compound a leverage config over the tape sequentially; collect curve + stats. */
export function simulateLeverage(
  tape: TradeTapeEntry[],
  candlesBySymbol: Map<string, Candle[]>,
  cfg: LeverageConfig,
): LeverageResult {
  let equity = 1;
  const equityCurve: number[] = [1];
  const multipliers: number[] = [];
  const logMultipliers: number[] = [];
  let liquidations = 0;

  for (const trade of tape) {
    const candles = candlesBySymbol.get(trade.symbol);
    if (!candles) throw new Error(`missing 1m candles for symbol ${trade.symbol}`);
    const outcome = resolveTradeUnderLeverage(trade, candles, cfg);
    if (outcome.liquidated) liquidations++;
    const m = Math.max(outcome.equityMultiplier, 0); // isolated margin: cannot go below 0
    multipliers.push(m);
    logMultipliers.push(Math.log(Math.max(m, 1e-12)));
    equity *= m;
    equityCurve.push(equity);
    if (equity <= 0) break; // absorbing barrier
  }

  const meanLog = logMultipliers.length
    ? logMultipliers.reduce((s, x) => s + x, 0) / logMultipliers.length
    : 0;

  return {
    leverage: cfg.leverage,
    marginFraction: cfg.marginFraction,
    tradeCount: tape.length,
    liquidations,
    totalReturn: equity - 1,
    meanLogGrowthPerTrade: meanLog,
    maxDrawdown: maxDrawdown(equityCurve),
    ruinProbability: ruinProbability(multipliers, cfg.ruinThreshold, cfg.mcIterations),
    equityCurve,
  };
}

function maxDrawdown(curve: number[]): number {
  let peak = curve[0] ?? 1;
  let maxDD = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
}

/**
 * Monte Carlo ruin probability: shuffle the per-trade equity multipliers,
 * compound each path, count the fraction whose running equity ever drops below
 * ruinThreshold. (Per-trade multipliers are order-independent; only the
 * compounding sequence changes — the same assumption used by reshuffleTrades.)
 */
export function ruinProbability(
  multipliers: number[],
  ruinThreshold: number,
  iterations: number,
): number {
  if (multipliers.length === 0) return 0;
  let ruined = 0;
  for (let it = 0; it < iterations; it++) {
    const shuffled = shuffle(multipliers);
    let equity = 1;
    let hit = false;
    for (const m of shuffled) {
      equity *= m;
      if (equity < ruinThreshold) { hit = true; break; }
    }
    if (hit) ruined++;
  }
  return ruined / iterations;
}

function shuffle(arr: number[]): number[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scalp/leverage/simulator.test.ts`
Expected: PASS (sim reconciliation, missing-data throw, ruin bounds, synthetic Kelly ~20).

- [ ] **Step 5: Commit**

```bash
gmp "add sequential leverage simulator and monte carlo ruin" feat backend
```

---

## Task 5: Emit the trade tape from the scalp backtest

**Files:**
- Modify: `scripts/backtest-scalp.ts`

**Context:** The backtest builds positions with `entryIndex = i + 1`, `entryTimestamp = nextBar.timestamp`, and calls `simulatePosition(...)` which returns a `SimTradeResult` carrying `pnlPercent`, `barsHeld`, `exitReason`. The 5m candle array is `all5m`. The exit timestamp = `all5m[entryIndex + barsHeld].timestamp` (clamped to the last bar). Tape entries map directly to `TradeTapeEntry`.

**Interfaces:**
- Consumes: `TradeTapeEntry` (Task 1), the existing per-trade loop in `backtest-scalp.ts`.
- Produces: a JSON file `TradeTapeEntry[]` at the `--emit-trade-tape` path; baseline metrics still printed to stdout.

- [ ] **Step 1: Add CLI flag parsing**

Find the CLI arg parsing block in `scripts/backtest-scalp.ts` (where flags like `--strategy`, `--symbols` are read). Add:

```ts
// near the other arg reads
const emitTapeArg = args.indexOf('--emit-trade-tape');
const emitTapePath: string | null = emitTapeArg !== -1 ? args[emitTapeArg + 1] : null;
```

- [ ] **Step 2: Accumulate tape entries in the trade loop**

At the top of the multi-symbol run (before the per-symbol loop), declare:

```ts
import { writeFileSync } from 'node:fs';
import type { TradeTapeEntry } from '../src/lib/scalp/leverage/types';

const tape: TradeTapeEntry[] = [];
```

Immediately after the existing `const trade: TradeResult | null = simulatePosition(...)` call and its null check, push a tape entry (only when emitting). `symbol` is the current symbol in scope; `all5m`, `position`, `signal` are in scope:

```ts
if (emitTapePath && trade) {
  const exitIdx = Math.min(position.entryIndex + trade.barsHeld, all5m.length - 1);
  tape.push({
    symbol,
    direction: position.direction,
    entryPrice: position.entryPrice,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    entryTimestamp: position.entryTimestamp,
    exitTimestamp: all5m[exitIdx].timestamp,
    pnlPercent1x: trade.pnlPercent,
  });
}
```

> Note: if `barsHeld` is not present on the `TradeResult` returned here, use the result's exit index field instead; confirm by inspecting the `SimTradeResult` type in `src/lib/sim/types.ts` (it exposes `barsHeld`). Keep the mapping to `exitTimestamp` — the simulator keys off timestamps, not indices.

- [ ] **Step 3: Write the tape file at the end of the run**

After all symbols are processed and before the final summary print, add:

```ts
if (emitTapePath) {
  writeFileSync(emitTapePath, JSON.stringify(tape, null, 2));
  console.log(`\n📼 Wrote ${tape.length} trades to ${emitTapePath}`);
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Smoke-run the tape emission on one symbol**

Run: `npx tsx scripts/backtest-scalp.ts --strategy ict_5m --symbols BTCUSDT --emit-trade-tape /tmp/tape-smoke.json`
Expected: prints baseline metrics and `📼 Wrote N trades to /tmp/tape-smoke.json` with N > 0.

- [ ] **Step 6: Verify tape shape**

Run: `node -e "const t=require('/tmp/tape-smoke.json'); console.log(t.length, Object.keys(t[0]).sort().join(','))"`
Expected: a count and keys `direction,entryPrice,entryTimestamp,exitTimestamp,pnlPercent1x,stopLoss,symbol,takeProfit`.

- [ ] **Step 7: Commit**

```bash
gmp "emit trade tape from scalp backtest for leverage sim" feat backend
```

---

## Task 6: Leverage sweep CLI runner

**Files:**
- Create: `scripts/leverage-sweep.ts`

**Context:** Loads the tape and the per-symbol 1m candle files referenced by the tape, runs `simulateLeverage` across a leverage grid, prints a table + ASCII curve, and writes a JSON report. Candle files are `data/<symbol>_1m.json` (an array of `Candle`).

**Interfaces:**
- Consumes: `simulateLeverage` (Task 4); `TradeTapeEntry`, `LeverageConfig`, `LeverageResult` (Task 1); `Candle`.
- Produces: a CLI script (no exported API). Output: `experiments/leverage-sweep-<timestamp passed via arg or fixed name>.json` + stdout report.

- [ ] **Step 1: Implement the runner**

```ts
// scripts/leverage-sweep.ts
import { readFileSync, writeFileSync } from 'node:fs';
import type { Candle } from '../src/types/candle';
import type { TradeTapeEntry, LeverageConfig, LeverageResult } from '../src/lib/scalp/leverage/types';
import { simulateLeverage } from '../src/lib/scalp/leverage/simulator';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}

const tapePath = arg('--tape', 'tape.json');
const grid = arg('--leverage-grid', '1,2,5,10,25,50,100,125').split(',').map(Number);
const marginFraction = Number(arg('--margin-fraction', '1'));
const mmr = Number(arg('--mmr', '0.005'));
const slippageBps = Number(arg('--slippage-bps', '3'));
const fundingRate8h = Number(arg('--funding-rate', '0.0001'));
const ruinThreshold = Number(arg('--ruin-threshold', '0.10'));
const mcIterations = Number(arg('--mc-iterations', '1000'));
const outPath = arg('--out', 'experiments/leverage-sweep.json');

const tape: TradeTapeEntry[] = JSON.parse(readFileSync(tapePath, 'utf8'));
if (tape.length === 0) { console.error('Empty tape — nothing to simulate.'); process.exit(1); }

// Load 1m candles for each distinct symbol in the tape.
const symbols = [...new Set(tape.map((t) => t.symbol))];
const candlesBySymbol = new Map<string, Candle[]>();
for (const sym of symbols) {
  const path = `data/${sym}_1m.json`;
  try {
    candlesBySymbol.set(sym, JSON.parse(readFileSync(path, 'utf8')) as Candle[]);
  } catch {
    console.error(`FATAL: missing 1m candle file ${path} for symbol ${sym}`);
    process.exit(1);
  }
}

const results: LeverageResult[] = grid.map((leverage) => {
  const cfg: LeverageConfig = { leverage, marginFraction, mmr, slippageBps, fundingRate8h, ruinThreshold, mcIterations };
  return simulateLeverage(tape, candlesBySymbol, cfg);
});

// L* = growth-maximizing; L_ruin = first L with ruinProbability >= 5%.
const star = results.reduce((a, b) => (b.meanLogGrowthPerTrade > a.meanLogGrowthPerTrade ? b : a));
const ruinLevel = results.find((r) => r.ruinProbability >= 0.05);

console.log(`\nTape: ${tape.length} trades across ${symbols.join(', ')} | marginFraction=${marginFraction}, mmr=${mmr}, slippage=${slippageBps}bps\n`);
console.log('   L  | totalReturn |  meanLogG/trade | maxDD | liquidations |  ruin%');
console.log('------|-------------|-----------------|-------|--------------|--------');
for (const r of results) {
  console.log(
    `${String(r.leverage).padStart(5)} | ${(r.totalReturn * 100).toFixed(1).padStart(10)}% | ${r.meanLogGrowthPerTrade.toFixed(6).padStart(15)} | ${(r.maxDrawdown * 100).toFixed(0).padStart(4)}% | ${String(r.liquidations).padStart(12)} | ${(r.ruinProbability * 100).toFixed(1).padStart(5)}%`,
  );
}
console.log(`\nL* (max growth) = ${star.leverage}  |  L_ruin (ruin% >= 5%) = ${ruinLevel ? ruinLevel.leverage : 'none in grid'}`);

// ASCII growth curve.
const maxG = Math.max(...results.map((r) => r.meanLogGrowthPerTrade), 0);
const minG = Math.min(...results.map((r) => r.meanLogGrowthPerTrade), 0);
const span = maxG - minG || 1;
console.log('\nGrowth rate vs leverage (ln-multiplier per trade):');
for (const r of results) {
  const n = Math.round(((r.meanLogGrowthPerTrade - minG) / span) * 40);
  console.log(`${String(r.leverage).padStart(5)} | ${'#'.repeat(Math.max(0, n))}`);
}

writeFileSync(outPath, JSON.stringify({ config: { marginFraction, mmr, slippageBps, fundingRate8h, ruinThreshold, mcIterations }, symbols, tradeCount: tape.length, lStar: star.leverage, lRuin: ruinLevel?.leverage ?? null, results }, null, 2));
console.log(`\nWrote report to ${outPath}`);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke-run on the BTC smoke tape**

Run: `npx tsx scripts/leverage-sweep.ts --tape /tmp/tape-smoke.json --leverage-grid 1,10,50,100 --out /tmp/sweep-smoke.json`
Expected: a printed table with 4 rows, an `L*`/`L_ruin` line, an ASCII curve, and `Wrote report to /tmp/sweep-smoke.json`. At L=100 expect many liquidations and high ruin%.

- [ ] **Step 4: Commit**

```bash
gmp "add leverage sweep cli runner with ascii report" feat backend
```

---

## Task 7: Full experiment run + reconciliation + findings

**Files:**
- Create: `experiments/leverage-sweep-fullmargin.md` (findings writeup)
- Create: `experiments/leverage-sweep.json` (report artifact, produced by the run)

**Context:** Run the real experiment on the full universe and record the result, including the L=1 reconciliation against the 1x baseline (the integrity check that the sim is faithful).

- [ ] **Step 1: Emit the full tape**

Run: `npx tsx scripts/backtest-scalp.ts --strategy ict_5m --symbols BTCUSDT,ETHUSDT,SOLUSDT,XAUUSD --emit-trade-tape experiments/tape-ict5m.json`
Expected: baseline metrics for each symbol printed; tape written. **Record the 1x baseline total PnL and win rate from stdout.** If aggregate expectancy ≤ 0, note that as the finding and still proceed (leverage will only confirm ruin).

- [ ] **Step 2: Run the leverage sweep (full margin, f=1)**

Run: `npx tsx scripts/leverage-sweep.ts --tape experiments/tape-ict5m.json --leverage-grid 1,2,5,10,25,50,100,125 --margin-fraction 1 --out experiments/leverage-sweep-f1.json`
Expected: table + curve. At `marginFraction=1`, a single liquidation zeroes equity — expect ruin% to climb to ~100% well before 100x.

- [ ] **Step 3: Run the Kelly-revealing sweep (f<1)**

Run: `npx tsx scripts/leverage-sweep.ts --tape experiments/tape-ict5m.json --leverage-grid 1,2,5,10,25,50,100,125 --margin-fraction 0.1 --out experiments/leverage-sweep-f0.1.json`
Expected: with smaller per-trade margin the growth curve shows a hump (L*) before collapsing — the Kelly picture.

- [ ] **Step 4: Reconcile L=1 against the baseline**

Run: `node -e "const r=require('./experiments/leverage-sweep-f1.json'); const l1=r.results.find(x=>x.leverage===1); console.log('L=1 liquidations (should be 0):', l1.liquidations); console.log('L=1 totalReturn:', (l1.totalReturn*100).toFixed(1)+'%');"`
Expected: `L=1 liquidations` = 0 (P_liq at L=1 is ~entry×mmr, unreachable). The L=1 compounded return should agree in sign with the baseline expectancy from Step 1. Note any discrepancy (compounded vs additive is expected; sign must match).

- [ ] **Step 5: Write the findings doc**

Create `experiments/leverage-sweep-fullmargin.md` capturing: the 1x baseline (from Step 1), the f=1 and f=0.1 tables, `L*` and `L_ruin` for each, the L=1 reconciliation result, and a one-paragraph verdict on whether any leverage level is justifiable for this signal. Reference `data/` files and the sweep JSONs.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: all leverage tests green; no regressions elsewhere.

- [ ] **Step 7: Commit**

```bash
gmp "run full leverage sweep and record findings" docs backend
```

---

## Self-Review

**Spec coverage:**
- §4 architecture (post-hoc re-sim, isolated module) → Tasks 1–4, 6. ✓
- §6 data model (`TradeTapeEntry`/`LeverageConfig`/`LeverageResult`) → Task 1. ✓
- §7.1 liquidation price → Task 2. ✓
- §7.2 pessimistic intrabar resolution → Task 3 (refined: liquidation is the only leverage-induced deviation; walk on 1m by timestamp). ✓
- §7.3 sizing & compounding → Task 4. ✓
- §7.4 funding + slippage → Task 2 (funding), Task 3 (slippage shifts trigger). ✓
- §7.5 ruin via MC reshuffle → Task 4 (`ruinProbability`). ✓
- §8 deliverable (per-symbol/combined table, L*, L_ruin, ASCII) → Task 6 + Task 7. ✓
- §9 testing (liquidation hand-calcs, ordering, funding, Kelly synthetic) → Tasks 2–4. ✓
- §10 error handling (index/symbol validation, equity≤0 absorbing) → Task 3 (walk bounds), Task 4 (missing-symbol throw, absorbing barrier), Task 6 (missing-file fatal). ✓
- §2 baseline gate (report 1x expectancy first) → Task 5 (still prints baseline) + Task 7 Step 1. ✓

**Refinements vs spec (intentional, faithful to intent):**
- Tape keys off **timestamps** and the sim walks **1m** candles (spec said "1m path"; the 5m index space would have been coarser). Documented.
- Liquidation modeled as the *only* leverage-induced deviation from the 1x outcome → exact L=1 reconciliation. Cleaner than re-deriving stop/TP on 1m, same pessimistic guarantee.
- Slippage shifts the liquidation trigger toward entry (isolated margin caps loss at full margin, so slippage cannot exceed margin — modeling it as earlier liquidation is the honest, non-double-counting choice).

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `TradeTapeEntry`, `LeverageConfig`, `TradeOutcome`, `LeverageResult` defined in Task 1 and used verbatim in Tasks 3, 4, 5, 6. `resolveTradeUnderLeverage`/`simulateLeverage`/`ruinProbability`/`liquidationPrice`/`effectiveLiqTrigger`/`fundingCostFraction` signatures match across definition and call sites. ✓
