# Paper Fleet Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deployed, read-only web dashboard showing one consolidated "book" view (equity, open positions, recent trades, per-sleeve breakdown, governance) across the live paper fleet — crypto (Run 20), gold F2F, and metals/session — served from inside the fleet container on Railway.

**Architecture:** A new read-only tRPC router (`dashboard.book`) reads the three existing stores (crypto `bot_*` tables in SQLite, `gold-bot-state.json`, `metals-bot-state.json`) via pure, unit-tested reader functions extracted from `scripts/track-record-status.ts`. The existing Next.js app renders it. Next.js is added to the Docker image (`next build`) and launched as a **non-core 6th process** in `docker-entrypoint.sh`, reading the same `/app/data` volume; Railway exposes its port.

**Tech Stack:** Next.js 15 (App Router), TypeScript (strict), tRPC + @trpc/react-query, better-sqlite3 + Drizzle, Lightweight Charts, Tailwind v4, vitest.

## Global Constraints

- Language: all code/comments/docs in English.
- No `any` / `as any`. Use proper narrowing or `unknown`.
- Tests live under `tests/**/*.test.ts` (vitest `include` is `tests/**/*.test.ts`, `environment: 'node'`). Do NOT colocate tests in `src/`; they won't run.
- Test env is **node, not jsdom** — no React render tests. Test pure logic only; UI is verified by `pnpm build` + manual smoke.
- Commit ONLY with `gmp "message" type scope` (never raw `git commit`). Branch is `ftr/paper-fleet-dashboard` (already created).
- PAPER ONLY. Never add `BYBIT_API_KEY`/`BYBIT_API_SECRET`. UI is view-only — no controls, no auth.
- Data dir: readers resolve paths under a `dataDir` arg defaulting to `path.resolve('data')`. In the container cwd is `/app`, so `data` → `/app/data` (the volume). Tests pass a temp dir.
- Readers must be resilient: a missing DB file or unreadable JSON returns an empty/`available:false` result, never throws. The empty book (today's real state) is a valid state, not an error.
- Verification after each task: `pnpm test` (relevant file), `pnpm typecheck`, `pnpm lint` — show output before claiming done.

---

## File Structure

**New:**
- `src/lib/bot/sleeve-readers.ts` — all live-store read I/O for the dashboard (sleeve summaries, open positions, recent trades, equity curve, freshness, governance). Returns typed data; resilient to missing files.
- `src/lib/trpc/routers/dashboard/book.ts` — the `book` tRPC router (thin; calls readers).
- `src/components/live-trading/BookHeader.tsx`, `SleeveCards.tsx`, `OpenPositionsTable.tsx`, `RecentTradesTable.tsx`, `EquityCurveChart.tsx` — client components (trpc `useQuery`, `refetchInterval: 30_000`).
- `src/lib/bot/format.ts` — pure presentation helpers (`formatPnlPct`, `formatUsd`, `sleeveStatusLabel`) so UI logic is unit-testable.
- `tests/bot/sleeve-readers.test.ts`, `tests/bot/format.test.ts`, `tests/trpc/book-router.test.ts`.

**Modified:**
- `scripts/track-record-status.ts` — import readers from `sleeve-readers.ts` (DRY; delete the duplicated `cryptoSleeve`/`metalsSleeve`/`goldSleeve`).
- `src/lib/trpc/routers/dashboard/index.ts` — register `book`.
- `src/app/live-trading/page.tsx` — rewrite as the consolidated book (compose the new components).
- `Dockerfile` — copy next config + `public/`, set `NODE_ENV=production` before build, add `RUN pnpm build`.
- `scripts/docker-entrypoint.sh` — launch `next start` as a non-core process.
- `RAILWAY-DEPLOY.md` — document the UI port + public networking + 2 GB.

---

## Task 1: Extract sleeve-summary readers (+ DRY the status script)

**Files:**
- Create: `src/lib/bot/sleeve-readers.ts`
- Test: `tests/bot/sleeve-readers.test.ts`
- Modify: `scripts/track-record-status.ts`

**Interfaces:**
- Consumes: `SleeveSummary`, `summarizeSleeve` from `src/lib/bot/track-record.ts`.
- Produces:
  - `defaultDataDir(): string` → `path.resolve('data')`
  - `readCryptoSleeve(dataDir?: string): SleeveSummary`
  - `readMetalsSleeve(dataDir?: string): SleeveSummary`
  - `readGoldSleeve(dataDir?: string): SleeveSummary`
  - `readAllSleeves(dataDir?: string): SleeveSummary[]` → `[crypto, metals, gold]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bot/sleeve-readers.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readCryptoSleeve, readMetalsSleeve, readGoldSleeve, readAllSleeves } from '../../src/lib/bot/sleeve-readers';

let dir: string;

function seedCryptoDb(d: string) {
  const db = new Database(path.join(d, 'ict-trading.db'));
  db.exec(`
    CREATE TABLE bot_trades (id TEXT PRIMARY KEY, pnl_percent REAL);
    CREATE TABLE bot_state (id INTEGER PRIMARY KEY, equity REAL);
    CREATE TABLE bot_positions (id TEXT PRIMARY KEY, status TEXT);
    INSERT INTO bot_trades VALUES ('a', 1.5), ('b', -0.5);
    INSERT INTO bot_state VALUES (1, 10123.4);
    INSERT INTO bot_positions VALUES ('p1','open'), ('p2','closed');
  `);
  db.close();
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleeve-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('sleeve-readers', () => {
  it('reads the crypto sleeve from bot_* tables', () => {
    seedCryptoDb(dir);
    const s = readCryptoSleeve(dir);
    expect(s.closedTrades).toBe(2);
    expect(s.cumPnlPct).toBeCloseTo(1.0);
    expect(s.openPositions).toBe(1);
    expect(s.equity).toBeCloseTo(10123.4);
  });

  it('returns an empty crypto summary when the DB is missing (fresh volume)', () => {
    const s = readCryptoSleeve(dir); // no db file
    expect(s.closedTrades).toBe(0);
    expect(s.openPositions).toBe(0);
    expect(s.equity).toBe(10000);
  });

  it('reads gold and metals from JSON state, tolerating absent files', () => {
    fs.writeFileSync(path.join(dir, 'gold-bot-state.json'), JSON.stringify({ trades: [{ pnlPct: 2 }], equity: 10200, position: { dir: 'long' } }));
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({ trades: [{ pnlPct: -1 }, { pnlPct: 3 }], positions: [] }));
    const gold = readGoldSleeve(dir);
    const metals = readMetalsSleeve(dir);
    expect(gold.closedTrades).toBe(1);
    expect(gold.openPositions).toBe(1);
    expect(gold.equity).toBeCloseTo(10200);
    expect(metals.closedTrades).toBe(2);
    expect(readAllSleeves(dir)).toHaveLength(3);
    expect(readAllSleeves(dir)[0].label).toContain('crypto');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bot/sleeve-readers.test.ts`
Expected: FAIL — `Cannot find module '.../sleeve-readers'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/bot/sleeve-readers.ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { summarizeSleeve, type SleeveSummary } from './track-record';

export function defaultDataDir(): string {
  return path.resolve('data');
}

function dbPath(dataDir: string): string {
  return path.join(dataDir, 'ict-trading.db');
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** Open the bot DB read-only, or null if it does not exist yet (fresh volume). */
function openReadonly(dataDir: string): Database.Database | null {
  const p = dbPath(dataDir);
  if (!fs.existsSync(p)) return null;
  const db = new Database(p, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

export function readCryptoSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const db = openReadonly(dataDir);
  if (!db) return summarizeSleeve('crypto (Run 20)', [], 0, 10000);
  try {
    const rows = db.prepare('SELECT pnl_percent FROM bot_trades').all() as Array<{ pnl_percent: number }>;
    const state = db.prepare('SELECT equity FROM bot_state WHERE id = 1').get() as { equity: number } | undefined;
    const open = (db.prepare("SELECT COUNT(*) n FROM bot_positions WHERE status = 'open'").get() as { n: number }).n;
    return summarizeSleeve('crypto (Run 20)', rows.map((r) => r.pnl_percent), open, state?.equity ?? 10000);
  } finally {
    db.close();
  }
}

export function readMetalsSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const d = readJson(path.join(dataDir, 'metals-bot-state.json')) as
    | { trades?: Array<{ pnlPct: number }>; positions?: unknown[] }
    | null;
  const trades = d?.trades ?? [];
  return summarizeSleeve('session/metals', trades.map((t) => t.pnlPct), (d?.positions ?? []).length, 10000);
}

export function readGoldSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const d = readJson(path.join(dataDir, 'gold-bot-state.json')) as
    | { trades?: Array<{ pnlPct?: number; pnlPercent?: number }>; equity?: number; position?: unknown }
    | null;
  const trades = d?.trades ?? [];
  const pnls = trades.map((t) => t.pnlPct ?? t.pnlPercent ?? 0);
  return summarizeSleeve('gold F2F', pnls, d?.position ? 1 : 0, d?.equity ?? 10000);
}

export function readAllSleeves(dataDir: string = defaultDataDir()): SleeveSummary[] {
  return [readCryptoSleeve(dataDir), readMetalsSleeve(dataDir), readGoldSleeve(dataDir)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/bot/sleeve-readers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: DRY the status script**

In `scripts/track-record-status.ts`, delete the local `cryptoSleeve`/`metalsSleeve`/`goldSleeve` functions and the now-unused `Database`/`summarizeSleeve` imports, and import instead:

```ts
import { readCryptoSleeve, readMetalsSleeve, readGoldSleeve } from '../src/lib/bot/sleeve-readers';
```
Then in `main()`: `const sleeves = [readCryptoSleeve(), readMetalsSleeve(), readGoldSleeve()];`
Keep `metalsHonestPnl()` and `combineSleeves`/`partitionByHoldCap` usage as-is.

- [ ] **Step 6: Verify the script still runs and typecheck passes**

Run: `npx tsx scripts/track-record-status.ts && pnpm typecheck`
Expected: prints the consolidated table; typecheck clean.

- [ ] **Step 7: Commit**

```bash
gmp "extract sleeve-summary readers, DRY track-record status" refactor backend
```

---

## Task 2: Open-positions and recent-trades readers

**Files:**
- Modify: `src/lib/bot/sleeve-readers.ts`
- Test: `tests/bot/sleeve-readers.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `interface OpenPosition { sleeve: string; symbol: string; direction: string; entryPrice: number; sizeUsdt: number | null; entryTimestamp: number; strategy: string | null }`
  - `readOpenPositions(dataDir?: string): OpenPosition[]`
  - `interface ClosedTrade { sleeve: string; symbol: string; direction: string; entryTimestamp: number; exitTimestamp: number; pnlPct: number; pnlUsdt: number | null; exitReason: string | null }`
  - `readRecentTrades(limit: number, dataDir?: string): ClosedTrade[]` (crypto from `bot_trades`, newest first by `exit_timestamp`; gold/metals appended from JSON where timestamps exist)

- [ ] **Step 1: Write the failing test** (append to the existing test file)

```ts
import { readOpenPositions, readRecentTrades } from '../../src/lib/bot/sleeve-readers';

describe('positions & trades readers', () => {
  it('reads open crypto positions with sleeve tag', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_positions (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT, status TEXT,
        entry_price REAL, entry_timestamp INTEGER, position_size_usdt REAL, strategy TEXT);
      INSERT INTO bot_positions VALUES ('p1','BTCUSDT','long','open',63000,1700000000000,258.2,'order_block');
      INSERT INTO bot_positions VALUES ('p2','ETHUSDT','short','closed',1900,1700000000000,187.0,'order_block');
    `);
    db.close();
    const pos = readOpenPositions(dir);
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ sleeve: 'crypto', symbol: 'BTCUSDT', direction: 'long', strategy: 'order_block' });
  });

  it('reads recent crypto trades newest-first, capped by limit', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT,
        entry_timestamp INTEGER, exit_timestamp INTEGER, pnl_percent REAL, pnl_usdt REAL, exit_reason TEXT);
      INSERT INTO bot_trades VALUES ('t1','BTCUSDT','short',1,100,0.5,1.2,'take_profit');
      INSERT INTO bot_trades VALUES ('t2','ETHUSDT','long',1,200,-1.0,-5.0,'stop_loss');
    `);
    db.close();
    const trades = readRecentTrades(10, dir);
    expect(trades[0].sleeve).toBe('crypto');
    expect(trades[0].exitTimestamp).toBe(200); // newest first
    expect(readRecentTrades(1, dir)).toHaveLength(1);
  });

  it('returns [] for positions/trades on a fresh volume', () => {
    expect(readOpenPositions(dir)).toEqual([]);
    expect(readRecentTrades(10, dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bot/sleeve-readers.test.ts`
Expected: FAIL — `readOpenPositions`/`readRecentTrades` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `sleeve-readers.ts`)

```ts
export interface OpenPosition {
  sleeve: string;
  symbol: string;
  direction: string;
  entryPrice: number;
  sizeUsdt: number | null;
  entryTimestamp: number;
  strategy: string | null;
}

export function readOpenPositions(dataDir: string = defaultDataDir()): OpenPosition[] {
  const db = openReadonly(dataDir);
  const out: OpenPosition[] = [];
  if (db) {
    try {
      const rows = db.prepare(
        "SELECT symbol, direction, entry_price, entry_timestamp, position_size_usdt, strategy FROM bot_positions WHERE status = 'open'",
      ).all() as Array<{ symbol: string; direction: string; entry_price: number; entry_timestamp: number; position_size_usdt: number; strategy: string }>;
      for (const r of rows) {
        out.push({ sleeve: 'crypto', symbol: r.symbol, direction: r.direction, entryPrice: r.entry_price, sizeUsdt: r.position_size_usdt, entryTimestamp: r.entry_timestamp, strategy: r.strategy });
      }
    } finally {
      db.close();
    }
  }
  // Gold: single open position flag in JSON (no rich fields) — surface as a marker.
  const gold = readJson(path.join(dataDir, 'gold-bot-state.json')) as { position?: { direction?: string; entryPrice?: number; entryTime?: number } } | null;
  if (gold?.position) {
    out.push({ sleeve: 'gold', symbol: 'XAUTUSDT', direction: gold.position.direction ?? '—', entryPrice: gold.position.entryPrice ?? 0, sizeUsdt: null, entryTimestamp: gold.position.entryTime ?? 0, strategy: 'f2f_gold' });
  }
  // Metals: open legs in JSON.
  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as { positions?: Array<{ leg?: string; direction?: string; entryPrice?: number; entryTime?: number }> } | null;
  for (const p of metals?.positions ?? []) {
    out.push({ sleeve: 'metals', symbol: p.leg ?? 'metals', direction: p.direction ?? '—', entryPrice: p.entryPrice ?? 0, sizeUsdt: null, entryTimestamp: p.entryTime ?? 0, strategy: 'session' });
  }
  return out;
}

export interface ClosedTrade {
  sleeve: string;
  symbol: string;
  direction: string;
  entryTimestamp: number;
  exitTimestamp: number;
  pnlPct: number;
  pnlUsdt: number | null;
  exitReason: string | null;
}

export function readRecentTrades(limit: number, dataDir: string = defaultDataDir()): ClosedTrade[] {
  const out: ClosedTrade[] = [];
  const db = openReadonly(dataDir);
  if (db) {
    try {
      const rows = db.prepare(
        'SELECT symbol, direction, entry_timestamp, exit_timestamp, pnl_percent, pnl_usdt, exit_reason FROM bot_trades ORDER BY exit_timestamp DESC LIMIT ?',
      ).all(limit) as Array<{ symbol: string; direction: string; entry_timestamp: number; exit_timestamp: number; pnl_percent: number; pnl_usdt: number; exit_reason: string }>;
      for (const r of rows) {
        out.push({ sleeve: 'crypto', symbol: r.symbol, direction: r.direction, entryTimestamp: r.entry_timestamp, exitTimestamp: r.exit_timestamp, pnlPct: r.pnl_percent, pnlUsdt: r.pnl_usdt, exitReason: r.exit_reason });
      }
    } finally {
      db.close();
    }
  }
  // Gold/metals JSON trades carry ISO timestamps; include when parseable, tagged by sleeve.
  const gold = readJson(path.join(dataDir, 'gold-bot-state.json')) as { trades?: Array<{ direction?: string; entryTime?: string; exitTime?: string; pnlPct?: number; pnlPercent?: number; exitReason?: string }> } | null;
  for (const t of gold?.trades ?? []) {
    out.push({ sleeve: 'gold', symbol: 'XAUTUSDT', direction: t.direction ?? '—', entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0, exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0, pnlPct: t.pnlPct ?? t.pnlPercent ?? 0, pnlUsdt: null, exitReason: t.exitReason ?? null });
  }
  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as { trades?: Array<{ leg?: string; entryTime?: string; exitTime?: string; pnlPct?: number; stale?: boolean }> } | null;
  for (const t of metals?.trades ?? []) {
    out.push({ sleeve: 'metals', symbol: t.leg ?? 'metals', direction: '—', entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0, exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0, pnlPct: t.pnlPct ?? 0, pnlUsdt: null, exitReason: t.stale ? 'stale (downtime)' : null });
  }
  return out.sort((a, b) => b.exitTimestamp - a.exitTimestamp).slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/bot/sleeve-readers.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
gmp "add open-positions and recent-trades readers" feat backend
```

---

## Task 3: Equity-curve, freshness, and governance readers

**Files:**
- Modify: `src/lib/bot/sleeve-readers.ts`
- Test: `tests/bot/sleeve-readers.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `interface EquityPoint { timestamp: number; equity: number; drawdown: number }`
  - `interface EquityCurve { crypto: EquityPoint[]; currentEquity: { crypto: number; gold: number; metals: number; total: number } }`
  - `readEquityCurve(dataDir?: string): EquityCurve` (crypto series from `bot_equity_snapshots`; gold/metals have no per-snapshot history in v1 — only current equity)
  - `interface Freshness { cryptoLatestCandleMs: number | null; goldStateMtimeMs: number | null; metalsStateMtimeMs: number | null }`
  - `readFreshness(dataDir?: string): Freshness`
  - `interface GovernanceStatus { available: boolean; status: string | null }`
  - `readGovernance(dataDir?: string): GovernanceStatus`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { readEquityCurve, readFreshness, readGovernance } from '../../src/lib/bot/sleeve-readers';

describe('curve/freshness/governance readers', () => {
  it('reads the crypto equity curve and sums current sleeve equity', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_state (id INTEGER PRIMARY KEY, equity REAL);
      CREATE TABLE bot_equity_snapshots (id INTEGER PRIMARY KEY, timestamp INTEGER, equity REAL, drawdown REAL);
      INSERT INTO bot_state VALUES (1, 10050);
      INSERT INTO bot_equity_snapshots (timestamp, equity, drawdown) VALUES (100, 10000, 0), (200, 10050, 0.01);
    `);
    db.close();
    fs.writeFileSync(path.join(dir, 'gold-bot-state.json'), JSON.stringify({ equity: 10200 }));
    const c = readEquityCurve(dir);
    expect(c.crypto).toHaveLength(2);
    expect(c.crypto[1]).toMatchObject({ timestamp: 200, equity: 10050 });
    expect(c.currentEquity.crypto).toBeCloseTo(10050);
    expect(c.currentEquity.gold).toBeCloseTo(10200);
    expect(c.currentEquity.metals).toBeCloseTo(10000); // default when file absent
    expect(c.currentEquity.total).toBeCloseTo(30250);
  });

  it('reads governance status, available:false when file absent', () => {
    expect(readGovernance(dir)).toEqual({ available: false, status: null });
    fs.writeFileSync(path.join(dir, 'book-governance.json'), JSON.stringify({ status: 'WATCH' }));
    expect(readGovernance(dir)).toEqual({ available: true, status: 'WATCH' });
  });

  it('reports freshness nulls on a fresh volume', () => {
    const f = readFreshness(dir);
    expect(f.cryptoLatestCandleMs).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bot/sleeve-readers.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```ts
export interface EquityPoint { timestamp: number; equity: number; drawdown: number }
export interface EquityCurve {
  crypto: EquityPoint[];
  currentEquity: { crypto: number; gold: number; metals: number; total: number };
}

export function readEquityCurve(dataDir: string = defaultDataDir()): EquityCurve {
  const cryptoSummary = readCryptoSleeve(dataDir);
  const gold = readGoldSleeve(dataDir);
  const metals = readMetalsSleeve(dataDir);
  let crypto: EquityPoint[] = [];
  const db = openReadonly(dataDir);
  if (db) {
    try {
      // Only query if the snapshots table exists (older/fresh DBs may lack it).
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_equity_snapshots'").get();
      if (hasTable) {
        crypto = db.prepare('SELECT timestamp, equity, drawdown FROM bot_equity_snapshots ORDER BY timestamp ASC').all() as EquityPoint[];
      }
    } finally {
      db.close();
    }
  }
  const cur = { crypto: cryptoSummary.equity, gold: gold.equity, metals: metals.equity, total: 0 };
  cur.total = cur.crypto + cur.gold + cur.metals;
  return { crypto, currentEquity: cur };
}

export interface Freshness { cryptoLatestCandleMs: number | null; goldStateMtimeMs: number | null; metalsStateMtimeMs: number | null }

function mtimeMs(p: string): number | null {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

export function readFreshness(dataDir: string = defaultDataDir()): Freshness {
  let cryptoLatestCandleMs: number | null = null;
  const db = openReadonly(dataDir);
  if (db) {
    try {
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_candles'").get();
      if (hasTable) {
        const row = db.prepare('SELECT MAX(timestamp) ts FROM bot_candles').get() as { ts: number | null };
        cryptoLatestCandleMs = row?.ts ?? null;
      }
    } finally {
      db.close();
    }
  }
  return {
    cryptoLatestCandleMs,
    goldStateMtimeMs: mtimeMs(path.join(dataDir, 'gold-bot-state.json')),
    metalsStateMtimeMs: mtimeMs(path.join(dataDir, 'metals-bot-state.json')),
  };
}

export interface GovernanceStatus { available: boolean; status: string | null }

export function readGovernance(dataDir: string = defaultDataDir()): GovernanceStatus {
  const d = readJson(path.join(dataDir, 'book-governance.json')) as { status?: string } | null;
  if (!d) return { available: false, status: null };
  return { available: true, status: d.status ?? null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/bot/sleeve-readers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gmp "add equity-curve, freshness, governance readers" feat backend
```

---

## Task 4: `dashboard.book` tRPC router

**Files:**
- Create: `src/lib/trpc/routers/dashboard/book.ts`
- Modify: `src/lib/trpc/routers/dashboard/index.ts`
- Test: `tests/trpc/book-router.test.ts`

**Interfaces:**
- Consumes: all readers from Task 1–3; `router`, `publicProcedure` from `../../init`; `createCallerFactory` from `../../init`.
- Produces `bookRouter` with procedures:
  - `overview` → `{ totalEquity: number; perSleeve: SleeveSummary[]; totalClosedTrades: number; totalOpenPositions: number; activeSleeves: number; idleSleeves: string[]; governance: GovernanceStatus; freshness: Freshness }`
  - `equityCurve` → `EquityCurve`
  - `positions` → `OpenPosition[]`
  - `trades` (input `{ limit?: number }`, default 50, max 200) → `ClosedTrade[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/trpc/book-router.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createCallerFactory } from '../../src/lib/trpc/init';
import { bookRouter } from '../../src/lib/trpc/routers/dashboard/book';

let dir: string;
const createCaller = createCallerFactory(bookRouter);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-'));
  process.env.BOT_DATA_DIR = dir; // router reads from here (see impl note)
});
afterEach(() => {
  delete process.env.BOT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('book router', () => {
  it('overview reports an empty book on a fresh volume without throwing', async () => {
    const caller = createCaller({});
    const o = await caller.overview();
    expect(o.totalClosedTrades).toBe(0);
    expect(o.totalEquity).toBeCloseTo(30000); // 3 sleeves × 10000 default
    expect(o.idleSleeves).toHaveLength(3);
    expect(o.governance.available).toBe(false);
  });

  it('overview aggregates seeded crypto data', async () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, pnl_percent REAL);
      CREATE TABLE bot_state (id INTEGER PRIMARY KEY, equity REAL);
      CREATE TABLE bot_positions (id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO bot_trades VALUES ('a', 2.0);
      INSERT INTO bot_state VALUES (1, 10200);
      INSERT INTO bot_positions VALUES ('p','open');
    `);
    db.close();
    const o = await createCaller({}).overview();
    expect(o.totalClosedTrades).toBe(1);
    expect(o.totalOpenPositions).toBe(1);
    expect(o.activeSleeves).toBe(1);
  });

  it('trades clamps the limit to 200', async () => {
    const t = await createCaller({}).trades({ limit: 9999 });
    expect(Array.isArray(t)).toBe(true); // no throw; clamped internally
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/trpc/book-router.test.ts`
Expected: FAIL — `bookRouter` not found.

- [ ] **Step 3: Write minimal implementation**

Note: readers default to `path.resolve('data')`. To make the router testable with a temp dir, resolve the data dir from `process.env.BOT_DATA_DIR` when set. Add this tiny helper at the top of the router and pass it to every reader call.

```ts
// src/lib/trpc/routers/dashboard/book.ts
import { z } from 'zod';
import path from 'node:path';
import { router, publicProcedure } from '../../init';
import {
  readAllSleeves, readOpenPositions, readRecentTrades, readEquityCurve,
  readFreshness, readGovernance,
} from '../../../bot/sleeve-readers';
import { combineSleeves } from '../../../bot/track-record';

function dataDir(): string {
  return process.env.BOT_DATA_DIR ?? path.resolve('data');
}

export const bookRouter = router({
  overview: publicProcedure.query(() => {
    const perSleeve = readAllSleeves(dataDir());
    const combined = combineSleeves(perSleeve);
    const totalEquity = perSleeve.reduce((a, s) => a + s.equity, 0);
    return {
      totalEquity,
      perSleeve,
      totalClosedTrades: combined.totalClosedTrades,
      totalOpenPositions: combined.totalOpenPositions,
      activeSleeves: combined.activeSleeves,
      idleSleeves: combined.idleSleeves,
      governance: readGovernance(dataDir()),
      freshness: readFreshness(dataDir()),
    };
  }),
  equityCurve: publicProcedure.query(() => readEquityCurve(dataDir())),
  positions: publicProcedure.query(() => readOpenPositions(dataDir())),
  trades: publicProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional())
    .query(({ input }) => readRecentTrades(input?.limit ?? 50, dataDir())),
});
```

Register in `src/lib/trpc/routers/dashboard/index.ts`:
```ts
import { bookRouter } from './book';
// ...inside router({ ... }):
  book: bookRouter,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/trpc/book-router.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (router type flows to the client `AppRouter`)**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
gmp "add dashboard.book read-only tRPC router" feat backend
```

---

## Task 5: UI — consolidated book page

**Files:**
- Create: `src/lib/bot/format.ts`, `src/components/live-trading/{BookHeader,SleeveCards,OpenPositionsTable,RecentTradesTable,EquityCurveChart}.tsx`
- Modify: `src/app/live-trading/page.tsx` (full rewrite)
- Test: `tests/bot/format.test.ts`

**Interfaces:**
- Consumes: `trpc.dashboard.book.{overview,equityCurve,positions,trades}.useQuery` from `src/lib/trpc/client`.
- Produces pure helpers in `format.ts`:
  - `formatUsd(n: number): string` → e.g. `$10,050.00`
  - `formatPnlPct(n: number): string` → sign-prefixed, 2dp, e.g. `+2.00%`
  - `sleeveStatusLabel(s: { closedTrades: number; openPositions: number }): string` → `'flat'` | `'in position'` | `'active'`

- [ ] **Step 1: Write the failing test for the pure helpers**

```ts
// tests/bot/format.test.ts
import { describe, it, expect } from 'vitest';
import { formatUsd, formatPnlPct, sleeveStatusLabel } from '../../src/lib/bot/format';

describe('format helpers', () => {
  it('formats USD and signed pnl%', () => {
    expect(formatUsd(10050)).toBe('$10,050.00');
    expect(formatPnlPct(2)).toBe('+2.00%');
    expect(formatPnlPct(-0.5)).toBe('-0.50%');
  });
  it('labels sleeve status', () => {
    expect(sleeveStatusLabel({ closedTrades: 0, openPositions: 0 })).toBe('flat');
    expect(sleeveStatusLabel({ closedTrades: 0, openPositions: 1 })).toBe('in position');
    expect(sleeveStatusLabel({ closedTrades: 3, openPositions: 0 })).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bot/format.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `format.ts`**

```ts
// src/lib/bot/format.ts
export function formatUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function formatPnlPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}
export function sleeveStatusLabel(s: { closedTrades: number; openPositions: number }): string {
  if (s.openPositions > 0) return 'in position';
  if (s.closedTrades > 0) return 'active';
  return 'flat';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/bot/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the components + rewrite the page**

`EquityCurveChart.tsx` (Lightweight Charts area series; guards empty data):
```tsx
'use client';
import { useEffect, useRef } from 'react';
import { createChart, ColorType, type IChartApi } from 'lightweight-charts';

export function EquityCurveChart({ points }: { points: Array<{ timestamp: number; equity: number }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#9ca3af' },
      grid: { horzLines: { color: '#1f2937' }, vertLines: { color: '#1f2937' } },
      height: 260, autoSize: true,
    });
    const series = chart.addAreaSeries({ lineColor: '#22d3ee', topColor: 'rgba(34,211,238,0.3)', bottomColor: 'rgba(34,211,238,0)' });
    series.setData(points.map((p) => ({ time: Math.floor(p.timestamp / 1000) as never, value: p.equity })));
    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => chart.remove();
  }, [points]);
  if (points.length === 0) {
    return <div className="h-[260px] flex items-center justify-center text-gray-500 text-sm">No equity history yet — the book started flat.</div>;
  }
  return <div ref={ref} className="w-full" />;
}
```

`BookHeader.tsx`, `SleeveCards.tsx`, `OpenPositionsTable.tsx`, `RecentTradesTable.tsx`: each `'use client'`, call the matching `trpc.dashboard.book.*.useQuery(undefined, { refetchInterval: 30_000 })` (or `{ limit: 50 }` for trades), render with `formatUsd`/`formatPnlPct`, and show a `q.isLoading` skeleton and a `q.error` inline message. Follow the existing dashboard component style (Tailwind, dark theme) as in `src/components/dashboard/*`. Green for `pnl >= 0`, red otherwise. Each table shows a sleeve tag column.

`src/app/live-trading/page.tsx` — replace the whole file:
```tsx
'use client';
import { trpc } from '@/lib/trpc/client';
import { BookHeader } from '@/components/live-trading/BookHeader';
import { EquityCurveChart } from '@/components/live-trading/EquityCurveChart';
import { OpenPositionsTable } from '@/components/live-trading/OpenPositionsTable';
import { RecentTradesTable } from '@/components/live-trading/RecentTradesTable';
import { SleeveCards } from '@/components/live-trading/SleeveCards';

export default function LiveTradingPage() {
  const curve = trpc.dashboard.book.equityCurve.useQuery(undefined, { refetchInterval: 30_000 });
  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <h1 className="text-3xl font-bold">Paper Fleet — Live Book</h1>
      <BookHeader />
      <section className="rounded-lg border border-gray-800 p-4">
        <h2 className="text-lg font-semibold mb-2">Combined equity (crypto series)</h2>
        <EquityCurveChart points={curve.data?.crypto ?? []} />
      </section>
      <SleeveCards />
      <OpenPositionsTable />
      <RecentTradesTable />
    </main>
  );
}
```
(Confirm the `@/` alias resolves to `src/` via `tsconfig.json` `paths`; if the codebase uses relative imports in pages, match that instead.)

- [ ] **Step 6: Verify the whole app compiles**

Run: `pnpm build`
Expected: `next build` succeeds (this typechecks + compiles every route). If a pre-existing unrelated route fails to build due to an `--ignore-scripts` native dep (e.g. `@tensorflow/tfjs-node`), note it and make that import dynamic/lazy or guard it — do not expand scope beyond making the build pass.

- [ ] **Step 7: Manual smoke (local)**

Run: `pnpm build && pnpm start` then open `http://localhost:3000/live-trading`. Expect the page to render against the local `data/ict-trading.db` (header equity, empty/near-empty tables, flat curve message). Ctrl-C when done.

- [ ] **Step 8: Commit**

```bash
gmp "build consolidated live book UI" feat admin
```

---

## Task 6: Deploy — build Next.js in the image, run as non-core process

**Files:**
- Modify: `Dockerfile`, `scripts/docker-entrypoint.sh`, `RAILWAY-DEPLOY.md`

**Interfaces:** none (deployment).

- [ ] **Step 1: Confirm `pnpm build` passes locally first (fail-fast gate)**

Run: `pnpm build`
Expected: success. Do not touch the Dockerfile until this passes.

- [ ] **Step 2: Dockerfile — copy configs + public, build Next.js**

Set `ENV NODE_ENV=production` BEFORE the build. After the existing `COPY scripts/ ./scripts/` line, and before `chmod`, add:
```dockerfile
# Next.js needs its config, PostCSS/Tailwind config, and public assets to build.
COPY next.config.ts postcss.config.mjs ./
COPY public/ ./public/

# Build the web dashboard (the fleet's read-only UI). next build always compiles
# in production mode; devDeps are present (install was not --prod).
ENV NODE_ENV=production
RUN pnpm build
```
(Remove the later duplicate `ENV ... NODE_ENV=production` or keep only `HOME`; do not set NODE_ENV twice with conflicting placement.)

- [ ] **Step 3: Entrypoint — launch `next start` as a non-core process**

In `scripts/docker-entrypoint.sh`, after the orderflow collector block and before the `echo "  crypto=..."` line, add:
```sh
# 6. Read-only web dashboard (non-core: if it dies, trading continues).
npx next start -p "${PORT:-3000}" &
UI_PID=$!
```
Update the summary echo to include `ui=$UI_PID`. Add `$UI_PID` to the `kill` list in `cleanup()`. Do NOT add it to `CORE_PIDS`. Extend the non-fatal warning block so a dead UI logs a warning like the orderflow collector (mirror the `FLOW_WARNED` pattern with a `UI_WARNED` flag), and include `$UI_PID` in the final kill on core-exit.

- [ ] **Step 4: Local Docker validation**

```bash
docker build -t ict-fleet-ui . && \
docker run --rm -e PORT=3000 -p 3000:3000 -v "$PWD/.docker-data:/app/data" ict-fleet-ui
```
Expected logs: `=== Starting ICT paper fleet (5 processes) ===` (message text can stay), all bots + `ui=` PID, crypto `BTCUSDT: 2499 candles cached`, and `next start` printing `Ready on http://...:3000`. Open `http://localhost:3000/live-trading` → the book renders. Ctrl-C; confirm clean shutdown.

- [ ] **Step 5: Update `RAILWAY-DEPLOY.md`**

Add a "Web dashboard" section: the fleet now also serves a read-only UI on `$PORT`; in Railway enable **public networking / generate a domain** for the service (Settings → Networking), and ensure the machine has **≥2 GB RAM** (5 bots + Next.js). The UI is view-only and needs no auth (paper). Reachable at `https://<domain>/live-trading`.

- [ ] **Step 6: Commit**

```bash
gmp "serve read-only dashboard from the fleet container" feat build
```

- [ ] **Step 7: Deploy + verify on Railway**

Merge to `main` via `deploy` (staging), or push the branch and deploy. Then:
```bash
railway logs --service ict-paper-fleet --deployment --lines 80
```
Expected: all bots start, crypto backfills 2499 candles, `next start` Ready. Enable the public domain, open `https://<domain>/live-trading`, confirm the book renders live against the Railway volume. Confirm the deployment status is SUCCESS and does not crash-loop.

---

## Self-Review

**Spec coverage:**
- Same-container deploy → Task 6. ✓
- Consolidated book (crypto+gold+metals) → Tasks 1–3 readers, Task 4 router, Task 5 UI. ✓
- View-only, no auth → no control procedures anywhere; router is all `query`. ✓
- WAL/concurrency → readers open `readonly` + `busy_timeout`; WAL already set by bots (`src/lib/data/db.ts`). ✓
- Per-sleeve `available:false` resilience → readers guard missing files; `readGovernance` returns `available:false`. ✓
- Empty book valid state → Task 4 test asserts empty overview; Task 5 chart shows "started flat". ✓
- Endpoints overview/equityCurve/positions/trades → Task 4. ✓
- 30s polling → Task 5 `refetchInterval: 30_000`. ✓
- 2 GB + public networking → Task 6 steps 5,7. ✓
- Tests for aggregation → Tasks 1–4. ✓
- Deploy gate (typecheck/lint/build) → Task 5 step 6, Task 6 step 1. ✓

**Placeholder scan:** The only intentional flexibility is Task 5 components following the existing `src/components/dashboard/*` visual style rather than pinned markup — acceptable (style match, not logic). No TODO/TBD.

**Type consistency:** `SleeveSummary` (from track-record.ts) is reused unchanged. `OpenPosition`/`ClosedTrade`/`EquityCurve`/`Freshness`/`GovernanceStatus` are defined in Task 2/3 and consumed unchanged in Task 4. Router procedure names (`overview`/`equityCurve`/`positions`/`trades`) match Task 5's `useQuery` calls. `BOT_DATA_DIR` env override defined in Task 4 impl and used by its tests.
