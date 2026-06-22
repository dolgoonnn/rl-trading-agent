'use client';

import { trpc } from '@/lib/trpc/client';
import { ProposalCard } from '@/components/queue/ProposalCard';
import { RiskStrip } from '@/components/queue/RiskStrip';

/**
 * Embeds the proposal queue inline on the setup detail page so decisions
 * happen on the chart, not after navigating away. This is the integration
 * layer between the chart view and the bounded-autonomy queue.
 */
export function SetupProposals({ symbol }: { symbol: string }) {
  const utils = trpc.useUtils();
  const q = trpc.dashboard.queue.forSymbol.useQuery({ symbol }, { refetchInterval: 30_000 });

  if (q.isLoading) return null;
  const data = q.data;
  if (!data || !data.available) return null;

  return (
    <section className="space-y-3">
      <RiskStrip risk={data.risk} />
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm uppercase tracking-wider text-zinc-400">
          proposals for {symbol} ({data.pending.length})
        </h2>
        <span className="text-[11px] text-zinc-500">decide here, on the chart</span>
      </div>
      {data.pending.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-800 bg-zinc-900/30 p-4 text-center text-xs text-zinc-500">
          no pending proposals for {symbol}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.pending.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              blocked={data.risk?.blocked ?? false}
              blockedReason={data.risk?.blockedReason ?? null}
              onDecision={() => {
                utils.dashboard.queue.forSymbol.invalidate({ symbol });
                utils.dashboard.queue.feed.invalidate();
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
