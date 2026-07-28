'use client';

import { trpc } from '@/lib/trpc/client';
import { formatPnlPct } from '@/lib/bot/format';

interface Row {
  key: string;
  n: number;
  netPnlPct: number;
  winRate: number;
}

function BreakdownTable({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div>
      <h3 className="mb-1 text-[11px] uppercase tracking-wider text-zinc-500">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No trades yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wider text-zinc-500">
              <th className="px-2 py-1">Key</th>
              <th className="px-2 py-1 text-right">n</th>
              <th className="px-2 py-1 text-right">Net PnL%</th>
              <th className="px-2 py-1 text-right">Win rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-zinc-800/60 last:border-0">
                <td className="px-2 py-1 text-zinc-200">{r.key}</td>
                <td className="px-2 py-1 text-right font-mono text-zinc-400">{r.n}</td>
                <td className={`px-2 py-1 text-right font-mono ${r.netPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatPnlPct(r.netPnlPct * 100)}
                </td>
                <td className="px-2 py-1 text-right font-mono text-zinc-400">{(r.winRate * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function BreakdownTables() {
  const q = trpc.dashboard.book.breakdowns.useQuery(undefined, { refetchInterval: 30_000 });

  if (q.isLoading) {
    return <div className="h-24 animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/40" />;
  }

  if (q.error || !q.data) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
        Failed to load breakdowns{q.error ? `: ${q.error.message}` : ''}
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 text-sm text-zinc-500">Counts shown per row — a bucket with few trades is not a pattern.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <BreakdownTable title="By exit reason" rows={q.data.byExitReason} />
        <BreakdownTable title="By regime" rows={q.data.byRegime} />
        <BreakdownTable title="By symbol" rows={q.data.bySymbol} />
        <BreakdownTable title="By confluence bucket" rows={q.data.byConfluence} />
      </div>
    </div>
  );
}
