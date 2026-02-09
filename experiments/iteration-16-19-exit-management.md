# Iterations 16-19: Exit Management

## Baseline
- Config: OB-only, dynamic_rr, maker (0.07%), suppress 3 regimes, threshold 4.0, simple exits
- **54.6% pass rate, +9.73% PnL, 42.6% WR** (748 trades)

## Iter 16: Breakeven-Only Stop
Move SL to entry + buffer (0.1 × risk distance) after 1R profit.

| Metric | Simple | Breakeven |
|--------|--------|-----------|
| Pass Rate | 54.6% | **56.7%** (+2.1pp) |
| PnL | +9.73% | +29.26% (+19.5pp) |
| Win Rate | 42.6% | 49.7% (+7.1pp) |
| Trades | 748 | 807 |

**Key insight**: Breakeven stop converts many near-misses into small wins/scratches.

## Iter 17: Partial Take Profit
Close fraction of position at triggerR, move SL to breakeven.

| Config | Pass Rate | PnL | WR |
|--------|-----------|-----|-----|
| Partial 50%@1R | **57.7%** | +60.84% | 50.2% |
| Partial 33%@1R | 56.7% | +50.97% | 50.2% |
| Partial 50%@0.75R | 55.7% | +66.34% | **55.7%** |

**Best pass rate: 50%@1R** — locks in half the gain early, lets the rest run.

## Iter 18: Adaptive Max Hold
Sweep max-bars with best partial TP config (50%@1R):

| Max Bars | Pass Rate |
|----------|-----------|
| 40 | 51.5% |
| 50 | 49.5% |
| 60 | 51.5% |
| 72 | 51.5% |
| **100** | **57.7%** |

**100 bars optimal** — partial TP already handles stale trades.

## Iter 19: Best Exit Combo
**`--exit-mode simple --partial-tp "0.5,1.0"` with max-bars 100**

| Metric | Baseline | Best Exit Combo | Delta |
|--------|----------|-----------------|-------|
| Pass Rate | 54.6% | **57.7%** | +3.1pp |
| PnL | +9.73% | **+60.84%** | +51.1pp |
| Win Rate | 42.6% | **50.2%** | +7.6pp |
| Trades | 748 | 807 | +59 |

## New Running Baseline
```bash
npx tsx scripts/backtest-confluence.ts --strategy ob --sl-mode dynamic_rr \
  --friction 0.0007 --suppress-regime "ranging+normal,ranging+high,downtrend+high" \
  --threshold 4.0 --exit-mode simple --partial-tp "0.5,1.0"
```

---
_Generated: 2026-02-08_
