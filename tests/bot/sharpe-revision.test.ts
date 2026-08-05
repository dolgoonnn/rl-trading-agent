/**
 * Drawdown-based Sharpe revision — the answer to "what do I do instead of waiting?"
 *
 * Proving an edge from live returns needs a Minimum Track Record Length that
 * scales as 1/Sharpe² (Bailey & Lopez de Prado): ~6 months for the book at
 * Sharpe 2.26, over 6 YEARS for a single Sharpe-0.66 leg. Waiting is not a
 * usable method, and no significance test fixes that.
 *
 * What IS decidable quickly is the drawdown, because a drawdown deep enough to
 * matter is a LARGE signal. For a drifted Brownian equity curve the all-time
 * maximum drawdown is exponential:
 *
 *     P(MaxDD >= D | Sharpe S, vol sigma) = exp(-2 * D * S / sigma)
 *
 * Inverting it gives the number the operator actually wants: the deepest Sharpe
 * still defensible after seeing drawdown D, and — computable BEFORE a single
 * trade — the drawdown at which the assumed Sharpe stops being credible.
 *
 * This is the Rej/Seager/Bouchaud principle: an excessive drawdown should
 * trigger a downward REVISION of the assumed Sharpe, and you cut when the
 * revised figure no longer earns the allocation.
 */
import { describe, it, expect } from 'vitest';
import { reviseSharpe, medianMaxDrawdown } from '../../src/lib/bot/sharpe-revision';

// The deployed book's frozen parameters: 12% vol target, assumed Sharpe 2.
const BOOK = { assumedSharpe: 2, annualizedVol: 0.12 };

describe('reviseSharpe', () => {
  it('computes the cut-off depths BEFORE any trading — the whole point', () => {
    const r = reviseSharpe({ drawdown: 0, ...BOOK });
    // exp(-2*D*S/sigma) = 0.05  =>  D = sigma*ln(20)/(2S)
    expect(r.rejectAtDrawdown).toBeCloseTo(0.0899, 4);
    // The revised ceiling falls to the 0.5 allocation floor here.
    expect(r.cutAtDrawdown).toBeCloseTo(0.3595, 4);
    // Deeper cut than reject, always — otherwise the bands invert.
    expect(r.cutAtDrawdown).toBeGreaterThan(r.rejectAtDrawdown);
  });

  it('treats an ordinary drawdown as consistent with the assumed Sharpe', () => {
    const r = reviseSharpe({ drawdown: 0.02, ...BOOK });
    expect(r.verdict).toBe('consistent');
    expect(r.pValue).toBeGreaterThan(0.05);
  });

  it('rejects the assumed Sharpe once the drawdown passes the pre-computed depth', () => {
    const r = reviseSharpe({ drawdown: 0.12, ...BOOK });
    expect(r.verdict).toBe('revise');
    expect(r.pValue).toBeLessThan(0.05);
    // You may no longer claim Sharpe 2 — only what the drawdown still supports.
    expect(r.impliedSharpe!).toBeLessThan(2);
    expect(r.impliedSharpe!).toBeCloseTo(1.498, 3);
  });

  it('cuts when the revised Sharpe no longer earns its allocation', () => {
    const r = reviseSharpe({ drawdown: 0.40, ...BOOK });
    expect(r.verdict).toBe('cut');
    expect(r.impliedSharpe!).toBeLessThan(0.5);
  });

  it('is exactly at the boundary where the ceiling equals the assumed Sharpe', () => {
    const r = reviseSharpe({ drawdown: 0.0899, ...BOOK });
    expect(r.impliedSharpe!).toBeCloseTo(2, 2);
  });

  it('reports no implied Sharpe when there is no drawdown to infer from', () => {
    const r = reviseSharpe({ drawdown: 0, ...BOOK });
    expect(r.impliedSharpe).toBeNull();
    expect(r.verdict).toBe('consistent');
  });

  it('fires far earlier than a catastrophe stop — that is the point', () => {
    // The book's existing hard-kill sits at ~29% and its de-risk band at ~19%.
    // An evidence-based revision must act well before either.
    expect(reviseSharpe({ drawdown: 0, ...BOOK }).rejectAtDrawdown).toBeLessThan(0.19);
  });

  it('scales with vol — a higher-vol book earns a deeper allowance', () => {
    const tight = reviseSharpe({ drawdown: 0, assumedSharpe: 2, annualizedVol: 0.06 });
    const loose = reviseSharpe({ drawdown: 0, assumedSharpe: 2, annualizedVol: 0.24 });
    expect(loose.rejectAtDrawdown).toBeCloseTo(tight.rejectAtDrawdown * 4, 4);
  });

  it('demands more of a higher-Sharpe claim', () => {
    // Claiming Sharpe 3 means a shallower drawdown already refutes you.
    const s2 = reviseSharpe({ drawdown: 0, assumedSharpe: 2, annualizedVol: 0.12 });
    const s3 = reviseSharpe({ drawdown: 0, assumedSharpe: 3, annualizedVol: 0.12 });
    expect(s3.rejectAtDrawdown).toBeLessThan(s2.rejectAtDrawdown);
  });

  it('never acts on nonsensical inputs — fails safe, never auto-cuts', () => {
    for (const bad of [
      { drawdown: 0.5, assumedSharpe: 0, annualizedVol: 0.12 },
      { drawdown: 0.5, assumedSharpe: 2, annualizedVol: 0 },
      { drawdown: Number.NaN, assumedSharpe: 2, annualizedVol: 0.12 },
    ]) {
      const r = reviseSharpe(bad);
      expect(r.verdict, JSON.stringify(bad)).toBe('consistent');
      expect(r.pValue).toBe(1);
    }
  });
});

describe('medianMaxDrawdown', () => {
  it('states the drawdown a healthy book should typically see', () => {
    // sigma*ln2/(2S) — a Sharpe-2, 12%-vol book typically tops out near 2%.
    expect(medianMaxDrawdown(2, 0.12)).toBeCloseTo(0.0208, 4);
  });

  it('grows as the claimed Sharpe falls', () => {
    expect(medianMaxDrawdown(0.66, 0.12)).toBeGreaterThan(medianMaxDrawdown(2, 0.12));
  });
});
