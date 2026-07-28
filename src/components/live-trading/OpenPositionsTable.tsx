'use client';

import { trpc } from '@/lib/trpc/client';
import { formatUsd } from '@/lib/bot/format';

export function OpenPositionsTable() {
  const q = trpc.dashboard.book.positions.useQuery(undefined, { refetchInterval: 30_000 });

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold text-zinc-100">Open positions</h2>
      {q.isLoading ? (
        <div className="h-16 animate-pulse rounded bg-zinc-800/60" />
      ) : q.error ? (
        <p className="text-sm text-red-300">Failed to load positions: {q.error.message}</p>
      ) : !q.data || q.data.length === 0 ? (
        <p className="text-sm text-zinc-500">No open positions.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                <th className="px-3 py-2">Sleeve</th>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Direction</th>
                <th className="px-3 py-2 text-right">Entry price</th>
                <th className="px-3 py-2 text-right">Size (USDT)</th>
                <th className="px-3 py-2">Strategy</th>
                <th className="px-3 py-2">Opened</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((p, i) => (
                <tr key={`${p.sleeve}-${p.symbol}-${i}`} className="border-b border-zinc-800/60 last:border-0">
                  <td className="px-3 py-2">
                    <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[11px] text-zinc-300">
                      {p.sleeve}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-zinc-200">{p.symbol}</td>
                  <td className="px-3 py-2">
                    <span className={p.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                      {p.direction.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-200">{formatUsd(p.entryPrice)}</td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-200">
                    {p.sizeUsdt !== null ? formatUsd(p.sizeUsdt) : '—'}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{p.strategy ?? '—'}</td>
                  <td className="px-3 py-2 text-zinc-500">
                    {p.entryTimestamp ? new Date(p.entryTimestamp).toLocaleString() : '—'}
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
