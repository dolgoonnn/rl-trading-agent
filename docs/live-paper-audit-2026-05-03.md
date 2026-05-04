# Live-Paper Audit — 2026-05-03

## Purpose
Document what the deployed bots already log, the cadence, the 90-day clock start date, and any gaps that the allocator/monitor depend on.

## 90-day clock starts: 2026-05-03
Re-evaluate enforcement design at 2026-08-01 (90 days).

---

## Crypto bot (`scripts/run-bot.ts` → `src/lib/bot/...`)

### `bot_equity_snapshots`
| Column | Type |
|---|---|
| id | integer PK autoincrement |
| timestamp | integer (epoch ms) |
| equity | real |
| peakEquity | real |
| drawdown | real |
| openPositions | integer |
| dailyPnl | real |
| cumulativePnl | real |

**Write cadence:** on bot start, on bot stop/shutdown, and after every trade close (per `position-tracker.ts` lines 255, 305, 621). The main tick loop runs every 30 seconds but does NOT write a snapshot on each tick — only on trade events and lifecycle events. No snapshot is written on a tick that produces no trade activity.

**Retention:** unbounded — no DELETE or prune logic exists in `position-tracker.ts` or `run-bot.ts`.

### `bot_trades`
| Column | Type |
|---|---|
| id | text PK |
| symbol | text |
| direction | text |
| entryPrice, exitPrice | real |
| entryTimestamp, exitTimestamp | integer (epoch ms) |
| stopLoss, takeProfit | real |
| positionSizeUSDT, riskAmountUSDT | real |
| strategy | text |
| confluenceScore | real |
| factorBreakdown | text (JSON) |
| regime | text |
| exitReason | text |
| barsHeld | integer |
| pnlPercent, pnlUSDT | real |
| equityAfter | real |
| drawdownFromPeak | real |
| createdAt | integer (epoch ms) |

**Write cadence:** one insert per closed trade.

**Retention:** unbounded — no pruning.

**Per-trade attribution to strategy:** YES — `strategy` column present (e.g. `"order_block"`).

**Per-trade regime tag:** YES — `regime` column present (e.g. `"uptrend+high"`).

### `bot_state`
Single row (id=1), updated on every `saveState()` call — after position open/close and at startup/shutdown. Stores aggregate counters (equity, peakEquity, totalTrades, dailyPnl, weeklyPnl, consecutiveLosses) plus JSON blobs (circuitBreakers, lastProcessedTimestamp, recentErrors).

### `bot_positions`
One row per position (open or closed). Written on `addPosition`; updated on partial TP and close. Includes `strategy` and `regime` columns matching `bot_trades`.

---

## Gold bot (`scripts/run-gold-bot.ts`)

- **State file:** `data/gold-bot-state.json`
- **Fields:**

| Field | Type | Description |
|---|---|---|
| equity | number | Current equity in USD |
| initialCapital | number | Starting capital |
| position | object \| null | Active position (entryPrice, entryTimestamp, weight, hardStop, trailingStop, peakPrice, daysHeld, pBullAtEntry, atrAtEntry) |
| trades | array | All completed trade records |
| lastTickTimestamp | number | Unix ms of last processed daily bar |
| rolling30dReturns | number[] | Per-day returns, capped at 90 entries |
| startedAt | number | Bot launch epoch ms |

- **Update cadence:** once per day — after each daily bar close (~00:05 UTC). State is saved after every tick (`saveState(state)` at line 520), which fires once per 24 hours in the main loop.

- **Trade retention:** unbounded — `trades` array grows with every closed trade, no cap or pruning. The full trade history is preserved in the JSON file.

- **Rolling returns retention:** bounded at 90 entries (`rolling30dReturns.slice(-90)`), sufficient for rolling 90d equity reconstruction.

---

## Gaps (relative to allocator + monitor needs)

- [ ] **Crypto bot equity snapshots are sparse (event-driven, not time-series).** Snapshots are written only at trade close and lifecycle events — NOT on every hourly bar. In quiet periods with no trades, there may be gaps of many hours. The monitor's `getRollingSharpe()` auto-detects the average interval and annualizes accordingly, which is correct but means Sharpe is only as fresh as the last trade event. **Mitigation:** acceptable for a low-frequency strategy (~2-3 trades/week per symbol); no code fix needed at this stage.

- [ ] **`bot_equity_snapshots` has no bot/strategy identifier.** The table records aggregate equity across all symbols with no column to split by strategy. If a second crypto strategy is added, the combined equity curve becomes unattributable. **Mitigation:** documented gap; fix required before deploying a second concurrent crypto strategy.

- [ ] **Gold bot has no 90-day equity time-series.** The monitor reconstructs gold's 90-day equity backwards from `rolling30dReturns` (90 entries max). This is an approximation — it works as long as the bot has been running continuously, but a restart from a fresh state file loses history before `startedAt`. **Mitigation:** the monitor was already updated (commit 41f0252) to bound the array and guard against short windows. Reconstruction is sound for the current single-strategy deployment.

- [ ] **Gold bot trades array is unbounded but JSON-serialized.** After years of operation the JSON file will grow, but at ~8 trades/month this is negligible (< 1 KB/year of trade records). No action needed at this horizon.

- [ ] **No cross-bot equity normalization.** The allocator computes weights from Sharpe ratios derived from each bot's independent equity series. There is no shared clock or synchronized equity snapshot across crypto and gold. Both bots operate on different cadences (30s vs 24h), so joint portfolio metrics (correlation, combined drawdown) cannot be computed directly. **Mitigation:** documented; acceptable for current two-strategy deployment. Revisit when a third strategy is added.

---

## Sign-off

Bot logging is sufficient for A1 (allocator) and A2 (monitor) on the 2 currently deployed strategies (ICT order-block crypto, F2F gold), with the following specific approximations noted above: (1) crypto equity Sharpe computed from sparse event-driven snapshots rather than a regular time-series, and (2) gold 90-day equity reconstructed from `rolling30dReturns` rather than a stored equity curve. Re-audit when ICT 7-sym or funding-arb deploy — both gaps #2 (strategy identifier) and #5 (cross-bot normalization) will become blocking at that point.
