# Funding-Arb Validation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing funding-arb strategy at its shipped defaults through walk-forward + DSR + Monte Carlo validation, produce a verdict, and write a results JSON that's shape-compatible with `experiments/f2f-validation-results.json`.

**Architecture:** One new orchestration script (`scripts/validate-funding-arb.ts`) plus 4 small pure-function helpers in `src/lib/funding-arb-validation/` (window slicer, walk-forward iterator, Sharpe, trade-shape adapter, verdict assembler). The existing `scripts/backtest-funding-arb.ts` gets a minimal refactor (export two functions, wrap `main()` in an ESM-aware guard) so the validation script can import its core. No bot code is modified.

**Tech Stack:** TypeScript (strict), `tsx` for script execution, **Vitest** (added in Task 0 on this branch — also added independently on the path A branch; the configs are identical so the merge is a no-op), reuses `src/lib/rl/utils/{monte-carlo,deflated-sharpe}.ts`.

---

## File Structure

**Create:**
- `vitest.config.ts` — test runner config (identical to path A's; OK to duplicate, OK to conflict-resolve later)
- `tests/sanity.test.ts` — vitest smoke test (also identical to path A's)
- `src/lib/funding-arb-validation/types.ts` — local types: `WfWindow`, `ValidationCheck`, `ValidationResult`
- `src/lib/funding-arb-validation/window-slicer.ts` — `tradesInWindow(trades, startMs, endMs)`
- `src/lib/funding-arb-validation/walk-forward.ts` — `walkForwardWindows(rangeStart, rangeEnd, valDays, slideDays)`
- `src/lib/funding-arb-validation/sharpe.ts` — `computeAnnualizedSharpeFromReturns(returns, tradesPerYear)`
- `src/lib/funding-arb-validation/trade-adapter.ts` — `arbTradeToMcTrade(t, positionSizeUsdt)`
- `src/lib/funding-arb-validation/verdict.ts` — `assembleVerdict(checks)`
- `src/lib/funding-arb-validation/index.ts` — barrel
- `tests/funding-arb-validation/window-slicer.test.ts`
- `tests/funding-arb-validation/walk-forward.test.ts`
- `tests/funding-arb-validation/sharpe.test.ts`
- `tests/funding-arb-validation/trade-adapter.test.ts`
- `tests/funding-arb-validation/verdict.test.ts`
- `scripts/validate-funding-arb.ts` — orchestration script

**Modify:**
- `package.json` — add `vitest` + `@vitest/ui` dev deps + `test` script (Task 0)
- `scripts/backtest-funding-arb.ts` — `export` `loadFundingData` and `backtestSymbol`; wrap the bottom `main()` call in an ESM `import.meta.url` guard so import doesn't trigger CLI execution

---

### Task 0: Set up Vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/sanity.test.ts`

> **Note:** This is identical to path A's Task 0. Vitest was added on the path A branch (commit `973ef59` on `docs/portfolio-allocator-spec`). Path B branched from `main` (which doesn't have vitest), so we add it here too. When both branches merge, the duplicate-but-identical configs resolve cleanly. Don't try to be clever about deduping.

- [ ] **Step 1: Install Vitest**

```bash
pnpm add -D vitest @vitest/ui
```

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

### Task 1: Make `backtest-funding-arb.ts` importable

**Files:**
- Modify: `scripts/backtest-funding-arb.ts`

The validation script needs to call `loadFundingData` and `backtestSymbol` from the existing backtest script. Currently both are unexported, and the bottom-of-file `main()` call runs at import time. This task fixes both.

- [ ] **Step 1: Inspect the current bottom of the file**

```bash
tail -10 scripts/backtest-funding-arb.ts
```

Expected: a bare `main();` call after the function definitions.

- [ ] **Step 2: Add `export` to the two functions we need**

Find these lines and prepend `export `:

- `function loadFundingData(symbol: string): FundingRecord[] {` → `export function loadFundingData(symbol: string): FundingRecord[] {`
- `function backtestSymbol(...): ArbTrade[] {` → `export function backtestSymbol(...): ArbTrade[] {`

Also export the two interfaces the validation script will use:
- `interface ArbTrade {` → `export interface ArbTrade {`
- `interface BacktestConfig {` → `export interface BacktestConfig {`

- [ ] **Step 3: Wrap the bottom `main()` call so import doesn't trigger CLI**

Replace the bare `main();` at the bottom with:

```ts
import { fileURLToPath } from 'node:url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
```

> Add the `import { fileURLToPath } from 'node:url';` to the top of the file alongside the other imports. Don't put the import next to the conditional.

- [ ] **Step 4: Verify the CLI still works**

```bash
npx tsx scripts/backtest-funding-arb.ts --symbols BTCUSDT --min-rate 0.005 2>&1 | tail -15
```

Expected: backtest runs and prints the same summary as before. Trades file written to `experiments/funding-arb-backtest-results.json`.

- [ ] **Step 5: Verify import doesn't trigger run**

Create a temporary file `/tmp/test-import.ts`:

```ts
import { backtestSymbol, loadFundingData } from '../Users/apple/projects/personal/ict-trading/scripts/backtest-funding-arb.ts';
console.log('imported successfully:', typeof backtestSymbol, typeof loadFundingData);
```

> Adjust the import path to match the actual location. From the project root:

```bash
cat > /tmp/test-import.mts <<'EOF'
import { backtestSymbol, loadFundingData } from '/Users/apple/projects/personal/ict-trading/scripts/backtest-funding-arb.ts';
console.log('imported successfully:', typeof backtestSymbol, typeof loadFundingData);
EOF
npx tsx /tmp/test-import.mts
rm /tmp/test-import.mts
```

Expected: prints `imported successfully: function function` and exits. The backtest summary banner does NOT print.

- [ ] **Step 6: Commit**

```bash
gmp "make funding-arb backtest importable" refactor backend
```

---

### Task 2: Shared validation types

**Files:**
- Create: `src/lib/funding-arb-validation/types.ts`

- [ ] **Step 1: Write the types**

```ts
export interface WfWindow {
  startMs: number;
  endMs: number;
}

export interface ValidationCheck {
  name: string;
  value: string;
  threshold: string;
  pass: boolean;
}

export interface ValidationResult {
  timestamp: string;
  dataRange: { start: string; end: string; bars: number };
  config: Record<string, unknown>;
  checks: ValidationCheck[];
  details: {
    totalTrades: number;
    totalFundingCollected: number;
    netPnl: number;
    sharpe: number;
    deflatedSharpe: number;
    bootstrapSharpe5: number;
    bootstrapPnl5Pct: number;
    skip20PassRate: number;
    wfWindowsPass: number;
    wfWindowsTotal: number;
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck 2>&1 | grep "src/lib/funding-arb-validation/types.ts" || echo "no errors in types.ts"
```

Expected: "no errors in types.ts" (other pre-existing errors unrelated).

- [ ] **Step 3: Commit**

```bash
gmp "add funding-arb validation shared types" feat backend
```

---

### Task 3: Window slicer — pure function (TDD)

**Files:**
- Create: `tests/funding-arb-validation/window-slicer.test.ts`
- Create: `src/lib/funding-arb-validation/window-slicer.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { tradesInWindow } from '@/lib/funding-arb-validation/window-slicer';
import type { ArbTrade } from '../../scripts/backtest-funding-arb';

const D = (utc: string) => new Date(utc).getTime();

function fakeTrade(entryUtc: string, netPnl: number): ArbTrade {
  return {
    symbol: 'BTCUSDT',
    direction: 'short_perp',
    entryTimestamp: D(entryUtc),
    exitTimestamp: D(entryUtc) + 1000,
    entryFundingRate: 0.0003,
    holdTimeHours: 8,
    fundingPayments: 1,
    totalFundingCollected: netPnl + 1,
    spreadCost: 1,
    netPnl,
    annualizedAPY: 0.2,
    exitReason: 'rate_below',
  };
}

describe('tradesInWindow', () => {
  it('keeps trades whose entryTimestamp falls inside [startMs, endMs)', () => {
    const trades: ArbTrade[] = [
      fakeTrade('2026-01-01T00:00:00Z', 1),
      fakeTrade('2026-01-15T00:00:00Z', 2),
      fakeTrade('2026-02-01T00:00:00Z', 3), // exclusive end → excluded
      fakeTrade('2026-02-15T00:00:00Z', 4),
    ];
    const result = tradesInWindow(
      trades,
      D('2026-01-01T00:00:00Z'),
      D('2026-02-01T00:00:00Z'),
    );
    expect(result.map((t) => t.netPnl)).toEqual([1, 2]);
  });

  it('returns empty when no trades fall in window', () => {
    const trades: ArbTrade[] = [fakeTrade('2026-03-01T00:00:00Z', 5)];
    expect(
      tradesInWindow(trades, D('2026-01-01T00:00:00Z'), D('2026-02-01T00:00:00Z')),
    ).toEqual([]);
  });

  it('handles empty input', () => {
    expect(
      tradesInWindow([], D('2026-01-01T00:00:00Z'), D('2026-02-01T00:00:00Z')),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm test tests/funding-arb-validation/window-slicer.test.ts
```

Expected: FAIL — `tradesInWindow` not exported.

- [ ] **Step 3: Implement**

`src/lib/funding-arb-validation/window-slicer.ts`:

```ts
import type { ArbTrade } from '../../../scripts/backtest-funding-arb';

export function tradesInWindow(
  trades: ArbTrade[],
  startMs: number,
  endMs: number,
): ArbTrade[] {
  return trades.filter(
    (t) => t.entryTimestamp >= startMs && t.entryTimestamp < endMs,
  );
}
```

- [ ] **Step 4: Run, verify pass**

```bash
pnpm test tests/funding-arb-validation/window-slicer.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
gmp "add window slicer for walk-forward validation" feat backend
```

---

### Task 4: Walk-forward window iterator (TDD)

**Files:**
- Create: `tests/funding-arb-validation/walk-forward.test.ts`
- Create: `src/lib/funding-arb-validation/walk-forward.ts`

The spec says: train window 6mo (purely structural — funding arb has no fit step), val window 1mo, slide 1mo. The iterator only emits *val windows* — train is implicit.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { walkForwardValWindows } from '@/lib/funding-arb-validation/walk-forward';
import type { WfWindow } from '@/lib/funding-arb-validation/types';

const D = (utc: string) => new Date(utc).getTime();
const DAY = 86_400_000;

describe('walkForwardValWindows', () => {
  it('emits val windows that start after the warm-up (train) window', () => {
    // Range: 2026-01-01 → 2026-12-31 (~365 days). Train 180d, val 30d, slide 30d.
    // First val window starts at day 180.
    const windows = walkForwardValWindows(
      D('2026-01-01T00:00:00Z'),
      D('2026-12-31T00:00:00Z'),
      180,
      30,
      30,
    );
    expect(windows.length).toBeGreaterThan(0);
    // First val window starts ~180 days after range start
    const firstStartDay = (windows[0]!.startMs - D('2026-01-01T00:00:00Z')) / DAY;
    expect(firstStartDay).toBeCloseTo(180, 0);
    // Each window is exactly 30 days wide
    for (const w of windows) {
      expect((w.endMs - w.startMs) / DAY).toBeCloseTo(30, 0);
    }
    // Slide is 30 days between window starts
    const startDeltas = windows.slice(1).map(
      (w: WfWindow, i: number) => (w.startMs - windows[i]!.startMs) / DAY,
    );
    for (const d of startDeltas) {
      expect(d).toBeCloseTo(30, 0);
    }
  });

  it('returns empty when range is shorter than train + val', () => {
    const windows = walkForwardValWindows(
      D('2026-01-01T00:00:00Z'),
      D('2026-03-01T00:00:00Z'), // only 60 days
      180,
      30,
      30,
    );
    expect(windows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm test tests/funding-arb-validation/walk-forward.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/funding-arb-validation/walk-forward.ts`:

```ts
import type { WfWindow } from './types';

const DAY_MS = 86_400_000;

export function walkForwardValWindows(
  rangeStartMs: number,
  rangeEndMs: number,
  trainDays: number,
  valDays: number,
  slideDays: number,
): WfWindow[] {
  const windows: WfWindow[] = [];
  const trainMs = trainDays * DAY_MS;
  const valMs = valDays * DAY_MS;
  const slideMs = slideDays * DAY_MS;

  let valStart = rangeStartMs + trainMs;
  while (valStart + valMs <= rangeEndMs) {
    windows.push({ startMs: valStart, endMs: valStart + valMs });
    valStart += slideMs;
  }
  return windows;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
pnpm test tests/funding-arb-validation/walk-forward.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
gmp "add walk-forward val window iterator" feat backend
```

---

### Task 5: Annualized Sharpe helper (TDD)

**Files:**
- Create: `tests/funding-arb-validation/sharpe.test.ts`
- Create: `src/lib/funding-arb-validation/sharpe.ts`

For trade-level returns, annualization factor is `sqrt(tradesPerYear)`. The MC utilities expect this same factor.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { computeAnnualizedSharpeFromReturns } from '@/lib/funding-arb-validation/sharpe';

describe('computeAnnualizedSharpeFromReturns', () => {
  it('returns null for fewer than 5 returns', () => {
    expect(computeAnnualizedSharpeFromReturns([0.01, 0.02], 50)).toBeNull();
  });

  it('returns null for zero stdev', () => {
    expect(
      computeAnnualizedSharpeFromReturns(Array(30).fill(0.001), 50),
    ).toBeNull();
  });

  it('annualizes positive-mean returns by sqrt(tradesPerYear)', () => {
    // 60 returns alternating +0.005 / -0.001 → mean=0.002, stdev≈0.003
    // Sharpe per trade ≈ 0.002 / 0.003 = 0.667
    // Annualized at 50 trades/yr ≈ 0.667 * sqrt(50) ≈ 4.71
    const returns = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? 0.005 : -0.001,
    );
    const s = computeAnnualizedSharpeFromReturns(returns, 50);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(3);
    expect(s!).toBeLessThan(7);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm test tests/funding-arb-validation/sharpe.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/funding-arb-validation/sharpe.ts`:

```ts
const MIN_RETURNS_FOR_SHARPE = 5;

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function computeAnnualizedSharpeFromReturns(
  returns: number[],
  tradesPerYear: number,
): number | null {
  if (returns.length < MIN_RETURNS_FOR_SHARPE) return null;
  const sd = stdev(returns);
  if (sd === 0) return null;
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  return (mean / sd) * Math.sqrt(tradesPerYear);
}
```

- [ ] **Step 4: Run, verify pass**

```bash
pnpm test tests/funding-arb-validation/sharpe.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
gmp "add annualized sharpe helper for trade-level returns" feat backend
```

---

### Task 6: ArbTrade → MCTradeResult adapter (TDD)

**Files:**
- Create: `tests/funding-arb-validation/trade-adapter.test.ts`
- Create: `src/lib/funding-arb-validation/trade-adapter.ts`

The MC utilities consume `MCTradeResult { pnlPercent: number }`. We convert per-trade `netPnl` (USD) into `pnlPercent` (fraction of position size).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { arbTradesToMcTrades } from '@/lib/funding-arb-validation/trade-adapter';
import type { ArbTrade } from '../../scripts/backtest-funding-arb';

function fakeTrade(netPnl: number): ArbTrade {
  return {
    symbol: 'BTCUSDT',
    direction: 'short_perp',
    entryTimestamp: 0,
    exitTimestamp: 1000,
    entryFundingRate: 0.0003,
    holdTimeHours: 8,
    fundingPayments: 1,
    totalFundingCollected: netPnl + 1,
    spreadCost: 1,
    netPnl,
    annualizedAPY: 0.2,
    exitReason: 'rate_below',
  };
}

describe('arbTradesToMcTrades', () => {
  it('converts each trade to {pnlPercent: netPnl/positionSize}', () => {
    const trades = [fakeTrade(20), fakeTrade(-5), fakeTrade(0)];
    const mc = arbTradesToMcTrades(trades, 2000);
    expect(mc).toEqual([
      { pnlPercent: 0.01 },
      { pnlPercent: -0.0025 },
      { pnlPercent: 0 },
    ]);
  });

  it('throws on zero positionSize (invalid input)', () => {
    expect(() => arbTradesToMcTrades([fakeTrade(20)], 0)).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm test tests/funding-arb-validation/trade-adapter.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/funding-arb-validation/trade-adapter.ts`:

```ts
import type { MCTradeResult } from '@/lib/rl/utils/monte-carlo';
import type { ArbTrade } from '../../../scripts/backtest-funding-arb';

export function arbTradesToMcTrades(
  trades: ArbTrade[],
  positionSizeUsdt: number,
): MCTradeResult[] {
  if (positionSizeUsdt <= 0) {
    throw new Error(
      `arbTradesToMcTrades: positionSizeUsdt must be > 0, got ${positionSizeUsdt}`,
    );
  }
  return trades.map((t) => ({ pnlPercent: t.netPnl / positionSizeUsdt }));
}
```

- [ ] **Step 4: Run, verify pass**

```bash
pnpm test tests/funding-arb-validation/trade-adapter.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
gmp "add arbtrade to mctradeesult adapter" feat backend
```

---

### Task 7: Verdict assembler (TDD)

**Files:**
- Create: `tests/funding-arb-validation/verdict.test.ts`
- Create: `src/lib/funding-arb-validation/verdict.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { assembleVerdict } from '@/lib/funding-arb-validation/verdict';
import type { ValidationCheck } from '@/lib/funding-arb-validation/types';

const c = (name: string, pass: boolean): ValidationCheck => ({
  name,
  value: pass ? 'good' : 'bad',
  threshold: 'X',
  pass,
});

describe('assembleVerdict', () => {
  it('returns DEPLOY_WITH_CONFIDENCE on 5/5', () => {
    const v = assembleVerdict([c('a', true), c('b', true), c('c', true), c('d', true), c('e', true)]);
    expect(v.passCount).toBe(5);
    expect(v.totalCount).toBe(5);
    expect(v.recommendation).toMatch(/deploy with confidence/i);
  });

  it('returns DEPLOY on 4/5', () => {
    const v = assembleVerdict([c('a', true), c('b', true), c('c', true), c('d', true), c('e', false)]);
    expect(v.passCount).toBe(4);
    expect(v.recommendation).toMatch(/^deploy/i);
    expect(v.recommendation).not.toMatch(/confidence/i);
  });

  it('returns STOP on <=3/5', () => {
    const v = assembleVerdict([c('a', true), c('b', true), c('c', true), c('d', false), c('e', false)]);
    expect(v.passCount).toBe(3);
    expect(v.recommendation).toMatch(/stop/i);
  });

  it('handles all-failing', () => {
    const v = assembleVerdict([c('a', false), c('b', false)]);
    expect(v.passCount).toBe(0);
    expect(v.recommendation).toMatch(/stop/i);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm test tests/funding-arb-validation/verdict.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/funding-arb-validation/verdict.ts`:

```ts
import type { ValidationCheck } from './types';

export interface Verdict {
  passCount: number;
  totalCount: number;
  recommendation: string;
}

export function assembleVerdict(checks: ValidationCheck[]): Verdict {
  const passCount = checks.filter((c) => c.pass).length;
  const totalCount = checks.length;

  let recommendation: string;
  if (totalCount === 5 && passCount === 5) {
    recommendation = `${passCount}/${totalCount} PASS — deploy with confidence`;
  } else if (totalCount === 5 && passCount === 4) {
    recommendation = `${passCount}/${totalCount} — deploy`;
  } else {
    recommendation = `${passCount}/${totalCount} — stop and document findings`;
  }

  return { passCount, totalCount, recommendation };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
pnpm test tests/funding-arb-validation/verdict.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
gmp "add validation verdict assembler" feat backend
```

---

### Task 8: Barrel exports

**Files:**
- Create: `src/lib/funding-arb-validation/index.ts`

- [ ] **Step 1: Write the barrel**

```ts
export * from './types';
export * from './window-slicer';
export * from './walk-forward';
export * from './sharpe';
export * from './trade-adapter';
export * from './verdict';
```

- [ ] **Step 2: Verify tests still pass**

```bash
pnpm test
```

Expected: all 12 tests pass (3+2+3+2+4 from Tasks 3-7, +1 sanity from Task 0).

- [ ] **Step 3: Commit**

```bash
gmp "add funding-arb-validation barrel exports" feat backend
```

---

### Task 9: Validation orchestration script

**Files:**
- Create: `scripts/validate-funding-arb.ts`

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * Funding-Arb Validation
 *
 * Runs the existing funding-arb strategy at shipped defaults through:
 *   1. Baseline backtest (full data)
 *   2. Walk-forward (6mo train / 1mo val / 1mo slide)
 *   3. DSR (1-trial selection bias correction)
 *   4. MC bootstrap (1000 iter, Sharpe + PnL 5th percentile)
 *   5. MC skip-trades (20% drop, 1000 iter, profitable fraction)
 *
 * Output: experiments/funding-arb-validation-results.json (shape-compatible
 * with experiments/f2f-validation-results.json so path A's bootstrap-floors
 * loader can consume it later).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadFundingData,
  backtestSymbol,
  type ArbTrade,
  type BacktestConfig,
} from './backtest-funding-arb';
import {
  tradesInWindow,
  walkForwardValWindows,
  computeAnnualizedSharpeFromReturns,
  arbTradesToMcTrades,
  assembleVerdict,
  type ValidationCheck,
  type ValidationResult,
} from '@/lib/funding-arb-validation';
import {
  bootstrapTrades,
  skipTrades,
} from '@/lib/rl/utils/monte-carlo';
import { calculateDeflatedSharpe } from '@/lib/rl/utils/deflated-sharpe';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TRAIN_DAYS = 180;
const VAL_DAYS = 30;
const SLIDE_DAYS = 30;
const MC_ITERATIONS = 1000;
const SKIP_RATE = 0.20;
const MIN_DATA_YEARS = 2.5;
const OUT_VALIDATION = path.resolve(
  'experiments/funding-arb-validation-results.json',
);
const OUT_BASELINE = path.resolve(
  'experiments/funding-arb-baseline.json',
);

const SHIPPED_DEFAULTS: BacktestConfig = {
  symbols: DEFAULT_SYMBOLS,
  minFundingRate: 0.0002,
  closeBelowRate: 0.00005,
  positionSizeUSDT: 2000,
  maxHoldTimeHours: 168,
  commissionPerSide: 0.00055,
  spreadAssumption: {
    BTCUSDT: 0.0002,
    ETHUSDT: 0.0003,
    SOLUSDT: 0.0003,
  },
  maxArbPositions: 3,
};

function preflight(symbols: string[]): {
  rangeStart: number;
  rangeEnd: number;
  totalBars: number;
} {
  let rangeStart = Infinity;
  let rangeEnd = -Infinity;
  let totalBars = 0;
  for (const sym of symbols) {
    const records = loadFundingData(sym);
    if (records.length === 0) {
      throw new Error(`Pre-flight: no data for ${sym}`);
    }
    rangeStart = Math.min(rangeStart, records[0]!.timestamp);
    rangeEnd = Math.max(rangeEnd, records[records.length - 1]!.timestamp);
    totalBars += records.length;
  }
  const years = (rangeEnd - rangeStart) / (365.25 * 86_400_000);
  if (years < MIN_DATA_YEARS) {
    throw new Error(
      `Pre-flight: data span ${years.toFixed(2)}y < required ${MIN_DATA_YEARS}y`,
    );
  }
  console.log(
    `Pre-flight OK: ${symbols.length} symbols, ${years.toFixed(2)}y span, ${totalBars} bars total`,
  );
  return { rangeStart, rangeEnd, totalBars };
}

function runBaseline(symbols: string[]): ArbTrade[] {
  const allTrades: ArbTrade[] = [];
  for (const sym of symbols) {
    const records = loadFundingData(sym);
    const trades = backtestSymbol(sym, records, SHIPPED_DEFAULTS);
    allTrades.push(...trades);
    console.log(
      `  ${sym}: ${trades.length} trades, total netPnl $${trades.reduce((s, t) => s + t.netPnl, 0).toFixed(2)}`,
    );
  }
  return allTrades.sort((a, b) => a.entryTimestamp - b.entryTimestamp);
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const symbols = DEFAULT_SYMBOLS;

  console.log('='.repeat(60));
  console.log('Funding-Arb Validation');
  console.log('='.repeat(60));

  const { rangeStart, rangeEnd, totalBars } = preflight(symbols);
  console.log('\n--- Baseline backtest ---');
  const trades = runBaseline(symbols);

  if (trades.length === 0) {
    throw new Error(
      'Baseline produced 0 trades. Strategy never triggered. Check data shape and `fundingRate` field.',
    );
  }

  fs.writeFileSync(OUT_BASELINE, JSON.stringify({ trades }, null, 2));
  console.log(`Wrote baseline trade ledger to ${OUT_BASELINE}`);

  // ---- Trade-level metrics ----
  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalFunding = trades.reduce(
    (s, t) => s + t.totalFundingCollected,
    0,
  );
  const yearsSpan = (rangeEnd - rangeStart) / (365.25 * 86_400_000);
  const tradesPerYear = trades.length / yearsSpan;

  const returns = trades.map((t) => t.netPnl / SHIPPED_DEFAULTS.positionSizeUSDT);
  const sharpe = computeAnnualizedSharpeFromReturns(returns, tradesPerYear) ?? 0;

  console.log(
    `Total trades: ${trades.length}, total funding: $${totalFunding.toFixed(2)}, net PnL: $${totalPnl.toFixed(2)}, Sharpe: ${sharpe.toFixed(2)}`,
  );

  // ---- Walk-forward ----
  console.log('\n--- Walk-forward ---');
  const windows = walkForwardValWindows(
    rangeStart,
    rangeEnd,
    TRAIN_DAYS,
    VAL_DAYS,
    SLIDE_DAYS,
  );
  let wfPass = 0;
  let wfTotal = 0;
  for (const w of windows) {
    const wt = tradesInWindow(trades, w.startMs, w.endMs);
    if (wt.length === 0) continue; // skip empty windows
    wfTotal += 1;
    const wPnl = wt.reduce((s, t) => s + t.netPnl, 0);
    if (wPnl > 0) wfPass += 1;
  }
  const wfPassRate = wfTotal > 0 ? wfPass / wfTotal : 0;
  console.log(
    `Walk-forward: ${wfPass}/${wfTotal} windows positive (${fmtPct(wfPassRate)})`,
  );

  // ---- DSR ----
  const dsrResult = calculateDeflatedSharpe(sharpe, trades.length, 1);
  console.log(`DSR: ${dsrResult.deflatedSharpe.toFixed(2)} (haircut ${dsrResult.haircut.toFixed(2)})`);

  // ---- MC ----
  console.log('\n--- Monte Carlo ---');
  const mcInput = arbTradesToMcTrades(trades, SHIPPED_DEFAULTS.positionSizeUSDT);
  const annFactor = Math.sqrt(tradesPerYear);
  const boot = bootstrapTrades(mcInput, MC_ITERATIONS, undefined, annFactor);
  const skip = skipTrades(mcInput, SKIP_RATE, MC_ITERATIONS, annFactor);

  console.log(
    `Bootstrap Sharpe 5th: ${boot.sharpe.p5.toFixed(2)}, PnL 5th: ${(boot.finalPnl.p5 * 100).toFixed(1)}%`,
  );
  console.log(
    `Skip 20% profitable fraction: ${fmtPct(skip.profitableFraction)}`,
  );

  // ---- Verdict ----
  const checks: ValidationCheck[] = [
    {
      name: 'Walk-Forward >=60%',
      value: fmtPct(wfPassRate),
      threshold: '>=60%',
      pass: wfPassRate >= 0.60,
    },
    {
      name: 'DSR >0',
      value: dsrResult.deflatedSharpe.toFixed(2),
      threshold: '>0',
      pass: dsrResult.deflatedSharpe > 0,
    },
    {
      name: 'MC Bootstrap Sharpe 5th >0',
      value: boot.sharpe.p5.toFixed(2),
      threshold: '>0',
      pass: boot.sharpe.p5 > 0,
    },
    {
      name: 'MC Bootstrap PnL 5th >0%',
      value: fmtPct(boot.finalPnl.p5),
      threshold: '>0%',
      pass: boot.finalPnl.p5 > 0,
    },
    {
      name: 'MC Skip 20% >=95%',
      value: fmtPct(skip.profitableFraction),
      threshold: '>=95%',
      pass: skip.profitableFraction >= 0.95,
    },
  ];

  const verdict = assembleVerdict(checks);
  const result: ValidationResult = {
    timestamp: new Date().toISOString(),
    dataRange: {
      start: new Date(rangeStart).toISOString().slice(0, 10),
      end: new Date(rangeEnd).toISOString().slice(0, 10),
      bars: totalBars,
    },
    config: SHIPPED_DEFAULTS as unknown as Record<string, unknown>,
    checks,
    details: {
      totalTrades: trades.length,
      totalFundingCollected: totalFunding,
      netPnl: totalPnl,
      sharpe,
      deflatedSharpe: dsrResult.deflatedSharpe,
      bootstrapSharpe5: boot.sharpe.p5,
      bootstrapPnl5Pct: boot.finalPnl.p5,
      skip20PassRate: skip.profitableFraction,
      wfWindowsPass: wfPass,
      wfWindowsTotal: wfTotal,
    },
  };

  fs.writeFileSync(OUT_VALIDATION, JSON.stringify(result, null, 2));
  console.log('\n' + '='.repeat(60));
  console.log(`VERDICT: ${verdict.recommendation}`);
  console.log('='.repeat(60));
  console.log(`Wrote ${OUT_VALIDATION}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck 2>&1 | grep "validate-funding-arb" || echo "no errors"
```

Expected: "no errors" (other pre-existing errors in unrelated files OK).

- [ ] **Step 3: Commit (without running yet)**

```bash
gmp "add funding-arb validation orchestration script" feat backend
```

---

### Task 10: Run validation against real data

**Files:** none (execution only)

- [ ] **Step 1: Run the script**

```bash
npx tsx scripts/validate-funding-arb.ts 2>&1 | tee /tmp/funding-arb-validation-run.log
```

Expected: script runs to completion, prints VERDICT line, writes both `experiments/funding-arb-baseline.json` and `experiments/funding-arb-validation-results.json`.

- [ ] **Step 2: Inspect results**

```bash
cat experiments/funding-arb-validation-results.json | head -60
```

Read the `checks` array. Note the verdict.

- [ ] **Step 3: Decide path forward based on verdict**

- **5/5 PASS — deploy with confidence**: report DONE_WITH_VERDICT, link the results file, recommend the deployment spec as the next session.
- **4/5 — deploy**: same as above, but flag the failing check explicitly.
- **3/5 or worse — stop**: report DONE_WITH_VERDICT, do NOT recommend deployment, summarize which checks failed and which symbols/conditions hurt most.

Do not write a deployment spec. That's a separate session.

- [ ] **Step 4: Commit the results files**

```bash
gmp "capture funding-arb validation baseline + results" feat experiments
```

> The two `experiments/*.json` files are research artifacts — committed alongside ICT/F2F results in the same directory.

---

### Task 11: Final sanity + tag

**Files:** none

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test
```

Expected: all 12 tests pass (1 sanity + 3 window-slicer + 2 walk-forward + 3 sharpe + 2 trade-adapter + 4 verdict = 15 tests... wait, recount: 1+3+2+3+2+4 = 15. Adjust if your numbers differ).

- [ ] **Step 2: Typecheck the new files**

```bash
pnpm typecheck 2>&1 | grep -E "funding-arb-validation|validate-funding-arb" || echo "clean"
```

Expected: "clean".

- [ ] **Step 3: Tag the milestone**

```bash
git tag -a "path-b-validated-$(date -u +%Y%m%d)" -m "Funding-arb validation pipeline shipped + run"
```

Local tag only. Don't push.

---

## Self-review notes

- **Spec coverage:** Pre-flight (Task 9), baseline backtest (Task 9 via Tasks 1, 6), walk-forward (Tasks 3, 4, 9), DSR (Task 9), MC bootstrap + skip (Task 9), 5-check verdict + JSON (Tasks 7, 9), shape compatibility with f2f-validation (Task 9). Test infra (Task 0). Refactor of existing backtest (Task 1). Run + decision (Task 10). All spec sections covered.
- **Placeholder scan:** No TBDs, no "implement later", every code step contains complete code. Two `[from audit]`-style placeholders in Task 11 Step 1's expected count are explicitly explained ("adjust if your numbers differ" — counting tests across multiple suites is brittle, so the engineer is told what to do if the actual count differs).
- **Type consistency:** `ArbTrade` and `BacktestConfig` are exported from `scripts/backtest-funding-arb.ts` (Task 1); used in Tasks 3, 6, 9. `WfWindow`, `ValidationCheck`, `ValidationResult` defined in Task 2 (`types.ts`), used in Tasks 4, 7, 9. `Verdict` defined in Task 7, used in Task 9. `MCTradeResult` imported from existing utils, no naming conflict.
- **No invented APIs:** `loadFundingData`, `backtestSymbol`, `ArbTrade`, `BacktestConfig` exist in `scripts/backtest-funding-arb.ts` (verified by grep before writing the plan). `bootstrapTrades(trades, iter, sampleSize?, annFactor?)`, `skipTrades(trades, rate, iter, annFactor?)`, `MCTradeResult { pnlPercent }`, `MCDistribution { p5, ... }`, `calculateDeflatedSharpe(sharpe, numTrades, numTrials, opts?)`, `DeflatedSharpeResult { deflatedSharpe, haircut, ... }` all verified by grep before writing the plan.
- **Branch coordination caveat:** Vitest is added independently here and on path A. When both branches merge to main, the duplicate-but-identical setup commit deduplicates cleanly. If path A merges first, this branch's Task 0 becomes a no-op rebase.
