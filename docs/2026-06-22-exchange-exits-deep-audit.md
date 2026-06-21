# Exchange-Native Protective Exits — Deep Verification Audit

**Date:** 2026-06-22 (overnight autonomous run) · **Branch:** `ftr/overnight-bot-hardening` · **Feature commits:** `62cd729..` (Phase 1) → `..8d84fa7` (Phase 2b)
**Auditor:** Claude (SDD execution + 4 parallel deep reviewers: 2× opus, 2× sonnet) + mechanical verification.

> **TL;DR (fill at end):** _<overall go/no-go — merge vs enable-live>_

---

## 1. What was built (3 phases, all behind `--exchange-exits`, default OFF)

| Phase | Delivers | Key commits |
|---|---|---|
| **1** | On a live limit fill, arm SL+TP on Bybit (`setTradingStop`, one-way, `tpslMode:'Full'`). If arming fails → flatten immediately + don't track (safety invariant). On in-process partial-TP → re-arm SL→breakeven. On time-exit/graceful-shutdown → flatten real position + clear. On hard crash → venue stop stays armed. | `62cd729..17738be`, `2ae68ba` |
| **2a** | Per-tick `reconcileExchangeClose` at top of `manageOpenPosition`: venue flat but shadow open → book shadow at the REAL `getClosedPnL.avgExitPrice`. Spurious-close guard: require a close record `closedAtMs > entryTimestamp` (pure `decideExchangeReconcile`, boundary-tested). | `2d41089..c3584b3` |
| **2b** | When the in-process partial fires, reduce the REAL venue position by the partial fraction (market reduce-only, candle-close), then re-arm SL(BE)+TP for the remainder. Closes the residual post-partial accounting divergence. | `8d84fa7` |

**Module:** `src/lib/bot/exchange-exit-manager.ts` (`ExchangeExitManager` + pure `closeSideFor`, `decideExchangeReconcile`). **Wiring:** `scripts/run-bot.ts`. **Config:** `EXCHANGE_EXIT_CONFIG` (default `enabled:false`). **Docs:** `RUNNING.md`. **Tests:** `tests/bot/exchange-exit-manager.test.ts`.

### Key design decisions
1. **Position-attached stop** (`setTradingStop`, `tpslMode:'Full'`) over standalone conditional orders — auto reduce-only, one endpoint also moves SL→BE.
2. **Phase 2a spurious-close guard** — `getOpenSize` returns size 0 on *any* API error, so size-0 alone is not proof of a close; require a `getClosedPnL` record post-dating entry (one-way mode ⇒ an open position can't have a close newer than its own entry). Rejects both API-error and stale prior-trade records. Pure + boundary-tested.
3. **Phase 2b uses a MARKET reduce-only at candle-close, NOT a resting limit at the partial price** — deliberately avoids an intrabar-vs-candle-close parity change, so Run-20 needs **no re-measurement** and the backtest path is untouched. Trade-off: a bounded market-slippage difference on the partial leg (same order as modelled friction) instead of the structural 50% size mismatch.

---

## 2. Mechanical verification (re-run independently this session)

| Check | Result |
|---|---|
| `pnpm typecheck` | **227 errors** — unchanged pre-existing baseline, **zero new** ✓ |
| `pnpm vitest run` (full) | **344 / 344 passing** (37 files; +24 over the 320 pre-feature baseline) ✓ |
| `pnpm lint` (feature files) | `exchange-exit-manager.ts`, `config.ts`, `run-bot.ts` — **zero lint hits** ✓ (repo-wide 96-error baseline is pre-existing, unrelated) |

## 3. Run-20 / backtest "untouched" proof

- **Structural:** `scripts/backtest-confluence.ts` imports **none** of the feature (`grep` for `exchange-exit-manager|ExchangeExitManager|run-bot` → no matches). The feature lives only in the live-bot path + the new module.
- **Config additive:** the only `config.ts` change in the feature range is the additive `EXCHANGE_EXIT_CONFIG` block; `RUN20_STRATEGY_CONFIG` is byte-unchanged.
- **Empirical Run-20 backtest (this session):** Overall PnL **+309.81%**, WR **44.6%**, **657 trades**, **WF pass rate 64.9%**. This matches the documented "Run-20 on refreshed data: 64.9% WF" (project memory) — i.e. the feature did **not** perturb the backtest. (The backtest's own WF "verdict: FAILED" is a *pre-existing* property of Run-20 on current data vs the internal gate, NOT introduced by this feature.)

**Conclusion:** ✅ the feature cannot — and empirically does not — affect the paper-forward run or Run-20. Structural proof (no import) + additive config + a matching backtest number are three independent confirmations.

---

## 4. Deep review findings (4 independent reviewers)

### A. End-to-end safety invariant + shadow↔venue accounting (opus)
_<fill: per-path table 1-11, verdict, findings>_

### B. Adversarial correctness bug hunt (opus) — BUGS FOUND (3 real + cleared list)
- **C1 (Critical, fix-before-live):** `run-bot.ts` partial reduce `reduceQty = (size * fraction).toString()` violates Bybit `qtyStep` (SOL 1.5→0.75 step 0.1; BTC 0.123→0.0615 step 0.001; DOGE 1235→617.5 step 1) → reduce-only reject → venue keeps 100% while shadow booked the partial → Phase 2b silently no-ops on many trades. **Fix:** round qty down to `qtyStep`, skip if `< minOrderQty`.
- **C2 (Critical, fix-before-live):** after a *failed* reduce, the unconditional `armExits` re-arm (`tpslMode:'Full'`) covers the still-full venue position → 100% dumped at final TP. **Fix:** only treat the partial as venue-realized when `reduced.ok`.
- **I1 (Important, fix-before-live):** Bybit closed-PnL is eventually-consistent — `getOpenSize` flips flat before the PnL record lands; `decideExchangeReconcile` returns null (no record) so reconcile is skipped, but the code falls through to the in-process exit and can manage a phantom position until the record appears (esp. when the venue fired on MarkPrice but the candle didn't cross SL). **Fix:** "venue flat + no record yet" ⇒ reconcile-pending, return early; don't fall through.
- **I2 (Important, fix-before-live):** `getOpenSize` returns `{size:0}` on API error too; time-exit (`:1277`) and shutdown (`:435`) flatten paths read 0 → skip `marketClose` → then `clearExits` removes the protective stop → **orphaned unprotected live position** (the exact failure mode the feature prevents) on a single transient read error. **Fix:** distinguish error from flat (return `null` on error); fail *closed* on the flatten paths (don't clear the stop when the venue state is unknown).
- **M1/M2 (Minor, acceptable):** reason-inference relies on the size-gate (fragile but currently correct); `entryTimestamp=Date.now()` vs venue ms could clock-skew-reject a close (fails safe → missed reconcile, self-heals).
- **Cleared (verified NOT bugs):** `closeSideFor` direction; `<=` boundary; full-close `size.toString()` (venue-reported, step-aligned); `parseInt(updatedTime)` fail-safe; `Number.isFinite` guard; disabled no-op returns; circular import; within-tick single-act; `reduceOnly:true` present on every order; `submitOrder`/`setTradingStop`/`getClosedPnL` call shapes match installed bybit-api required params (independent check).

### C. Default-OFF gating completeness + paper inertness (sonnet) — ✅ PROVABLY INERT WHEN OFF, zero findings
- **All 24 `exchangeExitManager` references** in run-bot.ts verified null-safe/guarded: every `?.isEnabled` block entry narrows the type, and all 15 direct (non-`?.`) calls sit inside such blocks. No unguarded call.
- **All 5 client-calling methods** (armExits, clearExits, marketClose, getOpenSize, getRealizedClose) carry the defense-in-depth `!config.enabled` early-return. Zero gaps.
- **Construction** double-gated: `--exchange-exits` flag AND both `BYBIT_API_KEY`/`SECRET`; field stays `null` otherwise. `EXCHANGE_EXIT_CONFIG.enabled=false` cannot flip at module-init.
- **Backtest untouched:** `backtest-confluence.ts` has zero feature references; `RUN20_STRATEGY_CONFIG` byte-unchanged.
- **Paper-mode trace:** manager `null` → reconcile early-returns, partial/close/arm/shutdown blocks all skipped (`null?.isEnabled` falsy). The forward track record is unaffected.
- **Findings: NONE.**

### D. Test coverage gap analysis (sonnet)
_<fill: coverage map, critical gaps, proposed tests, merge/live verdict>_

---

## 5. Triage & fixes applied this session
_<fill: each Critical/Important finding → fixed (commit) / deferred (why)>_

## 6. Residual risks & before-live gates
_<fill>_

## 7. Verdict
- **Merge (default-OFF):** _<yes/no>_
- **Enable `--exchange-exits` live:** _<blocked on: testnet checklist (RUNNING.md), + any findings>_
