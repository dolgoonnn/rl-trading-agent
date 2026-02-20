# Scalp Phase 1 Results: Fix ICT Baseline

## Summary

**Phase 1 FAILED to reach 40% WF pass rate. PIVOT to Phase 2 alternative strategies.**

Best ICT 5m config: 32.1% WF pass rate, 68 trades, 39.7% WR, -4.8% PnL

## Results Table

| Config | Trades | WR | PnL | WF Pass |
|--------|--------|-----|------|---------|
| Baseline (iter 1): RR 2.0, no suppress, traditional KZ, OB 0.5%, th4 | 280 | 31.4% | -28.6% | 27.3% |
| **Iter 2**: RR 1.5, 2-regime suppress, traditional KZ, OB 0.5%, th4 | 72 | 40.3% | -5.5% | 31.0% |
| Iter 3: RR 1.5, 2-regime suppress, crypto KZ, OB 0.5%, th4 | 130 | 28.5% | -14.0% | 25.6% |
| Iter 4a: RR 1.5, 2-regime suppress, all sessions, OB 0.3%, th4 | 353 | 27.8% | -41.4% | 15.9% |
| Iter 4b: RR 1.5, 2-regime suppress, traditional KZ, OB 0.3%, th5 | 56 | 37.5% | -5.4% | 16.0% |
| Iter 4c: RR 1.5, 2-regime suppress, traditional KZ, OB 0.3%, th5.5 | 42 | 33.3% | -5.9% | 14.3% |
| Iter 4d: RR 1.5, 2-regime suppress, traditional KZ, OB 0.3%, th6 | 34 | 29.4% | -5.7% | 11.1% |
| Iter 5a: RR 1.5, 3-regime suppress, traditional KZ, OB 0.5%, th3 | 81 | 38.3% | -7.2% | 22.6% |
| **Iter 5b**: RR 1.5, 3-regime suppress, traditional KZ, OB 0.5%, th4 | 68 | 39.7% | -4.8% | **32.1%** |

## Key Findings

1. **R:R 1.5 is correct** for scalps — WR jumped from 31.4% → 40.3% (above breakeven for 1.5:1 = 40%)
2. **Regime suppression helps marginally** — 2 regimes: +3.7pp, 3 regimes: +4.8pp total
3. **Traditional kill zones > crypto kill zones** — crypto KZ added noise, reduced WR to 28.5%
4. **all_sessions is worst** — floods strategy with noise (15.9% WF)
5. **Tighter OB proximity (0.3%) hurts** — kills trade count without improving quality
6. **Higher thresholds kill trade count** — too few signals, more SKIP windows

## Root Cause Analysis

ICT order-block entries on 5m have insufficient edge for scalping because:
- Traditional forex kill zones only cover ~6 hours/day → 16 of 45 windows have 0 trades
- OB proximity filter (0.5%) on 5m candles finds few quality setups
- Even the best config has negative PnL (-4.8%) — friction eats the thin edge
- 68 trades over 8 months = ~8.5/month = insufficient signal frequency

## Decision

**PIVOT to Phase 2**: Alternative strategies that don't depend on ICT OB entries.
Strategies to test: VWAP mean reversion, BB squeeze, ATR breakout, Silver Bullet, session range.

## Best Phase 1 Reproduction Command

```bash
npx tsx scripts/backtest-scalp.ts --symbol BTCUSDT --threshold 4 --target-rr 1.5 \
  --suppress-regime "ranging+normal,ranging+high,downtrend+high"
```
