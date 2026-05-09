'use client';

import { use } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { SetupChart } from '@/components/dashboard/SetupChart';
import {
  SetupCard,
  type SetupCardData,
  type SetupCardStats,
  type SetupCardDecay,
} from '@/components/dashboard/SetupCard';

interface PageProps {
  params: Promise<{ symbol: string }>;
}

export default function SetupPage({ params }: PageProps) {
  const { symbol } = use(params);

  const candlesQ = trpc.dashboard.candles.recent.useQuery({ symbol, n: 300 });
  const setupsQ = trpc.dashboard.setups.live.useQuery({ symbol, candleCount: 500 });
  const statsQ = trpc.dashboard.stats.byPattern.useQuery();
  const decayQ = trpc.dashboard.decay.status.useQuery();

  const candles = candlesQ.data?.available ? candlesQ.data.candles : [];
  const setupsData = setupsQ.data;
  const stats = statsQ.data ?? [];
  const decay = decayQ.data;

  const statsForStrategy = (id: string): SetupCardStats | null => {
    const s = stats.find((x) => x.strategy === id);
    if (!s) return null;
    return { winRate: s.winRate, totalTrades: s.totalTrades, sharpe: s.sharpe, source: s.source };
  };

  const decayForStrategy = (id: string): SetupCardDecay | null => {
    if (!decay?.available) return null;
    const d = decay.statuses.find(
      (x: { strategy: string; tripped: boolean; reason?: string }) => x.strategy === id,
    );
    if (!d) return null;
    return { tripped: d.tripped, reason: d.reason };
  };

  const strategyId = 'ict-3sym';

  const cards: SetupCardData[] = (setupsData?.allScored ?? []).slice(0, 5).map((s) => {
    const sig = s.signal;
    return {
      setupType: sig.strategy,
      side: sig.direction,
      entryPrice: sig.entryPrice,
      stopLoss: sig.stopLoss,
      takeProfit: sig.takeProfit,
      confluenceScore: s.totalScore,
      scoreBreakdown: Object.entries(s.factorBreakdown).map(([factor, value]) => ({
        factor,
        value,
      })),
      strategyId,
    };
  });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <div>
          <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-300">
            &larr; back to grid
          </Link>
          <h1 className="font-mono text-xl font-semibold">{symbol}</h1>
        </div>
        <span className="text-xs text-zinc-500">
          {setupsQ.isLoading ? 'loading…' : setupsData?.available ? 'live' : 'no data'}
        </span>
      </header>
      <main className="space-y-6 p-6">
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
          {candlesQ.isLoading ? (
            <div className="flex h-[400px] items-center justify-center text-zinc-500">
              loading candles…
            </div>
          ) : candles.length === 0 ? (
            <div className="flex h-[400px] items-center justify-center text-zinc-500">
              no candle data
            </div>
          ) : (
            <SetupChart candles={candles} />
          )}
        </section>
        <section>
          <h2 className="mb-3 text-sm uppercase tracking-wider text-zinc-400">Active setups</h2>
          {setupsQ.isLoading ? (
            <p className="text-zinc-500">loading…</p>
          ) : cards.length === 0 ? (
            <p className="text-zinc-500">
              no active setups &middot; {setupsData?.reasoning?.[0] ?? ''}
            </p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {cards.map((c, i) => (
                <SetupCard
                  key={i}
                  data={c}
                  stats={statsForStrategy(c.strategyId)}
                  decay={decayForStrategy(c.strategyId)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
