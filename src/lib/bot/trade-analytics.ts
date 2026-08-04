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

/**
 * Pip = the SECOND-TO-LAST digit of the standard quote (the last digit is the
 * fractional pip). That is the FX convention and it carries to every other
 * market on an MT-style platform — it is why 1 pip is 0.0001 on a 5-digit
 * EUR/USD and $0.10 on a 2-decimal gold quote, not $0.01.
 *
 * Sanity check the rule holds its scale: a 0.1% move lands at roughly 10-60
 * pips on every instrument below. Sizes that put a normal day in the thousands
 * are a decimal place too fine.
 */
const PIP_SIZE: Record<string, number> = {
  eurusd: 0.0001, // 1.14000 -> pip is the 4th decimal
  gold: 0.1,      // 4055.40 -> $1.00 = 10 pips
  silver: 0.01,   // 58.505  -> $1.00 = 100 pips
  us500: 1,       // 7443.75 -> 1 index point = 1 pip
  btcusdt: 1,     // $1 = 1 pip
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

/**
 * Heat taken and best move offered, over the holding window.
 *
 * The stopless analogue of risk/reward. `maePct` is the worst unrealized loss
 * (<= 0), `mfePct` the best unrealized gain (>= 0), and `capturedPct` how much
 * of the favourable move the exit actually kept — the number that says whether
 * a clock exit is leaving money on the table.
 */
export interface Excursion {
  maePct: number;
  mfePct: number;
  /** null when there was no favourable move to capture — a ratio over zero. */
  capturedPct: number | null;
}

export function computeExcursion(
  candles: Array<{ timestamp: number; high: number; low: number }>,
  direction: string,
  entryPrice: number | null,
  exitPrice: number | null,
  entryTimestamp: number,
  exitTimestamp: number,
): Excursion | null {
  if (entryPrice === null || entryPrice <= 0 || exitPrice === null) return null;
  const held = candles.filter((c) => c.timestamp >= entryTimestamp && c.timestamp <= exitTimestamp);
  if (held.length === 0) return null;
  const high = Math.max(...held.map((c) => c.high));
  const low = Math.min(...held.map((c) => c.low));
  const short = direction === 'short';
  // Favourable is up for a long, down for a short.
  const best = short ? (entryPrice - low) / entryPrice : (high - entryPrice) / entryPrice;
  const worst = short ? (entryPrice - high) / entryPrice : (low - entryPrice) / entryPrice;
  const realized = short ? (entryPrice - exitPrice) / entryPrice : (exitPrice - entryPrice) / entryPrice;
  const mfePct = Math.max(0, best);
  return {
    maePct: Math.min(0, worst),
    mfePct,
    capturedPct: mfePct > 0 ? realized / mfePct : null,
  };
}

/** Pips rendered the way a platform shows them: grouped, and never false-precise. */
export function formatPips(m: PriceMove): string {
  const abs = Math.abs(m.value);
  const dp = abs >= 100 ? 0 : 1;
  const sign = m.value >= 0 ? '+' : '−';
  return `${sign}${abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })} pips`;
}
