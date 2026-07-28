# Dashboard Detail & Analytics (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every trade inspectable — a click-through detail drawer per trade plus four analytics surfaces (underwater drawdown, performance stats, dimensional breakdowns, cost/friction) on the live paper-fleet dashboard.

**Architecture:** Same layering as v1 — pure logic (`trade-analytics.ts`) → resilient readers (`sleeve-readers.ts`) → read-only tRPC procedures on the existing `dashboard.book` router → client components. No schema changes, no new data capture; this surfaces data the bots already persist.

**Tech Stack:** Next.js 15/16 App Router, TypeScript strict, tRPC + @trpc/react-query, better-sqlite3 (read-only), Lightweight Charts v5, Tailwind v4, vitest.

## Global Constraints

- Language: all code/comments/docs in English.
- No `any` / `as any`. Use proper narrowing or `unknown`.
- `noUncheckedIndexedAccess` is ON: never assert `arr[i].field`; guard with `toHaveLength(...)` + optional chaining (`arr[i]?.field`). No non-null `!`.
- Tests live under `tests/**/*.test.ts` (vitest `include` is `tests/**/*.test.ts`, `environment: 'node'`). Do NOT colocate tests in `src/`. Env is **node, not jsdom** — no React render tests; UI is verified by `pnpm build` + live smoke.
- Commit ONLY with `gmp "message" type scope` (never raw `git commit`). `gmp` is a shell function — invoke as `zsh -ic 'gmp "msg" feat backend'` (a `zle`/`can't change option` warning line is harmless; verify with `git log --oneline -1`).
- Branch is `ftr/dashboard-detail-analytics` (already created). Do NOT switch branches.
- ALL new tRPC procedures are `query` — the dashboard is strictly view-only. No mutations, ever.
- Readers are resilient: missing DB file, missing table, or unreadable/malformed JSON → safe empty defaults, NEVER throw. Guard every table query with the existing `tableExists(db, name)` helper.
- **Reuse, do not reinvent:** `calculateMaxDrawdown(returns: number[]): number`, `calculateSharpeRatio(returns: number[], ...)`, `calculateSortinoRatio(returns: number[], ...)` are exported from `src/lib/rl/utils/gt-score.ts`. Import them; do not write new versions.
- **Honesty guard:** `MIN_TRADES_FOR_STATS = 20`. The API always returns computed values plus `n`; the **UI** must refuse to render ratio-style stats below that threshold, showing "needs ≥20 trades to be meaningful" instead. Every breakdown row shows its bucket count.
- Sleeve detail is a **capability, not an assumption**: crypto trades are rich, metals/gold trades are thin (`leg, metal, side, entryPrice, exitPrice, entryTime, exitTime, pnlPct` only). Render what exists; never show an empty N/A grid.
- KNOWN FALSE ALARM: the editor LSP emits STALE "cannot find module" / "implicitly any" diagnostics on newly created files. The authority is `pnpm typecheck` filtered to touched files. The repo has a KNOWN dirty typecheck baseline (~227 pre-existing errors in `scripts/**` + `src/lib/rl/**` + `src/lib/bot/alerts.ts` + `src/lib/ict/regime-detector.ts`) — ignore those; only errors in files YOU touch count.

---

## File Structure

**New:**
- `src/lib/bot/trade-analytics.ts` — pure metrics + grouping (profit factor, expectancy, avg win/loss, avg R, bucket helpers). No I/O.
- `src/components/live-trading/TradeDetailDrawer.tsx` — slide-over panel: confluence bars, PnL waterfall, levels/R, meta.
- `src/components/live-trading/StatsPanel.tsx` — performance stats with the honesty guard.
- `src/components/live-trading/BreakdownTables.tsx` — grouped by exit reason / regime / symbol / confluence bucket.
- `src/components/live-trading/CostPanel.tsx` — gross vs net, friction, funding per symbol.
- `tests/bot/trade-analytics.test.ts`, and new cases appended to `tests/bot/sleeve-readers.test.ts` and `tests/trpc/book-router.test.ts`.

**Modified:**
- `src/lib/bot/sleeve-readers.ts` — add `id` to `ClosedTrade`; add `readTradeDetail`, `readAllTradesForStats`, `readDrawdownCurve`.
- `src/lib/trpc/routers/dashboard/book.ts` — add `tradeDetail`, `stats`, `breakdowns`, `costs`, `drawdownCurve`.
- `src/components/live-trading/RecentTradesTable.tsx` — rows become clickable, open the drawer.
- `src/components/live-trading/EquityCurveChart.tsx` — add underwater drawdown subplot + −10% halt line.
- `src/app/live-trading/page.tsx` — mount the new panels.

---

## Task 1: Give every trade a stable id

`ClosedTrade` currently has no identifier, so a drawer cannot address a row. Crypto rows have a DB `id`; gold/metals JSON trades have none and need a deterministic synthetic key.

**Files:**
- Modify: `src/lib/bot/sleeve-readers.ts`
- Test: `tests/bot/sleeve-readers.test.ts` (append)

**Interfaces:**
- Produces: `ClosedTrade` gains `id: string`. Crypto → the `bot_trades.id` value. Gold → `gold:<exitTimestamp>`. Metals → `metals:<leg>:<exitTimestamp>`. Ids are stable across reads (no randomness, no array index).

- [ ] **Step 1: Write the failing test** (append to the existing file)

```ts
describe('trade ids', () => {
  it('exposes the crypto DB id and synthesises stable ids for json sleeves', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT,
        entry_timestamp INTEGER, exit_timestamp INTEGER, pnl_percent REAL, pnl_usdt REAL, exit_reason TEXT);
      INSERT INTO bot_trades VALUES ('abc-123','BTCUSDT','short',1,500,0.5,1.2,'take_profit');
    `);
    db.close();
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [{ leg: 'overnight_au', entryTime: '2026-07-01T00:00:00Z', exitTime: '2026-07-01T09:00:00Z', pnlPct: 1 }],
    }));
    const trades = readRecentTrades(10, dir);
    const crypto = trades.find((t) => t.sleeve === 'crypto');
    const metals = trades.find((t) => t.sleeve === 'metals');
    expect(crypto?.id).toBe('abc-123');
    expect(metals?.id).toBe(`metals:overnight_au:${Date.parse('2026-07-01T09:00:00Z')}`);
    // Stable across repeated reads.
    expect(readRecentTrades(10, dir).find((t) => t.sleeve === 'metals')?.id).toBe(metals?.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bot/sleeve-readers.test.ts`
Expected: FAIL — `id` does not exist on `ClosedTrade` / is `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/bot/sleeve-readers.ts`, add `id: string;` as the first field of `interface ClosedTrade`. In `readRecentTrades`:
- crypto: add `id` to the SELECT column list (`SELECT id, symbol, direction, ...`), widen the row cast with `id: string`, and set `id: r.id` in the pushed object.
- gold: `id: \`gold:${t.exitTime ? Date.parse(t.exitTime) : 0}\``
- metals: `id: \`metals:${t.leg ?? 'metals'}:${t.exitTime ? Date.parse(t.exitTime) : 0}\``

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/bot/sleeve-readers.test.ts`
Expected: PASS (all cases, including the pre-existing ones).

- [ ] **Step 5: Verify no new type errors**

Run: `pnpm typecheck 2>&1 | grep -E "sleeve-readers|RecentTradesTable|book"`
Expected: prints NOTHING.

- [ ] **Step 6: Commit**

```bash
zsh -ic 'gmp "add stable ids to closed trades" feat backend'
```

---

## Task 2: Pure trade analytics module

**Files:**
- Create: `src/lib/bot/trade-analytics.ts`
- Test: `tests/bot/trade-analytics.test.ts`

**Interfaces:**
- Produces:
  - `export interface AnalyticsTrade { pnlPct: number; pnlUsdt: number | null; riskAmountUsdt: number | null; exitReason: string | null; regime: string | null; symbol: string; confluenceScore: number | null }`
  - `export interface PerfStats { n: number; profitFactor: number | null; expectancy: number; avgWin: number; avgLoss: number; avgR: number | null; winRate: number }`
  - `export function computePerfStats(trades: AnalyticsTrade[]): PerfStats`
  - `export interface BreakdownRow { key: string; n: number; netPnlPct: number; winRate: number }`
  - `export function groupBy(trades: AnalyticsTrade[], keyOf: (t: AnalyticsTrade) => string): BreakdownRow[]` — rows sorted by `n` descending; a null/absent key becomes `'unknown'` inside `keyOf` (callers supply the fallback).
  - `export function confluenceBucket(score: number | null): string` — `'<3'`, `'3-4'`, `'4-5'`, `'5-6'`, `'6+'`, or `'unknown'` for null.
  - `export const MIN_TRADES_FOR_STATS = 20`

Semantics (exact, so tests and impl agree):
- `profitFactor` = sum of positive `pnlPct` ÷ absolute sum of negative `pnlPct`. **`null`** when there are no losses (division by zero) or no trades — never `Infinity`.
- `expectancy` = mean of `pnlPct` over all trades; `0` when empty.
- `avgWin` = mean `pnlPct` of winners (`> 0`), `0` if none. `avgLoss` = mean `pnlPct` of losers (`< 0`), `0` if none (stays negative).
- `avgR` = mean of `pnlUsdt / riskAmountUsdt` over trades where BOTH are non-null and `riskAmountUsdt > 0`; **`null`** if no such trade.
- `winRate` = winners ÷ n; `0` when empty.

- [ ] **Step 1: Write the failing test**

```ts
// tests/bot/trade-analytics.test.ts
import { describe, it, expect } from 'vitest';
import {
  computePerfStats, groupBy, confluenceBucket, MIN_TRADES_FOR_STATS,
  type AnalyticsTrade,
} from '../../src/lib/bot/trade-analytics';

function t(over: Partial<AnalyticsTrade> = {}): AnalyticsTrade {
  return { pnlPct: 0, pnlUsdt: null, riskAmountUsdt: null, exitReason: null, regime: null, symbol: 'BTCUSDT', confluenceScore: null, ...over };
}

describe('computePerfStats', () => {
  it('computes profit factor, expectancy, averages and win rate', () => {
    const s = computePerfStats([t({ pnlPct: 2 }), t({ pnlPct: 1 }), t({ pnlPct: -1 })]);
    expect(s.n).toBe(3);
    expect(s.profitFactor).toBeCloseTo(3);      // (2+1) / 1
    expect(s.expectancy).toBeCloseTo(2 / 3);    // (2+1-1)/3
    expect(s.avgWin).toBeCloseTo(1.5);
    expect(s.avgLoss).toBeCloseTo(-1);
    expect(s.winRate).toBeCloseTo(2 / 3);
  });

  it('returns null profit factor when there are no losses (no Infinity)', () => {
    expect(computePerfStats([t({ pnlPct: 1 })]).profitFactor).toBeNull();
  });

  it('handles the empty set without dividing by zero', () => {
    const s = computePerfStats([]);
    expect(s).toMatchObject({ n: 0, profitFactor: null, expectancy: 0, avgWin: 0, avgLoss: 0, avgR: null, winRate: 0 });
  });

  it('computes avgR only from trades carrying both pnlUsdt and risk', () => {
    const s = computePerfStats([
      t({ pnlUsdt: 10, riskAmountUsdt: 5 }),   // R = 2
      t({ pnlUsdt: -4, riskAmountUsdt: 4 }),   // R = -1
      t({ pnlUsdt: 99, riskAmountUsdt: null }), // ignored
      t({ pnlUsdt: 5, riskAmountUsdt: 0 }),     // ignored (zero risk)
    ]);
    expect(s.avgR).toBeCloseTo(0.5);
  });

  it('exposes the honesty threshold', () => {
    expect(MIN_TRADES_FOR_STATS).toBe(20);
  });
});

describe('groupBy + confluenceBucket', () => {
  it('groups with counts, net pnl and win rate, sorted by count desc', () => {
    const rows = groupBy(
      [t({ exitReason: 'stop_loss', pnlPct: -1 }), t({ exitReason: 'take_profit', pnlPct: 2 }), t({ exitReason: 'stop_loss', pnlPct: -2 })],
      (x) => x.exitReason ?? 'unknown',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.key).toBe('stop_loss');
    expect(rows[0]?.n).toBe(2);
    expect(rows[0]?.netPnlPct).toBeCloseTo(-3);
    expect(rows[0]?.winRate).toBeCloseTo(0);
    expect(rows[1]?.key).toBe('take_profit');
  });

  it('buckets confluence scores', () => {
    expect(confluenceBucket(null)).toBe('unknown');
    expect(confluenceBucket(2.9)).toBe('<3');
    expect(confluenceBucket(3)).toBe('3-4');
    expect(confluenceBucket(4.31)).toBe('4-5');
    expect(confluenceBucket(5.82)).toBe('5-6');
    expect(confluenceBucket(7)).toBe('6+');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bot/trade-analytics.test.ts`
Expected: FAIL — `Cannot find module '.../trade-analytics'`.

- [ ] **Step 3: Implement**

```ts
// src/lib/bot/trade-analytics.ts
/**
 * Pure per-trade analytics for the dashboard. No I/O so it stays unit-testable.
 * Ratio-style metrics return null rather than Infinity/NaN when undefined, so
 * the UI can distinguish "not computable" from "zero".
 */

/** Sample size below which ratio stats are not meaningful and must not be shown. */
export const MIN_TRADES_FOR_STATS = 20;

export interface AnalyticsTrade {
  pnlPct: number;
  pnlUsdt: number | null;
  riskAmountUsdt: number | null;
  exitReason: string | null;
  regime: string | null;
  symbol: string;
  confluenceScore: number | null;
}

export interface PerfStats {
  n: number;
  profitFactor: number | null;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  avgR: number | null;
  winRate: number;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function computePerfStats(trades: AnalyticsTrade[]): PerfStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlPct > 0).map((t) => t.pnlPct);
  const losses = trades.filter((t) => t.pnlPct < 0).map((t) => t.pnlPct);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const rs = trades
    .filter((t) => t.pnlUsdt !== null && t.riskAmountUsdt !== null && t.riskAmountUsdt > 0)
    .map((t) => (t.pnlUsdt as number) / (t.riskAmountUsdt as number));
  return {
    n,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: mean(trades.map((t) => t.pnlPct)),
    avgWin: mean(wins),
    avgLoss: mean(losses),
    avgR: rs.length > 0 ? mean(rs) : null,
    winRate: n > 0 ? wins.length / n : 0,
  };
}

export interface BreakdownRow {
  key: string;
  n: number;
  netPnlPct: number;
  winRate: number;
}

export function groupBy(trades: AnalyticsTrade[], keyOf: (t: AnalyticsTrade) => string): BreakdownRow[] {
  const buckets = new Map<string, AnalyticsTrade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    const cur = buckets.get(k);
    if (cur) cur.push(t);
    else buckets.set(k, [t]);
  }
  const rows: BreakdownRow[] = [];
  for (const [key, ts] of buckets) {
    const winners = ts.filter((t) => t.pnlPct > 0).length;
    rows.push({
      key,
      n: ts.length,
      netPnlPct: ts.reduce((a, t) => a + t.pnlPct, 0),
      winRate: ts.length > 0 ? winners / ts.length : 0,
    });
  }
  return rows.sort((a, b) => b.n - a.n);
}

export function confluenceBucket(score: number | null): string {
  if (score === null) return 'unknown';
  if (score < 3) return '<3';
  if (score < 4) return '3-4';
  if (score < 5) return '4-5';
  if (score < 6) return '5-6';
  return '6+';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/bot/trade-analytics.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
zsh -ic 'gmp "add pure trade analytics module" feat backend'
```

---

## Task 3: Detail, stats-source and drawdown readers

**Files:**
- Modify: `src/lib/bot/sleeve-readers.ts`
- Test: `tests/bot/sleeve-readers.test.ts` (append)

**Interfaces:**
- Consumes: `AnalyticsTrade` from `./trade-analytics`; the `openReadonly`/`readJson`/`tableExists` private helpers already in `sleeve-readers.ts`.
- Produces:
  - `export interface FactorScore { name: string; value: number }`
  - `export interface TradeDetail { found: boolean; id: string | null; sleeve: string; symbol: string; direction: string; entryPrice: number | null; exitPrice: number | null; entryTimestamp: number; exitTimestamp: number; pnlPct: number; pnlUsdt: number | null; exitReason: string | null; stopLoss: number | null; takeProfit: number | null; riskAmountUsdt: number | null; positionSizeUsdt: number | null; regime: string | null; barsHeld: number | null; confluenceScore: number | null; factors: FactorScore[] | null; grossReturn: number | null; frictionReturn: number | null; fundingReturn: number | null; netReturn: number | null; fundingPaidUsdt: number | null; rMultiple: number | null }`
  - `export function readTradeDetail(id: string, dataDir?: string): TradeDetail`
  - `export function readAllTradesForStats(dataDir?: string): AnalyticsTrade[]`
  - `export function readDrawdownCurve(dataDir?: string): EquityPoint[]`

Rules:
- Not found (any sleeve) → `{ found: false, id: null, ... }` with every optional field null and numeric defaults 0 — never throw.
- `factors` parses the `factor_breakdown` JSON string into `FactorScore[]` sorted by `value` descending; **malformed JSON or a non-object → `null`**, never a throw.
- `rMultiple` = `pnlUsdt / riskAmountUsdt` when both present and risk > 0, else `null`.
- Thin sleeves (gold/metals): the rich fields are `null` — that is the capability signal the UI keys on.
- `readAllTradesForStats` reads crypto rows only (the only sleeve carrying the fields analytics needs), guarded by `tableExists`.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { readTradeDetail, readAllTradesForStats, readDrawdownCurve } from '../../src/lib/bot/sleeve-readers';

describe('detail readers', () => {
  function seedRichTrade(d: string, factorJson: string) {
    const db = new Database(path.join(d, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT,
        entry_price REAL, exit_price REAL, entry_timestamp INTEGER, exit_timestamp INTEGER,
        stop_loss REAL, take_profit REAL, position_size_usdt REAL, risk_amount_usdt REAL,
        confluence_score REAL, factor_breakdown TEXT, regime TEXT, exit_reason TEXT,
        bars_held INTEGER, pnl_percent REAL, pnl_usdt REAL,
        gross_return REAL, friction_return REAL, funding_return REAL, net_return REAL, funding_paid_usdt REAL);
    `);
    db.prepare(`INSERT INTO bot_trades VALUES ('t1','BTCUSDT','short',63000,62000,1,500,64000,61000,258.2,6.0,4.31,?, 'ranging+low','take_profit',12,1.5,9.0,0.017,-0.0014,0.00002,0.0156,0.03)`).run(factorJson);
    db.close();
  }

  it('returns a rich crypto trade with parsed factors and R multiple', () => {
    seedRichTrade(dir, JSON.stringify({ obProximity: 1.4, killZoneActive: 1.27, rrRatio: 0.56 }));
    const d = readTradeDetail('t1', dir);
    expect(d.found).toBe(true);
    expect(d.symbol).toBe('BTCUSDT');
    expect(d.confluenceScore).toBeCloseTo(4.31);
    expect(d.factors).toHaveLength(3);
    expect(d.factors?.[0]?.name).toBe('obProximity'); // sorted by value desc
    expect(d.rMultiple).toBeCloseTo(1.5);             // 9.0 / 6.0
    expect(d.netReturn).toBeCloseTo(0.0156);
  });

  it('survives malformed factor_breakdown by returning null factors', () => {
    seedRichTrade(dir, 'not-json{{');
    const d = readTradeDetail('t1', dir);
    expect(d.found).toBe(true);
    expect(d.factors).toBeNull();
  });

  it('returns found:false for an unknown id and on a fresh volume', () => {
    expect(readTradeDetail('nope', dir).found).toBe(false);
    expect(readTradeDetail('gold:123', dir).found).toBe(false);
  });

  it('reads a thin metals trade with null rich fields', () => {
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [{ leg: 'overnight_au', metal: 'au', side: 'long', entryPrice: 4000, exitPrice: 4040,
        entryTime: '2026-07-01T00:00:00Z', exitTime: '2026-07-01T09:00:00Z', pnlPct: 1 }],
    }));
    const id = `metals:overnight_au:${Date.parse('2026-07-01T09:00:00Z')}`;
    const d = readTradeDetail(id, dir);
    expect(d.found).toBe(true);
    expect(d.sleeve).toBe('metals');
    expect(d.pnlPct).toBeCloseTo(1);
    expect(d.factors).toBeNull();
    expect(d.confluenceScore).toBeNull();
  });

  it('feeds analytics and the drawdown curve, empty on a fresh volume', () => {
    expect(readAllTradesForStats(dir)).toEqual([]);
    expect(readDrawdownCurve(dir)).toEqual([]);
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, pnl_percent REAL, pnl_usdt REAL,
        risk_amount_usdt REAL, exit_reason TEXT, regime TEXT, confluence_score REAL);
      INSERT INTO bot_trades VALUES ('a','BTCUSDT',1.5,9,6,'take_profit','ranging+low',4.31);
      CREATE TABLE bot_equity_snapshots (id INTEGER PRIMARY KEY, timestamp INTEGER, equity REAL, drawdown REAL);
      INSERT INTO bot_equity_snapshots (timestamp, equity, drawdown) VALUES (10, 10000, 0), (20, 9900, 0.01);
    `);
    db.close();
    const rows = readAllTradesForStats(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confluenceScore).toBeCloseTo(4.31);
    const curve = readDrawdownCurve(dir);
    expect(curve).toHaveLength(2);
    expect(curve[1]?.drawdown).toBeCloseTo(0.01);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bot/sleeve-readers.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement** (append to `sleeve-readers.ts`)

```ts
import type { AnalyticsTrade } from './trade-analytics';

export interface FactorScore { name: string; value: number }

export interface TradeDetail {
  found: boolean;
  id: string | null;
  sleeve: string;
  symbol: string;
  direction: string;
  entryPrice: number | null;
  exitPrice: number | null;
  entryTimestamp: number;
  exitTimestamp: number;
  pnlPct: number;
  pnlUsdt: number | null;
  exitReason: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskAmountUsdt: number | null;
  positionSizeUsdt: number | null;
  regime: string | null;
  barsHeld: number | null;
  confluenceScore: number | null;
  factors: FactorScore[] | null;
  grossReturn: number | null;
  frictionReturn: number | null;
  fundingReturn: number | null;
  netReturn: number | null;
  fundingPaidUsdt: number | null;
  rMultiple: number | null;
}

const NOT_FOUND: TradeDetail = {
  found: false, id: null, sleeve: '', symbol: '', direction: '',
  entryPrice: null, exitPrice: null, entryTimestamp: 0, exitTimestamp: 0,
  pnlPct: 0, pnlUsdt: null, exitReason: null, stopLoss: null, takeProfit: null,
  riskAmountUsdt: null, positionSizeUsdt: null, regime: null, barsHeld: null,
  confluenceScore: null, factors: null, grossReturn: null, frictionReturn: null,
  fundingReturn: null, netReturn: null, fundingPaidUsdt: null, rMultiple: null,
};

/** Parse the stored factor_breakdown JSON into sorted scores; null if unusable. */
function parseFactors(raw: unknown): FactorScore[] | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const out: FactorScore[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out.push({ name, value });
  }
  return out.sort((a, b) => b.value - a.value);
}

function rMultipleOf(pnlUsdt: number | null, risk: number | null): number | null {
  return pnlUsdt !== null && risk !== null && risk > 0 ? pnlUsdt / risk : null;
}

export function readTradeDetail(id: string, dataDir: string = defaultDataDir()): TradeDetail {
  const db = openReadonly(dataDir);
  if (db) {
    try {
      if (tableExists(db, 'bot_trades')) {
        const r = db.prepare('SELECT * FROM bot_trades WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        if (r) {
          const num = (k: string): number | null => (typeof r[k] === 'number' ? (r[k] as number) : null);
          const str = (k: string): string | null => (typeof r[k] === 'string' ? (r[k] as string) : null);
          const pnlUsdt = num('pnl_usdt');
          const risk = num('risk_amount_usdt');
          return {
            found: true, id, sleeve: 'crypto',
            symbol: str('symbol') ?? '', direction: str('direction') ?? '',
            entryPrice: num('entry_price'), exitPrice: num('exit_price'),
            entryTimestamp: num('entry_timestamp') ?? 0, exitTimestamp: num('exit_timestamp') ?? 0,
            pnlPct: num('pnl_percent') ?? 0, pnlUsdt,
            exitReason: str('exit_reason'), stopLoss: num('stop_loss'), takeProfit: num('take_profit'),
            riskAmountUsdt: risk, positionSizeUsdt: num('position_size_usdt'),
            regime: str('regime'), barsHeld: num('bars_held'),
            confluenceScore: num('confluence_score'), factors: parseFactors(r['factor_breakdown']),
            grossReturn: num('gross_return'), frictionReturn: num('friction_return'),
            fundingReturn: num('funding_return'), netReturn: num('net_return'),
            fundingPaidUsdt: num('funding_paid_usdt'),
            rMultiple: rMultipleOf(pnlUsdt, risk),
          };
        }
      }
    } finally {
      db.close();
    }
  }
  // Thin JSON sleeves: match on the synthetic id produced by readRecentTrades.
  const gold = readJson(path.join(dataDir, 'gold-bot-state.json')) as
    | { trades?: Array<{ direction?: string; entryPrice?: number; exitPrice?: number; entryTime?: string; exitTime?: string; pnlPct?: number; pnlPercent?: number; exitReason?: string }> }
    | null;
  for (const t of gold?.trades ?? []) {
    const tid = `gold:${t.exitTime ? Date.parse(t.exitTime) : 0}`;
    if (tid === id) {
      return {
        ...NOT_FOUND, found: true, id: tid, sleeve: 'gold', symbol: 'XAUTUSDT',
        direction: t.direction ?? '—', entryPrice: t.entryPrice ?? null, exitPrice: t.exitPrice ?? null,
        entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0,
        exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0,
        pnlPct: t.pnlPct ?? t.pnlPercent ?? 0, exitReason: t.exitReason ?? null,
      };
    }
  }
  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as
    | { trades?: Array<{ leg?: string; side?: string; entryPrice?: number; exitPrice?: number; entryTime?: string; exitTime?: string; pnlPct?: number; stale?: boolean }> }
    | null;
  for (const t of metals?.trades ?? []) {
    const tid = `metals:${t.leg ?? 'metals'}:${t.exitTime ? Date.parse(t.exitTime) : 0}`;
    if (tid === id) {
      return {
        ...NOT_FOUND, found: true, id: tid, sleeve: 'metals', symbol: t.leg ?? 'metals',
        direction: t.side ?? '—', entryPrice: t.entryPrice ?? null, exitPrice: t.exitPrice ?? null,
        entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0,
        exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0,
        pnlPct: t.pnlPct ?? 0, exitReason: t.stale ? 'stale (downtime)' : null,
      };
    }
  }
  return NOT_FOUND;
}

/** Crypto rows only — the sole sleeve carrying the fields analytics needs. */
export function readAllTradesForStats(dataDir: string = defaultDataDir()): AnalyticsTrade[] {
  const db = openReadonly(dataDir);
  if (!db) return [];
  try {
    if (!tableExists(db, 'bot_trades')) return [];
    const rows = db.prepare(
      'SELECT symbol, pnl_percent, pnl_usdt, risk_amount_usdt, exit_reason, regime, confluence_score FROM bot_trades',
    ).all() as Array<{ symbol: string; pnl_percent: number; pnl_usdt: number | null; risk_amount_usdt: number | null; exit_reason: string | null; regime: string | null; confluence_score: number | null }>;
    return rows.map((r) => ({
      symbol: r.symbol,
      pnlPct: r.pnl_percent,
      pnlUsdt: r.pnl_usdt,
      riskAmountUsdt: r.risk_amount_usdt,
      exitReason: r.exit_reason,
      regime: r.regime,
      confluenceScore: r.confluence_score,
    }));
  } finally {
    db.close();
  }
}

export function readDrawdownCurve(dataDir: string = defaultDataDir()): EquityPoint[] {
  const db = openReadonly(dataDir);
  if (!db) return [];
  try {
    if (!tableExists(db, 'bot_equity_snapshots')) return [];
    return db.prepare('SELECT timestamp, equity, drawdown FROM bot_equity_snapshots ORDER BY timestamp ASC').all() as EquityPoint[];
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/bot/sleeve-readers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
zsh -ic 'gmp "add trade detail, stats-source and drawdown readers" feat backend'
```

---

## Task 4: Five new `dashboard.book` procedures

**Files:**
- Modify: `src/lib/trpc/routers/dashboard/book.ts`
- Test: `tests/trpc/book-router.test.ts` (append)

**Interfaces:**
- Consumes: Task 2 + Task 3 exports; the existing `dataDir()` helper in `book.ts` (`process.env.BOT_DATA_DIR ?? path.resolve('data')`).
- Produces (all `publicProcedure.query`):
  - `tradeDetail` — input `z.object({ id: z.string().min(1) })` → `TradeDetail`
  - `stats` → `PerfStats & { maxDrawdown: number; sharpe: number; sortino: number; minTradesForStats: number }`
  - `breakdowns` → `{ byExitReason: BreakdownRow[]; byRegime: BreakdownRow[]; bySymbol: BreakdownRow[]; byConfluence: BreakdownRow[] }`
  - `costs` → `{ totalGross: number; totalFriction: number; totalFunding: number; totalNet: number; fundingBySymbol: Array<{ symbol: string; fundingPaidUsdt: number }> }`
  - `drawdownCurve` → `EquityPoint[]`

`sharpe`/`sortino`/`maxDrawdown` come from `src/lib/rl/utils/gt-score.ts` applied to the per-trade `pnlPct` series expressed as fractions (`pnlPct / 100`). These are **per-trade**, not annualized — label them as such in the UI.

- [ ] **Step 1: Write the failing test** (append)

```ts
describe('detail + analytics procedures', () => {
  it('returns an empty-but-valid stats payload on a fresh volume', async () => {
    const s = await createCaller({}).stats();
    expect(s.n).toBe(0);
    expect(s.profitFactor).toBeNull();
    expect(s.minTradesForStats).toBe(20);
  });

  it('aggregates stats, breakdowns and costs from seeded trades', async () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, pnl_percent REAL, pnl_usdt REAL,
        risk_amount_usdt REAL, exit_reason TEXT, regime TEXT, confluence_score REAL,
        gross_return REAL, friction_return REAL, funding_return REAL, net_return REAL, funding_paid_usdt REAL);
      INSERT INTO bot_trades VALUES ('a','BTCUSDT',2,10,5,'take_profit','ranging+low',4.31,0.021,-0.0014,0.0,0.02,0.03);
      INSERT INTO bot_trades VALUES ('b','ETHUSDT',-1,-5,5,'stop_loss','uptrend+normal',5.82,-0.009,-0.0014,-0.0002,-0.011,0.01);
    `);
    db.close();
    const caller = createCaller({});
    const s = await caller.stats();
    expect(s.n).toBe(2);
    expect(s.profitFactor).toBeCloseTo(2);   // 2 / 1
    const b = await caller.breakdowns();
    expect(b.byExitReason).toHaveLength(2);
    expect(b.bySymbol.map((r) => r.key).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(b.byConfluence.some((r) => r.key === '4-5')).toBe(true);
    const c = await caller.costs();
    expect(c.totalFriction).toBeCloseTo(-0.0028);
    expect(c.fundingBySymbol).toHaveLength(2);
  });

  it('returns found:false for an unknown trade id', async () => {
    const d = await createCaller({}).tradeDetail({ id: 'missing' });
    expect(d.found).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/trpc/book-router.test.ts`
Expected: FAIL — procedures do not exist.

- [ ] **Step 3: Implement**

Add imports at the top of `book.ts`:
```ts
import { readTradeDetail, readAllTradesForStats, readDrawdownCurve } from '../../../bot/sleeve-readers';
import { computePerfStats, groupBy, confluenceBucket, MIN_TRADES_FOR_STATS } from '../../../bot/trade-analytics';
import { calculateMaxDrawdown, calculateSharpeRatio, calculateSortinoRatio } from '../../../rl/utils/gt-score';
```
Add inside `router({ ... })` (keep every existing procedure):
```ts
  tradeDetail: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ input }) => readTradeDetail(input.id, dataDir())),

  stats: publicProcedure.query(() => {
    const trades = readAllTradesForStats(dataDir());
    const returns = trades.map((t) => t.pnlPct / 100);
    return {
      ...computePerfStats(trades),
      maxDrawdown: calculateMaxDrawdown(returns),
      sharpe: calculateSharpeRatio(returns),
      sortino: calculateSortinoRatio(returns),
      minTradesForStats: MIN_TRADES_FOR_STATS,
    };
  }),

  breakdowns: publicProcedure.query(() => {
    const trades = readAllTradesForStats(dataDir());
    return {
      byExitReason: groupBy(trades, (t) => t.exitReason ?? 'unknown'),
      byRegime: groupBy(trades, (t) => t.regime ?? 'unknown'),
      bySymbol: groupBy(trades, (t) => t.symbol),
      byConfluence: groupBy(trades, (t) => confluenceBucket(t.confluenceScore)),
    };
  }),

  costs: publicProcedure.query(() => readCosts(dataDir())),

  drawdownCurve: publicProcedure.query(() => readDrawdownCurve(dataDir())),
```
`readCosts` does not exist yet — the router must never open a DB itself, so add the reader. Append to `sleeve-readers.ts`:
```ts
export interface CostSummary {
  totalGross: number;
  totalFriction: number;
  totalFunding: number;
  totalNet: number;
  fundingBySymbol: Array<{ symbol: string; fundingPaidUsdt: number }>;
}

export function readCosts(dataDir: string = defaultDataDir()): CostSummary {
  const empty: CostSummary = { totalGross: 0, totalFriction: 0, totalFunding: 0, totalNet: 0, fundingBySymbol: [] };
  const db = openReadonly(dataDir);
  if (!db) return empty;
  try {
    if (!tableExists(db, 'bot_trades')) return empty;
    const rows = db.prepare(
      'SELECT symbol, gross_return, friction_return, funding_return, net_return, funding_paid_usdt FROM bot_trades',
    ).all() as Array<{ symbol: string; gross_return: number; friction_return: number; funding_return: number; net_return: number; funding_paid_usdt: number }>;
    const bySymbol = new Map<string, number>();
    const out: CostSummary = { ...empty, fundingBySymbol: [] };
    for (const r of rows) {
      out.totalGross += r.gross_return;
      out.totalFriction += r.friction_return;
      out.totalFunding += r.funding_return;
      out.totalNet += r.net_return;
      bySymbol.set(r.symbol, (bySymbol.get(r.symbol) ?? 0) + r.funding_paid_usdt);
    }
    out.fundingBySymbol = [...bySymbol].map(([symbol, fundingPaidUsdt]) => ({ symbol, fundingPaidUsdt }));
    return out;
  } finally {
    db.close();
  }
}
```
Import `readCosts` alongside the other readers in `book.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/trpc/book-router.test.ts tests/bot/sleeve-readers.test.ts tests/bot/trade-analytics.test.ts`
Expected: PASS (all files).

- [ ] **Step 5: Verify types**

Run: `pnpm typecheck 2>&1 | grep -E "sleeve-readers|trade-analytics|dashboard/book|book-router"`
Expected: prints NOTHING.

- [ ] **Step 6: Commit**

```bash
zsh -ic 'gmp "add detail, stats, breakdown, cost and drawdown procedures" feat backend'
```

---

## Task 5: Trade detail drawer

**Files:**
- Create: `src/components/live-trading/TradeDetailDrawer.tsx`
- Modify: `src/components/live-trading/RecentTradesTable.tsx`
- (No unit test — vitest env is node; verified by `pnpm build` + smoke.)

**Interfaces:**
- Consumes: `trpc.dashboard.book.tradeDetail.useQuery({ id }, { enabled: id !== null })`; `formatUsd`/`formatPnlPct` from `src/lib/bot/format`.
- Produces: `export function TradeDetailDrawer({ tradeId, onClose }: { tradeId: string | null; onClose: () => void })`.

Behaviour:
- Renders nothing when `tradeId === null`.
- Fixed slide-over on the right (`fixed inset-y-0 right-0 w-full max-w-md overflow-y-auto z-50`), dark theme matching existing components, with a backdrop that closes on click and a close button. Closes on `Escape`.
- Sections, each **omitted entirely when its data is null** (the sleeve-capability rule):
  1. **Header** — symbol, direction, sleeve tag, exit reason, PnL% (green ≥ 0 / red).
  2. **Levels & risk** — entry, exit, stop-loss, take-profit, position size, risk, and **R-multiple** (omit whole block when `stopLoss`/`takeProfit`/`riskAmountUsdt` are all null).
  3. **PnL waterfall** — gross → friction → funding → net as labelled horizontal bars (omit when `netReturn` is null). Show `fundingPaidUsdt` beneath when present.
  4. **Confluence factors** — horizontal bar per factor, sorted desc, value labelled; header shows `confluenceScore`. **Omit when `factors` is null**, and in that case, if the sleeve is not `crypto`, render the note: `Limited detail for this sleeve — the {sleeve} bot stores summary trades only.`
  5. **Meta** — regime, bars held, entry/exit timestamps.
- `isLoading` → skeleton; `error` → inline red message; `found === false` → "Trade not found."

- [ ] **Step 1: Build the drawer component**

Write `TradeDetailDrawer.tsx` per the behaviour above. Study `src/components/dashboard/GoldContextPanel.tsx` and `src/components/live-trading/SleeveCards.tsx` first and match their Tailwind class vocabulary (card borders, muted text, badge pills). Bars are plain divs with a percentage width — no chart library. For the confluence bars, scale each factor's width to `value / maxValue` of that trade's factors.

- [ ] **Step 2: Make trade rows clickable**

In `RecentTradesTable.tsx`: add `const [openId, setOpenId] = useState<string | null>(null);`, give each `<tr>` `onClick={() => setOpenId(t.id)}` plus `className="... cursor-pointer hover:bg-white/5"`, and render `<TradeDetailDrawer tradeId={openId} onClose={() => setOpenId(null)} />` after the table. Keep the existing columns and empty state unchanged.

- [ ] **Step 3: Verify the app builds**

Run: `pnpm build`
Expected: `✓ Compiled successfully`. (`typescript.ignoreBuildErrors` is on for the repo's legacy debt, so ALSO run `pnpm typecheck 2>&1 | grep -E "TradeDetailDrawer|RecentTradesTable"` and confirm it prints nothing.)

- [ ] **Step 4: Commit**

```bash
zsh -ic 'gmp "add trade detail drawer with confluence and pnl breakdown" feat admin'
```

---

## Task 6: Analytics panels + underwater drawdown

**Files:**
- Create: `src/components/live-trading/StatsPanel.tsx`, `src/components/live-trading/BreakdownTables.tsx`, `src/components/live-trading/CostPanel.tsx`
- Modify: `src/components/live-trading/EquityCurveChart.tsx`, `src/app/live-trading/page.tsx`

**Interfaces:**
- Consumes: `trpc.dashboard.book.{stats,breakdowns,costs,drawdownCurve}.useQuery(undefined, { refetchInterval: 30_000 })`.
- Produces: `StatsPanel()`, `BreakdownTables()`, `CostPanel()` (no props); `EquityCurveChart` gains an optional prop `drawdown?: Array<{ timestamp: number; drawdown: number }>`.

- [ ] **Step 1: StatsPanel with the honesty guard**

Render `n` always. When `n < minTradesForStats`, render the notice
`Needs ≥{minTradesForStats} trades to be meaningful — {n} so far.`
**in place of** profit factor / expectancy / avgR / Sharpe / Sortino / max-drawdown values (win rate and `n` may still show, labelled with the count). When `n >= minTradesForStats`, render all values; format ratios to 2dp and show `—` for any `null`. Label Sharpe/Sortino explicitly as **per-trade**, not annualized.

- [ ] **Step 2: BreakdownTables**

Four small tables (exit reason, regime, symbol, confluence bucket), each with columns `key | n | net PnL% | win rate`. Every row shows its `n`. Above the tables render the caption `Counts shown per row — a bucket with few trades is not a pattern.` Empty data → "No trades yet."

- [ ] **Step 3: CostPanel**

Show `totalGross`, `totalFriction`, `totalFunding`, `totalNet` (as percentages via `formatPnlPct` on `value * 100`, since these are stored as fractions) and a small `symbol | funding paid` table from `fundingBySymbol` (USD via `formatUsd`). Empty → "No cost data yet."

- [ ] **Step 4: Underwater subplot in EquityCurveChart**

Add the optional `drawdown` prop. When it has points, add a second series to the SAME chart via `chart.addSeries(AreaSeries, { ... })` on a separate price scale so it renders as an underwater band beneath equity:
```ts
const ddSeries = chart.addSeries(AreaSeries, {
  lineColor: '#f87171', topColor: 'rgba(248,113,113,0)', bottomColor: 'rgba(248,113,113,0.35)',
  priceScaleId: 'dd', lastValueVisible: false, priceLineVisible: false,
});
chart.priceScale('dd').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });
ddSeries.setData(drawdown.map((p) => ({ time: Math.floor(p.timestamp / 1000) as Time, value: -Math.abs(p.drawdown) * 100 })));
ddSeries.createPriceLine({ price: -10, color: '#ef4444', lineStyle: 2, axisLabelVisible: true, title: 'halt -10%' });
```
Use the v5 API (`addSeries(AreaSeries, …)`) exactly as the existing chart does — v4's `addAreaSeries` does not exist in this version. Guard: skip the whole block when `drawdown` is undefined/empty.

- [ ] **Step 5: Mount everything on the page**

In `src/app/live-trading/page.tsx`, query `drawdownCurve` alongside the existing `equityCurve` and pass it to the chart: `<EquityCurveChart points={curve.data?.crypto ?? []} drawdown={dd.data ?? []} />`. Add `<StatsPanel />`, `<BreakdownTables />`, `<CostPanel />` after `<SleeveCards />`, each in the same `rounded-lg border border-gray-800 p-4` section wrapper used by the existing chart section, with an `<h2>` heading.

- [ ] **Step 6: Verify build + types**

Run: `pnpm build` → `✓ Compiled successfully`, then
`pnpm typecheck 2>&1 | grep -E "StatsPanel|BreakdownTables|CostPanel|EquityCurveChart|live-trading/page"` → prints NOTHING.

- [ ] **Step 7: Local smoke**

Run: `PORT=3111 pnpm start` in the background, then
`curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3111/live-trading` → `200`, and
`curl -s -o /dev/null -w "%{http_code}\n" 'http://localhost:3111/api/trpc/dashboard.book.stats?batch=1&input=%7B%7D'` → `200`. Stop the server.

- [ ] **Step 8: Commit**

```bash
zsh -ic 'gmp "add stats, breakdown and cost panels with underwater drawdown" feat admin'
```

---

## Self-Review

**Spec coverage:**
- Click-through detail panel → Task 5 (drawer) + Task 1 (ids) + Task 3 (`readTradeDetail`). ✓
- 13-factor confluence chart → Task 5 §4, data from `parseFactors` (Task 3). ✓
- PnL waterfall (gross→friction→funding→net) → Task 5 §3, fields from Task 3. ✓
- R-multiple + levels → Task 3 `rMultiple`, Task 5 §2. ✓
- Underwater drawdown + −10% halt line → Task 6 Step 4, data from `readDrawdownCurve` (Task 3). ✓
- Performance stats (profit factor, expectancy, avg win/loss, avg R, max DD, Sharpe, Sortino) → Task 2 + Task 4 `stats`. ✓
- Breakdowns by exit reason / regime / symbol / confluence bucket → Task 2 `groupBy`/`confluenceBucket` + Task 4 `breakdowns` + Task 6 Step 2. ✓
- Cost/friction analysis → Task 4 `readCosts`/`costs` + Task 6 Step 3. ✓
- Honesty guard (`MIN_TRADES_FOR_STATS = 20`, API returns values, UI withholds) → Task 2 constant, Task 4 `minTradesForStats` passthrough, Task 6 Step 1 UI rule, plus per-row counts in Step 2. ✓
- Sleeve capability (omit, never N/A grid) → Task 3 nulls + Task 5 omission rule and the metals note. ✓
- Resilience: missing file/table/malformed JSON → Task 3 `tableExists` guards, `parseFactors` try/catch, `NOT_FOUND`; tested. ✓
- All procedures `query`, no mutations → Task 4. ✓
- Reuse rl/utils metrics → Task 4 imports from `gt-score.ts`. ✓
- Out of scope (filters, export, custom layout, mobile redesign) → no task implements them. ✓

**Placeholder scan:** No TBD/TODO, and no undefined helpers — Task 4 wires `costs` to `readCosts`, whose full implementation is given in the same step. Component markup in Tasks 5–6 is specified by behaviour + exact class vocabulary to match existing files rather than pinned JSX, which is a style-match instruction, not a placeholder.

**Type consistency:** `AnalyticsTrade` (Task 2) is exactly what `readAllTradesForStats` (Task 3) returns and what `computePerfStats`/`groupBy` consume. `BreakdownRow`/`PerfStats` flow unchanged into Task 4's `breakdowns`/`stats`. `TradeDetail`/`FactorScore` (Task 3) are consumed unchanged by Task 5. `EquityPoint` is the pre-existing v1 type reused by `readDrawdownCurve`. `ClosedTrade.id` (Task 1) is the key Task 5 passes to `tradeDetail` (Task 4) — and the synthetic id formats in Task 1 and Task 3 match exactly (`gold:<exitTs>`, `metals:<leg>:<exitTs>`).
