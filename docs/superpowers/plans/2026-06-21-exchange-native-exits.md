# Exchange-Native Protective Exits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place our stop-loss and take-profit as real reduce-only orders on Bybit (via `setTradingStop`) the instant a live entry fills, so a process crash can never leave a position unprotected.

**Architecture:** A new injectable `ExchangeExitManager` wraps the three Bybit V5 calls we need (`setTradingStop`, `submitOrder` market-close, `getPositionInfo`). `run-bot.ts` arms exits right after a live fill, re-arms the SL when our in-process partial-TP moves it to breakeven, and flattens + clears on time-exit / shutdown / kill. When exchange exits are enabled, the exchange is the **authoritative** holder of SL/TP; a lightweight per-tick position-size poll detects exchange-driven closes so our shadow accounting stays in sync. The whole feature is gated behind a default-off flag so paper mode and the validated Run-20 backtest are untouched.

**Tech Stack:** TypeScript (strict), `bybit-api` v4.5.3 `RestClientV5`, vitest, SQLite/Drizzle (existing tracker).

## Global Constraints

- No `any` types; `as any` banned. Narrow or use `unknown`. (verbatim from `/Users/apple/.claude/CLAUDE.md`)
- All code/comments/docs in English.
- Commit with `gmp "<msg>" <type> <scope>` — never raw `git commit`.
- Bot category is `linear`; one-way position mode → `positionIdx: 0`. (`src/lib/bot/config.ts:280` `BYBIT_CATEGORY = 'linear'`)
- Default-off: the feature must not change paper / paper-forward behavior or the backtest. Gate = `ExchangeExitConfig.enabled` (default `false`).
- Bybit clears a position-attached SL/TP by sending the price as the string `"0"`.
- Every Bybit call is fail-safe: it must never throw into the tick loop; it returns `{ ok, reason }` and the caller logs + decides.
- **Safety invariant:** if we hold a live position and cannot arm or confirm a protective stop, we FLATTEN immediately (market reduce-only). An unprotected live position is never allowed to persist.

## Scope & Phasing (read before starting)

This plan delivers **Phase 1** only. Phase 1 puts the **hard SL and the final TP** on the exchange (both are fixed-price exits → no sim/live parity divergence) and makes the exchange authoritative for them. Our in-process logic keeps owning the **fractional partial-TP, the breakeven move, and the max-bars time exit**, and re-arms / clears / flattens the exchange accordingly.

**Phase 2 (separate plan, gated on the reconciliation work in `bot-live-state-and-roadmap`)** moves the *fractional partial-TP* onto the exchange as a resting reduce-only order. That is deferred because a resting partial-TP fills **intrabar**, whereas our validated Run-20 partial-TP triggers on candle **close** — making the exchange the source of truth for the partial requires fill reconciliation and an accepted, documented parity change. Do not attempt it here.

**Why Phase 1 is independently shippable:** the catastrophic gap is "crash ⇒ no stop." Phase 1 closes it completely for the SL (and the final TP) without touching the partial-TP semantics that the backtest validates.

---

### Task 1: `ExchangeExitManager` — arm SL + TP

**Files:**
- Create: `src/lib/bot/exchange-exit-manager.ts`
- Test: `tests/bot/exchange-exit-manager.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module). `BYBIT_CATEGORY` from `src/lib/bot/config.ts`.
- Produces:
  - `interface ExchangeExitClient` — structural slice of `RestClientV5` (so tests inject a mock):
    - `setTradingStop(params): Promise<{ retCode: number; retMsg: string }>`
    - `submitOrder(params): Promise<{ retCode: number; retMsg: string; result?: { orderId?: string } }>`
    - `getPositionInfo(params): Promise<{ retCode: number; retMsg: string; result: { list: Array<{ size: string; side: string; avgPrice: string }> } }>`
  - `interface ExchangeExitConfig { enabled: boolean; triggerBy: 'LastPrice' | 'MarkPrice' | 'IndexPrice' }`
  - `const DEFAULT_EXCHANGE_EXIT_CONFIG: ExchangeExitConfig`
  - `interface ExitOpResult { ok: boolean; reason?: string }`
  - `class ExchangeExitManager` with `armExits(symbol, stopLoss, takeProfit): Promise<ExitOpResult>` (this task), plus `clearExits`, `marketClose`, `getOpenSize`, `isEnabled` (later tasks).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/bot/exchange-exit-manager.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  ExchangeExitManager,
  DEFAULT_EXCHANGE_EXIT_CONFIG,
  type ExchangeExitClient,
} from '@/lib/bot/exchange-exit-manager';

function mockClient(overrides: Partial<ExchangeExitClient> = {}): ExchangeExitClient {
  return {
    setTradingStop: vi.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK' }),
    submitOrder: vi.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK', result: { orderId: 'x' } }),
    getPositionInfo: vi.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK', result: { list: [] } }),
    ...overrides,
  };
}

describe('ExchangeExitManager.armExits', () => {
  it('sends SL+TP as a Full-mode position stop with the configured trigger', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });

    const res = await mgr.armExits('BTCUSDT', 60000, 65000);

    expect(res.ok).toBe(true);
    expect(client.setTradingStop).toHaveBeenCalledWith({
      category: 'linear',
      symbol: 'BTCUSDT',
      positionIdx: 0,
      tpslMode: 'Full',
      stopLoss: '60000',
      takeProfit: '65000',
      slTriggerBy: 'MarkPrice',
      tpTriggerBy: 'MarkPrice',
    });
  });

  it('returns ok:false with the Bybit retMsg on a non-zero retCode (does not throw)', async () => {
    const client = mockClient({
      setTradingStop: vi.fn().mockResolvedValue({ retCode: 10001, retMsg: 'params error' }),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });

    const res = await mgr.armExits('BTCUSDT', 60000, 65000);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('params error');
  });

  it('returns ok:false when the client throws (network) without propagating', async () => {
    const client = mockClient({
      setTradingStop: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });

    const res = await mgr.armExits('BTCUSDT', 60000, 65000);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('ETIMEDOUT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bot/exchange-exit-manager.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bot/exchange-exit-manager'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/bot/exchange-exit-manager.ts
/**
 * Exchange-Native Protective Exits
 *
 * Places our stop-loss / take-profit as a position-attached reduce-only stop on
 * Bybit (V5 `setTradingStop`, one-way mode, positionIdx 0). The point is crash
 * safety: once armed, the stop lives on the exchange and fires even if this
 * process dies. Gated behind `ExchangeExitConfig.enabled` (default false) so
 * paper mode and the backtest are unaffected.
 *
 * Every method is fail-safe — it never throws into the tick loop; it returns
 * `{ ok, reason }` and lets the caller decide (the caller's safety rule: if a
 * live position can't be protected, flatten it).
 */
import { BYBIT_CATEGORY } from './config';

/** Structural slice of RestClientV5 we depend on (lets tests inject a mock). */
export interface ExchangeExitClient {
  setTradingStop(params: {
    category: 'linear';
    symbol: string;
    positionIdx: 0 | 1 | 2;
    tpslMode?: 'Full' | 'Partial';
    stopLoss?: string;
    takeProfit?: string;
    slTriggerBy?: string;
    tpTriggerBy?: string;
  }): Promise<{ retCode: number; retMsg: string }>;
  submitOrder(params: {
    category: 'linear';
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Market';
    qty: string;
    reduceOnly: boolean;
    orderLinkId?: string;
  }): Promise<{ retCode: number; retMsg: string; result?: { orderId?: string } }>;
  getPositionInfo(params: { category: 'linear'; symbol: string }): Promise<{
    retCode: number;
    retMsg: string;
    result: { list: Array<{ size: string; side: string; avgPrice: string }> };
  }>;
}

export interface ExchangeExitConfig {
  /** Master gate — false in paper/backtest. */
  enabled: boolean;
  /** Trigger reference for SL/TP. MarkPrice avoids wick-hunt liquidations. */
  triggerBy: 'LastPrice' | 'MarkPrice' | 'IndexPrice';
}

export const DEFAULT_EXCHANGE_EXIT_CONFIG: ExchangeExitConfig = {
  enabled: false,
  triggerBy: 'MarkPrice',
};

export interface ExitOpResult {
  ok: boolean;
  reason?: string;
}

export class ExchangeExitManager {
  constructor(
    private readonly client: ExchangeExitClient,
    private readonly config: ExchangeExitConfig,
  ) {}

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Arm (or replace) the position-attached SL + final TP. Bybit treats a repeat
   * call as a replace, so this doubles as the breakeven-move amend.
   */
  async armExits(symbol: string, stopLoss: number, takeProfit: number): Promise<ExitOpResult> {
    try {
      const resp = await this.client.setTradingStop({
        category: BYBIT_CATEGORY,
        symbol,
        positionIdx: 0,
        tpslMode: 'Full',
        stopLoss: stopLoss.toString(),
        takeProfit: takeProfit.toString(),
        slTriggerBy: this.config.triggerBy,
        tpTriggerBy: this.config.triggerBy,
      });
      if (resp.retCode !== 0) {
        return { ok: false, reason: `setTradingStop retCode=${resp.retCode}: ${resp.retMsg}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/bot/exchange-exit-manager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/exchange-exit-manager.ts tests/bot/exchange-exit-manager.test.ts
gmp "add ExchangeExitManager.armExits (position-attached reduce-only SL+TP via setTradingStop)" feat backend
```

---

### Task 2: `clearExits` + `marketClose` + `getOpenSize`

**Files:**
- Modify: `src/lib/bot/exchange-exit-manager.ts`
- Test: `tests/bot/exchange-exit-manager.test.ts`

**Interfaces:**
- Consumes: `ExchangeExitClient`, `ExitOpResult` from Task 1.
- Produces (on `ExchangeExitManager`):
  - `clearExits(symbol: string): Promise<ExitOpResult>` — sends `stopLoss:'0', takeProfit:'0'` (Bybit clears with `"0"`).
  - `marketClose(symbol: string, closeSide: 'Buy' | 'Sell', qty: string): Promise<ExitOpResult>` — reduce-only market order to flatten (time-exit / shutdown / kill, which the exchange stop has no equivalent for).
  - `getOpenSize(symbol: string): Promise<{ size: number; avgPrice: number }>` — current real position size (0 if flat); used to detect exchange-driven closes.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/bot/exchange-exit-manager.test.ts
describe('ExchangeExitManager.clearExits', () => {
  it('sends "0" for both SL and TP to remove the position stop', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const res = await mgr.clearExits('BTCUSDT');
    expect(res.ok).toBe(true);
    expect(client.setTradingStop).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTCUSDT', positionIdx: 0, stopLoss: '0', takeProfit: '0' }),
    );
  });
});

describe('ExchangeExitManager.marketClose', () => {
  it('flattens with a reduce-only market order on the closing side', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const res = await mgr.marketClose('BTCUSDT', 'Sell', '0.01');
    expect(res.ok).toBe(true);
    expect(client.submitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'linear', symbol: 'BTCUSDT', side: 'Sell',
        orderType: 'Market', qty: '0.01', reduceOnly: true,
      }),
    );
  });
});

describe('ExchangeExitManager.getOpenSize', () => {
  it('parses the live position size and avgPrice', async () => {
    const client = mockClient({
      getPositionInfo: vi.fn().mockResolvedValue({
        retCode: 0, retMsg: 'OK',
        result: { list: [{ size: '0.012', side: 'Buy', avgPrice: '60100' }] },
      }),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const r = await mgr.getOpenSize('BTCUSDT');
    expect(r.size).toBeCloseTo(0.012);
    expect(r.avgPrice).toBeCloseTo(60100);
  });

  it('reports size 0 when the venue has no open position', async () => {
    const client = mockClient(); // getPositionInfo returns list: []
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const r = await mgr.getOpenSize('BTCUSDT');
    expect(r.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bot/exchange-exit-manager.test.ts`
Expected: FAIL — `mgr.clearExits is not a function`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add these methods inside class ExchangeExitManager (src/lib/bot/exchange-exit-manager.ts)

/** Remove the position-attached SL/TP (Bybit clears with the string "0"). */
async clearExits(symbol: string): Promise<ExitOpResult> {
  try {
    const resp = await this.client.setTradingStop({
      category: BYBIT_CATEGORY,
      symbol,
      positionIdx: 0,
      tpslMode: 'Full',
      stopLoss: '0',
      takeProfit: '0',
    });
    if (resp.retCode !== 0) {
      return { ok: false, reason: `clearExits retCode=${resp.retCode}: ${resp.retMsg}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Flatten the position with a reduce-only market order (time-exit/shutdown/kill). */
async marketClose(symbol: string, closeSide: 'Buy' | 'Sell', qty: string): Promise<ExitOpResult> {
  try {
    const resp = await this.client.submitOrder({
      category: BYBIT_CATEGORY,
      symbol,
      side: closeSide,
      orderType: 'Market',
      qty,
      reduceOnly: true,
    });
    if (resp.retCode !== 0) {
      return { ok: false, reason: `marketClose retCode=${resp.retCode}: ${resp.retMsg}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Current real position size + avg entry (size 0 ⇒ flat). Never throws. */
async getOpenSize(symbol: string): Promise<{ size: number; avgPrice: number }> {
  try {
    const resp = await this.client.getPositionInfo({ category: BYBIT_CATEGORY, symbol });
    const row = resp.retCode === 0 ? resp.result.list[0] : undefined;
    if (!row) return { size: 0, avgPrice: 0 };
    return { size: parseFloat(row.size) || 0, avgPrice: parseFloat(row.avgPrice) || 0 };
  } catch {
    return { size: 0, avgPrice: 0 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/bot/exchange-exit-manager.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/exchange-exit-manager.ts tests/bot/exchange-exit-manager.test.ts
gmp "add clearExits, marketClose (reduce-only) and getOpenSize to ExchangeExitManager" feat backend
```

---

### Task 3: Config + `closeSideFor` helper

**Files:**
- Modify: `src/lib/bot/config.ts` (add near the other `*_CONFIG` blocks, ~line 175-215)
- Modify: `src/lib/bot/exchange-exit-manager.ts` (export a pure helper)
- Test: `tests/bot/exchange-exit-manager.test.ts`

**Interfaces:**
- Produces:
  - `config.ts`: `export const EXCHANGE_EXIT_CONFIG: ExchangeExitConfig` (re-exported default, `enabled` overridden by CLI in Task 4).
  - `exchange-exit-manager.ts`: `export function closeSideFor(direction: 'long' | 'short'): 'Buy' | 'Sell'` — a long is closed by a `Sell`, a short by a `Buy`. Used by the run-bot wiring to flatten.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/bot/exchange-exit-manager.test.ts
import { closeSideFor } from '@/lib/bot/exchange-exit-manager';

describe('closeSideFor', () => {
  it('closes a long with a Sell and a short with a Buy', () => {
    expect(closeSideFor('long')).toBe('Sell');
    expect(closeSideFor('short')).toBe('Buy');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bot/exchange-exit-manager.test.ts -t closeSideFor`
Expected: FAIL — `closeSideFor is not a function`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to src/lib/bot/exchange-exit-manager.ts (module scope, after the class)
/** The order side that flattens a position of the given direction. */
export function closeSideFor(direction: 'long' | 'short'): 'Buy' | 'Sell' {
  return direction === 'long' ? 'Sell' : 'Buy';
}
```

```typescript
// add to src/lib/bot/config.ts near the other live-bot config blocks (~line 175)
import { DEFAULT_EXCHANGE_EXIT_CONFIG, type ExchangeExitConfig } from './exchange-exit-manager';

// Exchange-Native Protective Exits (live bot only). `enabled` is flipped on by
// the --exchange-exits CLI flag in run-bot; default OFF keeps paper/backtest pure.
export const EXCHANGE_EXIT_CONFIG: ExchangeExitConfig = { ...DEFAULT_EXCHANGE_EXIT_CONFIG };
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run tests/bot/exchange-exit-manager.test.ts && pnpm typecheck`
Expected: vitest PASS; typecheck shows no NEW errors beyond the pre-existing baseline (227 per `docs` note; record the count).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/exchange-exit-manager.ts src/lib/bot/config.ts tests/bot/exchange-exit-manager.test.ts
gmp "add EXCHANGE_EXIT_CONFIG + closeSideFor helper" feat backend
```

---

### Task 4: Construct the manager in run-bot behind `--exchange-exits`

**Files:**
- Modify: `scripts/run-bot.ts` (CLI parse; constructor near `limitOrderExecutor` at `:258-268`; add private field)

**Interfaces:**
- Consumes: `ExchangeExitManager`, `EXCHANGE_EXIT_CONFIG`.
- Produces: `this.exchangeExitManager?: ExchangeExitManager` on the bot class, constructed only when API keys exist AND `--exchange-exits` is passed.

- [ ] **Step 1: Add the field + CLI flag + construction**

```typescript
// near other imports in scripts/run-bot.ts
import { ExchangeExitManager } from '@/lib/bot/exchange-exit-manager';
import { EXCHANGE_EXIT_CONFIG } from '@/lib/bot/config';
import { RestClientV5 } from 'bybit-api';

// add private field alongside `private limitOrderExecutor?: LimitOrderExecutor;`
private exchangeExitManager?: ExchangeExitManager;

// in the constructor, immediately AFTER the limitOrderExecutor block (~:268):
const exchangeExitsRequested = process.argv.includes('--exchange-exits');
if (exchangeExitsRequested) {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  if (apiKey && apiSecret) {
    const client = new RestClientV5({ key: apiKey, secret: apiSecret, testnet: false });
    this.exchangeExitManager = new ExchangeExitManager(client, {
      ...EXCHANGE_EXIT_CONFIG,
      enabled: true,
    });
    console.log('[exchange-exits] ENABLED — SL/TP will be placed on Bybit at fill');
  } else {
    console.warn('--exchange-exits requires BYBIT_API_KEY and BYBIT_API_SECRET env vars');
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no NEW errors vs. the Task 3 baseline.

- [ ] **Step 3: Smoke-run the help/paper path (no keys ⇒ no-op)**

Run: `pnpm tsx scripts/run-bot.ts --help` (or the existing dry invocation)
Expected: process starts; with no `--exchange-exits` flag, no `[exchange-exits]` log line appears.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-bot.ts
gmp "construct ExchangeExitManager behind --exchange-exits flag (default off)" feat backend
```

---

### Task 5: Arm exits on live fill — and FLATTEN if arming fails

**Files:**
- Modify: `scripts/run-bot.ts` `processLimitOrder` (`:1200-1215`, right after `this.tracker.addPosition(position)`)

**Interfaces:**
- Consumes: `this.exchangeExitManager`, `closeSideFor`, `BotPosition`.
- Produces: after a live fill, the position has a reduce-only SL+TP on Bybit; if it can't be armed, the position is flattened and NOT tracked.

**Why flatten-on-failure:** the Global Constraints safety invariant — we never hold an unprotected live position.

- [ ] **Step 1: Add arming + fail-safe flatten after `addPosition`**

```typescript
// in processLimitOrder, replace the success block body after `if (position) {`
if (position) {
  position.regime = result.order.regime;

  // Arm the protective SL+TP on Bybit BEFORE we consider the position "tracked".
  if (this.exchangeExitManager?.isEnabled) {
    const armed = await this.exchangeExitManager.armExits(
      symbol, position.stopLoss, position.takeProfit,
    );
    if (!armed.ok) {
      // Cannot protect the position → flatten immediately (reduce-only market).
      const qty = (position.positionSizeUSDT / result.fillPrice).toString();
      const flat = await this.exchangeExitManager.marketClose(
        symbol, closeSideFor(position.direction), qty,
      );
      console.error(
        `  ${symbol}: ARM FAILED (${armed.reason}) — flattened (${flat.ok ? 'ok' : flat.reason}); position NOT tracked`,
      );
      await this.exchangeExitManager.clearExits(symbol); // belt-and-suspenders
      return;
    }
    console.log(`  ${symbol}: exchange SL=${position.stopLoss} TP=${position.takeProfit} armed`);
  }

  this.tracker.addPosition(position);
  await this.alerts.positionOpened(position);
  console.log(`  ${symbol}: LIMIT FILLED — ${position.direction.toUpperCase()} @ $${result.fillPrice.toFixed(2)} (maker)`);
}
```

```typescript
// ensure closeSideFor is imported at top of run-bot.ts
import { ExchangeExitManager, closeSideFor } from '@/lib/bot/exchange-exit-manager';
```

- [ ] **Step 2: Typecheck + full bot suite (no regressions to existing wiring)**

Run: `pnpm typecheck && pnpm vitest run tests/bot`
Expected: typecheck no new errors; all existing `tests/bot/*` PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/run-bot.ts
gmp "arm exchange SL/TP on live fill; flatten if arming fails (no unprotected positions)" feat backend
```

---

### Task 6: Re-arm SL on breakeven move; clear/flatten on in-process exit

**Files:**
- Modify: `scripts/run-bot.ts` `manageOpenPosition` (`:1116-1168`)

**Interfaces:**
- Consumes: `this.exchangeExitManager`, `closeSideFor`.
- Produces: when our in-process partial-TP moves the SL to breakeven we re-arm the exchange SL; when our in-process logic closes a position (SL/TP/max_bars) we reconcile the exchange — clear the resting stop and, for non-SL/TP exits, flatten the real position first.

**Key correctness rule:** for `stop_loss` / `take_profit` exits the exchange has the identical fixed-price order and may already have executed it, so we only **clear** (idempotent no-op if already gone). For `max_bars` (and force/kill, Task 7) the exchange has NO equivalent, so we must **marketClose then clear**.

- [ ] **Step 1: Re-arm on partial breakeven move**

```typescript
// in manageOpenPosition, inside the `if (!wasPT && position.partialTaken) {` block,
// AFTER `console.log(... SL moved ...)`:
if (this.exchangeExitManager?.isEnabled) {
  const reArmed = await this.exchangeExitManager.armExits(
    position.symbol, position.currentSL, position.takeProfit,
  );
  if (!reArmed.ok) {
    console.error(`  ${position.symbol}: BE re-arm failed (${reArmed.reason}) — exchange SL still at original level`);
  } else {
    console.log(`  ${position.symbol}: exchange SL re-armed to BE ${position.currentSL}`);
  }
}
```

- [ ] **Step 2: Reconcile the exchange when we close in-process**

```typescript
// in manageOpenPosition, AFTER `const closedPos = exitResult.position;`
// and BEFORE `const fundingSeries = await this.buildFundingSeries(closedPos);`
if (this.exchangeExitManager?.isEnabled) {
  if (closedPos.exitReason === 'max_bars' || closedPos.exitReason === 'shutdown') {
    // No exchange equivalent for a time exit — flatten the REAL position first.
    const live = await this.exchangeExitManager.getOpenSize(closedPos.symbol);
    if (live.size > 0) {
      const flat = await this.exchangeExitManager.marketClose(
        closedPos.symbol, closeSideFor(closedPos.direction), live.size.toString(),
      );
      if (!flat.ok) console.error(`  ${closedPos.symbol}: time-exit flatten failed (${flat.reason})`);
    }
  }
  // For SL/TP the exchange already executed (or will) — clear any residual stop.
  await this.exchangeExitManager.clearExits(closedPos.symbol);
}
```

- [ ] **Step 3: Typecheck + full bot suite**

Run: `pnpm typecheck && pnpm vitest run tests/bot`
Expected: typecheck no new errors; all `tests/bot/*` PASS (these paths are gated behind `isEnabled`, so paper tests are unaffected).

- [ ] **Step 4: Commit**

```bash
git add scripts/run-bot.ts
gmp "reconcile exchange exits: re-arm SL to BE on partial, clear/flatten on in-process close" feat backend
```

---

### Task 7: Flatten + clear on shutdown / kill-switch

**Files:**
- Modify: `scripts/run-bot.ts` shutdown force-close loop (`:376-394`)

**Interfaces:**
- Consumes: `this.exchangeExitManager`, `closeSideFor`.
- Produces: graceful shutdown and kill-switch force-close also flatten the REAL Bybit position and clear its resting stop — not just the shadow book.

- [ ] **Step 1: Flatten the real position in the shutdown loop**

```typescript
// in the shutdown handler, inside `for (const position of openPositions) {`
// BEFORE `const result = this.orderManager.forceClose(position, price, 'shutdown');`
if (this.exchangeExitManager?.isEnabled) {
  const live = await this.exchangeExitManager.getOpenSize(position.symbol);
  if (live.size > 0) {
    await this.exchangeExitManager.marketClose(
      position.symbol, closeSideFor(position.direction), live.size.toString(),
    );
  }
  await this.exchangeExitManager.clearExits(position.symbol);
}
const result = this.orderManager.forceClose(position, price, 'shutdown');
```

- [ ] **Step 2: Typecheck + full bot suite**

Run: `pnpm typecheck && pnpm vitest run tests/bot`
Expected: typecheck no new errors; all `tests/bot/*` PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/run-bot.ts
gmp "flatten real Bybit position + clear stop on shutdown/kill when exchange-exits enabled" feat backend
```

---

### Task 8: Testnet end-to-end verification + docs

**Files:**
- Modify: `docs/running.md` (document `--exchange-exits`, the env keys, and the testnet check)
- Verify: live behavior on Bybit **testnet** (`BYBIT_API_KEY`/`SECRET` for testnet; flip the client `testnet: true` temporarily or via env)

**Interfaces:**
- Consumes: the whole feature.
- Produces: a recorded manual verification that the SL/TP actually appears on the venue, survives a process kill, and is cleared on close.

- [ ] **Step 1: Manual testnet run (record the result in the PR description)**

Procedure (no code, this is verification):
1. Set testnet keys; run `pnpm tsx scripts/run-bot.ts --limit-orders --exchange-exits ...` against testnet.
2. After a fill, confirm in the Bybit testnet UI (or `getPositionInfo`) that the position shows a Stop Loss and Take Profit.
3. `kill -9` the bot process; confirm the SL/TP **remain** on the venue (this is the whole point).
4. Restart; let an exit occur; confirm the stop is cleared and no orphan reduce-only order remains.

Expected: SL+TP visible post-fill; survive the kill; cleared after close. **Record pass/fail with screenshots or API output.**

- [ ] **Step 2: Document the flag**

Add to `docs/running.md` under the bot section: the `--exchange-exits` flag, that it requires `BYBIT_API_KEY`/`BYBIT_API_SECRET`, that it is default-off, that it places a position-attached reduce-only SL+TP, and the Phase-2 caveat (partial-TP stays in-process for now).

- [ ] **Step 3: Final full verification**

Run: `pnpm typecheck && pnpm vitest run && pnpm lint`
Expected: typecheck no new errors vs. baseline; full suite green; lint clean.

- [ ] **Step 4: Commit**

```bash
git add docs/running.md
gmp "document --exchange-exits flag + testnet verification procedure" docs docs
```

---

## Phase 2 (separate, gated — do NOT build here)

Move the **fractional partial-TP** onto the exchange as a resting reduce-only order (Bybit `Partial` `tpslMode` with `tpSize`, or a standalone reduce-only limit). This makes the exchange the source of truth for the partial and therefore:
- Requires **fill reconciliation** (poll executions / closed-PnL) to book the partial at the real exchange fill — couples to the reconciliation task in `bot-live-state-and-roadmap`.
- Introduces an accepted **parity change**: the exchange partial fills **intrabar**; our validated Run-20 partial triggers on candle **close**. Document and re-measure before enabling.
Gate Phase 2 behind the reconciliation work; it is not a prerequisite for the crash-safety win Phase 1 delivers.

## Self-Review

- **Spec coverage:** setTradingStop SL+TP ✓ (Task 1); clear/flatten ✓ (Task 2); config+gate ✓ (Tasks 3-4); arm-on-fill + fail-safe flatten ✓ (Task 5); BE re-arm + in-process-close reconcile ✓ (Task 6); shutdown/kill flatten ✓ (Task 7); verification+docs ✓ (Task 8). Full exit replication of the *fractional partial* explicitly deferred to Phase 2 with rationale.
- **Placeholder scan:** none — every code step shows real code; every test shows real assertions.
- **Type consistency:** `ExchangeExitClient`, `ExchangeExitConfig`, `ExitOpResult`, `armExits/clearExits/marketClose/getOpenSize/isEnabled`, `closeSideFor` used identically across tasks; `positionIdx: 0` and `'linear'` constant throughout; `closeSideFor(direction)` returns `'Buy'|'Sell'` consumed by `marketClose`.
