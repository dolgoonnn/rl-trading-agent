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
import { resampleCandles, type Timeframe } from './bias';

export interface OverlayRect {
  kind: 'ob-bull' | 'ob-bear' | 'fvg-bull' | 'fvg-bear' | 'unicorn';
  startTime: number;
  endTime: number;
  high: number;
  low: number;
  status: string;
  tf?: Timeframe;
  strength?: number;
}

export interface PastTradeMarker {
  id: string;
  direction: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  pnlPercent: number;
  outcome: 'win' | 'loss';
  score: number;
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
const HTF_OB_AGE_4H = 60; // ~10 days on 4H
const HTF_OB_AGE_1D = 30; // ~30 days on 1D
const PAST_TRADE_LOOKBACK_MS = 365 * 24 * 3_600_000; // 1 year — chart filters by visible candle range anyway

interface OBLite {
  type: 'bullish' | 'bearish';
  index: number;
  timestamp: number;
  high: number;
  low: number;
  status: string;
}

function rectsOverlap(a: OverlayRect, b: OverlayRect): boolean {
  const horizontal = a.startTime <= b.endTime && b.startTime <= a.endTime;
  const vertical = a.low <= b.high && b.low <= a.high;
  return horizontal && vertical;
}

function unicornIntersections(rects: OverlayRect[]): OverlayRect[] {
  const obs = rects.filter((r) => r.kind === 'ob-bull' || r.kind === 'ob-bear');
  const fvgs = rects.filter((r) => r.kind === 'fvg-bull' || r.kind === 'fvg-bear');
  const out: OverlayRect[] = [];
  for (const ob of obs) {
    for (const fvg of fvgs) {
      const sameSide =
        (ob.kind === 'ob-bull' && fvg.kind === 'fvg-bull') ||
        (ob.kind === 'ob-bear' && fvg.kind === 'fvg-bear');
      if (!sameSide) continue;
      if (!rectsOverlap(ob, fvg)) continue;
      out.push({
        kind: 'unicorn',
        startTime: Math.max(ob.startTime, fvg.startTime),
        endTime: Math.min(ob.endTime, fvg.endTime),
        high: Math.min(ob.high, fvg.high),
        low: Math.max(ob.low, fvg.low),
        status: 'confluence',
      });
    }
  }
  return out;
}

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
          pastTrades: [] as PastTradeMarker[],
        };
      }
      const db = new Database(dbPath, { readonly: true });
      try {
        const candles = readRecentCandles(db, input.symbol, input.candleCount) as Candle[];
        if (candles.length < 50) {
          return { available: true as const, rects: [], lines: [], markers: [], pastTrades: [] };
        }

        const lastIdx = candles.length - 1;
        const lastBar = candles[lastIdx]!;
        const lastTime = lastBar.timestamp;
        const firstTime = candles[0]!.timestamp;

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
            tf: '1H',
            strength: 1,
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
            tf: '1H',
            strength: 1,
          });
        }

        // HTF overlays — 4H and 1D OBs as fainter, wider context zones
        const htfConfigs: Array<{ tf: Timeframe; maxAge: number }> = [
          { tf: '4H', maxAge: HTF_OB_AGE_4H },
          { tf: '1D', maxAge: HTF_OB_AGE_1D },
        ];
        for (const { tf, maxAge } of htfConfigs) {
          const htfCandles = resampleCandles(candles, tf);
          if (htfCandles.length < 20) continue;
          const htfObs = detectOrderBlocks(htfCandles) as OBLite[];
          const htfLastIdx = htfCandles.length - 1;
          for (const ob of htfObs) {
            if (ob.status === 'broken') continue;
            if (htfLastIdx - ob.index > maxAge) continue;
            if (ob.timestamp < firstTime) continue;
            rects.push({
              kind: ob.type === 'bullish' ? 'ob-bull' : 'ob-bear',
              startTime: ob.timestamp,
              endTime: lastTime,
              high: ob.high,
              low: ob.low,
              status: ob.status,
              tf,
              strength: tf === '1D' ? 3 : 2,
            });
          }
        }

        // Confluence rectangles where OB ∩ FVG (Flux Charts "ICT Unicorn" pattern)
        rects.push(...unicornIntersections(rects));

        // Past trades from bot_trades — overlay W/L outcomes on chart
        const cutoff = lastTime - PAST_TRADE_LOOKBACK_MS;
        interface BotTradeRow {
          id: string;
          direction: string;
          entry_price: number;
          exit_price: number;
          entry_timestamp: number;
          exit_timestamp: number;
          pnl_percent: number;
          confluence_score: number;
        }
        let pastTrades: PastTradeMarker[] = [];
        try {
          const tradeRows = db
            .prepare(
              `SELECT id, direction, entry_price, exit_price, entry_timestamp, exit_timestamp, pnl_percent, confluence_score
               FROM bot_trades
               WHERE symbol = ? AND entry_timestamp >= ?
               ORDER BY entry_timestamp ASC`,
            )
            .all(input.symbol, cutoff) as BotTradeRow[];
          pastTrades = tradeRows
            .filter((t) => t.entry_timestamp >= firstTime && t.entry_timestamp <= lastTime)
            .map((t) => ({
              id: t.id,
              direction: t.direction === 'long' ? 'long' : 'short',
              entryTime: t.entry_timestamp,
              entryPrice: t.entry_price,
              exitTime: t.exit_timestamp,
              exitPrice: t.exit_price,
              pnlPercent: t.pnl_percent,
              outcome: t.pnl_percent > 0 ? 'win' : 'loss',
              score: t.confluence_score,
            }));
        } catch {
          // bot_trades table may not exist on fresh installs
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

        return { available: true as const, rects, lines, markers, pastTrades };
      } finally {
        db.close();
      }
    }),
});
