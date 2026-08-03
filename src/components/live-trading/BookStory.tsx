'use client';

import { trpc } from '@/lib/trpc/client';
import { formatPnlPct, formatUsd } from '@/lib/bot/format';

/**
 * The headline: what the book did, and WHY.
 *
 * Dashboard research is blunt that a metric listed without the question it
 * answers — and without any comparison — cannot inform a decision. The previous
 * header showed a bare equity figure, which is why every "why did it go
 * negative?" had to be answered by hand. This states the decomposition instead.
 *
 * Stored PnL fields are FRACTIONS (0.0271 = 2.71%) — multiply by 100 exactly once
 * before formatting.
 */
export function BookStory() {
  const overview = trpc.dashboard.book.overview.useQuery(undefined, { refetchInterval: 30_000 });
  const attrib = trpc.dashboard.book.attribution.useQuery(undefined, { refetchInterval: 30_000 });

  if (overview.isLoading || attrib.isLoading) {
    return <div className="h-24 animate-pulse rounded-md bg-zinc-800/40" />;
  }
  if (overview.error || attrib.error) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
        Could not load the book: {overview.error?.message ?? attrib.error?.message}
      </div>
    );
  }

  const o = overview.data;
  const s = attrib.data?.summary;
  if (!o || !s) return null;

  const totalPct = s.total * 100;
  const tone = totalPct >= 0 ? 'text-emerald-400' : 'text-red-400';

  // The story sentence. Only claim "one leg did this" when the data supports it.
  let story: React.ReactNode;
  if (o.totalClosedTrades === 0) {
    story = <>No closed trades yet — the book is flat at its starting notional.</>;
  } else if (s.dominatedByOneLeg && s.topDetractor) {
    story = (
      <>
        Driven almost entirely by{' '}
        <span className="font-medium text-zinc-100">{s.topDetractor.leg}</span>{' '}
        <span className="font-mono text-red-400">{formatPnlPct(s.topDetractor.netPnlPct * 100)}</span>
        {' '}over {s.topDetractor.n} trades. Every other leg combined is{' '}
        <span className={`font-mono ${s.restNetPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {formatPnlPct(s.restNetPnlPct * 100)}
        </span>.
      </>
    );
  } else if (s.topContributor) {
    story = (
      <>
        Best leg{' '}
        <span className="font-medium text-zinc-100">{s.topContributor.leg}</span>{' '}
        <span className="font-mono text-emerald-400">{formatPnlPct(s.topContributor.netPnlPct * 100)}</span>
        {s.topDetractor && (
          <>
            {' '}· worst{' '}
            <span className="font-medium text-zinc-100">{s.topDetractor.leg}</span>{' '}
            <span className="font-mono text-red-400">{formatPnlPct(s.topDetractor.netPnlPct * 100)}</span>
          </>
        )}
        . No single leg dominates.
      </>
    );
  } else {
    story = <>P&amp;L is spread across legs with no dominant contributor.</>;
  }

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-xs uppercase tracking-wider text-zinc-500">Book</span>
        <span className={`font-mono text-3xl font-semibold ${tone}`}>{formatPnlPct(totalPct)}</span>
        <span className="font-mono text-sm text-zinc-400">{formatUsd(o.totalEquity)}</span>
        <span className="text-sm text-zinc-500">
          {o.totalClosedTrades} closed · {o.totalOpenPositions} open
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-300">{story}</p>
      <LegBars />
    </section>
  );
}

/** Per-leg contribution bars — the detail behind the sentence. */
function LegBars() {
  const q = trpc.dashboard.book.attribution.useQuery(undefined, { refetchInterval: 30_000 });
  const legs = q.data?.legs ?? [];
  if (legs.length === 0) return null;

  const max = Math.max(...legs.map((l) => Math.abs(l.netPnlPct)), 1e-9);

  return (
    <div className="mt-4 space-y-1.5">
      {legs.map((l) => {
        const pct = l.netPnlPct * 100;
        const width = (Math.abs(l.netPnlPct) / max) * 100;
        const pos = l.netPnlPct >= 0;
        return (
          <div key={`${l.sleeve}:${l.leg}`} className="grid grid-cols-[10rem_1fr_5rem] items-center gap-3 text-sm">
            <div className="truncate text-zinc-300">
              {l.leg}
              <span className="ml-1.5 text-xs text-zinc-500">{l.n}</span>
              {l.staleCount > 0 && (
                <span
                  className="ml-1.5 rounded bg-amber-500/15 px-1 text-[10px] text-amber-300"
                  title={`${l.staleCount} downtime-stranded trade(s) — drift, not strategy`}
                >
                  {l.staleCount} stale
                </span>
              )}
            </div>
            {/* Zero line in the middle; bars grow left (loss) or right (gain). */}
            <div className="relative h-3 rounded bg-zinc-800/60">
              <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-700" />
              <div
                className={`absolute inset-y-0 rounded ${pos ? 'bg-emerald-500/70' : 'bg-red-500/70'}`}
                style={pos ? { left: '50%', width: `${width / 2}%` } : { right: '50%', width: `${width / 2}%` }}
              />
            </div>
            <div className={`text-right font-mono ${pos ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatPnlPct(pct)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
