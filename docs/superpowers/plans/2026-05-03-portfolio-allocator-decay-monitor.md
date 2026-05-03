# Portfolio Allocator + Decay Monitor + Live-Paper Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the advisory inverse-vol portfolio allocator, the bootstrap-floor decay monitor, and the live-paper audit doc described in the 2026-05-03 spec.

**Architecture:** Two read-only standalone scripts (`run-allocator.ts` weekly, `run-monitor.ts` daily) on top of a shared `src/lib/portfolio/` library. Library has four files: `types.ts` (shared types), `equity-source.ts` (adapter over crypto SQLite + gold JSON), `allocator.ts` (pure inverse-vol math), `decay-monitor.ts` (bootstrap-floor + drawdown tripwires) plus a `bootstrap-floors.ts` loader that reads validation JSONs in `experiments/`. Both scripts are added to `ecosystem.config.cjs` as cron-style PM2 entries. No bot code is modified — outputs go to `data/*.json` + Telegram. A3 is a read-only audit producing one markdown doc.

**Tech Stack:** TypeScript (strict), `better-sqlite3` + Drizzle (already present), `tsx` for script execution, **Vitest** (added in Task 0 — project currently has no test framework), Telegram via existing `AlertManager`.

---

## File Structure

**Create:**
- `vitest.config.ts` — test runner config
- `src/lib/portfolio/types.ts` — `StrategyId`, `EquityPoint`, `AllocatorResult`, `DecayStatus`
- `src/lib/portfolio/equity-source.ts` — readers + UTC resampling + return computation
- `src/lib/portfolio/allocator.ts` — inverse-vol weight calculation
- `src/lib/portfolio/bootstrap-floors.ts` — loads 5th-pct + MaxDD from validation JSONs
- `src/lib/portfolio/decay-monitor.ts` — tripwire evaluation
- `src/lib/portfolio/index.ts` — barrel exports
- `tests/portfolio/equity-source.test.ts`
- `tests/portfolio/allocator.test.ts`
- `tests/portfolio/bootstrap-floors.test.ts`
- `tests/portfolio/decay-monitor.test.ts`
- `scripts/run-allocator.ts` — weekly cron entry
- `scripts/run-monitor.ts` — daily cron entry
- `docs/live-paper-audit-2026-05-03.md` — A3 deliverable

**Modify:**
- `package.json` — add `vitest`, `@vitest/ui` dev deps + `test` script
- `ecosystem.config.cjs` — add `allocator-cron` + `monitor-cron` PM2 entries

---

### Task 0: Set up Vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/sanity.test.ts`

- [ ] **Step 1: Install Vitest**

```bash
pnpm add -D vitest @vitest/ui
```

Expected: clean install, `vitest` appears under `devDependencies`.

- [ ] **Step 2: Add test scripts to package.json**

In `package.json` `scripts`, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Write sanity test**

`tests/sanity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('vitest setup', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

```bash
pnpm test
```

Expected: `1 passed`.

- [ ] **Step 6: Commit**

```bash
gmp "add vitest test framework" chore config
```

---

### Task 1: Shared types

**Files:**
- Create: `src/lib/portfolio/types.ts`

- [ ] **Step 1: Write the types**

```ts
export type StrategyId = 'ict-3sym' | 'ict-7sym' | 'f2f-gold';

export interface EquityPoint {
  timestamp: number; // ms epoch
  equity: number;
}

export interface StrategyAllocation {
  strategy: StrategyId;
  weight: number; // [0, 1]
  annualizedVol: number; // e.g., 0.45 = 45%/yr
  recommendedRiskPerTrade: number; // e.g., 0.0018 = 0.18%
  currentRiskPerTrade: number;
  excluded?: { reason: string };
}

export interface AllocatorResult {
  generatedAt: number;
  lookbackDays: number;
  totalCurrentRiskBudget: number;
  allocations: StrategyAllocation[];
  warnings: string[];
}

export interface DecayStatus {
  strategy: StrategyId;
  liveSharpe30d: number | null;
  bootstrapFloor: number | null;
  liveDrawdown90d: number | null;
  drawdownCeiling: number | null;
  tripped: boolean;
  reason?: string;
}

export interface MonitorResult {
  generatedAt: number;
  statuses: DecayStatus[];
  warnings: string[];
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
gmp "add portfolio shared types" feat backend
```

---

### Task 2: equity-source — UTC daily resampling (pure function, TDD)

**Files:**
- Create: `tests/portfolio/equity-source.test.ts`
- Create: `src/lib/portfolio/equity-source.ts`

- [ ] **Step 1: Write the failing test**

`tests/portfolio/equity-source.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resampleToUtcDaily } from '@/lib/portfolio/equity-source';
import type { EquityPoint } from '@/lib/portfolio/types';

const D = (utc: string) => new Date(utc).getTime();

describe('resampleToUtcDaily', () => {
  it('keeps the last point at-or-before each UTC midnight', () => {
    const points: EquityPoint[] = [
      { timestamp: D('2026-01-01T05:00:00Z'), equity: 1000 },
      { timestamp: D('2026-01-01T18:00:00Z'), equity: 1010 },
      { timestamp: D('2026-01-02T03:00:00Z'), equity: 1020 },
      { timestamp: D('2026-01-02T20:00:00Z'), equity: 1015 },
      { timestamp: D('2026-01-03T01:00:00Z'), equity: 1030 },
    ];
    const out = resampleToUtcDaily(points);
    expect(out).toEqual([
      { timestamp: D('2026-01-01T00:00:00Z'), equity: 1010 },
      { timestamp: D('2026-01-02T00:00:00Z'), equity: 1015 },
      { timestamp: D('2026-01-03T00:00:00Z'), equity: 1030 },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(resampleToUtcDaily([])).toEqual([]);
  });

  it('drops days with no samples (gap)', () => {
    const points: EquityPoint[] = [
      { timestamp: D('2026-01-01T12:00:00Z'), equity: 1000 },
      { timestamp: D('2026-01-04T12:00:00Z'), equity: 1100 },
    ];
    const out = resampleToUtcDaily(points);
    expect(out.map((p) => new Date(p.timestamp).toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z',
    ]);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
pnpm test tests/portfolio/equity-source.test.ts
```

Expected: FAIL — module not found / `resampleToUtcDaily` not exported.

- [ ] **Step 3: Implement minimal version**

`src/lib/portfolio/equity-source.ts`:

```ts
import type { EquityPoint } from './types';

const MS_PER_DAY = 86_400_000;

function utcMidnightFloor(ts: number): number {
  return Math.floor(ts / MS_PER_DAY) * MS_PER_DAY;
}

export function resampleToUtcDaily(points: EquityPoint[]): EquityPoint[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
  const byDay = new Map<number, EquityPoint>();
  for (const p of sorted) {
    const day = utcMidnightFloor(p.timestamp);
    byDay.set(day, { timestamp: day, equity: p.equity });
  }
  return [...byDay.values()].sort((a, b) => a.timestamp - b.timestamp);
}
```

- [ ] **Step 4: Run, verify pass**

```bash
pnpm test tests/portfolio/equity-source.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
gmp "add UTC daily resampling for equity series" feat backend
```

---

### Task 3: equity-source — daily returns from equity series

**Files:**
- Modify: `tests/portfolio/equity-source.test.ts`
- Modify: `src/lib/portfolio/equity-source.ts`

- [ ] **Step 1: Append failing tests**

Add to `tests/portfolio/equity-source.test.ts`:

```ts
import { toDailyReturns } from '@/lib/portfolio/equity-source';

describe('toDailyReturns', () => {
  it('computes simple daily returns from a daily-resampled series', () => {
    const series: EquityPoint[] = [
      { timestamp: D('2026-01-01T00:00:00Z'), equity: 1000 },
      { timestamp: D('2026-01-02T00:00:00Z'), equity: 1010 },
      { timestamp: D('2026-01-03T00:00:00Z'), equity: 990 },
    ];
    const r = toDailyReturns(series);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.01, 6);
    expect(r[1]).toBeCloseTo(-0.01980198, 6);
  });

  it('returns empty when fewer than 2 points', () => {
    expect(toDailyReturns([])).toEqual([]);
    expect(
      toDailyReturns([{ timestamp: 0, equity: 100 }]),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm test tests/portfolio/equity-source.test.ts
```

Expected: FAIL — `toDailyReturns` not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/portfolio/equity-source.ts`:

```ts
export function toDailyReturns(series: EquityPoint[]): number[] {
  if (series.length < 2) return [];
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.equity;
    const curr = series[i]!.equity;
    if (prev === 0) continue;
    out.push(curr / prev - 1);
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
pnpm test tests/portfolio/equity-source.test.ts
```

Expected: 5 passed (3 + 2).

- [ ] **Step 5: Commit**

```bash
gmp "add daily returns computation from equity series" feat backend
```

---

### Task 4: equity-source — crypto bot SQLite reader

**Files:**
- Modify: `tests/portfolio/equity-source.test.ts`
- Modify: `src/lib/portfolio/equity-source.ts`

- [ ] **Step 1: Discover the crypto equity table schema**

Read `src/lib/data/schema.ts` and find the `botEquitySnapshots` table. Note its column names exactly (e.g., `equity`, `timestamp`, `botId` if present).

```bash
grep -n -A12 "botEquitySnapshots\|bot_equity_snapshots" src/lib/data/schema.ts
```

Record: column names + whether there's a strategy/bot identifier column. If there is one, the reader filters by it. If not, the reader reads the whole table (single-bot DB).

- [ ] **Step 2: Write the failing test using an in-memory DB**

Append to `tests/portfolio/equity-source.test.ts`:

```ts
import Database from 'better-sqlite3';
import { readCryptoEquityFromDb } from '@/lib/portfolio/equity-source';

function makeFixtureDb(): Database.Database {
  const db = new Database(':memory:');
  // Match the production schema columns discovered in Step 1.
  // The test creates a minimal table with only the columns the reader uses.
  db.exec(`
    CREATE TABLE bot_equity_snapshots (
      id INTEGER PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      equity REAL NOT NULL
    )
  `);
  const insert = db.prepare(
    'INSERT INTO bot_equity_snapshots (timestamp, equity) VALUES (?, ?)',
  );
  insert.run(D('2026-01-01T05:00:00Z'), 1000);
  insert.run(D('2026-01-01T18:00:00Z'), 1010);
  insert.run(D('2026-01-02T03:00:00Z'), 1020);
  return db;
}

describe('readCryptoEquityFromDb', () => {
  it('returns rows ordered by timestamp', () => {
    const db = makeFixtureDb();
    const rows = readCryptoEquityFromDb(db);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.equity).toBe(1000);
    expect(rows[2]!.equity).toBe(1020);
  });

  it('returns empty when table is empty', () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE bot_equity_snapshots (id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, equity REAL NOT NULL)',
    );
    expect(readCryptoEquityFromDb(db)).toEqual([]);
  });
});
```

> If Step 1 found a strategy/bot identifier column, add a third test asserting filtering by that column. Mirror the column name exactly.

- [ ] **Step 3: Run, verify fail**

```bash
pnpm test tests/portfolio/equity-source.test.ts
```

Expected: FAIL — `readCryptoEquityFromDb` not exported.

- [ ] **Step 4: Implement**

Append to `src/lib/portfolio/equity-source.ts`:

```ts
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

interface EquityRow { timestamp: number; equity: number; }

export function readCryptoEquityFromDb(
  db: BetterSqlite3Database,
): EquityPoint[] {
  const rows = db
    .prepare(
      'SELECT timestamp, equity FROM bot_equity_snapshots ORDER BY timestamp ASC',
    )
    .all() as EquityRow[];
  return rows.map((r) => ({ timestamp: r.timestamp, equity: r.equity }));
}
```

> If Step 1 found a filter column, change the SELECT to `WHERE <column> = ?` and accept that filter as a second argument. Update tests to match.

- [ ] **Step 5: Run, verify pass**

```bash
pnpm test tests/portfolio/equity-source.test.ts
```

Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
gmp "add crypto bot equity reader for portfolio layer" feat backend
```

---

### Task 5: equity-source — gold bot JSON reader

**Files:**
- Modify: `tests/portfolio/equity-source.test.ts`
- Modify: `src/lib/portfolio/equity-source.ts`

- [ ] **Step 1: Inspect the gold state structure**

```bash
head -20 data/gold-bot-state.json
```

Note: `equity` is a current scalar; `rolling30dReturns` is the pre-computed daily-return array. We use `rolling30dReturns` directly (skips re-deriving returns from a single-point equity series).

- [ ] **Step 2: Write failing test**

Append to `tests/portfolio/equity-source.test.ts`:

```ts
import { readGoldDailyReturnsFromJson } from '@/lib/portfolio/equity-source';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function writeGoldFixture(state: object): string {
  const p = path.join(os.tmpdir(), `gold-fixture-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(state));
  return p;
}

describe('readGoldDailyReturnsFromJson', () => {
  it('returns the rolling30dReturns array', () => {
    const p = writeGoldFixture({
      equity: 10500,
      initialCapital: 10000,
      rolling30dReturns: [0.01, -0.005, 0.02, 0],
    });
    expect(readGoldDailyReturnsFromJson(p)).toEqual([0.01, -0.005, 0.02, 0]);
  });

  it('returns empty when state is missing the field', () => {
    const p = writeGoldFixture({ equity: 10000 });
    expect(readGoldDailyReturnsFromJson(p)).toEqual([]);
  });

  it('returns empty when file does not exist', () => {
    expect(
      readGoldDailyReturnsFromJson('/tmp/definitely-not-real-12345.json'),
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: Run, verify fail**

```bash
pnpm test tests/portfolio/equity-source.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement**

Append to `src/lib/portfolio/equity-source.ts`:

```ts
import * as fs from 'node:fs';

export function readGoldDailyReturnsFromJson(filePath: string): number[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { rolling30dReturns?: number[] };
    if (!Array.isArray(parsed.rolling30dReturns)) return [];
    return parsed.rolling30dReturns.filter(
      (r): r is number => typeof r === 'number' && Number.isFinite(r),
    );
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run, verify pass**

```bash
pnpm test tests/portfolio/equity-source.test.ts
```

Expected: 10 passed.

- [ ] **Step 6: Commit**

```bash
gmp "add gold bot returns reader for portfolio layer" feat backend
```

---

### Task 6: equity-source — top-level router `getDailyReturns(strategy, days)`

**Files:**
- Modify: `tests/portfolio/equity-source.test.ts`
- Modify: `src/lib/portfolio/equity-source.ts`

- [ ] **Step 1: Write failing test**

Append:

```ts
import {
  getDailyReturnsForStrategy,
  type EquitySources,
} from '@/lib/portfolio/equity-source';

describe('getDailyReturnsForStrategy', () => {
  it('routes ict-3sym through the crypto reader and returns truncated tail', () => {
    const db = makeFixtureDb();
    // Add daily snapshots for 5 distinct UTC days
    const insert = db.prepare(
      'INSERT INTO bot_equity_snapshots (timestamp, equity) VALUES (?, ?)',
    );
    insert.run(D('2026-01-04T12:00:00Z'), 1030);
    insert.run(D('2026-01-05T12:00:00Z'), 1040);

    const sources: EquitySources = {
      cryptoDb: db,
      goldStatePath: '/tmp/missing.json',
    };
    const r = getDailyReturnsForStrategy('ict-3sym', 60, sources);
    // 4 distinct UTC days resampled → 3 daily returns
    expect(r).toHaveLength(3);
  });

  it('routes f2f-gold through the gold reader', () => {
    const p = writeGoldFixture({
      rolling30dReturns: Array(40).fill(0.001),
    });
    const sources: EquitySources = {
      cryptoDb: null,
      goldStatePath: p,
    };
    const r = getDailyReturnsForStrategy('f2f-gold', 30, sources);
    expect(r).toHaveLength(30); // last 30 of 40
  });
});
```

- [ ] **Step 2: Run, verify fail**

Expected: FAIL — symbols not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/portfolio/equity-source.ts`:

```ts
import type { StrategyId } from './types';

export interface EquitySources {
  cryptoDb: BetterSqlite3Database | null;
  goldStatePath: string;
}

export function getDailyReturnsForStrategy(
  strategy: StrategyId,
  lookbackDays: number,
  sources: EquitySources,
): number[] {
  if (strategy === 'f2f-gold') {
    const all = readGoldDailyReturnsFromJson(sources.goldStatePath);
    return all.slice(-lookbackDays);
  }
  // ict-3sym, ict-7sym both come from the crypto bot DB.
  // 7-sym is currently unused — same source, same shape; the strategy
  // identifier is here to support future per-strategy filtering.
  if (!sources.cryptoDb) return [];
  const series = readCryptoEquityFromDb(sources.cryptoDb);
  const daily = resampleToUtcDaily(series);
  const truncated = daily.slice(-(lookbackDays + 1));
  return toDailyReturns(truncated);
}
```

- [ ] **Step 4: Run, verify pass**

Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
gmp "route strategies through equity-source per StrategyId" feat backend
```

---

### Task 7: allocator — inverse-vol weights (pure function, TDD)

**Files:**
- Create: `tests/portfolio/allocator.test.ts`
- Create: `src/lib/portfolio/allocator.ts`

- [ ] **Step 1: Write failing test**

`tests/portfolio/allocator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeInverseVolWeights } from '@/lib/portfolio/allocator';

describe('computeInverseVolWeights', () => {
  it('gives equal weight when vols are equal', () => {
    const inputs = [
      { strategy: 'ict-3sym' as const, dailyReturns: [0.01, -0.01, 0.01, -0.01] },
      { strategy: 'f2f-gold' as const, dailyReturns: [0.01, -0.01, 0.01, -0.01] },
    ];
    const r = computeInverseVolWeights(inputs);
    expect(r.allocations).toHaveLength(2);
    expect(r.allocations[0]!.weight).toBeCloseTo(0.5, 6);
    expect(r.allocations[1]!.weight).toBeCloseTo(0.5, 6);
    expect(r.warnings).toEqual([]);
  });

  it('underweights the higher-vol strategy', () => {
    const lowVol = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.001 : -0.001));
    const highVol = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const r = computeInverseVolWeights([
      { strategy: 'ict-3sym', dailyReturns: highVol },
      { strategy: 'f2f-gold', dailyReturns: lowVol },
    ]);
    const crypto = r.allocations.find((a) => a.strategy === 'ict-3sym')!;
    const gold = r.allocations.find((a) => a.strategy === 'f2f-gold')!;
    expect(gold.weight).toBeGreaterThan(crypto.weight);
    expect(crypto.weight + gold.weight).toBeCloseTo(1, 6);
  });

  it('excludes a strategy with fewer than 30 returns and warns', () => {
    const r = computeInverseVolWeights([
      { strategy: 'ict-3sym', dailyReturns: Array(50).fill(0).map((_, i) => (i % 2 ? 0.005 : -0.005)) },
      { strategy: 'f2f-gold', dailyReturns: [0.01, -0.01, 0.01] }, // cold start
    ]);
    expect(r.allocations.find((a) => a.strategy === 'ict-3sym')!.weight).toBeCloseTo(1, 6);
    const gold = r.allocations.find((a) => a.strategy === 'f2f-gold')!;
    expect(gold.excluded?.reason).toMatch(/insufficient/i);
    expect(gold.weight).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('returns annualized vol on each allocation', () => {
    const constantVol = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const r = computeInverseVolWeights([
      { strategy: 'ict-3sym', dailyReturns: constantVol },
    ]);
    // stdev of [0.01, -0.01, 0.01, -0.01, ...] is 0.01; annualized = 0.01 * sqrt(252) ≈ 0.1587
    expect(r.allocations[0]!.annualizedVol).toBeCloseTo(0.01 * Math.sqrt(252), 3);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/portfolio/allocator.ts`:

```ts
import type {
  AllocatorResult,
  StrategyAllocation,
  StrategyId,
} from './types';

const TRADING_DAYS = 252;
const MIN_RETURNS_FOR_VOL = 30;

interface AllocatorInput {
  strategy: StrategyId;
  dailyReturns: number[];
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance =
    xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function computeInverseVolWeights(
  inputs: AllocatorInput[],
  opts: { lookbackDays?: number } = {},
): Pick<AllocatorResult, 'allocations' | 'warnings'> {
  const warnings: string[] = [];
  const includable: { strategy: StrategyId; annualizedVol: number }[] = [];
  const excluded: StrategyAllocation[] = [];

  for (const inp of inputs) {
    if (inp.dailyReturns.length < MIN_RETURNS_FOR_VOL) {
      warnings.push(
        `${inp.strategy}: insufficient data (${inp.dailyReturns.length} returns < ${MIN_RETURNS_FOR_VOL} required) — excluded from allocation`,
      );
      excluded.push({
        strategy: inp.strategy,
        weight: 0,
        annualizedVol: 0,
        recommendedRiskPerTrade: 0,
        currentRiskPerTrade: 0,
        excluded: { reason: `insufficient data: ${inp.dailyReturns.length} returns` },
      });
      continue;
    }
    const dailyVol = stdev(inp.dailyReturns);
    const annualizedVol = dailyVol * Math.sqrt(TRADING_DAYS);
    if (annualizedVol === 0) {
      warnings.push(`${inp.strategy}: zero volatility — excluded`);
      excluded.push({
        strategy: inp.strategy,
        weight: 0,
        annualizedVol: 0,
        recommendedRiskPerTrade: 0,
        currentRiskPerTrade: 0,
        excluded: { reason: 'zero volatility' },
      });
      continue;
    }
    includable.push({ strategy: inp.strategy, annualizedVol });
  }

  const totalInvVol = includable.reduce((s, x) => s + 1 / x.annualizedVol, 0);
  const included: StrategyAllocation[] = includable.map((x) => ({
    strategy: x.strategy,
    weight: 1 / x.annualizedVol / totalInvVol,
    annualizedVol: x.annualizedVol,
    recommendedRiskPerTrade: 0, // filled in by caller knowing total budget
    currentRiskPerTrade: 0,
  }));

  return { allocations: [...included, ...excluded], warnings };
}
```

- [ ] **Step 4: Run, verify pass**

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
gmp "add inverse-vol weight calculation" feat backend
```

---

### Task 8: bootstrap-floors loader

**Files:**
- Create: `tests/portfolio/bootstrap-floors.test.ts`
- Create: `src/lib/portfolio/bootstrap-floors.ts`

- [ ] **Step 1: Discover existing validation file shapes**

```bash
ls experiments/ | grep -iE "validation|pbo|monte"
head -80 experiments/f2f-validation-results.json
ls experiments/pbo-results-3sym-run20.json 2>/dev/null && head -40 experiments/pbo-results-3sym-run20.json
```

Record exactly: where in the JSON each strategy's "MC Bootstrap Sharpe 5th" value lives. The F2F file has it at `checks[]` with `name: "MC Bootstrap Sharpe 5th >0"`. The PBO file may have a different shape. **If the ICT 3-sym bootstrap value is not present in any committed JSON file, add a constant fallback in the loader** (the spec lists 3.03 from validation memory).

- [ ] **Step 2: Write failing test**

`tests/portfolio/bootstrap-floors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseF2fValidationFloor,
  loadBootstrapFloors,
} from '@/lib/portfolio/bootstrap-floors';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('parseF2fValidationFloor', () => {
  it('extracts the bootstrap Sharpe 5th from the checks array', () => {
    const obj = {
      checks: [
        { name: 'Walk-Forward >=60%', value: '51.1%', pass: false },
        { name: 'MC Bootstrap Sharpe 5th >0', value: '1.41', pass: true },
      ],
    };
    expect(parseF2fValidationFloor(obj)).toBeCloseTo(1.41, 4);
  });

  it('returns null when the check is missing', () => {
    expect(parseF2fValidationFloor({ checks: [] })).toBeNull();
    expect(parseF2fValidationFloor({})).toBeNull();
  });
});

describe('loadBootstrapFloors', () => {
  it('returns a Map with floors for known strategies', () => {
    // Use a temp dir that mimics the experiments/ layout
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floors-'));
    fs.writeFileSync(
      path.join(tmp, 'f2f-validation-results.json'),
      JSON.stringify({
        checks: [{ name: 'MC Bootstrap Sharpe 5th >0', value: '1.41', pass: true }],
      }),
    );
    const floors = loadBootstrapFloors(tmp);
    expect(floors.get('f2f-gold')).toBeCloseTo(1.41, 4);
  });

  it('falls back to memory constants when validation files are missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floors-empty-'));
    const floors = loadBootstrapFloors(tmp);
    // Memory constants from the spec
    expect(floors.get('ict-3sym')).toBeCloseTo(3.03, 4);
    expect(floors.get('ict-7sym')).toBeCloseTo(0.72, 4);
  });
});
```

- [ ] **Step 3: Run, verify fail**

Expected: FAIL.

- [ ] **Step 4: Implement**

`src/lib/portfolio/bootstrap-floors.ts`:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StrategyId } from './types';

// Memory-of-record fallbacks from the 2026-05-03 spec.
// Used when a validation JSON file is absent or malformed.
const FALLBACK_FLOORS: Record<StrategyId, number> = {
  'ict-3sym': 3.03,
  'ict-7sym': 0.72,
  'f2f-gold': 1.41,
};

const FALLBACK_DRAWDOWN_CEILINGS: Record<StrategyId, number> = {
  'ict-3sym': 0.633,
  'ict-7sym': 0.805,
  'f2f-gold': 0.153,
};

export function parseF2fValidationFloor(obj: unknown): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const checks = (obj as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return null;
  const match = checks.find(
    (c: unknown) =>
      c &&
      typeof c === 'object' &&
      typeof (c as { name?: unknown }).name === 'string' &&
      ((c as { name: string }).name).includes('MC Bootstrap Sharpe 5th'),
  );
  if (!match) return null;
  const valueStr = (match as { value?: unknown }).value;
  if (typeof valueStr !== 'string') return null;
  const parsed = parseFloat(valueStr);
  return Number.isFinite(parsed) ? parsed : null;
}

function tryLoadJson(p: string): unknown | null {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function loadBootstrapFloors(experimentsDir: string): Map<StrategyId, number> {
  const result = new Map<StrategyId, number>();

  // f2f-gold
  const f2f = tryLoadJson(path.join(experimentsDir, 'f2f-validation-results.json'));
  const f2fFloor = parseF2fValidationFloor(f2f);
  result.set('f2f-gold', f2fFloor ?? FALLBACK_FLOORS['f2f-gold']);

  // ict-3sym, ict-7sym: no parsed file shape committed yet → fallback to memory.
  // When PBO/MC artifacts standardize a shape, add parsers here.
  result.set('ict-3sym', FALLBACK_FLOORS['ict-3sym']);
  result.set('ict-7sym', FALLBACK_FLOORS['ict-7sym']);

  return result;
}

export function loadDrawdownCeilings(): Map<StrategyId, number> {
  const m = new Map<StrategyId, number>();
  for (const k of Object.keys(FALLBACK_DRAWDOWN_CEILINGS) as StrategyId[]) {
    m.set(k, FALLBACK_DRAWDOWN_CEILINGS[k]);
  }
  return m;
}
```

- [ ] **Step 5: Run, verify pass**

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
gmp "add bootstrap floor loader with memory fallbacks" feat backend
```

---

### Task 9: decay-monitor — bootstrap-floor + drawdown tripwires

**Files:**
- Create: `tests/portfolio/decay-monitor.test.ts`
- Create: `src/lib/portfolio/decay-monitor.ts`

- [ ] **Step 1: Write failing test**

`tests/portfolio/decay-monitor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  evaluateDecay,
  computeAnnualizedSharpe,
  computeMaxDrawdown,
} from '@/lib/portfolio/decay-monitor';
import type { EquityPoint } from '@/lib/portfolio/types';

describe('computeAnnualizedSharpe', () => {
  it('annualizes from daily returns by sqrt(252)', () => {
    const r = Array(30).fill(0.001); // mean=0.001, stdev=0
    // stdev=0 should be guarded to null
    expect(computeAnnualizedSharpe(r)).toBeNull();
  });
  it('returns a positive Sharpe for positive-mean returns', () => {
    const r = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.002 : -0.0005));
    const s = computeAnnualizedSharpe(r);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(0);
  });
  it('returns null for fewer than 5 returns', () => {
    expect(computeAnnualizedSharpe([0.01, 0.02])).toBeNull();
  });
});

describe('computeMaxDrawdown', () => {
  it('returns 0 for a monotonically rising series', () => {
    const series: EquityPoint[] = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 110 },
      { timestamp: 3, equity: 120 },
    ];
    expect(computeMaxDrawdown(series)).toBe(0);
  });
  it('returns the peak-to-trough fraction', () => {
    const series: EquityPoint[] = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 200 }, // peak
      { timestamp: 3, equity: 150 }, // 25% drawdown from peak
      { timestamp: 4, equity: 180 },
    ];
    expect(computeMaxDrawdown(series)).toBeCloseTo(0.25, 6);
  });
});

describe('evaluateDecay', () => {
  it('does NOT trip when live Sharpe is above the floor and DD is under ceiling', () => {
    const r = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.005 : 0.001));
    const series: EquityPoint[] = Array.from({ length: 90 }, (_, i) => ({
      timestamp: i,
      equity: 1000 + i * 5,
    }));
    const status = evaluateDecay({
      strategy: 'ict-3sym',
      dailyReturns30d: r,
      equity90d: series,
      bootstrapFloor: 1.0,
      drawdownCeiling: 0.6,
    });
    expect(status.tripped).toBe(false);
  });

  it('trips on bootstrap-floor breach', () => {
    const r = Array.from({ length: 30 }, (_, i) => (i % 2 ? -0.005 : 0.001)); // negative drift
    const series: EquityPoint[] = Array.from({ length: 90 }, (_, i) => ({
      timestamp: i,
      equity: 1000,
    }));
    const status = evaluateDecay({
      strategy: 'ict-3sym',
      dailyReturns30d: r,
      equity90d: series,
      bootstrapFloor: 1.0,
      drawdownCeiling: 0.6,
    });
    expect(status.tripped).toBe(true);
    expect(status.reason).toMatch(/sharpe/i);
  });

  it('trips on drawdown breach', () => {
    const r = Array(30).fill(0.001); // benign
    const series: EquityPoint[] = [
      { timestamp: 1, equity: 1000 },
      { timestamp: 2, equity: 500 }, // 50% DD
    ];
    const status = evaluateDecay({
      strategy: 'ict-3sym',
      dailyReturns30d: r,
      equity90d: series,
      bootstrapFloor: -10, // unbreachable
      drawdownCeiling: 0.3,
    });
    expect(status.tripped).toBe(true);
    expect(status.reason).toMatch(/drawdown/i);
  });

  it('returns null fields and tripped=false on cold start', () => {
    const status = evaluateDecay({
      strategy: 'ict-3sym',
      dailyReturns30d: [],
      equity90d: [],
      bootstrapFloor: 1.0,
      drawdownCeiling: 0.6,
    });
    expect(status.tripped).toBe(false);
    expect(status.liveSharpe30d).toBeNull();
    expect(status.liveDrawdown90d).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/portfolio/decay-monitor.ts`:

```ts
import type { DecayStatus, EquityPoint, StrategyId } from './types';

const TRADING_DAYS = 252;
const DD_BREACH_MULTIPLIER = 1.5;
const MIN_RETURNS_FOR_SHARPE = 5;

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function computeAnnualizedSharpe(daily: number[]): number | null {
  if (daily.length < MIN_RETURNS_FOR_SHARPE) return null;
  const sd = stdev(daily);
  if (sd === 0) return null;
  const mean = daily.reduce((s, x) => s + x, 0) / daily.length;
  return (mean / sd) * Math.sqrt(TRADING_DAYS);
}

export function computeMaxDrawdown(series: EquityPoint[]): number {
  if (series.length === 0) return 0;
  let peak = series[0]!.equity;
  let maxDD = 0;
  for (const p of series) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
}

export interface EvaluateDecayInput {
  strategy: StrategyId;
  dailyReturns30d: number[];
  equity90d: EquityPoint[];
  bootstrapFloor: number;
  drawdownCeiling: number;
}

export function evaluateDecay(input: EvaluateDecayInput): DecayStatus {
  const liveSharpe30d = computeAnnualizedSharpe(input.dailyReturns30d);
  const liveDrawdown90d =
    input.equity90d.length > 0 ? computeMaxDrawdown(input.equity90d) : null;
  const ddCeilingEffective = input.drawdownCeiling * DD_BREACH_MULTIPLIER;

  let tripped = false;
  const reasons: string[] = [];

  if (liveSharpe30d !== null && liveSharpe30d < input.bootstrapFloor) {
    tripped = true;
    reasons.push(
      `live 30d Sharpe ${liveSharpe30d.toFixed(2)} < bootstrap floor ${input.bootstrapFloor.toFixed(2)}`,
    );
  }
  if (liveDrawdown90d !== null && liveDrawdown90d > ddCeilingEffective) {
    tripped = true;
    reasons.push(
      `live 90d drawdown ${(liveDrawdown90d * 100).toFixed(1)}% > ceiling ${(ddCeilingEffective * 100).toFixed(1)}% (1.5× ${(input.drawdownCeiling * 100).toFixed(1)}%)`,
    );
  }

  return {
    strategy: input.strategy,
    liveSharpe30d,
    bootstrapFloor: input.bootstrapFloor,
    liveDrawdown90d,
    drawdownCeiling: ddCeilingEffective,
    tripped,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
  };
}
```

- [ ] **Step 4: Run, verify pass**

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
gmp "add decay monitor with bootstrap-floor and drawdown tripwires" feat backend
```

---

### Task 10: barrel exports

**Files:**
- Create: `src/lib/portfolio/index.ts`

- [ ] **Step 1: Write the barrel**

```ts
export * from './types';
export * from './equity-source';
export * from './allocator';
export * from './bootstrap-floors';
export * from './decay-monitor';
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: pass, all tests pass.

- [ ] **Step 3: Commit**

```bash
gmp "add portfolio barrel exports" feat backend
```

---

### Task 11: scripts/run-allocator.ts (weekly cron)

**Files:**
- Create: `scripts/run-allocator.ts`

- [ ] **Step 1: Discover Telegram alert + DB connection patterns**

```bash
grep -n "AlertManager\|sendAlert\|sendMessage" src/lib/bot/alerts.ts | head -10
grep -n "new Database\|better-sqlite3" src/lib/data/*.ts | head -5
```

Note exact import paths and constructor signatures. The script must reuse the existing pattern, not invent new ones.

- [ ] **Step 2: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * Weekly Portfolio Allocator (advisory)
 *
 * Computes inverse-vol weights for currently deployed strategies and writes
 * recommendations to data/allocator-recommendations.json + Telegram.
 *
 * Cron: Sundays 00:05 UTC (configured in ecosystem.config.cjs).
 *
 * NO BOT CONFIG IS MUTATED. Output is informational only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  getDailyReturnsForStrategy,
  computeInverseVolWeights,
  type EquitySources,
} from '@/lib/portfolio';
import type { AllocatorResult, StrategyId } from '@/lib/portfolio/types';
import { AlertManager } from '@/lib/bot/alerts';
import { DEFAULT_BOT_CONFIG } from '@/lib/bot/config';

const LOOKBACK_DAYS = 60;
const OUT_PATH = path.resolve('data/allocator-recommendations.json');
const DEPLOYED: StrategyId[] = ['ict-3sym', 'f2f-gold'];

// Each deployed strategy's currently configured riskPerTrade.
// Both bots use DEFAULT_BOT_CONFIG.riskPerTrade today (0.003 = 0.3%).
// If they diverge, refactor here.
const CURRENT_RISK_PER_TRADE: Record<StrategyId, number> = {
  'ict-3sym': DEFAULT_BOT_CONFIG.riskPerTrade,
  'ict-7sym': DEFAULT_BOT_CONFIG.riskPerTrade,
  'f2f-gold': DEFAULT_BOT_CONFIG.riskPerTrade,
};

function openCryptoDb(): Database.Database | null {
  const dbPath = path.resolve('data/app.db');
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

async function main(): Promise<void> {
  const cryptoDb = openCryptoDb();
  const sources: EquitySources = {
    cryptoDb,
    goldStatePath: path.resolve('data/gold-bot-state.json'),
  };

  const inputs = DEPLOYED.map((strategy) => ({
    strategy,
    dailyReturns: getDailyReturnsForStrategy(strategy, LOOKBACK_DAYS, sources),
  }));

  const { allocations, warnings } = computeInverseVolWeights(inputs);

  const totalCurrentRiskBudget = DEPLOYED.reduce(
    (s, k) => s + CURRENT_RISK_PER_TRADE[k],
    0,
  );

  for (const a of allocations) {
    a.currentRiskPerTrade = CURRENT_RISK_PER_TRADE[a.strategy];
    a.recommendedRiskPerTrade = a.weight * totalCurrentRiskBudget;
  }

  const result: AllocatorResult = {
    generatedAt: Date.now(),
    lookbackDays: LOOKBACK_DAYS,
    totalCurrentRiskBudget,
    allocations,
    warnings,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));

  // Telegram summary
  const lines: string[] = [
    `📊 Allocator (advisory) — ${LOOKBACK_DAYS}d inverse-vol`,
    `Total risk budget: ${(totalCurrentRiskBudget * 100).toFixed(2)}%`,
    '',
  ];
  for (const a of allocations) {
    if (a.excluded) {
      lines.push(`• ${a.strategy}: EXCLUDED (${a.excluded.reason})`);
      continue;
    }
    const cur = (a.currentRiskPerTrade * 100).toFixed(3);
    const rec = (a.recommendedRiskPerTrade * 100).toFixed(3);
    const arrow = Math.abs(a.recommendedRiskPerTrade - a.currentRiskPerTrade) < 1e-5 ? '=' : '→';
    lines.push(
      `• ${a.strategy}: weight ${(a.weight * 100).toFixed(1)}% | risk/trade ${cur}% ${arrow} ${rec}% | annVol ${(a.annualizedVol * 100).toFixed(1)}%`,
    );
  }
  if (warnings.length) {
    lines.push('', '⚠️ ' + warnings.join('; '));
  }

  const alerts = new AlertManager();
  await alerts.sendAlert(lines.join('\n'));

  cryptoDb?.close();
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

> If Step 1 found a different signature for `AlertManager` (e.g., it takes a config arg, or method is `send` not `sendAlert`), update both calls accordingly.

- [ ] **Step 3: Dry run**

```bash
pnpm typecheck
npx tsx scripts/run-allocator.ts
```

Expected: typecheck passes; script runs without error and writes `data/allocator-recommendations.json`. (If gold-bot-state.json or app.db doesn't exist yet because bots haven't run, the allocator should produce a result with both strategies excluded for cold-start — that's the correct behavior.)

- [ ] **Step 4: Inspect output**

```bash
cat data/allocator-recommendations.json
```

Expected: valid JSON matching `AllocatorResult` shape.

- [ ] **Step 5: Commit**

```bash
gmp "add weekly allocator cron script" feat backend
```

---

### Task 12: scripts/run-monitor.ts (daily cron)

**Files:**
- Create: `scripts/run-monitor.ts`

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * Daily Decay Monitor
 *
 * Compares each deployed strategy's live 30d Sharpe against its bootstrap 5th
 * percentile, and 90d drawdown against 1.5× backtest MaxDD. Writes status to
 * data/decay-status.json and sends a Telegram alert (debounced 24h) only when
 * a tripwire fires.
 *
 * Cron: daily 00:10 UTC.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  getDailyReturnsForStrategy,
  resampleToUtcDaily,
  readCryptoEquityFromDb,
  loadBootstrapFloors,
  loadDrawdownCeilings,
  evaluateDecay,
  type EquitySources,
} from '@/lib/portfolio';
import type {
  DecayStatus,
  EquityPoint,
  MonitorResult,
  StrategyId,
} from '@/lib/portfolio/types';
import { AlertManager } from '@/lib/bot/alerts';

const LOOKBACK_RETURNS_DAYS = 30;
const LOOKBACK_EQUITY_DAYS = 90;
const ALERT_DEBOUNCE_MS = 24 * 60 * 60 * 1000;
const STATUS_PATH = path.resolve('data/decay-status.json');
const ALERT_LOG_PATH = path.resolve('data/decay-alerts-log.json');
const DEPLOYED: StrategyId[] = ['ict-3sym', 'f2f-gold'];

function openCryptoDb(): Database.Database | null {
  const dbPath = path.resolve('data/app.db');
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

function load90dEquityForStrategy(
  strategy: StrategyId,
  sources: EquitySources,
): EquityPoint[] {
  if (strategy === 'f2f-gold') {
    // Gold persists only daily returns + a current equity scalar. Reconstruct
    // a 90-bar equity curve from the rolling30dReturns array (best available).
    const returns = JSON.parse(
      fs.readFileSync(sources.goldStatePath, 'utf-8'),
    ) as { equity?: number; rolling30dReturns?: number[] };
    if (!returns.rolling30dReturns || returns.rolling30dReturns.length === 0)
      return [];
    const startEquity = returns.equity ?? 10000;
    let eq = startEquity;
    // Walk backwards: reconstruct equity at each prior day from the most recent.
    const reverseEquity: EquityPoint[] = [
      { timestamp: Date.now(), equity: eq },
    ];
    const rs = returns.rolling30dReturns;
    let t = Date.now();
    for (let i = rs.length - 1; i >= 0; i--) {
      t -= 86_400_000;
      eq = eq / (1 + rs[i]!); // invert the return
      reverseEquity.push({ timestamp: t, equity: eq });
    }
    return reverseEquity.reverse();
  }
  // crypto: pull last 90 daily-resampled equity points from DB
  if (!sources.cryptoDb) return [];
  const all = readCryptoEquityFromDb(sources.cryptoDb);
  const daily = resampleToUtcDaily(all);
  return daily.slice(-LOOKBACK_EQUITY_DAYS);
}

interface AlertLogEntry { strategy: StrategyId; lastAlertedAt: number; }

function loadAlertLog(): AlertLogEntry[] {
  if (!fs.existsSync(ALERT_LOG_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ALERT_LOG_PATH, 'utf-8')) as AlertLogEntry[];
  } catch {
    return [];
  }
}

function saveAlertLog(entries: AlertLogEntry[]): void {
  fs.writeFileSync(ALERT_LOG_PATH, JSON.stringify(entries, null, 2));
}

async function main(): Promise<void> {
  const cryptoDb = openCryptoDb();
  const sources: EquitySources = {
    cryptoDb,
    goldStatePath: path.resolve('data/gold-bot-state.json'),
  };
  const floors = loadBootstrapFloors(path.resolve('experiments'));
  const ceilings = loadDrawdownCeilings();

  const statuses: DecayStatus[] = [];
  const warnings: string[] = [];

  for (const strategy of DEPLOYED) {
    const returns = getDailyReturnsForStrategy(
      strategy,
      LOOKBACK_RETURNS_DAYS,
      sources,
    );
    const equity = load90dEquityForStrategy(strategy, sources);
    const floor = floors.get(strategy);
    const ceiling = ceilings.get(strategy);
    if (floor === undefined || ceiling === undefined) {
      warnings.push(`${strategy}: bootstrap floor or DD ceiling missing — skipped`);
      continue;
    }
    statuses.push(
      evaluateDecay({
        strategy,
        dailyReturns30d: returns,
        equity90d: equity,
        bootstrapFloor: floor,
        drawdownCeiling: ceiling,
      }),
    );
  }

  const result: MonitorResult = {
    generatedAt: Date.now(),
    statuses,
    warnings,
  };
  fs.writeFileSync(STATUS_PATH, JSON.stringify(result, null, 2));

  // Debounced Telegram alerts
  const log = loadAlertLog();
  const now = Date.now();
  const newLog: AlertLogEntry[] = [...log];
  const tripped = statuses.filter((s) => s.tripped);
  const alerts = new AlertManager();

  for (const s of tripped) {
    const last = log.find((e) => e.strategy === s.strategy);
    if (last && now - last.lastAlertedAt < ALERT_DEBOUNCE_MS) continue;
    await alerts.sendAlert(`🚨 DECAY ALERT — ${s.strategy}\n${s.reason}`);
    const idx = newLog.findIndex((e) => e.strategy === s.strategy);
    if (idx >= 0) newLog[idx] = { strategy: s.strategy, lastAlertedAt: now };
    else newLog.push({ strategy: s.strategy, lastAlertedAt: now });
  }
  saveAlertLog(newLog);

  cryptoDb?.close();
  console.log(`Wrote ${STATUS_PATH}, ${tripped.length} tripped`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Dry run**

```bash
pnpm typecheck
npx tsx scripts/run-monitor.ts
```

Expected: typecheck passes; script runs and writes `data/decay-status.json` + (possibly empty) `data/decay-alerts-log.json`.

- [ ] **Step 3: Inspect output**

```bash
cat data/decay-status.json
```

Expected: valid `MonitorResult` JSON.

- [ ] **Step 4: Commit**

```bash
gmp "add daily decay monitor cron script" feat backend
```

---

### Task 13: ecosystem.config.cjs cron entries

**Files:**
- Modify: `ecosystem.config.cjs`

- [ ] **Step 1: Add allocator + monitor entries**

In `ecosystem.config.cjs`, append two entries to the `apps` array:

```js
{
  name: 'allocator-cron',
  script: './node_modules/.bin/tsx',
  args: 'scripts/run-allocator.ts',
  cwd: __dirname,
  instances: 1,
  autorestart: false,
  cron_restart: '5 0 * * 0', // Sundays 00:05 UTC
  watch: false,
  max_memory_restart: '256M',
  env: { NODE_ENV: 'production' },
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  error_file: 'logs/allocator-cron-error.log',
  out_file: 'logs/allocator-cron-out.log',
  merge_logs: true,
},
{
  name: 'monitor-cron',
  script: './node_modules/.bin/tsx',
  args: 'scripts/run-monitor.ts',
  cwd: __dirname,
  instances: 1,
  autorestart: false,
  cron_restart: '10 0 * * *', // daily 00:10 UTC
  watch: false,
  max_memory_restart: '256M',
  env: { NODE_ENV: 'production' },
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  error_file: 'logs/monitor-cron-error.log',
  out_file: 'logs/monitor-cron-out.log',
  merge_logs: true,
},
```

- [ ] **Step 2: Validate config**

```bash
node -e "require('./ecosystem.config.cjs')"
```

Expected: no error (Node parses the module cleanly).

- [ ] **Step 3: Commit**

```bash
gmp "schedule allocator weekly + monitor daily via PM2 cron" chore config
```

---

### Task 14: A3 — Live-paper audit doc

**Files:**
- Create: `docs/live-paper-audit-2026-05-03.md`

- [ ] **Step 1: Audit crypto bot logging**

Read these files end-to-end and note what is logged, with what cadence:
- `src/lib/bot/position-tracker.ts` (especially `recordEquitySnapshot`, `recordTrade`)
- `src/lib/data/schema.ts` (the `bot_*` tables)

For each table, record: columns present, write cadence (per-tick? per-trade? per-day?), retention policy (truncated? unbounded?). Note any gap that would block A1/A2 reading the data correctly.

- [ ] **Step 2: Audit gold bot logging**

Read `scripts/run-gold-bot.ts` and any persistence code it uses. Note exactly what is in `data/gold-bot-state.json` — fields, update frequency, whether trade history is preserved.

- [ ] **Step 3: Write the doc**

`docs/live-paper-audit-2026-05-03.md`:

```markdown
# Live-Paper Audit — 2026-05-03

## Purpose
Document what the deployed bots already log, the cadence, the 90-day clock start date, and any gaps that the allocator/monitor depend on.

## 90-day clock starts: 2026-05-03
Re-evaluate enforcement design at 2026-08-01 (90 days).

## Crypto bot (`scripts/run-bot.ts` → `src/lib/bot/...`)
- Equity snapshots: table `bot_equity_snapshots`, columns [list from schema], cadence [from audit], retention [from audit].
- Trade history: table `bot_trades`, columns [list], coverage [list].
- Per-trade attribution to strategy: [present? — record yes/no].
- Per-trade regime tag: [present? — record yes/no].

## Gold bot (`scripts/run-gold-bot.ts`)
- State file: `data/gold-bot-state.json`.
- Fields: `equity`, `initialCapital`, `position`, `trades` array, `lastTickTimestamp`, `rolling30dReturns`, `startedAt`.
- Update cadence: [from audit — per tick or per trade?]
- Trade retention: [bounded? rolling? unbounded?]

## Gaps (relative to allocator + monitor needs)
[List the concrete gaps. Example:]
- [ ] Crypto bot equity snapshots cadence is per-tick (~hourly). Acceptable: monitor resamples to daily UTC. No change needed.
- [ ] Gold bot does not retain a 90-day equity series. Monitor reconstructs from `rolling30dReturns` (sufficient for 30d Sharpe; 90d DD reconstruction is approximate). **Mitigation:** if more than 30 days are needed, add a `dailyEquityHistory: number[]` field to gold bot state. Out-of-scope for this plan.
- [ ] [other gaps as found]

## Sign-off
Bot logging is sufficient for A1 (allocator) and A2 (monitor) on the 2 currently deployed strategies, with the gold-90d-DD approximation noted above. Re-audit when ICT 7-sym or funding-arb deploy.
```

- [ ] **Step 4: Fill in the bracketed values**

Replace each `[...]` placeholder with what was actually found in steps 1–2. Do not commit a doc with placeholders.

- [ ] **Step 5: Commit**

```bash
gmp "audit live-paper logging coverage and start 90d clock" docs spec
```

---

### Task 15: Final sanity — full-suite run

**Files:** none

- [ ] **Step 1: Run typecheck + tests + manual scripts**

```bash
pnpm typecheck && pnpm test && npx tsx scripts/run-allocator.ts && npx tsx scripts/run-monitor.ts
```

Expected: all green; both JSON files written.

- [ ] **Step 2: Deploy the cron entries**

```bash
pm2 reload ecosystem.config.cjs
pm2 ls
```

Expected: `allocator-cron` and `monitor-cron` appear in the list with `cron_restart` schedules.

- [ ] **Step 3: Tag the milestone**

```bash
git tag -a "path-a-shipped-$(date -u +%Y%m%d)" -m "Portfolio allocator + decay monitor + audit shipped"
```

- [ ] **Step 4: Final commit if anything was tweaked**

If steps 1–2 surfaced any fix, commit it now via `gmp`. Otherwise skip.

---

## Self-review notes

- **Spec coverage:** A1 → Tasks 1, 2, 3, 6, 7, 11. A2 → Tasks 1, 8, 9, 12. A3 → Task 14. Cron → Task 13. Test infra → Task 0. Barrel/typecheck → Task 10. All spec sections covered.
- **Placeholder scan:** Two `[from audit]` markers exist intentionally inside Task 14's doc template — Step 4 of Task 14 explicitly requires filling them before commit. No placeholders remain in code.
- **Type consistency:** `StrategyId` is a closed union of three strings; reused in every task. `EquityPoint`, `AllocatorResult`, `DecayStatus`, `MonitorResult` defined in Task 1, used unmodified after. `EquitySources` introduced in Task 6 as a public type, consumed by Tasks 11+12.
- **No invented code:** `AlertManager` import path verified through Task 11 Step 1 discovery; `bot_equity_snapshots` schema verified through Task 4 Step 1 discovery; gold state shape verified through Task 5 Step 1 from real `data/gold-bot-state.json`.
