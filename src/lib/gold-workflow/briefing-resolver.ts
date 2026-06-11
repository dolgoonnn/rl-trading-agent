import type { GoldContext, Verdict } from './types';

/**
 * Stub gold-context resolver. Returns hand-crafted data so the panel renders
 * end-to-end. Replace each row's logic incrementally:
 *   midnightOpen → midnight-open.ts (compute from 5m/15m candles at 00:00 ET)
 *   asianRange   → judas-detector.ts (range of 20:00-00:00 ET, sweep state)
 *   dxy          → dxy-correlation.ts (needs DXY data feed)
 *   news         → news-calendar.ts (ForexFactory scrape, cache to SQLite)
 */
export function resolveGoldContext(symbol: string, now: number = Date.now()): GoldContext {
  const verdict: Verdict = 'WAIT';
  const verdictReason = 'Stub data — wire real resolvers per row to activate.';

  return {
    symbol,
    generatedAt: now,
    verdict,
    verdictReason,
    midnightOpen: {
      price: 4072.5,
      priceVsMidnight: 'discount',
      light: 'green',
      note: 'Stub: price in discount, longs favored from PO3 perspective.',
    },
    asianRange: {
      high: 4076.8,
      low: 4068.4,
      highSwept: false,
      lowSwept: false,
      judasComplete: false,
      light: 'amber',
      note: 'Stub: range marked, awaiting sweep during 07:00-09:30 ET.',
    },
    dxy: {
      dxyBias: 'short',
      goldImpliedBias: 'long',
      alignedWithGold: true,
      light: 'green',
      note: 'Stub: DXY weak → gold bias bullish.',
    },
    news: {
      todayEvents: [],
      yesterdayHadHighImpact: false,
      light: 'green',
      note: 'Stub: no high-impact USD events today.',
    },
  };
}
