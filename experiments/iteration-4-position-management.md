# Iteration 4: Position Management Optimization

## Hypothesis
Position management (wider stops, strategy-specific exits, break-even/trailing) can improve win rate and reduce premature stop-outs, turning a marginally positive EV into a profitable system.

## Implementation Summary

### Changes Made

1. **Production Strategy Config** (`PRODUCTION_STRATEGY_CONFIG`):
   - `stopLossATRMultiple`: 1.0 → 2.0 (wider stops reduce early SL hits)
   - `takeProfitATRMultiple`: 2.0 → 4.0 (wider TP maintains R:R with wider SL)
   - `minConfluence`: 1 → 2 (require 2+ factors, not single-factor entries)
   - `maxStructureAge`: 100 → 50 (staler structures = worse signals)
   - `proximityPercent`: 0.01 → 0.005 (tighter OB touch zone)

2. **Weight Recalibration** (from `diagnose-signals.ts` analysis):
   - `killZoneActive`: 1.5 → 0.5 (negatively correlated with wins)
   - `rrRatio`: 0.8 → 1.0 (positively correlated with wins)

3. **Enhanced Exit Mode** (strategy-specific exits + trailing):
   - Break-even stop at 1R profit
   - Trailing stop at 1.5R profit (1.5×ATR trail distance)
   - Strategy `detectExit()` calls for structure-based exits
   - **Finding: Enhanced exits are NET NEGATIVE — they chop out winning trades**

4. **Hard Pre-Filters**:
   - `minSignalRR` filter rejects signals below R:R threshold before scoring
   - Optional `requireKillZone` filter

## Signal Quality Diagnosis

**Script:** `scripts/diagnose-signals.ts` (2000-candle BTC sample)

| Metric | Before (1.5×ATR SL) | After (2.0×ATR SL) |
|--------|---------------------|---------------------|
| Win Rate | 30.9% | 30.1% |
| Avg Win R | +2.50R | +2.89R |
| EV per trade | +0.084R | **+0.171R** |
| SL hit within 3 bars | 48% | 26% |
| First-bar edge | 45% favorable | 54% favorable |
| MFE < 0.25R | 12% | 17% |

**Key Finding:** Wider stops doubled EV from +0.084R to +0.171R by reducing premature stop-outs.

## Walk-Forward Results (BTC-only)

### Exit Mode Comparison (threshold=5, production config)

| Mode | Trades | Win Rate | Pass Rate | PnL |
|------|--------|----------|-----------|-----|
| Simple (SL/TP only) | 982 | 31.4% | **21.2%** | -90.3% |
| Enhanced (exits + trailing) | 2803 | 22.3% | 0.0% | -99.98% |
| Enhanced (CHoCH-only exits) | 1211 | 30.6% | 15.2% | -95.2% |

**Verdict:** Simple exit mode (SL/TP only) significantly outperforms enhanced exits. Strategy-specific exits are too aggressive and chop winning trades.

### Threshold Sweep (simple mode, production config, minRR=1.5)

| Threshold | Win Rate | Pass Rate | PnL |
|-----------|----------|-----------|-----|
| 3.0 | 32.0% | 27.3% | -95.8% |
| 3.5 | 31.5% | 21.2% | -96.2% |
| **4.0** | **31.8%** | **30.3%** | **-94.2%** |
| 4.5 | 31.4% | 30.3% | -92.0% |
| 5.0 | 31.4% | 21.2% | -90.3% |
| 6.0 | 23.3% | 9.1% | -95.2% |

**Best:** Threshold 4.0-4.5, simple mode, production config → 30.3% pass rate

### 3-Symbol Walk-Forward (best config: threshold=4, production, simple)

| Symbol | Pass Rate | Total Trades | Win Rate |
|--------|-----------|-------------|----------|
| All | 24.2% | 3418 | 28.6% |

### Per-Strategy Analysis

| Strategy | Trades | Win Rate | Avg PnL | Assessment |
|----------|--------|----------|---------|------------|
| order_block | 672 | 34.4% | -0.33% | Best performer |
| fvg | 2175 | 28.1% | -0.32% | Too many signals |
| bos_continuation | 462 | 22.7% | -0.39% | **Worst performer** |
| choch_reversal | 109 | 28.4% | -0.45% | Too few trades |

## Key Learnings

1. **Wider stops (2.0×ATR) help significantly.** Reducing early SL hits from 48% to 26% doubled per-trade EV.

2. **Strategy-specific exits are net negative.** They add complexity without improving outcomes. The `detectExit()` methods fire too frequently, turning winners into break-even or small losses.

3. **Break-even and trailing stops are also net negative.** Moving SL to entry at 1R causes too many positions to get stopped at zero instead of reaching TP.

4. **BOS continuation is the weakest strategy** (22.7% win rate). It needs either reworking or heavier confluence requirements.

5. **FVG strategy generates too many signals** (2175 trades = over-trading). It needs stricter entry criteria or cooldown.

6. **The system has a small positive edge in recent data** (+0.171R per trade in last 2000 candles) but fails across the full 33-window walk-forward. This suggests **regime dependence** — profitable in some market conditions, unprofitable in others.

7. **Best pass rate achieved: 30.3%** (BTC, threshold 4.0, production config). Still below the 70%+ target but improved from 0-5% in Iteration 2.

## Remaining Issues

1. **Win rate too low** — Need ~35-40% to overcome friction. Currently 28-32%.
2. **Regime sensitivity** — Profitable in trends, losing in ranges.
3. **Signal over-production** — 10K+ signals per 3-symbol backtest. Need quality over quantity.
4. **No momentum filter** — Entries happen without confirming direction from recent price action.

## Decision: Adjust — Promising but not yet viable

The production config improvements (wider stops, weight recalibration) significantly improved from 0% to 30% pass rate. But fundamental entry quality needs improvement before proceeding to paper trading.

## Impact on Next Iteration

Before paper trading (Iteration 5), we need to address:
1. Add momentum confirmation filter (e.g., 3-bar close direction confirmation)
2. Consider disabling BOS continuation or requiring threshold 6+ for it
3. Add FVG cooldown (min 4-6 bars between same-strategy signals)
4. Consider regime detection (ADX/volatility filter) to skip ranging markets
5. Re-run Iteration 3 calibration with the new production config

---
_Generated: 2026-02-07_
_Scripts: scripts/backtest-confluence.ts, scripts/diagnose-signals.ts_
