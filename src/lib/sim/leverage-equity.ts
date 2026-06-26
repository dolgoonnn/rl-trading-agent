/**
 * Pure leverage equity-curve builder.
 *
 * Turns a per-trade {netReturn, liquidated} list into a compounded equity
 * curve and summary metrics for a single leverage level.
 *
 * NOTE: opts.mmr is accepted for interface symmetry with the leverage-sweep
 * caller (Task 4) but is NOT used here. Liquidation events have already been
 * resolved upstream by the simulator; this function only applies the equity
 * math (margin fraction + liquidation fee on liq trades, levered return on
 * normal trades).
 */

export interface LeverageTrade {
  netReturn: number;
  liquidated: boolean;
}

export interface LeverageEquityResult {
  leverage: number;
  terminalWealth: number; // final equity, starting from 1.0
  liqRate: number; // liquidated count / total
  maxDD: number; // max peak-to-trough drawdown of the equity curve (fraction)
  blown: boolean; // equity hit <= 0 at any point
  equityCurve: number[]; // length trades.length + 1, starts at 1.0
  stepReturns: number[]; // per-trade equity returns (for Sharpe/DSR in Task 4)
}

export function buildLeverageEquityCurve(
  trades: LeverageTrade[],
  opts: { leverage: number; f: number; mmr: number; liqFeeFrac: number },
): LeverageEquityResult {
  if (trades.length === 0) {
    return {
      leverage: opts.leverage,
      terminalWealth: 1,
      liqRate: 0,
      maxDD: 0,
      blown: false,
      equityCurve: [1],
      stepReturns: [],
    };
  }

  const equityCurve: number[] = [1.0];
  const stepReturns: number[] = [];

  let E = 1.0;
  let blown = false;
  let runningPeak = 1.0;
  let maxDD = 0;
  let liqCount = 0;

  for (const trade of trades) {
    if (trade.liquidated) {
      liqCount++;
    }

    if (blown) {
      // Account is already ruined — stays at 0, step return is 0.
      equityCurve.push(0);
      stepReturns.push(0);
      continue;
    }

    let eNext: number;
    if (trade.liquidated) {
      // Isolated mode: lose posted margin fraction + liquidation fee.
      eNext = E * (1 - opts.f - opts.liqFeeFrac);
    } else {
      // Normal trade: levered return on the margin fraction.
      eNext = E * (1 + opts.leverage * opts.f * trade.netReturn);
    }

    // Ruin clamp — cannot go below 0.
    if (eNext <= 0) {
      eNext = 0;
      blown = true;
    }

    const stepReturn = E > 0 ? (eNext - E) / E : 0;
    stepReturns.push(stepReturn);
    equityCurve.push(eNext);

    // Track running peak and max drawdown.
    if (eNext > runningPeak) {
      runningPeak = eNext;
    }
    if (runningPeak > 0) {
      const dd = (runningPeak - eNext) / runningPeak;
      if (dd > maxDD) {
        maxDD = dd;
      }
    }

    E = eNext;
  }

  return {
    leverage: opts.leverage,
    terminalWealth: E,
    liqRate: liqCount / trades.length,
    maxDD,
    blown,
    equityCurve,
    stepReturns,
  };
}
