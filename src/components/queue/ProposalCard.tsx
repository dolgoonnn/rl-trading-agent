'use client';

import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import type { ProposalReasoning } from '@/lib/queue/proposal-generator';

interface Props {
  proposal: {
    id: string;
    symbol: string;
    side: 'long' | 'short';
    score: number;
    threshold: number;
    rrRatio: number;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    regime: string;
    strategy: string;
    reasoning: ProposalReasoning;
    caveats: string[];
    createdAt: number;
  };
  blocked: boolean;
  blockedReason: string | null;
  onDecision?: () => void;
}

export function ProposalCard({ proposal, blocked, blockedReason, onDecision }: Props) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = trpc.dashboard.queue.decide.useMutation({
    onSuccess: (res) => {
      setBusy(false);
      if (!res.ok) {
        setError(res.error ?? 'decision failed');
        return;
      }
      setReason('');
      setError(null);
      onDecision?.();
    },
    onError: (err) => {
      setBusy(false);
      setError(err.message);
    },
  });

  const handle = (decision: 'approved' | 'rejected' | 'snoozed') => {
    if (reason.trim().length < 3) {
      setError('reason required (min 3 chars)');
      return;
    }
    setBusy(true);
    setError(null);
    decide.mutate({
      id: proposal.id,
      decision,
      reason: reason.trim(),
      snoozeMinutes: decision === 'snoozed' ? 30 : undefined,
    });
  };

  const sideColor = proposal.side === 'long' ? 'text-emerald-300' : 'text-red-300';
  const borderColor =
    proposal.side === 'long' ? 'border-emerald-700/40' : 'border-red-700/40';
  const ageMin = Math.floor((Date.now() - proposal.createdAt) / 60_000);
  const bucket = proposal.reasoning.bucketStats;

  return (
    <div className={`rounded-lg border ${borderColor} bg-zinc-900/60 p-4`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold text-zinc-100">{proposal.symbol}</span>
          <span className={`text-sm font-mono uppercase ${sideColor}`}>{proposal.side}</span>
          <span className="text-xs text-zinc-500">· {proposal.strategy}</span>
        </div>
        <div className="text-right text-xs text-zinc-500">
          score <span className="font-mono text-zinc-200">{proposal.score.toFixed(2)}</span>
          <span className="text-zinc-600"> / {proposal.threshold.toFixed(2)}</span>
          <span className="ml-2">R:R <span className="font-mono text-zinc-200">{proposal.rrRatio.toFixed(2)}</span></span>
          <span className="ml-2 text-zinc-600">{ageMin}m ago</span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 rounded bg-zinc-950/40 px-3 py-2 text-xs">
        <div>
          <div className="text-[10px] uppercase text-zinc-500">entry</div>
          <div className="font-mono text-zinc-100">{proposal.entry.toFixed(4)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-zinc-500">stop</div>
          <div className="font-mono text-red-300">{proposal.stopLoss.toFixed(4)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-zinc-500">target</div>
          <div className="font-mono text-emerald-300">{proposal.takeProfit.toFixed(4)}</div>
        </div>
      </div>

      {proposal.reasoning.topFactors.length > 0 && (
        <div className="mt-2 text-xs">
          <span className="text-zinc-500">why: </span>
          {proposal.reasoning.topFactors.map((f, i) => (
            <span key={f.factor} className="font-mono text-zinc-300">
              {f.factor} +{f.value.toFixed(2)}
              {i < proposal.reasoning.topFactors.length - 1 ? ' · ' : ''}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">odds (live, last 90d)</div>
        {bucket ? (
          <div className="mt-1 font-mono text-zinc-200">
            score {bucket.bucket}: <span className="text-emerald-300">{(bucket.winRate * 100).toFixed(1)}%</span> WR
            · n={bucket.n} · avg pnl
            <span className={bucket.meanPnlPct >= 0 ? ' text-emerald-300' : ' text-red-300'}>
              {' '}{(bucket.meanPnlPct * 100).toFixed(2)}%
            </span>
          </div>
        ) : (
          <div className="mt-1 text-zinc-500">no live history for this score band</div>
        )}
        <div className="mt-0.5 text-[10px] text-zinc-600">regime: {proposal.regime}</div>
      </div>

      {proposal.caveats.length > 0 && (
        <ul className="mt-2 space-y-1">
          {proposal.caveats.map((c, i) => {
            const isPositive = c.startsWith('✓');
            const isCritical = c.startsWith('⚠');
            const text = c.replace(/^[✓⚠]\s*/, '');
            const cls = isPositive
              ? 'rounded border border-emerald-900/40 bg-emerald-950/20 px-3 py-1.5 text-[11px] text-emerald-200'
              : isCritical
                ? 'rounded border border-red-900/50 bg-red-950/30 px-3 py-1.5 text-[11px] text-red-200'
                : 'rounded border border-amber-900/40 bg-amber-950/20 px-3 py-1.5 text-[11px] text-amber-200';
            const prefix = isPositive ? '✓ ' : isCritical ? '⚠ ' : '· ';
            return (
              <li key={i} className={cls}>
                {prefix}
                {text}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 space-y-2">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason (required) — why are you taking or skipping this?"
          rows={2}
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        {error && <div className="text-[11px] text-red-400">{error}</div>}
        {blocked && (
          <div className="rounded bg-red-950/30 px-2 py-1 text-[11px] text-red-300">
            🛑 risk gate blocks new trades: {blockedReason}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            disabled={busy || blocked}
            onClick={() => handle('approved')}
            className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            Approve → execute
          </button>
          <button
            disabled={busy}
            onClick={() => handle('rejected')}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            Reject
          </button>
          <button
            disabled={busy}
            onClick={() => handle('snoozed')}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            Snooze 30m
          </button>
          <Link
            href={`/dashboard/setup/${proposal.symbol}`}
            className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            chart →
          </Link>
        </div>
      </div>
    </div>
  );
}
