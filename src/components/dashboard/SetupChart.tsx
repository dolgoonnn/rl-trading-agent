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
import { killZoneWindowsInRange, KILL_ZONE_FILL } from './killzones';

export interface SetupChartCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartOverlayRect {
  kind: 'ob-bull' | 'ob-bear' | 'fvg-bull' | 'fvg-bear' | 'unicorn';
  startTime: number;
  endTime: number;
  high: number;
  low: number;
  tf?: '1H' | '4H' | '1D';
  strength?: number;
}

export interface ChartPastTrade {
  id: string;
  direction: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  outcome: 'win' | 'loss';
  pnlPercent: number;
}

export interface ChartCandidateSetup {
  rank: number;
  side: 'long' | 'short';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  score: number;
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
  pastTrades?: ChartPastTrade[];
  candidates?: ChartCandidateSetup[];
  height?: number;
}

const BASE_RECT_STYLE: Record<ChartOverlayRect['kind'], { fill: string; border: string }> = {
  'ob-bull': { fill: 'rgba(34, 197, 94, 0.18)', border: 'rgba(34, 197, 94, 0.55)' },
  'ob-bear': { fill: 'rgba(239, 68, 68, 0.18)', border: 'rgba(239, 68, 68, 0.55)' },
  'fvg-bull': { fill: 'rgba(59, 130, 246, 0.12)', border: 'rgba(59, 130, 246, 0.4)' },
  'fvg-bear': { fill: 'rgba(234, 179, 8, 0.12)', border: 'rgba(234, 179, 8, 0.4)' },
  'unicorn': { fill: 'rgba(168, 85, 247, 0.32)', border: 'rgba(168, 85, 247, 0.85)' },
};

// HTF zones get fainter fill + thicker border so they're context, not noise
function styleForRect(r: ChartOverlayRect): { fill: string; border: string } {
  const base = BASE_RECT_STYLE[r.kind];
  if (r.kind === 'unicorn') return base;
  const tf = r.tf ?? '1H';
  if (tf === '1H') return base;
  // For HTF, halve fill alpha so they sit behind LTF zones
  const fill = base.fill.replace(/[\d.]+\)$/, (m) => `${parseFloat(m) * 0.55})`);
  return { fill, border: base.border };
}

export function SetupChart({
  candles,
  rects = [],
  lines = [],
  markers = [],
  setupLines = null,
  pastTrades = [],
  candidates = [],
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

    // Kill-zone background bands across the visible candle range
    const firstTs = candles[0]?.timestamp ?? 0;
    const lastTs = candles[candles.length - 1]?.timestamp ?? 0;
    const kzWindows = firstTs && lastTs ? killZoneWindowsInRange(firstTs, lastTs) : [];
    const kzRects: RectSpec[] = kzWindows.map((w) => ({
      startTime: w.startMs,
      endTime: w.endMs,
      high: 0,
      low: 0,
      fillColor: KILL_ZONE_FILL[w.kind],
      borderColor: 'transparent',
      fullHeight: true,
    }));
    const kzPrim = new RectanglePrimitive();
    kzPrim.setRects(kzRects);
    series.attachPrimitive(kzPrim);

    // Rectangle primitive for OB/FVG overlays (drawn on top of KZ bands).
    // Sort so HTF context renders first (back), then LTF, then unicorn confluence on top.
    const sortedRects = [...rects].sort((a, b) => {
      const order = (r: ChartOverlayRect) =>
        r.kind === 'unicorn' ? 3 : r.tf === '1D' ? 0 : r.tf === '4H' ? 1 : 2;
      return order(a) - order(b);
    });
    const rectPrim = new RectanglePrimitive();
    const rectSpecs: RectSpec[] = sortedRects.map((r) => {
      const style = styleForRect(r);
      return {
        startTime: r.startTime,
        endTime: r.endTime,
        high: r.high,
        low: r.low,
        fillColor: style.fill,
        borderColor: style.border,
      };
    });
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

    // Top-1 setup entry/SL/TP — solid, labeled
    if (setupLines) {
      priceLines.push(
        series.createPriceLine({
          price: setupLines.entry,
          color: '#fbbf24',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `#1 entry ${setupLines.side}`,
        }),
        series.createPriceLine({
          price: setupLines.stopLoss,
          color: '#ef4444',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '#1 SL',
        }),
        series.createPriceLine({
          price: setupLines.takeProfit,
          color: '#22c55e',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '#1 TP',
        }),
      );
    }

    // Lower-ranked candidates — thinner, dotted, no axis label clutter
    for (const cand of candidates) {
      if (cand.rank === 1) continue; // already drawn above
      const dim = 0.55 - cand.rank * 0.08;
      const alpha = Math.max(0.18, dim);
      priceLines.push(
        series.createPriceLine({
          price: cand.entry,
          color: `rgba(251, 191, 36, ${alpha})`,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
          title: `#${cand.rank} ${cand.side} ${cand.score.toFixed(1)}`,
        }),
      );
    }

    // Markers (sweeps / BOS / CHoCH) + past-trade entry/exit markers (W=green, L=red)
    const allMarkers: SeriesMarker<Time>[] = [
      ...markers.map((m) => ({
        time: Math.floor(m.time / 1000) as Time,
        position: (m.direction === 'bullish' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
        color: m.kind === 'sweep' ? '#f59e0b' : m.kind === 'choch' ? '#a855f7' : '#3b82f6',
        shape: (m.kind === 'sweep' ? 'arrowUp' : 'circle') as 'arrowUp' | 'circle',
        text: m.text,
      })),
      ...pastTrades.flatMap((t) => {
        const winColor = t.outcome === 'win' ? '#10b981' : '#ef4444';
        const tag = `${t.outcome === 'win' ? 'W' : 'L'} ${t.pnlPercent >= 0 ? '+' : ''}${(t.pnlPercent * 100).toFixed(1)}%`;
        return [
          {
            time: Math.floor(t.entryTime / 1000) as Time,
            position: (t.direction === 'long' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
            color: winColor,
            shape: (t.direction === 'long' ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
            text: tag,
          },
          {
            time: Math.floor(t.exitTime / 1000) as Time,
            position: (t.direction === 'long' ? 'aboveBar' : 'belowBar') as 'belowBar' | 'aboveBar',
            color: winColor,
            shape: 'square' as 'square',
            text: '',
          },
        ];
      }),
    ];
    if (allMarkers.length > 0) {
      const sm = allMarkers.sort((a, b) => (a.time as number) - (b.time as number));
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
  }, [candles, rects, lines, markers, setupLines, pastTrades, candidates, height]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
