import { describe, it, expect } from 'vitest';
import { resolveSimConfig } from '@/lib/sim/resolve-config';

describe('resolveSimConfig', () => {
  it('returns the deployed partial_tp config for order_block', () => {
    const cfg = resolveSimConfig('order_block');
    expect(cfg).toStrictEqual({
      entryTiming: 'signal_close',
      maxBars: 160,
      barMs: 3_600_000,
      exitMode: 'partial_tp',
      partialTP: { fraction: 0.50, triggerR: 1.41, beBuffer: 0.20 },
    });
  });

  it('throws on an unknown strategy', () => {
    expect(() => resolveSimConfig('nope')).toThrow(/nope/);
  });
});
