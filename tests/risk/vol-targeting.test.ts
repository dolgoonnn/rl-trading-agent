import { describe, it, expect } from 'vitest';
import {
  annualizedVol,
  volTargetLeverage,
  fractionalKellyVolTarget,
  BARS_PER_YEAR_1H,
  BARS_PER_YEAR_DAILY,
} from '@/lib/risk/sizing';

/**
 * Constant-vol targeting. Pure, DI'd functions — every input is passed in, no
 * Date.now()/fetch. The CRITICAL regression: annualization MUST use the true
 * bars-per-year of the series (8760 for 1h crypto, 365 for daily crypto), NOT
 * the equities sqrt(252) — getting this wrong silently mis-levers the book.
 */

describe('annualizedVol — scales per-bar std by sqrt(barsPerYear)', () => {
  it('annualizes a per-bar std by the supplied barsPerYear', () => {
    // returns with a known per-bar std; verify ann = std * sqrt(barsPerYear)
    const returns = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01];
    // sample std of [+0.01,-0.01,...] = 0.01095 (n-1)
    const perBarStd = annualizedVol(returns, 1) / Math.sqrt(1);
    expect(perBarStd).toBeCloseTo(0.010954, 5);
    const ann = annualizedVol(returns, BARS_PER_YEAR_1H);
    expect(ann).toBeCloseTo(perBarStd * Math.sqrt(BARS_PER_YEAR_1H), 9);
  });

  it('REGRESSION: a 1h series uses barsPerYear=8760, NOT sqrt(252)', () => {
    const returns = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01];
    const annHourly = annualizedVol(returns, BARS_PER_YEAR_1H);
    const annEquitiesWrong = annualizedVol(returns, 252);
    // The hourly annualization must be sqrt(8760/252) ≈ 5.9x the (wrong) 252 one.
    expect(BARS_PER_YEAR_1H).toBe(8760);
    expect(annHourly / annEquitiesWrong).toBeCloseTo(Math.sqrt(8760 / 252), 6);
    // Concretely it must NOT equal the sqrt(252) annualization.
    expect(annHourly).not.toBeCloseTo(annEquitiesWrong, 6);
  });

  it('daily crypto uses barsPerYear=365, NOT 252', () => {
    expect(BARS_PER_YEAR_DAILY).toBe(365);
    const returns = [0.02, -0.02, 0.02, -0.02];
    const annDaily = annualizedVol(returns, BARS_PER_YEAR_DAILY);
    const annEquities = annualizedVol(returns, 252);
    expect(annDaily / annEquities).toBeCloseTo(Math.sqrt(365 / 252), 6);
  });

  it('returns 0 for fewer than 2 observations (no std)', () => {
    expect(annualizedVol([], BARS_PER_YEAR_1H)).toBe(0);
    expect(annualizedVol([0.01], BARS_PER_YEAR_1H)).toBe(0);
  });
});

describe('volTargetLeverage — min(targetVol/realizedVol, maxLeverage)', () => {
  it('levers up a quiet series toward the target, capped by maxLeverage', () => {
    // realized 5% vs 12% target ⇒ 2.4x, under a 3x cap ⇒ 2.4x
    const lev = volTargetLeverage({ realizedVol: 0.05, targetVol: 0.12, maxLeverage: 3 });
    expect(lev).toBeCloseTo(0.12 / 0.05, 9);
    expect(lev).toBeCloseTo(2.4, 9);
  });

  it('caps leverage at maxLeverage for a very quiet series', () => {
    const lev = volTargetLeverage({ realizedVol: 0.02, targetVol: 0.12, maxLeverage: 3 });
    expect(lev).toBe(3); // 0.12/0.02 = 6 → capped at 3
  });

  it('delevers a hot series below 1x (no floor — risk reduction is the point)', () => {
    const lev = volTargetLeverage({ realizedVol: 0.36, targetVol: 0.12, maxLeverage: 3 });
    expect(lev).toBeCloseTo(1 / 3, 9);
  });

  it('returns 0 when realizedVol is 0 (cannot size a dead series)', () => {
    expect(volTargetLeverage({ realizedVol: 0, targetVol: 0.12, maxLeverage: 3 })).toBe(0);
  });

  it('boundary: targetVol == realizedVol ⇒ exactly 1x', () => {
    expect(volTargetLeverage({ realizedVol: 0.12, targetVol: 0.12, maxLeverage: 3 })).toBe(1);
  });
});

describe('fractionalKellyVolTarget — frac*SR_deflated-scaled target, stand down on SR<=0', () => {
  it('positive deflated Sharpe ⇒ fraction-scaled target vol', () => {
    // half-Kelly: usedTarget = baseTargetVol * clamp(fraction*SR, 0, 1)
    // SR=2, frac=0.5 ⇒ scale = min(1, 1.0) = 1.0 ⇒ usedTarget = baseTargetVol
    const t = fractionalKellyVolTarget({
      deflatedSharpeRolling: 2,
      baseTargetVol: 0.12,
      fraction: 0.5,
    });
    expect(t).toBeCloseTo(0.12, 9);
  });

  it('modest positive Sharpe scales the target below base', () => {
    // SR=1, frac=0.5 ⇒ scale = 0.5 ⇒ usedTarget = 0.06
    const t = fractionalKellyVolTarget({
      deflatedSharpeRolling: 1,
      baseTargetVol: 0.12,
      fraction: 0.5,
    });
    expect(t).toBeCloseTo(0.06, 9);
  });

  it('STAND DOWN: deflatedSharpe <= 0 ⇒ target vol 0 (no exposure)', () => {
    expect(
      fractionalKellyVolTarget({ deflatedSharpeRolling: 0, baseTargetVol: 0.12, fraction: 0.5 }),
    ).toBe(0);
    expect(
      fractionalKellyVolTarget({ deflatedSharpeRolling: -0.5, baseTargetVol: 0.12, fraction: 0.5 }),
    ).toBe(0);
  });

  it('caps the Kelly scale at base target (never levers ABOVE baseTargetVol)', () => {
    // SR=10, frac=0.5 ⇒ raw scale 5 → clamped to 1 ⇒ usedTarget = base, not 5*base
    const t = fractionalKellyVolTarget({
      deflatedSharpeRolling: 10,
      baseTargetVol: 0.12,
      fraction: 0.5,
    });
    expect(t).toBeCloseTo(0.12, 9);
  });
});
