'use client';

import { useEffect, useRef } from 'react';
import {
  createChart, ColorType, CandlestickSeries, createSeriesMarkers,
  type IChartApi, type Time,
} from 'lightweight-charts';
import { trpc } from '@/lib/trpc/client';

/**
 * The market around a trade — candles, entry/exit markers, and the stop/target rails.
 *
 * Numbers alone cannot show whether the bot traded sensibly. Seeing where the
 * entry landed relative to the structure, how far price ran, and where the rails
 * sat is the difference between a ledger and understanding the system.
 *
 * Lightweight Charts v5 API: `addSeries(CandlestickSeries, …)` and standalone
 * `createSeriesMarkers` — the v4 `addCandlestickSeries`/`series.setMarkers` calls
 * do not exist in this version.
 */
export function TradeChart({ tradeId }: { tradeId: string }) {
  const q = trpc.dashboard.book.tradeChart.useQuery({ id: tradeId });
  const holder = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const data = q.data;

  useEffect(() => {
    if (!holder.current || !data?.available || data.candles.length === 0) return;

    const chart = createChart(holder.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#9ca3af',
        attributionLogo: false,
      },
      grid: { horzLines: { color: '#27272a' }, vertLines: { color: '#27272a' } },
      rightPriceScale: { borderColor: '#3f3f46' },
      timeScale: { borderColor: '#3f3f46', timeVisible: true },
      height: 300,
      autoSize: true,
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981', downColor: '#ef4444',
      borderUpColor: '#10b981', borderDownColor: '#ef4444',
      wickUpColor: '#10b981', wickDownColor: '#ef4444',
    });
    series.setData(
      data.candles.map((c) => ({
        time: Math.floor(c.timestamp / 1000) as Time,
        open: c.open, high: c.high, low: c.low, close: c.close,
      })),
    );

    // Entry / exit markers, oriented by direction.
    const long = data.direction === 'long';
    createSeriesMarkers(series, [
      {
        time: Math.floor(data.entryTimestamp / 1000) as Time,
        position: long ? 'belowBar' : 'aboveBar',
        color: '#22d3ee',
        shape: long ? 'arrowUp' : 'arrowDown',
        text: `entry ${data.entryPrice?.toFixed(2) ?? ''}`,
      },
      {
        time: Math.floor(data.exitTimestamp / 1000) as Time,
        position: long ? 'aboveBar' : 'belowBar',
        color: '#a78bfa',
        shape: long ? 'arrowDown' : 'arrowUp',
        text: `exit ${data.exitPrice?.toFixed(2) ?? ''}`,
      },
    ]);

    // Risk rails.
    if (data.stopLoss !== null) {
      series.createPriceLine({
        price: data.stopLoss, color: '#ef4444', lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: 'stop',
      });
    }
    if (data.takeProfit !== null) {
      series.createPriceLine({
        price: data.takeProfit, color: '#10b981', lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: 'target',
      });
    }
    if (data.entryPrice !== null) {
      series.createPriceLine({
        price: data.entryPrice, color: '#71717a', lineWidth: 1, lineStyle: 3,
        axisLabelVisible: false, title: 'entry',
      });
    }

    chart.timeScale().fitContent();
    return () => { chart.remove(); chartRef.current = null; };
  }, [data]);

  if (q.isLoading) return <div className="h-[300px] animate-pulse rounded bg-zinc-800/40" />;
  if (q.error) {
    return <p className="text-xs text-red-300">Could not load the chart: {q.error.message}</p>;
  }
  if (!data?.available) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-500">
        {data?.reason ?? 'No chart available for this trade.'}
        {data?.entryPrice !== null && data?.entryPrice !== undefined ? (
          <span className="mt-1 block font-mono text-zinc-400">
            entry {data.entryPrice.toFixed(2)}
            {data.exitPrice !== null ? ` → exit ${data.exitPrice.toFixed(2)}` : ''}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <div ref={holder} className="w-full" />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-500">
        <span><span className="text-cyan-300">▲</span> entry</span>
        <span><span className="text-violet-400">▼</span> exit</span>
        <span><span className="text-red-400">╌</span> stop</span>
        <span><span className="text-emerald-400">╌</span> target</span>
        <span className="ml-auto">{data.symbol} · {barInterval(data.candles)} · {data.candles.length} bars</span>
      </div>
    </div>
  );
}

/** Timeframe label derived from actual bar spacing — crypto is 1h, venue fetches are 5m. */
function barInterval(candles: Array<{ timestamp: number }>): string {
  if (candles.length < 2) return '';
  const gaps = candles.slice(1).map((c, i) => c.timestamp - candles[i]!.timestamp).filter((g) => g > 0).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const m = Math.round(median / 60_000);
  if (m <= 0) return '';
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}
