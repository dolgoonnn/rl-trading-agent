'use client';

import { trpc } from '@/lib/trpc/client';
import type { TrafficLight, Verdict } from '@/lib/gold-workflow/types';

const LIGHT_BG: Record<TrafficLight, string> = {
  green: 'bg-emerald-500/10 border-emerald-500/30',
  amber: 'bg-amber-500/10 border-amber-500/30',
  red: 'bg-red-500/10 border-red-500/30',
};

const LIGHT_DOT: Record<TrafficLight, string> = {
  green: 'bg-emerald-400',
  amber: 'bg-amber-400',
  red: 'bg-red-400',
};

const VERDICT_STYLE: Record<Verdict, string> = {
  TRADE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  WAIT: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  SKIP: 'bg-red-500/15 text-red-300 border-red-500/40',
};

function fmtPrice(n: number): string {
  return n.toFixed(2);
}

function Row({
  title,
  light,
  note,
  detail,
}: {
  title: string;
  light: TrafficLight;
  note: string;
  detail?: string;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${LIGHT_BG[light]}`}>
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${LIGHT_DOT[light]}`} />
        <span className="text-xs font-semibold text-zinc-100">{title}</span>
      </div>
      <div className="mt-1 text-[11px] text-zinc-300">{note}</div>
      {detail ? <div className="mt-0.5 text-[10px] font-mono text-zinc-500">{detail}</div> : null}
    </div>
  );
}

export function GoldContextPanel({ symbol }: { symbol: string }) {
  const q = trpc.dashboard.goldContext.get.useQuery(
    { symbol },
    { refetchInterval: 60_000 },
  );

  if (q.isLoading) return null;
  const data = q.data;
  if (!data || !data.applicable) return null;
  const c = data.context;

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-zinc-400">Gold context</span>
        <div className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${VERDICT_STYLE[c.verdict]}`}>
          {c.verdict} · {c.verdictReason}
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <Row
          title="Midnight Open (PO3)"
          light={c.midnightOpen.light}
          note={c.midnightOpen.note}
          detail={`anchor ${fmtPrice(c.midnightOpen.price)} · ${c.midnightOpen.priceVsMidnight}`}
        />
        <Row
          title="Asian Range / Judas"
          light={c.asianRange.light}
          note={c.asianRange.note}
          detail={`H ${fmtPrice(c.asianRange.high)}${c.asianRange.highSwept ? ' ✓' : ''} · L ${fmtPrice(
            c.asianRange.low,
          )}${c.asianRange.lowSwept ? ' ✓' : ''} · judas ${c.asianRange.judasComplete ? 'done' : 'pending'}`}
        />
        <Row
          title="DXY Inversion"
          light={c.dxy.light}
          note={c.dxy.note}
          detail={`DXY ${c.dxy.dxyBias} → gold ${c.dxy.goldImpliedBias} · ${
            c.dxy.alignedWithGold ? 'aligned' : 'conflict'
          }`}
        />
        <Row
          title="USD News"
          light={c.news.light}
          note={c.news.note}
          detail={
            c.news.todayEvents.length === 0
              ? 'no high-impact today'
              : c.news.todayEvents.map((e) => `${e.time} ${e.name}`).join(' · ')
          }
        />
      </div>
    </section>
  );
}
