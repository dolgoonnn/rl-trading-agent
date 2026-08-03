/**
 * The gold bot's frozen training stats must actually reach the signal path.
 *
 * BUG THIS FIXES (my own, from 2026-07-28): `run-gold-bot.ts` set
 * `opts.trainStats = FROZEN_TRAIN_STATS` and printed "Train stats: frozen (...)"
 * at startup, but `generateSignals` computes the stats INTERNALLY from
 * trainStart/trainEnd and had no parameter to receive them. So the constant was
 * assigned, logged, and never used — the startup line asserted a calibration the
 * strategy was not using.
 *
 * WHY IT MATTERS: the stats standardise the signal as (delta - mu)/sigma, and that
 * z drives `pBull >= activationThreshold`. Measured on live XAUT (480 bars), the
 * self-estimated sigma is 1.939e-3 against the frozen 1.463e-3 — 32.5% higher,
 * compressing every z-score by ~25% and making activation materially harder.
 */
import { describe, it, expect } from 'vitest';
import type { Candle } from '../../src/types/candle';
import { generateSignals } from '../../src/lib/gold/signals';
import { computeSmoothedLogPrices, computeDeltaSmoothed, computeTrainStats } from '../../src/lib/gold/indicators';

/** Deterministic synthetic series with a mild uptrend plus wiggle. */
function series(n: number): Candle[] {
  const out: Candle[] = [];
  let px = 2000;
  for (let i = 0; i < n; i++) {
    px *= 1 + 0.0004 + 0.004 * Math.sin(i / 3.1) + 0.002 * Math.sin(i / 11.7);
    out.push({ timestamp: Date.UTC(2024, 0, 1) + i * 86_400_000, open: px, high: px * 1.004, low: px * 0.996, close: px, volume: 1 });
  }
  return out;
}

const PARAMS = { lambda: 0.95, theta: 0.91 };

describe('gold frozen train stats reach the signal path', () => {
  it('accepts an override and uses it instead of self-estimating', () => {
    const candles = series(300);
    const last = candles.length - 1;

    const selfEstimated = generateSignals(candles, PARAMS, 0, last, last, candles.length, 'none');
    // A deliberately different sigma must move the standardised signal.
    const override = { mu: 0.0005462, sigma: 0.001463 };
    const withFrozen = generateSignals(candles, PARAMS, 0, last, last, candles.length, 'none', override);

    expect(selfEstimated).toHaveLength(1);
    expect(withFrozen).toHaveLength(1);
    expect(withFrozen[0]?.zScore).not.toBeCloseTo(selfEstimated[0]?.zScore ?? 0, 6);
  });

  it('reproduces the self-estimated result when handed the same stats', () => {
    const candles = series(300);
    const last = candles.length - 1;
    const delta = computeDeltaSmoothed(computeSmoothedLogPrices(candles, PARAMS.lambda));
    const same = computeTrainStats(delta, 0, last);

    const a = generateSignals(candles, PARAMS, 0, last, last, candles.length, 'none');
    const b = generateSignals(candles, PARAMS, 0, last, last, candles.length, 'none', same);
    expect(b[0]?.zScore).toBeCloseTo(a[0]?.zScore ?? 0, 10);
  });

  it('a larger sigma compresses the z-score, making activation harder', () => {
    const candles = series(300);
    const last = candles.length - 1;
    const tight = generateSignals(candles, PARAMS, 0, last, last, candles.length, 'none', { mu: 0.0005, sigma: 0.001 });
    const wide = generateSignals(candles, PARAMS, 0, last, last, candles.length, 'none', { mu: 0.0005, sigma: 0.002 });
    expect(Math.abs(wide[0]?.zScore ?? 0)).toBeLessThan(Math.abs(tight[0]?.zScore ?? 0));
  });
});
