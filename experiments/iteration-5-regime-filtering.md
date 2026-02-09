# Iteration 5: Regime-Aware Trade Suppression

## Hypothesis

The confluence scoring system has hit a ~26-30% walk-forward pass rate ceiling after 4.5 iterations of tuning. All evidence points to **regime dependence** as the root cause:
- System is profitable in trending markets, loses in ranging/choppy conditions
- Recent 2000-candle sample: +0.171R per trade (recent trending period)
- 3-year walk-forward: deeply negative worst-case Sharpe (-41.89)
- No combination of threshold, weight, or entry tightening breaks 30%

**Approach:** Suppress trades during unfavorable market regimes using a regime detector that measures efficiency ratio, ATR percentile, trend strength, and directional movement.

## Implementation

### New Module: `src/lib/ict/regime-detector.ts`

Classifies market regime along two axes:
- **Trend:** uptrend / downtrend / ranging
- **Volatility:** high / normal / low

Key indicators:
1. **Efficiency ratio** (Kaufman's): |net movement| / total path length (0-1)
2. **ATR percentile**: Rolling window normalization across assets
3. **Directional index**: Simplified ADX measuring directional dominance
4. **Normalized slope**: Price change per bar, ATR-normalized

### Integration: `src/lib/rl/strategies/confluence-scorer.ts`

Added `RegimeFilterConfig` to `ConfluenceConfig`:
- `minEfficiency` (default: 0.25) — suppress below this
- `minTrendStrength` (default: 0.20) — suppress below this
- `maxVolatilityPercentile` (default: 0.90) — suppress extreme volatility
- `minVolatilityPercentile` (default: 0.10) — suppress dead markets

Regime check runs **before** strategy evaluation (cheap early exit).

### Scripts Updated

- `scripts/analyze-regime-windows.ts` — Diagnostic: regime x performance matrix
- `scripts/calibrate-confluence.ts` — Added `--regime` flag
- `scripts/backtest-confluence.ts` — Added `--regime` flag + per-regime breakdown

## Diagnostic Results

Run: `npx tsx scripts/analyze-regime-windows.ts` (threshold=4.5, 3 symbols)

### Regime x Performance Matrix

| Regime           | Windows | Avg Sharpe | Med Sharpe | Win Rate | Avg Trades | Pass Rate | Total PnL  |
|------------------|---------|------------|------------|----------|------------|-----------|------------|
| uptrend+normal   | 9       | -5.30      | -6.96      | 33.5%    | 27.0       | 33.3%     | -72.80%    |
| uptrend+high     | 3       | -6.38      | -2.90      | 30.8%    | 29.7       | 33.3%     | -21.47%    |
| ranging+normal   | 38      | -9.90      | -9.75      | 32.4%    | 24.8       | 28.9%     | -286.58%   |
| downtrend+normal | 8       | -11.47     | -10.97     | 32.8%    | 26.4       | 25.0%     | -77.34%    |
| uptrend+low      | 4       | -20.09     | -22.26     | 24.8%    | 26.8       | 25.0%     | -77.85%    |
| ranging+low      | 25      | -11.78     | -9.17      | 31.5%    | 24.5       | 24.0%     | -192.86%   |
| downtrend+high   | 9       | -15.89     | -13.38     | 29.2%    | 23.9       | 22.2%     | -101.11%   |
| ranging+high     | 3       | -18.22     | -18.79     | 27.2%    | 25.0       | 0.0%      | -32.25%    |

**Total windows: 99 | Baseline pass rate: 26.3%**

### Critical Finding

**ALL regime buckets have negative average Sharpe.** The system loses money in every market regime. Regime filtering will reduce losses by sitting out (suppressed windows = Sharpe 0 = pass), but it cannot create a positive-edge system.

### Suppression Projections

| Strategy | Suppressed Regimes | Baseline Pass | Projected Pass | Trade Loss |
|----------|-------------------|---------------|----------------|------------|
| All losers | All 8 regimes | 26.3% | 100.0% | 100.0% |
| Ranging only | ranging+normal/low/high | 26.3% | 75.8% | 65.3% |

The "75.8% pass rate" from suppressing ranging regimes is misleading: it counts suppressed (no-trade) windows as passes. The remaining 33 trending windows still only pass at ~28% rate.

## Key Learnings

1. **Regime filtering is necessary but insufficient.** The system loses in ALL regimes. The core strategy entries have <33% win rate which is below the ~33% breakeven for 2:1 R:R.

2. **Ranging regimes are the worst** (38+25+3 = 66 of 99 windows). Suppressing them eliminates 66% of losing windows.

3. **Uptrend+normal is the "best" regime** but still negative (-5.30 Sharpe, 33.3% pass). The system needs fundamentally better entry quality, not just regime gating.

4. **Win rate is the bottleneck.** Across all regimes, WR ranges 24.8% - 33.5%. The 2.0 ATR SL + 4.0 ATR TP requires ~33% WR to break even. The system is at or below breakeven everywhere.

5. **Regime filtering + entry improvements could combine.** If entries can be improved to push WR from 33% → 38-40% in trending regimes, regime filtering would convert those from marginal to profitable.

## Calibration with Regime Filtering

### With Regime Filtering (default thresholds: eff=0.25, trend=0.2)

| Threshold | Min Sharpe | Avg Sharpe | Pass Rate | Trades |
|-----------|------------|------------|-----------|--------|
| 3.0 | -84.26 | -11.16 | 27.3% | 2479 |
| 3.5 | -70.96 | -12.44 | 22.2% | 2356 |
| 4.0 | -63.57 | -13.59 | 19.2% | 2265 |
| 4.5 | -65.80 | -14.09 | 25.3% | 1952 |
| 5.0 | -103.41 | -15.63 | 28.3% | 1695 |

**Result: WORSE than baseline (26.3% → 19-28%).** The AND logic (`efficiency < min AND trendStrength < min`) doesn't suppress enough bars because most windows have at least one indicator above threshold.

### Analysis: Why Regime Filtering Doesn't Help

The current regime filter uses AND logic: suppress only when BOTH efficiency AND trend strength are below thresholds. This is too conservative — it barely reduces trade count (2265 vs ~2500 baseline at threshold 4.0).

More fundamentally, ALL regimes have negative Sharpe. Regime filtering cannot make the system profitable; it can only reduce losses by sitting out. The core issue is **entry quality**: win rates of 25-33% are at/below the breakeven for 2:1 R:R.

## Decision

| Outcome | Action |
|---------|--------|
| Pass rate > 50% | Proceed to paper trading prep |
| Pass rate 35-50% | Add per-strategy regime gating, re-calibrate |
| Pass rate < 35% | Regime filtering insufficient — consider reducing strategies |

## Verification Checklist

- [ ] Regime detector classifies known trending period as uptrend
- [ ] Regime detector classifies known ranging period as ranging
- [ ] Diagnostic script confirms regime-performance correlation
- [ ] A/B comparison shows improvement with regime filtering
- [ ] Calibration pass rate > 40% with regime filtering
- [ ] Trade count stays above 500 total

---
_Created: ${new Date().toISOString()}_
_Script: iteration-5-regime-filtering implementation_
