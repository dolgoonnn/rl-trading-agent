'use client';

import { trpc } from '@/lib/trpc/client';
import { formatUsd, formatPnlPct } from '@/lib/bot/format';

export function RecentTradesTable() {
  const q = trpc.dashboard.book.trades.useQuery({ limit: 50 }, { refetchInterval: 30_000 });

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold text-zinc-100">Recent trades</h2>
      {q.isLoading ? (
        <div className="h-16 animate-pulse rounded bg-zinc-800/60" />
      ) : q.error ? (
        <p className="text-sm text-red-300">Failed to load trades: {q.error.message}</p>
      ) : !q.data || q.data.length === 0 ? (
        <p className="text-sm text-zinc-500">No closed trades yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                <th className="px-3 py-2">Sleeve</th>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Direction</th>
                <th className="px-3 py-2 text-right">PnL %</th>
                <th className="px-3 py-2 text-right">PnL (USDT)</th>
                <th className="px-3 py-2">Exit reason</th>
                <th className="px-3 py-2">Closed</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((t, i) => (
                <tr key={`${t.sleeve}-${t.symbol}-${t.exitTimestamp}-${i}`} className="border-b border-zinc-800/60 last:border-0">
                  <td className="px-3 py-2">
                    <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[11px] text-zinc-300">
                      {t.sleeve}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-zinc-200">{t.symbol}</td>
                  <td className="px-3 py-2">
                    <span className={t.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                      {t.direction === '—' ? t.direction : t.direction.toUpperCase()}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right font-mono ${t.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatPnlPct(t.pnlPct)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-200">
                    {t.pnlUsdt !== null ? formatUsd(t.pnlUsdt) : '—'}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{t.exitReason ?? '—'}</td>
                  <td className="px-3 py-2 text-zinc-500">
                    {t.exitTimestamp ? new Date(t.exitTimestamp).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
