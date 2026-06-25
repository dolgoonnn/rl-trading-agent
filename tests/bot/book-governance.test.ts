import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  decideBookGovernance,
  BOOK_GOVERNANCE_CONFIG,
  computeBookGovernanceState,
  writeBookGovernanceSignal,
  readBookGovernanceSignal,
} from '@/lib/bot/book-governance';

const cfg = BOOK_GOVERNANCE_CONFIG;

describe('decideBookGovernance', () => {
  it('all-clear ⇒ trade ×1', () => {
    const d = decideBookGovernance({ bookSharpe30: 2.1, bookSharpe60: 2.0, bookDrawdown: 0.02, days: 120, config: cfg });
    expect(d.action).toBe('trade');
    expect(d.multiplier).toBe(1);
    expect(d.watch).toBe(false);
    expect(d.reviewRequired).toBe(false);
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

  // Task-2 adjustment (a): cold book with catastrophic drawdown — hard-halt precedes cold-book guard
  it('cold book with catastrophic drawdown ⇒ HARD halt (hard-halt unconditional, precedes cold-book guard)', () => {
    const d = decideBookGovernance({ bookSharpe30: null, bookSharpe60: null, bookDrawdown: 0.95, days: 5, config: cfg });
    expect(d.action).toBe('halt');
  });
});

describe('computeBookGovernanceState', () => {
  // 40 valid ISO dates starting 2025-01-01 (crosses into February)
  const dates40 = Array.from({ length: 40 }, (_, i) =>
    new Date(2025, 0, 1 + i).toISOString().slice(0, 10),
  );

  it('weighted book series ⇒ positive Sharpe when sleeves trend up', () => {
    // Upward-trending returns: base + i*0.00005 → mean > 0, std > 0
    const mkTrend = (base: number) =>
      Object.fromEntries(dates40.map((d, i) => [d, base + i * 0.00005]));

    const sleeves = [
      { name: 'crypto', byDay: mkTrend(0.002) },
      { name: 'sessionBookRetail', byDay: mkTrend(0.0015) },
      { name: 'f2f', byDay: mkTrend(0.001) },
    ];
    const st = computeBookGovernanceState(
      sleeves,
      { crypto: 0.5, sessionBookRetail: 0.3, f2f: 0.2 },
      365,
    );
    expect(st.days).toBe(40);
    expect(st.bookSharpe30).toBeGreaterThan(0);
    // 40 days >= min60 gate of 20 obs
    expect(st.bookSharpe60).toBeGreaterThan(0);
    expect(st.bookDrawdown).toBeGreaterThanOrEqual(0);
  });

  it('constant-return series ⇒ bookSharpe30 === 0 (Fix 1: zero-std fp-noise guard)', () => {
    // All returns identical → std ≈ 8.8e-19 (IEEE-754 fp noise), must clamp to 0
    const mkFlat = (val: number) => Object.fromEntries(dates40.map((d) => [d, val]));

    const sleeves = [
      { name: 'crypto', byDay: mkFlat(0.002) },
      { name: 'sessionBookRetail', byDay: mkFlat(0.0015) },
      { name: 'f2f', byDay: mkFlat(0.001) },
    ];
    const st = computeBookGovernanceState(
      sleeves,
      { crypto: 0.5, sessionBookRetail: 0.3, f2f: 0.2 },
      365,
    );
    expect(st.bookSharpe30).toBe(0);
    expect(st.bookSharpe60).toBe(0);
  });
});

describe('readBookGovernanceSignal', () => {
  it('fresh signal round-trips; stale ⇒ null; missing ⇒ null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookgov-'));
    const now = 1_000_000_000_000;
    writeBookGovernanceSignal(dir, { action: 'derisk', multiplier: 0.5, reason: 'x', asOfMs: now, bookSharpe30: -0.2, bookSharpe60: -1.3, bookDrawdown: 0.05, days: 100 });
    expect(readBookGovernanceSignal(dir, now + 60_000, 90 * 60 * 1000)?.multiplier).toBe(0.5);
    expect(readBookGovernanceSignal(dir, now + 2 * 60 * 60 * 1000, 90 * 60 * 1000)).toBeNull(); // stale
    expect(readBookGovernanceSignal(path.join(dir, 'nope'), now, 90 * 60 * 1000)).toBeNull(); // missing
  });
});
