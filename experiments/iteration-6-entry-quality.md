# Iteration 6: Entry Quality Overhaul

## Date: 2026-02-08

## Objective
Push average WR from ~30% to 38-40% by fixing detection quality and reducing to 2 viable strategies (OB + FVG). Target: pass rate from 26.3% to 40-50%.

## Changes Made

### 1. Order Block Detection (`src/lib/ict/order-blocks.ts`)
- `minMovePercent` raised from 1.0% to 1.2% (1.5% killed OB count)
- Body-to-range filter enforced: `bodyToRangeRatio >= 0.5` (rejects doji/indecision candles)
- "Last candle" filter: next 1-2 candles must start impulse, reject if next candle is larger same-direction body
- **Note:** Mitigation marking in detection was attempted then reverted — it marks ALL OBs as mitigated since the lookback window includes historical price returning to the zone

### 2. FVG Detection (`src/lib/ict/fair-value-gaps.ts`)
- `minSizePercent` raised from 0.2% to 0.4% — filter micro-gaps
- `maxAgeCandles` reduced from 50 to 30 — FVGs older than 30 bars are stale
- **Displacement is now a hard filter** (was optional scoring bonus) — non-displacement FVGs are noise

### 3. Strategy Changes (`src/lib/rl/strategies/ict-strategies.ts`)
- BOS and CHoCH strategies disabled in ACTIVE_STRATEGIES
- FVG CE tolerance tightened from 0.3% to 0.15%
- FVG requires structure alignment (recent BOS in direction within 40 bars)
- FVG max age capped at 30 bars within strategy

### 4. Confluence Scorer Weights (`src/lib/rl/strategies/confluence-scorer.ts`)
- `liquiditySweep` 1.5 → 2.0 (strongest positive predictor)
- `rrRatio` 1.0 → 1.5 (higher R:R trades win more)
- `breakerConfluence` 0.25 → 0 (negatively correlated — disabled)
- BOS and CHoCH removed from ACTIVE_STRATEGIES array

## Results

### Calibration (3 symbols × 33 windows = 99 windows)

| Threshold | Pass Rate | Trades | Min Sharpe |
|-----------|-----------|--------|------------|
| 3.0       | 17.2%     | 1562   | -748.74    |
| 3.5       | 18.2%     | 1554   | -748.74    |
| 4.0       | 19.2%     | 1269   | -849.03    |
| 4.5       | 26.3%     | 1057   | -3019.61   |
| 5.0       | 32.3%     | 983    | -4552.27   |
| **5.5**   | **33.3%** | 954    | -4552.27   |
| 6.0       | 23.2%     | 417    | -9933.83   |

**Best threshold: 5.5 (33.3% pass rate)**

### Per-Strategy Breakdown (BTCUSDT, production config, simple exits, threshold 4.0)

| Strategy     | Signals | Trades | WR    | Avg PnL | Status |
|-------------|---------|--------|-------|---------|--------|
| order_block | 779     | 161    | 39.8% | -0.17%  | Near breakeven |
| fvg         | 412     | 291    | 26.5% | -0.39%  | Below breakeven |
| bos_cont    | 0       | 0      | N/A   | N/A     | Disabled |
| choch_rev   | 0       | 0      | N/A   | N/A     | Disabled |

### Per-Strategy Breakdown (3 symbols, production config, threshold 5.5)

| Strategy     | Signals | Trades | WR    | Avg PnL |
|-------------|---------|--------|-------|---------|
| order_block | 7886    | 328    | 33.8% | -0.39%  |
| fvg         | 3076    | 899    | 25.6% | -0.37%  |

### Comparison to Baseline (Iteration 5)

| Metric              | Iter 5 (Baseline) | Iter 6        | Delta   |
|---------------------|-------------------|---------------|---------|
| Best threshold      | 4.5               | 5.5           | +1.0    |
| Pass rate (maximin) | 26.3%             | 33.3%         | **+7pp** |
| OB WR (BTCUSDT)     | 42.1%             | 39.8%         | -2.3pp  |
| FVG WR (BTCUSDT)    | 25.8%             | 26.5%         | +0.7pp  |
| BOS/CHoCH trades    | ~570              | 0             | Removed |
| Total trades (99w)  | ~1200             | 954           | -20%    |

## Analysis

### What Worked
1. **Disabling BOS/CHoCH** removed ~570 losing trades and improved pass rate
2. **Higher threshold (5.5)** filters more aggressively — pass rate +7pp
3. **OB body-to-range filter** improves OB quality (rejects indecision candles)
4. **FVG displacement hard filter** reduces FVG noise significantly

### What Didn't Work as Expected
1. **OB WR dropped from 42.1% to 33.8-39.8%** — the tightened detection filtered some good OBs too. The "last candle" filter + body-to-range + minMovePercent 1.2% reduced the candidate pool, but the remaining OBs aren't reliably better
2. **FVG WR barely improved (25.8% → 25.6-26.5%)** — displacement + structure alignment helped reduce count but didn't push WR above breakeven. The fundamental issue is that FVG entries at CE don't predict direction well enough
3. **All regime buckets still negative** — consistent with Iteration 5 findings

### Root Cause
The system's core problem isn't noise filtering — it's that the **entry model doesn't have enough predictive power**. The OB and FVG concepts identify zones of interest but don't reliably predict short-term direction with enough edge to overcome 0.15% round-trip friction.

Specifically:
- OB at 39.8% WR with 2:1 R:R is nearly breakeven (33% breakeven) — small positive edge
- FVG at 25.6% WR is structurally below breakeven — no edge after friction
- Combined, the FVG losses overwhelm the OB edge

## Decision Gate

| Outcome | Criteria | Result |
|---------|----------|--------|
| Pass rate > 45% | Proceed to paper trading | **NO** (33.3%) |
| Pass rate 35-45% | Add regime filter + adaptive SL/TP | **CLOSE** (33.3%) |
| Pass rate < 35% | OB-only or fundamental rethink | **YES** |

**Decision: OB-only system or fundamental rethink**

### Recommended Next Steps
1. **OB-only system (quick test):** Drop FVG entirely. OB at 39.8% WR may be enough for a positive-expectancy OB-only system with proper threshold tuning. This would be ~160 trades across BTCUSDT (fewer but higher quality).
2. **Multi-timeframe confirmation:** Use higher timeframe (4H/daily) structure to filter 1H entries — this is the real ICT methodology (top-down analysis)
3. **Entry timing improvement:** Instead of entering on OB touch, require a bullish/bearish engulfing candle at the OB zone (reaction confirmation)
4. **Fundamentally different approach:** The current single-timeframe confluence system has a structural ceiling. Multi-timeframe + SMT divergence + proper AMD (Accumulation, Manipulation, Distribution) model would be a full rewrite.
