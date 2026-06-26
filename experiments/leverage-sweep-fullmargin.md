# ICT "Full Margin Scalp" — Leverage / Liquidation Sweep Findings

**Date:** 2026-06-26
**Spec:** `docs/superpowers/specs/2026-06-25-ict-scalp-leverage-sim-design.md`
**Plan:** `docs/superpowers/plans/2026-06-25-ict-scalp-leverage-sim.md`
**Signal under test:** `ict_5m` scalp (`src/lib/scalp/strategies/ict-5m.ts`), default config
**Universe:** BTCUSDT, ETHUSDT, SOLUSDT, XAUUSD (1m data; XAUUSD via `data/XAUUSD_1m.json`)
**Artifacts:** `experiments/tape-ict5m.json` (tape), `experiments/leverage-sweep-f1.json`, `experiments/leverage-sweep-f0.1.json`

---

## TL;DR

**"ICT full margin scalp" on this signal is guaranteed ruin.** The underlying `ict_5m` scalp has **negative expectancy at 1x** (−0.0997%/trade, 33.1% win rate, −328.7% additive PnL over 3,296 trades). Leverage creates no alpha — it only sets *how fast* the account dies. The growth-rate-vs-leverage curve has **no Kelly hump**: it is negative everywhere and monotonically more negative as leverage rises. Growth-maximizing leverage is **L\* = 1** (i.e. use the least leverage possible — ideally none) in every configuration tested.

This is the spec's **baseline gate firing exactly as designed**: with no positive edge to amplify, the leverage analysis is moot except as a demonstration of ruin. It is hard-number confirmation of the standing project principle — *we don't full-margin* — for this signal.

---

## 1. Baseline (1x) — the gate

| Metric | Value |
|---|---|
| Trades | 3,296 (BTC 252, ETH 124, SOL 80, XAUUSD 2,840) |
| Win rate | 33.1% |
| Mean P&L / trade | **−0.0997%** (expectancy **NEGATIVE**) |
| Total P&L (additive, 1x) | **−328.7%** |
| Walk-forward pass rate | 16.9% |

The signal loses across the board. Per spec §2: *"If aggregate expectancy ≤ 0, that is itself the finding — leverage analysis is moot."* We proceeded with the sweep only to demonstrate the failure mode concretely on real data.

## 2. Full margin (marginFraction = 1) — the marketed configuration

Each trade commits the **entire account** as isolated margin at leverage L.

| L | totalReturn | meanLogG/trade | maxDD | liquidations | ruin% |
|---|---|---|---|---|---|
| 1 | −96.6% | −0.001026 | 97% | 0 | 100.0% |
| 2 | −99.9% | −0.002061 | 100% | 0 | 100.0% |
| 5 | −100.0% | −0.005225 | 100% | 0 | 100.0% |
| 10 | −100.0% | −0.010693 | 100% | 0 | 100.0% |
| 25 | −100.0% | −0.028603 | 100% | 0 | 100.0% |
| 50 | −100.0% | −0.064060 | 100% | 0 | 100.0% |
| 100 | −100.0% | −2.101265 | 100% | 1 | 100.0% |
| 125 | −100.0% | −5.643372 | 100% | 1 | 100.0% |

**L\* = 1, L_ruin = 1.** At full margin, the account is wiped (ruin% = 100%) at *every* leverage including **1x** — because betting the whole account each trade on a negative-edge, compounding system is ruinous on its own. Liquidations (the 0.5–1% buffer being pierced by 1m wicks) only appear at L ≥ 100; below that, compounding the negative edge kills the account before liquidation is even reached.

## 3. Kelly-revealing sweep (marginFraction = 0.1) — looking for a hump

Smaller per-trade bets let the account survive longer, so the *shape* of the growth curve is visible.

| L | totalReturn | meanLogG/trade | maxDD | liquidations | ruin% |
|---|---|---|---|---|---|
| 1 | −28.6% | −0.000102 | 29% | 0 | 0.0% |
| 2 | −49.0% | −0.000204 | 49% | 0 | 0.0% |
| 5 | −81.5% | −0.000512 | 82% | 0 | 0.0% |
| 10 | −96.6% | −0.001026 | 97% | 0 | 100.0% |
| 25 | −100.0% | −0.002582 | 100% | 0 | 100.0% |
| 50 | −100.0% | −0.005225 | 100% | 0 | 100.0% |
| 100 | −100.0% | −0.012475 | 100% | 110 | 100.0% |
| 125 | −100.0% | −0.022284 | 100% | 506 | 100.0% |

**L\* = 1, L_ruin = 10.** The growth rate (meanLogG/trade) is **negative at L=1 and strictly decreases** as leverage rises — the textbook signature of a **negative-edge system**. A profitable system would show a concave hump peaking at the Kelly-optimal leverage; here there is no peak above zero. (For contrast, the harness's synthetic 60%/±1% positive-edge test correctly finds the hump at L≈20 — see `tests/scalp/leverage/simulator.test.ts`. The machinery works; the *signal* doesn't.)

Note: f=0.1 records *more* liquidations than f=1 (110/506 vs 1) because at f=1 the account hits the absorbing barrier (equity → 0) early and the sim stops processing trades, so fewer trades ever reach the high-leverage liquidation check. This is correct behavior, not a bug.

## 4. Integrity check — L=1 reconciliation

At L = 1, the liquidation price is `entry × (1 − 1 + mmr) = entry × mmr` (≈ 0.5% of price — effectively unreachable). Both sweeps report **0 liquidations at L=1**, confirming leverage's *only* deviation from the 1x outcome is liquidation, and that it cannot fire at 1x. The L=1 result is therefore a faithful (compounded) replay of the 1x tape.

The L=1 full-margin compounded return (−96.6%) differs from the additive baseline (−328.7%) because the simulator **compounds** (multiplicative, floored at −100% — you cannot lose more than the account) while the backtest **sums** per-trade returns. The signs agree (both decisively negative); −328.7% additive is not a realizable return.

## 5. Known limitation (does not change the verdict)

13.9% of trades (458 / 3,296) are **same-5m-bar exits** where `entryTimestamp == exitTimestamp`. The resolver walks `(entryTs, exitTs]`, which is empty for these, so they are **never liquidation-checked at 1m** — biasing the liquidation *count* optimistically (a property of the spec's (entry, exit] walk + 5m→1m mapping; see spec §11). This is **immaterial to the conclusion**: liquidations only matter at L ≥ 100, and ruin is already 100% from L = 10 via compounding the negative edge. Even if every same-bar trade were a hidden liquidation, the verdict (guaranteed ruin) is unchanged. A follow-up could extend the walk to `[entryTs, exitTs + barMs)` to cover full entry/exit bars if liquidation-count fidelity ever becomes the deciding factor (it isn't here).

## 6. Verdict

- **Full margin is not a model.** It is a leverage transform on an existing edge. This signal has no edge, so the transform only amplifies losses and adds ruin risk.
- **There is no leverage worth using here.** L\* = 1 everywhere; the honest answer is "don't trade this signal," and certainly not levered.
- **The wild part is real, just inverted.** The marketing promise ("tiny move → huge gain at 100x") is symmetric: tiny adverse move → liquidation, and on a 33%-WR signal the adverse moves dominate. 100% ruin, fast.
- **Reusable result:** the leverage/liquidation/funding/ruin harness (`src/lib/scalp/leverage/`) is validated (synthetic Kelly = 20) and can be pointed at any future *positive-edge* signal (e.g. the validated Run 20 OB book) to find its actual Kelly-optimal leverage — which is the only context in which leverage is a question worth asking.

## Reproduce

```bash
# 1) Emit the tape (baseline gate prints here)
npx tsx scripts/backtest-scalp.ts --strategy ict_5m \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT,XAUUSD \
  --emit-trade-tape experiments/tape-ict5m.json

# 2) Full margin
npx tsx scripts/leverage-sweep.ts --tape experiments/tape-ict5m.json \
  --leverage-grid 1,2,5,10,25,50,100,125 --margin-fraction 1 \
  --out experiments/leverage-sweep-f1.json

# 3) Kelly-revealing
npx tsx scripts/leverage-sweep.ts --tape experiments/tape-ict5m.json \
  --leverage-grid 1,2,5,10,25,50,100,125 --margin-fraction 0.1 \
  --out experiments/leverage-sweep-f0.1.json
```

Note: `data/*_1m.json` are gitignored (100–500 MB each) and may be refreshed by background tooling — regenerate the tape and sweeps in one pass for a consistent run.
