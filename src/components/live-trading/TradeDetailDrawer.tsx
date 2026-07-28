'use client';

import { useEffect } from 'react';
import { trpc } from '@/lib/trpc/client';
import { formatUsd, formatPnlPct } from '@/lib/bot/format';

function fmtTs(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function fmtPrice(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function WaterfallBar({ label, value }: { label: string; value: number }) {
  const isNeg = value < 0;
  const width = Math.min(100, Math.abs(value) * 100);
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-center justify-between text-[11px]">
        <span className="text-zinc-400">{label}</span>
        <span className={`font-mono ${isNeg ? 'text-red-400' : 'text-emerald-400'}`}>{formatPnlPct(value * 100)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-800/60">
        <div
          className={`h-full rounded ${isNeg ? 'bg-red-400/70' : 'bg-emerald-400/70'}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

export function TradeDetailDrawer({ tradeId, onClose }: { tradeId: string | null; onClose: () => void }) {
  const q = trpc.dashboard.book.tradeDetail.useQuery({ id: tradeId ?? '' }, { enabled: tradeId !== null });

  useEffect(() => {
    if (tradeId === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tradeId, onClose]);

  if (tradeId === null) return null;

  const data = q.data;
  const hasLevels = data && (data.stopLoss !== null || data.takeProfit !== null || data.riskAmountUsdt !== null);
  const hasWaterfall = data && data.netReturn !== null;
  const hasFactors = data && data.factors !== null;
  const maxFactorValue = hasFactors && data.factors ? Math.max(...data.factors.map((f) => f.value), 0) : 0;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Trade detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Close
          </button>
        </div>

        {q.isLoading ? (
          <div className="space-y-2">
            <div className="h-6 animate-pulse rounded bg-zinc-800/60" />
            <div className="h-24 animate-pulse rounded bg-zinc-800/60" />
            <div className="h-24 animate-pulse rounded bg-zinc-800/60" />
          </div>
        ) : q.error ? (
          <p className="text-sm text-red-300">Failed to load trade: {q.error.message}</p>
        ) : !data || data.found === false ? (
          <p className="text-sm text-zinc-500">Trade not found.</p>
        ) : (
          <div className="space-y-4">
            {/* Header */}
            <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-lg text-zinc-100">{data.symbol}</span>
                <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[11px] text-zinc-300">
                  {data.sleeve}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-sm">
                <span className={data.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                  {data.direction === '—' ? data.direction : data.direction.toUpperCase()}
                </span>
                {data.exitReason ? <span className="text-zinc-500">· {data.exitReason}</span> : null}
              </div>
              <p className={`mt-2 text-2xl font-bold font-mono ${data.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {formatPnlPct(data.pnlPct)}
              </p>
              {data.pnlUsdt !== null ? (
                <p className="mt-0.5 text-xs text-zinc-500">{formatUsd(data.pnlUsdt)}</p>
              ) : null}
            </section>

            {/* Levels & risk */}
            {hasLevels ? (
              <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-400">Levels & risk</h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div>
                    <span className="text-zinc-500">Entry</span>
                    <p className="font-mono text-zinc-200">{fmtPrice(data.entryPrice)}</p>
                  </div>
                  <div>
                    <span className="text-zinc-500">Exit</span>
                    <p className="font-mono text-zinc-200">{fmtPrice(data.exitPrice)}</p>
                  </div>
                  <div>
                    <span className="text-zinc-500">Stop loss</span>
                    <p className="font-mono text-zinc-200">{fmtPrice(data.stopLoss)}</p>
                  </div>
                  <div>
                    <span className="text-zinc-500">Take profit</span>
                    <p className="font-mono text-zinc-200">{fmtPrice(data.takeProfit)}</p>
                  </div>
                  <div>
                    <span className="text-zinc-500">Position size</span>
                    <p className="font-mono text-zinc-200">
                      {data.positionSizeUsdt !== null ? formatUsd(data.positionSizeUsdt) : '—'}
                    </p>
                  </div>
                  <div>
                    <span className="text-zinc-500">Risk</span>
                    <p className="font-mono text-zinc-200">
                      {data.riskAmountUsdt !== null ? formatUsd(data.riskAmountUsdt) : '—'}
                    </p>
                  </div>
                  <div>
                    <span className="text-zinc-500">R-multiple</span>
                    <p className="font-mono text-zinc-200">
                      {data.rMultiple !== null ? `${data.rMultiple.toFixed(2)}R` : '—'}
                    </p>
                  </div>
                </div>
              </section>
            ) : null}

            {/* PnL waterfall */}
            {hasWaterfall && data.netReturn !== null ? (
              <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <h3 className="mb-3 text-xs uppercase tracking-wider text-zinc-400">PnL waterfall</h3>
                {data.grossReturn !== null ? <WaterfallBar label="Gross" value={data.grossReturn} /> : null}
                {data.frictionReturn !== null ? <WaterfallBar label="Friction" value={data.frictionReturn} /> : null}
                {data.fundingReturn !== null ? <WaterfallBar label="Funding" value={data.fundingReturn} /> : null}
                <WaterfallBar label="Net" value={data.netReturn} />
                {data.fundingPaidUsdt !== null ? (
                  <p className="mt-1 text-[11px] text-zinc-500">Funding paid: {formatUsd(data.fundingPaidUsdt)}</p>
                ) : null}
              </section>
            ) : null}

            {/* Confluence factors */}
            {hasFactors && data.factors ? (
              <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs uppercase tracking-wider text-zinc-400">Confluence factors</h3>
                  {data.confluenceScore !== null ? (
                    <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[11px] font-mono text-zinc-300">
                      score {data.confluenceScore.toFixed(2)}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {data.factors.map((f) => (
                    <div key={f.name}>
                      <div className="mb-0.5 flex items-center justify-between text-[11px]">
                        <span className="text-zinc-400">{f.name}</span>
                        <span className="font-mono text-zinc-300">{f.value.toFixed(2)}</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-800/60">
                        <div
                          className="h-full rounded bg-cyan-400/70"
                          style={{ width: `${maxFactorValue > 0 ? (f.value / maxFactorValue) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : !hasFactors && data.sleeve !== 'crypto' ? (
              <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <p className="text-xs text-zinc-500">
                  Limited detail for this sleeve — the {data.sleeve} bot stores summary trades only.
                </p>
              </section>
            ) : null}

            {/* Meta */}
            <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
              <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-400">Meta</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                {data.regime !== null ? (
                  <div>
                    <span className="text-zinc-500">Regime</span>
                    <p className="text-zinc-200">{data.regime}</p>
                  </div>
                ) : null}
                {data.barsHeld !== null ? (
                  <div>
                    <span className="text-zinc-500">Bars held</span>
                    <p className="font-mono text-zinc-200">{data.barsHeld}</p>
                  </div>
                ) : null}
                <div>
                  <span className="text-zinc-500">Entry time</span>
                  <p className="text-zinc-200">{fmtTs(data.entryTimestamp)}</p>
                </div>
                <div>
                  <span className="text-zinc-500">Exit time</span>
                  <p className="text-zinc-200">{fmtTs(data.exitTimestamp)}</p>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
