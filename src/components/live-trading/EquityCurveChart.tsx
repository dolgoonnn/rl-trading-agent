'use client';
import { useEffect, useRef } from 'react';
import { createChart, AreaSeries, ColorType, type IChartApi, type Time } from 'lightweight-charts';

export function EquityCurveChart({ points }: { points: Array<{ timestamp: number; equity: number }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#9ca3af' },
      grid: { horzLines: { color: '#1f2937' }, vertLines: { color: '#1f2937' } },
      height: 260,
      autoSize: true,
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#22d3ee',
      topColor: 'rgba(34,211,238,0.3)',
      bottomColor: 'rgba(34,211,238,0)',
    });
    series.setData(points.map((p) => ({ time: Math.floor(p.timestamp / 1000) as Time, value: p.equity })));
    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => chart.remove();
  }, [points]);
  if (points.length === 0) {
    return (
      <div className="h-[260px] flex items-center justify-center text-gray-500 text-sm">
        No equity history yet — the book started flat.
      </div>
    );
  }
  return <div ref={ref} className="w-full" />;
}
