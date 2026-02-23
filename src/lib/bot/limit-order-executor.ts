/**
 * Limit Order Executor — Post-Only Limit Orders on Bybit
 *
 * Places post-only limit orders at candle close price instead of simulating
 * market fills. Saves ~0.035% per side (maker 0.02% vs taker 0.055%).
 *
 * Lifecycle:
 * 1. Signal detected → place post-only limit at close price
 * 2. Each tick → check if order is filled
 * 3. If filled → create position as normal
 * 4. If not filled after maxWaitBars → cancel and skip trade
 *
 * Requires BYBIT_API_KEY and BYBIT_API_SECRET env vars for authenticated endpoints.
 */

import { RestClientV5 } from 'bybit-api';
import type { BotSymbol } from '@/types/bot';
import type { ScoredSignal } from '@/lib/rl/strategies/confluence-scorer';
import { BYBIT_CATEGORY } from './config';

export interface PendingLimitOrder {
  /** Bybit order ID */
  orderId: string;
  /** Client-generated order link ID */
  orderLinkId: string;
  /** Symbol */
  symbol: BotSymbol;
  /** Direction */
  side: 'Buy' | 'Sell';
  /** Limit price */
  price: number;
  /** Order quantity */
  qty: string;
  /** The original signal that triggered this order */
  signal: ScoredSignal;
  /** Regime at time of signal */
  regime: string;
  /** Bar index when order was placed */
  placedAtBarIndex: number;
  /** Timestamp when order was placed */
  placedAt: number;
  /** Risk per trade used for this order */
  riskPerTrade: number;
}

export interface LimitOrderConfig {
  /** Max candles to wait for fill before cancelling (default 2) */
  maxWaitBars: number;
  /** Use post-only flag (default true) */
  postOnly: boolean;
  /** Whether limit orders are enabled (default false — paper mode) */
  enabled: boolean;
}

export const DEFAULT_LIMIT_ORDER_CONFIG: LimitOrderConfig = {
  maxWaitBars: 2,
  postOnly: true,
  enabled: false,
};

export class LimitOrderExecutor {
  private client: RestClientV5;
  private config: LimitOrderConfig;
  private pendingOrders: Map<BotSymbol, PendingLimitOrder> = new Map();

  constructor(
    apiKey: string,
    apiSecret: string,
    config: LimitOrderConfig = DEFAULT_LIMIT_ORDER_CONFIG,
    testnet = false,
  ) {
    this.client = new RestClientV5({
      key: apiKey,
      secret: apiSecret,
      testnet,
    });
    this.config = config;
  }

  /**
   * Place a post-only limit order for a signal.
   *
   * @returns The pending order, or null if placement failed
   */
  async placeOrder(
    signal: ScoredSignal,
    symbol: BotSymbol,
    qty: string,
    limitPrice: number,
    regime: string,
    barIndex: number,
    riskPerTrade: number,
  ): Promise<PendingLimitOrder | null> {
    const side = signal.signal.direction === 'long' ? 'Buy' : 'Sell';
    const orderLinkId = `ict_${symbol}_${Date.now()}`;

    try {
      const response = await this.client.submitOrder({
        category: BYBIT_CATEGORY,
        symbol,
        side,
        orderType: 'Limit',
        qty,
        price: limitPrice.toString(),
        timeInForce: this.config.postOnly ? 'PostOnly' : 'GTC',
        orderLinkId,
        reduceOnly: false,
      });

      if (response.retCode !== 0) {
        console.error(`Limit order failed for ${symbol}: ${response.retMsg}`);
        return null;
      }

      const pending: PendingLimitOrder = {
        orderId: response.result.orderId,
        orderLinkId,
        symbol,
        side,
        price: limitPrice,
        qty,
        signal,
        regime,
        placedAtBarIndex: barIndex,
        placedAt: Date.now(),
        riskPerTrade,
      };

      this.pendingOrders.set(symbol, pending);
      return pending;
    } catch (err) {
      console.error(`Limit order placement error for ${symbol}:`, err);
      return null;
    }
  }

  /**
   * Check status of a pending limit order.
   *
   * @returns 'filled' | 'pending' | 'expired' (cancelled due to max wait)
   */
  async checkOrder(
    symbol: BotSymbol,
    currentBarIndex: number,
  ): Promise<{ status: 'filled' | 'pending' | 'expired'; order: PendingLimitOrder; fillPrice?: number }> {
    const pending = this.pendingOrders.get(symbol);
    if (!pending) {
      throw new Error(`No pending order for ${symbol}`);
    }

    // Check if order has been waiting too long
    const barsWaited = currentBarIndex - pending.placedAtBarIndex;
    if (barsWaited >= this.config.maxWaitBars) {
      // Cancel the order
      await this.cancelOrder(symbol);
      this.pendingOrders.delete(symbol);
      return { status: 'expired', order: pending };
    }

    // Query order status from Bybit
    try {
      const response = await this.client.getActiveOrders({
        category: BYBIT_CATEGORY,
        symbol,
        orderLinkId: pending.orderLinkId,
      });

      if (response.retCode !== 0) {
        console.error(`Order status check failed for ${symbol}: ${response.retMsg}`);
        return { status: 'pending', order: pending };
      }

      const orders = response.result.list;
      if (!orders || orders.length === 0) {
        // Order not in active list — might be filled or cancelled
        // Check order history
        const historyResponse = await this.client.getHistoricOrders({
          category: BYBIT_CATEGORY,
          symbol,
          orderLinkId: pending.orderLinkId,
          limit: 1,
        });

        if (historyResponse.retCode === 0 && historyResponse.result.list.length > 0) {
          const order = historyResponse.result.list[0]!;
          if (order.orderStatus === 'Filled') {
            this.pendingOrders.delete(symbol);
            return {
              status: 'filled',
              order: pending,
              fillPrice: parseFloat(order.avgPrice),
            };
          }
        }

        // If not found in history either, treat as expired
        this.pendingOrders.delete(symbol);
        return { status: 'expired', order: pending };
      }

      const activeOrder = orders[0]!;
      if (activeOrder.orderStatus === 'Filled') {
        this.pendingOrders.delete(symbol);
        return {
          status: 'filled',
          order: pending,
          fillPrice: parseFloat(activeOrder.avgPrice),
        };
      }

      return { status: 'pending', order: pending };
    } catch (err) {
      console.error(`Order status check error for ${symbol}:`, err);
      return { status: 'pending', order: pending };
    }
  }

  /**
   * Cancel a pending order for a symbol.
   */
  async cancelOrder(symbol: BotSymbol): Promise<boolean> {
    const pending = this.pendingOrders.get(symbol);
    if (!pending) return false;

    try {
      const response = await this.client.cancelOrder({
        category: BYBIT_CATEGORY,
        symbol,
        orderLinkId: pending.orderLinkId,
      });

      if (response.retCode !== 0) {
        console.error(`Cancel order failed for ${symbol}: ${response.retMsg}`);
        return false;
      }

      this.pendingOrders.delete(symbol);
      return true;
    } catch (err) {
      console.error(`Cancel order error for ${symbol}:`, err);
      return false;
    }
  }

  /**
   * Cancel all pending orders (e.g., on shutdown).
   */
  async cancelAll(): Promise<void> {
    for (const symbol of this.pendingOrders.keys()) {
      await this.cancelOrder(symbol);
    }
  }

  /** Check if there's a pending order for a symbol */
  hasPendingOrder(symbol: BotSymbol): boolean {
    return this.pendingOrders.has(symbol);
  }

  /** Get all pending orders */
  getPendingOrders(): PendingLimitOrder[] {
    return Array.from(this.pendingOrders.values());
  }

  /** Whether limit order execution is enabled */
  get isEnabled(): boolean {
    return this.config.enabled;
  }
}
