'use client';
import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { BookStory } from '@/components/live-trading/BookStory';
import { HealthStrip } from '@/components/live-trading/HealthStrip';
import { EquityCurveChart } from '@/components/live-trading/EquityCurveChart';
import { OpenPositionsTable } from '@/components/live-trading/OpenPositionsTable';
import { RecentTradesTable } from '@/components/live-trading/RecentTradesTable';
import { SleeveCards } from '@/components/live-trading/SleeveCards';
import { StatsPanel } from '@/components/live-trading/StatsPanel';
import { BreakdownTables } from '@/components/live-trading/BreakdownTables';
import { CostPanel } from '@/components/live-trading/CostPanel';

/**
 * Layout follows the journalism model the dashboard research recommends:
 * headline first (what happened and WHY), then whether anything is wrong, then
 * live state, then detail. Sample-hungry analytics sit behind a disclosure so
 * they stop occupying the top-left attention zone while they are still noise.
 */
export default function LiveTradingPage() {
  // Plot the BOOK, not the crypto sleeve — the sleeve series sits flat at its
  // notional while other sleeves move, which made the chart contradict the headline.
  const curve = trpc.dashboard.book.bookEquityCurve.useQuery(undefined, { refetchInterval: 30_000 });
  const stats = trpc.dashboard.book.stats.useQuery(undefined, { refetchInterval: 30_000 });
  const [showAnalytics, setShowAnalytics] = useState(false);

  const n = stats.data?.n ?? 0;
  const minN = stats.data?.minTradesForStats ?? 20;
  const analyticsReady = n >= minN;

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-3xl font-bold">Paper Fleet — Live Book</h1>

      {/* 1. The story: what the book did, and which leg drove it. */}
      <BookStory />

      {/* 2. Is anything actually wrong? Governance, feed freshness, "as of". */}
      <HealthStrip />

      {/* 3. Live state. */}
      <SleeveCards />
      <OpenPositionsTable />

      <section className="rounded-lg border border-gray-800 p-4">
        <h2 className="mb-2 text-lg font-semibold">Book equity &amp; drawdown</h2>
        <p className="mb-3 text-xs text-zinc-500">
          All sleeves combined, rebuilt from closed trades. Downtime-stranded fills are excluded.
        </p>
        <EquityCurveChart points={curve.data ?? []} drawdown={curve.data ?? []} />
      </section>

      {/* 4. Detail — click any row for why the trade opened and closed. */}
      <RecentTradesTable />

      {/* 5. Sample-hungry analytics, collapsed until they mean something. */}
      <section className="rounded-lg border border-gray-800 p-4">
        <button
          type="button"
          onClick={() => setShowAnalytics((v) => !v)}
          className="flex w-full items-center justify-between text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500"
          aria-expanded={showAnalytics}
        >
          <span className="text-lg font-semibold">Analytics</span>
          <span className="text-xs text-zinc-400">
            {analyticsReady
              ? `${n} trades · tap to ${showAnalytics ? 'hide' : 'show'}`
              : `needs ${minN}+ trades to mean anything — ${n} so far`}
          </span>
        </button>
        {showAnalytics && (
          <div className="mt-4 space-y-6">
            <StatsPanel />
            <BreakdownTables />
            <CostPanel />
          </div>
        )}
      </section>
    </main>
  );
}
