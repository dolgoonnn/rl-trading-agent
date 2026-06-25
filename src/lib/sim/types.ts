import type { Candle } from '@/types/candle';

export type SimExitReason = 'stop_loss' | 'take_profit' | 'max_bars' | 'strategy' | 'liquidation';
export type FidelityTier = 'l2_depth' | 'subbar_1m' | 'ohlc_heuristic' | 'pessimistic';
export type EntryTiming = 'signal_close' | 'next_open';

export interface SimPosition {
  direction: 'long' | 'short';
  entryPrice: number;       // raw signal price (pre-cost)
  entryTimestamp: number;
  entryIndex: number;
  stopLoss: number;
  takeProfit: number;
  strategy: string;
}

export interface SimConfig {
  entryTiming: EntryTiming;
  maxBars: number;
  barMs: number;
  exitMode: 'simple' | 'partial_tp' | 'breakeven' | 'trailing';
  partialTP?: { fraction: number; triggerR: number; beBuffer: number };
  trailing?: { activationR: number; distanceR: number };
  /** Isolated-margin leverage. When present, enables liquidation modeling. */
  leverage?: number;
  /** Maintenance margin ratio (fraction). Defaults to DEFAULT_MMR = 0.005. */
  mmr?: number;
}

export interface SimTradeResult {
  entryTimestamp: number;
  exitTimestamp: number;
  direction: 'long' | 'short';
  entryPrice: number;       // cost-adjusted entry
  exitPrice: number;        // cost-adjusted exit
  pnlPercent: number;       // cost-adjusted gross return; does NOT include funding (see netReturn)
  strategy?: string;
  exitReason: SimExitReason;
  tier: FidelityTier;
  grossReturn: number;      // == pnlPercent (cost already in adjusted prices)
  fundingReturn: number;
  netReturn: number;        // grossReturn + fundingReturn
  /** True when the position was closed by a liquidation event (leverage-induced). */
  liquidated: boolean;
}

export interface SubBarProvider {
  /** 1m candles strictly inside [barTs, barTs + barMs). Empty when none. */
  subBarsFor(barTs: number, barMs: number): Candle[];
}

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
