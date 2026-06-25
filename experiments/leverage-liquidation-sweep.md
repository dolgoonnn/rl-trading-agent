# Leverage / Liquidation Sweep on Run-20 (2026-06-25)

**Question:** "Can we run the validated edge at high leverage / full margin?" Answered empirically by re-simulating the canonical Run-20 entries at each leverage with a Bybit isolated-USDT-perp liquidation model.

**Method:** 657 canonical Run-20 entries (BTC 163 / ETH 212 / SOL 282), dumped from `backtest-confluence --dump-positions`, re-simulated per leverage via the shared `simulatePosition` (with `leverage`/`mmr` → liquidation flagged when the liq price is crossed before the stop, intrabar). Equity compounded with a fixed margin-fraction `f`: non-liquidated trade `×(1+L·f·r)`, liquidated trade `×(1−f−liqFee)` (isolated cap), ruin clamp at 0. Friction 7 bps, MMR 0.5%, liqFee 0.5%. L=1 fidelity check passes (reproduces the Run-20 edge, 657/657 resolved).

## The curve

| L | liqRate | per-trade Sharpe | terminalWealth (f=.02 / .05 / .10) | maxDD (f=.02 / .05 / .10) |
|---|---|---|---|---|
| 1 | 0% | 0.082 | 1.06 / 1.15 / 1.33 | 2% / 5% / 11% |
| 2 | 0% | 0.082 | 1.12 / 1.33 / 1.73 | 4% / 11% / 20% |
| 5 | 0% | 0.082 | 1.33 / 1.95 / 3.39 | 11% / 25% / 44% |
| **10** | **1.07%** | 0.073 | **1.60 / 2.94 / 5.59** ← peak wealth | 22% / 45% / 72% |
| 25 | 33.2% | −0.01 | 0.41 / 0.28 / 0.03 | 70% / 89% / 99% |
| 50 | 72.8% | −0.13 | 0.02 / 0.001 / ~0 | 98% / 100% / 100% |

`liqRate` and Sharpe are `f`-independent (liquidation depends on L and the price path, not on sizing). Per-trade Sharpe ≈ ×√219 ≈ 1.2 annualized.

## Findings

1. **Terminal wealth peaks at L=10** across all sizing — *not* low single-digit.
2. **It's a knife-edge.** L=10 is where liquidations begin (1.07%), Sharpe starts degrading, and the next step is a cliff: L=25 loses 59–97%, L=50 is near-total ruin. **Full-margin scalping is confirmed ruin.**
3. **Prudent zone = L ≤ 5:** liqRate exactly 0, Sharpe undegraded (0.082), still 1.3–3.4× wealth at f=0.10 with maxDD ≤ 25–44%. Captures most of the leverage benefit with **zero liquidation risk**.
4. **Leverage does not improve the edge** — Sharpe is flat through L=5 → leverage only scales the bet until liquidation truncates it. Optimal leverage is set by **drawdown tolerance, not edge** (consistent with the combined-book "drawdown tolerance binds, not Kelly").

## Caveats

- **Isolated margin** (loss capped at the trade's margin). **Cross-margin would be worse** (account-wide liquidation / ADL) — not modeled.
- The L=10 peak rides 22–72% drawdowns + a 1% liquidation rate — growth-optimal, not survival-optimal.
- Single MMR tier (0.5%); larger notionals hit worse tiers. 1h Run-20 entries only (not the no-edge scalp sandbox — leveraging that just confirms faster ruin).

## Reproduce

```bash
# 1. dump canonical Run-20 entries
npx tsx scripts/backtest-confluence.ts <Run-20 flags> --dump-positions /tmp/run20-positions.json
# 2. sweep
npx tsx scripts/leverage-sweep.ts --positions /tmp/run20-positions.json [--f 0.05] [--leverages 1,2,5,10,25,50]
```

Model: `src/lib/sim/{liquidation,leverage-equity,leverage-sweep-core}.ts`. Liquidation flag: `simulatePosition` via `SimConfig.leverage`/`mmr`.
