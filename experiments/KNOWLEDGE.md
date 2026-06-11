# Experiment Knowledge Base

Consolidated index of every experiment track in this repo (Feb–Jun 2026, ~250
documented experiments). Read this before testing a new idea — most idea families
have already been falsified, and the methodology lessons here are paid for.

**Last updated**: 2026-06-11 (after strategy-combination study)

---

## 1. Track verdicts

| Track | Scope | Best result | Verdict | Primary docs |
|---|---|---|---|---|
| **1H crypto confluence** | Iterations 1–55, CMA-ES Runs 1–20 | Run 20: 69.7% WF, +1573.7% PnL, validated 5/7, **deployed to bot** | ✅ EDGE | `iteration-*.md`, `PROGRESS.md` |
| **F2F daily gold** | Paper replication + 62-param sweep | Sharpe 2.08, +197% PnL, 15.3% MaxDD, **6/7 validation**, deployed | ✅ EDGE | `f2f-validation-results.json`, MEMORY.md |
| **5m crypto scalp** | 2 phases, 6 strategies | 33.3% WF after bug fixes (gate: 40%) | ❌ DEAD | `scalp-phase1-results.md`, `scalp-phase2-results.md` |
| **Gold 1H asian-range** | CMA-ES Runs 1–20 | Fitness 1124.4, 100% WF in-sample → collapsed OOS, failed MC | ❌ DEAD | `gold-cmaes-iterations.md`, `gold-readiness-assessment.md` |
| **Forex 1H** | 4 pairs, feasibility + CMA-ES Runs 1–4 | 65.4% WF in-sample → 3/7 validation | ❌ DEAD | `forex-gold-feasibility.md`, `forex-validation-results.json` |
| **Gold 1m/3m sweep+CHoCH** | Vendor-indicator clone, 12 configs + zero-friction | 24.8% WF best; entry is coin flip gross of costs | ❌ DEAD | `gold-1m-sweep-choch.md` |
| **Gold overnight session hold** | Parameter-free 22→07 UTC long; 2015–19 holdout test | Sharpe 1.7–2.1, 12/12 years + at 0 friction; holdout-confirmed; venue-dependent (≤1bp/side) | ✅ CANDIDATE | `gold-session-hold.md`, `gold-1m-research.md` |
| **Crypto altcoin transfer** | 17 alts on Run 18 config | Only LINKUSDT passed (60.6% WF) | ⚠️ BTC/ETH-dominant | `pair-validation-report.md` |
| **RL (PPO/DDQN)** | Weight optimizer, signal filter, funding rate | All negative or zero-trade | ❌ DEAD | `ppo-eval-*.json`, MEMORY.md |
| **Strategy combination** | crypto Run 20 + session book + F2F as one book; EW/handcraft/ERC/shrunk-MV, all walk-forward | Sharpe 2.16 → **2.94** (+36% vs best sleeve, ρ≈0, DM 1.72); handcraft only method to beat EW (P=99.1%, 11yr universe); **deployable at venue-realistic costs: Sharpe 2.53, 37%/yr @12% vol target, 5/5 stress gates** | ✅ EDGE (combination layer) | `strategy-combination.md` |
| **Execution audit** | All 9 session-book legs re-priced at researched 2026 venue costs (MGC/SIL/MES/ECN/Bybit) | 7/9 legs survive; EUR-h22 dead (−4.0 Sharpe at real rollover costs), Au-AM-fix cut; gold 0.3bp assumption → 0.45–0.55bp real; **22:00 UTC overnight entry sits on CME maintenance break (DST bug) — re-anchor to 18:05 ET before deploy** | ⚠️ GATING ITEMS | `execution-audit.md` |

---

## 2. What works (validated, in production)

### 1H crypto OB confluence — CMA-ES Run 20
- 69.7% WF, +1573.7% PnL, 48.5% WR; PBO=21%, DSR=7.58, MC trade-level PASS (param fragility expected from CMA-ES convergence)
- Improvement trajectory documented in iterations 14→35: baseline 54.6% → partial TP 50%@1R + breakeven (+3.1pp) → ATR extension filter (+1.7pp) → per-regime thresholds (+2.5pp, +171pp PnL) → 61.9%; the 61.9→71.3% step came from CMA-ES (see §6 Discrepancies)
- Full config + reproduction command: MEMORY.md "Run 20"

### F2F daily gold (forecast-to-fill, arXiv 2511.08571)
- Long-only, λ=0.95/θ=0.91, zscore50 regime filter; 1,097 OOS trades, 39.3% WR, Sharpe 2.08
- The single most parameter-robust model in the repo: 8% fragility, bootstrap PnL 5th pct +103%
- Only failed check: WF pass 51.1% (<60%) — expected for long-only through gold downtrends
- Module: `src/lib/gold/` (independent of ICT code)

---

## 3. The graveyard (do not re-test without a NEW mechanism)

| Idea family | Evidence | Where |
|---|---|---|
| FVG as primary signal | 25.6% WR (iter 6); revival at 40.4% WF (iter 40-43) | iteration-6, iteration-36-55 |
| BOS / CHoCH as primary signal | 35.7% / 46.3% WF vs OB-only 71.3% | iteration-36-55 |
| Strategy ensembles | OB+FVG −17.2pp, OB+CHoCH −3.6pp vs OB-only | iteration-36-55 |
| 15m timeframe (crypto) | 44.6% WF (−26.7pp) — noise-dominated | iteration-36-55 |
| 5m scalping, any strategy (crypto) | 6 strategies, best 33.3% WF post-bug-fix | scalp-phase2-results |
| 1m/3m gold sweep+CHoCH, vendor bracket | 12/12 fail; +0.00045%/trade at ZERO friction | gold-1m-sweep-choch |
| Volume weighting | −7.4pp (iter 22) | iteration-20-23 |
| Breaker blocks | −2.2pp at weight 0.5 (iter 47) | iteration-36-55 |
| OTE zone factor | zero effect (iter 44) | iteration-36-55 |
| Funding-rate features | zero predictive power | MEMORY.md |
| RL (PPO weights, signal filter, DDQN) | −6.3pp / 0 trades / failed gates | ppo-eval JSONs |
| Per-regime SL/TP multipliers, vol-scaled sizing, streak sizing, drawdown limits | all rejected, iter 24-31 | iteration-24-27, -28-31 |
| Circuit breaker (consecutive-loss pause) | never fires at 1H trade frequency | iteration-12 |
| Crypto-tuned config on forex | 36.5% WF aggregate, EURUSD/GBPUSD 15.4% | forex-gold-feasibility |
| Session-range (Asian) gold intraday at 1H | 100% WF in-sample → failed MC OOS | gold-cmaes-iterations |

---

## 4. Methodology canon

### Look-ahead bug triad (scalp Phase 2 — invalidated an entire phase)
1. **HTF aggregation**: `aggregate(5m, 12)` produced 12-minute "1H" bars — smoother, falsely predictive
2. **Unclosed HTF bar**: using the current 1H bar gives up to 59 min of future knowledge
3. **Same-bar entry**: signal computed from close, filled at that close = free favorable slippage

Corrected ATR breakout went **61.1% → 33.3% WF**. Every new harness must inherit these fixes
(`backtest-scalp.ts` does: next-bar-open entry, closed-HTF-only `findHTFIndex`).

### Metrics integrity
- **0-trade windows are SKIP, not FAIL** (iteration 8) — otherwise filtering improvements are penalized
- Maximin worst-case Sharpe and WF pass rate can disagree (iteration 3/13): decide on WF pass rate
- Calibration script vs backtest script must reproduce each other (iteration 13)

### Friction
- Rule of thumb: **if WR is within ~5pp of the bracket's breakeven, friction decides the sign**
- LTF math: on 1m gold, 1R ≈ 5–15 bps → 2 bps/side friction = 25–80% of one R. Unwinnable.
- Friction reference: crypto perp 5–7 bps/side; gold spot 0.5–1.5 bps/side; forex majors ~3 bps/side
- Friction sensitivity that is monotonic and steep (each doubling −9–11pp WR) is the signature of a no-edge system

### Validation battery (ordered by discriminating power, from actual failures)
1. **MC bootstrap Sharpe/PnL 5th percentile** — killed gold 1H (−8.4) and forex (−3.94) AFTER they passed WF/DSR. Strongest gate.
2. **Walk-forward >60%** — necessary but insufficient; fooled twice (gold 100%→61.6% OOS, forex 65.4%→3/7)
3. **Param fragility** — flat basin (F2F 8%) = robust; sharp basin (forex 76%) = brittle; CMA-ES output is always sharp (interpret, don't auto-fail)
4. **DSR** — haircuts Sharpe 10–40% for trial count; track the trial count honestly (currently 236+)
5. **PBO <25%** — weak with few windows/variants; structural limits at small sample
6. **Skip 20%** — edge concentration check
- **Sample floor**: <100 trades ⇒ treat any pass as provisional (gold 1H's 69-trade configs were mirages)

### Optimization
- In-sample CMA-ES fitness is meaningless: gold runs found 3 distinct basins, all ~1124 fitness, all overfit
- CMA-ES params are data-window-sensitive: re-optimize after data refreshes (Run 18 → 20 lesson)
- Warm-start chains work; fresh starts mostly rediscover the same ceiling
- **Never optimize a model that loses at zero friction** (gold 1m rule)

---

## 5. Market character (cross-market findings)

| Property | Crypto (1H) | Gold | Forex majors |
|---|---|---|---|
| structureAlignment weight (CMA-ES) | 1.7–2.7× | **→ 0 in every run** | 3.2× |
| liquiditySweep weight | 1.3–1.7× | **3.4–4.2× (dominant)** | 4.3× |
| Regime suppression | critical (+20pp) | not needed (all variants worse) | misaligned (95% ranging+low) |
| ATR% per 1H | 1.5–2.5% | 0.5–1.0% | 0.04–0.08% |
| Long/short asymmetry | mild | **endemic** (157:3 OOS; longBias 1.30) | n/a |
| Robustness vs timeframe | 1H ≫ 15m ≫ 5m | **daily ≫ 1H ≫ 1m** (6/7 → failed-MC → coin flip) | untested below 1H |

Key implication: BOS/CHoCH-style structure does not predict gold (your own optimizer zeroed it
twice) — any "smart money structure" gold product should be assumed edge-free until proven otherwise.

---

## 6. Record discrepancies (need reconciliation)

0. **F2F overlap inflation — RESOLVED 2026-06-10** (`validate-f2f.ts --slide 126`,
   `f2f-validation-results-deoverlap.json`): on non-overlapping windows F2F's calendar
   truth is **+19.4% total over 11.4yr (~1.6%/yr), Sharpe 2.0 when invested, MaxDD 3.8%,
   185 trades**. Scorecard vs the recorded 6/7: **PBO 16.8% → 88.5% FAIL** (the λ/θ
   selection does not generalize across independent windows; overlapped CSCV shared data
   between splits), bootstrap tails collapse (Sharpe 5th 1.41 → 0.11, PnL 5th +103% →
   +0.4%). Verdict: F2F is a thin-deployment, marginal-calendar-PnL strategy — per-trade
   quality real, headline "+197%" an overlap artifact. Bot is low-risk (tiny DD) but its
   expected P&L is ~1.6%/yr unleveraged, and λ/θ re-selection is unstable.

1. **61.9% → 71.3% undocumented**: iteration writeups end at 61.9% WF (iter 35); MEMORY.md
   baseline is 71.3% from later CMA-ES work with no writeup in `experiments/`.
2. **Gold 11-year revalidation missing**: MEMORY.md says Run 12 failed 0/6 on 2015–2026 data;
   `gold-validation-results.json` (Feb 20) still contains the older 2-yr-era 3/7 result
   (61.6% WF, 160 trades). The 11-yr run's JSON was overwritten or never saved.
3. **OB half-life contradiction**: iteration-20 rejected exponential OB decay (3-tier scoring won),
   yet deployed Run 20 uses `--ob-half-life 12`. Reversal happened inside CMA-ES; no written reconciliation.

---

## 7. Iteration protocol for new ideas (distilled)

The cheap-kill ladder — each step only runs if the previous passes:

1. **Zero-friction backtest** (~5 min on 1m gold): gross edge must be clearly positive.
   Coin flip ⇒ stop. No tuning, no "maybe with a filter".
2. **Friction ladder** (charitable → realistic): edge must survive the realistic level.
3. **Walk-forward** >40% (exploration gate) / >60% (paper-trading gate), 0-trade windows skipped.
4. **Full battery**: MC bootstrap first, then DSR (increment the trial count), PBO, fragility, skip-20%.
5. **Record the result here and in `experiments/` even when (especially when) it fails.**

**Sandbox note**: 1m XAUUSD (`data/XAUUSD_1m.json`, 2.28M candles, 2020–2026, all regimes) is the
best falsification substrate in the repo — ~310 WF windows, 8K–37K-trade verdicts, minutes per run
via `backtest-scalp.ts --tf`. The archive's standing prior: 18/18 LTF strategy configs across two
markets had no edge — on 1m, treat the signal layer as guilty until the zero-friction run says otherwise.
Untested shapes worth a look: 1m as *execution* layer for HTF signals (daily F2F bias + LTF fill),
session-range logic with multi-hour holds, time-of-day spread/volatility structure.

**2026-06-10 outcome of this protocol**: exploratory research (`gold-1m-research.md`) killed
sweeps definitively (negative alpha vs drift, n=65k) but surfaced the overnight session
seasonal — which then passed a 2015–2019 holdout (`gold-session-hold.md`). Calendar
structure beat pattern structure, exactly as the gold CMA-ES weight profile predicted.

---

## 8. File index

- **1H confluence iterations**: `iteration-001.log` … `iteration-36-55-new-dimensions.md`, `PROGRESS.md`
- **Scalp**: `scalp-iteration-1.md`, `scalp-phase1-results.md`, `scalp-phase2-results.md`
- **Gold 1H**: `gold-cmaes-iterations.md` (Runs 1–20 log), `gold-readiness-assessment.md`, `gold-validation-results.json`, `gold-session-analysis.json`
- **Gold 1m**: `gold-1m-sweep-choch.md`, raw runs in `runs/gold-sweep-choch/`
- **Forex**: `forex-gold-feasibility.md`, `forex-validation-results.json`
- **F2F**: `f2f-validation-results.json`, `f2f-param-sweep-results.json`, `f2f-backtest-results.json`
- **Altcoins**: `pair-validation-report.md`, `pair-validation-results.json`
- **Validation artifacts**: `pbo-results*.json`, `monte-carlo-results*.json`, `dsr-results.json`
- **RL**: `ppo-eval-*.json`
- **Specs**: `docs/superpowers/specs/` (design docs for newer tracks)
