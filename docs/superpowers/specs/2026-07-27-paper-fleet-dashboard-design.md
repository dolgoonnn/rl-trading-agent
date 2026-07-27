# Paper Fleet Dashboard — Design

**Date:** 2026-07-27
**Status:** Approved (design), pending implementation plan
**Author:** brainstorm session

## Goal

A deployed, read-only web dashboard for the ICT paper-trading fleet now running on
Railway (Singapore). One consolidated "book" view across all live sleeves — crypto
(Run 20, BTC/ETH/SOL), gold F2F (XAUTUSDT), and the metals/session book — plus
book-governance status and data-freshness. The point is at-a-glance answers to
"is it running, what's it holding, how's the equity curve" without SSHing in.

Not a greenfield build: the app already has the Next.js scaffolding, a
`dashboard/live-stats` tRPC router that reads the bot tables, the `bot_*` schema,
Lightweight Charts, and a 626-line `live-trading/page.tsx` (built for the old
single-bot crypto view). This is **rewire + deploy**, not new construction.

## Decisions (from brainstorm)

- **Data access:** UI runs in the **same container** as the fleet, reading the same
  SQLite file + JSON state on the shared volume. (Rejected: Postgres migration —
  big rewrite, better-sqlite3 is synchronous and deeply wired, risks the working
  fleet. Rejected: local-only UI — can't see live Railway state.)
- **Scope:** **Consolidated book** across all sleeves (not crypto-only).
- **Controls:** **View-only v1.** No kill-switch/halt controls, no auth. Safe on an
  open Railway URL because it is paper-only and read-only. Controls + auth are a
  later, separate decision.
- **RAM:** bump the Railway machine to **2 GB** (5 bots + Next.js prod server).
- **Exposure:** open URL, no access token (read-only, paper).

## Architecture

### Deployment — UI as a non-core 6th process

Next.js runs as a sixth process inside the existing fleet container
(`scripts/docker-entrypoint.sh`), launched after the bots and treated as
**non-core**: mirrors the orderflow collector — if the UI dies, the supervisor
logs a warning and the bots keep trading; the UI death does NOT trip the
container restart. It reads `/app/data/ict-trading.db` and the gold/metals JSON
state on the shared volume. Railway exposes it on `$PORT` → public URL.

- **Dockerfile:** add `pnpm build` (`next build`) in the build stage. Entrypoint
  adds `next start -p ${PORT:-3000}` as a non-core background job.
- **Railway:** enable public networking (Railway auto-detects the listening port;
  add a generated domain). Machine → `shared-cpu-1x` @ **2 GB**.
- **Concurrency (the one real technical gotcha):** two `better-sqlite3` connections
  to one file — the bots (writer) and the UI (reader). To avoid
  `SQLITE_BUSY / database is locked`, the bot's DB connection MUST run in **WAL
  mode** (`PRAGMA journal_mode=WAL`), which allows a concurrent reader alongside
  the writer, and the UI opens the DB **read-only** (`readonly: true`). Verifying/
  enabling WAL on the bot connection is part of this work. Also set a `busy_timeout`
  on the UI connection as a belt-and-suspenders measure.

### Data layer — one read-only tRPC router `dashboard.book`

Reuses `src/lib/bot/track-record.ts` (`summarizeSleeve`, `combineSleeves`,
`partitionByHoldCap`) — the exact three-store consolidation that
`scripts/track-record-status.ts` already performs. Sources:

- **Crypto:** `bot_trades`, `bot_positions` (status = open), `bot_equity_snapshots`
  (Run 20 strategy/symbols).
- **Gold:** `bot_trades` where `strategy = 'f2f_gold'` + `data/gold-bot-state.json`
  (current equity, open position).
- **Metals:** `data/metals-bot-state.json` (trades[], open legs; honors the `stale`
  flag from `metals-stale.ts`).
- **Governance:** `data/book-governance.json` (WATCH / BREACH status).

Endpoints (all `publicProcedure`, read-only):

- `book.overview` → total equity, total open-position count, aggregate stats
  (trades, win rate, net PnL, current drawdown), per-sleeve summary rows,
  governance status, data-freshness (latest candle ts / last tick per sleeve).
- `book.equityCurve` → combined + per-sleeve equity series for the chart.
- `book.positions` → all open positions across sleeves.
- `book.trades` → recent closed trades, paginated, sleeve-tagged.

The existing `live-stats.byScoreBucket` router stays and can back an optional
confluence-analytics panel later; not required for v1.

### UI — rebuild `live-trading/page.tsx` as the consolidated book

Single page, sections top-to-bottom:

1. **Header:** total equity, today's PnL, open-position count, data-freshness
   badge, governance badge (WATCH/BREACH).
2. **Equity curve:** Lightweight Charts, combined line with per-sleeve toggle.
3. **Open positions table:** all sleeves (symbol, direction, entry, size,
   unrealized PnL), sleeve-tagged.
4. **Recent trades table:** across sleeves, sleeve-tagged, paginated.
5. **Per-sleeve cards:** crypto / gold / metals — equity, trades, win rate, net
   PnL, status string (e.g. "regime-suppressed", "halted", "flat").

Client polls every **30s** via tRPC `refetchInterval`. Data changes hourly
(crypto) / daily (gold), so polling is ample — no websockets.

## Error handling & empty state

- Per-sleeve read failure → router returns `{ available: false, reason }` for that
  sleeve; UI renders "no data / unreachable" instead of crashing (mirrors the
  existing `live-stats` `available` pattern). One dead sleeve never blanks the page.
- **Empty book (the state today):** flat $10,000 baseline + "0 trades yet" — a
  valid state, not an error.
- UI process crash is non-fatal to the bots (non-core supervision).

## Testing

- **Red-Green unit tests** for the `dashboard.book` aggregation against a seeded
  fixture SQLite DB + sample gold/metals JSON states: assert overview totals,
  per-sleeve split, empty-book case, and shutdown-artifact handling. Reuse/extend
  any existing `track-record.ts` tests.
- **Deploy gate:** `pnpm typecheck` + `pnpm lint` + `next build` must pass.

## Out of scope (v1)

Kill-switch / halt controls, authentication, alert-configuration UI, backtest
browser. Knowledge-base and flashcards pages already exist and are untouched.

## Risks

- **WAL not enabled on the bot connection** → UI reads could hit `database is
  locked`. Mitigation: enable WAL + read-only UI connection + busy_timeout
  (above). This is the top implementation risk and gets verified first.
- **Memory pressure** (5 bots + Next.js on one machine). Mitigation: 2 GB machine;
  Next.js runs prod (`next start`), not dev.
- **Open URL** exposes paper positions/equity publicly to anyone with the link.
  Accepted for v1 (paper, read-only). Revisit if controls are ever added.
