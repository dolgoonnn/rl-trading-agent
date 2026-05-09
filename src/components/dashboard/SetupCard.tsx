import { StatsBadge } from './StatsBadge';
import { DecayBadge } from './DecayBadge';

export interface SetupCardData {
  setupType: string;
  side: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confluenceScore: number;
  scoreBreakdown: Array<{ factor: string; value: number }>;
  strategyId: 'ict-3sym' | 'f2f-gold' | 'funding-arb' | string;
}

export interface SetupCardStats {
  winRate: number;
  totalTrades: number;
  sharpe: number;
  source: string;
}

export interface SetupCardDecay {
  tripped: boolean;
  reason?: string;
}

interface Props {
  data: SetupCardData;
  stats: SetupCardStats | null;
  decay: SetupCardDecay | null;
}

export function SetupCard({ data, stats, decay }: Props) {
  const sideColor = data.side === 'long' ? 'border-green-700/50' : 'border-red-700/50';

  return (
    <div className={`rounded-lg border ${sideColor} bg-zinc-900/60 p-4`}>
      {/* Header: Setup Type, Side, Confluence Score */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <span className="font-mono text-sm uppercase tracking-wide text-zinc-100">
            {data.setupType}
          </span>
          <span
            className={`ml-2 font-mono text-xs ${
              data.side === 'long' ? 'text-green-300' : 'text-red-300'
            }`}
          >
            {data.side.toUpperCase()}
          </span>
        </div>
        <span className="font-mono text-sm text-zinc-300">
          score {data.confluenceScore.toFixed(2)}
        </span>
      </div>

      {/* Price Levels: Entry, SL, TP */}
      <div className="mb-3 grid grid-cols-3 gap-3 text-xs text-zinc-400">
        <div>
          entry{' '}
          <span className="font-mono text-zinc-200">{data.entryPrice.toFixed(2)}</span>
        </div>
        <div>
          SL <span className="font-mono text-red-300">{data.stopLoss.toFixed(2)}</span>
        </div>
        <div>
          TP <span className="font-mono text-green-300">{data.takeProfit.toFixed(2)}</span>
        </div>
      </div>

      {/* Confluence Breakdown (collapsible) */}
      <details className="mb-3">
        <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
          confluence breakdown
        </summary>
        <ul className="mt-2 space-y-1 text-xs">
          {data.scoreBreakdown.map((b) => (
            <li
              key={b.factor}
              className="flex justify-between font-mono text-zinc-400"
            >
              <span>{b.factor}</span>
              <span>{b.value.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      </details>

      {/* Stats and Decay Badges */}
      <div className="flex flex-wrap items-center gap-2">
        {stats ? (
          <StatsBadge
            winRate={stats.winRate}
            totalTrades={stats.totalTrades}
            sharpe={stats.sharpe}
            source={stats.source}
          />
        ) : (
          <span className="text-xs text-zinc-500">validated stats unavailable</span>
        )}
        {decay && <DecayBadge tripped={decay.tripped} reason={decay.reason} />}
      </div>
    </div>
  );
}
