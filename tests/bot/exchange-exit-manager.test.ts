import { describe, it, expect, vi } from 'vitest';
import {
  ExchangeExitManager,
  closeSideFor,
  decideExchangeReconcile,
  roundQtyToStep,
  computePartialReduceQty,
  selectFlattenQty,
  type ExchangeExitClient,
} from '@/lib/bot/exchange-exit-manager';

function mockClient(overrides: Partial<ExchangeExitClient> = {}): ExchangeExitClient {
  return {
    setTradingStop: vi.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK' }),
    submitOrder: vi.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK', result: { orderId: 'x' } }),
    getPositionInfo: vi.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK', result: { list: [] } }),
    getClosedPnL: vi.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK', result: { list: [] } }),
    ...overrides,
  };
}

describe('ExchangeExitManager.armExits', () => {
  it('sends SL+TP as a Full-mode position stop with the configured trigger', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });

    const res = await mgr.armExits('BTCUSDT', 60000, 65000);

    expect(res.ok).toBe(true);
    expect(client.setTradingStop).toHaveBeenCalledWith({
      category: 'linear',
      symbol: 'BTCUSDT',
      positionIdx: 0,
      tpslMode: 'Full',
      stopLoss: '60000',
      takeProfit: '65000',
      slTriggerBy: 'MarkPrice',
      tpTriggerBy: 'MarkPrice',
    });
  });

  it('returns ok:false with the Bybit retMsg on a non-zero retCode (does not throw)', async () => {
    const client = mockClient({
      setTradingStop: vi.fn().mockResolvedValue({ retCode: 10001, retMsg: 'params error' }),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });

    const res = await mgr.armExits('BTCUSDT', 60000, 65000);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('params error');
  });

  it('returns ok:false when the client throws (network) without propagating', async () => {
    const client = mockClient({
      setTradingStop: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });

    const res = await mgr.armExits('BTCUSDT', 60000, 65000);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('ETIMEDOUT');
  });

  it('is a no-op when disabled — never touches the exchange', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: false, triggerBy: 'MarkPrice' });

    const res = await mgr.armExits('BTCUSDT', 60000, 65000);

    expect(res.ok).toBe(true);
    expect(client.setTradingStop).not.toHaveBeenCalled();
  });
});

describe('ExchangeExitManager.clearExits', () => {
  it('sends "0" for both SL and TP to remove the position stop', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const res = await mgr.clearExits('BTCUSDT');
    expect(res.ok).toBe(true);
    expect(client.setTradingStop).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT', positionIdx: 0, tpslMode: 'Full', stopLoss: '0', takeProfit: '0',
      }),
    );
  });

  it('returns ok:false when the exchange rejects with a non-zero retCode', async () => {
    const client = mockClient({
      setTradingStop: vi.fn().mockResolvedValue({ retCode: 110001, retMsg: 'order not found' }),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const res = await mgr.clearExits('BTCUSDT');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('110001');
  });

  it('is a no-op when disabled — never touches the exchange', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: false, triggerBy: 'MarkPrice' });
    const res = await mgr.clearExits('BTCUSDT');
    expect(res.ok).toBe(true);
    expect(client.setTradingStop).not.toHaveBeenCalled();
  });
});

describe('ExchangeExitManager.marketClose', () => {
  it('flattens with a reduce-only market order on the closing side', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const res = await mgr.marketClose('BTCUSDT', 'Sell', '0.01');
    expect(res.ok).toBe(true);
    expect(client.submitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'linear', symbol: 'BTCUSDT', side: 'Sell',
        orderType: 'Market', qty: '0.01', reduceOnly: true,
      }),
    );
  });

  it('returns ok:false when the exchange rejects with a non-zero retCode', async () => {
    const client = mockClient({
      submitOrder: vi.fn().mockResolvedValue({ retCode: 110017, retMsg: 'reduce-only rejected' }),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const res = await mgr.marketClose('BTCUSDT', 'Sell', '0.01');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('110017');
  });

  it('is a no-op when disabled — never touches the exchange', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: false, triggerBy: 'MarkPrice' });
    const res = await mgr.marketClose('BTCUSDT', 'Sell', '0.01');
    expect(res.ok).toBe(true);
    expect(client.submitOrder).not.toHaveBeenCalled();
  });
});

describe('ExchangeExitManager.getOpenSize', () => {
  it('parses the live position size and avgPrice', async () => {
    const client = mockClient({
      getPositionInfo: vi.fn().mockResolvedValue({
        retCode: 0, retMsg: 'OK',
        result: { list: [{ size: '0.012', side: 'Buy', avgPrice: '60100' }] },
      }),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const r = await mgr.getOpenSize('BTCUSDT');
    expect(r).not.toBeNull();
    expect(r!.size).toBeCloseTo(0.012);
    expect(r!.avgPrice).toBeCloseTo(60100);
  });

  it('reports size 0 (CONFIRMED flat) when the venue has no open position', async () => {
    const client = mockClient(); // getPositionInfo returns list: []
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const r = await mgr.getOpenSize('BTCUSDT');
    expect(r).toEqual({ size: 0, avgPrice: 0 });
  });

  it('returns null (UNKNOWN, not flat) on a non-zero retCode', async () => {
    const client = mockClient({
      getPositionInfo: vi.fn().mockResolvedValue({ retCode: 10001, retMsg: 'err', result: { list: [] } }),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    expect(await mgr.getOpenSize('BTCUSDT')).toBeNull();
  });

  it('returns null (UNKNOWN, not flat) on a network throw', async () => {
    const client = mockClient({
      getPositionInfo: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    expect(await mgr.getOpenSize('BTCUSDT')).toBeNull();
  });

  it('is a no-op when disabled — never touches the exchange, returns confirmed-flat', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: false, triggerBy: 'MarkPrice' });
    const r = await mgr.getOpenSize('BTCUSDT');
    expect(r).toEqual({ size: 0, avgPrice: 0 });
    expect(client.getPositionInfo).not.toHaveBeenCalled();
  });
});

describe('closeSideFor', () => {
  it('closes a long with a Sell and a short with a Buy', () => {
    expect(closeSideFor('long')).toBe('Sell');
    expect(closeSideFor('short')).toBe('Buy');
  });
});

describe('ExchangeExitManager.getRealizedClose', () => {
  it('returns the most-recent realized exit price and pnl', async () => {
    const client = mockClient({
      getClosedPnL: vi.fn().mockResolvedValue({
        retCode: 0, retMsg: 'OK',
        result: { list: [{ avgExitPrice: '64250.5', closedPnl: '12.3', side: 'Sell', qty: '0.01', updatedTime: '1' }] },
      }),
    });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const r = await mgr.getRealizedClose('BTCUSDT');
    expect(r).not.toBeNull();
    expect(r!.exitPrice).toBeCloseTo(64250.5);
    expect(r!.closedPnl).toBeCloseTo(12.3);
    expect(r!.closedAtMs).toBe(1);
  });

  it('returns null when the closed-PnL list is empty', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    expect(await mgr.getRealizedClose('BTCUSDT')).toBeNull();
  });

  it('returns null when disabled — never touches the exchange', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: false, triggerBy: 'MarkPrice' });
    expect(await mgr.getRealizedClose('BTCUSDT')).toBeNull();
    expect(client.getClosedPnL).not.toHaveBeenCalled();
  });

  it('returns null and does not throw on a client error', async () => {
    const client = mockClient({ getClosedPnL: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) });
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    expect(await mgr.getRealizedClose('BTCUSDT')).toBeNull();
  });
});

describe('decideExchangeReconcile', () => {
  const base = { entryTimestamp: 1000, takeProfit: 65000, currentSL: 60000 };

  it('does NOT reconcile when the venue still shows an open size', () => {
    const realized = { exitPrice: 64000, closedAtMs: 2000 }; // fresh, but still open
    expect(decideExchangeReconcile({ openSize: 0.01, realized, ...base })).toBeNull();
  });

  it('does NOT reconcile when flat but there is no close record (transient API error)', () => {
    expect(decideExchangeReconcile({ openSize: 0, realized: null, ...base })).toBeNull();
  });

  it('does NOT reconcile when the close record pre-dates entry (stale prior trade)', () => {
    const realized = { exitPrice: 64000, closedAtMs: base.entryTimestamp - 1 };
    expect(decideExchangeReconcile({ openSize: 0, realized, ...base })).toBeNull();
  });

  it('does NOT reconcile when closedAtMs equals entryTimestamp (<= boundary)', () => {
    const realized = { exitPrice: 64000, closedAtMs: base.entryTimestamp };
    expect(decideExchangeReconcile({ openSize: 0, realized, ...base })).toBeNull();
  });

  it('reconciles when flat AND the close record post-dates entry', () => {
    const realized = { exitPrice: 64900, closedAtMs: base.entryTimestamp + 1 };
    const d = decideExchangeReconcile({ openSize: 0, realized, ...base });
    expect(d).not.toBeNull();
    expect(d!.exitPrice).toBe(64900);
    expect(d!.reason).toBe('take_profit'); // 64900 nearer 65000 TP than 60000 SL
  });

  it('infers stop_loss when the exit price is nearer the SL', () => {
    const realized = { exitPrice: 60100, closedAtMs: base.entryTimestamp + 1 };
    const d = decideExchangeReconcile({ openSize: 0, realized, ...base });
    expect(d!.reason).toBe('stop_loss');
  });
});

describe('roundQtyToStep', () => {
  it('rounds DOWN to the symbol qtyStep (never over-close)', () => {
    expect(roundQtyToStep(0.75, 'SOLUSDT')).toBe(0.7);   // step 0.1
    expect(roundQtyToStep(0.0615, 'BTCUSDT')).toBe(0.061); // step 0.001
    expect(roundQtyToStep(0.137, 'ETHUSDT')).toBe(0.13);  // step 0.01
  });
  it('uses the default step (0.001) for an unknown symbol', () => {
    expect(roundQtyToStep(1.23456, 'WHATEVERUSDT')).toBe(1.234);
  });
  it('returns 0 for non-positive or non-finite qty', () => {
    expect(roundQtyToStep(0, 'BTCUSDT')).toBe(0);
    expect(roundQtyToStep(-1, 'BTCUSDT')).toBe(0);
    expect(roundQtyToStep(NaN, 'BTCUSDT')).toBe(0);
  });
  it('keeps a clean decimal string (no float artifacts)', () => {
    expect(roundQtyToStep(0.012, 'ETHUSDT').toString()).toBe('0.01'); // step 0.01
    expect(roundQtyToStep(0.006000000000000001, 'BTCUSDT').toString()).toBe('0.006');
  });
});

describe('computePartialReduceQty', () => {
  it('returns size*fraction rounded DOWN to step, as a clean string', () => {
    expect(computePartialReduceQty(0.1, 0.5, 'BTCUSDT')).toBe('0.05');
    expect(computePartialReduceQty(1.5, 0.5, 'SOLUSDT')).toBe('0.7'); // 0.75 → step 0.1 → 0.7
    expect(computePartialReduceQty(0.123, 0.5, 'BTCUSDT')).toBe('0.061'); // 0.0615 → 0.061
  });
  it('returns null when fraction is out of (0,1)', () => {
    expect(computePartialReduceQty(0.1, 0, 'BTCUSDT')).toBeNull();
    expect(computePartialReduceQty(0.1, 1, 'BTCUSDT')).toBeNull();
    expect(computePartialReduceQty(0.1, 1.5, 'BTCUSDT')).toBeNull();
  });
  it('returns null when liveSize is non-positive', () => {
    expect(computePartialReduceQty(0, 0.5, 'BTCUSDT')).toBeNull();
  });
  it('returns null when the rounded qty is below one step', () => {
    expect(computePartialReduceQty(0.001, 0.5, 'BTCUSDT')).toBeNull(); // 0.0005 < step 0.001
  });
});

describe('selectFlattenQty', () => {
  it('uses the venue-reported live size when known and > 0', () => {
    expect(selectFlattenQty(0.012, 999, 60000, 'BTCUSDT')).toBe('0.012');
  });
  it('returns null when the venue is confirmed flat (size 0)', () => {
    expect(selectFlattenQty(0, 999, 60000, 'BTCUSDT')).toBeNull();
  });
  it('falls back to a step-rounded notional estimate when size is UNKNOWN (null)', () => {
    // 600 / 60000 = 0.01 → step 0.001 → '0.01'
    expect(selectFlattenQty(null, 600, 60000, 'BTCUSDT')).toBe('0.01');
  });
  it('returns null when unknown and no usable fill price', () => {
    expect(selectFlattenQty(null, 600, 0, 'BTCUSDT')).toBeNull();
  });
});
