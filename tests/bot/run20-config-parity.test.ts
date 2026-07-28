/**
 * Run 20 sim/live parity guard.
 *
 * Run 20 was optimized AND validated by `scripts/train-cmaes-production.ts`,
 * which builds its backtest args WITHOUT `--production`. The backtest therefore
 * scored every candidate against `DEFAULT_CONFIG` (maxStructureAge = 75), with
 * only `--sl-mode dynamic_rr` layered on top.
 *
 * The live signal engine, however, seeds its scorer from
 * `PRODUCTION_STRATEGY_CONFIG`, which tightens `maxStructureAge` to 50. That
 * silently deploys a stricter entry gate than anything that was ever validated
 * (measured on identical data: 645 trades vs 657, and materially worse PnL).
 *
 * These tests pin the LIVE effective strategy config to the values Run 20 was
 * actually validated with, so the divergence cannot silently return.
 */
import { describe, it, expect } from 'vitest';
import { SignalEngine } from '../../src/lib/bot/signal-engine';
import { RUN20_STRATEGY_CONFIG } from '../../src/lib/bot/config';

/** Effective strategy config the live scorer ends up using for a symbol. */
function liveStrategyConfig(): Record<string, unknown> {
  const engine = new SignalEngine(RUN20_STRATEGY_CONFIG);
  const withInternals = engine as unknown as { getOrCreateScorer: (s: string) => unknown };
  const scorer = withInternals.getOrCreateScorer('BTCUSDT') as {
    config?: { strategyConfig?: Record<string, unknown> };
  };
  return scorer.config?.strategyConfig ?? {};
}

describe('Run 20 live/validated parity', () => {
  it('uses the validated structure-age gate (75), not the tighter production 50', () => {
    expect(liveStrategyConfig().maxStructureAge).toBe(75);
  });

  it('keeps the SL placement mode the validated command passed via --sl-mode', () => {
    expect(liveStrategyConfig().slPlacementMode).toBe('dynamic_rr');
  });

  it('keeps the remaining validated entry gates unchanged', () => {
    const c = liveStrategyConfig();
    expect(c.minConfluence).toBe(2);
    expect(c.minRiskReward).toBe(1.5);
    expect(c.stopLossATRMultiple).toBe(2.0);
    expect(c.takeProfitATRMultiple).toBe(4.0);
    expect(c.proximityPercent).toBe(0.005);
    expect(c.useKillZoneFilter).toBe(false);
    expect(c.requireLiquiditySweep).toBe(false);
  });

  it('pins the Run 20 scorer params that the CMA-ES command optimized', () => {
    expect(RUN20_STRATEGY_CONFIG.baseThreshold).toBe(4.048);
    expect(RUN20_STRATEGY_CONFIG.obHalfLife).toBe(12);
    expect(RUN20_STRATEGY_CONFIG.maxBars).toBe(160);
    expect(RUN20_STRATEGY_CONFIG.cooldownBars).toBe(7);
    expect(RUN20_STRATEGY_CONFIG.atrExtensionBands).toBe(5.79);
    expect(RUN20_STRATEGY_CONFIG.frictionPerSide).toBe(0.0007);
    expect(RUN20_STRATEGY_CONFIG.suppressedRegimes).toEqual([
      'ranging+normal',
      'ranging+high',
      'downtrend+high',
    ]);
  });
});
