'use client';

import { use } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { SetupChart } from '@/components/dashboard/SetupChart';
import { KillZoneBadge } from '@/components/dashboard/KillZoneBadge';
import { HTFMiniGrid } from '@/components/dashboard/HTFMiniGrid';
import { ChecklistCard } from '@/components/dashboard/ChecklistCard';
import {
  SetupCard,
  type SetupCardData,
  type SetupCardStats,
  type SetupCardDecay,
} from '@/components/dashboard/SetupCard';

const RUN20_THRESHOLD = 4.048;

interface PageProps {
  params: Promise<{ symbol: string }>;
}

export default function SetupPage({ params }: PageProps) {
  const { symbol } = use(params);

  const candlesQ = trpc.dashboard.candles.recent.useQuery({ symbol, n: 300 });
  const setupsQ = trpc.dashboard.setups.live.useQuery({ symbol, candleCount: 500 });
  const overlaysQ = trpc.dashboard.overlays.scan.useQuery({ symbol, candleCount: 500 });
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

  const overlays = overlaysQ.data;
  const selected = setupsData?.allScored?.[0]?.signal ?? null;
  const setupLines = selected
    ? {
        entry: selected.entryPrice,
        stopLoss: selected.stopLoss,
        takeProfit: selected.takeProfit,
        side: selected.direction,
      }
    : null;

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
        <div className="flex items-center gap-3">
          <KillZoneBadge />
          <span className="text-xs text-zinc-500">
            {setupsQ.isLoading ? 'loading…' : setupsData?.available ? 'live' : 'no data'}
          </span>
        </div>
      </header>
      <main className="space-y-6 p-6">
        <HTFMiniGrid symbol={symbol} setupSide={selected?.direction ?? null} />
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
          <div className="mb-2 flex flex-wrap gap-3 px-2 pt-1 text-[10px] font-mono text-zinc-500">
            <span><span className="inline-block h-2 w-3 align-middle" style={{ background: 'rgba(34,197,94,0.4)' }} /> bull OB</span>
            <span><span className="inline-block h-2 w-3 align-middle" style={{ background: 'rgba(239,68,68,0.4)' }} /> bear OB</span>
            <span><span className="inline-block h-2 w-3 align-middle" style={{ background: 'rgba(59,130,246,0.3)' }} /> bull FVG</span>
            <span><span className="inline-block h-2 w-3 align-middle" style={{ background: 'rgba(234,179,8,0.3)' }} /> bear FVG</span>
            <span className="text-emerald-400">— SSL</span>
            <span className="text-rose-400">— BSL</span>
            <span className="text-amber-400">▲ sweep</span>
            <span className="text-blue-400">● BOS</span>
            <span className="text-purple-400">● CHoCH</span>
          </div>
          {candlesQ.isLoading ? (
            <div className="flex h-[400px] items-center justify-center text-zinc-500">
              loading candles…
            </div>
          ) : candles.length === 0 ? (
            <div className="flex h-[400px] items-center justify-center text-zinc-500">
              no candle data
            </div>
          ) : (
            <SetupChart
              candles={candles}
              rects={overlays?.rects ?? []}
              lines={overlays?.lines ?? []}
              markers={overlays?.markers ?? []}
              setupLines={setupLines}
            />
          )}
        </section>
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm uppercase tracking-wider text-zinc-400">
              {setupsData && setupsData.barOffset === 0 ? 'Active setups' : 'Recent setups'}
            </h2>
            {setupsData && setupsData.barOffset > 0 && (
              <span className="text-xs text-zinc-500">
                last candidate {setupsData.barOffset} bar{setupsData.barOffset === 1 ? '' : 's'} ago
                &middot; scanned {setupsData.scannedBars} bars
              </span>
            )}
            <span className="text-xs text-zinc-500">regime: {setupsData?.regime ?? '—'}</span>
          </div>
          {setupsQ.isLoading ? (
            <p className="text-zinc-500">loading…</p>
          ) : cards.length === 0 ? (
            <p className="text-zinc-500">
              no setups in last {setupsData?.scannedBars ?? 50} bars &middot; {setupsData?.reasoning?.[0] ?? ''}
            </p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {cards.map((c, i) => (
                <SetupCard
                  key={`card-${i}`}
                  data={c}
                  stats={statsForStrategy(c.strategyId)}
                  decay={decayForStrategy(c.strategyId)}
                />
              ))}
              {cards[0] && (
                <div className="md:col-span-2">
                  <ChecklistCard
                    side={cards[0].side}
                    totalScore={cards[0].confluenceScore}
                    threshold={RUN20_THRESHOLD}
                    factorBreakdown={Object.fromEntries(
                      cards[0].scoreBreakdown.map((b) => [b.factor, b.value]),
                    )}
                  />
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
