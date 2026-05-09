'use client';

import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, type IChartApi, type Time } from 'lightweight-charts';

export interface SetupChartCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Props {
  candles: SetupChartCandle[];
  height?: number;
}

export function SetupChart({ candles, height = 400 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { color: '#0a0a0a' }, textColor: '#a1a1aa' },
      grid: {
        vertLines: { color: '#27272a' },
        horzLines: { color: '#27272a' },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      borderVisible: false,
    });
    series.setData(
      candles.map((c) => ({
        time: (Math.floor(c.timestamp / 1000)) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, height]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
