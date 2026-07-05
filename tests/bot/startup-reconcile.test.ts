import { describe, it, expect } from 'vitest';
import {
  decideStartupReconcile,
  reconcileSeverity,
  type StartupReconcileInput,
} from '../../src/lib/bot/startup-reconcile';

/** Minimal shadow-position stub — only the fields the reconciler reads. */
function shadow(overrides: Partial<StartupReconcileInput['shadow']> = {}): StartupReconcileInput['shadow'] {
  return {
    symbol: 'BTCUSDT',
    direction: 'long',
    positionSizeUSDT: 1000,
    entryPrice: 50000,
    ...overrides,
  };
}

describe('decideStartupReconcile — state classification', () => {
  it('IN_SYNC when both DB and exchange are flat', () => {
    const d = decideStartupReconcile({ shadow: null, exchange: { size: 0, avgPrice: 0 } });
    expect(d.state).toBe('IN_SYNC');
    expect(d.action).toBe('none');
  });

  it('IN_SYNC when DB holds a position and exchange confirms a matching-side size', () => {
    const d = decideStartupReconcile({
      shadow: shadow({ positionSizeUSDT: 1000, entryPrice: 50000 }),
      exchange: { size: 0.02, avgPrice: 50000 }, // 0.02 BTC ≈ $1000 notional
    });
    expect(d.state).toBe('IN_SYNC');
    expect(d.action).toBe('none');
  });

  it('DB_GHOST when DB holds a position but exchange is CONFIRMED flat', () => {
    const d = decideStartupReconcile({
      shadow: shadow(),
      exchange: { size: 0, avgPrice: 0 },
    });
    expect(d.state).toBe('DB_GHOST');
    // Recoverable: the venue closed it (SL/TP/manual) while the bot was down —
    // book the missed exit, do not touch the exchange.
    expect(d.action).toBe('close_shadow');
  });

  it('EXCHANGE_ORPHAN when DB is flat but exchange holds a live position', () => {
    const d = decideStartupReconcile({
      shadow: null,
      exchange: { size: 0.5, avgPrice: 50000 },
    });
    expect(d.state).toBe('EXCHANGE_ORPHAN');
    // Dangerous: an unmanaged live position with unknown stops. Never auto-open
    // or silently adopt — halt new entries and require operator review.
    expect(d.action).toBe('halt_and_alert');
  });

  it('SIZE_MISMATCH when both hold but notionals diverge beyond tolerance', () => {
    const d = decideStartupReconcile({
      shadow: shadow({ positionSizeUSDT: 1000, entryPrice: 50000 }), // expects ~0.02 BTC
      exchange: { size: 0.20, avgPrice: 50000 }, // 10x the expected size
    });
    expect(d.state).toBe('SIZE_MISMATCH');
    expect(d.action).toBe('halt_and_alert');
  });

  it('tolerates small size drift (fees/rounding) as IN_SYNC', () => {
    const d = decideStartupReconcile({
      shadow: shadow({ positionSizeUSDT: 1000, entryPrice: 50000 }), // expects 0.02 BTC
      exchange: { size: 0.0201, avgPrice: 50000 }, // 0.5% over — within tolerance
    });
    expect(d.state).toBe('IN_SYNC');
  });

  it('UNKNOWN when exchange state cannot be confirmed (null) and DB holds — keep managing', () => {
    const d = decideStartupReconcile({ shadow: shadow(), exchange: null });
    expect(d.state).toBe('UNKNOWN');
    // Fail closed: do NOT close the shadow on an unconfirmed flat; keep managing it.
    expect(d.action).toBe('keep_managing');
  });

  it('UNKNOWN when exchange state cannot be confirmed (null) and DB flat — alert only', () => {
    const d = decideStartupReconcile({ shadow: null, exchange: null });
    expect(d.state).toBe('UNKNOWN');
    expect(d.action).toBe('alert');
  });

  it('includes a human-readable reason for every non-sync state', () => {
    expect(decideStartupReconcile({ shadow: shadow(), exchange: { size: 0, avgPrice: 0 } }).reason)
      .toMatch(/ghost|venue|closed|flat/i);
    expect(decideStartupReconcile({ shadow: null, exchange: { size: 0.5, avgPrice: 50000 } }).reason)
      .toMatch(/orphan|unmanaged|unknown/i);
  });
});

describe('reconcileSeverity — operator triage', () => {
  it('IN_SYNC is info, DB_GHOST is warn, ORPHAN/MISMATCH/UNKNOWN are critical', () => {
    expect(reconcileSeverity('IN_SYNC')).toBe('info');
    expect(reconcileSeverity('DB_GHOST')).toBe('warn');
    expect(reconcileSeverity('EXCHANGE_ORPHAN')).toBe('critical');
    expect(reconcileSeverity('SIZE_MISMATCH')).toBe('critical');
    expect(reconcileSeverity('UNKNOWN')).toBe('critical');
  });
});

describe('decideStartupReconcile — guards', () => {
  it('treats a zero/invalid entryPrice as UNKNOWN rather than dividing by zero', () => {
    const d = decideStartupReconcile({
      shadow: shadow({ entryPrice: 0 }),
      exchange: { size: 0.02, avgPrice: 50000 },
    });
    // Cannot compute expected base size → cannot verify → fail closed.
    expect(d.state).toBe('UNKNOWN');
    expect(d.action).toBe('keep_managing');
  });
});
