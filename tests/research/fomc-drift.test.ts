/**
 * TDD for the non-trivial logic in the pre-FOMC drift re-validation
 * (scripts/research-fomc-revalidation.ts via scripts/lib/fomc-drift-core.ts):
 *
 *   1. windowReturn: a backward-looking, friction-netted, no-look-ahead
 *      event-window log return. markAt must NEVER read a price from after the
 *      requested instant (that would be a look-ahead bug worth basis points).
 *
 *   2. volGateAbove: the "trade only when uncertain" gate must decide using only
 *      PRIOR observations for its threshold and must refuse (return null) when
 *      history is too short — a null is "skip", never "trade".
 */
import { describe, it, expect } from 'vitest';
import {
  type DayMinuteMarks,
  markAt,
  windowReturn,
  volGateAbove,
  mean,
  tstat,
} from '../../scripts/lib/fomc-drift-core';

function marks(entries: Array<[string, number, number]>): DayMinuteMarks {
  const m: DayMinuteMarks = new Map();
  for (const [day, minute, price] of entries) {
    let d = m.get(day);
    if (!d) { d = new Map(); m.set(day, d); }
    d.set(minute, price);
  }
  return m;
}

describe('markAt — backward-only, stale-tolerant price lookup', () => {
  it('returns the exact print when present at the minute', () => {
    const m = marks([['2024-01-30', 840, 100]]); // 14:00 ET = minute 840
    expect(markAt(m, '2024-01-30', 840)).toBe(100);
  });

  it('walks BACKWARD up to staleMin when the exact minute is missing', () => {
    const m = marks([['2024-01-30', 835, 99]]); // print 5 min earlier
    expect(markAt(m, '2024-01-30', 840, 10)).toBe(99); // tolerated
    expect(markAt(m, '2024-01-30', 840, 3)).toBeNull(); // outside stale window
  });

  it('NEVER reads a FUTURE print (no look-ahead)', () => {
    // Only a later print exists; a look-ahead bug would return it.
    const m = marks([['2024-01-30', 845, 101]]);
    expect(markAt(m, '2024-01-30', 840, 10)).toBeNull();
  });
});

describe('windowReturn — friction-netted long event-window return', () => {
  it('is the log price ratio minus round-trip friction', () => {
    const m = marks([
      ['2024-01-29', 840, 100], // T-1 14:00 ET entry
      ['2024-01-30', 835, 101], // T 13:55 ET exit
    ]);
    const gross = Math.log(101 / 100);
    expect(windowReturn(m, '2024-01-29', 840, '2024-01-30', 835, 0)).toBeCloseTo(gross, 12);
    // 0.5bp/side => subtract 1bp round trip.
    expect(windowReturn(m, '2024-01-29', 840, '2024-01-30', 835, 0.00005)).toBeCloseTo(
      gross - 0.0001,
      12,
    );
  });

  it('returns null when a leg is missing (no fabricated fill)', () => {
    const m = marks([['2024-01-29', 840, 100]]); // exit leg absent
    expect(windowReturn(m, '2024-01-29', 840, '2024-01-30', 835, 0)).toBeNull();
  });
});

describe('volGateAbove — no-look-ahead uncertainty gate', () => {
  it('compares vol[i] to the median of the PRIOR lookback only', () => {
    // 10 lows then a spike; with lookback 5, minHistory 5, index at the spike
    // must be ABOVE the prior-window median.
    const vols = [1, 1, 1, 1, 1, 5];
    expect(volGateAbove(vols, 5, 5, 5)).toBe(true);
    // A low value after highs is BELOW the prior median => gate closed.
    const vols2 = [9, 9, 9, 9, 9, 1];
    expect(volGateAbove(vols2, 5, 5, 5)).toBe(false);
  });

  it('refuses (null) when there is insufficient history — null means SKIP', () => {
    const vols = [1, 2, 3];
    expect(volGateAbove(vols, 2, 252, 100)).toBeNull(); // i < lookback
    expect(volGateAbove(vols, 2, 2, 100)).toBeNull(); // history < minHistory
  });

  it('the threshold never peeks at vol[i] or later (look-ahead guard)', () => {
    // Make vol[i] huge and everything after it huge too; the decision must hinge
    // only on the prior window, which here is all 1s => median 1 => i is above.
    const vols = [1, 1, 1, 1, 1, 100, 100, 100];
    expect(volGateAbove(vols, 5, 5, 5)).toBe(true);
    // Symmetric: prior window all 100s => i (=1) below => false, ignoring the
    // later small values entirely.
    const vols2 = [100, 100, 100, 100, 100, 1, 1, 1];
    expect(volGateAbove(vols2, 5, 5, 5)).toBe(false);
  });
});

describe('stats helpers', () => {
  it('mean and tstat behave', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(tstat([0, 0, 0])).toBe(0); // zero variance => 0, not NaN
    expect(tstat([1, 1, 1, 1])).toBe(0); // zero variance
    expect(tstat([1, -1, 1, -1])).toBeCloseTo(0, 12); // zero mean
  });
});
