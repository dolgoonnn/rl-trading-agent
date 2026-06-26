import { describe, it, expect } from 'vitest';
import { liqAdverseMove, liquidationPrice } from '../../src/lib/sim/liquidation';

describe('liqAdverseMove', () => {
  it('50x leverage, 0.5% MMR → 1.5% adverse move', () => {
    expect(liqAdverseMove(50, 0.005)).toBeCloseTo(0.015, 10);
  });

  it('100x leverage, 0.5% MMR → 0.5% adverse move', () => {
    expect(liqAdverseMove(100, 0.005)).toBeCloseTo(0.005, 10);
  });

  it('throws when 1/L === mmr (d = 0, non-viable position)', () => {
    // 1/200 = 0.005 = mmr → d = 0
    expect(() => liqAdverseMove(200, 0.005)).toThrow();
  });

  it('throws when 1/L < mmr (d < 0, instantly liquidatable)', () => {
    // e.g. 1/50 = 0.02, mmr = 0.03 → d = -0.01
    expect(() => liqAdverseMove(50, 0.03)).toThrow();
  });

  it('throws when leverage <= 0', () => {
    expect(() => liqAdverseMove(0, 0.005)).toThrow();
    expect(() => liqAdverseMove(-10, 0.005)).toThrow();
  });

  it('throws when mmr < 0', () => {
    expect(() => liqAdverseMove(50, -0.001)).toThrow();
  });
});

describe('liquidationPrice', () => {
  it('long 50x → liq below entry', () => {
    expect(liquidationPrice(100, 'long', 50, 0.005)).toBeCloseTo(98.5, 10);
  });

  it('short 50x → liq above entry', () => {
    expect(liquidationPrice(100, 'short', 50, 0.005)).toBeCloseTo(101.5, 10);
  });

  it('long 100x → liq below entry', () => {
    expect(liquidationPrice(100, 'long', 100, 0.005)).toBeCloseTo(99.5, 10);
  });

  it('throws when leverage <= 0 (via liqAdverseMove guard)', () => {
    expect(() => liquidationPrice(100, 'long', 0, 0.005)).toThrow();
  });

  it('throws when position is non-viable (1/L <= mmr)', () => {
    expect(() => liquidationPrice(100, 'long', 200, 0.005)).toThrow();
  });
});
