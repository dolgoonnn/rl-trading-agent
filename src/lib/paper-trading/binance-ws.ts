/**
 * Binance WebSocket Client
 * Connects to Binance kline stream with reconnection and exponential backoff
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type {
  BinanceKlineMessage,
  BinanceWsConfig,
  BinanceWsEvents,
  LiveCandle,
  WsConnectionState,
} from './types';

const DEFAULT_CONFIG: Required<BinanceWsConfig> = {
  symbol: 'BTCUSDT',
  timeframe: '1h',
  baseUrl: 'wss://stream.binance.com:9443/ws',
  maxReconnectAttempts: 10,
  reconnectDelayMs: 1000,
  reconnectBackoffMultiplier: 2,
  pingIntervalMs: 30000,
};

// Timeframe to Binance interval mapping
const TIMEFRAME_MAP: Record<string, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  '6h': '6h',
  '8h': '8h',
  '12h': '12h',
  '1d': '1d',
  '3d': '3d',
  '1w': '1w',
  '1M': '1M',
};

export class BinanceWebSocket extends EventEmitter {
  private config: Required<BinanceWsConfig>;
  private ws: WebSocket | null = null;
  private state: WsConnectionState = 'disconnected';
  private reconnectAttempts: number = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private lastPongTime: number = 0;
  private shouldReconnect: boolean = true;
  private currentCandle: LiveCandle | null = null;
  private lastClosedTimestamp: number = 0;

  constructor(config: BinanceWsConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Validate timeframe
    if (!TIMEFRAME_MAP[this.config.timeframe]) {
      throw new Error(`Invalid timeframe: ${this.config.timeframe}`);
    }
  }

  /**
   * Get the WebSocket stream URL
   */
  private getStreamUrl(): string {
    const symbol = this.config.symbol.toLowerCase();
    const interval = TIMEFRAME_MAP[this.config.timeframe];
    return `${this.config.baseUrl}/${symbol}@kline_${interval}`;
  }

  /**
   * Connect to Binance WebSocket
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.shouldReconnect = true;
    this.state = 'connecting';

    return new Promise((resolve, reject) => {
      const url = this.getStreamUrl();
      console.log(`[BinanceWS] Connecting to ${url}...`);

      try {
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
          this.state = 'connected';
          this.reconnectAttempts = 0;
          this.lastPongTime = Date.now();
          console.log('[BinanceWS] Connected');
          this.emit('connected');
          this.startPingInterval();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('pong', () => {
          this.lastPongTime = Date.now();
        });

        this.ws.on('close', (code, reason) => {
          const reasonStr = reason?.toString() || 'unknown';
          console.log(`[BinanceWS] Disconnected: ${code} - ${reasonStr}`);
          this.handleDisconnect(reasonStr);
        });

        this.ws.on('error', (error) => {
          console.error('[BinanceWS] Error:', error.message);
          this.emit('error', error);
          if (this.state === 'connecting') {
            reject(error);
          }
        });
      } catch (error) {
        this.state = 'disconnected';
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPingInterval();
    this.clearReconnectTimeout();

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }

    this.state = 'disconnected';
    console.log('[BinanceWS] Disconnected by client');
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as BinanceKlineMessage;

      if (message.e !== 'kline') {
        return;
      }

      const kline = message.k;
      const candle: LiveCandle = {
        timestamp: kline.t,
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c),
        volume: parseFloat(kline.v),
        closed: kline.x,
        trades: kline.n,
      };

      // Emit candle update
      this.emit('candle', candle);

      // Emit candleClosed if this candle just closed (and we haven't already emitted for this timestamp)
      if (candle.closed && candle.timestamp > this.lastClosedTimestamp) {
        this.lastClosedTimestamp = candle.timestamp;
        this.emit('candleClosed', candle);
      }

      this.currentCandle = candle;
    } catch (error) {
      console.error('[BinanceWS] Failed to parse message:', error);
    }
  }

  /**
   * Handle WebSocket disconnect
   */
  private handleDisconnect(reason: string): void {
    this.stopPingInterval();
    this.state = 'disconnected';
    this.emit('disconnected', reason);

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('[BinanceWS] Max reconnect attempts reached');
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.state = 'reconnecting';
    this.reconnectAttempts++;

    const delay = this.config.reconnectDelayMs *
      Math.pow(this.config.reconnectBackoffMultiplier, this.reconnectAttempts - 1);

    console.log(`[BinanceWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // Connection failed, will trigger another reconnect
      }
    }, delay);
  }

  /**
   * Clear reconnect timeout
   */
  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval(): void {
    this.stopPingInterval();

    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      // Check if we've received a pong recently
      const timeSinceLastPong = Date.now() - this.lastPongTime;
      if (timeSinceLastPong > this.config.pingIntervalMs * 2) {
        console.warn('[BinanceWS] No pong received, reconnecting...');
        this.ws.terminate();
        return;
      }

      this.ws.ping();
    }, this.config.pingIntervalMs);
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Get current connection state
   */
  getState(): WsConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Get current candle
   */
  getCurrentCandle(): LiveCandle | null {
    return this.currentCandle;
  }

  /**
   * Get reconnect attempts
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof BinanceWsEvents>(
    event: K,
    listener: BinanceWsEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof BinanceWsEvents>(
    event: K,
    ...args: Parameters<BinanceWsEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
