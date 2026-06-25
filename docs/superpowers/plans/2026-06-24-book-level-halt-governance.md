# Book-Level Halt Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the *edge-decay* hard-halt authority from each individual sleeve up to the **combined book**, so a single sleeve (crypto today) is no longer hard-halted on its own thin/decaying track record while the diversified portfolio is healthy — keeping each sleeve's local *catastrophic* drawdown stop intact.

**Architecture:** A **layered (hybrid pod-shop) governance model**. Each sleeve keeps its fast, local **absolute-drawdown hard stop** (catastrophe protection). A new **central book governor** computes the live combined-book rolling Sharpe + drawdown, decides `trade | derisk | halt`, and writes a small `data/book-governance.json` signal (mirroring the existing `data/KILL` file-signal pattern). Each sleeve bot reads that signal every tick and applies the **more conservative** of its local decision and the book decision. The per-sleeve *sustained-DSR* hard halt (the leg that mis-fired on crypto) is re-scoped to a soft de-risk; durable edge-decay is now judged where capital is actually allocated — at the book.

**Tech Stack:** TypeScript (strict), Vitest, better-sqlite3 + Drizzle, tsx, PM2. Pure decision logic with dependency-injected clock/IO (matches `src/lib/bot/retirement.ts` and `kill-switch.ts` conventions).

## Research grounding (why book-level)

- **Multi-strategy funds use a hybrid model** — per-pod drawdown stops *plus* a central risk team governing at the portfolio level; a single pod's drawdown is expected and absorbed ([Managing Multi-Strategy Quantitative Funds](https://oboe.com/learn/managing-multi-strategy-quantitative-funds-6kpdpu/study-guide), [Multi-Strategy Hedge Funds Explained](https://alpha-maven.com/learn/multi-strategy-hedge-funds), [7 Risk Management Strategies for Algorithmic Trading](https://nurp.com/algorithmic-trading-blog/7-risk-management-strategies-for-algorithmic-trading/)).
- **Carver:** diversification and the position-management framework matter more than per-rule on/off switches; cross-instrument diversification amplifies marginally-profitable sleeves ([Systematic Trading](https://qoppac.blogspot.com/p/systematic-trading-start-here.html), [Better System Trader #026](https://bettersystemtrader.com/026-robert-carver/)).
- **Strategy decay / DSR:** retirement should be triggered by a *substantial, sustained* drop in rolling Sharpe, corrected for selection bias — not a single noisy sub-floor reading ([Strategy-Decay Risk](https://larryswedroe.substack.com/p/strategy-decay-risk-why-your-best), [The Deflated Sharpe Ratio (Bailey & López de Prado)](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)).

This directly motivates: **keep local catastrophic DD stops, lift edge-decay judgement to the book, and make the book signal a sustained (60-day) measure.**

## Global Constraints

- **Paper-only.** No real-money keys. No change to live order placement.
- **TDD, no `any`** — figure out real types or use `unknown` + narrowing (per `~/.claude/rules/typescript-patterns.md`).
- **DI the clock/IO** — pure decision functions take `nowMs` and values; no `Date.now()`/`fetch`/DB in logic files.
- **Fail-open on the book signal** — a missing/stale/corrupt `data/book-governance.json` must NEVER block trading; sleeves fall back to local-only governance (a dead governor cannot freeze the book).
- **Never gate on global `pnpm typecheck` exit code** — the repo has ~227 pre-existing errors. Gate on: (a) the task's vitest files pass; (b) NEW-errors-only typecheck on edited files vs baseline `git show origin/main:<file>`; (c) `npx eslint <edited files>` clean.
- **Commit with `gmp "<msg>" <type> backend`** — never raw `git commit`.
- **Frozen thresholds copied verbatim from existing code:** book WATCH = 30-day annualised Sharpe `< 0`; book BREACH = 60-day annualised Sharpe `< -1.0` (from `scripts/run-allocator.ts:statusOf`); `minTrackRecordLength`-style data gates: 30-day needs ≥10 obs, 60-day needs ≥20 obs (from `rollingFromDaily`); cluster weights crypto `0.50` / sessionBookRetail `0.30` / f2f `0.20` (from `run-allocator.ts:CLUSTER_WEIGHTS`).

---

## Background: what exists today (read before starting)

- `src/lib/bot/retirement.ts` — pure halt confluence. ACTIVE legs: (1) **absolute-DD hard halt** `drawdown >= hardKillDD`; (2) **sustained-DSR streak hard halt** `dsrBreachConsecutive >= dsrBreachK` (config `dsrBreachK=3`); (3) **soft de-risk band**. `evaluateRetirementHalt(inputs)` is the per-tick entry. Setting `dsrBreachK=0` disables leg (2) — the code guards `dsrBreachK > 0` and a sub-floor DSR then falls through to the soft de-risk leg (`if (dsrInsignificant) → derisk 0.5`).
- `src/lib/bot/config.ts` — `RETIREMENT_CONFIG` (`minAcceptableSharpe: 0.5`, `minTrackRecordLength: 50`, `dsrBreachK: 3`, …).
- `scripts/run-bot.ts` — crypto sleeve. `evaluateRetirement(nowMs)` (~lines 616-685) calls `evaluateRetirementHalt({ …, config: RETIREMENT_CONFIG })` with the sleeve's OWN `getRollingDeflatedSharpeObs`; on `'halt'` → `setKillFlag(db, {source:'retirement'})` (DB-latched, restart-durable). This is the leg that hard-halted crypto on a ~57-observation record.
- `scripts/run-allocator.ts` — ADVISORY monitor. Already has `statusOf(sharpe30, sharpe60, days)` (`BREACH` if `sharpe60 < -1.0`, `WATCH` if `sharpe30 < 0`, `NO DATA` if `days < 10`, else `OK`), `rollingFromDaily(byDay)` (per-day map → sharpe30/60), per-sleeve live readers (`liveSessionBook` from `data/metals-bot-state.json`, `liveF2F` from `data/gold-bot-state.json`, crypto from `bot_equity_snapshots`), and helpers `annSharpe`, `std`, `mean`, `corrOf`, plus `SLEEVES`, `CLUSTER_WEIGHTS`. **It computes per-sleeve status but NOT a book-aggregate status, and writes no signal.**
- `src/lib/bot/kill-switch.ts` — `KillFlag`, `setKillFlag`, `isKilled` (DB-latched) + the `data/KILL` file pattern (the model for our JSON signal).

## File Structure

- **Create** `src/lib/bot/book-governance.ts` — pure decision (`decideBookGovernance`) + pure book-Sharpe aggregation (`computeBookGovernanceState`) + signal read/write IO helpers (`writeBookGovernanceSignal`, `readBookGovernanceSignal`). One responsibility: the book-level governor. ~180 lines.
- **Create** `tests/bot/book-governance.test.ts` — unit tests for the pure decision + aggregation + signal staleness.
- **Modify** `src/lib/bot/config.ts` — add `BOOK_GOVERNANCE_CONFIG`; flip `RETIREMENT_CONFIG.dsrBreachK` handling is done at the call site (Task 6), config itself documents the change.
- **Modify** `scripts/run-allocator.ts` — after computing per-sleeve live series, aggregate the book series, call `computeBookGovernanceState` + `decideBookGovernance`, and `writeBookGovernanceSignal`. Print the book status line.
- **Modify** `scripts/run-bot.ts` — in `evaluateRetirement`: (a) pass `dsrBreachK: 0` override (re-scope leg 2 to soft de-risk); (b) read the book signal, combine multipliers, and on a book HARD action latch `setKillFlag(source:'book-governance')`.
- **Modify** `ecosystem.config.cjs` — add a `book-governor` PM2 app running the allocator in signal-writing mode on a cadence.
- **Modify** `RUNNING.md` — operator runbook: how the governor works, how to clear the stale per-sleeve retirement latch so crypto resumes under book governance.

---

## Task 1: Book-governance decision (pure) + config

**Files:**
- Create: `src/lib/bot/book-governance.ts`
- Modify: `src/lib/bot/config.ts` (add `BOOK_GOVERNANCE_CONFIG`)
- Test: `tests/bot/book-governance.test.ts`

**Interfaces:**
- Produces: `decideBookGovernance(inputs: BookGovernanceInputs): BookGovernanceDecision`, `BookGovernanceConfig`, `BOOK_GOVERNANCE_CONFIG`.
- Consumes: `expectedMaxDD`, `hardKillDD` from `@/lib/bot/retirement` (reuse the frozen DD bounds — do NOT re-derive).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/bot/book-governance.test.ts
import { describe, it, expect } from 'vitest';
import { decideBookGovernance, BOOK_GOVERNANCE_CONFIG } from '@/lib/bot/book-governance';

const cfg = BOOK_GOVERNANCE_CONFIG;

describe('decideBookGovernance', () => {
  it('all-clear ⇒ trade ×1', () => {
    const d = decideBookGovernance({ bookSharpe30: 2.1, bookSharpe60: 2.0, bookDrawdown: 0.02, days: 120, config: cfg });
    expect(d.action).toBe('trade');
    expect(d.multiplier).toBe(1);
  });

  it('WATCH (30d Sharpe < 0) is OBSERVE-only ⇒ still trade ×1 (flat is normal)', () => {
    const d = decideBookGovernance({ bookSharpe30: -0.4, bookSharpe60: 0.8, bookDrawdown: 0.03, days: 120, config: cfg });
    expect(d.action).toBe('trade');
    expect(d.multiplier).toBe(1);
    expect(d.watch).toBe(true);
  });

  it('BREACH (60d Sharpe < -1) ⇒ de-risk ×0.5 + review flag (NOT auto hard-halt)', () => {
    const d = decideBookGovernance({ bookSharpe30: -1.5, bookSharpe60: -1.2, bookDrawdown: 0.05, days: 120, config: cfg });
    expect(d.action).toBe('derisk');
    expect(d.multiplier).toBe(0.5);
    expect(d.reviewRequired).toBe(true);
  });

  it('book absolute drawdown >= hardKillDD ⇒ HARD halt ×0 (catastrophe, unconditional)', () => {
    const d = decideBookGovernance({ bookSharpe30: 0.5, bookSharpe60: 0.5, bookDrawdown: 0.95, days: 120, config: cfg });
    expect(d.action).toBe('halt');
    expect(d.multiplier).toBe(0);
  });

  it('insufficient data (days < min) ⇒ trade ×1 (never act on a cold book)', () => {
    const d = decideBookGovernance({ bookSharpe30: null, bookSharpe60: null, bookDrawdown: 0.0, days: 5, config: cfg });
    expect(d.action).toBe('trade');
    expect(d.multiplier).toBe(1);
  });

  it('boundary: 60d Sharpe exactly -1.0 is NOT a breach (strict <)', () => {
    const d = decideBookGovernance({ bookSharpe30: 0.2, bookSharpe60: -1.0, bookDrawdown: 0.04, days: 120, config: cfg });
    expect(d.action).toBe('trade');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bot/book-governance.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bot/book-governance'`.

- [ ] **Step 3: Add the config block**

In `src/lib/bot/config.ts`, after `RETIREMENT_CONFIG`, add:

```typescript
/**
 * BOOK-LEVEL governance (the central "risk team" over the sleeves).
 * Thresholds copied verbatim from scripts/run-allocator.ts:statusOf so the
 * automatic governor matches the documented monitor:
 *   WATCH  = 30d annualised Sharpe < 0   → OBSERVE only (a flat stretch is normal)
 *   BREACH = 60d annualised Sharpe < -1  → auto de-risk ×0.5 + flag for human review
 *   book DD >= hardKillDD                 → HARD halt (catastrophe; reuses frozen DD bounds)
 * minDays/min30/min60 mirror rollingFromDaily's data gates (10/10/20).
 */
export interface BookGovernanceConfig {
  watchSharpe30: number;
  breachSharpe60: number;
  deriskMultiplier: number;
  minDays: number;
  min30: number;
  min60: number;
  /** Reused frozen DD inputs (same family as RETIREMENT_CONFIG). */
  sigmaAnnual: number;
  sharpe: number;
  horizonYears: number;
  bootstrapP5DD: number;
  /** A signal older than this (ms) is treated as STALE ⇒ fail-open. */
  signalMaxAgeMs: number;
}

export const BOOK_GOVERNANCE_CONFIG: BookGovernanceConfig = {
  watchSharpe30: 0,
  breachSharpe60: -1.0,
  deriskMultiplier: 0.5,
  minDays: 10,
  min30: 10,
  min60: 20,
  sigmaAnnual: RETIREMENT_CONFIG.sigmaAnnual,
  sharpe: RETIREMENT_CONFIG.sharpe,
  horizonYears: RETIREMENT_CONFIG.horizonYears,
  bootstrapP5DD: RETIREMENT_CONFIG.bootstrapP5DD,
  signalMaxAgeMs: 90 * 60 * 1000, // 90 min: the governor runs ≤ every 30 min
};
```

- [ ] **Step 4: Write the pure decision function**

Create `src/lib/bot/book-governance.ts`:

```typescript
/**
 * Book-level governance — the central "risk team" decision over the sleeves.
 * PURE + DI (no Date.now/fetch/DB in this function). A single sleeve's decay is
 * expected and absorbed by diversification (see plan research grounding); the
 * book is where edge-decay is judged. Catastrophe (book absolute drawdown) is
 * still an unconditional hard halt.
 */
import { expectedMaxDD, hardKillDD } from '@/lib/bot/retirement';
import type { BookGovernanceConfig } from '@/lib/bot/config';

export type BookHaltAction = 'trade' | 'derisk' | 'halt';

export interface BookGovernanceInputs {
  bookSharpe30: number | null;
  bookSharpe60: number | null;
  bookDrawdown: number;
  days: number;
  config: BookGovernanceConfig;
}

export interface BookGovernanceDecision {
  action: BookHaltAction;
  multiplier: number;
  reason: string;
  watch: boolean;
  reviewRequired: boolean;
}

export function decideBookGovernance(inputs: BookGovernanceInputs): BookGovernanceDecision {
  const { bookSharpe30, bookSharpe60, bookDrawdown, days, config } = inputs;
  const eMaxDD = expectedMaxDD({
    sigmaAnnual: config.sigmaAnnual,
    sharpe: config.sharpe,
    horizonYears: config.horizonYears,
  });
  const hkDD = hardKillDD({ eMaxDD, bootstrapP5DD: config.bootstrapP5DD });

  // 1. Catastrophe: book absolute drawdown — unconditional HARD halt.
  if (bookDrawdown >= hkDD) {
    return {
      action: 'halt',
      multiplier: 0,
      reason: `book hard drawdown: ${(bookDrawdown * 100).toFixed(1)}% >= hardKillDD ${(hkDD * 100).toFixed(1)}%`,
      watch: false,
      reviewRequired: true,
    };
  }

  // Cold book: never act.
  if (days < config.minDays) {
    return { action: 'trade', multiplier: 1, reason: `cold book (days=${days} < ${config.minDays})`, watch: false, reviewRequired: false };
  }

  // 2. BREACH (sustained 60d edge collapse) — auto de-risk + flag for review.
  if (bookSharpe60 !== null && bookSharpe60 < config.breachSharpe60) {
    return {
      action: 'derisk',
      multiplier: config.deriskMultiplier,
      reason: `book BREACH: 60d Sharpe ${bookSharpe60.toFixed(2)} < ${config.breachSharpe60} — de-risk + review before kill`,
      watch: false,
      reviewRequired: true,
    };
  }

  // 3. WATCH (30d soft) — OBSERVE only, a flat stretch is normal.
  const watch = bookSharpe30 !== null && bookSharpe30 < config.watchSharpe30;
  return {
    action: 'trade',
    multiplier: 1,
    reason: watch
      ? `book WATCH: 30d Sharpe ${bookSharpe30!.toFixed(2)} < ${config.watchSharpe30} — observe only (flat is normal)`
      : 'book all-clear',
    watch,
    reviewRequired: false,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/bot/book-governance.test.ts`
Expected: PASS (6/6).

- [ ] **Step 6: Lint + new-errors-only typecheck**

Run: `npx eslint src/lib/bot/book-governance.ts src/lib/bot/config.ts && pnpm typecheck 2>&1 | grep -E "book-governance|config.ts" | grep -v "$(git show origin/main:src/lib/bot/config.ts >/dev/null 2>&1; echo NOMATCH)"`
Expected: eslint clean; no NEW typecheck errors on the two files.

- [ ] **Step 7: Commit**

```bash
gmp "add pure book-governance decision + BOOK_GOVERNANCE_CONFIG (WATCH observe / BREACH de-risk / book-DD hard)" feat backend
```

---

## Task 2: Book live-returns aggregation (pure) + signal IO

**Files:**
- Modify: `src/lib/bot/book-governance.ts` (add `computeBookGovernanceState`, `writeBookGovernanceSignal`, `readBookGovernanceSignal`)
- Test: `tests/bot/book-governance.test.ts` (extend)

**Interfaces:**
- Produces:
  - `computeBookGovernanceState(sleeves: SleeveDaily[], weights, config, nowMs): BookGovernanceState` — pure: aligns per-sleeve daily-return maps on a union calendar (0 when flat), builds the weighted book daily series, returns `{ bookSharpe30, bookSharpe60, bookDrawdown, days }`.
  - `writeBookGovernanceSignal(dir: string, signal: BookGovernanceSignal): void`
  - `readBookGovernanceSignal(dir: string, nowMs: number, maxAgeMs: number): BookGovernanceDecision | null` — returns null on missing/stale/corrupt (fail-open).
- Consumes: `annSharpe`/`std` math — reimplement locally as small pure helpers (do NOT import from the `scripts/` allocator; keep `src/lib` free of `scripts/` deps).

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/bot/book-governance.test.ts
import { computeBookGovernanceState, writeBookGovernanceSignal, readBookGovernanceSignal } from '@/lib/bot/book-governance';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

describe('computeBookGovernanceState', () => {
  it('weighted book series ⇒ positive Sharpe when sleeves trend up', () => {
    const mk = (base: number) => Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`2025-01-${String(i + 1).padStart(2, '0')}`.slice(0, 10), base]),
    );
    // 40 days of small positive daily returns per sleeve
    const sleeves = [
      { name: 'crypto', byDay: mk(0.002) },
      { name: 'sessionBookRetail', byDay: mk(0.0015) },
      { name: 'f2f', byDay: mk(0.001) },
    ];
    const st = computeBookGovernanceState(sleeves, { crypto: 0.5, sessionBookRetail: 0.3, f2f: 0.2 }, 365);
    expect(st.days).toBe(40);
    expect(st.bookSharpe30).not.toBeNull();
    expect(st.bookSharpe60).toBeNull(); // < 20 of 60 — wait: 40 >= 20 so NOT null
    expect(st.bookDrawdown).toBeGreaterThanOrEqual(0);
  });
});

describe('readBookGovernanceSignal', () => {
  it('fresh signal round-trips; stale ⇒ null; missing ⇒ null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookgov-'));
    const now = 1_000_000_000_000;
    writeBookGovernanceSignal(dir, { action: 'derisk', multiplier: 0.5, reason: 'x', asOfMs: now, bookSharpe30: -0.2, bookSharpe60: -1.3, days: 100 });
    expect(readBookGovernanceSignal(dir, now + 60_000, 90 * 60 * 1000)?.multiplier).toBe(0.5);
    expect(readBookGovernanceSignal(dir, now + 2 * 60 * 60 * 1000, 90 * 60 * 1000)).toBeNull(); // stale
    expect(readBookGovernanceSignal(path.join(dir, 'nope'), now, 90 * 60 * 1000)).toBeNull(); // missing
  });
});
```

> NOTE for implementer: the inline comment in the `bookSharpe60` assertion above is a reminder — with 40 days you HAVE ≥20 obs, so `bookSharpe60` is non-null. Fix the assertion to `expect(st.bookSharpe60).not.toBeNull();` before running. (Caught in self-review; left as a teaching note.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/bot/book-governance.test.ts`
Expected: FAIL — `computeBookGovernanceState` / signal fns not exported.

- [ ] **Step 3: Implement aggregation + IO**

Append to `src/lib/bot/book-governance.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

export interface SleeveDaily { name: string; byDay: Record<string, number>; }
export interface BookGovernanceState {
  bookSharpe30: number | null;
  bookSharpe60: number | null;
  bookDrawdown: number;
  days: number;
}
export interface BookGovernanceSignal extends BookGovernanceState {
  action: BookHaltAction;
  multiplier: number;
  reason: string;
  asOfMs: number;
}

const SIGNAL_FILE = 'book-governance.json';

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function annSharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }

/** Pure: union-calendar align (0 when a sleeve is flat that day), weighted book series. */
export function computeBookGovernanceState(
  sleeves: SleeveDaily[],
  weights: Record<string, number>,
  trailing: number,
): BookGovernanceState {
  const allDates = new Set<string>();
  for (const s of sleeves) for (const d of Object.keys(s.byDay)) allDates.add(d);
  const dates = [...allDates].sort().slice(-trailing);
  const book = dates.map((d) =>
    sleeves.reduce((acc, s) => acc + (weights[s.name] ?? 0) * (s.byDay[d] ?? 0), 0),
  );
  const last30 = book.slice(-30);
  const last60 = book.slice(-60);
  // book drawdown from the cumulative-return peak
  let eq = 1, peak = 1, maxdd = 0;
  for (const r of book) { eq *= 1 + r; if (eq > peak) peak = eq; const dd = (peak - eq) / peak; if (dd > maxdd) maxdd = dd; }
  return {
    days: book.length,
    bookSharpe30: last30.length >= 10 ? annSharpe(last30) : null,
    bookSharpe60: last60.length >= 20 ? annSharpe(last60) : null,
    bookDrawdown: maxdd,
  };
}

export function writeBookGovernanceSignal(dir: string, signal: BookGovernanceSignal): void {
  fs.writeFileSync(path.join(dir, SIGNAL_FILE), JSON.stringify(signal, null, 2));
}

/** Fail-open: missing / stale / corrupt ⇒ null (local-only governance). */
export function readBookGovernanceSignal(
  dir: string,
  nowMs: number,
  maxAgeMs: number,
): BookGovernanceDecision | null {
  try {
    const raw = fs.readFileSync(path.join(dir, SIGNAL_FILE), 'utf-8');
    const s = JSON.parse(raw) as BookGovernanceSignal;
    if (typeof s.asOfMs !== 'number' || nowMs - s.asOfMs > maxAgeMs) return null;
    return { action: s.action, multiplier: s.multiplier, reason: s.reason, watch: false, reviewRequired: false };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Fix the teaching-note assertion, run tests**

Edit the test (`bookSharpe60` → `not.toBeNull()`), then:
Run: `npx vitest run tests/bot/book-governance.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/lib/bot/book-governance.ts
gmp "add book-returns aggregation + fail-open signal read/write to book-governance" feat backend
```

---

## Task 3: Governor writes the signal (wire into run-allocator.ts)

**Files:**
- Modify: `scripts/run-allocator.ts`

**Interfaces:**
- Consumes: `computeBookGovernanceState`, `decideBookGovernance`, `writeBookGovernanceSignal`, `BOOK_GOVERNANCE_CONFIG`; the allocator's existing per-sleeve `byDay` maps (built inside `liveSessionBook`/`liveF2F`; the crypto daily map is derived from `readLiveEquitySnapshots`).

- [ ] **Step 1: Read the current per-sleeve build** — confirm how each sleeve's `byDay` map is produced (`liveSessionBook`, `liveF2F`, and the crypto equity→daily-return derivation). The governor needs the SAME three `byDay` maps the monitor already builds. Refactor the three readers to also RETURN their `byDay` map (currently they only return the `SleeveLive` summary).

- [ ] **Step 2: Write the failing test (governor emits a file)**

```typescript
// tests/bot/book-governor-emit.test.ts
import { describe, it, expect } from 'vitest';
import { computeBookGovernanceState, decideBookGovernance, writeBookGovernanceSignal, readBookGovernanceSignal } from '@/lib/bot/book-governance';
import { BOOK_GOVERNANCE_CONFIG } from '@/lib/bot/config';
import * as os from 'os'; import * as fs from 'fs'; import * as path from 'path';

it('end-to-end: breaching sleeves ⇒ signal action=derisk on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-'));
  const now = 1_700_000_000_000;
  const losing = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`2025-03-${String((i % 28) + 1).padStart(2, '0')}`, -0.01]));
  const st = computeBookGovernanceState(
    [{ name: 'crypto', byDay: losing }, { name: 'sessionBookRetail', byDay: losing }, { name: 'f2f', byDay: losing }],
    { crypto: 0.5, sessionBookRetail: 0.3, f2f: 0.2 }, 365);
  const d = decideBookGovernance({ ...st, config: BOOK_GOVERNANCE_CONFIG });
  writeBookGovernanceSignal(dir, { ...st, action: d.action, multiplier: d.multiplier, reason: d.reason, asOfMs: now });
  const got = readBookGovernanceSignal(dir, now, BOOK_GOVERNANCE_CONFIG.signalMaxAgeMs);
  expect(['derisk', 'halt']).toContain(got?.action);
});
```

Run: `npx vitest run tests/bot/book-governor-emit.test.ts` → expect PASS once Task 1-2 land (this test only uses the pure API; it guards the integration contract). If it already passes, that's correct — it locks the contract the allocator will use.

- [ ] **Step 3: Wire into the allocator main()**

In `scripts/run-allocator.ts`, after the per-sleeve live monitor block, add (using the three `byDay` maps from Step 1):

```typescript
import { computeBookGovernanceState, decideBookGovernance, writeBookGovernanceSignal } from '../src/lib/bot/book-governance';
import { BOOK_GOVERNANCE_CONFIG } from '../src/lib/bot/config';
// ... after computing cryptoByDay / sessionByDay / f2fByDay:
const bookState = computeBookGovernanceState(
  [
    { name: 'crypto', byDay: cryptoByDay },
    { name: 'sessionBookRetail', byDay: sessionByDay },
    { name: 'f2f', byDay: f2fByDay },
  ],
  CLUSTER_WEIGHTS,
  365,
);
const bookDecision = decideBookGovernance({ ...bookState, config: BOOK_GOVERNANCE_CONFIG });
const nowMs = Number(process.env.GOV_NOW_MS) || ( /* injected for tests */ Date.now());
writeBookGovernanceSignal(path.resolve(__dirname, '..', 'data'), {
  ...bookState, action: bookDecision.action, multiplier: bookDecision.multiplier,
  reason: bookDecision.reason, asOfMs: nowMs,
});
console.log(`\nBOOK GOVERNANCE: ${bookDecision.action.toUpperCase()} ×${bookDecision.multiplier} — ${bookDecision.reason}`);
console.log(`  book: 30d Sharpe ${bookState.bookSharpe30 ?? '—'}, 60d Sharpe ${bookState.bookSharpe60 ?? '—'}, DD ${(bookState.bookDrawdown * 100).toFixed(1)}%, days ${bookState.days}`);
```

> `run-allocator.ts` is a top-level script (it may use `Date.now()` directly — that's allowed in scripts, only the `src/lib` logic files are clock-free). The `GOV_NOW_MS` override keeps it reproducible if scripted in a test harness.

- [ ] **Step 4: Manual run — emit a real signal**

Run: `npx tsx scripts/run-allocator.ts --capital 10000`
Expected: prints `BOOK GOVERNANCE: …` and writes `data/book-governance.json`. Verify:
`cat data/book-governance.json` shows `{ action, multiplier, bookSharpe30, bookSharpe60, bookDrawdown, days, asOfMs, reason }`.

- [ ] **Step 5: Commit**

```bash
gmp "allocator computes + writes the live book-governance signal each run" feat backend
```

---

## Task 4: Re-scope the per-sleeve sustained-DSR hard halt to soft de-risk

**Files:**
- Modify: `scripts/run-bot.ts` (the `evaluateRetirement` call, ~line 624-633)
- Test: `tests/bot/retirement-halt.test.ts` (add a case proving `dsrBreachK=0` ⇒ de-risk, not halt)

**Interfaces:**
- Consumes: existing `evaluateRetirementHalt`, `RETIREMENT_CONFIG`.

- [ ] **Step 1: Write the failing test**

```typescript
// add to tests/bot/retirement-halt.test.ts
import { evaluateRetirementHalt } from '@/lib/bot/retirement';
import { RETIREMENT_CONFIG } from '@/lib/bot/config';

it('with dsrBreachK=0 a sustained sub-floor DSR DE-RISKS (not hard halt)', () => {
  const base = {
    nowMs: 0, drawdown: 0.02, deflatedSharpe: 0.1, snapshotCount: 80,
    regimeCause: false, charterBreachConsecutive: 0, dsrBreachConsecutive: 99,
  };
  const halted = evaluateRetirementHalt({ ...base, config: { ...RETIREMENT_CONFIG, dsrBreachK: 3 } });
  expect(halted.decision.action).toBe('halt'); // current sleeve behaviour

  const rescoped = evaluateRetirementHalt({ ...base, config: { ...RETIREMENT_CONFIG, dsrBreachK: 0 } });
  expect(rescoped.decision.action).toBe('derisk'); // new behaviour: soft, not hard
  expect(rescoped.decision.multiplier).toBe(0.5);
});
```

- [ ] **Step 2: Run to verify it fails** — actually this test should PASS immediately (it only exercises existing pure logic with two configs). Run it to CONFIRM the `dsrBreachK=0` path already yields `derisk` in `retirement.ts`.

Run: `npx vitest run tests/bot/retirement-halt.test.ts -t "dsrBreachK=0"`
Expected: PASS — this validates the mechanism Task 6 will use.

- [ ] **Step 3: (No production change in this task)** — this task only *proves* the re-scoping mechanism. The actual config override is applied at the call site in Task 6 (so other RETIREMENT_CONFIG consumers, if any, are unaffected). Add a one-line comment above `RETIREMENT_CONFIG.dsrBreachK` in `config.ts`:

```typescript
  // dsrBreachK 3 → per-sleeve sustained-DSR HARD halt. As of book-governance
  // (2026-06-24) run-bot.ts overrides this to 0 at the call site: edge-decay is
  // judged at the BOOK level; the sleeve keeps only its absolute-DD hard stop.
  dsrBreachK: 3,
```

- [ ] **Step 4: Commit**

```bash
gmp "prove + document dsrBreachK=0 re-scopes sustained-DSR to soft de-risk" test backend
```

---

## Task 5: Crypto bot consumes the book signal

**Files:**
- Modify: `scripts/run-bot.ts` — `evaluateRetirement` (combine the book signal) + constructor (store `dataDir`).

**Interfaces:**
- Consumes: `readBookGovernanceSignal`, `BOOK_GOVERNANCE_CONFIG`; existing `setKillFlag`, `this.retirementMultiplier`, `this.alerts`.

- [ ] **Step 1: Write the failing test** — extract the multiplier-combination into a pure helper so it is testable without the live tick.

```typescript
// tests/bot/book-signal-apply.test.ts
import { describe, it, expect } from 'vitest';
import { combineGovernance } from '@/lib/bot/book-governance';

describe('combineGovernance — local sleeve × book signal (most conservative wins)', () => {
  it('book null (fail-open) ⇒ local decision unchanged', () => {
    expect(combineGovernance({ localMultiplier: 1, localHalt: false }, null)).toEqual({ multiplier: 1, halt: false, source: 'local' });
  });
  it('book derisk ×0.5 with local full ⇒ ×0.5', () => {
    expect(combineGovernance({ localMultiplier: 1, localHalt: false }, { action: 'derisk', multiplier: 0.5, reason: 'b', watch: false, reviewRequired: true }))
      .toEqual({ multiplier: 0.5, halt: false, source: 'book' });
  });
  it('book halt ⇒ halt regardless of local', () => {
    expect(combineGovernance({ localMultiplier: 1, localHalt: false }, { action: 'halt', multiplier: 0, reason: 'b', watch: false, reviewRequired: true }).halt).toBe(true);
  });
  it('local halt wins even if book says trade', () => {
    expect(combineGovernance({ localMultiplier: 0, localHalt: true }, { action: 'trade', multiplier: 1, reason: 'b', watch: false, reviewRequired: false }).halt).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/bot/book-signal-apply.test.ts`
Expected: FAIL — `combineGovernance` not exported.

- [ ] **Step 3: Implement `combineGovernance` (pure)**

Append to `src/lib/bot/book-governance.ts`:

```typescript
export interface LocalGovernance { localMultiplier: number; localHalt: boolean; }
export interface CombinedGovernance { multiplier: number; halt: boolean; source: 'local' | 'book'; }

/** Most-conservative-wins: book signal can only TIGHTEN, never loosen, the local decision. */
export function combineGovernance(local: LocalGovernance, book: BookGovernanceDecision | null): CombinedGovernance {
  if (local.localHalt) return { multiplier: 0, halt: true, source: 'local' };
  if (book === null) return { multiplier: local.localMultiplier, halt: false, source: 'local' };
  if (book.action === 'halt') return { multiplier: 0, halt: true, source: 'book' };
  const m = Math.min(local.localMultiplier, book.multiplier);
  return { multiplier: m, halt: false, source: m < local.localMultiplier ? 'book' : 'local' };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/bot/book-signal-apply.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Wire into `run-bot.ts:evaluateRetirement`** — apply the `dsrBreachK:0` override and fold in the book signal. Replace the body around lines 624-685 so that: (a) the local decision uses `config: { ...RETIREMENT_CONFIG, dsrBreachK: 0 }`; (b) the book signal is read; (c) `combineGovernance` decides; (d) a book HARD action latches `setKillFlag(db, { source: 'book-governance', … })`; a local absolute-DD HARD still latches `source: 'retirement'`. Concretely:

```typescript
// inside evaluateRetirement(), after computing `result` with the dsrBreachK:0 override:
const localHalt = result.decision.action === 'halt';
const book = readBookGovernanceSignal(this.dataDir, nowMs, BOOK_GOVERNANCE_CONFIG.signalMaxAgeMs);
const combined = combineGovernance(
  { localMultiplier: result.decision.multiplier, localHalt },
  book,
);

if (combined.halt) {
  const source = combined.source === 'book' ? 'book-governance' : 'retirement';
  const cause = combined.source === 'book' ? (book?.reason ?? 'book hard halt') : result.decision.cause;
  setKillFlag(db, { halted: true, source, reason: cause, nowMs });
  this.retirementMultiplier = 0;
  // ... existing dedupe alert + decision_log, with `source`/`cause` ...
  return;
}
this.retirementAlerted = false;
this.retirementMultiplier = combined.multiplier; // 1, 0.5 from either layer
```

Set `this.dataDir = path.resolve(__dirname, '..', 'data')` in the constructor (or reuse the existing data-dir constant if one exists — grep `data/ict-trading.db` resolution in run-bot.ts and reuse that base).

- [ ] **Step 6: Targeted verification (no live trades needed)**

Run: `npx vitest run tests/bot/book-signal-apply.test.ts tests/bot/retirement-halt.test.ts`
Expected: PASS. Then new-errors-only typecheck on `scripts/run-bot.ts` + `npx eslint scripts/run-bot.ts src/lib/bot/book-governance.ts`.

- [ ] **Step 7: Commit**

```bash
gmp "crypto bot governs via book signal (combine + fail-open); sleeve DSR now soft de-risk" feat backend
```

---

## Task 6: PM2 governor app + operator runbook + clear the stale latch

**Files:**
- Modify: `ecosystem.config.cjs` (add `book-governor`)
- Modify: `RUNNING.md`

**Interfaces:** none (ops).

- [ ] **Step 1: Add the governor PM2 app**

In `ecosystem.config.cjs`, add an app that runs the allocator on a cadence (the allocator now emits the signal). Use a short shell loop or a cron-style wrapper; mirror the existing `orderflow-collector` block:

```javascript
{
  name: 'book-governor',
  script: './node_modules/.bin/tsx',
  args: 'scripts/run-governor-loop.ts',   // thin loop: every 15 min → run-allocator signal write
  cwd: __dirname,
  exec_mode: 'fork', interpreter: 'none', autorestart: true, watch: false,
  max_memory_restart: '256M', restart_delay: 30000, max_restarts: 1000, min_uptime: '30s',
  env: { NODE_ENV: 'production' },
  error_file: 'logs/book-governor-error.log', out_file: 'logs/book-governor-out.log', merge_logs: true,
},
```

Create `scripts/run-governor-loop.ts` — a 15-line loop that calls the allocator's signal-writing path every 15 minutes (extract the governor block from Task 3 into an exported `emitBookGovernanceSignal()` the loop imports, so the logic is shared, not duplicated).

- [ ] **Step 2: Document in RUNNING.md** — add a "Book governance" section: what the signal means (`trade`/`derisk`/`halt`), that it's fail-open (a dead governor never freezes the book), the 90-min staleness window, and how to inspect: `cat data/book-governance.json`.

- [ ] **Step 3: One-time operator action — clear the stale per-sleeve latch**

Document (and have the operator run): the crypto bot is currently latched `source:'retirement'` from the OLD per-sleeve sustained-DSR halt. After deploying book governance, clear it so crypto resumes under the book's authority:

```bash
# inspect first
sqlite3 data/ict-trading.db "SELECT * FROM bot_kill_switch;"
# clear ONLY if the latch source is the old per-sleeve retirement halt and the book is not itself breaching
sqlite3 data/ict-trading.db "UPDATE bot_kill_switch SET halted=0, source='', reason='cleared: migrated to book governance 2026-06-24' WHERE id=1;"
```

> SAFETY: do this only after `data/book-governance.json` exists and shows `action` ∈ {trade, derisk} (i.e. the book is NOT itself breaching). If the book is breaching, leave crypto halted — the book governor agrees with the stop.

- [ ] **Step 4: Start the governor + verify the loop**

Run: `pm2 start ecosystem.config.cjs --only book-governor && pm2 save && sleep 2 && cat data/book-governance.json`
Expected: a fresh signal with `asOfMs` within the last couple minutes.

- [ ] **Step 5: Commit**

```bash
gmp "add book-governor PM2 app + runbook + stale-latch migration step" feat backend
```

---

## Self-Review

**1. Spec coverage**
- "Re-scope per-sleeve sustained-DSR hard halt → soft" → Task 4 (proof) + Task 5 (call-site override). ✓
- "Book-level governor computes live book Sharpe/DD + decides" → Tasks 1-2. ✓
- "Signal file (fail-open)" → Task 2 (read/write) + Task 3 (emit). ✓
- "Sleeve bots apply it" → Task 5 (crypto). ⚠️ GAP: gold (`run-gold-bot.ts`) and session (`run-metals-bot.ts`) are NOT wired in this plan. **Decision:** crypto is the sleeve that mis-fired and the highest-weight one; gold already has its own `GOLD_MAX_DRAWDOWN` peak-DD halt and session has none. Wiring the other two to read the same signal is a mechanical follow-up (same `readBookGovernanceSignal` + `combineGovernance` pattern). Logged as out-of-scope here; add as a Phase-2 plan if desired. This plan delivers working software (book governs crypto) on its own.
- "Keep local catastrophe stop" → unchanged absolute-DD leg in `retirement.ts`. ✓
- "Operator migration of the stale latch" → Task 6 Step 3. ✓

**2. Placeholder scan** — no TBD/TODO-as-implementation. The one `// teaching note` in Task 2 is intentional and the step instructs fixing it before running. Every code step shows complete code.

**3. Type consistency** — `BookGovernanceDecision` shape (`action`/`multiplier`/`reason`/`watch`/`reviewRequired`) is identical across `decideBookGovernance` (Task 1), `readBookGovernanceSignal` (Task 2), and `combineGovernance` (Task 5). `BookGovernanceSignal extends BookGovernanceState` so the emit path (Task 3) and read path (Task 2) agree on `asOfMs`/`bookSharpe30`/`bookSharpe60`/`days`. `CLUSTER_WEIGHTS` keys (`crypto`/`sessionBookRetail`/`f2f`) match `computeBookGovernanceState` weight lookups.

**Risks to watch during execution**
- Confirm `RETIREMENT_CONFIG.dsrBreachK` has no consumer other than `run-bot.ts` before relying on the call-site override (grep `dsrBreachK`); if shared, the override approach (Task 5) already isolates the change — do NOT mutate the exported constant.
- `run-allocator.ts` lives in `scripts/` and may use `Date.now()`; that's fine (only `src/lib` logic files are clock-free). Keep all pure logic in `src/lib/bot/book-governance.ts`.
- The crypto sleeve's own equity→daily-return derivation for `cryptoByDay` must use the same `bot_equity_snapshots` source the monitor uses (per-UTC-day returns), so the book series is consistent with the documented monitor.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-24-book-level-halt-governance.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with checkpoints for review.

**Which approach?**
