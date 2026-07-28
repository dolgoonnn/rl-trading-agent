'use client';

import { trpc } from '@/lib/trpc/client';
import { formatUsd } from '@/lib/bot/format';

function freshnessLabel(ms: number | null): string {
  if (ms === null) return 'no data';
  const ageMin = (Date.now() - ms) / 60_000;
  if (ageMin < 60) return `${Math.round(ageMin)}m ago`;
  if (ageMin < 24 * 60) return `${Math.round(ageMin / 60)}h ago`;
  return `${Math.round(ageMin / (24 * 60))}d ago`;
}

export function BookHeader() {
  const q = trpc.dashboard.book.overview.useQuery(undefined, { refetchInterval: 30_000 });

  if (q.isLoading) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 animate-pulse">
        <div className="h-8 w-48 rounded bg-zinc-800" />
      </section>
    );
  }

  if (q.error || !q.data) {
    return (
      <section className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
        Failed to load book overview{q.error ? `: ${q.error.message}` : ''}
      </section>
    );
  }

  const d = q.data;
  const govLabel = !d.governance.available
    ? 'n/a'
    : d.governance.action === 'trade'
      ? 'trading'
      : d.governance.action === 'derisk'
        ? 'de-risking'
        : d.governance.action === 'halt'
          ? 'HALTED'
          : 'unknown';
  const govStyle = !d.governance.available
    ? 'bg-zinc-700/30 text-zinc-400 border-zinc-700/50'
    : d.governance.action === 'trade'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
      : d.governance.action === 'halt'
        ? 'bg-red-500/15 text-red-300 border-red-500/40'
        : 'bg-amber-500/15 text-amber-300 border-amber-500/40';

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="text-xs uppercase tracking-wider text-zinc-400">Total book equity</span>
          <p className="text-3xl font-bold font-mono text-zinc-50">{formatUsd(d.totalEquity)}</p>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <div className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${govStyle}`}>
            governance: {govLabel}
          </div>
          {d.governance.reason ? (
            <p className="max-w-xs text-right text-[10px] text-zinc-500" title={d.governance.reason}>
              {d.governance.reason}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Closed trades</p>
          <p className="text-lg font-semibold text-zinc-100">{d.totalClosedTrades}</p>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Open positions</p>
          <p className="text-lg font-semibold text-zinc-100">{d.totalOpenPositions}</p>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Active / idle sleeves</p>
          <p className="text-lg font-semibold text-zinc-100">
            {d.activeSleeves} / {d.idleSleeves.length}
          </p>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Crypto candle freshness</p>
          <p className="text-lg font-semibold text-zinc-100">{freshnessLabel(d.freshness.cryptoLatestCandleMs)}</p>
        </div>
      </div>
      {d.idleSleeves.length > 0 ? (
        <p className="mt-3 text-[11px] text-zinc-500">idle: {d.idleSleeves.join(', ')}</p>
      ) : null}
    </section>
  );
}
