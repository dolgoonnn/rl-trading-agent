/** One trade from the 1x scalp backtest, with everything the leverage re-sim needs. */
export interface TradeTapeEntry {
  symbol: string;                 // maps to data/<symbol>_1m.json
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryTimestamp: number;         // ms, UTC — entry bar timestamp
  exitTimestamp: number;          // ms, UTC — 1x exit bar timestamp (inclusive walk bound)
  pnlPercent1x: number;           // per-unit cost-adjusted return from the 1x backtest (e.g. 0.012 = +1.2%)
}

export interface LeverageConfig {
  leverage: number;               // L
  marginFraction: number;         // fraction of equity committed as isolated margin per trade (0..1]
  mmr: number;                    // maintenance margin rate, e.g. 0.005
  slippageBps: number;            // adverse slippage applied to the liquidation trigger (bps of entry)
  fundingRate8h: number;          // flat funding per 8h on notional, e.g. 0.0001
  ruinThreshold: number;          // equity fraction of start that counts as ruin, e.g. 0.10
  mcIterations: number;           // Monte Carlo reshuffles for ruin probability, e.g. 1000
}

/** Per-trade result under a given leverage. equityMultiplier multiplies running equity. */
export type TradeOutcome =
  | { liquidated: true; equityMultiplier: number }    // 1 - marginFraction
  | { liquidated: false; equityMultiplier: number };  // 1 + marginFraction * L * (pnl - funding)

export interface LeverageResult {
  leverage: number;
  marginFraction: number;
  tradeCount: number;
  liquidations: number;
  totalReturn: number;            // terminal equity / start - 1
  meanLogGrowthPerTrade: number;  // mean ln(equityMultiplier)
  maxDrawdown: number;            // on the sequential equity curve, in [0,1]
  ruinProbability: number;        // fraction of MC paths breaching ruinThreshold
  equityCurve: number[];          // sequential, starts at 1
}
