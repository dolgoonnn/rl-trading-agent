interface Props {
  regime: string;
  volRegime: string;
  confidence: number;
}

const COLOR: Record<string, string> = {
  uptrend: 'bg-green-700/40 text-green-200 border-green-600/40',
  downtrend: 'bg-red-700/40 text-red-200 border-red-600/40',
  ranging: 'bg-zinc-700/40 text-zinc-200 border-zinc-600/40',
  unknown: 'bg-zinc-800/40 text-zinc-400 border-zinc-700/40',
};

export function BiasBadge({ regime, volRegime, confidence }: Props) {
  const cls = COLOR[regime] ?? COLOR.unknown;
  return (
    <div className={`inline-flex flex-col gap-0.5 rounded-md border px-2 py-1 text-xs ${cls}`}>
      <span className="font-mono uppercase tracking-wide">{regime}</span>
      <span className="text-[10px] opacity-70">vol {volRegime} · conf {(confidence * 100).toFixed(0)}%</span>
    </div>
  );
}
