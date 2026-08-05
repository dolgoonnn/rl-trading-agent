/**
 * A disaster brake on the stopless session legs.
 *
 * The legs exit on a clock and place no stop, which is CORRECT for ordinary
 * stop distances — simulated over 1,662 nights of gold/silver minute bars, a
 * 0.25% stop cuts gold's total from +39.1% to +13.3%, fires on 49% of nights,
 * and 56% of the time the trade would have finished better than the stop price.
 * A tight stop here converts noise into realised loss (Kaminski & Lo 2014).
 *
 * What the clock does NOT bound is the tail: the worst untouched night was
 * -6.57% on gold and -11.65% on silver. A stop wide enough to be untouched in
 * normal noise (fires on 0.4% of nights at 3%) caps that tail while leaving the
 * edge alone. That is what this is — a catastrophe brake, not a trading stop.
 */
import { describe, it, expect } from 'vitest';
import { CATASTROPHE_STOP_PCT, catastropheStopPrice, catastropheStopHit } from '../../scripts/run-metals-bot';

describe('catastrophe stop', () => {
  it('sits far outside normal nightly noise', () => {
    // Median nightly heat measured live is ~0.30%; the brake must not be near it.
    expect(CATASTROPHE_STOP_PCT).toBeGreaterThanOrEqual(0.02);
  });

  it('prices below entry for a long and above for a short', () => {
    expect(catastropheStopPrice('long', 4000)).toBeCloseTo(4000 * (1 - CATASTROPHE_STOP_PCT), 6);
    expect(catastropheStopPrice('short', 4000)).toBeCloseTo(4000 * (1 + CATASTROPHE_STOP_PCT), 6);
  });

  it('fires only when price breaches the brake', () => {
    const entry = 4000;
    const s = CATASTROPHE_STOP_PCT;
    expect(catastropheStopHit('long', entry, entry * (1 - s) - 0.01)).toBe(true);
    expect(catastropheStopHit('long', entry, entry * (1 - s) + 0.01)).toBe(false);
    expect(catastropheStopHit('short', entry, entry * (1 + s) + 0.01)).toBe(true);
    expect(catastropheStopHit('short', entry, entry * (1 + s) - 0.01)).toBe(false);
  });

  it('does not fire on a routine adverse night', () => {
    // The worst single live trade took -3.20% of heat on silver; a -1% night is
    // ordinary and must be left completely alone.
    expect(catastropheStopHit('long', 58.5, 58.5 * 0.99)).toBe(false);
    expect(catastropheStopHit('long', 4000, 4000 * 0.985)).toBe(false);
  });

  it('fires on the kind of night it exists for', () => {
    // Gold's worst untouched night in 1,662 was -6.57%.
    expect(catastropheStopHit('long', 4000, 4000 * (1 - 0.0657))).toBe(true);
    // Silver's was -11.65%.
    expect(catastropheStopHit('long', 58.5, 58.5 * (1 - 0.1165))).toBe(true);
  });
});
