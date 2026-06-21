import type { Candle } from '@/types/candle';

export type SimExitReason = 'stop_loss' | 'take_profit' | 'max_bars' | 'strategy';
export type FidelityTier = 'l2_depth' | 'subbar_1m' | 'ohlc_heuristic' | 'pessimistic';
export type EntryTiming = 'signal_close' | 'next_open';

export interface SimLevels {
  direction: 'long' | 'short';
  stopLoss: number;
  takeProfit: number;
}

export interface BarFillRequest {
  levels: SimLevels;
  bar: Candle;
  barsHeld: number;
  maxBars: number;
  /** 1m candles strictly inside [bar.ts, bar.ts + barMs). Present enables subbar_1m. */
  subBars?: Candle[];
}

export interface FillResult {
  exitPrice: number;
  exitReason: SimExitReason;
  fillTimestamp: number;
  tier: FidelityTier;
}

export interface CostContext {
  side: 'entry' | 'exit';
  /** Which leg an exit fills as. TP exits rest (maker); SL/timeout cross (taker). */
  exitSide?: 'maker' | 'taker';
  /** Bar volume (base units) for impact gating. */
  barVolume?: number;
  /** Order size (base units) for impact gating. */
  orderQty?: number;
  /** Half-spread as a fraction of price (e.g. 0.0001 = 1bp). */
  halfSpread?: number;
  /**
   * Per-bar volatility (fraction) for the sqrt-impact term. Defaults to 1 when
   * absent — callers who do not inject vol should fold the typical volatility
   * into `impactCoef` (i.e. set impactCoef ≈ Y × σ_typical).
   */
  volatility?: number;
}
