/**
 * Cold-start sizing must never zero out — regression guard.
 *
 * ORIGINAL BUG: a flat, tradeless equity curve produced rollingSharpe 0, which the
 * sleeve-level deflated-Sharpe brake deflated to <= 0 and turned into a 0x
 * position-size multiplier — so the bot could never open its FIRST trade
 * (chicken-and-egg: no first trade => flat equity => Sharpe 0 => sizing 0 => no
 * first trade, forever). That cost weeks of an empty forward record.
 *
 * The brake itself has since been RETIRED: it fed an ANNUALIZED rolling Sharpe into
 * a PER-OBSERVATION deflation formula and failed OPEN (see
 * tests/bot/sleeve-dsr-brake-removed.test.ts). Edge decay is now governed at BOOK
 * level by the book-governance signal.
 *
 * So this file no longer tests the removed method. It pins the PROPERTY that still
 * matters and must hold forever: a fresh book with no trades and no drawdown still
 * sizes above zero, so the first entry can actually book.
 */
import { describe, it, expect } from 'vitest';
import { RiskEngine } from '../../src/lib/bot/risk-engine';
import type { PositionTracker } from '../../src/lib/bot/position-tracker';

/** Minimal tracker stub for a brand-new book: no trades, no drawdown, flat equity. */
function coldStartTracker(over: Record<string, unknown> = {}): PositionTracker {
  const stub = {
    getDrawdown: () => 0,
    getTotalTrades: () => 0,
    getRollingSharpe: () => null,
    getOpenPositions: () => [],
    getCircuitBreakers: () => [],
    ...over,
  };
  return stub as unknown as PositionTracker;
}

describe('cold-start sizing must not halt the first trade', () => {
  it('sizes above zero on a brand-new book (no trades, no drawdown)', () => {
    const engine = new RiskEngine();
    const { multiplier } = engine.getPositionSizeMultiplier(coldStartTracker(), 'uptrend+normal');
    expect(multiplier).toBeGreaterThan(0);
  });

  it('BUG REPRO: flat-equity rolling Sharpe 0 with 0 trades must not zero sizing', () => {
    const engine = new RiskEngine();
    const tracker = coldStartTracker({ getRollingSharpe: () => 0, getTotalTrades: () => 0 });
    const { multiplier } = engine.getPositionSizeMultiplier(tracker, 'uptrend+normal');
    expect(multiplier).toBeGreaterThan(0);
  });

  it('a tiny trade sample must not zero sizing either', () => {
    const engine = new RiskEngine();
    const tracker = coldStartTracker({ getRollingSharpe: () => 0.05, getTotalTrades: () => 3 });
    const { multiplier } = engine.getPositionSizeMultiplier(tracker, 'uptrend+normal');
    expect(multiplier).toBeGreaterThan(0);
  });

  it('reports a neutral sharpe term in the breakdown (brake retired)', () => {
    const engine = new RiskEngine();
    const { breakdown } = engine.getPositionSizeMultiplier(coldStartTracker(), 'uptrend+normal');
    expect(breakdown.sharpe).toBe(1.0);
  });

  it('still de-risks on real drawdown — the surviving sleeve control', () => {
    const engine = new RiskEngine();
    const deep = coldStartTracker({ getDrawdown: () => 0.12 });
    const { breakdown } = engine.getPositionSizeMultiplier(deep, 'uptrend+normal');
    expect(breakdown.drawdown).toBeLessThan(1.0);
  });
});
