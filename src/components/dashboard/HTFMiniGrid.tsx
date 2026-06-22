'use client';

import { trpc } from '@/lib/trpc/client';
import { BiasBadge } from './BiasBadge';

const TIMEFRAMES = ['1H', '4H', '1D'] as const;

interface Props {
  symbol: string;
  /** When provided, shows whether each TF aligns with the proposed setup direction. */
  setupSide?: 'long' | 'short' | null;
}

export function HTFMiniGrid({ symbol, setupSide = null }: Props) {
  const q = trpc.dashboard.bias.scan.useQuery(
    { symbols: [symbol], timeframes: [...TIMEFRAMES] },
    { refetchInterval: 30_000 },
  );

  if (q.isLoading) return <div className="text-xs text-zinc-500">loading bias…</div>;
  if (q.isError || !q.data?.available) return null;

  const cellMap = new Map<string, (typeof q.data.cells)[number]>();
  for (const c of q.data.cells) cellMap.set(c.timeframe, c);

  function alignment(regime: string): 'aligned' | 'mismatch' | 'neutral' {
    if (!setupSide || regime === 'unknown' || regime === 'ranging') return 'neutral';
    const isUp = regime === 'uptrend';
    return (isUp && setupSide === 'long') || (!isUp && setupSide === 'short') ? 'aligned' : 'mismatch';
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs uppercase tracking-wider text-zinc-500">HTF bias</span>
      {TIMEFRAMES.map((tf) => {
        const cell = cellMap.get(tf);
        if (!cell) return null;
        const a = alignment(cell.regime);
        const ringColor =
          a === 'aligned'
            ? 'ring-green-500/40'
            : a === 'mismatch'
              ? 'ring-red-500/40'
              : 'ring-transparent';
        return (
          <div key={tf} className={`rounded-md ring-1 ${ringColor} ring-offset-1 ring-offset-zinc-950`}>
            <div className="text-[10px] text-zinc-500">{tf}</div>
            <BiasBadge regime={cell.regime} volRegime={cell.volRegime} confidence={cell.confidence} />
          </div>
        );
      })}
    </div>
  );
}
