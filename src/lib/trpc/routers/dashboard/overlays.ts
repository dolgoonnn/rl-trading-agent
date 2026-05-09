import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';
import { detectOrderBlocks } from '@/lib/ict/order-blocks';
import { detectFairValueGaps, getActiveFVGs } from '@/lib/ict/fair-value-gaps';
import { detectLiquidityLevels, detectLiquiditySweeps } from '@/lib/ict/liquidity';
import { analyzeMarketStructure } from '@/lib/ict/market-structure';
import type { Candle } from '@/types';
import { readRecentCandles } from './candles';

export interface OverlayRect {
  kind: 'ob-bull' | 'ob-bear' | 'fvg-bull' | 'fvg-bear';
  startTime: number;
  endTime: number;
  high: number;
  low: number;
  status: string;
}

export interface OverlayLine {
  kind: 'bsl' | 'ssl';
  price: number;
  startTime: number;
  swept: boolean;
}

export interface OverlayMarker {
  kind: 'sweep' | 'bos' | 'choch';
  direction: 'bullish' | 'bearish';
  time: number;
  price: number;
  text: string;
}

const MAX_OB_AGE = 80;
const MAX_FVG_AGE = 50;

export const overlaysRouter = router({
  scan: publicProcedure
    .input(z.object({ symbol: z.string(), candleCount: z.number().int().min(100).max(2000).default(500) }))
    .query(({ input }) => {
      const dbPath = path.resolve('data/ict-trading.db');
      if (!fs.existsSync(dbPath)) {
        return {
          available: false as const,
          rects: [] as OverlayRect[],
          lines: [] as OverlayLine[],
          markers: [] as OverlayMarker[],
        };
      }
      const db = new Database(dbPath, { readonly: true });
      try {
        const candles = readRecentCandles(db, input.symbol, input.candleCount) as Candle[];
        if (candles.length < 50) {
          return { available: true as const, rects: [], lines: [], markers: [] };
        }

        const lastIdx = candles.length - 1;
        const lastBar = candles[lastIdx]!;
        const lastTime = lastBar.timestamp;

        const obs = detectOrderBlocks(candles);
        const fvgs = detectFairValueGaps(candles);
        const activeFVGs = getActiveFVGs(fvgs, lastIdx, MAX_FVG_AGE);
        const levels = detectLiquidityLevels(candles);
        const sweeps = detectLiquiditySweeps(candles, levels);
        const structure = analyzeMarketStructure(candles);

        const rects: OverlayRect[] = [];
        for (const ob of obs) {
          if (ob.status === 'broken') continue;
          if (lastIdx - ob.index > MAX_OB_AGE) continue;
          rects.push({
            kind: ob.type === 'bullish' ? 'ob-bull' : 'ob-bear',
            startTime: ob.timestamp,
            endTime: lastTime,
            high: ob.high,
            low: ob.low,
            status: ob.status,
          });
        }
        for (const fvg of activeFVGs) {
          rects.push({
            kind: fvg.type === 'bullish' ? 'fvg-bull' : 'fvg-bear',
            startTime: fvg.timestamp,
            endTime: lastTime,
            high: fvg.high,
            low: fvg.low,
            status: fvg.status,
          });
        }

        const lines: OverlayLine[] = levels
          .filter((l) => lastIdx - l.index <= MAX_OB_AGE * 2)
          .map((l) => ({
            kind: l.type,
            price: l.price,
            startTime: l.timestamp,
            swept: l.status === 'swept',
          }));

        const markers: OverlayMarker[] = [];
        for (const s of sweeps) {
          if (lastIdx - s.sweepIndex > MAX_OB_AGE) continue;
          markers.push({
            kind: 'sweep',
            direction: s.level.type === 'bsl' ? 'bearish' : 'bullish',
            time: s.timestamp,
            price: s.sweepCandle.high && s.level.type === 'bsl' ? s.sweepCandle.high : s.sweepCandle.low,
            text: s.level.type === 'bsl' ? 'BSL swept' : 'SSL swept',
          });
        }
        for (const sb of structure.structureBreaks) {
          if (lastIdx - sb.breakIndex > MAX_OB_AGE) continue;
          markers.push({
            kind: sb.type === 'choch' ? 'choch' : 'bos',
            direction: sb.direction,
            time: sb.timestamp,
            price: sb.direction === 'bullish' ? sb.breakCandle.high : sb.breakCandle.low,
            text: `${sb.type.toUpperCase()} ${sb.direction === 'bullish' ? '↑' : '↓'}`,
          });
        }

        return { available: true as const, rects, lines, markers };
      } finally {
        db.close();
      }
    }),
});
