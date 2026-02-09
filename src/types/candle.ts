/**
 * Core OHLCV candle types
 */

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Taker buy base asset volume (from Binance klines index 9). Optional for backwards compat. */
  takerBuyVolume?: number;
}

export interface CandleWithIndex extends Candle {
  index: number;
}

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

export interface CandleQuery {
  symbol: string;
  timeframe: Timeframe;
  start?: Date;
  end?: Date;
  limit?: number;
}

export function isBullish(candle: Candle): boolean {
  return candle.close > candle.open;
}

export function isBearish(candle: Candle): boolean {
  return candle.close < candle.open;
}

export function bodySize(candle: Candle): number {
  return Math.abs(candle.close - candle.open);
}

export function range(candle: Candle): number {
  return candle.high - candle.low;
}

export function bodyPercent(candle: Candle): number {
  const r = range(candle);
  if (r === 0) return 0;
  return bodySize(candle) / r;
}
