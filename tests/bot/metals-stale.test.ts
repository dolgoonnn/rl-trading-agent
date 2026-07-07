import { describe, it, expect } from 'vitest';
import { isStrandedHold, staleCapHoursFor } from '../../src/lib/bot/metals-stale';

const H = 3_600_000;

describe('staleCapHoursFor — per-leg max sane hold (above the longest legit hold)', () => {
  it('overnight caps well above its ~9h design hold', () => {
    expect(staleCapHoursFor('overnight')).toBeGreaterThan(9);
    expect(staleCapHoursFor('overnight')).toBeLessThanOrEqual(48);
  });
  it('weekend caps above a 3-day-weekend hold (~85h)', () => {
    expect(staleCapHoursFor('weekend')).toBeGreaterThanOrEqual(96);
  });
  it('intraday legs cap low', () => {
    expect(staleCapHoursFor('fix-short')).toBeLessThanOrEqual(24);
    expect(staleCapHoursFor('agfix-short')).toBeLessThanOrEqual(24);
  });
});

describe('isStrandedHold — only fires for holds beyond the leg cap', () => {
  it('a normal ~9h overnight hold is NOT stranded', () => {
    expect(isStrandedHold('overnight', 9 * H)).toBe(false);
  });
  it('a 12-day overnight hold IS stranded (the downtime case)', () => {
    expect(isStrandedHold('overnight', 288 * H)).toBe(true);
  });
  it('a normal ~60h weekend hold is NOT stranded', () => {
    expect(isStrandedHold('weekend', 60 * H)).toBe(false);
  });
  it('a 9-day weekend hold IS stranded', () => {
    expect(isStrandedHold('weekend', 216 * H)).toBe(true);
  });
  it('a normal ~17h us500-overnight hold is NOT stranded', () => {
    expect(isStrandedHold('us500-overnight', 17 * H)).toBe(false);
  });
  it('boundary: exactly at the cap is NOT stranded (strictly greater)', () => {
    expect(isStrandedHold('overnight', staleCapHoursFor('overnight') * H)).toBe(false);
  });
  it('an unknown leg falls back to the conservative default cap', () => {
    // Should not throw and should treat a 10-day hold as stranded.
    expect(isStrandedHold('mystery-leg', 240 * H)).toBe(true);
  });
});
