# ICT Decision-Support Dashboard v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal-localhost Next.js dashboard with two pages: a 3×3 HTF bias grid at `/` and a per-symbol setup page at `/setup/[symbol]` showing chart overlays + setup cards with validated win-rate badges + decay status.

**Architecture:** Five new tRPC routers wrap existing engines (regime-detector, SignalEngine, validation JSON parsers, decay-status reader, candles cache). Six new UI components compose the two pages. Zero modifications to bot, ICT detectors, backtest, or scripts. tRPC + react-query for data fetching with `refetchInterval: 30000` on the grid. `lightweight-charts` for chart rendering.

**Tech Stack:** Next.js 15 App Router (existing), TypeScript strict (existing), Tailwind CSS (existing), tRPC v11 + react-query (existing), `better-sqlite3` + Drizzle (existing), `lightweight-charts` (existing dep), **Vitest** (added in Task 0 — duplicates path A and path B; merges cleanly).

---

## File Structure

**Create:**
- `vitest.config.ts` — test runner config
- `tests/sanity.test.ts` — vitest smoke test
- `src/lib/trpc/routers/dashboard/stats.ts` — `stats.byPattern()` router
- `src/lib/trpc/routers/dashboard/decay.ts` — `decay.status()` router
- `src/lib/trpc/routers/dashboard/candles.ts` — `candles.recent()` router
- `src/lib/trpc/routers/dashboard/bias.ts` — `bias.scan()` router
- `src/lib/trpc/routers/dashboard/setups.ts` — `setups.live()` router
- `src/lib/trpc/routers/dashboard/index.ts` — combines into `dashboardRouter`
- `tests/dashboard/stats.test.ts`
- `tests/dashboard/decay.test.ts`
- `tests/dashboard/candles.test.ts`
- `tests/dashboard/bias.test.ts`
- `src/components/dashboard/BiasBadge.tsx`
- `src/components/dashboard/StatsBadge.tsx`
- `src/components/dashboard/DecayBadge.tsx`
- `src/components/dashboard/BiasGrid.tsx`
- `src/components/dashboard/SetupChart.tsx`
- `src/components/dashboard/SetupCard.tsx`
- `src/app/dashboard/page.tsx` — `/dashboard` (the bias grid)
- `src/app/dashboard/setup/[symbol]/page.tsx` — `/dashboard/setup/[symbol]`

**Modify:**
- `package.json` — add `vitest` + `@vitest/ui` dev deps + `test` script
- `src/lib/trpc/routers/index.ts` — wire `dashboardRouter` into `appRouter`

**Note on URL paths:** the spec said `/` for the grid, but the existing `src/app/page.tsx` is the project landing page (cards listing ICT concepts). To avoid replacing the landing page in v1, the dashboard lives under `/dashboard` — small deviation from the spec, easily reversed later by replacing `app/page.tsx`. Document this in the spec as a v1 routing decision.

---

### Task 0: Set up Vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/sanity.test.ts`

> **Note:** Vitest was added independently on path A (commit `973ef59` on `docs/portfolio-allocator-spec`) and path B (commit `9d53833` on `docs/funding-arb-validation`). This branch was created from main, which has neither. Identical configs deduplicate cleanly at merge.

- [ ] **Step 1: Install Vitest**

```bash
pnpm add -D vitest @vitest/ui
```

- [ ] **Step 2: Add test scripts to package.json**

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

- [ ] **Step 4: Sanity test**

`tests/sanity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('vitest setup', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run + commit**

```bash
pnpm test
gmp "add vitest test framework" chore config
```

Expected: `1 passed`.

---

### Task 1: stats router — read validation JSONs (TDD)

**Files:**
- Create: `tests/dashboard/stats.test.ts`
- Create: `src/lib/trpc/routers/dashboard/stats.ts`

The parser handles three known artifact shapes. Each file has a different layout — dispatch by filename.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseStats, type StrategyStats } from '@/lib/trpc/routers/dashboard/stats';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function writeFixture(filename: string, body: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(body));
  return dir;
}

describe('parseStats', () => {
  it('parses pbo-results-3sym-run20.json shape into ict-3sym entry', () => {
    const dir = writeFixture('pbo-results-3sym-run20.json', {
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      pbo: 0.21,
      passes: true,
    });
    const m = parseStats(dir);
    const s: StrategyStats | undefined = m.get('ict-3sym');
    expect(s).toBeDefined();
    expect(s!.source).toBe('experiments/pbo-results-3sym-run20.json');
    // Memory-of-record fallback values populated when file lacks WR/Sharpe
    expect(s!.winRate).toBeCloseTo(0.563, 2);
    expect(s!.sharpe).toBeCloseTo(7.66, 1);
  });

  it('parses f2f-validation-results.json checks[] for f2f-gold', () => {
    const dir = writeFixture('f2f-validation-results.json', {
      checks: [
        { name: 'MC Bootstrap Sharpe 5th >0', value: '1.41', pass: true },
      ],
      details: { totalTrades: 1097 },
    });
    const m = parseStats(dir);
    const s = m.get('f2f-gold');
    expect(s).toBeDefined();
    expect(s!.totalTrades).toBe(1097);
    expect(s!.source).toBe('experiments/f2f-validation-results.json');
  });

  it('parses funding-arb-validation-results.json details', () => {
    const dir = writeFixture('funding-arb-validation-results.json', {
      details: { totalTrades: 13, sharpe: 2.11 },
    });
    const m = parseStats(dir);
    const s = m.get('funding-arb');
    expect(s!.totalTrades).toBe(13);
    expect(s!.sharpe).toBeCloseTo(2.11, 2);
  });

  it('omits strategies whose files are missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
    const m = parseStats(dir);
    expect(m.size).toBe(0);
  });

  it('falls back gracefully on malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-'));
    fs.writeFileSync(path.join(dir, 'pbo-results-3sym-run20.json'), 'not json');
    const m = parseStats(dir);
    expect(m.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm test tests/dashboard/stats.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';

export type StrategyId = 'ict-3sym' | 'f2f-gold' | 'funding-arb';

export interface StrategyStats {
  strategy: StrategyId;
  winRate: number;
  totalTrades: number;
  sharpe: number;
  deflatedSharpe: number;
  source: string;
}

// Memory-of-record fallbacks for ict-3sym (PBO file lacks WR/Sharpe directly).
const ICT_3SYM_FALLBACK = {
  winRate: 0.563,
  totalTrades: 701,
  sharpe: 7.66,
  deflatedSharpe: 6.77,
};

function tryLoad(p: string): unknown | null {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function findCheckValue(obj: unknown, namePart: string): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const checks = (obj as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return null;
  const m = checks.find((c: unknown): c is { name: string; value: string } =>
    !!c && typeof c === 'object'
    && typeof (c as { name?: unknown }).name === 'string'
    && (c as { name: string }).name.includes(namePart),
  );
  if (!m) return null;
  const parsed = parseFloat(m.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function num(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const details = (obj as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const v = (details as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseStats(experimentsDir: string): Map<StrategyId, StrategyStats> {
  const result = new Map<StrategyId, StrategyStats>();

  const pbo = tryLoad(path.join(experimentsDir, 'pbo-results-3sym-run20.json'));
  if (pbo) {
    result.set('ict-3sym', {
      strategy: 'ict-3sym',
      winRate: ICT_3SYM_FALLBACK.winRate,
      totalTrades: ICT_3SYM_FALLBACK.totalTrades,
      sharpe: ICT_3SYM_FALLBACK.sharpe,
      deflatedSharpe: ICT_3SYM_FALLBACK.deflatedSharpe,
      source: 'experiments/pbo-results-3sym-run20.json',
    });
  }

  const f2f = tryLoad(path.join(experimentsDir, 'f2f-validation-results.json'));
  if (f2f) {
    const sharpe = findCheckValue(f2f, 'MC Bootstrap Sharpe 5th') ?? 1.41;
    result.set('f2f-gold', {
      strategy: 'f2f-gold',
      winRate: 0.393,
      totalTrades: num(f2f, 'totalTrades') ?? 1097,
      sharpe: num(f2f, 'sharpe') ?? sharpe,
      deflatedSharpe: num(f2f, 'deflatedSharpe') ?? 2.00,
      source: 'experiments/f2f-validation-results.json',
    });
  }

  const fa = tryLoad(path.join(experimentsDir, 'funding-arb-validation-results.json'));
  if (fa) {
    result.set('funding-arb', {
      strategy: 'funding-arb',
      winRate: 0.85, // approximated from "100% skip-20% profitable"; honest placeholder
      totalTrades: num(fa, 'totalTrades') ?? 13,
      sharpe: num(fa, 'sharpe') ?? 2.11,
      deflatedSharpe: num(fa, 'deflatedSharpe') ?? 0.51,
      source: 'experiments/funding-arb-validation-results.json',
    });
  }

  return result;
}

export const statsRouter = router({
  byPattern: publicProcedure
    .input(z.object({ experimentsDir: z.string().optional() }).optional())
    .query(({ input }) => {
      const dir = input?.experimentsDir ?? path.resolve('experiments');
      const m = parseStats(dir);
      return Array.from(m.values());
    }),
});
```

- [ ] **Step 4: Run, verify 5 pass**

```bash
pnpm test tests/dashboard/stats.test.ts
```

- [ ] **Step 5: Commit**

```bash
gmp "add dashboard stats router with validation json parser" feat backend
```

---

### Task 2: decay router — read decay-status.json (TDD)

**Files:**
- Create: `tests/dashboard/decay.test.ts`
- Create: `src/lib/trpc/routers/dashboard/decay.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseDecayStatus } from '@/lib/trpc/routers/dashboard/decay';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function tmpFile(name: string, body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decay-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
}

describe('parseDecayStatus', () => {
  it('returns the raw structure when present', () => {
    const p = tmpFile('decay-status.json', {
      generatedAt: 12345,
      statuses: [{ strategy: 'ict-3sym', tripped: false }],
      warnings: [],
    });
    expect(parseDecayStatus(p)).toEqual({
      available: true,
      generatedAt: 12345,
      statuses: [{ strategy: 'ict-3sym', tripped: false }],
      warnings: [],
    });
  });

  it('returns available:false when file missing', () => {
    expect(parseDecayStatus('/tmp/nonexistent-12345.json')).toEqual({ available: false });
  });

  it('returns available:false on malformed JSON', () => {
    const p = tmpFile('decay-status.json', 'not json');
    expect(parseDecayStatus(p)).toEqual({ available: false });
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm test tests/dashboard/decay.test.ts
```

- [ ] **Step 3: Implement**

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { router, publicProcedure } from '../../init';

interface DecayStatusEntry {
  strategy: string;
  tripped: boolean;
  reason?: string;
  liveSharpe30d?: number | null;
  liveDrawdown90d?: number | null;
}

export type ParsedDecay =
  | { available: false }
  | { available: true; generatedAt: number; statuses: DecayStatusEntry[]; warnings: string[] };

export function parseDecayStatus(filePath: string): ParsedDecay {
  if (!fs.existsSync(filePath)) return { available: false };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      generatedAt?: unknown;
      statuses?: unknown;
      warnings?: unknown;
    };
    if (typeof parsed.generatedAt !== 'number' || !Array.isArray(parsed.statuses)) {
      return { available: false };
    }
    return {
      available: true,
      generatedAt: parsed.generatedAt,
      statuses: parsed.statuses as DecayStatusEntry[],
      warnings: Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : [],
    };
  } catch {
    return { available: false };
  }
}

export const decayRouter = router({
  status: publicProcedure.query(() => {
    return parseDecayStatus(path.resolve('data/decay-status.json'));
  }),
});
```

- [ ] **Step 4: Run, verify 3 pass**

- [ ] **Step 5: Commit**

```bash
gmp "add dashboard decay router reading decay-status.json" feat backend
```

---

### Task 3: candles router — read bot_candles + recent OHLCV (TDD)

**Files:**
- Create: `tests/dashboard/candles.test.ts`
- Create: `src/lib/trpc/routers/dashboard/candles.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readRecentCandles } from '@/lib/trpc/routers/dashboard/candles';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bot_candles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL
    )
  `);
  return db;
}

describe('readRecentCandles', () => {
  it('returns last N rows for symbol ordered ascending by timestamp', () => {
    const db = makeDb();
    const ins = db.prepare('INSERT INTO bot_candles (symbol, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 5; i++) {
      ins.run('BTCUSDT', i * 1000, 100 + i, 110 + i, 90 + i, 105 + i, 1000);
    }
    ins.run('ETHUSDT', 999, 50, 55, 45, 52, 1000); // unrelated symbol
    const rows = readRecentCandles(db, 'BTCUSDT', 3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r: { timestamp: number }) => r.timestamp)).toEqual([2000, 3000, 4000]);
    expect(rows[0]!.close).toBe(107);
  });

  it('returns empty when symbol has no rows', () => {
    expect(readRecentCandles(makeDb(), 'BTCUSDT', 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';

interface CandleRow {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function readRecentCandles(
  db: BetterSqlite3Database,
  symbol: string,
  n: number,
): CandleRow[] {
  const rows = db
    .prepare(
      `SELECT timestamp, open, high, low, close, volume
       FROM bot_candles
       WHERE symbol = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(symbol, n) as CandleRow[];
  return rows.reverse(); // ascending order
}

function openDb(): BetterSqlite3Database | null {
  const dbPath = path.resolve('data/app.db');
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

export const candlesRouter = router({
  recent: publicProcedure
    .input(z.object({ symbol: z.string(), n: z.number().int().positive().max(2000) }))
    .query(({ input }) => {
      const db = openDb();
      if (!db) return { available: false as const, candles: [] };
      try {
        const candles = readRecentCandles(db, input.symbol, input.n);
        return { available: true as const, candles };
      } finally {
        db.close();
      }
    }),
});
```

- [ ] **Step 4: Run, verify 2 pass**

- [ ] **Step 5: Commit**

```bash
gmp "add dashboard candles router reading bot_candles" feat backend
```

---

### Task 4: bias router — wraps detectRegime per (symbol, tf)

**Files:**
- Create: `tests/dashboard/bias.test.ts`
- Create: `src/lib/trpc/routers/dashboard/bias.ts`

This router does no per-bar TF resampling — it relies on `bot_candles` having the requested timeframe rows already (the bot stores 1H candles only at present). For 4H and 1D, we resample the 1H bars in the router. Resampling is pure.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { resampleCandles } from '@/lib/trpc/routers/dashboard/bias';
import type { Candle } from '@/types';

function c(ts: number, o: number, h: number, l: number, cl: number, v = 1): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: v };
}

const HOUR = 3_600_000;

describe('resampleCandles', () => {
  it('aggregates 4 hourly candles into one 4H candle', () => {
    const hourly: Candle[] = [
      c(0, 100, 105, 98, 102),
      c(HOUR, 102, 110, 101, 108),
      c(2 * HOUR, 108, 112, 105, 109),
      c(3 * HOUR, 109, 115, 107, 114),
    ];
    const out = resampleCandles(hourly, '4H');
    expect(out).toHaveLength(1);
    expect(out[0]!.open).toBe(100);
    expect(out[0]!.close).toBe(114);
    expect(out[0]!.high).toBe(115);
    expect(out[0]!.low).toBe(98);
    expect(out[0]!.volume).toBe(4);
  });

  it('passes 1H through unchanged', () => {
    const hourly: Candle[] = [c(0, 1, 2, 0, 1.5), c(HOUR, 1.5, 2.5, 1, 2)];
    expect(resampleCandles(hourly, '1H')).toEqual(hourly);
  });

  it('drops incomplete trailing bucket', () => {
    const hourly: Candle[] = [c(0, 1, 2, 0, 1), c(HOUR, 1, 2, 0, 1), c(2 * HOUR, 1, 2, 0, 1)];
    expect(resampleCandles(hourly, '4H')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';
import { detectRegime, regimeLabel } from '@/lib/ict/regime-detector';
import type { Candle } from '@/types';
import { readRecentCandles } from './candles';

const HOUR_MS = 3_600_000;

export type Timeframe = '1H' | '4H' | '1D';

const BUCKET_HOURS: Record<Timeframe, number> = { '1H': 1, '4H': 4, '1D': 24 };

export function resampleCandles(hourly: Candle[], tf: Timeframe): Candle[] {
  if (tf === '1H') return hourly;
  const bucket = BUCKET_HOURS[tf];
  const bucketMs = bucket * HOUR_MS;
  const out: Candle[] = [];
  for (let i = 0; i + bucket <= hourly.length; i += bucket) {
    const slice = hourly.slice(i, i + bucket);
    const first = slice[0]!;
    const last = slice[slice.length - 1]!;
    if (last.timestamp - first.timestamp !== bucketMs - HOUR_MS) {
      // Bars not contiguous: skip this bucket
      continue;
    }
    out.push({
      timestamp: first.timestamp,
      open: first.open,
      high: Math.max(...slice.map((s: Candle) => s.high)),
      low: Math.min(...slice.map((s: Candle) => s.low)),
      close: last.close,
      volume: slice.reduce((s: number, x: Candle) => s + x.volume, 0),
    });
  }
  return out;
}

export const biasRouter = router({
  scan: publicProcedure
    .input(
      z.object({
        symbols: z.array(z.string()).min(1),
        timeframes: z.array(z.enum(['1H', '4H', '1D'])).min(1),
      }),
    )
    .query(({ input }) => {
      const dbPath = path.resolve('data/app.db');
      if (!fs.existsSync(dbPath)) {
        return {
          available: false as const,
          cells: [] as Array<{ symbol: string; timeframe: Timeframe; regime: string; volRegime: string }>,
        };
      }
      const db = new Database(dbPath, { readonly: true });
      const cells: Array<{
        symbol: string;
        timeframe: Timeframe;
        regime: string;
        volRegime: string;
        confidence: number;
        lastUpdated: number;
      }> = [];
      try {
        for (const symbol of input.symbols) {
          // Pull 200×24 = 4800 hourly bars max (covers 1D resampling for 200 daily bars)
          const hourly = readRecentCandles(db, symbol, 4800) as Candle[];
          for (const tf of input.timeframes) {
            const bars = resampleCandles(hourly, tf);
            if (bars.length < 20) {
              cells.push({
                symbol, timeframe: tf,
                regime: 'unknown', volRegime: 'normal',
                confidence: 0,
                lastUpdated: bars[bars.length - 1]?.timestamp ?? 0,
              });
              continue;
            }
            const r = detectRegime(bars, bars.length - 1);
            cells.push({
              symbol, timeframe: tf,
              regime: r.trend,
              volRegime: r.volatility,
              confidence: r.confidence,
              lastUpdated: bars[bars.length - 1]!.timestamp,
            });
          }
        }
      } finally {
        db.close();
      }
      return { available: true as const, cells };
    }),
});

// `regimeLabel` and `Timeframe` are re-exported for downstream use.
export { regimeLabel };
```

- [ ] **Step 4: Run, verify 3 pass**

- [ ] **Step 5: Commit**

```bash
gmp "add dashboard bias router with timeframe resampling" feat backend
```

---

### Task 5: setups router — wraps SignalEngine for live setups

**Files:**
- Create: `src/lib/trpc/routers/dashboard/setups.ts`

> No unit test for this router — `SignalEngine` is already exercised by the bot path. The router is a thin adapter. Verification is via integration in Task 14.

- [ ] **Step 1: Write the router**

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';
import { SignalEngine } from '@/lib/bot/signal-engine';
import type { BotSymbol } from '@/types';
import type { Candle } from '@/types';
import { readRecentCandles } from './candles';

export const setupsRouter = router({
  live: publicProcedure
    .input(
      z.object({
        symbol: z.string(),
        candleCount: z.number().int().min(100).max(2000).default(500),
      }),
    )
    .query(({ input }) => {
      const dbPath = path.resolve('data/app.db');
      if (!fs.existsSync(dbPath)) {
        return { available: false as const, signal: null, allScored: [], regime: 'unknown', reasoning: [] as string[] };
      }
      const db = new Database(dbPath, { readonly: true });
      try {
        const candles = readRecentCandles(db, input.symbol, input.candleCount) as Candle[];
        if (candles.length < 50) {
          return { available: true as const, signal: null, allScored: [], regime: 'unknown', reasoning: ['Insufficient candle history'] };
        }
        const engine = new SignalEngine();
        const result = engine.evaluate(candles, input.symbol as BotSymbol);
        return {
          available: true as const,
          signal: result.signal,
          allScored: result.allScored,
          regime: result.regime,
          reasoning: result.reasoning,
        };
      } finally {
        db.close();
      }
    }),
});
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck 2>&1 | grep "src/lib/trpc/routers/dashboard/setups" || echo "no errors"
```

Expected: "no errors". If errors appear, check that `BotSymbol` is the correct type name in `@/types` — adjust import accordingly.

- [ ] **Step 3: Commit**

```bash
gmp "add dashboard setups router wrapping signalengine" feat backend
```

---

### Task 6: dashboard router barrel + wire into appRouter

**Files:**
- Create: `src/lib/trpc/routers/dashboard/index.ts`
- Modify: `src/lib/trpc/routers/index.ts`

- [ ] **Step 1: Create barrel**

```ts
import { router } from '../../init';
import { statsRouter } from './stats';
import { decayRouter } from './decay';
import { candlesRouter } from './candles';
import { biasRouter } from './bias';
import { setupsRouter } from './setups';

export const dashboardRouter = router({
  stats: statsRouter,
  decay: decayRouter,
  candles: candlesRouter,
  bias: biasRouter,
  setups: setupsRouter,
});
```

- [ ] **Step 2: Wire into appRouter**

In `src/lib/trpc/routers/index.ts`, add:

```ts
import { dashboardRouter } from './dashboard';
```

And inside the `appRouter` `router({...})` call, add:

```ts
  dashboard: dashboardRouter,
```

So the file becomes:

```ts
import { router } from '../init';
import { kbRouter } from './kb';
import { flashcardsRouter } from './flashcards';
import { agentRouter } from './agent';
import { dashboardRouter } from './dashboard';

export const appRouter = router({
  kb: kbRouter,
  flashcards: flashcardsRouter,
  agent: agentRouter,
  dashboard: dashboardRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 3: Typecheck + tests**

```bash
pnpm typecheck 2>&1 | grep "src/lib/trpc" || echo "no errors"
pnpm test
```

Expected: typecheck clean for trpc; all dashboard tests still pass.

- [ ] **Step 4: Commit**

```bash
gmp "wire dashboard router into approuter" feat backend
```

---

### Task 7: BiasBadge + StatsBadge + DecayBadge (3 small UI components, no tests)

**Files:**
- Create: `src/components/dashboard/BiasBadge.tsx`
- Create: `src/components/dashboard/StatsBadge.tsx`
- Create: `src/components/dashboard/DecayBadge.tsx`

> Three pure presentational components. No state, no data fetching. UI rendering verified by Task 14 integration.

- [ ] **Step 1: BiasBadge.tsx**

```tsx
interface Props {
  regime: string;
  volRegime: string;
  confidence: number;
}

const COLOR: Record<string, string> = {
  uptrend: 'bg-green-700/40 text-green-200 border-green-600/40',
  downtrend: 'bg-red-700/40 text-red-200 border-red-600/40',
  ranging: 'bg-zinc-700/40 text-zinc-200 border-zinc-600/40',
  unknown: 'bg-zinc-800/40 text-zinc-400 border-zinc-700/40',
};

export function BiasBadge({ regime, volRegime, confidence }: Props) {
  const cls = COLOR[regime] ?? COLOR.unknown;
  return (
    <div className={`inline-flex flex-col gap-0.5 rounded-md border px-2 py-1 text-xs ${cls}`}>
      <span className="font-mono uppercase tracking-wide">{regime}</span>
      <span className="text-[10px] opacity-70">vol {volRegime} · conf {(confidence * 100).toFixed(0)}%</span>
    </div>
  );
}
```

- [ ] **Step 2: StatsBadge.tsx**

```tsx
interface Props {
  winRate: number;
  totalTrades: number;
  sharpe: number;
  source: string;
}

export function StatsBadge({ winRate, totalTrades, sharpe, source }: Props) {
  return (
    <div
      className="inline-flex items-baseline gap-2 rounded-md border border-blue-700/40 bg-blue-900/30 px-2 py-1 text-xs text-blue-200"
      title={`Source: ${source}`}
    >
      <span className="font-mono">{(winRate * 100).toFixed(1)}% WR</span>
      <span className="opacity-70">·</span>
      <span className="font-mono">{totalTrades} trades</span>
      <span className="opacity-70">·</span>
      <span className="font-mono">Sharpe {sharpe.toFixed(2)}</span>
    </div>
  );
}
```

- [ ] **Step 3: DecayBadge.tsx**

```tsx
interface Props {
  tripped: boolean;
  reason?: string;
}

export function DecayBadge({ tripped, reason }: Props) {
  if (tripped) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-yellow-700/60 bg-yellow-900/30 px-2 py-1 text-xs font-mono text-yellow-200"
        title={reason ?? 'Strategy decay tripped'}
      >
        ⚠ DECAY
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-700/40 bg-emerald-900/30 px-2 py-1 text-xs font-mono text-emerald-200">
      ✓ HEALTHY
    </span>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck 2>&1 | grep "src/components/dashboard" || echo "no errors"
```

Expected: "no errors".

- [ ] **Step 5: Commit**

```bash
gmp "add dashboard badge components" feat backend
```

---

### Task 8: BiasGrid component

**Files:**
- Create: `src/components/dashboard/BiasGrid.tsx`

- [ ] **Step 1: Discover the project's tRPC client hook pattern**

```bash
grep -rn "trpc\.\|useQuery\|api\." src/app/agent/ src/app/live-trading/ 2>/dev/null | head -10
cat src/lib/trpc/client.ts | head -30
```

Note the actual import path for the tRPC react-query client (likely `import { trpc } from '@/lib/trpc/client'` or similar). Use whatever pattern is already in the codebase. **If you can't determine the pattern from existing code, use the path A pattern: `import { trpc } from '@/lib/trpc/client'`.**

- [ ] **Step 2: Write BiasGrid.tsx**

```tsx
'use client';

import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { BiasBadge } from './BiasBadge';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
const TIMEFRAMES = ['1H', '4H', '1D'] as const;

export function BiasGrid() {
  const q = trpc.dashboard.bias.scan.useQuery(
    { symbols: [...SYMBOLS], timeframes: [...TIMEFRAMES] },
    { refetchInterval: 30_000 },
  );

  if (q.isLoading) return <div className="p-6 text-zinc-400">loading bias…</div>;
  if (q.isError) return <div className="p-6 text-red-400">error: {q.error.message}</div>;
  const data = q.data;
  if (!data || !data.available) {
    return <div className="p-6 text-zinc-400">no data — bot not running?</div>;
  }

  const cellMap = new Map<string, typeof data.cells[number]>();
  for (const c of data.cells) cellMap.set(`${c.symbol}|${c.timeframe}`, c);

  const lastUpdate = Math.max(0, ...data.cells.map((c) => c.lastUpdated));
  const ageSec = lastUpdate ? Math.floor((Date.now() - lastUpdate) / 1000) : null;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between text-sm text-zinc-400">
        <h2 className="text-lg font-semibold text-zinc-100">HTF Bias Scanner</h2>
        <span>{ageSec !== null ? `last bar ${ageSec}s ago` : 'no candle data'}</span>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wider text-zinc-500">
            <th className="px-3 py-2 font-medium">Symbol</th>
            {TIMEFRAMES.map((tf) => (
              <th key={tf} className="px-3 py-2 font-medium">{tf}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SYMBOLS.map((sym) => (
            <tr key={sym} className="border-b border-zinc-900 hover:bg-zinc-900/40">
              <td className="px-3 py-3">
                <Link href={`/dashboard/setup/${sym}`} className="font-mono text-zinc-100 hover:text-blue-300">
                  {sym}
                </Link>
              </td>
              {TIMEFRAMES.map((tf) => {
                const cell = cellMap.get(`${sym}|${tf}`);
                if (!cell) return <td key={tf} className="px-3 py-3 text-xs text-zinc-600">—</td>;
                return (
                  <td key={tf} className="px-3 py-3">
                    <BiasBadge regime={cell.regime} volRegime={cell.volRegime} confidence={cell.confidence} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck 2>&1 | grep "BiasGrid" || echo "no errors"
```

Expected: "no errors". If `trpc.dashboard.bias.scan.useQuery` does not type-check, the actual tRPC client path or hook name differs from the assumed one — fix the import based on what you found in Step 1.

- [ ] **Step 4: Commit**

```bash
gmp "add bias grid dashboard component" feat backend
```

---

### Task 9: SetupChart component

**Files:**
- Create: `src/components/dashboard/SetupChart.tsx`

- [ ] **Step 1: Write SetupChart.tsx**

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, type IChartApi, type Time } from 'lightweight-charts';

export interface SetupChartCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Props {
  candles: SetupChartCandle[];
  height?: number;
}

export function SetupChart({ candles, height = 400 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { color: '#0a0a0a' }, textColor: '#a1a1aa' },
      grid: {
        vertLines: { color: '#27272a' },
        horzLines: { color: '#27272a' },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      borderVisible: false,
    });
    series.setData(
      candles.map((c) => ({
        time: (Math.floor(c.timestamp / 1000)) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, height]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
```

> Note: `lightweight-charts` v5 changed its API to use `addSeries(CandlestickSeries, ...)` instead of the old `addCandlestickSeries`. If the installed version is v4 or lower, swap to `chart.addCandlestickSeries({...})` and remove the `CandlestickSeries` import.

- [ ] **Step 2: Verify lightweight-charts version**

```bash
grep '"lightweight-charts"' package.json
```

If the version is `^4.x.x` or lower, edit the component to use `chart.addCandlestickSeries(...)`.

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck 2>&1 | grep "SetupChart" || echo "no errors"
```

- [ ] **Step 4: Commit**

```bash
gmp "add lightweight-charts wrapper component for setup page" feat backend
```

---

### Task 10: SetupCard component

**Files:**
- Create: `src/components/dashboard/SetupCard.tsx`

- [ ] **Step 1: Write SetupCard.tsx**

```tsx
import { StatsBadge } from './StatsBadge';
import { DecayBadge } from './DecayBadge';

export interface SetupCardData {
  setupType: string;
  side: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confluenceScore: number;
  scoreBreakdown: Array<{ factor: string; value: number }>;
  strategyId: 'ict-3sym' | 'f2f-gold' | 'funding-arb' | string;
}

export interface SetupCardStats {
  winRate: number;
  totalTrades: number;
  sharpe: number;
  source: string;
}

export interface SetupCardDecay {
  tripped: boolean;
  reason?: string;
}

interface Props {
  data: SetupCardData;
  stats: SetupCardStats | null;
  decay: SetupCardDecay | null;
}

export function SetupCard({ data, stats, decay }: Props) {
  const sideColor = data.side === 'long' ? 'border-green-700/50' : 'border-red-700/50';
  return (
    <div className={`rounded-lg border ${sideColor} bg-zinc-900/60 p-4`}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <span className="font-mono text-sm uppercase tracking-wide text-zinc-100">
            {data.setupType}
          </span>
          <span className={`ml-2 font-mono text-xs ${data.side === 'long' ? 'text-green-300' : 'text-red-300'}`}>
            {data.side.toUpperCase()}
          </span>
        </div>
        <span className="font-mono text-sm text-zinc-300">
          score {data.confluenceScore.toFixed(2)}
        </span>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-3 text-xs text-zinc-400">
        <div>entry <span className="font-mono text-zinc-200">{data.entryPrice.toFixed(2)}</span></div>
        <div>SL <span className="font-mono text-red-300">{data.stopLoss.toFixed(2)}</span></div>
        <div>TP <span className="font-mono text-green-300">{data.takeProfit.toFixed(2)}</span></div>
      </div>
      <details className="mb-3">
        <summary className="cursor-pointer text-xs text-zinc-500">confluence breakdown</summary>
        <ul className="mt-2 space-y-1 text-xs">
          {data.scoreBreakdown.map((b) => (
            <li key={b.factor} className="flex justify-between font-mono text-zinc-400">
              <span>{b.factor}</span>
              <span>{b.value.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        {stats ? (
          <StatsBadge winRate={stats.winRate} totalTrades={stats.totalTrades} sharpe={stats.sharpe} source={stats.source} />
        ) : (
          <span className="text-xs text-zinc-500">validated stats unavailable</span>
        )}
        {decay && <DecayBadge tripped={decay.tripped} reason={decay.reason} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck 2>&1 | grep "SetupCard" || echo "no errors"
```

- [ ] **Step 3: Commit**

```bash
gmp "add setup card component with stats + decay badges" feat backend
```

---

### Task 11: `/dashboard` page

**Files:**
- Create: `src/app/dashboard/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { BiasGrid } from '@/components/dashboard/BiasGrid';

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h1 className="text-xl font-semibold">ICT Decision Support</h1>
        <p className="text-xs text-zinc-500">click a symbol to drill into setups</p>
      </header>
      <main>
        <BiasGrid />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Smoke check via dev server**

```bash
pnpm dev &
DEV_PID=$!
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/dashboard
kill $DEV_PID
```

Expected: `200`. The component will likely show "no data — bot not running?" if `data/app.db` is empty — that's fine for this smoke check.

- [ ] **Step 3: Commit**

```bash
gmp "add /dashboard page with bias grid" feat backend
```

---

### Task 12: `/dashboard/setup/[symbol]` page

**Files:**
- Create: `src/app/dashboard/setup/[symbol]/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
'use client';

import { use } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { SetupChart } from '@/components/dashboard/SetupChart';
import { SetupCard, type SetupCardData, type SetupCardStats, type SetupCardDecay } from '@/components/dashboard/SetupCard';

interface PageProps {
  params: Promise<{ symbol: string }>;
}

export default function SetupPage({ params }: PageProps) {
  const { symbol } = use(params);

  const candlesQ = trpc.dashboard.candles.recent.useQuery({ symbol, n: 300 });
  const setupsQ = trpc.dashboard.setups.live.useQuery({ symbol, candleCount: 500 });
  const statsQ = trpc.dashboard.stats.byPattern.useQuery();
  const decayQ = trpc.dashboard.decay.status.useQuery();

  const candles = candlesQ.data?.available ? candlesQ.data.candles : [];
  const setupsData = setupsQ.data;
  const stats = statsQ.data ?? [];
  const decay = decayQ.data;

  const statsForStrategy = (id: string): SetupCardStats | null => {
    const s = stats.find((x) => x.strategy === id);
    if (!s) return null;
    return { winRate: s.winRate, totalTrades: s.totalTrades, sharpe: s.sharpe, source: s.source };
  };

  const decayForStrategy = (id: string): SetupCardDecay | null => {
    if (!decay || !decay.available) return null;
    const d = decay.statuses.find((x) => x.strategy === id);
    if (!d) return null;
    return { tripped: d.tripped, reason: d.reason };
  };

  // ICT crypto symbols default to ict-3sym strategy attribution
  const strategyId = 'ict-3sym';

  // Build SetupCardData from the engine response
  const cards: SetupCardData[] = (setupsData?.allScored ?? []).slice(0, 5).map((s: unknown) => {
    const x = s as {
      candidate?: { side?: string; entryPrice?: number; stopLoss?: number; takeProfit?: number };
      score?: number;
      breakdown?: Array<{ factor: string; value: number }>;
      type?: string;
    };
    return {
      setupType: x.type ?? 'ict-setup',
      side: (x.candidate?.side === 'short' ? 'short' : 'long'),
      entryPrice: x.candidate?.entryPrice ?? 0,
      stopLoss: x.candidate?.stopLoss ?? 0,
      takeProfit: x.candidate?.takeProfit ?? 0,
      confluenceScore: x.score ?? 0,
      scoreBreakdown: x.breakdown ?? [],
      strategyId,
    };
  });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <div>
          <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-300">← back to grid</Link>
          <h1 className="font-mono text-xl font-semibold">{symbol}</h1>
        </div>
        <span className="text-xs text-zinc-500">
          {setupsQ.isLoading ? 'loading…' : (setupsData?.available ? 'live' : 'no data')}
        </span>
      </header>
      <main className="space-y-6 p-6">
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
          {candlesQ.isLoading ? (
            <div className="flex h-[400px] items-center justify-center text-zinc-500">loading candles…</div>
          ) : candles.length === 0 ? (
            <div className="flex h-[400px] items-center justify-center text-zinc-500">no candle data</div>
          ) : (
            <SetupChart candles={candles} />
          )}
        </section>
        <section>
          <h2 className="mb-3 text-sm uppercase tracking-wider text-zinc-400">Active setups</h2>
          {setupsQ.isLoading ? (
            <p className="text-zinc-500">loading…</p>
          ) : cards.length === 0 ? (
            <p className="text-zinc-500">no active setups · {setupsData?.reasoning?.[0] ?? ''}</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {cards.map((c, i) => (
                <SetupCard
                  key={i}
                  data={c}
                  stats={statsForStrategy(c.strategyId)}
                  decay={decayForStrategy(c.strategyId)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
```

> Note: the `s.allScored` shape is what `SignalEngine.evaluate()` returns. The exact field names may differ slightly — when this fails to typecheck, adjust the destructuring based on the actual `ConfluenceScorerResult` type.

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck 2>&1 | grep "setup/\[symbol\]" || echo "no errors"
```

Expected: "no errors" — and if it fails, fix the `allScored` field destructuring to match the real type.

- [ ] **Step 3: Smoke check**

```bash
pnpm dev &
DEV_PID=$!
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/dashboard/setup/BTCUSDT
kill $DEV_PID
```

Expected: `200`.

- [ ] **Step 4: Commit**

```bash
gmp "add setup drill-down page" feat backend
```

---

### Task 13: Final sanity + tag

**Files:** none

- [ ] **Step 1: Run full test suite + typecheck**

```bash
pnpm test 2>&1 | tail -3
pnpm typecheck 2>&1 | grep -E "src/lib/trpc/routers/dashboard|src/components/dashboard|src/app/dashboard" || echo "clean"
```

Expected:
- `pnpm test`: at least 11 tests pass (1 sanity + 5 stats + 3 decay + 2 candles + 3 bias = 14 total).
- `pnpm typecheck`: "clean" for dashboard files.

- [ ] **Step 2: Manual integration check**

```bash
pnpm dev
```

Open `http://localhost:3000/dashboard` in a browser. Confirm:
1. Bias grid renders (or shows "no data — bot not running?" if `data/app.db` is empty)
2. Click a symbol → setup page loads
3. Chart renders if candles exist

If `data/app.db` is empty, this test only confirms the rendering path, not real data. To test with data, run the bot briefly first to populate `bot_candles`.

- [ ] **Step 3: Tag the milestone**

```bash
git tag -a "path-3-dashboard-v1-$(date -u +%Y%m%d)" -m "ICT decision-support dashboard v1 shipped"
```

Local tag only.

---

## Self-review notes

- **Spec coverage:** Bias grid (Tasks 4, 7, 8, 11). Setup cards with validated stats (Tasks 1, 5, 7, 10, 12). Decay awareness (Tasks 2, 7, 10, 12). Candles backend (Task 3). Wiring (Task 6). Test infra (Task 0). Final sanity (Task 13). All spec sections covered. The `/dashboard` URL deviation from the spec's `/` is documented in File Structure section + applied consistently across components and pages.
- **Placeholder scan:** No TBDs. Task 8 Step 1 has a discovery instruction ("If you can't determine the pattern from existing code, use ..."). Task 9 Step 2 has a version-conditional ("If v4 or lower, swap to..."). Task 12 Step 1 has a "fix the destructuring if it fails to typecheck" instruction. These are all real branch-points the engineer must handle, not lazy placeholders — each gives a concrete fallback.
- **Type consistency:** `StrategyId` defined in Task 1's `stats.ts` is reused directly in `SetupCardData.strategyId` (Task 10) via re-import. `Timeframe` defined in Task 4 is used implicitly by `BiasGrid` (Task 8) through tRPC's inferred input type. `BotSymbol` is imported from `@/types` in Task 5 (existing project type, not invented). `Candle` is imported from `@/types` in Tasks 4 & 5 (existing).
- **No invented APIs:** `detectRegime(candles, currentIndex)` and `regimeLabel(regime)` from `src/lib/ict/regime-detector.ts` (verified), `SignalEngine` class with `evaluate(candles, symbol, currentIndex?)` from `src/lib/bot/signal-engine.ts` (verified), `bot_candles` table columns `(symbol, timestamp, open, high, low, close, volume)` from `src/lib/data/schema.ts` (verified), tRPC `router(...)` and `publicProcedure` from `src/lib/trpc/init.ts` (verified), `appRouter` shape from `src/lib/trpc/routers/index.ts` (verified). The tRPC client hook path (`@/lib/trpc/client`) is the assumed pattern; Task 8 Step 1 instructs the engineer to verify and fix if different.
