'use client';

import { trpc } from '@/lib/trpc/client';
import { formatUsd, formatPnlPct, sleeveStatusLabel } from '@/lib/bot/format';

const STATUS_STYLE: Record<string, string> = {
  flat: 'bg-zinc-700/30 text-zinc-400 border-zinc-700/50',
  'in position': 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40',
  active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
};

/**
 * Say WHY a sleeve looks the way it does, so silence reads as healthy rather
 * than broken. A flat sleeve with no explanation is what made "why are there no
 * crypto trades?" a question the dashboard could not answer.
 */
function explainSleeve(s: { label: string; closedTrades: number; openPositions: number }): string {
  const isWeekend = [0, 6].includes(new Date().getUTCDay());

  if (s.label.startsWith('crypto')) {
    if (s.openPositions > 0) return 'In a position — trades around the clock.';
    if (s.closedTrades === 0) return 'No signal yet. This strategy is selective — roughly one trade every 2 days across 3 symbols, so quiet stretches are expected.';
    return 'Waiting for the next qualifying setup.';
  }

  if (s.label.startsWith('gold')) {
    if (s.openPositions > 0) return 'Holding — evaluates once per day.';
    if (s.closedTrades === 0) return 'Flat. Evaluates once daily and only enters when its regime filter allows, so long flat stretches are normal.';
    return 'Flat until the next daily signal.';
  }

  // session/metals
  if (s.openPositions > 0) {
    return isWeekend
      ? 'Holding weekend legs — these enter Friday evening and close Monday morning.'
      : 'Holding session legs — each exits on its own clock, not on a profit target.';
  }
  if (isWeekend) return 'Markets closed for the weekend — session legs resume Sunday evening.';
  return 'Between sessions. Legs open and close on fixed clock windows through the day.';
}

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
            {/* cumPnlPct is fraction-scale (sum of fraction-scale per-trade pnlPct); multiply by 100 before formatPnlPct */}
            <p className={`mt-2 text-2xl font-bold font-mono ${pnlColor}`}>{formatPnlPct(s.cumPnlPct * 100)}</p>
            <p className="mt-1.5 text-[11px] leading-snug text-zinc-400">{explainSleeve(s)}</p>
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
