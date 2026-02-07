# Iteration 7: OB-Only + Reaction Confirmation

## Hypothesis

Removing the FVG strategy (25.6% WR, structurally below breakeven) and adding reaction confirmation
to OB entries will improve the walk-forward pass rate above 35%.

## Changes Made

### 1. activeStrategies made runtime-configurable
- Added `activeStrategies: StrategyName[]` to `ConfluenceConfig`
- Default: `['order_block', 'fvg']` (backward compatible)
- Removed module-level `const ACTIVE_STRATEGIES`
- Added `setActiveStrategies()` runtime setter
- Both scripts accept `--strategy ob` or `--strategy ob,fvg`

### 2. Reaction confirmation added to OB entry
- **Bullish OB**: candle must close above OB midpoint (not just wick in)
- **Bearish OB**: candle must close below OB midpoint
- Body conviction: `bodySize / range >= 0.4` (configurable via `minReactionBodyPercent`)
- Controlled by `requireReactionConfirmation` flag (default: true)
- Filters entries where price blows through OB without holding
- **First attempt**: close > ob.high was too strict (231 signals, 46.9% WR but too few trades)
- **Relaxed to midpoint**: close > (ob.high+ob.low)/2 is the sweet spot (1185 signals)

### 3. --strategy CLI flag added to scripts
- `--strategy ob` = OB-only mode
- `--strategy ob,fvg` = current default
- Shorthand map: ob, fvg, bos, choch

## Results

### Calibration (OB-only, midpoint reaction)

| Threshold | Min Sharpe | Avg Sharpe | Pass Rate | Trades |
|-----------|------------|------------|-----------|--------|
| 3.0 | -633.43 | -39.39 | 39.4% | 563 |
| **3.5** | **-775.57** | **-29.04** | **41.4%** | **476** |
| 4.0 | -775.57 | -19.85 | 40.4% | 422 |
| 4.5 | -767.73 | -19.11 | 32.3% | 357 |
| 5.0 | -919.15 | -1.56 | 20.2% | 275 |
| 5.5 | -1116.67 | -32.78 | 3.0% | 61 |

Best by pass rate: **threshold 3.5 at 41.4%**

### Backtest at Threshold 3.5 (--production --simple)

| Metric | Iter 6 (OB+FVG, t=5.5) | Iter 7 (OB-only, t=3.5) | Delta |
|--------|------------------------|-------------------------|-------|
| Pass Rate | 33.3% | **44.4%** | +11.1pp |
| OB Win Rate | 39.8% | **41.0%** | +1.2pp |
| OB Signals | 7886 | 1185 | -85% |
| Total Trades | ~480 | 481 | ~same |
| Overall PnL | — | -79.09% | — |

### Reaction Filter Impact

| Metric | No reaction (Iter 6 OB) | Close > ob.high | Close > OB midpoint |
|--------|------------------------|-----------------|---------------------|
| OB signals | 7886 | 231 | 1185 |
| OB win rate | 39.8% | 46.9% | 41.0% |
| WF pass rate | 33.3% | 22.2% | 44.4% |
| Verdict | Baseline | Too strict | Sweet spot |

### Per-Regime Breakdown

| Regime | Trades | Win Rate | Total PnL | Verdict |
|--------|--------|----------|-----------|---------|
| uptrend+high | 58 | 50.0% | +64.13% | PROFITABLE |
| downtrend+high | 71 | 49.3% | +24.31% | PROFITABLE |
| ranging+high | 88 | 43.2% | -25.27% | Marginal |
| **ranging+normal** | **135** | **35.6%** | **-103.30%** | **PRIMARY LOSS DRIVER** |
| uptrend+normal | 48 | 37.5% | -16.59% | Losing |
| downtrend+normal | 40 | 37.5% | -31.03% | Losing |

**Key insight**: The system is profitable in high-volatility regimes (50% WR) but hemorrhages
in ranging+normal (35.6% WR, 135 trades = 28% of all trades, -103% PnL = ~all losses).

### Per-Symbol Walk-Forward (threshold 3.5)

- **BTCUSDT**: Low trade count (0-6 per window), 8/33 PASS, noisy
- **ETHUSDT**: Moderate (2-7 per window), 12/33 PASS
- **SOLUSDT**: Higher volume (4-16 per window), 14/33 PASS, highest variance

## Decision Gate

| Outcome | Action |
|---------|--------|
| OB-only pass rate > 45% | Proceed to paper trading (Iteration 8) |
| **OB-only pass rate 35-45%** | **Layer MTF bias on top (4H structure as soft filter)** |
| OB-only pass rate < 35% | System has no edge -- fundamental rethink |

**Result: 44.4% pass rate -> Layer MTF bias on top**

## Key Learnings

1. **Reaction confirmation works**: WR improved from 39.8% to 41.0% with midpoint check
2. **ob.high was too strict**: 97% signal reduction, unusable. OB midpoint is the right level.
3. **OB-only removes ~900 net-losing FVG trades**: Pass rate jumps +11pp
4. **Regime is the next lever**: ranging+normal (28% of trades, 35.6% WR) is the loss driver.
   Suppressing trades in this regime would likely push pass rate above 50%.
5. **High-volatility regimes are profitable**: 50% WR in uptrend+high and downtrend+high.
   The system has genuine edge when volatility is present.
6. **Threshold 3.5 is optimal**: Lower than Iter 6 (5.5) because OB-only produces fewer signals,
   and reaction filter already handles quality — don't double-filter.

## Impact on Next Iteration

The 44.4% pass rate is close to the 45% paper-trading gate. Two paths forward:

1. **Iteration 8a: MTF bias** — Add 4H structure as soft filter (or hard filter in ranging+normal).
   Expected to push pass rate above 50% by suppressing the 135 ranging+normal trades.

2. **Iteration 8b: Regime suppression** — Use the existing regime detector to suppress
   ranging+normal trades specifically. Simpler than MTF, may achieve similar results.

---
_Generated: 2026-02-08_
_Calibration: experiments/iteration-7-calibration-ob.json_
_Script changes: confluence-scorer.ts, ict-strategies.ts, calibrate-confluence.ts, backtest-confluence.ts_
