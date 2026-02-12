# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors
- Walk-forward validation: 29-33 windows per symbol
- Commission: 0.1% per side, Slippage: 0.05% per side
- Max position hold: 112 bars
- CMA-ES production-matched optimizer: 23 dimensions (10 weights + 5 regime thresholds + 8 hyperparams)

---

## CMA-ES Optimization History

### 3-Symbol Optimization (BTCUSDT, ETHUSDT, SOLUSDT)

Converged at **78.1% WF pass rate, fitness=1071.7** after 18 runs.
See MEMORY.md for full run-by-run history (Runs 1-18).

**Final 3-symbol config:**
```bash
npx tsx scripts/backtest-confluence.ts --strategy ob --sl-mode dynamic_rr \
  --friction 0.0007 --suppress-regime "ranging+normal,ranging+high,downtrend+high" \
  --threshold 4.672 --exit-mode simple --partial-tp "0.55,0.84,0.05" --atr-extension 4.10 \
  --ob-half-life 18 --max-bars 108 --cooldown-bars 8 \
  --regime-threshold "uptrend+high:2.86,uptrend+normal:6.17,uptrend+low:3.13,downtrend+normal:4.33,downtrend+low:4.48" \
  --weights "structureAlignment:2.660,killZoneActive:0.814,liquiditySweep:1.733,obProximity:1.103,fvgAtCE:1.554,recentBOS:1.255,rrRatio:0.627,oteZone:0.787,obFvgConfluence:1.352"
```

### 10-Symbol Validation & Pair Selection

Tested 3-symbol config on expanded universe (10 symbols). Bottom 3 dropped:
| Symbol | WF Pass Rate | Decision |
|--------|-------------|----------|
| MATICUSDT | 50.0% | Dropped |
| ARBUSDT | 53.1% | Dropped |
| APTUSDT | 54.5% | Dropped |

### Broad Universe Optimization (7 symbols)

**Symbols:** BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT, DOGEUSDT, NEARUSDT, ADAUSDT

#### Broad Run 1 (10-symbol, warm from 3-sym Run 18)
- **Config:** sigma=0.08, pop=25, 30 gens, 10 symbols
- **Result:** fitness=880.0, pass=59.5%, trades=2535, WR=53.0%, PnL=+1195.1%
- Baseline (10-sym default): 56.9% pass, -14.8% PnL

#### Broad Run 2 (7-symbol, warm from Run 1)
- **Config:** sigma=0.06, pop=20, 40 gens (early-stopped gen 39)
- **Result:** fitness=902.8, pass=62.1%, trades=1743, WR=51.2%, PnL=+1232.0%
- Key shifts: partialTP 0.82→0.91R, fvgAtCE 0.86→0.57, rrRatio 1.21→0.36

#### Broad Run 3 (7-symbol, warm from Run 2)
- **Config:** sigma=0.04, pop=20, 40 gens (early-stopped gen 39)
- **Result:** fitness=935.3, pass=64.7%, trades=1757, WR=50.9%, PnL=+2300.8%
- Key shifts: baseThreshold 4.65→4.74, partialTP 0.91→0.93R, obHalfLife 18→20, liquiditySweep 1.74→1.35

#### Broad Run 4 (7-symbol, warm from Run 3)
- **Config:** sigma=0.02, pop=20, 40 gens (early-stopped gen 39)
- **Result:** fitness=950.3, pass=66.1%, trades=1762, WR=50.9%, PnL=+2513.6%
- Key shifts: baseThreshold 4.74→4.80, partialTP 0.93→0.94R, structureAlignment 2.43→2.56, rrRatio 0.35→0.29

#### Warm-Chain Progression
| Run | Symbols | Fitness | Pass Rate | Trades | WR | PnL | Delta Fitness |
|-----|---------|---------|-----------|--------|----|-----|---------------|
| Run 1 | 10 | 880.0 | 59.5% | 2535 | 53.0% | +1195% | — |
| Run 2 | 7 | 902.8 | 62.1% | 1743 | 51.2% | +1232% | +22.8 |
| Run 3 | 7 | 935.3 | 64.7% | 1757 | 50.9% | +2301% | +32.5 |
| **Run 4** | **7** | **950.3** | **66.1%** | **1762** | **50.9%** | **+2514%** | **+15.0** |

**Convergence confirmed:** Diminishing returns (+32.5 → +15.0), sigma=0.007 at termination.

---

## Final 7-Symbol Config (Broad Run 4)

### Confluence Weights
| Factor | Weight |
|--------|--------|
| Structure Alignment | 2.561 |
| Kill Zone Active | 0.566 |
| Liquidity Sweep | 1.347 |
| OB Proximity | 1.374 |
| FVG at CE | 0.674 |
| Recent BOS | 1.492 |
| R:R Ratio | 0.294 |
| OTE Zone | 0.610 |
| Breaker Confluence | 0 |
| OB+FVG Confluence | 1.162 |

### Regime Thresholds
| Regime | Threshold |
|--------|-----------|
| Base | 4.80 |
| uptrend+high | 2.90 |
| uptrend+normal | 5.21 |
| uptrend+low | 2.90 |
| downtrend+normal | 5.20 |
| downtrend+low | 4.16 |

### Hyperparameters
- OB freshness half-life: 19
- ATR extension bands: 2.63
- Partial TP: 44% @ 0.94R, BE buffer 0.12
- Max bars: 112, Cooldown bars: 8
- Suppressed regimes: ranging+normal, ranging+high, downtrend+high

### Reproduce
```bash
npx tsx scripts/backtest-confluence.ts --strategy ob --sl-mode dynamic_rr \
  --friction 0.0007 --suppress-regime "ranging+normal,ranging+high,downtrend+high" \
  --threshold 4.797 --exit-mode simple --partial-tp "0.44,0.94,0.12" --atr-extension 2.63 \
  --ob-half-life 19 --max-bars 112 --cooldown-bars 8 \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT,LINKUSDT,DOGEUSDT,NEARUSDT,ADAUSDT \
  --regime-threshold "uptrend+high:2.90,uptrend+normal:5.21,uptrend+low:2.90,downtrend+normal:5.20,downtrend+low:4.16" \
  --weights "structureAlignment:2.561,killZoneActive:0.566,liquiditySweep:1.347,obProximity:1.374,fvgAtCE:0.674,recentBOS:1.492,rrRatio:0.294,oteZone:0.610,obFvgConfluence:1.162"
```

## Walk-Forward Results (Run 4 Config)

### Per-Symbol Breakdown
| Symbol | Windows | Positive | Pass Rate | Status |
|--------|---------|----------|-----------|--------|
| BTCUSDT | 29 | 19/29 | 65.5% | PASS |
| ETHUSDT | 31 | 23/31 | 74.2% | PASS |
| SOLUSDT | 33 | 21/33 | 63.6% | PASS |
| LINKUSDT | 33 | 22/33 | 66.7% | PASS |
| DOGEUSDT | 33 | 22/33 | 66.7% | PASS |
| NEARUSDT | 33 | 21/33 | 63.6% | PASS |
| ADAUSDT | 32 | 20/32 | 62.5% | PASS |

**Overall pass rate:** 66.1%
**Total trades:** 1762
**Overall win rate:** 50.9%
**Overall PnL:** +2513.6%

### Per-Strategy Breakdown
| Strategy | Signals | Trades | Wins | Losses | Win Rate | Total PnL |
|----------|---------|--------|------|--------|----------|-----------|
| order_block | 8643 | 1762 | 896 | 866 | 50.9% | +2513.6% |

## Key Learnings
- **OB-only strategy dominance confirmed** across 7 symbols (FVG/BOS/CHoCH remain inactive)
- **CMA-ES warm-chaining works**: 880→950 fitness over 4 runs (+70.3 total improvement)
- **Dropping weak symbols helps**: 10-sym→7-sym improved pass rate from 59.5% to 66.1% with better PnL
- **Parameter convergence**: baseThreshold settled at ~4.80, partialTP at ~0.94R, structureAlignment is consistently the top weight
- **Diminishing factors**: rrRatio (0.29), killZoneActive (0.57), oteZone (0.61) contribute minimally
- **Signal-to-trade conversion:** 20.4% (1762 trades from 8643 signals above threshold)

## Decision: PROCEED to paper trading with 7-symbol config

## Next Steps
1. PBO validation on 7-symbol config
2. Paper trading deployment with Run 4 config
3. Monitor live performance vs backtest expectations

---
_Last updated: 2026-02-12_
_Optimizer: scripts/train-cmaes-production.ts_
_Models: models/cmaes_broad_run{1,2,3,4}.json_
