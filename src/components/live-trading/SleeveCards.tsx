'use client';

import { trpc } from '@/lib/trpc/client';
import { formatUsd, formatPnlPct, sleeveStatusLabel } from '@/lib/bot/format';

const STATUS_STYLE: Record<string, string> = {
  flat: 'bg-zinc-700/30 text-zinc-400 border-zinc-700/50',
  'in position': 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40',
  active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
};

export function SleeveCards() {
  const q = trpc.dashboard.book.overview.useQuery(undefined, { refetchInterval: 30_000 });

  if (q.isLoading) {
    return (
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/40" />
        ))}
      </section>
    );
  }

  if (q.error || !q.data) {
    return (
      <section className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
        Failed to load sleeves{q.error ? `: ${q.error.message}` : ''}
      </section>
    );
  }

  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {q.data.perSleeve.map((s) => {
        const status = sleeveStatusLabel(s);
        const pnlColor = s.cumPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
        return (
          <div key={s.label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-zinc-100">{s.label}</span>
              <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[status]}`}>
                {status}
              </span>
            </div>
            <p className={`mt-2 text-2xl font-bold font-mono ${pnlColor}`}>{formatPnlPct(s.cumPnlPct)}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
              <span>equity {formatUsd(s.equity)}</span>
              <span>{s.closedTrades} closed</span>
              <span>{s.openPositions} open</span>
              <span>{(s.winRate * 100).toFixed(0)}% win rate</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}
