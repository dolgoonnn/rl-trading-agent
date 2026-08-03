'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc/client';

/**
 * "Is anything actually wrong?" — one line, so silence reads as healthy.
 *
 * Replaces the old BookHeader, which repeated the equity figure the headline
 * already states and buried freshness among duplicated numbers. This keeps only
 * what the headline cannot tell you: whether governance is happy, whether each
 * bot's data is current, and when this page last refreshed — the missing "as of"
 * that made stale snapshots indistinguishable from live ones.
 */
export function HealthStrip() {
  const q = trpc.dashboard.book.overview.useQuery(undefined, { refetchInterval: 30_000 });
  const [, tick] = useState(0);

  // Re-render every 10s so the "updated Ns ago" counter stays truthful between polls.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  if (q.isLoading) return <div className="h-10 animate-pulse rounded-md bg-zinc-800/40" />;
  if (q.error || !q.data) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        Cannot reach the book — the page is not showing live data.
      </div>
    );
  }

  const d = q.data;
  const gov = d.governance;
  const govTone = !gov.available
    ? { cls: 'border-zinc-700 bg-zinc-800/60 text-zinc-400', label: 'governance n/a' }
    : gov.action === 'halt'
      ? { cls: 'border-red-500/50 bg-red-500/15 text-red-300', label: 'HALTED' }
      : gov.action === 'derisk'
        ? { cls: 'border-amber-500/50 bg-amber-500/15 text-amber-300', label: 'de-risking' }
        : { cls: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300', label: 'trading' };

  const feeds = [
    { name: 'crypto', ms: d.freshness.cryptoLatestCandleMs, staleAfterMs: 3 * 3_600_000 },
    { name: 'gold', ms: d.freshness.goldStateMtimeMs, staleAfterMs: 36 * 3_600_000 },
    { name: 'metals', ms: d.freshness.metalsStateMtimeMs, staleAfterMs: 2 * 3_600_000 },
  ];
  const stale = feeds.filter((f) => f.ms !== null && Date.now() - f.ms > f.staleAfterMs);
  const missing = feeds.filter((f) => f.ms === null);
  const allWell = stale.length === 0 && missing.length === 0 && gov.action === 'trade';

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
      <span className={`rounded border px-2 py-0.5 font-semibold ${govTone.cls}`}>{govTone.label}</span>

      {allWell ? (
        <span className="text-zinc-400">All feeds current · nothing halted</span>
      ) : (
        <span className="text-amber-300">
          {stale.length > 0 && `stale: ${stale.map((f) => f.name).join(', ')}`}
          {stale.length > 0 && missing.length > 0 && ' · '}
          {missing.length > 0 && `no data: ${missing.map((f) => f.name).join(', ')}`}
        </span>
      )}

      <span className="text-zinc-500">
        {feeds
          .filter((f) => f.ms !== null)
          .map((f) => `${f.name} ${ago(Date.now() - (f.ms as number))}`)
          .join(' · ')}
      </span>

      {gov.reason ? (
        <span className="max-w-md truncate text-zinc-500" title={gov.reason}>
          {gov.reason}
        </span>
      ) : null}

      <span className="ml-auto text-zinc-500" title={new Date(q.dataUpdatedAt).toLocaleString()}>
        updated {ago(Date.now() - q.dataUpdatedAt)} ago
      </span>
    </div>
  );
}

function ago(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
