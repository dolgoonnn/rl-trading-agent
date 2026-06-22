'use client';

import { trpc } from '@/lib/trpc/client';
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
  symbol?: string;
  regime?: string;
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

const STRATEGY_TO_BOT_KEY: Record<string, string> = {
  'ict-3sym': 'order_block',
  'f2f-gold': 'asian_range_gold',
};

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function SetupCard({ data, stats, decay }: Props) {
  const sideColor = data.side === 'long' ? 'border-green-700/50' : 'border-red-700/50';
  const sideText = data.side === 'long' ? 'text-green-300' : 'text-red-300';

  // Mechanism: top contributors to the score
  const topFactors = [...data.scoreBreakdown]
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .filter((f) => f.value > 0);

  // Risk-reward (Mechanism + Actionability)
  const risk = Math.abs(data.entryPrice - data.stopLoss);
  const reward = Math.abs(data.takeProfit - data.entryPrice);
  const rr = risk > 0 ? reward / risk : 0;

  // Evidence: live performance of similar-scored setups
  const botKey = STRATEGY_TO_BOT_KEY[data.strategyId] ?? data.strategyId;
  const liveStatsQ = trpc.dashboard.liveStats.byScoreBucket.useQuery({
    strategy: botKey,
    score: data.confluenceScore,
    windowDays: 90,
  });
  const matched = liveStatsQ.data?.matchedBucket ?? null;
  const totalRecent = liveStatsQ.data?.totalTrades ?? 0;

  // Caveats: low sample size, regime mismatch, decay
  const caveats: string[] = [];
  if (matched && matched.n < 10) caveats.push(`only ${matched.n} similar trades in last 90d — wide uncertainty`);
  if (data.regime && /ranging\+(normal|high)|downtrend\+high/.test(data.regime)) {
    caveats.push(`regime ${data.regime} is in suppress list (Run 20)`);
  }
  if (decay?.tripped) caveats.push(`decay tripped: ${decay.reason ?? 'edge unstable'}`);

  return (
    <div className={`rounded-lg border ${sideColor} bg-zinc-900/60 p-4 space-y-3`}>
      {/* INTENT FIDELITY: what is the setup, in user's terms */}
      <div className="flex items-center justify-between">
        <div>
          <span className="font-mono text-sm uppercase tracking-wide text-zinc-100">{data.setupType}</span>
          <span className={`ml-2 font-mono text-xs ${sideText}`}>{data.side.toUpperCase()}</span>
        </div>
        <span className="font-mono text-sm text-zinc-300">score {data.confluenceScore.toFixed(2)}</span>
      </div>

      {/* ACTIONABILITY: levels + R:R */}
      <div className="grid grid-cols-4 gap-2 rounded bg-zinc-950/40 px-3 py-2 text-xs">
        <div>
          <div className="text-[10px] uppercase text-zinc-500">entry</div>
          <div className="font-mono text-zinc-200">{data.entryPrice.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-zinc-500">stop</div>
          <div className="font-mono text-red-300">{data.stopLoss.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-zinc-500">target</div>
          <div className="font-mono text-green-300">{data.takeProfit.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-zinc-500">R:R</div>
          <div className={`font-mono ${rr >= 2 ? 'text-emerald-300' : rr >= 1 ? 'text-amber-300' : 'text-red-300'}`}>
            {rr.toFixed(2)}
          </div>
        </div>
      </div>

      {/* MECHANISM CLARITY: why this score */}
      {topFactors.length > 0 && (
        <div className="text-xs">
          <span className="text-zinc-500">why: </span>
          {topFactors.map((f, i) => (
            <span key={f.factor} className="font-mono text-zinc-300">
              {f.factor} +{f.value.toFixed(2)}
              {i < topFactors.length - 1 ? ' · ' : ''}
            </span>
          ))}
        </div>
      )}

      {/* UNCERTAINTY HANDLING: live odds with stderr */}
      <div className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">historical odds (live, last 90d)</div>
        {liveStatsQ.isLoading ? (
          <div className="text-zinc-500">loading…</div>
        ) : matched && matched.n > 0 ? (
          <div className="mt-1 space-y-0.5 font-mono text-zinc-200">
            <div>
              score {matched.bucket}: <span className="text-emerald-300">{pct(matched.winRate)}</span> WR
              <span className="text-zinc-500"> ± {pct(matched.winRateStderr)}</span> · n={matched.n}
            </div>
            <div className="text-zinc-400">
              avg pnl <span className={matched.meanPnlPct >= 0 ? 'text-emerald-300' : 'text-red-300'}>
                {(matched.meanPnlPct * 100).toFixed(2)}%
              </span>
              <span className="text-zinc-500"> ± {(matched.meanPnlPctStderr * 100).toFixed(2)}%</span>
              · {matched.meanBarsHeld.toFixed(0)} bars
            </div>
          </div>
        ) : (
          <div className="mt-1 text-zinc-500">
            no similar-scored trades in last 90d ({totalRecent} total live trades)
          </div>
        )}
      </div>

      {/* EVIDENCE COVERAGE: validated stats badge + decay */}
      <div className="flex flex-wrap items-center gap-2">
        {stats && (
          <StatsBadge
            winRate={stats.winRate}
            totalTrades={stats.totalTrades}
            sharpe={stats.sharpe}
            source={stats.source}
          />
        )}
        {decay && <DecayBadge tripped={decay.tripped} reason={decay.reason} />}
      </div>

      {/* RESPONSE STRUCTURE: caveats surfaced explicitly, not buried */}
      {caveats.length > 0 && (
        <ul className="space-y-1 rounded border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
          {caveats.map((c, i) => (
            <li key={i}>⚠ {c}</li>
          ))}
        </ul>
      )}

      {/* breakdown stays available but secondary */}
      <details>
        <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">full score breakdown</summary>
        <ul className="mt-2 space-y-1 text-xs">
          {data.scoreBreakdown.map((b) => (
            <li key={b.factor} className="flex justify-between font-mono text-zinc-400">
              <span>{b.factor}</span>
              <span>{b.value.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
