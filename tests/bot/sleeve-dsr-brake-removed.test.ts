/**
 * The sleeve-level deflated-Sharpe SIZING brake is retired.
 *
 * It was miscalibrated in two directions at once:
 *   1. `position-tracker.getRollingSharpe()` returns an ANNUALIZED Sharpe
 *      ((mean/std) * sqrt(periodsPerYear), from daily equity snapshots), but it was
 *      fed to `calculateDeflatedSharpe`, whose variance is Lo's PER-OBSERVATION
 *      formula (1 + 0.5*SR^2 ...)/T — and T was the trade count, not the number of
 *      daily observations the Sharpe was actually computed from.
 *   2. The net effect FAILED OPEN: at 238 trials / 30 trades, an annualized rolling
 *      Sharpe of 2.0 sized FULL where honest units say halt.
 *
 * A naive units fix is not viable either: honestly deflated, a single config at 238
 * trials is negative for any realistic Sharpe (see the honest-DSR recompute), so the
 * brake would be permanently stuck ON.
 *
 * Resolution: edge decay is governed at BOOK level by the book-governance signal
 * (already respected by the session/metals bot), consistent with the earlier decision
 * to re-scope DSR halting to the book (dsrBreachK = 0). Drawdown and regime
 * multipliers are unchanged and remain the sleeve-level risk controls.
 */
import { describe, it, expect } from 'vitest';
import { RiskEngine } from '../../src/lib/bot/risk-engine';

describe('sleeve DSR sizing brake retired', () => {
  it('no longer exposes a rolling-Sharpe sizing multiplier', () => {
    const engine = RiskEngine.prototype as unknown as Record<string, unknown>;
    expect(engine.getSharpeMultiplier).toBeUndefined();
  });

  it('does not import the deflated-Sharpe helper into the sizing path', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/lib/bot/risk-engine.ts', 'utf-8');
    expect(src).not.toContain('calculateDeflatedSharpe');
  });

  it('keeps the sizing breakdown reporting drawdown and regime only', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/lib/bot/risk-engine.ts', 'utf-8');
    // The multiplier must no longer fold in a sharpe term.
    expect(src).not.toMatch(/multiplier\s*=\s*drawdownMult\s*\*\s*regimeMult\s*\*\s*sharpeMult/);
    expect(src).toMatch(/drawdownMult\s*\*\s*regimeMult/);
  });
});
