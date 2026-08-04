'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { formatUsd, formatPnlPct } from '@/lib/bot/format';
import { priceMove, formatPips } from '@/lib/bot/trade-analytics';
import { TradeDetailDrawer } from './TradeDetailDrawer';

export function RecentTradesTable() {
  const q = trpc.dashboard.book.trades.useQuery({ limit: 50 }, { refetchInterval: 30_000 });
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold text-zinc-100">Recent trades</h2>
      {q.isLoading ? (
        <div className="h-16 animate-pulse rounded bg-zinc-800/60" />
      ) : q.error ? (
        <p className="text-sm text-red-300">Failed to load trades: {q.error.message}</p>
      ) : !q.data || q.data.length === 0 ? (
        <p className="text-sm text-zinc-500">No closed trades yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                <th className="px-3 py-2">Sleeve</th>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Direction</th>
                <th className="px-3 py-2 text-right">PnL %</th>
                <th className="px-3 py-2 text-right">Move</th>
                <th className="px-3 py-2 text-right">PnL (USDT)</th>
                <th className="px-3 py-2">Exit reason</th>
                <th className="px-3 py-2">Closed</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((t, i) => (
                <tr
                  key={`${t.sleeve}-${t.symbol}-${t.exitTimestamp}-${i}`}
                  onClick={() => setOpenId(t.id)}
                  className="cursor-pointer border-b border-zinc-800/60 last:border-0 hover:bg-white/5"
                >
                  <td className="px-3 py-2">
                    <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[11px] text-zinc-300">
                      {t.sleeve}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-zinc-200">
                    {t.symbol}
                    {t.instrument && t.instrument.toUpperCase() !== t.symbol.toUpperCase() ? (
                      <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide text-zinc-400">
                        {t.instrument}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <span className={t.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                      {t.direction === '—' ? t.direction : t.direction.toUpperCase()}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right font-mono ${t.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {/* pnlPct is fraction-scale (0.0271 = 2.71%); multiply by 100 before formatPnlPct */}
                    {formatPnlPct(t.pnlPct * 100)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-400">
                    {(() => {
                      // Percent is comparable across the book but does not describe
                      // the move — and these are leveraged, so pips is the unit.
                      const m = priceMove(t.instrument, t.direction, t.entryPrice, t.exitPrice);
                      return m === null ? '—' : formatPips(m);
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-200">
                    {t.pnlUsdt !== null ? formatUsd(t.pnlUsdt) : '—'}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{t.exitReason ?? '—'}</td>
                  <td className="px-3 py-2 text-zinc-500">
                    {t.exitTimestamp ? new Date(t.exitTimestamp).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* A pip means a different price step on each market — state it rather
              than let the reader guess why gold moves 1,330 and EUR moves 39. */}
          <p className="mt-3 text-[10px] text-zinc-600">
            1 pip = 0.0001 EUR/USD · $0.01 gold · $0.001 silver · 0.1 US500 · $1 BTC · $0.1 ETH · $0.01 SOL
          </p>
        </div>
      )}
      <TradeDetailDrawer tradeId={openId} onClose={() => setOpenId(null)} />
    </section>
  );
}
