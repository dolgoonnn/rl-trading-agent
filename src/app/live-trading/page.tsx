'use client';
import { trpc } from '@/lib/trpc/client';
import { BookHeader } from '@/components/live-trading/BookHeader';
import { EquityCurveChart } from '@/components/live-trading/EquityCurveChart';
import { OpenPositionsTable } from '@/components/live-trading/OpenPositionsTable';
import { RecentTradesTable } from '@/components/live-trading/RecentTradesTable';
import { SleeveCards } from '@/components/live-trading/SleeveCards';

export default function LiveTradingPage() {
  const curve = trpc.dashboard.book.equityCurve.useQuery(undefined, { refetchInterval: 30_000 });
  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <h1 className="text-3xl font-bold">Paper Fleet — Live Book</h1>
      <BookHeader />
      <section className="rounded-lg border border-gray-800 p-4">
        <h2 className="text-lg font-semibold mb-2">Combined equity (crypto series)</h2>
        <EquityCurveChart points={curve.data?.crypto ?? []} />
      </section>
      <SleeveCards />
      <OpenPositionsTable />
      <RecentTradesTable />
    </main>
  );
}
