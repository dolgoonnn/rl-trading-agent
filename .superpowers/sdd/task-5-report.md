# Task 5 Report — Leverage Sweep Core + CLI

## Status: COMPLETE

## Files Touched

| File | Action |
|------|--------|
| `src/lib/sim/leverage-sweep-core.ts` | NEW — pure core: `sweepLeverage()`, `SweepRow`, `SweepEntry`, `SweepOpts` |
| `src/lib/sim/index.ts` | MODIFIED — added `export * from './leverage-sweep-core'` |
| `scripts/leverage-sweep.ts` | NEW — CLI glue: loads dump, resolves candles, calls core, prints table |
| `tests/sim/leverage-sweep-core.test.ts` | NEW — TDD test (11 tests, all green) |

## TDD flow

- RED: test file created first, failed with `Cannot find package '@/lib/sim/leverage-sweep-core'`
- GREEN: core implemented, all 11 tests pass immediately
- REGRESSION: all 65 pre-existing tests continue to pass (total 76/76)

## Design decisions

### `sweepLeverage` interface

The core function takes `SweepEntry[]` (not `DumpedPosition[]`) so it is independent of the dump format. The CLI is responsible for converting `DumpedPosition → SweepEntry` by resolving the `entryIndex` from the candle array via timestamp search.

### `entryIndex` resolution in the CLI (critical)

`DumpedPosition` does not store `entryIndex`. The CLI finds it via:
```ts
const entryIdx = candles.findIndex((c) => c.timestamp >= pos.entryTimestamp);
position.entryIndex = entryIdx;
```
This ensures `barsHeld = i - entryIndex` starts at 1 on the first simulation bar (startIndex = idx + 1). Setting `entryIndex = 0` (as a naive placeholder) caused `barsHeld` to start at ~2727 >> `maxBars=160`, triggering immediate max_bars exits on every position and producing ~−0.7% return per trade (double friction with no gain).

### Sharpe definition

Per-trade Sharpe using population std, not annualized. Documented in source with explicit disclaimer. Uses `stepReturns` from `buildLeverageEquityCurve` — these are equity step returns (levered), not raw trade netReturns. This gives a relative ordering metric across leverage levels; DSR is out of scope.

### Composition

All simulation math delegated:
- `simulatePosition` — bar-by-bar exit resolution + liquidation flag
- `buildLeverageEquityCurve` — compounding, liqRate, maxDD, blown
- `DefaultFillModel` + `FlatFrictionCostModel` — fill and cost
- No re-derivation of any liquidation, compounding, or fill math

## Test assertions

1. Returns one row per leverage level (order preserved)
2. `row.trades` == 3 for all rows (all positions resolvable in fixture)
3. At L=1: `liqRate === 0` (liquidation buffer ~99.5%)
4. At L=1: `terminalWealth > 1` (positions hit TP)
5. At L=50: `liqRate > 0` (bar low pierces liqPrice = entry*0.985 at d=0.015)
6. `liqRate` is NON-DECREASING as L increases [1, 5, 50]
7. `maxDD` at L=50 >= `maxDD` at L=1
8. `blown === false` at L=1
9. `sharpe` is finite for all rows
10. L=1 `terminalWealth` matches hand-computed `(1 + L*f*netReturn)^3 = 1.006^3` (TP at +6%)

## CLI smoke test on real Run-20 dump (657 positions)

```
Loaded 657 positions from .../run20-positions.json
Symbols: 3 (0 missing candles). Entries for sweep: 657/657 (0 skipped).

Leverage curve (f=0.02, mmr=0.005, liqFee=0.005, friction=0.0007):

 L  terminalWealth  liqRate%  maxDD%  sharpe  blown  trades
--  --------------  --------  ------  ------  -----  ------
 1          1.0598     0.00%   2.22%  0.0817  false     657
 5          1.3265     0.00%  10.67%  0.0817  false     657
10          1.5972     1.07%  21.80%  0.0702  false     657

Best leverage by terminalWealth: L=10 (1.5972)
First L where liqRate > 1%: L=10 (1.07%)

L=1 fidelity sanity:
  terminalWealth = 1.059797  [must be > 1: PASS]
  trades = 657 / 657 dumped  [skipped = 0]  [PASS]
  L=1 sanity: PASS — dump reproduces Run-20 edge at base leverage.
```

## Pre-existing typecheck errors

`pnpm typecheck` reports errors in other scripts (analyze-ict-signals.ts, backtest-ict-rules.ts, baseline-strategy.ts, etc.) that are pre-existing and unrelated to this task. Zero errors in any of the four touched files.

## Concerns

None. The implementation is complete and correct.
