'use client';

interface RiskState {
  equityUsdt: number;
  dailyPnlUsdt: number;
  dailyPnlPct: number;
  riskUsedPct: number;
  riskLimitPct: number;
  tradesTodayCount: number;
  tradesTodayLimit: number;
  openPositions: number;
  maxOpenPositions: number;
  blocked: boolean;
  blockedReason: string | null;
}

export function RiskStrip({ risk }: { risk: RiskState | null }) {
  if (!risk) {
    return (
      <div className="border-b border-zinc-800 bg-zinc-950 px-4 py-2 text-xs text-zinc-500">
        risk gate: no data
      </div>
    );
  }
  const pnlColor =
    risk.dailyPnlPct > 0 ? 'text-emerald-400' : risk.dailyPnlPct < 0 ? 'text-red-400' : 'text-zinc-300';
  const riskColor =
    risk.riskUsedPct < risk.riskLimitPct * 0.5
      ? 'text-emerald-400'
      : risk.riskUsedPct < risk.riskLimitPct
        ? 'text-amber-400'
        : 'text-red-400';
  const tradesColor =
    risk.tradesTodayCount < risk.tradesTodayLimit ? 'text-zinc-200' : 'text-red-400';

  return (
    <div
      className={`sticky top-0 z-20 border-b px-4 py-2 text-xs ${
        risk.blocked ? 'border-red-700/60 bg-red-950/40' : 'border-zinc-800 bg-zinc-950/95 backdrop-blur'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <div>
          <span className="text-zinc-500">equity </span>
          <span className="font-mono text-zinc-100">${risk.equityUsdt.toFixed(2)}</span>
        </div>
        <div>
          <span className="text-zinc-500">today </span>
          <span className={`font-mono ${pnlColor}`}>
            {risk.dailyPnlPct >= 0 ? '+' : ''}{risk.dailyPnlPct.toFixed(2)}% (
            {risk.dailyPnlUsdt >= 0 ? '+' : ''}${risk.dailyPnlUsdt.toFixed(2)})
          </span>
        </div>
        <div>
          <span className="text-zinc-500">risk </span>
          <span className={`font-mono ${riskColor}`}>
            {risk.riskUsedPct.toFixed(2)}% / {risk.riskLimitPct.toFixed(1)}%
          </span>
        </div>
        <div>
          <span className="text-zinc-500">trades </span>
          <span className={`font-mono ${tradesColor}`}>
            {risk.tradesTodayCount}/{risk.tradesTodayLimit}
          </span>
        </div>
        <div>
          <span className="text-zinc-500">positions </span>
          <span className="font-mono text-zinc-200">
            {risk.openPositions}/{risk.maxOpenPositions}
          </span>
        </div>
        {risk.blocked && (
          <div className="ml-auto rounded bg-red-700/30 px-2 py-0.5 font-semibold text-red-200">
            🛑 BLOCKED · {risk.blockedReason}
          </div>
        )}
      </div>
    </div>
  );
}
