import { describe, it, expect, vi } from 'vitest';
import {
  ExchangeExitManager,
  closeSideFor,
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
    expect(r.size).toBeCloseTo(0.012);
    expect(r.avgPrice).toBeCloseTo(60100);
  });

  it('reports size 0 when the venue has no open position', async () => {
    const client = mockClient(); // getPositionInfo returns list: []
    const mgr = new ExchangeExitManager(client, { enabled: true, triggerBy: 'MarkPrice' });
    const r = await mgr.getOpenSize('BTCUSDT');
    expect(r.size).toBe(0);
  });

  it('is a no-op when disabled — never touches the exchange, returns size 0', async () => {
    const client = mockClient();
    const mgr = new ExchangeExitManager(client, { enabled: false, triggerBy: 'MarkPrice' });
    const r = await mgr.getOpenSize('BTCUSDT');
    expect(r.size).toBe(0);
    expect(r.avgPrice).toBe(0);
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
