# Scalp Iteration 1: ICT 5m Baseline with 1H Bias Filter

## Hypothesis

ICT concepts (order blocks, FVGs, market structure) on 5m candles generate profitable scalp trades when:
1. Filtered by 1H directional bias (only trade with the trend)
2. Restricted to London/NY kill zones (high-priority sessions)
3. Require reaction confirmation (bullish/bearish candle body)
4. Simple SL/TP exit (no strategy-based exits, proven NET NEGATIVE on 1H)

## Config

```bash
npx tsx scripts/backtest-scalp.ts \
  --symbol BTCUSDT \
  --threshold 4 \
  --friction 0.0005 \
  --max-bars 36 \
  --cooldown-bars 4 \
  --train-bars 4320 --val-bars 1440 --slide-bars 1440
```

## Data

- **Source**: BTCUSDT 1m candles from Bybit (346K candles)
- **Period**: 2025-06-20 → 2026-02-16 (~8 months)
- **Aggregation**: 1m → 5m (69,201 bars), 5m → 1H for bias
- **Quality**: 0 gaps, 0 OHLC errors

## Results

| Metric | Value |
|--------|-------|
| Trades | 280 |
| Win Rate | 31.4% |
| PnL% | -28.6% |
| Avg PnL/trade | -0.102% |
| Sharpe | -18.64 |
| Max DD | 26.0% |
| Avg bars held | 13.2 (1.1 hours) |
| WF Pass Rate | 27.3% (12/44) |

## Analysis

### Why It Failed

1. **Win rate too low (31.4%)**: With 2:1 R:R, breakeven WR is 33%. We're below breakeven.
2. **Friction dominates**: 0.05% per side = 0.10% round-trip. Avg trade is -0.10%, meaning almost all edge is eaten by friction.
3. **5m structure is noisy**: ICT swing points, OBs, and FVGs on 5m are less reliable than on 1H. More false signals.
4. **OB proximity too loose**: Many entries are near OBs that haven't been properly tested/retested.
5. **2:1 R:R too ambitious for scalp**: Small 5m moves rarely reach 2R before SL.

### What Worked

- Kill zone filter correctly concentrates trades in London/NY sessions
- 1H bias filter prevents counter-trend entries
- Trade count is reasonable (280 over 8 months ≈ 1.2/day avg)
- Avg hold time of 1.1 hours is reasonable for scalp timeframe

### Observations

- Some windows pass strongly (W3: +1.0%, W30: +2.8%, W36: +2.5%) suggesting edge exists in trending weeks
- Ranging/choppy weeks devastate performance (W4: -2.7%, W23: -2.4%, W34: -2.3%)
- No regime filtering applied yet — this was the biggest lever on 1H

## Next Steps

1. **Lower R:R target**: Try 1.5:1 instead of 2:1 — better hit rate for scalps
2. **Add regime suppression**: Suppress ranging+normal and ranging+high (biggest lever on 1H)
3. **Tighter OB proximity**: Reduce from 0.5% to 0.3% or 0.2%
4. **Wider SL**: Current SL may be too tight for 5m noise
5. **Higher threshold**: Try 5.0 or 6.0 to only take the highest-quality signals
6. **Test partial TP**: Apply the proven partial TP framework from 1H

## Decision

**CONTINUE** — The infrastructure works perfectly (data download, aggregation, multi-TF backtest, WF validation). The baseline shows no edge with default params, but several clear improvement vectors exist. If regime suppression + R:R adjustment don't bring WF rate above 40%, pivot to Phase 2 (mean reversion/volatility breakout).
