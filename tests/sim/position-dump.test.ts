import { describe, it, expect } from 'vitest';
import { buildDumpedPosition } from '@/lib/sim/position-dump';
import type { DumpedPosition } from '@/lib/sim/position-dump';

describe('buildDumpedPosition', () => {
  it('attaches symbol and preserves all fields for a long', () => {
    const input = {
      direction: 'long' as const,
      entryPrice: 100,
      stopLoss: 99,
      takeProfit: 110,
      entryTimestamp: 1700000000000,
      strategy: 'order_block',
    };

    const result = buildDumpedPosition(input, 'BTCUSDT');

    const expected: DumpedPosition = {
      symbol: 'BTCUSDT',
      direction: 'long',
      entryPrice: 100,
      stopLoss: 99,
      takeProfit: 110,
      entryTimestamp: 1700000000000,
      strategy: 'order_block',
    };

    expect(result).toStrictEqual(expected);
  });

  it('attaches symbol and preserves all fields for a short', () => {
    const input = {
      direction: 'short' as const,
      entryPrice: 2000,
      stopLoss: 2050,
      takeProfit: 1900,
      entryTimestamp: 1700005000000,
      strategy: 'fvg',
    };

    const result = buildDumpedPosition(input, 'ETHUSDT');

    const expected: DumpedPosition = {
      symbol: 'ETHUSDT',
      direction: 'short',
      entryPrice: 2000,
      stopLoss: 2050,
      takeProfit: 1900,
      entryTimestamp: 1700005000000,
      strategy: 'fvg',
    };

    expect(result).toStrictEqual(expected);
  });
});
