import { describe, it, expect } from 'vitest';
import { RiskEngine } from '../../src/lib/bot/risk-engine';

/**
 * Regression: the crypto bot booked ZERO trades because getRollingSharpe returns
 * 0 (not null) for a flat equity curve (no trades), and getSharpeMultiplier then
 * deflates that 0 → deflated ≤ 0 → returns 0 → position-size multiplier 0 →
 * every entry silently blocked. Chicken-and-egg: no first trade ⇒ flat equity ⇒
 * Sharpe 0 ⇒ sizing 0 ⇒ no first trade, forever.
 */
describe('getSharpeMultiplier — cold-start must NOT halt sizing', () => {
  const re = new RiskEngine();

  it('null rolling Sharpe (insufficient snapshots) → full size (existing guard)', () => {
    expect(re.getSharpeMultiplier({ rollingSharpe: null, numTrades: 0, trialCount: 236, minAcceptableSharpe: 0.5 })).toBe(1.0);
  });

  it('BUG REPRO: flat-equity Sharpe 0 with 0 trades must NOT return 0 (would block all entries)', () => {
    const m = re.getSharpeMultiplier({ rollingSharpe: 0, numTrades: 0, trialCount: 236, minAcceptableSharpe: 0.5 });
    expect(m).toBeGreaterThan(0);
    expect(m).toBe(1.0); // cold start = full size
  });

  it('a few trades is still cold-start — deflating a Sharpe on a tiny sample must not halt sizing', () => {
    const m = re.getSharpeMultiplier({ rollingSharpe: 0.05, numTrades: 3, trialCount: 236, minAcceptableSharpe: 0.5 });
    expect(m).toBeGreaterThan(0);
  });

  it('STILL HALTS with a real sample: genuinely negative deflated Sharpe after enough trades → 0', () => {
    // Large negative rolling Sharpe with a real trade count → deflated stays ≤ 0 → halt.
    const m = re.getSharpeMultiplier({ rollingSharpe: -2.0, numTrades: 100, trialCount: 236, minAcceptableSharpe: 0.5 });
    expect(m).toBe(0);
  });

  it('STILL DE-RISKS with a real sample: positive-but-marginal deflated Sharpe → 0.5', () => {
    // Tune so deflated is in (0, 0.5) with a real sample.
    const m = re.getSharpeMultiplier({ rollingSharpe: 0.6, numTrades: 300, trialCount: 5, minAcceptableSharpe: 0.5 });
    expect(m).toBe(0.5);
  });

  it('full size with a real sample and a strong deflated Sharpe → 1.0', () => {
    const m = re.getSharpeMultiplier({ rollingSharpe: 3.0, numTrades: 500, trialCount: 5, minAcceptableSharpe: 0.5 });
    expect(m).toBe(1.0);
  });
});
