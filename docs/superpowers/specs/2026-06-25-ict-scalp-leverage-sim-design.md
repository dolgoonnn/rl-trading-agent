# ICT Scalp Leverage / Liquidation Simulator — Design Spec

**Date:** 2026-06-25
**Status:** Approved (design) → ready for implementation plan
**Scope:** Research / simulation only. Nothing in this spec touches the live or paper trading bot.

---

## 1. Motivation

"Full margin scalp" is marketed as an ICT *model*. It is not. It decomposes into two layers:

1. **Signal layer** — the ICT scalp entry (killzone → liquidity draw → Sweep → Displace → Retrace → Enter at OTE). This already exists in the repo: `src/lib/scalp/strategies/ict-5m.ts`.
2. **Sizing layer** — max leverage (50–125x) with a stop tighter than the liquidation distance, so dollar risk stays small but notional is huge.

Leverage creates **zero alpha**. It is a monotonic transform on whatever edge the underlying signal already has: it amplifies returns *and* ruin probability together. The math is unforgiving:

- If the scalp has **no edge** → leverage guarantees ruin faster.
- If the scalp **has edge** → Kelly defines an optimal bet fraction, and "full margin" is almost always deep in the *overbetting* regime where the long-run growth rate goes **negative** even for a positive-expectancy system.

The goal is therefore **not** to deploy full margin. It is to build a liquidation-aware simulation layer that *measures* what leverage does to the existing scalp's equity curve, and finds the growth-maximizing leverage `L*` and the ruin cliff `L_ruin`. This converts "this is wild" into a defensible number and stays inside the project's "validate before deploying" discipline.

## 2. Goal & Success Criteria

**Goal:** For the `ict_5m` scalp on BTC/ETH/SOL/XAUUSD, produce the growth-rate-vs-leverage curve (the "Kelly hump") overlaid with ruin probability.

**Success criteria:**
- A reproducible report (JSON + terminal ASCII plot) reporting, per leverage level: total return, mean log-growth per trade, MaxDD, liquidation count, ruin %.
- `L*` (growth-maximizing leverage) and `L_ruin` (leverage where ruin % first crosses 5%) explicitly identified, per-symbol and combined.
- The harness is validated against a synthetic known-edge series (theory check), so the numbers are trustworthy.
- Pre-condition gate: the 1x baseline expectancy of `ict_5m` on this data is reported first. If it is ≤ 0, that is itself the finding — leverage analysis is moot and we stop.

**Non-goals (YAGNI):** no live/paper bot wiring, no cross-margin, no multi-position concurrency, no new signal work, no generic project-wide trade-log schema.

## 3. Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Scope | Sim / research only — no live deployment |
| Signal under test | `ict_5m` |
| Universe | BTCUSDT, ETHUSDT, SOLUSDT, XAUUSD (1m candles; all present in `data/`) |
| Leverage treatment | Sweep a grid → growth-rate + ruin curve |
| Architecture | A — post-hoc trade re-simulation (isolated module, signal layer untouched) |
| Intrabar fidelity | Pessimistic: 1m OHLC only; if a bar contains both stop and liquidation, **liquidation wins** |

## 4. Architecture (Approach A — post-hoc re-sim)

The signal layer is untouched. A new isolated module re-simulates the *existing* trade list under leverage.

```
data/{BTC,ETH,SOL}USDT_1m.json, XAUUSD_1m.json
        │
        ▼
scripts/backtest-scalp.ts  --emit-trade-tape tape.json   (only change to existing code)
        │   emits per-trade tape + reports 1x baseline edge
        ▼
tape.json  (TradeTapeEntry[])
        │
        ▼
scripts/leverage-sweep.ts
        │  loads tape + candle files
        ▼
src/lib/scalp/leverage/
   ├── types.ts        TradeTapeEntry, LeverageConfig, LeverageResult
   ├── liquidation.ts  liquidationPrice(), resolveBarOutcome(), accrueFunding()  [PURE]
   └── simulator.ts    LeverageSimulator → per-leverage equity curve + stats
        │
        ▼
report (JSON + terminal ASCII):  per-symbol + combined, L*, L_ruin
```

### Files

| File | Responsibility |
|---|---|
| `src/lib/scalp/leverage/types.ts` | `TradeTapeEntry`, `LeverageConfig`, `LeverageResult` |
| `src/lib/scalp/leverage/liquidation.ts` | Pure functions: `liquidationPrice()`, `resolveBarOutcome()`, `accrueFunding()` |
| `src/lib/scalp/leverage/simulator.ts` | `LeverageSimulator` — consumes tape + candles, returns equity curve + stats per leverage |
| `scripts/leverage-sweep.ts` | CLI runner: load tape + candles, sweep grid, MC ruin, print/save report |
| `scripts/backtest-scalp.ts` | **+1 flag** `--emit-trade-tape <path>` to dump the 1x trade tape (only modification to existing code) |
| `src/lib/scalp/leverage/*.test.ts` | Unit tests (see §9) |

## 5. Data Flow

1. **Tape emission + baseline gate.**
   `npx tsx scripts/backtest-scalp.ts --strategy ict_5m --symbols BTCUSDT,ETHUSDT,SOLUSDT,XAUUSD --emit-trade-tape tape.json`
   Emits per-trade `TradeTapeEntry` and prints the 1x baseline metrics (expectancy, WR, Sharpe). If expectancy ≤ 0, stop.
2. **Leverage sweep.**
   `npx tsx scripts/leverage-sweep.ts --tape tape.json --leverage-grid 1,2,5,10,25,50,100,125 --mmr 0.005 --margin-fraction <f> --slippage-bps 3 --funding-rate 0.0001 --ruin-threshold 0.10`
   Loads candle files, re-walks each trade's 1m path per leverage level, runs MC ruin, writes report.

## 6. Data Model

```ts
// src/lib/scalp/leverage/types.ts
export interface TradeTapeEntry {
  symbol: string;          // maps to data/<symbol>_1m.json
  entryIndex: number;      // index into the 1m candle array (entry fill bar)
  exitIndex: number;       // index of the bar where the 1x backtest exited
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  direction: 'long' | 'short';
}

export interface LeverageConfig {
  leverage: number;            // L
  marginFraction: number;      // fraction of equity committed as margin per trade (isolated)
  mmr: number;                 // maintenance margin rate (e.g. 0.005)
  slippageBps: number;         // adverse slippage on stop/liquidation fills
  fundingRate8h: number;       // flat funding per 8h on notional (real data where available)
  ruinThreshold: number;       // equity fraction of start that counts as ruin (e.g. 0.10)
}

export interface LeverageResult {
  leverage: number;
  totalReturn: number;         // terminal equity / start − 1
  meanLogGrowthPerTrade: number;
  maxDrawdown: number;
  liquidations: number;
  ruinProbability: number;     // from MC reshuffle
  equityCurve: number[];       // sequential (un-shuffled) path
}
```

## 7. The Math (honest core)

### 7.1 Liquidation price (isolated, linear perp)
Derived from: liquidation occurs when loss = initialMargin − maintenanceMargin = `N·(1/L − MMR)`.

- Long: `P_liq = entry · (1 − 1/L + MMR)`
- Short: `P_liq = entry · (1 + 1/L − MMR)`

At L=100, MMR=0.005 → `P_liq_long = entry · 0.995` (0.5% from entry). This is typically *inside* the strategy's ATR stop, so the stop never fires — the sim must capture this.

### 7.2 Pessimistic intrabar resolution
We have only 1m OHLC, not the intrabar path. For each bar in `(entryIndex, exitIndex]`, evaluate in this fixed priority order:

1. **Liquidation** — long: `bar.low ≤ P_liq`; short: `bar.high ≥ P_liq`. → lose full allocated margin, trade ends.
2. **Stop** — long: `bar.low ≤ stopLoss`; short: `bar.high ≥ stopLoss`. → stop exit (with adverse slippage).
3. **Target** — long: `bar.high ≥ takeProfit`; short: `bar.low ≤ takeProfit`. → TP exit.

If a single bar's range contains both the stop and the liquidation price, **liquidation wins** (step 1 precedes step 2). If none trigger by `exitIndex`, the trade closes at the `exitIndex` close (the 1x backtest's own exit, e.g. timeout).

### 7.3 Sizing & compounding
- Per-trade margin `M = marginFraction · equity` (isolated). Notional `N = M · L`. Quantity `Q = N / entryPrice`.
- Win/normal exit: `equity += Q · (exitPrice − entryPrice) · dir − costs`.
- Liquidation: `equity −= M` (full allocated margin lost).
- Trades applied **sequentially** to compound the equity curve. `marginFraction` defaults so that `L=1` ≈ the existing backtest's normal sizing (calibrated in the runner).
- Absorbing barrier: once `equity ≤ 0` (or below ruin threshold for the ruin metric), it stays there.

### 7.4 Costs
- **Funding:** `fundingRate8h · N` charged for each 8h boundary (00/08/16 UTC) the trade spans. Real funding used where `data/<symbol>_futures_1h.json` exists; otherwise the flat default. Second-order for minute-scale scalps but material at high L.
- **Slippage:** stop and liquidation fills take `slippageBps` adverse. At 100x, 5 bps ≈ 0.5% of equity per event.

### 7.5 Ruin probability
Reuse `reshuffleTrades` from `src/lib/rl/utils/monte-carlo.ts`. Shuffle the per-trade leveraged outcomes N=1000×, compound each path, count the fraction that breach `ruinThreshold` at any point. Reported per leverage level. (Reshuffling per-trade outcomes is valid because each trade's leveraged P&L is computed independently of order; only the compounding sequence changes.)

## 8. Deliverable

Per-symbol and combined report (JSON file + terminal ASCII plot):

- Table: `{ L, totalReturn, meanLogGrowthPerTrade, maxDrawdown, liquidations, ruinProbability }` for each grid level.
- `L*` = argmax of `meanLogGrowthPerTrade`.
- `L_ruin` = smallest L where `ruinProbability ≥ 5%`.
- Headline narrative: where growth peaks vs. where ruin takes over. Expected shape — growth rises then collapses once liquidations dominate, with `L*` far below 100x.

## 9. Testing (Red-Green)

| Test | Assertion |
|---|---|
| `liquidationPrice` long | entry 100, L=10, MMR=0.005 → 90.5 |
| `liquidationPrice` short | entry 100, L=10, MMR=0.005 → 109.5 |
| `resolveBarOutcome` ordering | bar range spanning both stop and liq → **liquidation** result |
| `resolveBarOutcome` normal | bar hitting only stop → stop exit with slippage applied |
| `accrueFunding` | trade spanning one 08:00 UTC boundary → exactly one funding charge on notional |
| Harness theory check | synthetic 60% win 1R / 40% lose 1R series → growth-maximizing fraction matches analytic Kelly within tolerance |

Each behaviour gets a failing test first, then implementation, then green — per project rules.

## 10. Error Handling

- Validate every tape entry: `0 ≤ entryIndex < exitIndex < candles.length`; skip + log malformed entries rather than crashing the sweep.
- Explicit, fatal error if a symbol's `data/<symbol>_1m.json` is missing (no silent skip — a missing symbol would distort the combined curve).
- Guard `equity ≤ 0` as an absorbing state.
- `--leverage-grid` parsed and validated (positive, finite).

## 11. Risks / Open Items

- **1m fidelity ceiling.** Pessimistic ordering is the honest mitigation, but true tick-level liquidation could differ. Documented as a known limitation in the report.
- **`marginFraction` calibration.** The `L=1 ≈ normal sizing` calibration must be explicit and shown in the report so the curve is interpretable.
- **XAUUSD funding.** Gold perp funding data may be absent; flat default used and noted.
