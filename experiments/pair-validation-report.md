# Pair Validation Report — 2026-02-09

## Summary
- **Candidates tested:** 17
- **Passed (>= 60% WF pass rate):** 1
- **Failed:** 16
- **Config:** CMA-ES Run 18 (threshold=4.672)

## Results (sorted by pass rate)

| Pair | WF Pass Rate | Windows | Trades | Win Rate | Avg Sharpe | Total PnL | Verdict |
|------|-------------|---------|--------|----------|------------|-----------|--------|
| LINKUSDT | 60.6% | 20/33 | 313 | 51.1% | 2.18 | +21.0% | PASS |
| DOGEUSDT | 57.6% | 19/33 | 303 | 50.2% | -0.28 | -63.5% | FAIL |
| NEARUSDT | 57.6% | 19/33 | 329 | 50.5% | 0.20 | -39.0% | FAIL |
| ADAUSDT | 56.3% | 18/32 | 304 | 51.6% | 3.85 | +69.5% | FAIL |
| APTUSDT | 54.5% | 18/33 | 304 | 53.0% | 5.57 | +28.8% | FAIL |
| ARBUSDT | 53.1% | 17/32 | 310 | 52.3% | 1.41 | -32.5% | FAIL |
| MATICUSDT | 50.0% | 8/16 | 139 | 45.3% | -7.60 | -45.4% | FAIL |
| AVAXUSDT | 48.5% | 16/33 | 327 | 52.6% | 6.93 | +3.2% | FAIL |
| DOTUSDT | 48.5% | 16/33 | 275 | 50.9% | -4.60 | -43.4% | FAIL |
| XRPUSDT | 45.5% | 15/33 | 265 | 52.5% | -4.38 | -8.3% | FAIL |
| ATOMUSDT | 45.5% | 15/33 | 289 | 50.2% | 1.00 | -29.8% | FAIL |
| ICPUSDT | 45.5% | 15/33 | 329 | 47.7% | -3.56 | +0.0% | FAIL |
| LTCUSDT | 39.4% | 13/33 | 261 | 43.3% | -13.61 | -89.4% | FAIL |
| UNIUSDT | 36.4% | 12/33 | 300 | 52.0% | 1.47 | -3.5% | FAIL |
| AAVEUSDT | 36.4% | 12/33 | 341 | 45.7% | -9.46 | -86.0% | FAIL |
| BNBUSDT | 35.5% | 11/31 | 200 | 43.0% | -29.42 | -57.4% | FAIL |
| FILUSDT | 30.3% | 10/33 | 311 | 44.7% | -10.27 | -85.4% | FAIL |

## Validated Pairs for Paper Trading
`BTCUSDT, ETHUSDT, SOLUSDT, LINKUSDT`

## Paper Trade Command
```bash
npx tsx scripts/paper-trade-confluence.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT,LINKUSDT
```
