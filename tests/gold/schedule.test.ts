import { describe, it, expect } from 'vitest';
import { nextGoldPollDelayMs, GOLD_MAX_POLL_MS } from '../../src/lib/gold/schedule';

const MIN = 60_000;
const POST = 5 * MIN;

describe('nextGoldPollDelayMs — sleep-robust daily scheduling', () => {
  it('caps a far-from-close wait at the poll interval (was ~20h single setTimeout)', () => {
    expect(nextGoldPollDelayMs(20 * 60 * MIN, POST)).toBe(GOLD_MAX_POLL_MS);
  });

  it('waits the true (short) time when the close is near', () => {
    expect(nextGoldPollDelayMs(10 * MIN, POST)).toBe(10 * MIN + POST);
  });

  it('never returns a wait longer than the cap', () => {
    for (const h of [0.6, 2, 6, 12, 23]) {
      expect(nextGoldPollDelayMs(h * 60 * MIN, POST)).toBeLessThanOrEqual(GOLD_MAX_POLL_MS);
    }
  });

  it('a non-positive time-until-close (just passed) returns a short poll, never wedges', () => {
    expect(nextGoldPollDelayMs(-1000, POST)).toBeGreaterThan(0);
    expect(nextGoldPollDelayMs(0, POST)).toBeGreaterThan(0);
  });

  it('NaN/Infinity clock read cannot produce an infinite/NaN wait', () => {
    expect(Number.isFinite(nextGoldPollDelayMs(NaN, POST))).toBe(true);
    expect(Number.isFinite(nextGoldPollDelayMs(Infinity, POST))).toBe(true);
  });
});
