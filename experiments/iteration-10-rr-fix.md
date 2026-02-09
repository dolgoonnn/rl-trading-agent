# Iteration 10: R:R Fix + Friction Reduction

## Objective

Fix the three root causes destroying edge identified in iteration 9:

1. **R:R degradation**: Realized 1.48:1 vs target 2:1 (SL placed at OB boundary, not below entry)
2. **Friction**: 0.30% RT eats 137-153% over ~500 trades
3. **Ranging regimes**: -106% PnL from ranging+normal and ranging+high

## Methodology

### SL Placement Modes

Three modes added to `OrderBlockStrategy.detectEntry()`:

| Mode | SL Placement | TP Placement | Expected R:R |
|------|-------------|-------------|--------------|
| `ob_based` (baseline) | OB boundary - ATR*2 | Entry + ATR*4 | ~1.48 (SL further than 2*ATR from entry) |
| `entry_based` | Entry - ATR*2 | Entry + ATR*4 | Exactly 2.0 (geometric) |
| `dynamic_rr` | OB boundary - ATR*2 | Entry + 2.0 * (entry - SL) | Exactly 2.0 (OB-based SL) |

### Friction Levels

| Level | Per Side | Round Trip |
|-------|----------|------------|
| Taker (default) | 0.150% | 0.300% |
| Maker | 0.070% | 0.140% |

### Experiment Matrix

12 experiments: 3 SL modes x 2 friction levels x 2 regime suppression settings.

## Results

### Full Sweep (3 symbols, 1H, OB-only strategy)

| # | SL Mode | Friction | Suppress | Trades | TP R:R | SL R:R | Total PnL% | Friction Cost% |
|---|---------|----------|----------|--------|--------|--------|-----------|----------------|
| 1 | ob_based | taker | none | 457 | 1.484 | -1.106 | **-78.30%** | 137.10% |
| 2 | ob_based | taker | ranging | 288 | 1.481 | -1.105 | **+14.85%** | 86.40% |
| 3 | ob_based | maker | none | 457 | 1.543 | -1.049 | **-5.06%** | 63.98% |
| 4 | ob_based | maker | ranging | 288 | 1.536 | -1.049 | **+60.99%** | 40.32% |
| 5 | entry_based | taker | none | 1715 | 1.837 | -1.155 | **-738.94%** | 514.50% |
| 6 | entry_based | taker | ranging | 1317 | 1.831 | -1.160 | **-523.20%** | 395.10% |
| 7 | entry_based | maker | none | 1715 | 1.924 | -1.072 | **-464.26%** | 240.10% |
| 8 | entry_based | maker | ranging | 1317 | 1.921 | -1.075 | **-312.22%** | 184.38% |
| 9 | dynamic_rr | taker | none | 1016 | 1.905 | -1.089 | **-179.25%** | 304.80% |
| 10 | dynamic_rr | taker | ranging | 828 | 1.900 | -1.089 | **-18.37%** | 248.40% |
| 11 | dynamic_rr | maker | none | 1016 | 1.956 | -1.041 | **-16.07%** | 142.24% |
| 12 | dynamic_rr | maker | ranging | 828 | 1.953 | -1.041 | **+114.47%** | 115.92% |

### Top 3 Configs

| Rank | Config | PnL | Trades | TP R:R |
|------|--------|-----|--------|--------|
| 1 | **dynamic_rr + maker + suppress** | **+114.47%** | 828 | 1.953 |
| 2 | ob_based + maker + suppress | +60.99% | 288 | 1.536 |
| 3 | ob_based + taker + suppress | +14.85% | 288 | 1.481 |

## Analysis

### R:R Fix Effectiveness

The R:R fix worked as intended:

- `ob_based`: TP R:R = 1.48 (unchanged, this is the baseline)
- `entry_based`: TP R:R = 1.84-1.92 (improved but still <2.0 due to friction adjustment)
- `dynamic_rr`: TP R:R = 1.90-1.96 (best improvement, approaches 2.0)

### Entry-Based Mode Failure

`entry_based` is catastrophic (-312% to -739%):

- **Trade count explodes 3.7x** (457 → 1715): Tighter SL = better R:R calculation → more signals pass the minRiskReward filter
- **But WR collapses**: With SL at entry-2*ATR (instead of OB boundary-2*ATR), the SL is closer to entry → gets hit more often
- **Conclusion**: entry_based changes the risk geometry too much. The OB boundary is structurally significant — moving SL away from it removes structural protection.

### Dynamic R:R Mode Success

`dynamic_rr` is the winner:

- **Keeps OB-based SL** (structural protection): SL still at OB boundary
- **Adjusts TP** to achieve true 2:1 R:R from actual risk distance
- **Trade count moderate** (1016): More than ob_based (457) because the adjusted TP is sometimes closer than 4*ATR, improving the R:R calculation for marginal signals
- **Best total PnL**: +114% with maker + suppress (vs +61% for ob_based equivalent)

### Friction Impact

| Config | Taker PnL | Maker PnL | Friction Saved |
|--------|-----------|-----------|----------------|
| ob_based + suppress | +14.85% | +60.99% | +46.14% |
| dynamic_rr + suppress | -18.37% | +114.47% | +132.84% |

Maker mode is critical. At 828 trades with dynamic_rr:
- Taker friction: 828 * 0.30% = 248.4% total
- Maker friction: 828 * 0.14% = 115.9% total
- Savings: 132.5% in PnL

### Regime Suppression Impact

Consistently positive across all configs. Ranging regimes remain the system's Achilles heel:

| Config | No Suppress | Suppress | Delta |
|--------|-------------|----------|-------|
| ob_based + taker | -78.30% | +14.85% | +93.15% |
| ob_based + maker | -5.06% | +60.99% | +66.05% |
| dynamic_rr + taker | -179.25% | -18.37% | +160.88% |
| dynamic_rr + maker | -16.07% | +114.47% | +130.54% |

## Key Insights

1. **dynamic_rr is the correct SL mode**: Preserves OB structural SL while achieving true 2:1 R:R
2. **entry_based is destructive**: Removing structural SL protection collapses WR
3. **Maker friction is essential**: Taker friction (0.30% RT) exceeds the strategy's edge; maker (0.14% RT) preserves it
4. **Regime suppression stacks multiplicatively** with friction reduction
5. **Best config: dynamic_rr + maker + suppress ranging** = +114.47% PnL over 828 trades

## Recommended Production Config

```typescript
{
  slPlacementMode: 'dynamic_rr',
  friction: 0.0007,  // maker mode (0.07%/side)
  suppressedRegimes: ['ranging+normal', 'ranging+high'],
  activeStrategies: ['order_block'],
  // All other params: PRODUCTION_STRATEGY_CONFIG defaults
}
```

## Next Steps

1. Walk-forward validation on config #12 (dynamic_rr + maker + suppress)
2. Walk-forward on config #4 (ob_based + maker + suppress) as comparison
3. 15m timeframe backtest with config #12
4. MTF backtest (1H structure + 15m entry)
5. Paper trading deployment with best validated config

## Files Changed

| File | Change |
|------|--------|
| `src/lib/rl/strategies/ict-strategies.ts` | Added `SLPlacementMode` type, `slPlacementMode` to config, `calculateLongSLTP`/`calculateShortSLTP` helpers |
| `scripts/backtest-confluence.ts` | Added `--friction`, `--sl-mode`, `--timeframe` CLI flags |
| `scripts/diagnose-exits.ts` | Added `--friction`, `--sl-mode` CLI flags |
| `scripts/walk-forward-validate.ts` | Added `timeframe` to `WalkForwardConfig` |
| `scripts/paper-trade-confluence.ts` | Added `--suppress-regime`, `--sl-mode`, `--friction` flags |
| `src/lib/rl/strategies/confluence-scorer.ts` | Added `FIFTEEN_MIN_STRATEGY_CONFIG`, `FIFTEEN_MIN_CONFLUENCE_OVERRIDES` |
| `src/lib/ict/candle-aggregator.ts` | **NEW**: Timestamp-aligned candle aggregation utility |
| `scripts/backtest-mtf.ts` | **NEW**: Multi-TF backtest (1H structure + 15m entry) |
