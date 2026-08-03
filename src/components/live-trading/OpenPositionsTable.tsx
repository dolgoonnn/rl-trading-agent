'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { formatUsd, formatPnlPct } from '@/lib/bot/format';

/**
 * Open positions as CARDS with live progress, not a static row of entry prices.
 *
 * A trader's most urgent question is "how is my open position doing right now?"
 * Two kinds of answer, because the sleeves work differently:
 *   - crypto: marked to the latest close, with the stop and target as rails
 *   - session legs: no stop or target exists — the clock window IS the strategy,
 *     so progress is elapsed-vs-window and the useful number is time remaining.
 * Click a card to expand the full detail rather than leaving it uninspectable.
 */
export function OpenPositionsTable() {
  const q = trpc.dashboard.book.positions.useQuery(undefined, { refetchInterval: 30_000 });
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold text-zinc-100">Open positions</h2>

      {q.isLoading ? (
        <div className="h-20 animate-pulse rounded bg-zinc-800/60" />
      ) : q.error ? (
        <p className="text-sm text-red-300">Failed to load positions: {q.error.message}</p>
      ) : !q.data || q.data.length === 0 ? (
        <p className="text-sm text-zinc-500">No open positions — nothing at risk right now.</p>
      ) : (
        <div className="space-y-2">
          {q.data.map((p, i) => {
            const expanded = openIdx === i;
            const heldMs = p.entryTimestamp ? Date.now() - p.entryTimestamp : 0;
            const pnlTone =
              p.unrealizedPct === null
                ? 'text-zinc-400'
                : p.unrealizedPct >= 0
                  ? 'text-emerald-400'
                  : 'text-red-400';

            return (
              <div key={`${p.sleeve}-${p.symbol}-${i}`} className="rounded-md border border-zinc-800 bg-zinc-900/60">
                <button
                  type="button"
                  onClick={() => setOpenIdx(expanded ? null : i)}
                  aria-expanded={expanded}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500"
                >
                  <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[11px] text-zinc-300">
                    {p.sleeve}
                  </span>
                  <span className="font-mono text-zinc-100">{p.symbol}</span>
                  <span className={p.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                    {p.direction === '—' ? '—' : p.direction.toUpperCase()}
                  </span>

                  {/* The number a trader actually wants */}
                  {p.unrealizedPct !== null ? (
                    <span className={`font-mono text-lg font-semibold ${pnlTone}`}>
                      {formatPnlPct(p.unrealizedPct * 100)}
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-500">no live mark for this sleeve</span>
                  )}

                  <span className="ml-auto text-xs text-zinc-500">
                    held {formatDuration(heldMs)}
                    {p.progressKind === 'time' && p.expectedHoldMs
                      ? ` · ~${formatDuration(Math.max(0, p.expectedHoldMs - heldMs))} left`
                      : ''}
                  </span>
                  <span className="text-xs text-zinc-600">{expanded ? '▲' : '▼'}</span>
                </button>

                <div className="px-3 pb-3">
                  {p.progressKind === 'price' ? (
                    <PriceRail
                      entry={p.entryPrice}
                      current={p.currentPrice}
                      stop={p.stopLoss}
                      target={p.takeProfit}
                      long={p.direction === 'long'}
                    />
                  ) : p.progressKind === 'time' ? (
                    <TimeRail progress={p.progress ?? 0} />
                  ) : null}
                </div>

                {expanded && (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-zinc-800 px-3 py-3 text-xs sm:grid-cols-4">
                    <Field label="Entry" value={formatUsd(p.entryPrice)} />
                    <Field label="Current" value={p.currentPrice !== null ? formatUsd(p.currentPrice) : '—'} />
                    <Field label="Stop" value={p.stopLoss !== null ? formatUsd(p.stopLoss) : 'none'} />
                    <Field label="Target" value={p.takeProfit !== null ? formatUsd(p.takeProfit) : 'none'} />
                    <Field label="Size" value={p.sizeUsdt !== null ? formatUsd(p.sizeUsdt) : '—'} />
                    <Field label="Strategy" value={p.strategy ?? '—'} />
                    <Field
                      label="Opened"
                      value={p.entryTimestamp ? new Date(p.entryTimestamp).toLocaleString() : '—'}
                    />
                    <Field
                      label="Exits"
                      value={
                        p.progressKind === 'time' && p.expectedHoldMs
                          ? `on the clock, ~${formatDuration(Math.max(0, p.expectedHoldMs - heldMs))} away`
                          : p.takeProfit !== null
                            ? 'at stop or target'
                            : '—'
                      }
                    />
                  </dl>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-zinc-200">{value}</dd>
    </div>
  );
}

/** Stop ——— entry ——— target, with a live marker. Direction-aware. */
function PriceRail({
  entry, current, stop, target, long,
}: { entry: number; current: number | null; stop: number | null; target: number | null; long: boolean }) {
  if (stop === null || target === null || current === null) return null;
  const lo = Math.min(stop, target);
  const hi = Math.max(stop, target);
  const span = hi - lo;
  if (span <= 0) return null;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / span) * 100))}%`;
  // For a long the target is on the right; for a short it is on the left.
  const targetOnRight = long;

  return (
    <div className="mt-1">
      <div className="relative h-2 rounded bg-zinc-800">
        <div
          className="absolute inset-y-0 rounded bg-emerald-500/25"
          style={targetOnRight ? { left: pos(entry), right: 0 } : { left: 0, right: `calc(100% - ${pos(entry)})` }}
        />
        <div
          className="absolute inset-y-0 rounded bg-red-500/25"
          style={targetOnRight ? { left: 0, right: `calc(100% - ${pos(entry)})` } : { left: pos(entry), right: 0 }}
        />
        <div className="absolute inset-y-[-3px] w-px bg-zinc-400" style={{ left: pos(entry) }} title="entry" />
        <div
          className="absolute inset-y-[-4px] w-1 rounded-sm bg-cyan-300 shadow-[0_0_0_2px_rgba(0,0,0,0.6)]"
          style={{ left: pos(current) }}
          title="current price"
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-500">
        <span>{targetOnRight ? `stop ${stop.toFixed(2)}` : `target ${target.toFixed(2)}`}</span>
        <span className="text-zinc-400">entry {entry.toFixed(2)}</span>
        <span>{targetOnRight ? `target ${target.toFixed(2)}` : `stop ${stop.toFixed(2)}`}</span>
      </div>
    </div>
  );
}

/** Elapsed-vs-window bar for session legs, which exit on a clock. */
function TimeRail({ progress }: { progress: number }) {
  return (
    <div className="mt-1">
      <div className="h-2 rounded bg-zinc-800">
        <div className="h-2 rounded bg-cyan-500/60" style={{ width: `${progress * 100}%` }} />
      </div>
      <p className="mt-1 text-[10px] text-zinc-500">
        {(progress * 100).toFixed(0)}% through its session window — this leg exits on the clock, not on a target.
      </p>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
