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
// NOTE: config.ts imports back from this module (DEFAULT_EXCHANGE_EXIT_CONFIG),
// so this is a circular import. It is safe ONLY because BYBIT_CATEGORY is read
// lazily inside method bodies (ES live binding), never at module-init time.
// Do not reference BYBIT_CATEGORY at top level here, or it will be undefined.
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
    slTriggerBy?: 'LastPrice' | 'IndexPrice' | 'MarkPrice';
    tpTriggerBy?: 'LastPrice' | 'IndexPrice' | 'MarkPrice';
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
  getClosedPnL(params: { category: 'linear'; symbol: string; limit?: number }): Promise<{
    retCode: number;
    retMsg: string;
    result: { list: Array<{ avgExitPrice: string; closedPnl: string; side: string; qty: string; updatedTime: string }> };
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

  /** Remove the position-attached SL/TP (Bybit clears with the string "0"). */
  async clearExits(symbol: string): Promise<ExitOpResult> {
    // Defense-in-depth: never touch the live exchange when disabled, even if a
    // caller forgets to gate on `isEnabled`. Paper/backtest has no real position.
    if (!this.config.enabled) return { ok: true };
    try {
      const resp = await this.client.setTradingStop({
        category: BYBIT_CATEGORY,
        symbol,
        positionIdx: 0,
        tpslMode: 'Full',
        stopLoss: '0',
        takeProfit: '0',
      });
      if (resp.retCode !== 0) {
        return { ok: false, reason: `clearExits retCode=${resp.retCode}: ${resp.retMsg}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Flatten the position with a reduce-only market order (time-exit/shutdown/kill). */
  async marketClose(symbol: string, closeSide: 'Buy' | 'Sell', qty: string): Promise<ExitOpResult> {
    // Defense-in-depth: never touch the live exchange when disabled, even if a
    // caller forgets to gate on `isEnabled`. Paper/backtest has no real position.
    if (!this.config.enabled) return { ok: true };
    try {
      const resp = await this.client.submitOrder({
        category: BYBIT_CATEGORY,
        symbol,
        side: closeSide,
        orderType: 'Market',
        qty,
        reduceOnly: true,
      });
      if (resp.retCode !== 0) {
        return { ok: false, reason: `marketClose retCode=${resp.retCode}: ${resp.retMsg}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Current real position size + avg entry (size 0 ⇒ flat). Never throws. */
  async getOpenSize(symbol: string): Promise<{ size: number; avgPrice: number }> {
    // Defense-in-depth: return zero immediately when disabled; paper has no real position.
    if (!this.config.enabled) return { size: 0, avgPrice: 0 };
    try {
      const resp = await this.client.getPositionInfo({ category: BYBIT_CATEGORY, symbol });
      const row = resp.retCode === 0 ? resp.result.list[0] : undefined;
      if (!row) return { size: 0, avgPrice: 0 };
      return { size: parseFloat(row.size) || 0, avgPrice: parseFloat(row.avgPrice) || 0 };
    } catch {
      return { size: 0, avgPrice: 0 };
    }
  }

  /**
   * Most-recent realized close for the symbol (real exchange exit price + pnl).
   * Used to reconcile the shadow book when the venue's SL/TP fired. Returns null
   * when disabled, on error, on an empty list, or on an unparseable price. Never throws.
   */
  async getRealizedClose(
    symbol: string,
  ): Promise<{ exitPrice: number; closedPnl: number; closedAtMs: number } | null> {
    if (!this.config.enabled) return null;
    try {
      const resp = await this.client.getClosedPnL({ category: BYBIT_CATEGORY, symbol, limit: 1 });
      const row = resp.retCode === 0 ? resp.result.list[0] : undefined;
      if (!row) return null;
      const exitPrice = parseFloat(row.avgExitPrice);
      if (!Number.isFinite(exitPrice) || exitPrice <= 0) return null;
      return {
        exitPrice,
        closedPnl: parseFloat(row.closedPnl) || 0,
        // Bybit returns updatedTime as a millisecond-epoch string. If that format
        // ever changed, this would parse to 0 / a too-small value → the reconcile
        // guard (closedAtMs > entryTimestamp) rejects it: a missed reconcile, never
        // a spurious close (fails safe).
        closedAtMs: parseInt(row.updatedTime, 10) || 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Arm (or replace) the position-attached SL + final TP. Bybit treats a repeat
   * call as a replace, so this doubles as the breakeven-move amend.
   */
  async armExits(symbol: string, stopLoss: number, takeProfit: number): Promise<ExitOpResult> {
    // Defense-in-depth: never touch the live exchange when disabled, even if a
    // caller forgets to gate on `isEnabled`. Paper/backtest has no real position.
    if (!this.config.enabled) return { ok: true };
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

/** The order side that flattens a position of the given direction. */
export function closeSideFor(direction: 'long' | 'short'): 'Buy' | 'Sell' {
  return direction === 'long' ? 'Sell' : 'Buy';
}

/**
 * Pure decision for per-tick exchange-close reconciliation. Returns the close to
 * book, or null to do nothing this tick. Kept pure (no I/O) so the safety-critical
 * guard is unit-testable.
 *
 * Reconcile ONLY when the venue is flat (`openSize === 0`) AND a realized close
 * record POST-DATES this position's entry. `getOpenSize` returns size 0 on a
 * transient API error too, so size 0 alone is not proof; in one-way mode an open
 * position cannot have a venue close newer than its own entry, so the timestamp
 * check rejects both the API-error case and a stale prior-trade record. `reason`
 * is inferred from proximity to TP vs SL (cosmetic — PnL books from exitPrice).
 */
export function decideExchangeReconcile(args: {
  openSize: number;
  realized: { exitPrice: number; closedAtMs: number } | null;
  entryTimestamp: number;
  takeProfit: number;
  currentSL: number;
}): { exitPrice: number; reason: 'take_profit' | 'stop_loss' } | null {
  if (args.openSize > 0) return null;
  if (!args.realized || args.realized.closedAtMs <= args.entryTimestamp) return null;
  const { exitPrice } = args.realized;
  const reason: 'take_profit' | 'stop_loss' =
    Math.abs(exitPrice - args.takeProfit) < Math.abs(exitPrice - args.currentSL)
      ? 'take_profit'
      : 'stop_loss';
  return { exitPrice, reason };
}
