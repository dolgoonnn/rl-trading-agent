/**
 * The metals overnight pair is ONE bet, so it must carry ONE leg's risk.
 *
 * OBSERVED LIVE (2026-07-30, 21 closed trades): the gold and silver `overnight`
 * legs enter within seconds of each other and exit on the SAME timestamp, every
 * single night. They are not two positions — they are one directional bet on
 * precious metals, booked at double size:
 *
 *   2026-07-28 07:01   silver -1.981% + gold -0.800%  =  -2.782%
 *   2026-07-29 07:01   gold   +0.996% + silver +0.796% =  +1.792%
 *   2026-07-30 07:01   silver -0.811% + gold -0.653%  =  -1.464%
 *
 * Net: the pair alone was -2.454% while every OTHER leg combined was +0.511%.
 * One correlated leg dragged the whole book from positive to -1.943%.
 *
 * FIX: weight each side of a correlated pair so the pair sums to one unit of
 * risk. This changes SIZING only — not which trades are taken, not when they
 * exit — so it needs no re-validation of the underlying session edge.
 */
import { describe, it, expect } from 'vitest';
import { legWeight, CORRELATED_PAIR_WEIGHT } from '../../scripts/run-metals-bot';

describe('metals leg weighting', () => {
  it('halves each side of the correlated overnight pair', () => {
    expect(legWeight('overnight', 'gold')).toBe(CORRELATED_PAIR_WEIGHT);
    expect(legWeight('overnight', 'silver')).toBe(CORRELATED_PAIR_WEIGHT);
    expect(CORRELATED_PAIR_WEIGHT).toBe(0.5);
  });

  it('halves the weekend pair too — same two instruments, same correlation', () => {
    expect(legWeight('weekend', 'gold')).toBe(CORRELATED_PAIR_WEIGHT);
    expect(legWeight('weekend', 'silver')).toBe(CORRELATED_PAIR_WEIGHT);
  });

  it('leaves single-instrument legs at full weight', () => {
    expect(legWeight('fix-short', 'gold')).toBe(1);
    expect(legWeight('agfix-short', 'silver')).toBe(1);
    expect(legWeight('eur-morning-short', 'eurusd')).toBe(1);
    expect(legWeight('us500-overnight', 'us500')).toBe(1);
  });

  it('makes the correlated pair sum to one leg of risk', () => {
    const pair = legWeight('overnight', 'gold') + legWeight('overnight', 'silver');
    expect(pair).toBe(1);
    // A single-instrument leg already is one unit.
    expect(legWeight('fix-short', 'gold')).toBe(1);
  });

  it('would have halved the live loss from the correlated nights', () => {
    // The three observed pair nights, raw (unweighted) percent.
    const nights = [
      [-1.981, -0.800],
      [+0.996, +0.796],
      [-0.811, -0.653],
    ];
    const raw = nights.flat().reduce((a, b) => a + b, 0);
    const weighted = nights
      .flat()
      .reduce((a, b) => a + b * legWeight('overnight', 'gold'), 0);
    expect(raw).toBeCloseTo(-2.453, 2);
    expect(weighted).toBeCloseTo(-1.2265, 2);

    // Book was -1.943 = pair (-2.453) + everything else (+0.510).
    const everythingElse = -1.943 - raw;
    expect(everythingElse).toBeCloseTo(0.51, 2);

    // Weighting the pair roughly HALVES the book loss. It does NOT flip the book
    // positive — the pair still outweighs the other legs' combined profit. The
    // gain is a smaller, better-scaled loss, not a rescue.
    const weightedBook = everythingElse + weighted;
    expect(weightedBook).toBeCloseTo(-0.716, 2);
    expect(weightedBook).toBeGreaterThan(-1.943); // strictly better
    expect(weightedBook).toBeLessThan(0); // but still a losing sample
  });
});
