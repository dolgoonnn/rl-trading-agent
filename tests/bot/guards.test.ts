import { describe, it, expect } from 'vitest';
import {
  computePositionSize,
  checkPreTradeGuards,
} from '@/lib/bot/guards';
import type { GuardResult, RejectReason } from '@/types/bot';

// Shared defaults mirroring SAFETY_GATE_CONFIG
const CAP = 2.0; // maxNotionalPctEquity
const MIN_STOP_PCT = 0.001;
const MAX_DEV_BPS = 50;
const MAX_AGE_MS = 5_400_000;

describe('computePositionSize', () => {
  // ---- Case 1: REGRESSION — tiny riskDistance must be floored + notional bounded ----
  it('floors a tiny riskDistance so notional stays bounded (regression for unbounded-size bug)', () => {
    // equity=10_000, riskPerTrade=0.003, symbolAlloc=0.40, riskDistance=0.0001, entryPrice=50_000
    // riskAmount = 10_000*0.003*0.40 = 12
    // OLD unbounded path: size = 12 / 0.0001 = 120_000 → notional = 6_000_000_000 (insane)
    // floored: riskDistance = max(0.001*50_000, 0.0001) = 50 → size = 12/50 = 0.24 → notional = 12_000
    const result = computePositionSize({
      equity: 10_000,
      riskPerTrade: 0.003,
      symbolAlloc: 0.40,
      riskDistance: 0.0001,
      entryPrice: 50_000,
      maxNotionalPctEquity: CAP,
      minStopPct: MIN_STOP_PCT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notionalUsdt).toBeLessThanOrEqual(CAP * 10_000);
      expect(result.size).toBeCloseTo(0.24, 10);
      expect(result.notionalUsdt).toBeCloseTo(12_000, 6);
    }
  });

  // ---- Case 2: riskDistance exactly at floor → ok:true ----
  it('accepts riskDistance exactly at the minStopPct*entry floor (pins > vs >=)', () => {
    const entryPrice = 50_000;
    const flooredDistance = MIN_STOP_PCT * entryPrice; // 50
    const result = computePositionSize({
      equity: 10_000,
      riskPerTrade: 0.003,
      symbolAlloc: 0.40,
      riskDistance: flooredDistance,
      entryPrice,
      maxNotionalPctEquity: CAP,
      minStopPct: MIN_STOP_PCT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // size = 12 / 50 = 0.24, notional = 12_000
      expect(result.size).toBeCloseTo(0.24, 10);
    }
  });

  // ---- Case 5: notional === cap → ok; +epsilon → max_notional ----
  it.each<{ name: string; equity: number; expectOk: boolean; reason?: RejectReason }>([
    // Construct so notional === cap*equity exactly.
    // riskAmount = equity*0.003*1.0; size = riskAmount/riskDistance; notional = size*entry.
    // Pick riskDistance so notional == cap*equity.
    { name: 'notional exactly at cap', equity: 10_000, expectOk: true },
  ])('$name', ({ equity }) => {
    // entry=100, riskDistance=1 → size=riskAmount/1=riskAmount, notional=riskAmount*100
    // want notional == cap*equity = 2*equity → riskAmount*100 == 2*equity
    // riskAmount = equity*riskPerTrade*alloc. Set riskPerTrade so riskAmount = 2*equity/100 = 0.02*equity
    // riskPerTrade*alloc = 0.02 → alloc=1, riskPerTrade=0.02
    const entryPrice = 100;
    const riskDistance = 1; // above floor (0.001*100 = 0.1)
    const atCap = computePositionSize({
      equity,
      riskPerTrade: 0.02,
      symbolAlloc: 1.0,
      riskDistance,
      entryPrice,
      maxNotionalPctEquity: CAP,
      minStopPct: MIN_STOP_PCT,
    });
    expect(atCap.ok).toBe(true);
    if (atCap.ok) {
      expect(atCap.notionalUsdt).toBeCloseTo(CAP * equity, 6);
    }

    // +epsilon over cap → max_notional. Nudge riskPerTrade up slightly.
    const overCap = computePositionSize({
      equity,
      riskPerTrade: 0.02 * (1 + 1e-6),
      symbolAlloc: 1.0,
      riskDistance,
      entryPrice,
      maxNotionalPctEquity: CAP,
      minStopPct: MIN_STOP_PCT,
    });
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) {
      expect(overCap.reason).toBe<RejectReason>('max_notional');
    }
  });

  // ---- Case 7: healthy signal → ok:true, size === equity*riskPerTrade*symbolAlloc/riskDistance ----
  it('returns expected size for a healthy signal (riskDistance above floor)', () => {
    const equity = 10_000;
    const riskPerTrade = 0.003;
    const symbolAlloc = 0.40;
    const entryPrice = 50_000;
    const riskDistance = 500; // well above floor (0.001*50_000 = 50)
    const result: GuardResult = computePositionSize({
      equity,
      riskPerTrade,
      symbolAlloc,
      riskDistance,
      entryPrice,
      maxNotionalPctEquity: CAP,
      minStopPct: MIN_STOP_PCT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expectedSize = (equity * riskPerTrade * symbolAlloc) / riskDistance;
      expect(result.size).toBeCloseTo(expectedSize, 10);
      expect(result.notionalUsdt).toBeCloseTo(expectedSize * entryPrice, 6);
    }
  });
});

describe('checkPreTradeGuards', () => {
  const healthy = {
    signalEntry: 50_000,
    markPrice: 50_000,
    candleHigh: 50_100,
    candleLow: 49_900,
    candleClose: 50_000,
    candleCloseMs: 1_000_000_000_000,
    nowMs: 1_000_000_000_000,
    maxDeviationBps: MAX_DEV_BPS,
    maxCandleAgeMs: MAX_AGE_MS,
  };

  // ---- Case 3: deviation === max → ok; +1bp → mark_deviation ----
  it('accepts deviation exactly at maxDeviationBps and rejects +1bp', () => {
    const markPrice = 50_000;
    // deviation in bps = |entry-mark|/mark*1e4. Want exactly 50 bps:
    // |entry-mark|/mark = 50/1e4 = 0.005 → entry = mark*(1.005) = 50_250
    const atBoundary = checkPreTradeGuards({
      ...healthy,
      signalEntry: markPrice * (1 + MAX_DEV_BPS / 1e4),
      markPrice,
    });
    expect(atBoundary.ok).toBe(true);

    // +1bp over (51 bps)
    const overBoundary = checkPreTradeGuards({
      ...healthy,
      signalEntry: markPrice * (1 + (MAX_DEV_BPS + 1) / 1e4),
      markPrice,
    });
    expect(overBoundary.ok).toBe(false);
    if (!overBoundary.ok) {
      expect(overBoundary.reason).toBe<RejectReason>('mark_deviation');
    }
  });

  // ---- Case 4: candle age === maxAgeMs → ok; +1ms → stale_candle ----
  it('accepts candle age exactly at maxCandleAgeMs and rejects +1ms', () => {
    const candleCloseMs = 1_000_000_000_000;
    const atBoundary = checkPreTradeGuards({
      ...healthy,
      candleCloseMs,
      nowMs: candleCloseMs + MAX_AGE_MS, // age === maxAgeMs
    });
    expect(atBoundary.ok).toBe(true);

    const overBoundary = checkPreTradeGuards({
      ...healthy,
      candleCloseMs,
      nowMs: candleCloseMs + MAX_AGE_MS + 1, // +1ms
    });
    expect(overBoundary.ok).toBe(false);
    if (!overBoundary.ok) {
      expect(overBoundary.reason).toBe<RejectReason>('stale_candle');
    }
  });

  // ---- Case 6: crossed candle (high < low) → crossed_candle ----
  it('rejects a crossed candle where high < low', () => {
    const result = checkPreTradeGuards({
      ...healthy,
      candleHigh: 49_800, // high below low → crossed
      candleLow: 49_900,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe<RejectReason>('crossed_candle');
    }
  });

  it('rejects a candle with non-positive low', () => {
    const result = checkPreTradeGuards({
      ...healthy,
      candleHigh: 100,
      candleLow: 0,
      candleClose: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe<RejectReason>('crossed_candle');
    }
  });

  it('accepts a fully healthy signal', () => {
    const result = checkPreTradeGuards(healthy);
    expect(result.ok).toBe(true);
  });
});
