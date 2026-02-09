# Iteration 9: Exit-Type Diagnostics & Loss Analysis

## Hypothesis
The OB strategy shows 41% WR with 2:1 target R:R, which should be profitable (breakeven at ~33% WR). A hidden -0.38% per-trade PnL leak exists somewhere in the execution pipeline.

## Methodology
Created `scripts/diagnose-exits.ts` to capture per-trade exit reason (SL/TP/max-bars/end-of-window), realized R:R, MFE/MAE, confluence scores, regime at entry, and factor breakdowns across all 3 symbols (BTC/ETH/SOL, ~26K 1H candles each, 3 years).

## Key Findings

### 1. The Realized R:R Is NOT 2:1 — It's ~1.5:1
**This is the primary finding.**

| Metric | Target | Realized | Degradation |
|--------|--------|----------|-------------|
| TP R:R | 2.0 | 1.482 | -0.518 |
| SL R:R | -1.0 | -1.106 | -0.106 |

**Root cause:** The OB strategy places SL below `ob.low - 2×ATR`, not below `entry - 2×ATR`. Since the entry price (candle close) is above the OB zone, the actual risk distance is `entry - ob.low + 2×ATR`, which is always greater than `2×ATR`. The TP remains at `entry + 4×ATR`, so effective R:R = `4×ATR / (entry - ob.low + 2×ATR)` ≈ 1.5:1.

**Math check:** At 1.5:1 R:R, breakeven WR = 1 / (1 + 1.5) = 40%. We're at 41.3% — a razor-thin edge that friction destroys.

### 2. Friction Is 148% of Total Losses

| Metric | Value |
|--------|-------|
| Per-side friction | 0.15% (0.10% commission + 0.05% slippage) |
| Round-trip friction | 0.30% |
| Total friction (511 trades) | 153.30% |
| Actual PnL (after friction) | -103.05% |
| PnL without friction | +50.25% |

The system is **profitable before friction** but **destroyed by friction** because the edge (~0.1R per trade) is smaller than the friction cost (~0.09R per trade from each side).

### 3. SL/TP Same-Candle Conflicts: ZERO
No same-candle SL/TP conflicts detected. The SL-first resolution bias is NOT a factor. This hypothesis is eliminated.

### 4. Max-Bars Exits Are Profitable (+49.22%)
36 max-bars exits with 77.8% WR and +1.37% avg PnL. These are NOT a drag — they're actually winners that just took too long to reach TP. Reducing MAX_POSITION_BARS would hurt, not help.

### 5. Ranging Regimes Are The Sole Destroyer

| Regime | Trades | WR | Total PnL |
|--------|--------|-----|-----------|
| ranging+normal | 142 | 38.0% | -80.04% |
| ranging+high | 91 | 41.8% | -43.03% |
| uptrend+high | 67 | 46.3% | +63.33% |
| downtrend+high | 74 | 48.6% | +10.94% |
| All others | 137 | ~37% | -53.48% |

### 6. Bars Held Distribution Shows Entry Quality Issue

| Bars Held | Count | WR | Avg PnL |
|-----------|-------|-----|---------|
| 0-5 | 47 (9.2%) | 19.1% | -1.87% |
| 5-10 | 70 (13.7%) | 35.7% | -0.83% |
| 50-75 | 56 (11.0%) | 55.4% | +0.97% |
| 75-100 | 26 (5.1%) | 57.7% | +1.93% |
| 100+ | 36 (7.0%) | 77.8% | +1.37% |

Trades that survive past 50 bars are profitable (55%+ WR). Trades that hit SL within 5 bars (9.2%) are terrible (19.1% WR). These are "wrong-direction entries" — price immediately goes against us.

### 7. Confluence Score Shows Marginal Differentiation

| Score | Trades | WR | Total PnL |
|-------|--------|-----|-----------|
| 3.0-4.0 | 71 | 36.6% | -24.62% |
| 4.0-5.0 | 183 | 43.2% | -23.68% |
| 5.0-6.0 | 254 | 40.9% | -59.85% |

4.0-5.0 bucket has the best WR but 5.0-6.0 is paradoxically worse. With regime suppression, the 4.0-5.0 bucket becomes +62.20% PnL (50.9% WR).

## Regime Suppression Test

With `ranging+normal` + `ranging+high` suppressed:

| Metric | Baseline | Suppressed | Change |
|--------|----------|------------|--------|
| Trades | 511 | 328 | -36% |
| Win Rate | 41.3% | 42.7% | +1.4pp |
| Total PnL | -103.05% | +3.14% | +106.19pp |
| PnL w/o friction | +50.25% | +101.54% | +51.29pp |
| SOL PnL | -39.85% | +74.96% | +114.81pp |

Suppression flips total PnL from -103% to +3%. But this is still marginal.

## Root Cause Analysis

The system fails because:
1. **Effective R:R is 1.5:1**, not 2:1 (SL placed below OB, not below entry)
2. **Friction (0.30% RT) eats 0.19R** from an edge of only ~0.1R per trade
3. **Ranging regimes** have structurally lower WR (38%) which goes below breakeven at 1.5:1 R:R
4. Combined: edge ≈ 0.1R, friction ≈ 0.1R, net ≈ 0R → random walk territory

## Recommended Fixes (Priority Order)

### Fix A: Reduce Friction Impact (Highest Priority)
Options:
- **Lower frequency / higher timeframe**: 15m entries with 1H structure = better entry timing
- **Maker-only orders**: 0.02% fee vs 0.10% taker → 0.07% RT friction instead of 0.30%
- **Scale up risk per trade**: if risk = 5% instead of 2%, friction impact drops proportionally

### Fix B: Improve Effective R:R
- Place SL at `entry - 2×ATR` instead of `ob.low - 2×ATR` → true 2:1 R:R
- OR: increase TP multiplier to 5×ATR → effective R:R ≈ 2.0 even with OB-based SL
- Tradeoff: wider SL = lower WR per trade, higher TP = fewer TP hits

### Fix C: Regime Suppression (Easy Win)
- Suppress `ranging+normal` and `ranging+high` → eliminates 233 losing trades
- Net PnL goes from -103% to +3%
- But 328 trades over 3 years = ~9 trades/month (borderline for paper trading)

### Fix D: Target High-Vol Trending Only
- Only trade when regime is `uptrend+high` or `downtrend+high`
- 141 trades, ~4/month, but WR ~47% with strong PnL

## Decision

The OB strategy has a structural issue: **friction exceeds edge at current R:R**.

The path forward is NOT to keep tweaking filters (diminishing returns), but to either:
1. **Reduce friction** (maker orders, better exchange, or scale up risk)
2. **Improve timing** (15m entries for tighter SL → higher effective R:R)
3. **Accept the regime filter** and paper trade with the +3% edge as proof-of-concept

## 15-Minute Data Feasibility Test

### Data Fetched
| Symbol | Candles (15m) | Candles (1H) | Ratio |
|--------|--------------|--------------|-------|
| BTCUSDT | 105,115 | 26,279 | 4.0x |
| ETHUSDT | 105,115 | 26,279 | 4.0x |
| SOLUSDT | 105,115 | 26,279 | 4.0x |

### Results (BTCUSDT, unchanged parameters)

| Metric | 1H | 15m | Change |
|--------|-----|------|--------|
| Trades | 91 | 76 | -16% |
| Win Rate | 46.2% | 43.4% | -2.8pp |
| Total PnL | -15.32% | -8.37% | +6.95pp |
| TP R:R | 1.48 | 1.39 | -0.09 |
| Max-bars exits | 14.3% | 17.1% | +2.8pp |

### 15m Issues (Parameters Need Recalibration)

The 15m test ran with 1H-calibrated parameters, causing:
1. **MAX_POSITION_BARS=100** is only 25 hours at 15m (vs 100 hours at 1H) — insufficient time to reach TP
2. **trendLookback=100** covers only 25 hours at 15m — regime detector sees mostly "ranging"
3. **maxStructureAge=50** is 12.5 hours at 15m — OBs go stale immediately
4. **swingLookback=7** covers only 105 minutes at 15m — swing points are noisy

**Verdict:** 15m needs full parameter recalibration (multiply bar-based parameters by 4x). This is a separate iteration, not a quick fix.

## Final Assessment

The 1H OB strategy has a **structural friction problem**, not a signal quality problem:
- Before friction: +50.25% PnL over 3 years
- After friction: -103.05% PnL
- With regime suppression + friction: +3.14% PnL (marginal)

The path forward requires reducing friction impact, either through:
1. **Maker-only orders** (0.02% vs 0.10% commission)
2. **Higher risk per trade** (friction becomes smaller fraction of risk)
3. **15m entries with recalibrated parameters** (better timing, tighter SL)
4. **Regime-filtered paper trading** as proof-of-concept with the +3% edge

---
_Generated: 2026-02-08_
_Script: scripts/diagnose-exits.ts_
