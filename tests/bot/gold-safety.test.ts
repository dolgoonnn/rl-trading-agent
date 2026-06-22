import { describe, it, expect } from 'vitest';
import { goldEntryAllowed, GOLD_MAX_DRAWDOWN } from '@/lib/gold/paper-sleeve';

/**
 * PURE safety-gate tests for the gold F2F paper sleeve (pre-emptive hardening).
 *
 * `goldEntryAllowed` is the reduce-only NEW-ENTRY gate the gold bot consults
 * before OPENING a position. It blocks new entries when EITHER:
 *   - the SHARED global kill switch is tripped (halted=true), OR
 *   - the sleeve's own peak-drawdown breaches GOLD_MAX_DRAWDOWN.
 *
 * It is deliberately PURE — `halted`/`equity`/`peakEquity` are injected — so the
 * whole gate is testable with no DB, no fs sentinel, and no running daemon. The
 * gate NEVER closes a position; an open position is always managed by the exit
 * path regardless of what this returns.
 */

describe('goldEntryAllowed — pure reduce-only new-entry gate', () => {
  const peakEquity = 10_000;

  it('blocks new entries when the global kill switch is halted (reason mentions kill)', () => {
    // Even at peak equity (zero drawdown), a tripped kill flag blocks entries.
    const gate = goldEntryAllowed({
      halted: true,
      equity: peakEquity,
      peakEquity,
      maxDrawdown: GOLD_MAX_DRAWDOWN,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason?.toLowerCase()).toContain('kill');
  });

  it('allows entries when equity is exactly at peak (zero drawdown, not halted)', () => {
    const gate = goldEntryAllowed({
      halted: false,
      equity: peakEquity,
      peakEquity,
      maxDrawdown: GOLD_MAX_DRAWDOWN,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeUndefined();
  });

  it('blocks new entries when drawdown >= maxDrawdown (reason mentions drawdown)', () => {
    // 30% drawdown vs a 25% limit ⇒ blocked.
    const gate = goldEntryAllowed({
      halted: false,
      equity: peakEquity * 0.70, // 30% drawdown
      peakEquity,
      maxDrawdown: GOLD_MAX_DRAWDOWN,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason?.toLowerCase()).toContain('drawdown');
  });

  it('allows new entries when drawdown < maxDrawdown', () => {
    // 10% drawdown vs a 25% limit ⇒ allowed.
    const gate = goldEntryAllowed({
      halted: false,
      equity: peakEquity * 0.90, // 10% drawdown
      peakEquity,
      maxDrawdown: GOLD_MAX_DRAWDOWN,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeUndefined();
  });

  it('blocks at EXACTLY maxDrawdown (boundary is inclusive: >= halts)', () => {
    // Drawdown == limit ⇒ blocked (>= semantics).
    const maxDrawdown = 0.25;
    const gate = goldEntryAllowed({
      halted: false,
      equity: peakEquity * (1 - maxDrawdown), // exactly 25% drawdown
      peakEquity,
      maxDrawdown,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason?.toLowerCase()).toContain('drawdown');
  });

  it('allows just below the boundary (drawdown a hair under maxDrawdown)', () => {
    const maxDrawdown = 0.25;
    const gate = goldEntryAllowed({
      halted: false,
      equity: peakEquity * (1 - maxDrawdown) + 1, // a hair above the breach price
      peakEquity,
      maxDrawdown,
    });
    expect(gate.allowed).toBe(true);
  });

  it('the halt check takes precedence over drawdown (reason mentions kill, not drawdown)', () => {
    // Both conditions trip; the kill reason wins so operators see the global stop.
    const gate = goldEntryAllowed({
      halted: true,
      equity: peakEquity * 0.50, // also a 50% drawdown
      peakEquity,
      maxDrawdown: GOLD_MAX_DRAWDOWN,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason?.toLowerCase()).toContain('kill');
  });

  it('GOLD_MAX_DRAWDOWN defaults to 25%', () => {
    expect(GOLD_MAX_DRAWDOWN).toBe(0.25);
  });
});
