# Exchange-Exit Partial Propagation (Phase 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox steps.

**Goal:** Under `--exchange-exits`, when the in-process partial-TP fires, reduce the REAL Bybit position by the same fraction (market reduce-only) so the venue realizes the partial too — closing the residual post-partial accounting divergence that Phase 2a could not.

**Architecture / design decision (important):** The deferred Phase-2b idea was a *resting reduce-only limit* at the partial-R price — which fills **intrabar**, a parity change vs our candle-close-validated Run-20 partial, requiring a Run-20 re-measurement. **Rejected in favour of a simpler, strictly-better design for a close-validated strategy:** at the exact candle-close moment the shadow takes its partial, send a **market reduce-only** for the fraction. The venue reduces at ~the same price/time as the shadow → the venue's realized PnL matches the shadow's blended PnL → divergence closed, with **NO intrabar parity change** and **no Run-20 re-measure needed** (the trigger is still candle-close; the backtest path is untouched and gated off).

**Why it fixes the divergence:** Before — venue holds 100% SL+TP; on reversal-to-BE the venue sells 100% at BE while the shadow already booked the partial profit (over-reports). After — venue holds only the remainder after the partial reduce; on reversal-to-BE the venue sells the remainder at BE and already realized the partial at ~1.41R, matching the shadow (modulo bounded market slippage on the reduce).

**Residual (documented, not fixed here):** the venue partial fills at a market price ~candle-close ± slippage; the shadow books the partial at candle-close × friction. The size mismatch (the structural divergence) is gone; only a bounded slippage-sized price difference on the partial leg remains — same order as the friction we already model.

## Global Constraints
- No `any`. English. Default-OFF: gated behind `this.exchangeExitManager?.isEnabled`; paper/backtest/Run-20 untouched.
- typecheck no NEW errors vs 227. Full suite green. Feature files lint-clean.
- Reuse the existing fail-safe `marketClose` (reduce-only). `RUN20_STRATEGY_CONFIG.partialTP.fraction` (already imported) is the fraction (all symbols use RUN20).

---

### Task 1: Reduce the venue by the partial fraction at partial-TP

**Files:** Modify `scripts/run-bot.ts` — the in-process partial block in `manageOpenPosition` (the `if (!wasPT && position.partialTaken)` block, ~line 1226), BEFORE the existing SL(BE)+TP re-arm.

- [ ] **Step 1:** In that block, inside `if (this.exchangeExitManager?.isEnabled)`, BEFORE the `armExits` re-arm, add:
```typescript
// Phase 2b: reduce the REAL venue position by the partial fraction (market
// reduce-only) at the SAME candle-close moment the shadow takes its partial, so
// the venue realizes the partial too — closes the residual post-partial divergence
// (without this the venue holds 100% and a reversal-to-BE sells 100% at BE while
// the shadow already booked the partial profit). No intrabar parity change.
const partialFraction = RUN20_STRATEGY_CONFIG.partialTP.fraction;
if (partialFraction > 0 && partialFraction < 1) {
  const liveBeforeReduce = await this.exchangeExitManager.getOpenSize(position.symbol);
  if (liveBeforeReduce.size > 0) {
    const reduceQty = (liveBeforeReduce.size * partialFraction).toString();
    const reduced = await this.exchangeExitManager.marketClose(
      position.symbol, closeSideFor(position.direction), reduceQty,
    );
    if (!reduced.ok) {
      console.error(`  ${position.symbol}: partial venue-reduce failed (${reduced.reason}) — venue still holds full size`);
    } else {
      console.log(`  ${position.symbol}: reduced venue position by ${(partialFraction * 100).toFixed(0)}% (partial)`);
    }
  }
}
```
The existing `armExits(position.currentSL, position.takeProfit)` re-arm then runs and, via `tpslMode: 'Full'`, covers the now-reduced remainder.

- [ ] **Step 2:** Verify — `pnpm typecheck` (227), `pnpm vitest run` (full suite green; gated so paper unaffected), feature files lint-clean. Stage `scripts/run-bot.ts`.

---

### Task 2: Docs

- [ ] Update `RUNNING.md`: the residual post-partial divergence is now closed — the venue is reduced by the partial fraction at partial time (market reduce-only, candle-close, no parity change); only bounded slippage on the partial leg remains. Phase 2b done; partial-on-exchange-as-resting-limit explicitly NOT used (and why).

## Self-Review
- Divergence fix: venue reduced to match shadow remainder ✓. No parity change (candle-close trigger) ✓. Reuses fail-safe marketClose ✓. Gated default-off ✓. 2a reconciliation still correctly handles the eventual remainder close (getOpenSize>0 while remainder open → no spurious reconcile; size 0 + fresh closedPnL on remainder close → reconcile) ✓.
- Residual slippage on the partial leg: documented, bounded, acceptable. Step-rounding dust on `size*fraction`: bounded; noted for audit.
