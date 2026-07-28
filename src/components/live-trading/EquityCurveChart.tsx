'use client';
import { useEffect, useRef } from 'react';
import { createChart, AreaSeries, ColorType, type IChartApi, type Time } from 'lightweight-charts';

export function EquityCurveChart({
  points,
  drawdown,
}: {
  points: Array<{ timestamp: number; equity: number }>;
  drawdown?: Array<{ timestamp: number; drawdown: number }>;
}) {
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

    if (drawdown && drawdown.length > 0) {
      const ddSeries = chart.addSeries(AreaSeries, {
        lineColor: '#f87171', topColor: 'rgba(248,113,113,0)', bottomColor: 'rgba(248,113,113,0.35)',
        priceScaleId: 'dd', lastValueVisible: false, priceLineVisible: false,
      });
      chart.priceScale('dd').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });
      ddSeries.setData(drawdown.map((p) => ({ time: Math.floor(p.timestamp / 1000) as Time, value: -Math.abs(p.drawdown) * 100 })));
      ddSeries.createPriceLine({ price: -10, color: '#ef4444', lineStyle: 2, axisLabelVisible: true, title: 'halt -10%' });
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => chart.remove();
  }, [points, drawdown]);
  if (points.length === 0) {
    return (
      <div className="h-[260px] flex items-center justify-center text-gray-500 text-sm">
        No equity history yet — the book started flat.
      </div>
    );
  }
  return <div ref={ref} className="w-full" />;
}
