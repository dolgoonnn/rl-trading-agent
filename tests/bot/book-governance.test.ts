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
