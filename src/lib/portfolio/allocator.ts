import type {
  AllocatorResult,
  StrategyAllocation,
  StrategyId,
} from './types';

const TRADING_DAYS = 252;
const MIN_RETURNS_FOR_VOL = 30;

interface AllocatorInput {
  strategy: StrategyId;
  dailyReturns: number[];
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance =
    xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function computeInverseVolWeights(
  inputs: AllocatorInput[],
  _opts: { lookbackDays?: number } = {},
): Pick<AllocatorResult, 'allocations' | 'warnings'> {
  const warnings: string[] = [];
  const includable: { strategy: StrategyId; annualizedVol: number }[] = [];
  const excluded: StrategyAllocation[] = [];

  for (const inp of inputs) {
    if (inp.dailyReturns.length < MIN_RETURNS_FOR_VOL) {
      warnings.push(
        `${inp.strategy}: insufficient data (${inp.dailyReturns.length} returns < ${MIN_RETURNS_FOR_VOL} required) — excluded from allocation`,
      );
      excluded.push({
        strategy: inp.strategy,
        weight: 0,
        annualizedVol: 0,
        recommendedRiskPerTrade: 0,
        currentRiskPerTrade: 0,
        excluded: { reason: `insufficient data: ${inp.dailyReturns.length} returns` },
      });
      continue;
    }
    const dailyVol = stdev(inp.dailyReturns);
    const annualizedVol = dailyVol * Math.sqrt(TRADING_DAYS);
    if (annualizedVol === 0) {
      warnings.push(`${inp.strategy}: zero volatility — excluded`);
      excluded.push({
        strategy: inp.strategy,
        weight: 0,
        annualizedVol: 0,
        recommendedRiskPerTrade: 0,
        currentRiskPerTrade: 0,
        excluded: { reason: 'zero volatility' },
      });
      continue;
    }
    includable.push({ strategy: inp.strategy, annualizedVol });
  }

  const totalInvVol = includable.reduce((s, x) => s + 1 / x.annualizedVol, 0);
  const included: StrategyAllocation[] = includable.map((x) => ({
    strategy: x.strategy,
    weight: 1 / x.annualizedVol / totalInvVol,
    annualizedVol: x.annualizedVol,
    recommendedRiskPerTrade: 0, // filled in by caller knowing total budget
    currentRiskPerTrade: 0,
  }));

  return { allocations: [...included, ...excluded], warnings };
}
