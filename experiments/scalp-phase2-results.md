# Scalp Model — Phase 1 + 2 Results

## Phase 1: ICT 5m Optimization (Iterations 2-5)

**Baseline**: 280 trades, 31.4% WR, -28.6% PnL, 27.3% WF (Iteration 1)

| Iteration | Config | Trades | WR | PnL% | WF% |
|-----------|--------|--------|-----|------|-----|
| 2 | RR 1.5 + 2-regime | 72 | 40.3% | -5.5% | 31.0% |
| 3 | crypto kill zones | 130 | 28.5% | -14.0% | 25.6% |
| 4a | all_sessions + OB 0.3% | 353 | 27.8% | -41.4% | 15.9% |
| 4b | trad + OB 0.3% + th5 | 56 | 37.5% | -5.4% | 16.0% |
| 4c | th5.5 | 42 | 33.3% | -5.9% | 14.3% |
| 4d | th6 | 34 | 29.4% | -5.7% | 11.1% |
| 5a | th3 + 3-regime | 81 | 38.3% | -7.2% | 22.6% |
| **5b** | **th4 + 3-regime** | **68** | **39.7%** | **-4.8%** | **32.1%** |

**Phase 1 Decision**: PIVOT to Phase 2 (best=32.1%, below 40% kill gate)

---

## Phase 2: Alternative Strategies (Iterations 6-11)

### Iteration 6: Indicator Library
Created `src/lib/scalp/indicators.ts` — RSI, BB, VWAP, EMA, MACD, ATR, BB squeeze.

### Initial Phase 2 Results (no regime suppression)

| Strategy | Trades | WR | PnL% | WF% |
|----------|--------|-----|------|-----|
| mean_reversion | 364 | 20.9% | -48.8% | 24.4% |
| bb_squeeze | 0 | — | — | — |
| atr_breakout | 329 | 41.9% | -27.5% | 22.2% |
| silver_bullet | 59 | 32.2% | -7.0% | 30.0% |
| session_range | 167 | 26.9% | -20.4% | 27.3% |

### With Regime Suppression (3-regime: ranging+normal, ranging+high, downtrend+high)

| Strategy | Trades | WR | PnL% | WF% |
|----------|--------|-----|------|-----|
| atr_breakout + regime | 75 | 42.7% | -3.9% | 36.1% |
| silver_bullet + regime | 10 | 30.0% | -0.9% | 28.6% |
| session_range + regime | 52 | 26.9% | -2.6% | 23.3% |
| bb_squeeze + regime (th2.5, min3) | 59 | 22.0% | -11.8% | 20.0% |

### ATR Breakout Parameter Sweep — BTC

| Config | Trades | WR | PnL% | Sharpe | WF% |
|--------|--------|-----|------|--------|-----|
| 3-regime th3 | 46 | 39.1% | -2.4% | -12.76 | 27.6% |
| **3-regime th4** | **21** | **52.4%** | **+0.9%** | **7.47** | **52.6%** |
| 3-regime th4 momentum=2 | 34 | 32.4% | -1.5% | -7.98 | 34.8% |
| 3-regime th4 exp=1.3 | 21 | 52.4% | +0.9% | 7.47 | 52.6% |
| 3-regime th4 exp=1.3 mom=2 | 34 | 32.4% | -1.5% | -7.98 | 34.8% |
| 3-regime th4 rr=1.2 | 21 | 42.9% | 0.0% | 0.25 | 47.4% |
| 3-regime th4 maxbars=24 | 21 | 47.6% | -0.6% | -5.82 | 47.4% |
| 3-regime th4 maxbars=48 | 21 | 57.1% | +1.5% | 11.70 | 57.9% |
| **3-regime th4 maxbars=60** | **21** | **57.1%** | **+1.8%** | **13.54** | **57.9%** |
| 3-regime th4 maxbars=72 | 21 | 57.1% | +1.8% | 13.74 | 57.9% |
| 3-regime th4 partial-tp | 21 | 42.9% | +0.4% | 3.99 | 47.4% |
| 4-regime th3 | 44 | 40.9% | -1.5% | -7.01 | 32.1% |
| **4-regime th4 maxbars=60** | **20** | **60.0%** | **+2.4%** | **19.35** | **61.1%** |
| 4-regime th4 maxbars=60 ptp | 20 | 50.0% | +1.7% | 17.28 | 55.6% |
| 5-regime th4 maxbars=60 | 7 | 71.4% | +3.2% | 52.81 | 71.4% |
| 2-regime th4 maxbars=60 | 31 | 54.8% | +0.6% | 2.29 | 47.6% |

### Multi-Symbol Test — Best Config (4-regime, th4, maxbars=60)

| Symbol | Trades | WR | PnL% | Sharpe | WF% |
|--------|--------|-----|------|--------|-----|
| **BTCUSDT** | **20** | **60.0%** | **+2.4%** | **19.35** | **61.1%** |
| ETHUSDT | 28 | 39.3% | -1.8% | -6.50 | 38.9% |
| SOLUSDT | 6 | 16.7% | -5.3% | -166.19 | 16.7% |
| **3-symbol combined** | **54** | **44.4%** | **-4.7%** | **-9.67** | **45.2%** |

---

## Best Configuration

```bash
npx tsx scripts/backtest-scalp.ts --strategy atr_breakout --symbol BTCUSDT \
  --threshold 4 --max-bars 60 \
  --suppress-regime "ranging+normal,ranging+high,downtrend+high,downtrend+normal"
```

**Result**: 20 trades, 60.0% WR, +2.4% PnL, Sharpe=19.35, **61.1% WF pass rate**

---

## Key Findings

### What Works
1. **ATR breakout** is the only scalp strategy with positive PnL and >50% WF
2. **momentum=3** is essential — relaxing to 2 destroys quality
3. **threshold=4** is non-negotiable — any lower and WR drops below breakeven
4. **maxbars=60** (5 hours) optimal — gives trades time to hit TP
5. **4-regime suppression** (+downtrend+normal) slightly better than 3-regime
6. **R:R 1.5** is optimal — lower R:R hurts edge despite higher WR

### What Doesn't Work
1. **ICT 5m on 5m timeframe** — 32.1% WF best, well below 40% gate
2. **Mean reversion** — 20.9% WR, doesn't work on trending crypto
3. **BB squeeze** — very low WR after squeeze expansion
4. **Session range** — breakouts from Asian range aren't reliable
5. **Silver bullet** — too narrow window, insufficient signals
6. **Multi-symbol** — edge is BTC-specific, ETH/SOL degrade results
7. **Momentum relaxation** — momentum=2 adds only noise
8. **Partial TP** — hurts with so few trades (sample too small)

### Root Cause: Insufficient Signal Density
- ATR breakout generates only ~20 qualifying signals on BTC over 8 months (~2.5/month)
- The filter chain (ATR expansion 1.5x + 3 momentum bars + 1H bias + score >4 + regime) is so strict that very few signals pass
- Relaxing any filter degrades quality below breakeven
- This is fundamentally a 5m OHLCV data limitation — tick-level data might produce more granular signals

---

## Conclusion (ORIGINAL — INVALIDATED)

~~The ATR breakout on BTC 5m has a real but impractical edge.~~

**Decision**: The scalp model experiment is CLOSED. See Bug Fix Audit below.

---

## Bug Fix Audit (2026-02-16)

Three bugs were found in the scalp backtest engine that introduced optimistic bias:

### Bugs Fixed
1. **1H aggregation: 12-minute candles, not 1H** (CRITICAL): `aggregate(all5m, 12)` → `aggregate(all5m, 60)`. Parameter is target minutes, not bar count. HTF bias was computed on 12-minute candles.
2. **1H candle look-ahead** (CRITICAL): `findHTFIndex()` returned the current (unclosed) 1H candle. At 14:35, the 14:00 candle includes future 5m bars (14:40-14:55). Fix: use only the previous completed 1H candle.
3. **Entry at signal bar close** (MODERATE): Strategy computes signal FROM the close, then enters at that same close — impossible in practice. Fix: enter at next bar's open, recalculate SL/TP preserving same risk distance.

### Corrected Results

| Config | Trades | WR | PnL% | Sharpe | WF% | vs Original |
|--------|--------|-----|------|--------|-----|-------------|
| ATR BTC 4-regime (best) | 34 | 35.3% | -3.6% | -24.81 | 33.3% | was 61.1% |
| ATR BTC 3-regime | 38 | 39.5% | -0.8% | -3.43 | 38.1% | was 52.6% |
| ATR BTC no regime | 83 | 41.0% | -3.0% | -4.73 | 40.5% | was ~22% |
| ICT 5m BTC 3-regime | 103 | 25.2% | -21.3% | -56.10 | 17.2% | was 32.1% |
| ATR ETH 4-regime | 32 | 37.5% | +1.7% | 5.31 | 33.3% | was 38.9% |
| ATR SOL 4-regime | 21 | 52.4% | +2.0% | 8.30 | 43.8% | was 16.7% |

### Impact Assessment
- **ATR BTC 4-regime** (the "best" config): 61.1% WF → 33.3% WF, +2.4% PnL → -3.6% PnL. Edge was entirely an artifact of the 3 bugs.
- **ICT 5m**: already bad, now worse (17.2% WF, -21.3% PnL)
- **ETH/SOL**: SOL is surprisingly the best (43.8% WF, +2.0% PnL), but only 21 trades — statistically meaningless
- **No config exceeds the 55% WF minimum viable threshold**

### Verdict
The apparent scalp edge was entirely artificial. All 3 bugs biased results optimistically:
- 12-minute HTF candles provided a smoother, more predictive bias signal than real 1H candles
- Look-ahead let the strategy "see" the current hour's direction before it completed
- Entry at signal close gave free slippage in the favorable direction

**Scalp experiment remains CLOSED. No viable edge exists on 5m OHLCV crypto data.**

---

## Reproduction Commands

Phase 1 best (corrected):
```bash
npx tsx scripts/backtest-scalp.ts --symbol BTCUSDT --threshold 4 --target-rr 1.5 \
  --suppress-regime "ranging+normal,ranging+high,downtrend+high"
```

Phase 2 best — ATR breakout (corrected, no edge):
```bash
npx tsx scripts/backtest-scalp.ts --strategy atr_breakout --symbol BTCUSDT \
  --threshold 4 --max-bars 60 \
  --suppress-regime "ranging+normal,ranging+high,downtrend+high,downtrend+normal"
```
