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

// Convention: stored pnl/return fields (pnlPct, grossReturn, frictionReturn,
// fundingReturn, netReturn) are FRACTIONS (e.g. 0.0271 = 2.71%). Always
// multiply by 100 before passing to formatPnlPct.

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

type DetailLike = {
  sleeve: string;
  symbol: string;
  exitReason: string | null;
  confluenceScore: number | null;
  regime: string | null;
};

/**
 * Plain-language reason the position was opened.
 *
 * The session legs are the non-obvious case: their edge IS the clock window
 * (research found gold's intraday return concentrates 22:00-07:00 UTC while the
 * US session is a net drag), so "why did it enter at 22:00?" has a real answer
 * that the numbers alone never conveyed.
 */
function explainEntry(d: DetailLike): string {
  if (d.sleeve === 'crypto') {
    const score = d.confluenceScore !== null ? `confluence ${d.confluenceScore.toFixed(2)}` : 'confluence signal';
    const regime = d.regime ? ` in ${d.regime}` : '';
    return `An order block cleared the ${score} threshold${regime}. Factor detail is below.`;
  }
  if (d.sleeve === 'gold') {
    return 'The daily F2F momentum signal crossed its activation threshold and the regime filter allowed entry.';
  }
  const leg = d.symbol;
  if (leg.startsWith('overnight')) return 'Overnight session leg: gold drifts up between 22:00 and 07:00 UTC, which is where its intraday return concentrates.';
  if (leg.startsWith('weekend')) return 'Weekend leg: enters Friday evening to capture the weekend gap, exits Monday morning.';
  if (leg.startsWith('fix-short')) return 'London PM fix leg: shorts into the 15:00 London fix window.';
  if (leg.startsWith('agfix')) return 'Silver own-fix leg: shorts into silver’s noon London fix.';
  if (leg.startsWith('amfix')) return 'AM fix bounce leg: long into the 11:30 London morning fix.';
  if (leg.startsWith('eur-morning')) return 'EUR morning leg: shorts the European morning window, closing at 12:00 UTC.';
  if (leg.startsWith('eur-h22')) return 'EUR late leg: long into the 23:00 UTC close.';
  if (leg.startsWith('us500')) return 'US500 overnight leg: holds the index gap into the NY cash open.';
  return 'Scheduled session leg — the entry time itself is the signal.';
}

/** Plain-language reason the position closed. */
function explainExit(d: DetailLike): string {
  const r = d.exitReason ?? '';
  if (r === 'take_profit') return 'Price reached the take-profit level.';
  if (r === 'stop_loss') return 'Price hit the stop loss.';
  if (r === 'shutdown') return 'Force-closed when the bot restarted — not a strategy exit.';
  if (r.startsWith('stale')) return 'Held past its normal window while the bot was down, then flattened. Flagged as drift, not strategy.';
  if (r === 'timeout' || r === 'max_bars') return 'Hit the maximum holding period without reaching either target.';
  if (d.sleeve === 'metals') {
    return 'The session window ended. These legs exit on the clock regardless of profit — holding past the window was tested and performs worse.';
  }
  if (d.sleeve === 'gold') return 'The daily signal flipped or the regime filter turned the position off.';
  return r ? `Exit reason: ${r}.` : 'Closed on its scheduled exit condition.';
}

function formatHold(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`;
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
  const hasLevels =
    data &&
    (data.entryPrice !== null ||
      data.exitPrice !== null ||
      data.stopLoss !== null ||
      data.takeProfit !== null ||
      data.riskAmountUsdt !== null);
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
                {formatPnlPct(data.pnlPct * 100)}
              </p>
              {data.pnlUsdt !== null ? (
                <p className="mt-0.5 text-xs text-zinc-500">{formatUsd(data.pnlUsdt)}</p>
              ) : null}
            </section>

            {/* Why this trade happened, and why it ended — the two questions a
                detail view exists to answer. Both are derivable from the leg and
                the exit reason; neither was shown before. */}
            <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
              <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-400">Why</h3>
              <dl className="space-y-2 text-xs">
                <div>
                  <dt className="text-zinc-500">Entered because</dt>
                  <dd className="mt-0.5 leading-snug text-zinc-300">{explainEntry(data)}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Closed because</dt>
                  <dd className="mt-0.5 leading-snug text-zinc-300">{explainExit(data)}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Held</dt>
                  <dd className="mt-0.5 font-mono text-zinc-300">
                    {formatHold(data.exitTimestamp - data.entryTimestamp)}
                  </dd>
                </div>
              </dl>
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
