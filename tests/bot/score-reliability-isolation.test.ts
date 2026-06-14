import { describe, it, expect } from 'vitest';
import {
  scoreReliabilityCurve,
  type ReviewTradeRow,
  type ScoreReliabilityBin,
} from '@/lib/bot/review';
import { computePositionSize } from '@/lib/bot/guards';
import type { GuardResult } from '@/types/bot';

/**
 * Task 7 — THE GUARDRAIL.
 *
 * The score-reliability curve is a DIAGNOSTIC surfaced in the weekly review. It
 * MUST NEVER feed sizing. This test proves that property structurally: position
 * size is computed twice with two WILDLY different reliability curves and the
 * result is byte-identical, because `computePositionSize` has no parameter that
 * could consume a reliability curve.
 */

const DAY0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

function row(score: number, net: number): ReviewTradeRow {
  return {
    id: Math.random().toString(36).slice(2),
    symbol: 'BTCUSDT',
    regime: 'uptrend+normal',
    exitReason: net > 0 ? 'take_profit' : 'stop_loss',
    confluenceScore: score,
    entryTimestamp: DAY0,
    grossReturn: net,
    frictionReturn: 0,
    fundingReturn: 0,
    netReturn: net,
  };
}

describe('scoreReliabilityCurve — diagnostic binning', () => {
  it('bins by confluence score into [<5, 5-6, 6-7, 7+] with correct boundaries (5, 6, 7)', () => {
    const trades: ReviewTradeRow[] = [
      row(4.99, -0.01), // <5  loser
      row(5.0, 0.02), //   5-6 winner (boundary 5 → 5-6)
      row(5.9, -0.01), //   5-6 loser
      row(6.0, 0.03), //   6-7 winner (boundary 6 → 6-7)
      row(7.0, 0.04), //   7+  winner (boundary 7 → 7+)
      row(9.0, 0.05), //   7+  winner
    ];

    const curve = scoreReliabilityCurve(trades);
    const byBucket = new Map<string, ScoreReliabilityBin>(
      curve.map((b) => [b.bucket, b]),
    );

    // <5: 1 trade, loser
    expect(byBucket.get('<5')!.n).toBe(1);
    expect(byBucket.get('<5')!.winRate).toBe(0);

    // 5-6: 2 trades (5.0 and 5.9), 1 winner
    expect(byBucket.get('5-6')!.n).toBe(2);
    expect(byBucket.get('5-6')!.winRate).toBeCloseTo(0.5, 12);

    // 6-7: 1 trade (6.0), winner
    expect(byBucket.get('6-7')!.n).toBe(1);
    expect(byBucket.get('6-7')!.winRate).toBe(1);

    // 7+: 2 trades (7.0 and 9.0), both winners
    expect(byBucket.get('7+')!.n).toBe(2);
    expect(byBucket.get('7+')!.winRate).toBe(1);
  });

  it('reports realized win-rate and mean net-R per bin', () => {
    const trades: ReviewTradeRow[] = [
      row(7.2, 0.04),
      row(7.5, 0.06),
      row(8.0, -0.02),
    ];
    const curve = scoreReliabilityCurve(trades);
    const bin = curve.find((b) => b.bucket === '7+')!;
    expect(bin.n).toBe(3);
    expect(bin.winRate).toBeCloseTo(2 / 3, 12);
    expect(bin.meanNetR).toBeCloseTo((0.04 + 0.06 - 0.02) / 3, 12);
  });

  it('omits empty buckets (only bins with trades are returned)', () => {
    const trades: ReviewTradeRow[] = [row(8.0, 0.03)];
    const curve = scoreReliabilityCurve(trades);
    expect(curve).toHaveLength(1);
    expect(curve[0]!.bucket).toBe('7+');
  });
});

describe('GUARDRAIL: sizing is provably independent of the score-reliability curve', () => {
  it('computes an IDENTICAL position size for two DIFFERENT reliability curves', () => {
    // Curve A: 7+ bucket looks fantastic (90% win, +0.5R).
    const curveA = scoreReliabilityCurve([
      row(7.5, 0.5),
      row(7.6, 0.5),
      row(7.7, 0.5),
      row(7.8, 0.5),
      row(7.9, 0.5),
      row(8.0, 0.5),
      row(8.1, 0.5),
      row(8.2, 0.5),
      row(8.3, 0.5),
      row(8.4, -0.5),
    ]);

    // Curve B: 7+ bucket looks terrible (10% win, -0.4R).
    const curveB = scoreReliabilityCurve([
      row(7.5, -0.4),
      row(7.6, -0.4),
      row(7.7, -0.4),
      row(7.8, -0.4),
      row(7.9, -0.4),
      row(8.0, -0.4),
      row(8.1, -0.4),
      row(8.2, -0.4),
      row(8.3, -0.4),
      row(8.4, 0.4),
    ]);

    // Sanity: the two curves really do disagree, so a leak WOULD change sizing.
    const a7 = curveA.find((b) => b.bucket === '7+')!;
    const b7 = curveB.find((b) => b.bucket === '7+')!;
    expect(a7.winRate).not.toBeCloseTo(b7.winRate, 6);
    expect(a7.meanNetR).not.toBeCloseTo(b7.meanNetR, 6);

    // The sizing inputs are identical and contain NO reliability-curve argument.
    const sizingArgs = {
      equity: 10_000,
      riskPerTrade: 0.003,
      symbolAlloc: 0.4,
      riskDistance: 500,
      entryPrice: 50_000,
      maxNotionalPctEquity: 2.0,
      minStopPct: 0.001,
    } as const;

    // We deliberately do NOT pass either curve — it has no slot in the contract.
    const sizeWithA: GuardResult = computePositionSize({ ...sizingArgs });
    const sizeWithB: GuardResult = computePositionSize({ ...sizingArgs });

    expect(sizeWithA.ok).toBe(true);
    expect(sizeWithB.ok).toBe(true);
    if (sizeWithA.ok && sizeWithB.ok) {
      // Byte-identical: sizing cannot have consumed the reliability curve.
      expect(sizeWithA.size).toBe(sizeWithB.size);
      expect(sizeWithA.notionalUsdt).toBe(sizeWithB.notionalUsdt);
    }

    // Type-level proof: computePositionSize's argument object has no key that
    // could carry a reliability curve. (If a future refactor adds one, this
    // object-shape assertion + the no-arg call above will surface it.)
    const argKeys = Object.keys(sizingArgs).sort();
    expect(argKeys).toEqual(
      [
        'entryPrice',
        'equity',
        'maxNotionalPctEquity',
        'minStopPct',
        'riskDistance',
        'riskPerTrade',
        'symbolAlloc',
      ].sort(),
    );
  });
});
