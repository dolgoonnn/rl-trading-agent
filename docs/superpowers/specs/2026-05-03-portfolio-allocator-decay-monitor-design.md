# Portfolio Allocator + Decay Monitor + Live-Paper Audit

**Date:** 2026-05-03
**Scope:** Path A (A1 + A2 + A3) from the project-plateau brainstorm.
**Out of scope:** Funding-arb (Path B1), enforcement-mode allocation (deferred until 90d advisory data exists), regime-aware MRP monitoring (deferred until trade-per-regime sample size is meaningful).

---

## Why

The project has hit a plateau on per-strategy optimization: 190+ ICT-family experiments, three strategies that survive rigorous validation (ICT 3-sym Run 20, ICT 7-sym Broad Run 4, F2F gold), and no marginal returns from further parameter search. The unbuilt pieces aren't more strategies — they're (a) a portfolio layer that combines what already exists, and (b) a decay monitor that detects when validated edge stops working in live conditions.

The 90-day live paper-trade clock should run *while* this work proceeds; the monitor and allocator are the instruments that make that clock interpretable.

## Goals

1. **A1 — Portfolio Allocator (advisory):** publish weekly inverse-volatility weight recommendations across **currently deployed** strategies (today: ICT 3-sym Run 20 + F2F gold; ICT 7-sym is validated but not deployed and is excluded from allocation until it ships). Delivered to Telegram + JSON file. Human applies them by editing config (no auto-enforcement in v1).
2. **A2 — Decay Monitor:** detect when a strategy's live performance falls outside its bootstrap-validated distribution, and alert. Supports all 3 validated strategies — gold + 3-sym are monitored from day 1; 7-sym is wired up but inactive until deployment, so the same code handles it without changes when it lands.
3. **A3 — Live-Paper Audit:** confirm the bots already log everything A1/A2 need; close any gaps with minimal schema/code changes.

## Non-goals

- Auto-enforcement of allocator weights in v1. Advisory only for the 90d paper window. Enforcement is a v2 design once trust is established.
- Regime-bucketed performance monitoring (Minimum Regime Performance / Alexander-Fabozzi 2026). Defer until per-regime trade counts are statistically meaningful (~6 months of paper data).
- Cross-strategy correlation in the weight calculation. Inverse-vol only. Add ERC-style correlations when strategy count reaches 4+ (post-funding-arb).
- New strategy research, ICT re-optimization, or bot architectural rewrites.

---

## Architecture

Two new standalone scripts, one audit task. Both scripts are pure read-only consumers of existing bot state. Neither modifies bot behavior in v1.

```
                              ┌─────────────────────────┐
   crypto-bot SQLite ───┐     │  scripts/run-allocator  │
   (bot_equity_snaps)   ├─────►   weekly cron            ├──► data/allocator-recommendations.json
                        │     │   inverse-vol weights    ├──► Telegram alert
   gold-bot JSON state ─┤     └─────────────────────────┘
   (rolling30dReturns)  │
                        │     ┌─────────────────────────┐
                        ├─────►  scripts/run-monitor    │
                        │     │   daily cron             ├──► data/decay-status.json
   experiments/*.json ──┘     │   bootstrap-floor + DD   ├──► Telegram alert (on trip)
   (bootstrap 5th pcts)       └─────────────────────────┘
```

**Key boundary decisions:**
- Allocator and monitor are **separate processes** (single-purpose, independently scheduled, easier to debug).
- Both share a small **`src/lib/portfolio/equity-source.ts`** adapter that abstracts "give me the equity time series for strategy X" over crypto SQLite vs. gold JSON. This is the only new shared code.
- Bootstrap floors are read from the existing `experiments/*-validation-results.json` files via a small loader; values are not duplicated into config.
- Both scripts are added to `ecosystem.config.cjs` as cron-style PM2 entries.

## Components

### `src/lib/portfolio/equity-source.ts` (~120 LOC)

Single adapter, one job: given a strategy name, return `{ timestamp: number, equity: number }[]` for the last N days.

```ts
type StrategyId = 'ict-3sym' | 'ict-7sym' | 'f2f-gold';
interface EquityPoint { timestamp: number; equity: number; }
export function getEquityHistory(strategy: StrategyId, days: number): EquityPoint[];
export function getDailyReturns(strategy: StrategyId, days: number): number[];
```

Crypto strategies read from `bot_equity_snapshots` table (already populated). Gold reads from `data/gold-bot-state.json` (`rolling30dReturns` is the daily return array directly). Crypto snapshots are sub-daily (~hourly tick); resampled to one point per UTC day by taking the last snapshot at or before each UTC midnight. Daily returns are then `(equity_t / equity_{t-1}) - 1`.

### `src/lib/portfolio/allocator.ts` (~80 LOC)

Pure function. Inputs: array of `{ strategy, dailyReturns }`. Output: array of `{ strategy, weight }` summing to 1.

```ts
weight_i = (1 / σ_i) / Σ (1 / σ_j)
```

`σ_i` = annualized standard deviation of daily returns over the lookback window (60d default). If a strategy has fewer than 30 daily returns recorded (cold start), it's excluded from the basket and a warning is emitted.

### `src/lib/portfolio/decay-monitor.ts` (~150 LOC)

Two tripwires per strategy:

1. **Bootstrap-floor breach:** live 30d annualized Sharpe < bootstrap 5th-percentile from validation. Bootstrap values currently captured: ICT 3-sym = 3.03 (source: validation memory; verify against `experiments/pbo-results-3sym-run20.json` or sibling MC results file at implementation time), F2F gold = 1.41 (`experiments/f2f-validation-results.json` checks array, name "MC Bootstrap Sharpe 5th"), ICT 7-sym = 0.72 (validation memory).
2. **Drawdown breach:** live max drawdown over rolling 90d > 1.5 × validated MaxDD from backtest. Backtest MaxDDs: ICT 3-sym = 63.3%, ICT 7-sym = 80.5%, F2F gold = 15.3%.

A small **`bootstrap-floors.ts`** loader is responsible for reading these values out of the validation JSONs at runtime; if a file or value is missing, the strategy is skipped with a warning rather than failing the whole monitor run. Floor values are NOT duplicated into config — single source of truth is the validation artifact.

Returns a `DecayStatus[]` per strategy with `{ strategy, liveSharpe, bootstrapFloor, liveDD, ddCeiling, tripped: boolean, reason?: string }`.

### `scripts/run-allocator.ts` (~60 LOC)

Wires `equity-source` → `allocator` → JSON write + Telegram alert. Runs weekly (Sundays 00:05 UTC). Output payload includes (a) recommended weights, (b) current per-strategy 60d annualized vol, (c) implied risk-per-trade multiplier vs. each bot's current `riskPerTrade` config, (d) a one-line human action ("no change" vs. "consider reducing crypto from 0.30% → 0.18%").

### `scripts/run-monitor.ts` (~80 LOC)

Wires `equity-source` → `decay-monitor` → JSON write + Telegram alert (only on trip). Runs daily (00:10 UTC). Always writes `data/decay-status.json` for dashboard consumption. Telegram only fires when `tripped: true`, with a debounce (don't re-alert same strategy within 24h of last alert).

### A3 Audit deliverable: `docs/live-paper-audit-2026-05-03.md`

Short note (1 page): what each bot already logs, the cadence, the 90d clock start date (= today, 2026-05-03), and the explicit gap list (if any). Audit is a read-only investigation; any discovered gaps become follow-up tickets, not in-scope here.

## Data flow

**Allocator weekly run:**
1. Load 60d daily returns for each deployed strategy (currently 2: ICT 3-sym crypto, F2F gold).
2. Compute σ_i (annualized stdev of daily returns), then w_i = (1/σ_i) / Σ(1/σ_j).
3. Compute total current risk budget = Σ (current `riskPerTrade_i`) across deployed bots. Today this is `0.3% + 0.3% = 0.6%`. Use this sum (not a hardcoded 0.6%) so the allocator stays correct as bots are added or risk is dialed up/down. Recommended new `riskPerTrade_i = w_i × totalCurrentRiskBudget`.
4. Write JSON, send Telegram. Done.

**Monitor daily run:**
1. Load 30d daily returns + 90d equity series for each strategy.
2. Compute live 30d Sharpe (mean/σ × √252) and live 90d max drawdown.
3. Compare to bootstrap-floor and DD-ceiling from `experiments/`.
4. Write JSON. Telegram alert if any strategy is tripped (with debounce).

## Error handling

- **Cold start (insufficient data):** allocator emits warning, excludes strategy from basket. Monitor skips that strategy.
- **Equity source missing/corrupt:** script logs error, exits with code 1, does not write a stale recommendation. PM2 will restart per existing policy.
- **Bootstrap floor not found in validation file:** monitor skips that strategy with a one-time warning. Spec assumes the three known floors are present.
- **Telegram failure:** non-fatal. JSON write is the source of truth. Alert is best-effort.

## Testing

- **Unit:** `equity-source` against fixture SQLite + JSON files (synthetic 90d data). `allocator` against hand-computed inverse-vol weights for 2- and 3-strategy baskets. `decay-monitor` for both tripwire conditions and the cold-start case.
- **Integration:** end-to-end run of each script in dry-run mode (no Telegram, write to `/tmp/`) against a snapshot of the live bot state.
- **No backtest needed.** This is portfolio infrastructure, not a strategy.

## Migration / rollout

1. Land `equity-source` + tests.
2. Land `allocator` + script + tests. Manual run, eyeball output. Add to PM2 cron.
3. Land `decay-monitor` + script + tests. Manual run. Add to PM2 cron.
4. A3 audit doc. Identify the 90d clock start date.
5. Let it run. Re-evaluate at 30d (sanity), 60d (recommend enforcement design), 90d (commit to enforcement v2 if signal is good).

## Open questions deferred to v2

- **Enforcement mechanism:** how do bots actually consume the recommendation? Read-on-tick from JSON? Hot-reload of config? Separate `effective-risk-per-trade.json`? Decide after 90d when the question has data behind it.
- **Funding-arb integration:** when B1 ships and gets deployed, add `funding-arb` as a 4th `StrategyId`. Equity source needs an adapter for its tracker. Allocator math doesn't change.
- **Correlation upgrade:** at 4+ strategies, switch from inverse-vol to ERC. Adds ~50 LOC and a small numerical solver.
