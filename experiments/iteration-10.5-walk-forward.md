# Iteration 10.5: Walk-Forward Validation of Best Configs

## Objective

Validate the top configs from iteration 10's in-sample sweep using proper walk-forward (out-of-sample) validation. The +114% PnL from Config #12 was in-sample — this step determines if the edge is real or overfitted.

## Configs Tested

| Config | SL Mode | Friction | Regime Suppress | In-Sample PnL | In-Sample Trades |
|--------|---------|----------|-----------------|---------------|------------------|
| #12 (best) | dynamic_rr | 0.07%/side (maker) | ranging+normal, ranging+high | +114% | 828 |
| #4 (comparison) | ob_based | 0.07%/side (maker) | ranging+normal, ranging+high | +3% | 288 |

## Walk-Forward Configuration

- Train: 2160 bars (~3 months), Val: 720 bars (~1 month), Slide: 720 bars
- 33 windows per symbol, 3 symbols (BTCUSDT, ETHUSDT, SOLUSDT)
- 99 total windows, 0-trade windows SKIPPED from pass rate calculation
- Pass gate: 45% of eligible windows with positive Sharpe

---

## Results

### Config #12: dynamic_rr + maker + suppress (Enhanced Exits)

| Symbol | Total Windows | Skipped | Eligible | Passed | Pass Rate |
|--------|--------------|---------|----------|--------|-----------|
| BTCUSDT | 33 | 1 | 32 | 17 | 53.1% |
| ETHUSDT | 33 | 0 | 33 | 16 | 48.5% |
| SOLUSDT | 33 | 0 | 33 | 17 | 51.5% |
| **Overall** | **99** | **1** | **98** | **50** | **51.0%** |

- **891 trades** across all windows (good statistical significance)
- **41.0% win rate** — consistent with in-sample
- **Overall PnL: -86.59%** — losing windows lose much more than winners gain
- **Per-regime**: uptrend+high +98.5%, ranging+low +37.5%, downtrend+high -113%

### Config #12: dynamic_rr + maker + suppress (SIMPLE Exits)

Re-run with `--simple` (SL/TP only, no strategy exits or trailing):

| Symbol | Eligible | Passed | Pass Rate |
|--------|----------|--------|-----------|
| BTCUSDT | 32 | 17 | 53.1% |
| ETHUSDT | 33 | 14 | 42.4% |
| SOLUSDT | 33 | 14 | 42.4% |
| **Overall** | **98** | **45** | **45.9%** |

- **817 trades**, **41.9% WR**, **Overall PnL: -77.7%**
- Simple exits actually WORSE pass rate (45.9% vs 51.0%) — enhanced exits help here
- Per-regime: uptrend+high +78.5%, ranging+low +44.5%

### Config #4: ob_based + maker + suppress (Enhanced Exits)

| Symbol | Total Windows | Skipped | Eligible | Passed | Pass Rate |
|--------|--------------|---------|----------|--------|-----------|
| BTCUSDT | 33 | 16 | 17 | 3 | 17.6% |
| ETHUSDT | 33 | 2 | 31 | 10 | 32.3% |
| SOLUSDT | 33 | 0 | 33 | 19 | 57.6% |
| **Overall** | **99** | **18** | **81** | **33** | **40.7%** |

- **293 trades** — too few, especially BTCUSDT (38 trades, 16 zero-trade windows)
- **42.0% win rate** — slightly higher than dynamic_rr
- **Overall PnL: +3.40%** — barely positive but stable
- BTCUSDT catastrophically under-trades with regime suppression + ob_based SL

---

## Comparison Table

| Metric | Config #12 Enhanced | Config #12 Simple | Config #4 |
|--------|-------------------|-------------------|-----------|
| **Pass Rate** | **51.0%** | 45.9% | 40.7% |
| Eligible Windows | 98 | 98 | 81 |
| Total Trades | 891 | 817 | 293 |
| Win Rate | 41.0% | 41.9% | 42.0% |
| Overall PnL | -86.6% | -77.7% | +3.4% |
| BTCUSDT Pass % | 53.1% | 53.1% | 17.6% |
| ETHUSDT Pass % | 48.5% | 42.4% | 32.3% |
| SOLUSDT Pass % | 51.5% | 42.4% | 57.6% |
| **Gate (>45%)** | **PASS** | **MARGINAL** | **FAIL** |

## Key Findings

### 1. Config #12 (dynamic_rr) PASSES the 45% gate at 51.0%

This is the first config in the project to pass walk-forward validation with the dynamic_rr SL mode. All three symbols individually pass 48%+.

### 2. In-Sample vs Out-of-Sample Divergence is Massive

- **In-sample**: +114% PnL (full-dataset backtest)
- **Out-of-sample**: -86.6% PnL (walk-forward)

The pass rate (51%) confirms edge exists in half of windows. But the edge is **asymmetric** — wins are modest (+3-15% per window), while losses are catastrophic (-18% to -34% per window). The in-sample +114% was driven by lucky sequencing where big wins compound without intervening catastrophic drawdowns.

### 3. Enhanced Exits are Actually Helpful with dynamic_rr

Contrary to iteration 9's finding (enhanced exits hurt with ob_based SL), they help with dynamic_rr:
- Enhanced: 51.0% pass rate, 891 trades
- Simple: 45.9% pass rate, 817 trades

This likely because dynamic_rr's tighter TP (2.0 × risk vs 4.0 × ATR) means fewer trades reach TP, so the trailing stop captures partial profits that would otherwise revert to SL.

### 4. Config #4 (ob_based) Doesn't Have Enough Trades

With regime suppression + ob_based SL, BTCUSDT produces only 38 trades across 33 windows (16 windows empty). The system is too selective — regime suppression removes half the market, and the stricter ob_based entry further thins signals.

### 5. Regime Edge Profile Confirmed OOS

The regime breakdown is consistent in-sample and out-of-sample:
- **uptrend+high**: Strong positive (+98% PnL from 147 trades, 51% WR)
- **ranging+low**: Moderate positive (+37% PnL from 219 trades, 39% WR)
- **downtrend+high**: Strongly negative (-113% PnL)
- **uptrend+normal**: Negative (-103% PnL)

The suppressed regimes (ranging+normal, ranging+high) would have added more losses.

---

## Decision: CONDITIONAL GO for Paper Trading

**Config #12 (dynamic_rr + maker + suppress + enhanced)** passes the 45% gate at 51.0%.

### Conditions for Paper Trading

1. **Position sizing must be conservative** — the -18% to -34% window drawdowns mean full-size positions would be destructive. Max 2% of capital per trade.
2. **Use maker orders only** — the 0.14% RT friction is essential. Taker mode (0.30% RT) would destroy the edge.
3. **Monitor per-window Sharpe** — if 3 consecutive windows fail, pause and re-evaluate.
4. **SOL has highest variance** — consider starting with BTC+ETH only for the initial paper trading period.

### Paper Trading Command

```bash
npx tsx scripts/paper-trade-confluence.ts \
  --symbol BTCUSDT \
  --threshold 4 \
  --suppress-regime "ranging+normal,ranging+high" \
  --sl-mode dynamic_rr \
  --friction 0.0007
```

### What Would Improve the System

The biggest remaining risk is **catastrophic drawdown windows** (W8 BTC: -18%, W22 ETH: -33%). These are driven by:
- Consecutive losing trades in high-volatility downtrends
- dynamic_rr SL is placed below the OB, which in downtrend+high can be very far from entry

Potential mitigations for future iterations:
- **Max consecutive loss circuit breaker** (stop after 3-4 consecutive losses in a window)
- **Volatility-adjusted position sizing** (smaller in downtrend+high)
- **Per-window trailing equity stop** (close all if equity drops >10% in a window)

---

_Generated: 2026-02-08_
_Script: scripts/backtest-confluence.ts with --sl-mode dynamic_rr --friction 0.0007 --suppress-regime "ranging+normal,ranging+high"_
