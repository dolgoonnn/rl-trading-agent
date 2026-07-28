import { describe, it, expect } from 'vitest';
import { formatUsd, formatPnlPct, sleeveStatusLabel } from '../../src/lib/bot/format';

describe('format helpers', () => {
  it('formats USD and signed pnl%', () => {
    expect(formatUsd(10050)).toBe('$10,050.00');
    expect(formatPnlPct(2)).toBe('+2.00%');
    expect(formatPnlPct(-0.5)).toBe('-0.50%');
  });
  it('labels sleeve status', () => {
    expect(sleeveStatusLabel({ closedTrades: 0, openPositions: 0 })).toBe('flat');
    expect(sleeveStatusLabel({ closedTrades: 0, openPositions: 1 })).toBe('in position');
    expect(sleeveStatusLabel({ closedTrades: 3, openPositions: 0 })).toBe('active');
  });
});
