# Dashboard Detail & Analytics (v2) — Design

**Date:** 2026-07-28
**Status:** Approved (design), pending implementation plan
**Predecessor:** [2026-07-27 paper-fleet dashboard](2026-07-27-paper-fleet-dashboard-design.md) (shipped, live)

## Goal

Make every trade inspectable "in detail". The v1 book shows summary tables; the
bots already persist far richer per-trade data that the UI discards. This adds
(a) a click-through detail panel per trade/position, and (b) four analytics
surfaces: underwater drawdown, performance stats, dimensional breakdowns, and
cost/friction analysis.

This is a **surfacing + drill-down** job. No new data capture, no schema changes.

## Research basis

UX research on trading dashboards converged on progressive disclosure:
summary KPIs first, detail on demand; advanced metrics beyond win rate
(profit factor, expectancy, R-multiple, Sharpe/Sortino, max drawdown);
and — the strongest single recommendation — overlaying an **underwater
drawdown curve with a hard halt line**, because a plain equity curve hides
drawdown depth and duration. Sources:
- https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards
- https://www.uxpin.com/studio/blog/dashboard-design-principles/
- https://www.fortraders.com/blog/best-trade-journals-analytics-tools
- https://tradingwyckoff.com/en/algorithmic-trading/algorithmic-trading-metrics/
- https://journalplus.co/learn/guides/trading-performance-dashboard-guide/

## Data reality (drives the design)

Verified against the live stores:

| Sleeve | Per-trade detail available |
|---|---|
| **crypto** (`bot_trades`) | RICH: `confluence_score`, `factor_breakdown` (13-factor JSON), `stop_loss`, `take_profit`, `risk_amount_usdt`, `regime`, `bars_held`, `exit_reason`, `gross_return`, `friction_return`, `funding_return`, `net_return`, `funding_paid_usdt`, `equity_after`, `drawdown_from_peak` |
| **metals** (JSON) | THIN: `leg, metal, side, entryPrice, exitPrice, entryTime, exitTime, pnlPct` only |
| **gold** (JSON) | No closed trades yet; shape mirrors metals when it books |

**Consequence:** detail richness is a **per-sleeve capability**, not an
assumption. The panel renders what exists and omits what does not — it must
never show an empty "N/A" grid for metals. Crypto-only sections (confluence
chart, PnL waterfall, R-multiple) are hidden for thin sleeves, with a short
"limited detail for this sleeve" note.

`bot_equity_snapshots` has 637 rows carrying `peak_equity` + `drawdown`
already — the underwater curve is a direct read, not a recomputation.

**Reuse, do not reinvent:** `src/lib/rl/utils/` already exports
`calculateMaxDrawdown`, `calculateSharpeRatio`, `calculateSortinoRatio`.
Use them. Only genuinely new maths (profit factor, expectancy, avg R,
grouped breakdowns) goes in the new module.

## Architecture

Same layering as v1: pure logic → readers → read-only tRPC → components.

- **`src/lib/bot/trade-analytics.ts` (NEW, pure, no I/O):** profit factor,
  expectancy, avg win/loss, avg R-multiple, and the grouping helpers for
  breakdowns. Pure so it is unit-testable without a DB.
- **Readers** (extend `src/lib/bot/sleeve-readers.ts`): `readTradeDetail(id)`,
  `readDrawdownCurve()`, plus a `readAllTradesForStats()` feeding the analytics.
  Same resilience contract as v1: missing file/table → safe defaults, never throw.
- **Router** (extend `dashboard.book`): five new procedures, all `query`,
  all read-only, no mutations:
  - `tradeDetail({ id })` → one fully-decomposed trade, or `{ found: false }`
  - `stats()` → profit factor, expectancy, avg win/loss, avg R, max DD, Sharpe, Sortino, `n`
  - `breakdowns()` → grouped by exit reason / regime / symbol / confluence bucket
  - `costs()` → gross vs net totals, total friction, funding paid per symbol
  - `drawdownCurve()` → `{ timestamp, equity, drawdown }[]` from snapshots
- **UI:** a slide-over **detail drawer** (click a row in the existing trades or
  positions table), an **underwater subplot** added to the equity chart, and a
  **stats panel**, **breakdown tables**, and **cost panel** on the book page.

`factor_breakdown` is stored as a JSON *string*; parsing is done in the reader
inside a try/catch that yields `null` on malformed input — never propagates.

## The honesty guard (non-negotiable)

The live book has ~3 closed trades. Ratios like profit factor and Sharpe are
meaningless at that sample size and a precise-looking number invites false
confidence — the exact failure mode this project has already been burned by
(see the DSR inflation episode).

Therefore:
- Every stat renders **with its `n`** (trade count).
- Below **20 trades**, the stats panel and any breakdown bucket renders a
  **"needs ≥20 trades to be meaningful"** notice **instead of** the computed
  ratio. The underlying value is still returned by the API (for later use), but
  the UI refuses to present it as if it were reliable.
- Breakdown rows always show their bucket count so a 1-trade bucket cannot be
  misread as a pattern.

## Error handling

- Malformed `factor_breakdown` JSON → detail panel renders without the
  confluence chart; no crash.
- Unknown/absent trade id → `{ found: false }` → drawer shows "trade not found".
- Empty book → every panel shows its empty state (this is today's real state).
- Missing table/file (partial schema, fresh volume) → guarded reads returning
  empty, consistent with v1's `tableExists` pattern.

## Testing

- Red-green unit tests for `trade-analytics.ts` against fixture trades with
  hand-computed expected values (profit factor, expectancy, avg R, each
  grouping), including the zero-trade and all-losses (division-by-zero) cases.
- Reader tests for `readTradeDetail` covering: rich crypto trade, thin metals
  trade, malformed `factor_breakdown`, and unknown id.
- Router tests for the new procedures on a seeded temp DB.
- `pnpm typecheck` + `pnpm build` gate the deploy. Vitest env is `node` — no
  React render tests; UI verified by build + live smoke.

## Out of scope (v2)

Filters and date-range pickers, CSV export, customizable widget layout,
mobile-specific redesign, and any write/control capability (the dashboard
stays strictly view-only, all procedures `query`).

## Risks

- **Over-reading tiny samples** — mitigated by the honesty guard above.
- **Sleeve asymmetry** rendering badly — mitigated by capability-based
  rendering rather than a fixed grid.
- **Payload size:** `stats`/`breakdowns` read all trades. Trivial at current
  volume; revisit (aggregate in SQL) only if trade count reaches thousands.
