import type { DecayStatus, EquityPoint, StrategyId } from './types';

const TRADING_DAYS = 252;
const DD_BREACH_MULTIPLIER = 1.5;
const MIN_RETURNS_FOR_SHARPE = 5;

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function computeAnnualizedSharpe(daily: number[]): number | null {
  if (daily.length < MIN_RETURNS_FOR_SHARPE) return null;
  const sd = stdev(daily);
  if (sd === 0 || sd < 1e-10) return null;
  const mean = daily.reduce((s, x) => s + x, 0) / daily.length;
  return (mean / sd) * Math.sqrt(TRADING_DAYS);
}

export function computeMaxDrawdown(series: EquityPoint[]): number {
  if (series.length === 0) return 0;
  let peak = series[0]!.equity;
  let maxDD = 0;
  for (const p of series) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
}

export interface EvaluateDecayInput {
  strategy: StrategyId;
  dailyReturns30d: number[];
  equity90d: EquityPoint[];
  bootstrapFloor: number;
  drawdownCeiling: number;
}

export function evaluateDecay(input: EvaluateDecayInput): DecayStatus {
  const liveSharpe30d = computeAnnualizedSharpe(input.dailyReturns30d);
  const liveDrawdown90d =
    input.equity90d.length > 0 ? computeMaxDrawdown(input.equity90d) : null;
  const ddCeilingEffective = input.drawdownCeiling * DD_BREACH_MULTIPLIER;

  let tripped = false;
  const reasons: string[] = [];

  if (liveSharpe30d !== null && liveSharpe30d < input.bootstrapFloor) {
    tripped = true;
    reasons.push(
      `live 30d Sharpe ${liveSharpe30d.toFixed(2)} < bootstrap floor ${input.bootstrapFloor.toFixed(2)}`,
    );
  }
  if (liveDrawdown90d !== null && liveDrawdown90d > ddCeilingEffective) {
    tripped = true;
    reasons.push(
      `live 90d drawdown ${(liveDrawdown90d * 100).toFixed(1)}% > ceiling ${(ddCeilingEffective * 100).toFixed(1)}% (1.5× ${(input.drawdownCeiling * 100).toFixed(1)}%)`,
    );
  }

  return {
    strategy: input.strategy,
    liveSharpe30d,
    bootstrapFloor: input.bootstrapFloor,
    liveDrawdown90d,
    drawdownCeiling: ddCeilingEffective,
    tripped,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
  };
}
