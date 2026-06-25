// tests/scalp/leverage/liquidation.test.ts
import { describe, it, expect } from 'vitest';
import {
  liquidationPrice,
  effectiveLiqTrigger,
  fundingCostFraction,
} from '@/lib/scalp/leverage/liquidation';

describe('liquidationPrice', () => {
  it('long: entry 100, L=10, mmr=0.005 -> 90.5', () => {
    expect(liquidationPrice(100, 'long', 10, 0.005)).toBeCloseTo(90.5, 9);
  });
  it('short: entry 100, L=10, mmr=0.005 -> 109.5', () => {
    expect(liquidationPrice(100, 'short', 10, 0.005)).toBeCloseTo(109.5, 9);
  });
  it('long: L=100, mmr=0.005 -> 99.5 (0.5% from entry)', () => {
    expect(liquidationPrice(100, 'long', 100, 0.005)).toBeCloseTo(99.5, 9);
  });
});

describe('effectiveLiqTrigger', () => {
  it('long: slippage shifts trigger UP toward entry (earlier liquidation)', () => {
    const raw = liquidationPrice(100, 'long', 10, 0.005); // 90.5
    const trig = effectiveLiqTrigger(100, 'long', 10, 0.005, 10); // +0.10
    expect(trig).toBeGreaterThan(raw);
    expect(trig).toBeCloseTo(90.6, 9);
  });
  it('short: slippage shifts trigger DOWN toward entry', () => {
    const raw = liquidationPrice(100, 'short', 10, 0.005); // 109.5
    const trig = effectiveLiqTrigger(100, 'short', 10, 0.005, 10); // -0.10
    expect(trig).toBeLessThan(raw);
    expect(trig).toBeCloseTo(109.4, 9);
  });
});

describe('fundingCostFraction', () => {
  const H = 3_600_000;
  it('trade spanning exactly one 08:00 UTC boundary -> one charge', () => {
    // 1970-01-01 07:30 UTC .. 08:30 UTC crosses the 08:00 boundary once
    const entry = 7 * H + 30 * 60_000;
    const exit = 8 * H + 30 * 60_000;
    expect(fundingCostFraction(entry, exit, 0.0001)).toBeCloseTo(0.0001, 12);
  });
  it('trade within a single funding window -> zero', () => {
    const entry = 1 * H;       // 01:00
    const exit = 1 * H + 60_000; // 01:01
    expect(fundingCostFraction(entry, exit, 0.0001)).toBe(0);
  });
  it('trade spanning two boundaries (00:00 and 08:00) -> two charges', () => {
    const entry = 23 * H;          // day0 23:00
    const exit = 23 * H + 10 * H;  // day1 09:00 -> crosses day1 00:00 and 08:00
    expect(fundingCostFraction(entry, exit, 0.0001)).toBeCloseTo(0.0002, 12);
  });
});
