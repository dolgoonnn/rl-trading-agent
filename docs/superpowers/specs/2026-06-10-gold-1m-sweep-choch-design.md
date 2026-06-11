# Gold 1m Sweep + CHoCH Scalp Strategy — Design

**Date**: 2026-06-10
**Status**: Approved
**Goal**: Reverse-engineer and rigorously backtest the "Bullish Traders AI" TradingView indicator's entry model on 1m/3m gold data, to answer with numbers whether the model has any edge after friction.

## Background

The vendor indicator (invite-only, closed source) was reverse-engineered from six screenshots:
- Swing pivot highs/lows (dense dots → small pivot lookback)
- Liquidity lines extended from unmitigated swing points
- "Sweep" signal: candle wicks through the level but closes back inside
- CHoCH labels for structure-shift bias
- Mechanical bracket verified exactly across all 6 screenshots: **TP1 = entry ± 1.5R (partial), TP2 = entry ± 4R (runner)**, SL at sweep wick extreme ± small buffer (~$0.3–1.0)

Prior art in this repo: Phase 2 scalp results (`experiments/scalp-phase2-results.md`) found **no viable 5m crypto scalp edge** after fixing three look-ahead bugs (1H aggregation, unclosed HTF bar, same-bar entry). This experiment reuses those fixes. Expectation is a clean negative result; the kill gate makes that explicit.

## Decisions (user-approved)

- **Data**: Dukascopy XAUUSD spot, 1m, 2020-01-01 → now (~6.5 years, ~2M candles). Covers COVID spike, 2021–2023 chop, 2024–2026 bull — avoids the Run 12 regime-fitting trap.
- **Timeframes**: configurable `--tf 1|3|5`; test 1m and 3m variants (both appear in vendor screenshots).
- **Approach**: extend the existing scalp harness (`scripts/backtest-scalp.ts`) rather than a standalone script. Its partial-TP exit mode (`fraction@triggerR`, SL→BE, remainder to strategy TP) maps exactly onto the vendor bracket.

## Components

### 1. `scripts/download-gold-1m.ts`
- Clone of `download-gold-data.ts` with `timeframe: 'm1'`, default range 2020-01-01 → now.
- **Monthly** chunks (yearly 1m chunks time out), each saved to `data/.gold-1m-chunks/YYYY-MM.json` so the download is restartable (existing chunk files are skipped).
- Final merge → dedupe → validate (OHLC consistency, gap report, spot-price sanity checks) → `data/XAUUSD_1m.json`.
- The harness already loads `data/{symbol}_1m.json`, so `--symbol XAUUSD` works unchanged.

### 2. `src/lib/scalp/strategies/sweep-choch.ts`
Implements `ScalpStrategy`. Config:

```ts
interface SweepChochConfig {
  swingLookback: number;   // pivot bars each side, default 3
  biasMode: 'choch' | 'none'; // default 'choch'
  slAtrBuffer: number;     // SL buffer in ATR(14) multiples, default 0.3
  targetR: number;         // full TP in R, default 4
  sessionFilter: boolean;  // default true: 07:00–21:00 UTC (London+NY)
}
```

Entry logic (per bar `i`, on execution-TF candles):
1. Confirmed swing points only: a pivot at index `j` counts only when `j ≤ i − swingLookback` (no look-ahead).
2. Find the most recent **unswept** swing low below price (long) / swing high above (short) — no candle between pivot confirmation and `i−1` may have traded through it.
3. Sweep trigger at bar `i`: wick exceeds the level, close back on the original side.
4. Bias filter (`biasMode: 'choch'`): most recent structure break (CHoCH/BOS via `src/lib/ict/market-structure.ts` on the lookback slice) must match trade direction. `'none'` = pure sweep reversal.
5. Signal: `entryPrice = close(i)`, `SL = sweep wick extreme ∓ slAtrBuffer × ATR(14)`, `TP = entry ± targetR × risk`. Harness re-anchors to next bar open preserving distances (existing bug-fix behavior).
6. Confidence score (0–1) for threshold compatibility; matrix runs use `--threshold 0` since the vendor model is binary.

Vendor bracket = harness `--partial-tp "0.5,1.5,0"` (50% at 1.5R, SL→breakeven) + strategy TP at 4R.

### 3. Harness changes (`scripts/backtest-scalp.ts`, `types.ts`)
- `--tf <minutes>` (default 5, accepts 1/3/5): aggregate 1m → TF (passthrough at 1), temp files `${sym}_${tf}m.json`, `timeframe: '${tf}m'` for walk-forward.
- Window/hold defaults scale by `5/tf` when not explicitly passed (keeps ~15d/5d/5d walk-forward and ~3h max hold across TFs). Explicit CLI args override.
- `avgBarsHeld` and log strings use TF minutes instead of hardcoded 5.
- Register `sweep_choch` in `ScalpStrategyName` + `createStrategy()`; new CLI args `--bias-mode`, `--swing-lookback`, `--sl-atr-buffer`, `--target-r`, `--session on|off`.
- HTF path unchanged: `aggregate(execTF, 60)` is window-based and TF-agnostic; closed-bar-only `findHTFIndex` retained.

### 4. Tests (`tests/scalp/sweep-choch.test.ts`, vitest)
Synthetic-candle cases:
- Wick-through + close-back triggers a signal; body-close-through does not.
- Already-swept levels don't re-trigger.
- Pivot confirmation delay (no signal from unconfirmed swings).
- SL/TP math: TP − entry = exactly `targetR ×` risk; partial trigger at 1.5R verified against harness PartialTP logic.
- Bias filter blocks counter-CHoCH signals in `'choch'` mode.

### 5. Experiment matrix → `experiments/gold-1m-sweep-choch.md`
Walk-forward over: TF {1, 3} × bias {choch, none} × friction {0.00005, 0.0001, 0.0002} per side (≈ $0.4–1.7 round trip at $4,200 gold — brackets real spot spread).

**Kill gate (same as Phase 2): WF pass rate < 40% or negative total PnL ⇒ no edge, recorded plainly.** No optimizer pass unless a variant survives friction first.

## Verification
- `pnpm typecheck`, `pnpm lint`, `pnpm test` must pass before results are reported.
- Data quality report (gaps, OHLC errors, spot checks) reviewed before backtesting.

## Risks / honest expectations
- Dukascopy 1m gold may have gaps or thin Asian-session bars; session filter mitigates.
- Spread-to-risk ratio on 1m gold is worse than the 5m crypto tests that already failed; the likely outcome is a validated negative result — which is the point.
