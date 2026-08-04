/**
 * Pure per-trade analytics for the dashboard. No I/O so it stays unit-testable.
 * Ratio-style metrics return null rather than Infinity/NaN when undefined, so
 * the UI can distinguish "not computable" from "zero".
 */

/** Sample size below which ratio stats are not meaningful and must not be shown. */
export const MIN_TRADES_FOR_STATS = 20;

export interface AnalyticsTrade {
  pnlPct: number;
  pnlUsdt: number | null;
  riskAmountUsdt: number | null;
  exitReason: string | null;
  regime: string | null;
  symbol: string;
  confluenceScore: number | null;
}

export interface PerfStats {
  n: number;
  profitFactor: number | null;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  avgR: number | null;
  winRate: number;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function computePerfStats(trades: AnalyticsTrade[]): PerfStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlPct > 0).map((t) => t.pnlPct);
  const losses = trades.filter((t) => t.pnlPct < 0).map((t) => t.pnlPct);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const rs = trades
    .filter((t) => t.pnlUsdt !== null && t.riskAmountUsdt !== null && t.riskAmountUsdt > 0)
    .map((t) => (t.pnlUsdt as number) / (t.riskAmountUsdt as number));
  return {
    n,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: mean(trades.map((t) => t.pnlPct)),
    avgWin: mean(wins),
    avgLoss: mean(losses),
    avgR: rs.length > 0 ? mean(rs) : null,
    winRate: n > 0 ? wins.length / n : 0,
  };
}

export interface BreakdownRow {
  key: string;
  n: number;
  netPnlPct: number;
  winRate: number;
}

export function groupBy(trades: AnalyticsTrade[], keyOf: (t: AnalyticsTrade) => string): BreakdownRow[] {
  const buckets = new Map<string, AnalyticsTrade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    const cur = buckets.get(k);
    if (cur) cur.push(t);
    else buckets.set(k, [t]);
  }
  const rows: BreakdownRow[] = [];
  for (const [key, ts] of buckets) {
    const winners = ts.filter((t) => t.pnlPct > 0).length;
    rows.push({
      key,
      n: ts.length,
      netPnlPct: ts.reduce((a, t) => a + t.pnlPct, 0),
      winRate: ts.length > 0 ? winners / ts.length : 0,
    });
  }
  return rows.sort((a, b) => b.n - a.n);
}

export function confluenceBucket(score: number | null): string {
  if (score === null) return 'unknown';
  if (score < 3) return '<3';
  if (score < 4) return '3-4';
  if (score < 5) return '4-5';
  if (score < 6) return '5-6';
  return '6+';
}

/**
 * How far price moved, in PIPS, on every instrument.
 *
 * Percent is comparable across the book but says nothing about the move itself,
 * and these are leveraged positions — the pip is the unit the trade is actually
 * read in. One unit everywhere beats pips-here/points-there: mixed units make
 * two rows in the same table silently incomparable.
 *
 * Sizes follow the standard retail quote convention per instrument, so the
 * numbers match what a broker platform shows for the same move. `pipSize` rides
 * along so the UI can state the definition rather than leave it folklore.
 *
 * Signed by direction — a profitable short reports a positive move.
 */
export interface PriceMove { value: number; unit: 'pips'; pipSize: number }

const PIP_SIZE: Record<string, number> = {
  eurusd: 0.0001, // 5-digit FX: 1 pip = 0.0001
  gold: 0.01,     // XAU quoted to 2dp: $1.00 = 100 pips
  silver: 0.001,  // XAG quoted to 3dp: $1.00 = 1000 pips
  us500: 0.1,     // index CFD quoted to 1dp
  btcusdt: 1,     // crypto perps: pip scaled so one pip is a meaningful tick
  ethusdt: 0.1,
  solusdt: 0.01,
};

export function priceMove(
  instrument: string | null,
  direction: string,
  entryPrice: number | null,
  exitPrice: number | null,
): PriceMove | null {
  if (instrument === null || entryPrice === null || exitPrice === null) return null;
  const pipSize = PIP_SIZE[instrument.toLowerCase()];
  if (pipSize === undefined) return null;
  const raw = direction === 'short' ? entryPrice - exitPrice : exitPrice - entryPrice;
  return { value: raw / pipSize, unit: 'pips', pipSize };
}

/** Pips rendered the way a platform shows them: grouped, and never false-precise. */
export function formatPips(m: PriceMove): string {
  const abs = Math.abs(m.value);
  const dp = abs >= 100 ? 0 : 1;
  const sign = m.value >= 0 ? '+' : '−';
  return `${sign}${abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })} pips`;
}
