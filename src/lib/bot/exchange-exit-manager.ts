/**
 * Exchange-Native Protective Exits
 *
 * Places our stop-loss / take-profit as a position-attached reduce-only stop on
 * Bybit (V5 `setTradingStop`, one-way mode, positionIdx 0). The point is crash
 * safety: once armed, the stop lives on the exchange and fires even if this
 * process dies. Gated behind `ExchangeExitConfig.enabled` (default false) so
 * paper mode and the backtest are unaffected.
 *
 * Every method is fail-safe — it never throws into the tick loop; it returns
 * `{ ok, reason }` and lets the caller decide (the caller's safety rule: if a
 * live position can't be protected, flatten it).
 */
import { BYBIT_CATEGORY } from './config';

/** Structural slice of RestClientV5 we depend on (lets tests inject a mock). */
export interface ExchangeExitClient {
  setTradingStop(params: {
    category: 'linear';
    symbol: string;
    positionIdx: 0 | 1 | 2;
    tpslMode?: 'Full' | 'Partial';
    stopLoss?: string;
    takeProfit?: string;
    slTriggerBy?: string;
    tpTriggerBy?: string;
  }): Promise<{ retCode: number; retMsg: string }>;
  submitOrder(params: {
    category: 'linear';
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Market';
    qty: string;
    reduceOnly: boolean;
    orderLinkId?: string;
  }): Promise<{ retCode: number; retMsg: string; result?: { orderId?: string } }>;
  getPositionInfo(params: { category: 'linear'; symbol: string }): Promise<{
    retCode: number;
    retMsg: string;
    result: { list: Array<{ size: string; side: string; avgPrice: string }> };
  }>;
}

export interface ExchangeExitConfig {
  /** Master gate — false in paper/backtest. */
  enabled: boolean;
  /** Trigger reference for SL/TP. MarkPrice avoids wick-hunt liquidations. */
  triggerBy: 'LastPrice' | 'MarkPrice' | 'IndexPrice';
}

export const DEFAULT_EXCHANGE_EXIT_CONFIG: ExchangeExitConfig = {
  enabled: false,
  triggerBy: 'MarkPrice',
};

export interface ExitOpResult {
  ok: boolean;
  reason?: string;
}

export class ExchangeExitManager {
  constructor(
    private readonly client: ExchangeExitClient,
    private readonly config: ExchangeExitConfig,
  ) {}

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Arm (or replace) the position-attached SL + final TP. Bybit treats a repeat
   * call as a replace, so this doubles as the breakeven-move amend.
   */
  async armExits(symbol: string, stopLoss: number, takeProfit: number): Promise<ExitOpResult> {
    try {
      const resp = await this.client.setTradingStop({
        category: BYBIT_CATEGORY,
        symbol,
        positionIdx: 0,
        tpslMode: 'Full',
        stopLoss: stopLoss.toString(),
        takeProfit: takeProfit.toString(),
        slTriggerBy: this.config.triggerBy,
        tpTriggerBy: this.config.triggerBy,
      });
      if (resp.retCode !== 0) {
        return { ok: false, reason: `setTradingStop retCode=${resp.retCode}: ${resp.retMsg}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
