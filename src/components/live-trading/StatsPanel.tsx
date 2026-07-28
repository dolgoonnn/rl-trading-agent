'use client';

import { trpc } from '@/lib/trpc/client';
import { formatPnlPct } from '@/lib/bot/format';

function fmtRatio(n: number | null): string {
  return n === null ? '—' : n.toFixed(2);
}

export function StatsPanel() {
  const q = trpc.dashboard.book.stats.useQuery(undefined, { refetchInterval: 30_000 });

  if (q.isLoading) {
    return <div className="h-24 animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/40" />;
  }

  if (q.error || !q.data) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
        Failed to load stats{q.error ? `: ${q.error.message}` : ''}
      </div>
    );
  }

  const { n, minTradesForStats } = q.data;
  const insufficient = n < minTradesForStats;

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
        <span>n = {n}</span>
        <span>win rate {(q.data.winRate * 100).toFixed(0)}%</span>
      </div>
      {insufficient ? (
        <p className="text-sm text-zinc-400">
          Needs ≥{minTradesForStats} trades to be meaningful — {n} so far.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500">Profit factor</p>
            <p className="font-mono text-zinc-200">{fmtRatio(q.data.profitFactor)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500">Expectancy</p>
            <p className="font-mono text-zinc-200">{formatPnlPct(q.data.expectancy * 100)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500">Avg win</p>
            <p className="font-mono text-emerald-400">{formatPnlPct(q.data.avgWin * 100)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500">Avg loss</p>
            <p className="font-mono text-red-400">{formatPnlPct(q.data.avgLoss * 100)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500">Avg R</p>
            <p className="font-mono text-zinc-200">{fmtRatio(q.data.avgR)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500">Max drawdown</p>
            <p className="font-mono text-zinc-200">{formatPnlPct(q.data.maxDrawdown * 100)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500">Sharpe (per-trade)</p>
            <p className="font-mono text-zinc-200">{fmtRatio(q.data.sharpe)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500">Sortino (per-trade)</p>
            <p className="font-mono text-zinc-200">{fmtRatio(q.data.sortino)}</p>
          </div>
        </div>
      )}
    </div>
  );
}
