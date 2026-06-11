'use client';

import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { RiskStrip } from './RiskStrip';
import { ProposalCard } from './ProposalCard';
import { checkKillZone } from '@/lib/ict/kill-zones';

const STATUS_BADGE: Record<string, string> = {
  approved: 'bg-emerald-700/20 text-emerald-300 border-emerald-700/40',
  rejected: 'bg-zinc-800 text-zinc-400 border-zinc-700',
  expired: 'bg-zinc-900 text-zinc-500 border-zinc-800',
  executed: 'bg-emerald-700/30 text-emerald-200 border-emerald-700/50',
};

export function QueueView() {
  const utils = trpc.useUtils();
  const feedQ = trpc.dashboard.queue.feed.useQuery({ auditLimit: 12 }, { refetchInterval: 30_000 });
  const generateMut = trpc.dashboard.queue.generate.useMutation({
    onSuccess: () => utils.dashboard.queue.feed.invalidate(),
  });

  const data = feedQ.data;
  const kz = checkKillZone(Date.now());

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {data?.available && <RiskStrip risk={data.risk} />}
      <header className="border-b border-zinc-800 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">ICT Queue</h1>
            <p className="text-[11px] text-zinc-500">
              proposals · approve/reject with a reason · risk gate enforced
            </p>
          </div>
          <div className="flex items-baseline gap-3 text-xs text-zinc-400">
            <span>
              {kz.inKillZone ? (
                <span className="rounded bg-amber-900/30 px-2 py-0.5 text-amber-300">
                  🟡 {kz.name} active
                </span>
              ) : (
                <span>next {kz.name} in {kz.hoursUntilNext.toFixed(1)}h</span>
              )}
            </span>
            <button
              onClick={() => generateMut.mutate({})}
              disabled={generateMut.isPending}
              className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:text-zinc-500"
            >
              {generateMut.isPending ? 'scanning…' : 'scan now'}
            </button>
            <Link href="/dashboard" className="text-zinc-500 hover:text-zinc-300">
              bias grid →
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        {feedQ.isLoading && <div className="text-sm text-zinc-500">loading queue…</div>}
        {feedQ.isError && <div className="text-sm text-red-400">error: {feedQ.error.message}</div>}
        {data && !data.available && (
          <div className="rounded border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
            no database — start the bot or run migrations to populate state
          </div>
        )}

        {data?.available && (
          <>
            <section>
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-sm uppercase tracking-wider text-zinc-400">
                  pending ({data.stats.pendingCount})
                </h2>
                <div className="text-[11px] text-zinc-500">
                  approved {data.stats.approvedToday} · rejected {data.stats.rejectedToday} · expired{' '}
                  {data.stats.expiredToday}
                </div>
              </div>
              {data.pending.length === 0 ? (
                <div className="rounded border border-dashed border-zinc-800 bg-zinc-900/30 p-6 text-center text-sm text-zinc-500">
                  no proposals.{' '}
                  <button
                    className="text-zinc-300 underline-offset-2 hover:underline"
                    onClick={() => generateMut.mutate({})}
                  >
                    scan symbols now
                  </button>{' '}
                  or wait for next cron.
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {data.pending.map((p) => (
                    <ProposalCard
                      key={p.id}
                      proposal={p}
                      blocked={data.risk?.blocked ?? false}
                      blockedReason={data.risk?.blockedReason ?? null}
                      onDecision={() => utils.dashboard.queue.feed.invalidate()}
                    />
                  ))}
                </div>
              )}
            </section>

            {data.openPositions.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm uppercase tracking-wider text-zinc-400">
                  open positions ({data.openPositions.length})
                </h2>
                <div className="grid gap-2 md:grid-cols-2">
                  {data.openPositions.map((p) => {
                    const pnl = p.pnl_percent ?? 0;
                    const pnlColor =
                      pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-red-300' : 'text-zinc-300';
                    return (
                      <div
                        key={p.id}
                        className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs"
                      >
                        <div className="flex items-baseline justify-between">
                          <span className="font-mono text-zinc-100">
                            {p.symbol}{' '}
                            <span className={p.direction === 'long' ? 'text-emerald-300' : 'text-red-300'}>
                              {p.direction.toUpperCase()}
                            </span>
                          </span>
                          <span className={`font-mono ${pnlColor}`}>
                            {pnl >= 0 ? '+' : ''}{(pnl * 100).toFixed(2)}%
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-zinc-500">
                          @ {p.entry_price.toFixed(4)} · sl {p.current_sl.toFixed(4)} · tp{' '}
                          {p.take_profit.toFixed(4)} · {p.bars_held ?? 0} bars · {p.strategy}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 text-sm uppercase tracking-wider text-zinc-400">
                audit log (today)
              </h2>
              {data.recentDecisions.length === 0 ? (
                <div className="text-xs text-zinc-500">no decisions yet today</div>
              ) : (
                <ul className="space-y-1">
                  {data.recentDecisions.map((d) => (
                    <li
                      key={d.id}
                      className="flex flex-wrap items-baseline gap-2 rounded border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-xs"
                    >
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${
                          STATUS_BADGE[d.status] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700'
                        }`}
                      >
                        {d.status}
                      </span>
                      <span className="font-mono text-zinc-200">{d.symbol}</span>
                      <span className={d.side === 'long' ? 'text-emerald-300' : 'text-red-300'}>
                        {d.side}
                      </span>
                      <span className="text-zinc-500">score {d.score.toFixed(2)}</span>
                      {d.outcomePnlR != null && (
                        <span className={d.outcomePnlR >= 0 ? 'text-emerald-300' : 'text-red-300'}>
                          {d.outcomePnlR >= 0 ? '+' : ''}{d.outcomePnlR.toFixed(2)}R
                        </span>
                      )}
                      {d.decisionReason && (
                        <span className="ml-1 truncate text-zinc-400">"{d.decisionReason}"</span>
                      )}
                      <span className="ml-auto text-[10px] text-zinc-600">
                        {new Date(d.decisionAt ?? d.createdAt).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
