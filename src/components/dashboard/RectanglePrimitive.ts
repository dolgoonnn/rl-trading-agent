import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  PrimitivePaneViewZOrder,
  IPrimitivePaneRenderer,
  Time,
  IChartApi,
  ISeriesApi,
  SeriesType,
} from 'lightweight-charts';

export interface RectSpec {
  startTime: number;
  endTime: number;
  high: number;
  low: number;
  fillColor: string;
  borderColor: string;
}

class RectanglePaneRenderer implements IPrimitivePaneRenderer {
  constructor(private rects: RectSpec[], private chart: IChartApi, private series: ISeriesApi<SeriesType>) {}

  draw() {}

  drawBackground(target: { useBitmapCoordinateSpace: (cb: (scope: { context: CanvasRenderingContext2D; horizontalPixelRatio: number; verticalPixelRatio: number }) => void) => void }) {
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const ts = this.chart.timeScale();
      for (const r of this.rects) {
        const x1 = ts.timeToCoordinate((Math.floor(r.startTime / 1000)) as Time);
        const x2 = ts.timeToCoordinate((Math.floor(r.endTime / 1000)) as Time);
        const y1 = this.series.priceToCoordinate(r.high);
        const y2 = this.series.priceToCoordinate(r.low);
        if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
        const left = Math.min(x1, x2) * hr;
        const right = Math.max(x1, x2) * hr;
        const top = Math.min(y1, y2) * vr;
        const bottom = Math.max(y1, y2) * vr;
        ctx.fillStyle = r.fillColor;
        ctx.fillRect(left, top, right - left, bottom - top);
        ctx.strokeStyle = r.borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(left, top, right - left, bottom - top);
      }
    });
  }
}

class RectanglePaneView implements IPrimitivePaneView {
  constructor(private rects: RectSpec[], private chart: IChartApi, private series: ISeriesApi<SeriesType>) {}
  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom';
  }
  renderer() {
    return new RectanglePaneRenderer(this.rects, this.chart, this.series);
  }
}

export class RectanglePrimitive implements ISeriesPrimitive<Time> {
  private rects: RectSpec[] = [];
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;

  setRects(rects: RectSpec[]) {
    this.rects = rects;
  }

  attached(param: { chart: IChartApi; series: ISeriesApi<SeriesType> }) {
    this.chart = param.chart;
    this.series = param.series;
  }

  detached() {
    this.chart = null;
    this.series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    if (!this.chart || !this.series) return [];
    return [new RectanglePaneView(this.rects, this.chart, this.series)];
  }

  updateAllViews() {
    /* no-op: paneViews recomputes on each request */
  }
}
