'use client';

import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { BiasBadge } from './BiasBadge';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
const TIMEFRAMES = ['1H', '4H', '1D'] as const;

export function BiasGrid() {
  const q = trpc.dashboard.bias.scan.useQuery(
    { symbols: [...SYMBOLS], timeframes: [...TIMEFRAMES] },
    { refetchInterval: 30_000 },
  );

  if (q.isLoading) return <div className="p-6 text-zinc-400">loading bias…</div>;
  if (q.isError) return <div className="p-6 text-red-400">error: {q.error.message}</div>;
  const data = q.data;
  if (!data || !data.available) {
    return <div className="p-6 text-zinc-400">no data — bot not running?</div>;
  }

  const cellMap = new Map<string, typeof data.cells[number]>();
  for (const c of data.cells) cellMap.set(`${c.symbol}|${c.timeframe}`, c);

  const lastUpdate = Math.max(0, ...data.cells.map((c) => c.lastUpdated));
  const ageSec = lastUpdate ? Math.floor((Date.now() - lastUpdate) / 1000) : null;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between text-sm text-zinc-400">
        <h2 className="text-lg font-semibold text-zinc-100">HTF Bias Scanner</h2>
        <span>{ageSec !== null ? `last bar ${ageSec}s ago` : 'no candle data'}</span>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wider text-zinc-500">
            <th className="px-3 py-2 font-medium">Symbol</th>
            {TIMEFRAMES.map((tf) => (
              <th key={tf} className="px-3 py-2 font-medium">{tf}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SYMBOLS.map((sym) => (
            <tr key={sym} className="border-b border-zinc-900 hover:bg-zinc-900/40">
              <td className="px-3 py-3">
                <Link href={`/dashboard/setup/${sym}`} className="font-mono text-zinc-100 hover:text-blue-300">
                  {sym}
                </Link>
              </td>
              {TIMEFRAMES.map((tf) => {
                const cell = cellMap.get(`${sym}|${tf}`);
                if (!cell) return <td key={tf} className="px-3 py-3 text-xs text-zinc-600">—</td>;
                return (
                  <td key={tf} className="px-3 py-3">
                    <BiasBadge regime={cell.regime} volRegime={cell.volRegime} confidence={cell.confidence} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
