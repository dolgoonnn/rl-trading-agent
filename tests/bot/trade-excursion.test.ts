/**
 * How much HEAT a trade took, and how much of its best move it kept.
 *
 * The deployed legs place no stop, so "R-multiple" is undefined for them — R is
 * measured in stop-distances and there is no stop. That is a real design choice,
 * but it was being used as cover for having no risk instrumentation at all: the
 * book could not answer "how far underwater did that +0.09% winner go?" for any
 * trade, on any sleeve.
 *
 * MAE (worst adverse excursion) and MFE (best favourable excursion) are the
 * stopless analogue of risk/reward, and they are computable from the bars the
 * chart already fetches — so they work retroactively on every trade ever booked,
 * with no change to a live bot.
 */
import { describe, it, expect } from 'vitest';
import { computeExcursion } from '../../src/lib/bot/trade-analytics';

const bar = (t: number, l: number, h: number) => ({ timestamp: t, open: l, high: h, low: l, close: h });

describe('computeExcursion', () => {
  // Long from 100: dips to 97, runs to 110, closes 102.
  const longBars = [bar(10, 99, 101), bar(20, 97, 100), bar(30, 100, 110), bar(40, 101, 103)];

  it('measures heat and best move for a long', () => {
    const e = computeExcursion(longBars, 'long', 100, 102, 10, 40);
    expect(e).not.toBeNull();
    expect(e!.maePct).toBeCloseTo(-0.03, 4); // 97 -> -3%
    expect(e!.mfePct).toBeCloseTo(0.10, 4);  // 110 -> +10%
    expect(e!.capturedPct).toBeCloseTo(0.2, 2); // kept 2% of the 10% available
  });

  it('measures heat and best move for a short', () => {
    // Short from 100: price rises to 110 (heat), falls to 97 (favourable), closes 98.
    const e = computeExcursion(longBars, 'short', 100, 98, 10, 40);
    expect(e!.maePct).toBeCloseTo(-0.10, 4);
    expect(e!.mfePct).toBeCloseTo(0.03, 4);
    expect(e!.capturedPct).toBeCloseTo(0.667, 2);
  });

  it('only looks inside the holding window', () => {
    // A 130 spike AFTER the exit must not count as a missed opportunity.
    const withAfter = [...longBars, bar(50, 120, 130)];
    expect(computeExcursion(withAfter, 'long', 100, 102, 10, 40)!.mfePct).toBeCloseTo(0.10, 4);
  });

  it('reports no capture ratio when the trade never went favourable', () => {
    const losers = [bar(10, 95, 99), bar(20, 90, 96)];
    const e = computeExcursion(losers, 'long', 100, 96, 10, 20);
    expect(e!.maePct).toBeCloseTo(-0.10, 4);
    expect(e!.mfePct).toBe(0);
    // Dividing by a zero best-move would be Infinity — must be null, not a number.
    expect(e!.capturedPct).toBeNull();
  });

  it('returns null when there are no bars in the window or no entry price', () => {
    expect(computeExcursion([], 'long', 100, 102, 10, 40)).toBeNull();
    expect(computeExcursion(longBars, 'long', null, 102, 10, 40)).toBeNull();
    expect(computeExcursion(longBars, 'long', 100, 102, 900, 999)).toBeNull();
  });
});
