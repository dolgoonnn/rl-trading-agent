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
