interface Props {
  winRate: number;
  totalTrades: number;
  sharpe: number;
  source: string;
}

export function StatsBadge({ winRate, totalTrades, sharpe, source }: Props) {
  return (
    <div
      className="inline-flex items-baseline gap-2 rounded-md border border-blue-700/40 bg-blue-900/30 px-2 py-1 text-xs text-blue-200"
      title={`Source: ${source}`}
    >
      <span className="font-mono">{(winRate * 100).toFixed(1)}% WR</span>
      <span className="opacity-70">·</span>
      <span className="font-mono">{totalTrades} trades</span>
      <span className="opacity-70">·</span>
      <span className="font-mono">Sharpe {sharpe.toFixed(2)}</span>
    </div>
  );
}
