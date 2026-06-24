# Exchange-Exit Per-Tick Reconciliation (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Under `--exchange-exits`, detect each tick when the exchange has closed a position our shadow still thinks is open (the SL/TP fired on Bybit), and reconcile the shadow at the *real* exchange exit price — so the bot never keeps "managing" a flat position and its equity tracks the venue after an exchange-driven close.

**Architecture:** Add a `getRealizedClose(symbol)` to `ExchangeExitManager` (Bybit V5 `getClosedPnL`, most-recent record → real `avgExitPrice`). At the top of `manageOpenPosition`, before the in-process exit check, poll `getOpenSize`; if the exchange is flat but the shadow position is open, the exchange closed it — close the shadow at the real exit price (reason inferred from proximity to SL vs TP), clear residual stops, and skip the in-process check for that tick (no double-close). All gated behind `this.exchangeExitManager?.isEnabled`; default-OFF, so paper/backtest/Run-20 are untouched.

**Tech Stack:** TypeScript (strict), `bybit-api` v4.5.3 `RestClientV5`, vitest.

## Global Constraints
- No `any`; `as any` banned. English. Commit with `gmp "<msg>" <type> <scope>`.
- Default-OFF: every new exchange call gated behind `?.isEnabled`; `ExchangeExitManager` is `null` in paper mode.
- All Bybit calls fail-safe: never throw into the tick loop; return a typed value (`null`/`{ok,reason}`).
- typecheck: no NEW errors vs the 227 baseline. Full suite stays green.
- Bybit category `linear`, one-way mode `positionIdx: 0`.

## Scope
This is **Phase 2a** (close-reconciliation). It fixes "shadow manages a position the exchange already closed" and books the close at the real exit price. It does **NOT** eliminate the *partial-TP PnL divergence* documented in `RUNNING.md` — that needs **Phase 2b** (move the fractional partial-TP onto the exchange as a resting reduce-only order + book it from the exchange fill), which carries the intrabar-vs-close parity change and is out of scope here. After 2a, the shadow still books the in-process partial at the candle-close price; 2a only reconciles the *final* close.

**Design decision (booking price):** reconcile the shadow close at the **real exchange `avgExitPrice`** (from `getClosedPnL`), not at the SL/TP trigger level — accuracy over one extra API call, since correct equity is the whole point.

---

### Task 1: `getRealizedClose` on ExchangeExitManager

**Files:**
- Modify: `src/lib/bot/exchange-exit-manager.ts`
- Test: `tests/bot/exchange-exit-manager.test.ts`

**Interfaces:**
- Consumes: existing `ExchangeExitClient`, `BYBIT_CATEGORY`.
- Produces:
  - Extend `ExchangeExitClient` with `getClosedPnL(params: { category: 'linear'; symbol: string; limit?: number }): Promise<{ retCode: number; retMsg: string; result: { list: Array<{ avgExitPrice: string; closedPnl: string; side: string; qty: string; updatedTime: string }> } }>`.
  - `getRealizedClose(symbol: string): Promise<{ exitPrice: number; closedPnl: number } | null>` — most-recent closed-PnL record's `avgExitPrice`/`closedPnl`; `null` when disabled, on error, on empty list, or on an unparseable price.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/bot/exchange-exit-manager.test.ts (the mockClient factory already
// stubs setTradingStop/submitOrder/getPositionInfo; add a getClosedPnL stub default
// in the factory: getClosedPnL: vi.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK', result: { list: [] } }),)
describe('ExchangeExitManager.getRealizedClose', () => {
  it('returns the most-recent realized exit price and pnl', async () => {
    const client = mockClient({
      getClosedPnL: vi.fn().mockResolvedValue({
        retCode: 0, retMsg: 'OK',
        result: { list: [{ avgExitPrice: '64250.5', closedPnl: '12.3', side: 'Sell', qty: '0.01', updatedTime: '1' }] },
      }),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const r = await mgr.getRealizedClose('BTCUSDT');
    expect(r).not.toBeNull();
    expect(r!.exitPrice).toBeCloseTo(64250.5);
    expect(r!.closedPnl).toBeCloseTo(12.3);
  });

  it('returns null when the closed-PnL list is empty', async () => {
    const client = mockClient(); // getClosedPnL default → list: []
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    expect(await mgr.getRealizedClose('BTCUSDT')).toBeNull();
  });

  it('returns null when disabled — never touches the exchange', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: false, triggerBy: 'MarkPrice' });
    expect(await mgr.getRealizedClose('BTCUSDT')).toBeNull();
    expect(client.getClosedPnL).not.toHaveBeenCalled();
  });

  it('returns null and does not throw on a client error', async () => {
    const client = mockClient({ getClosedPnL: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    expect(await mgr.getRealizedClose('BTCUSDT')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run tests/bot/exchange-exit-manager.test.ts -t getRealizedClose` → FAIL (`getRealizedClose is not a function`), and the factory needs the `getClosedPnL` stub (add it).

- [ ] **Step 3: Write minimal implementation**

```typescript
// extend ExchangeExitClient interface (add the method):
  getClosedPnL(params: { category: 'linear'; symbol: string; limit?: number }): Promise<{
    retCode: number;
    retMsg: string;
    result: { list: Array<{ avgExitPrice: string; closedPnl: string; side: string; qty: string; updatedTime: string }> };
  }>;

// add method on ExchangeExitManager:
/** Most-recent realized close for the symbol (exit price + pnl). Null when
 *  disabled / no record / error. Never throws. */
async getRealizedClose(symbol: string): Promise<{ exitPrice: number; closedPnl: number } | null> {
  if (!this.config.enabled) return null;
  try {
    const resp = await this.client.getClosedPnL({ category: BYBIT_CATEGORY, symbol, limit: 1 });
    const row = resp.retCode === 0 ? resp.result.list[0] : undefined;
    if (!row) return null;
    const exitPrice = parseFloat(row.avgExitPrice);
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) return null;
    return { exitPrice, closedPnl: parseFloat(row.closedPnl) || 0 };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm vitest run tests/bot/exchange-exit-manager.test.ts` → all pass.
- [ ] **Step 5: Typecheck** — `pnpm typecheck` → 227. Then stage `src/lib/bot/exchange-exit-manager.ts tests/bot/exchange-exit-manager.test.ts` (controller commits with `gmp`).

---

### Task 2: Per-tick reconciliation in `manageOpenPosition`

**Files:**
- Modify: `scripts/run-bot.ts` (top of `manageOpenPosition`, ~line 1173)

**Interfaces:**
- Consumes: `getOpenSize`, `getRealizedClose`, `clearExits`, `isEnabled`; `this.orderManager.forceClose`, `this.tracker.closePosition`, `this.buildFundingSeries`, `this.alerts.positionClosed`.
- Produces: a private helper `reconcileExchangeClose(position): Promise<boolean>` returning `true` when it reconciled (caller then returns early).

- [ ] **Step 1: Add the reconciliation helper + early call**

At the very top of `manageOpenPosition`, before `const wasPT = ...`:
```typescript
// If the exchange already closed this position (its SL/TP fired), reconcile the
// shadow now and skip the in-process check this tick (prevents managing a flat
// position / double-close).
if (await this.reconcileExchangeClose(position)) return;
```

Add the helper method:
```typescript
/**
 * When `--exchange-exits` is on: detect that the venue has flattened a position
 * our shadow still holds open (the exchange SL/TP fired), and close the shadow at
 * the REAL exchange exit price. Returns true if it reconciled (caller returns).
 * Reason is inferred from proximity to currentSL vs takeProfit.
 */
private async reconcileExchangeClose(position: BotPosition): Promise<boolean> {
  if (!this.exchangeExitManager?.isEnabled) return false;
  const live = await this.exchangeExitManager.getOpenSize(position.symbol);
  if (live.size > 0) return false; // still open on the venue — nothing to reconcile

  // Venue is flat but we hold the shadow open → the exchange closed it.
  const realized = await this.exchangeExitManager.getRealizedClose(position.symbol);
  const exitPrice = realized?.exitPrice
    ?? (Math.abs(position.takeProfit - position.currentSL) > 0
        ? position.currentSL
        : position.currentSL); // fallback: known stop level if closed-PnL unavailable
  const reason: ExitReason =
    Math.abs(exitPrice - position.takeProfit) < Math.abs(exitPrice - position.currentSL)
      ? 'take_profit'
      : 'stop_loss';

  const result = this.orderManager.forceClose(position, exitPrice, reason);
  const fundingSeries = await this.buildFundingSeries(result.position);
  this.tracker.closePosition(result.position, fundingSeries);
  await this.alerts.positionClosed(result.position);
  await this.exchangeExitManager.clearExits(position.symbol);
  console.log(`  ${position.symbol}: RECONCILED exchange close @ $${exitPrice} (${reason})`);

  const triggered = this.riskEngine.evaluateAfterTrade(this.tracker);
  for (const cb of triggered) await this.alerts.circuitBreakerTriggered(cb.type, cb.reason);
  this.tracker.saveState();
  this.tracker.recordSnapshot();
  return true;
}
```
Confirm `BotPosition` and `ExitReason` are already imported in run-bot.ts (they are — used by manageOpenPosition). Confirm `forceClose(position, price, reason)` signature matches (it does: `(position, currentPrice, reason)`).

- [ ] **Step 2: Verify** — `pnpm typecheck` (227) + `pnpm vitest run tests/bot` (all pass; the new code is gated, so paper-mode tests are unaffected). Stage `scripts/run-bot.ts` (controller commits).

---

### Task 3: Docs + final verification

**Files:** Modify `RUNNING.md`; verify whole repo.

- [ ] **Step 1:** In the `RUNNING.md` `--exchange-exits` section, update the post-partial caveat: per-tick reconciliation now closes the shadow at the real exchange exit price when the venue's SL/TP fires (so the bot no longer manages a flat position), BUT the *fractional partial-TP* is still booked in-process at the candle-close price (Phase 2b — partial on the exchange — remains deferred), so a small post-partial PnL divergence persists; still reconcile against Bybit balance for exactness.
- [ ] **Step 2:** Final verify — `pnpm typecheck` (227), `pnpm vitest run` (full suite green), feature files lint-clean. Stage `RUNNING.md`.

---

## Phase 2b (future, separate plan)
Move the fractional partial-TP onto the exchange (Bybit `Partial` tpslMode `tpSize`, or a standalone reduce-only limit at the partial-R price), and book the partial from the exchange fill via the same reconciliation. Eliminates the residual post-partial PnL divergence. Carries the accepted intrabar-vs-close parity change; re-measure Run-20 net-of-parity before enabling.

## Self-Review
- Coverage: getRealizedClose (Task 1) ✓; per-tick close detection + real-price booking + reason inference + skip-in-process (Task 2) ✓; docs + verify (Task 3) ✓. Partial-on-exchange explicitly deferred to 2b.
- No placeholders; every code step is complete. Types: `getRealizedClose` returns `{exitPrice,closedPnl}|null` consumed in Task 2; `reconcileExchangeClose` returns `boolean` consumed by the early-return.
