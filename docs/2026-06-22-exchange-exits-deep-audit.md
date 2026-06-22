# Exchange-Native Protective Exits — Deep Verification Audit

**Date:** 2026-06-22 (overnight autonomous run) · **Branch:** `ftr/overnight-bot-hardening` · **Feature commits:** `62cd729..` (Phase 1) → `..8d84fa7` (Phase 2b)
**Auditor:** Claude (SDD execution + 4 parallel deep reviewers: 2× opus, 2× sonnet) + mechanical verification.

> **TL;DR:** Plan finished — Phase 1 + 2a + 2b built (`--exchange-exits`, default OFF). A 4-reviewer deep audit found the feature **provably inert when off** (safe to merge; backtest/Run-20 empirically unchanged at 64.9% WF) but **NOT live-safe as originally built** — 5 Critical issues, headlined by an orphaned-unprotected-position bug on the SL/TP close path (shadow uses LastPrice klines, the venue stop uses MarkPrice). This session **fixed the highest-leverage cluster under test** (flatten-to-flat before clearExits on every close path; `getOpenSize` error-vs-flat fail-closed; 3-state reconcile; qty-step rounding) — typecheck 227, suite **358/358**. **Verdict: MERGE yes (default-off); ENABLE LIVE no** until the §6 gates close (fill→arm window C3-A, friction/mode I3-A, full double-fail handling C2-A, wiring harness, and the testnet checklist).

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

### A. End-to-end safety invariant + shadow↔venue accounting (opus) — UNSAFE pre-fix; the highest-value findings
Verdict (pre-fix): **UNSAFE — FIX FIRST.** Pure helpers sound, gating airtight, but the wiring could orphan a real unprotected position. Per-path trace (11 paths): paths 1-5, 7, 8, 10 CONSISTENT; **6, 9, 11 DIVERGE**. Findings:
- **C1-A (Critical) — trigger-reference mismatch orphans on the SL/TP close path.** Shadow detects SL/TP from LastPrice klines; venue stop fires on **MarkPrice**. The close path only flattened for `max_bars`/`shutdown` and otherwise just `clearExits` ("the venue already fired"). A LastPrice wick that hits the shadow SL while MarkPrice didn't → `clearExits` removes the venue stop → **real position open, unprotected, untracked.** The exact failure mode the feature prevents, on the most common path. → **FIXED** (see §5).
- **C2-A (Critical) — arm-fail + flatten-fail → silent invisible orphan** (open, stop-less, untracked, no retry/alert). → **PARTIALLY FIXED** (now LOUD; full kill-latch+retry deferred, §6).
- **C3-A (Critical) — fill→arm window.** The entry limit order is bare (`reduceOnly:false`, no attached SL/TP); the position is unprotected on the venue between fill and the *next-tick* `armExits`. A crash in that window orphans it. → **NOT FIXED** (§6) — needs SL/TP attached to the entry order.
- **I1-A (Important) — shutdown flatten-fail still cleared the stop** (mislabeled "SL still armed"). → **FIXED** (fail-closed).
- **I2-A (Important) — partial-reduce-fail accounting divergence** (venue keeps 100%, still protected, but shadow booked the partial). → **MITIGATED** (qty-step rounding makes the reduce succeed in the common case; residual logged).
- **I3-A (Important) — friction double-count.** `--exchange-exits`/`--limit-orders` gate only on flags, not `config.mode`; default `'paper'` mode keeps `simulatesFills=true`, adding simulated friction on top of REAL venue fills. → **NOT FIXED** (§6) — require `--mode live`.
- **I4-A (Important) — zero integration-test coverage** of the 11 wired paths. → **PARTIALLY ADDRESSED** (pure helpers now tested; wiring harness deferred, §6).
- A's headline recommendation (implemented): **always reconcile the venue to flat (`getOpenSize`→`marketClose`) before `clearExits` on every close path — never assume the venue stop fired.**

### D. Test coverage gap analysis (sonnet)
- Module methods well-covered (happy/error/disabled); `decideExchangeReconcile` boundary-covered. **Wiring untested.** Verdict: **adequate to MERGE (default-off); NOT adequate to ENABLE LIVE.**
- Critical gaps (pre-fix): arm-fail→flatten branch, Phase-2b partial qty arithmetic, shutdown flatten, `getOpenSize`/`getRealizedClose` error paths. → Pure-helper extraction + tests **added this session** (`computePartialReduceQty`, `selectFlattenQty`, `roundQtyToStep`, `getOpenSize` null paths). Remaining: a `run-bot` wiring harness for the orchestration paths (§6).

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

## 5. Triage & fixes applied this session (commit `3181393`)

| Finding | Severity | Disposition |
|---|---|---|
| **C1-A** flatten-to-flat before clearExits on ALL close paths (orphan on LastPrice/MarkPrice mismatch) | Critical | ✅ **FIXED** — close block now `getOpenSize`→`marketClose` if size>0→`clearExits` only on success; fail-closed on `null`/flatten-fail (stop left armed). |
| **I2-B / I2-A** `getOpenSize` conflated error & flat | Important | ✅ **FIXED** — returns `null` on API error (UNKNOWN); all 5 call sites fail-closed on `null`. |
| **I1-A** shutdown flatten-fail still cleared the stop | Important | ✅ **FIXED** — shutdown only `clearExits` once flat confirmed/forced. |
| **I1-B** eventual-consistent closedPnL → phantom management | Important | ✅ **FIXED** — `reconcileExchangeClose` now 3-state; `'pending'` (flat, no record yet) skips the in-process exit. |
| **C1-B** partial-reduce qty violates `qtyStep` | Critical | ✅ **FIXED** — `computePartialReduceQty` rounds DOWN to step; null when sub-step. |
| **C2-B** re-arm after failed reduce | Critical | ✅ **MITIGATED** — qty-step makes the reduce succeed in the common case; on failure the position stays protected (re-arm runs) + loud log; accounting residual documented. |
| **C2-A** arm+flatten double-fail silent orphan | Critical | 🟡 **PARTIAL** — now a LOUD CRITICAL log + `selectFlattenQty` + clearExits-on-success. Full kill-latch + retry deferred (§6). |
| **I4 / D** untested wiring | Important | 🟡 **PARTIAL** — pure helpers extracted + tested (358/358 suite, +14). Wiring harness deferred (§6). |
| **C3-A** fill→arm protection window | Critical | ❌ **DEFERRED** (§6). |
| **I3-A** friction double-count in paper mode vs real fills | Important | ❌ **DEFERRED** (§6). |
| M1/M2/M3 (slippage, clock-skew, reason label) | Minor | Accepted/documented. |

Post-fix verification: typecheck **227**, full suite **358/358**, feature files lint-clean. **Independent opus re-review of the fix pass: "FIXES CORRECT, NO REGRESSION"** — headline orphan walked line-by-line and confirmed closed; `null` fail-closed at all 5 `getOpenSize` call sites; 3-state reconcile cannot strand an open position; no 2a/close-block double-act (reduce-only + mutual exclusion); partial-reduce stays protected after a failed reduce. Two new **Minor** notes (both accepted): (a) `SYMBOL_QTY_STEP` covers only BTC/ETH/SOL — a coarse-step symbol added later would fall back to the finer default and its partial reduce could reject (latent on universe expansion; in-code comment already warns → see §6.5); (b) no watchdog on a persistent `'pending'` reconcile state (venue is already flat so no unprotected exposure; self-heals when the closedPnL record lands; shutdown cleans up).

## 6. Residual risks & before-live gates (MUST do before enabling `--exchange-exits` with real money)

1. **C3-A — attach SL/TP to the ENTRY order** (`limit-order-executor.ts`): pass `stopLoss`/`takeProfit`/`tpslMode` on the entry `submitOrder` so the position is *born* protected, closing the fill→arm window. The post-fill `armExits` then becomes an idempotent confirm. (Couples `--limit-orders` with `--exchange-exits`.)
2. **I3-A — require `--mode live`** whenever `--exchange-exits`/`--limit-orders` is set (error out otherwise), so `simulatesFills` is off and shadow PnL books at raw venue prices (no double-counted friction).
3. **C2-A — full double-fail handling:** on arm-fail + flatten-fail, latch the kill-switch (`setKillFlag`, needs the `db` handle threaded into `processLimitOrder`), retry the flatten on later ticks, and push a critical Telegram alert — not just a log.
4. **Wiring test harness:** add `tests/bot/run-bot-wiring.test.ts` (mock `ExchangeExitManager`/tracker/orderManager) covering paths 1, 4, 6, 9, 11 — arm-fail→no-track, partial→reduce→reversal-to-BE, shutdown flatten-fail, the flatten-to-flat close path.
5. **`SYMBOL_QTY_STEP` is a STATIC table** (BTC 0.001 / ETH 0.01 / SOL 0.1). Verify against `getInstrumentsInfo` (and add any new symbol) before live — a wrong step silently breaks the partial reduce.
6. **Testnet checklist** (`RUNNING.md`): place a fill → confirm SL/TP on the venue → `kill -9` → confirm the stop survives → confirm it clears on exit. **NOT yet run.**
7. Spot-check realized PnL vs the Bybit account balance on the first live trades (bounded slippage on partial/market-reduce legs).

## 7. Verdict

- **Merge (default-OFF):** ✅ **YES.** The feature is provably inert when the flag is off (Audit C, zero findings; backtest/Run-20 empirically unchanged at 64.9% WF). It cannot affect the paper-forward run or Run-20. The default-off code is clean, typed, fail-safe, and 358/358 tested.
- **Enable `--exchange-exits` LIVE:** ⛔ **NOT YET.** The most dangerous orphan paths (C1-A close-path, I1/I2 fail-closed, C1-B qty-step) are now fixed and tested, but **C3-A (fill→arm window), I3-A (mode/friction), and the full C2-A double-fail handling remain** — plus the testnet checklist has not been run. Clear the §6 gates first.
- **Net:** the deep audit found the feature was *not* live-safe as built (5 Critical), the highest-leverage failures are now fixed under test, and the remaining gates are precisely specified. Strong default-off feature; do not point real capital at it until §6 is closed.
