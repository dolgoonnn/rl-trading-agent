# ICT Decision-Support Dashboard — v1 (personal, localhost)

**Date:** 2026-05-10
**Scope:** Path 3 from the project-plateau brainstorm. A read-only Next.js dashboard for the project owner's daily ICT trading workflow, surfacing the existing engines (regime-detector, ICT pattern detectors, signal-engine, validated stats, path A's decay monitor) without modifying any of them.
**Out of scope:** Multi-user / auth / billing / public deployment, real-time WebSocket data feed, trade journaling, alert delivery UI, mobile, dark/light theme toggle, settings/preferences. Most of these are reasonable v2/v3 — none are v1.

---

## Why

The codebase has every analytical piece needed for live ICT decision support — pattern detectors, regime classifier, confluence scorer, signal-engine — but it is all consumed by an autopilot bot and never surfaced to the human. The owner has hit a research-yield plateau (path A shipped a portfolio allocator + decay monitor; path B validated funding-arb at 5/5; path B-2 found no parameter-tune room). The next leverage is consumption, not production: a ~1-week dashboard that turns 3 already-validated edges plus the ICT detection library into a daily workflow tool.

The differentiator over TradingView, ICT Index, ICTPro Tools, and TradingView Pine Script suites is *validated win rates surfaced live* — none of those tools have rigorous PBO/DSR/MC validation behind their pattern detection.

## Goals

1. **HTF Bias Grid** at `/` — 3 symbols × 3 timeframes — answer "where am I directionally biased right now?" in 30 seconds.
2. **Setup Cards** at `/setup/[symbol]` — render active OBs/FVGs/liquidity with confluence breakdown and *validated win-rate badges* sourced from existing `experiments/*-validation-results.json` artifacts.
3. **Decay awareness** — every setup card surfaces whether the underlying strategy is currently tripped per path A's `data/decay-status.json`. Yellow badge if so. *No competitor does this.*
4. **Zero regressions** — bot, backtest, ICT detectors, alerts, and existing scripts continue working unchanged.

## Non-goals

- No new ICT detection logic. The dashboard is a consumer.
- No WebSocket layer. Tick-fresh data is unnecessary for a 30s-poll-tolerant decision tool. WS is a v2 concern.
- No multi-tenancy or auth. v1 binds to `localhost`.
- No write paths. Dashboard issues no orders, mutates no bot state.
- No mobile responsiveness beyond what flows naturally from Next.js + sensible CSS. Desktop-first.
- No theme toggle. One color scheme.
- No PM2 entry. The user runs `pnpm dev` when they want it.

---

## Architecture

Three layers, two of which already exist:

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (Next.js App Router pages, lightweight-charts)     │
│   - / (BiasGrid)                                            │
│   - /setup/[symbol] (chart + setup cards + stats)           │
└──────────────────────────────┬──────────────────────────────┘
                               │ tRPC queries
┌──────────────────────────────▼──────────────────────────────┐
│  NEW: tRPC routers in src/server/trpc/dashboard/            │
│   - bias.scan(symbols, tfs)                                 │
│   - setups.live(symbol, tf)                                 │
│   - stats.byPattern()                                       │
│   - decay.status()                                          │
│   - candles.recent(symbol, tf, n)                           │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│  EXISTING: untouched                                        │
│   - src/lib/ict/* (regime-detector, OBs, FVGs, structure)   │
│   - src/lib/bot/signal-engine.ts                            │
│   - data/app.db (bot's candle cache)                        │
│   - experiments/*-validation-results.json                   │
│   - data/decay-status.json (path A decay monitor output)    │
└─────────────────────────────────────────────────────────────┘
```

**Boundary discipline:** every router function is a thin adapter. It loads cached input, calls an existing detector, and returns a JSON-shaped response. No router contains analytical logic. If a feature appears to need new analytical logic, it doesn't belong in this v1.

## Components

### tRPC routers (5 new files, ~50–80 LOC each)

- `src/server/trpc/dashboard/bias.ts` — `bias.scan(input: { symbols: string[]; timeframes: ('1H'|'4H'|'1D')[] })` returns `{ symbol, timeframe, regime, volRegime, lastUpdated }[]`. Internally calls `detectRegime()` per (symbol, tf) over the most recent N=200 cached candles.
- `src/server/trpc/dashboard/setups.ts` — `setups.live(input: { symbol: string; timeframe: '1H' })` returns active OBs / FVGs / liquidity sweeps with confluence score breakdown. Internally invokes the same `signal-engine.ts` path the bot uses, but returns the full enriched setup objects instead of trade orders.
- `src/server/trpc/dashboard/stats.ts` — `stats.byPattern()` reads three known artifact paths in order:
  1. `experiments/pbo-results-3sym-run20.json` → `ict-3sym` (WR 56.3%, Sharpe 7.66 per memory of record)
  2. `experiments/f2f-validation-results.json` → `f2f-gold` (WR 39.3%, Sharpe 2.08 per memory)
  3. `experiments/funding-arb-validation-results.json` → `funding-arb` (path B output, Sharpe 2.11)
  Each file has a different JSON shape — parser dispatches by filename. Returns a flat map keyed by strategy ID with `{ winRate, totalTrades, sharpe, deflatedSharpe, source: 'experiments/<file>' }`. Fallback constants used only if a file is unparseable; missing files cause the strategy entry to be omitted (UI surfaces "stats unavailable" badge, see Error handling).
- `src/server/trpc/dashboard/decay.ts` — `decay.status()` reads `data/decay-status.json` (path A's daily output). Returns `{ generatedAt, statuses: DecayStatus[] }`. If the file is missing, returns `{ available: false }` rather than throwing.
- `src/server/trpc/dashboard/candles.ts` — `candles.recent(input: { symbol; tf; n })` reads from `data/app.db`. Returns `Candle[]` for the chart.

All five register through the existing tRPC root router (`src/lib/trpc` or wherever the project's appRouter lives — verified at implementation time).

### UI components (6 new files in `src/components/dashboard/`)

- `BiasGrid.tsx` — table layout, rows = symbols, columns = timeframes. Polls `bias.scan` via tRPC's `useQuery({ refetchInterval: 30000 })`. Loading + error states.
- `BiasBadge.tsx` — small pill: regime label + vol regime + a colored dot.
- `SetupCard.tsx` — composite card showing setup type, confluence score breakdown (factor → contribution), validated WR badge, decay badge.
- `DecayBadge.tsx` — single-element badge (green / yellow / unknown).
- `SetupChart.tsx` — `lightweight-charts` wrapper rendering N=300 1H candles plus markers for active OBs (rectangles), FVGs (rectangles), liquidity levels (horizontal lines). Reuses `lightweight-charts` (already a dependency).
- `StatsBadge.tsx` — small pill with WR% and trade-count tooltip on hover.

### Pages (2 new files)

- `src/app/page.tsx` — landing page. Renders `<BiasGrid>` only. No nav, no header beyond a tiny title strip with current UTC time.
- `src/app/setup/[symbol]/page.tsx` — drill-down. Header: symbol + 1H/4H/1D tab switcher (purely cosmetic in v1; only 1H wired to setups). Body: `<SetupChart>` on top, `<SetupCard>` list below.

## Data flow

**Landing page open:**
1. `BiasGrid` mounts. Fires `bias.scan({ symbols: ['BTCUSDT','ETHUSDT','SOLUSDT'], tfs: ['1H','4H','1D'] })`.
2. tRPC router opens `data/app.db` read-only, pulls last 200 candles per (symbol, tf), runs `detectRegime()`, returns 9 cells.
3. UI renders 3×3 grid with regime + vol badges. Auto-refresh every 30s via `refetchInterval`.

**Setup page open (`/setup/BTCUSDT`):**
1. Page mounts and fires four tRPC queries in parallel:
   - `candles.recent({ symbol: 'BTCUSDT', tf: '1H', n: 300 })`
   - `setups.live({ symbol: 'BTCUSDT', tf: '1H' })`
   - `stats.byPattern()`
   - `decay.status()`
2. `SetupChart` renders candles + OB/FVG/liquidity markers from the `setups.live` response.
3. Each `SetupCard` correlates its setup type with a strategy ID (e.g., setup produced by Run 20 confluence scorer → strategy `ict-3sym`), looks up `stats.byPattern()['ict-3sym']`, renders the badge.
4. `DecayBadge` looks up the same strategy in `decay.status()`. If `tripped: true`, yellow.
5. No auto-refresh on setup page in v1; user manually reloads. Avoids the complexity of differential chart updates.

## Error handling

| Failure | Behavior |
|---|---|
| Bot DB missing / empty cache | Grid shows "no data — bot not running?" per cell. Setup page shows blank chart with placeholder. |
| Specific (symbol, tf) detector throws | That cell shows red error state with the message. Other cells continue rendering. |
| `experiments/*-validation-results.json` missing | Setup card shows "validated stats unavailable" instead of WR badge. No throw. |
| `data/decay-status.json` missing | No decay badge rendered (silent skip). |
| tRPC network failure on poll | Last-known data stays on screen. A small "stale (last update Xm ago)" indicator appears. No retries, no toasts. |
| User navigates to `/setup/INVALID` | Page renders "symbol not in cache" message, link back to `/`. |

No retries. No exponential backoff. No auth. localhost only.

## Testing

- **`stats.ts` parser:** vitest unit test against fixture validation JSONs (the F2F shape + funding-arb shape are known). 4-6 tests covering happy path, missing file, malformed file, missing field.
- **`decay.ts` parser:** similar — happy, missing, malformed.
- **`bias.ts` integration:** vitest test using an in-memory better-sqlite3 fixture DB seeded with synthetic candles, asserting the regime classification flows through correctly. 2-3 tests.
- **`setups.ts` integration:** test that the router returns the same shape `signal-engine.ts` produces, given a fixture candle series. 1-2 tests.
- **`candles.ts`:** 1 trivial test that the SQL pulls back the last N rows ordered correctly.
- **No React component tests.** UI rendering correctness is verified by the user opening the page. Re-evaluate this call if a UI bug ships.
- **Integration check at the end:** `pnpm dev`, open both pages, confirm real data renders.

## Migration / rollout

1. Land tRPC routers + tests.
2. Land UI components + pages.
3. `pnpm dev`. Open `/`. Confirm grid renders for all 3 symbols.
4. Click each symbol → confirm setup page renders.
5. **Use it for a week** as the first morning chart-check. No further work in week 1.
6. After a week, decide whether to invest in v2 (alerts, multi-symbol expansion, journal) based on whether you actually opened it daily.

## Open questions deferred to v2+

- WebSocket data feed for tick-fresh updates. Cost: ~1 week of WS engineering. Trigger: only build when 30s poll feels too stale during real use.
- Multi-symbol expansion (forex, gold). Forex data is already downloaded; gold has its own daily-bar bot. Adapters needed but trivial. Trigger: once the v1 grid is daily-used.
- Setup alert routing into Telegram. The infrastructure exists (`AlertManager`). A toggle on each `SetupCard` ("alert me when this triggers") plus a server-side watcher would close the loop. Trigger: when you find yourself wanting alerts on patterns you're not actively watching.
- Trade journal entry that pre-fills from a clicked setup. Real product work. Trigger: only after you've used v1 for a while and identified specific journal needs.
- React component tests. Trigger: first UI regression bug.
- Auth and remote deploy. Trigger: ever inviting another user.
