import { describe, it, expect } from 'vitest';
import { resetWipeGuard } from '../../scripts/replay-bot';

/**
 * FIX-5: replay-bot's --fresh wipes bot_trades in the SHARED dev DB that the
 * forward paper bot writes to. The wipe must require explicit --confirm-wipe
 * when the table is non-empty, so a routine replay can't erase the forward
 * track record.
 */
describe('resetWipeGuard', () => {
  it('allows when --fresh not requested (no wipe at all)', () => {
    expect(resetWipeGuard(false, false, 432).allowed).toBe(true);
    expect(resetWipeGuard(false, true, 432).allowed).toBe(true);
  });

  it('allows --fresh on an EMPTY table (nothing to lose)', () => {
    expect(resetWipeGuard(true, false, 0).allowed).toBe(true);
  });

  it('BLOCKS --fresh on a NON-EMPTY table without --confirm-wipe', () => {
    const g = resetWipeGuard(true, false, 432);
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/432/);
    expect(g.reason).toMatch(/confirm-wipe/);
  });

  it('allows --fresh on a non-empty table WITH explicit --confirm-wipe', () => {
    expect(resetWipeGuard(true, true, 432).allowed).toBe(true);
  });
});
