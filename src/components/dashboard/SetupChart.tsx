'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineStyle,
  type Time,
  type SeriesMarker,
  type IPriceLine,
} from 'lightweight-charts';
import { RectanglePrimitive, type RectSpec } from './RectanglePrimitive';

export interface SetupChartCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartOverlayRect {
  kind: 'ob-bull' | 'ob-bear' | 'fvg-bull' | 'fvg-bear';
  startTime: number;
  endTime: number;
  high: number;
  low: number;
}

export interface ChartOverlayLine {
  kind: 'bsl' | 'ssl';
  price: number;
  swept: boolean;
}

export interface ChartOverlayMarker {
  kind: 'sweep' | 'bos' | 'choch';
  direction: 'bullish' | 'bearish';
  time: number;
  price: number;
  text: string;
}

export interface ChartSetupLines {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  side: 'long' | 'short';
}

interface Props {
  candles: SetupChartCandle[];
  rects?: ChartOverlayRect[];
  lines?: ChartOverlayLine[];
  markers?: ChartOverlayMarker[];
  setupLines?: ChartSetupLines | null;
  height?: number;
}

const RECT_STYLE: Record<ChartOverlayRect['kind'], { fill: string; border: string }> = {
  'ob-bull': { fill: 'rgba(34, 197, 94, 0.18)', border: 'rgba(34, 197, 94, 0.55)' },
  'ob-bear': { fill: 'rgba(239, 68, 68, 0.18)', border: 'rgba(239, 68, 68, 0.55)' },
  'fvg-bull': { fill: 'rgba(59, 130, 246, 0.12)', border: 'rgba(59, 130, 246, 0.4)' },
  'fvg-bear': { fill: 'rgba(234, 179, 8, 0.12)', border: 'rgba(234, 179, 8, 0.4)' },
};

export function SetupChart({
  candles,
  rects = [],
  lines = [],
  markers = [],
  setupLines = null,
  height = 480,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { color: '#0a0a0a' }, textColor: '#a1a1aa' },
      grid: {
        vertLines: { color: '#27272a' },
        horzLines: { color: '#27272a' },
      },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 8 },
      rightPriceScale: { borderColor: '#3f3f46' },
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
        time: Math.floor(c.timestamp / 1000) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    // Rectangle primitive for OB/FVG overlays
    const rectPrim = new RectanglePrimitive();
    const rectSpecs: RectSpec[] = rects.map((r) => ({
      startTime: r.startTime,
      endTime: r.endTime,
      high: r.high,
      low: r.low,
      fillColor: RECT_STYLE[r.kind].fill,
      borderColor: RECT_STYLE[r.kind].border,
    }));
    rectPrim.setRects(rectSpecs);
    series.attachPrimitive(rectPrim);

    // Liquidity horizontal lines
    const priceLines: IPriceLine[] = [];
    for (const l of lines) {
      const pl = series.createPriceLine({
        price: l.price,
        color: l.swept
          ? l.kind === 'bsl'
            ? 'rgba(239, 68, 68, 0.4)'
            : 'rgba(34, 197, 94, 0.4)'
          : l.kind === 'bsl'
            ? '#fb7185'
            : '#34d399',
        lineWidth: 1,
        lineStyle: l.swept ? LineStyle.Dotted : LineStyle.Dashed,
        axisLabelVisible: false,
        title: l.kind.toUpperCase() + (l.swept ? ' (swept)' : ''),
      });
      priceLines.push(pl);
    }

    // Setup entry/SL/TP lines
    if (setupLines) {
      priceLines.push(
        series.createPriceLine({
          price: setupLines.entry,
          color: '#fbbf24',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `entry ${setupLines.side}`,
        }),
        series.createPriceLine({
          price: setupLines.stopLoss,
          color: '#ef4444',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'SL',
        }),
        series.createPriceLine({
          price: setupLines.takeProfit,
          color: '#22c55e',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'TP',
        }),
      );
    }

    // Markers (sweeps / BOS / CHoCH)
    if (markers.length > 0) {
      const sm: SeriesMarker<Time>[] = markers
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((m) => ({
          time: Math.floor(m.time / 1000) as Time,
          position: m.direction === 'bullish' ? 'belowBar' : 'aboveBar',
          color: m.kind === 'sweep' ? '#f59e0b' : m.kind === 'choch' ? '#a855f7' : '#3b82f6',
          shape: m.kind === 'sweep' ? 'arrowUp' : 'circle',
          text: m.text,
        }));
      const setMarkers = (series as unknown as { setMarkers?: (m: SeriesMarker<Time>[]) => void }).setMarkers;
      if (typeof setMarkers === 'function') setMarkers.call(series, sm);
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [candles, rects, lines, markers, setupLines, height]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
