import { describe, it, expect } from 'vitest';
import { FlatFrictionCostModel, SpreadFeeImpactCostModel } from '@/lib/sim/cost-model';

describe('FlatFrictionCostModel (parity with current friction)', () => {
  const m = new FlatFrictionCostModel(0.0015); // 0.15% per side, no split

  it('long entry marks price UP by friction', () => {
    expect(m.apply(100, 'long', { side: 'entry' })).toBeCloseTo(100 * 1.0015, 9);
  });
  it('long exit marks price DOWN by friction', () => {
    expect(m.apply(100, 'long', { side: 'exit' })).toBeCloseTo(100 * 0.9985, 9);
  });
  it('short entry marks DOWN, short exit marks UP', () => {
    expect(m.apply(100, 'short', { side: 'entry' })).toBeCloseTo(100 * 0.9985, 9);
    expect(m.apply(100, 'short', { side: 'exit' })).toBeCloseTo(100 * 1.0015, 9);
  });
});

describe('FlatFrictionCostModel with maker/taker split', () => {
  const m = new FlatFrictionCostModel(0.0015, { makerBps: 2, takerBps: 5.5 });
  it('passive TP exit pays the maker leg', () => {
    expect(m.apply(100, 'long', { side: 'exit', exitSide: 'maker' })).toBeCloseTo(100 * (1 - 0.0002), 9);
  });
  it('entry crosses as taker', () => {
    expect(m.apply(100, 'long', { side: 'entry' })).toBeCloseTo(100 * (1 + 0.00055), 9);
  });
});

describe('SpreadFeeImpactCostModel', () => {
  const m = new SpreadFeeImpactCostModel({ takerFee: 0.00055, makerFee: 0.0002, impactCoef: 0.5, maxFillVolumeFrac: 0.025 });
  it('charges taker fee + half-spread on a small order (no impact)', () => {
    const out = m.apply(100, 'long', { side: 'entry', halfSpread: 0.0001, barVolume: 1e9, orderQty: 1 });
    // ~ 100 * (1 + 0.00055 + 0.0001), impact ~ 0 (but sqrt-impact still nonzero on finite orderQty)
    expect(out).toBeGreaterThan(100 * (1 + 0.00055 + 0.0001) - 1e-6);
    // impact at orderQty=1, barVolume=1e9 is ~0.00158 abs (0.5*sqrt(1e-9)*100), well inside 1e-3 relative (=0.1 abs)
    expect(out).toBeLessThan(100 * (1 + 0.00055 + 0.0001) + 1e-3);
  });
  it('adds sqrt impact when order is a real fraction of bar volume', () => {
    const small = m.apply(100, 'long', { side: 'entry', halfSpread: 0, barVolume: 1e6, orderQty: 1 });
    const big = m.apply(100, 'long', { side: 'entry', halfSpread: 0, barVolume: 1e6, orderQty: 10_000 });
    expect(big).toBeGreaterThan(small);
  });
});
