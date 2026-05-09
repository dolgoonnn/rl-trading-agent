const MIN_RETURNS_FOR_SHARPE = 5;
const STDEV_THRESHOLD = 1e-10;

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function computeAnnualizedSharpeFromReturns(
  returns: number[],
  tradesPerYear: number,
): number | null {
  if (returns.length < MIN_RETURNS_FOR_SHARPE) return null;
  const sd = stdev(returns);
  if (sd < STDEV_THRESHOLD) return null;
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  return (mean / sd) * Math.sqrt(tradesPerYear);
}
