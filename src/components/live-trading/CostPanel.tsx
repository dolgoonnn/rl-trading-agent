'use client';

import { trpc } from '@/lib/trpc/client';
import { formatUsd, formatPnlPct } from '@/lib/bot/format';

export function CostPanel() {
  const q = trpc.dashboard.book.costs.useQuery(undefined, { refetchInterval: 30_000 });

  if (q.isLoading) {
    return <div className="h-24 animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/40" />;
  }

  if (q.error || !q.data) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
        Failed to load costs{q.error ? `: ${q.error.message}` : ''}
      </div>
    );
  }

  const { totalGross, totalFriction, totalFunding, totalNet, fundingBySymbol } = q.data;
  const noData = totalGross === 0 && totalFriction === 0 && totalFunding === 0 && totalNet === 0 && fundingBySymbol.length === 0;

  if (noData) {
    return <p className="text-sm text-zinc-500">No cost data yet.</p>;
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Gross</p>
          <p className="font-mono text-zinc-200">{formatPnlPct(totalGross * 100)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Friction</p>
          <p className="font-mono text-red-400">{formatPnlPct(totalFriction * 100)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Funding</p>
          <p className="font-mono text-red-400">{formatPnlPct(totalFunding * 100)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Net</p>
          <p className={`font-mono ${totalNet >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{formatPnlPct(totalNet * 100)}</p>
        </div>
      </div>
      {fundingBySymbol.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wider text-zinc-500">
              <th className="px-2 py-1">Symbol</th>
              <th className="px-2 py-1 text-right">Funding paid</th>
            </tr>
          </thead>
          <tbody>
            {fundingBySymbol.map((f) => (
              <tr key={f.symbol} className="border-b border-zinc-800/60 last:border-0">
                <td className="px-2 py-1 font-mono text-zinc-200">{f.symbol}</td>
                <td className="px-2 py-1 text-right font-mono text-zinc-400">{formatUsd(f.fundingPaidUsdt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
