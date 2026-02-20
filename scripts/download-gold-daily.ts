#!/usr/bin/env tsx
/**
 * Download XAU/USD Daily candles from Dukascopy for F2F gold backtesting.
 *
 * Uses dukascopy-node (same as download-gold-data.ts, just daily timeframe).
 * XAU/USD spot — acceptable proxy for gold futures.
 *
 * Output: data/GC_F_1d.json (~5,400 daily candles, 2005-present)
 *
 * Usage:
 *   npx tsx scripts/download-gold-daily.ts                    # Default: 2005-01-01 to now
 *   npx tsx scripts/download-gold-daily.ts --from 2010-01-01  # Custom start
 *   npx tsx scripts/download-gold-daily.ts --to 2025-01-01    # Custom end
 */

import * as fs from 'fs';
import * as path from 'path';
import { getHistoricalRates } from 'dukascopy-node';
import type { Candle } from '../src/types/candle';

const ONE_DAY_MS = 86_400_000;
const OUTPUT_PATH = path.resolve(__dirname, '..', 'data', 'GC_F_1d.json');

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

interface GapInfo {
  after: number;
  before: number;
  missingDays: number;
  isWeekend: boolean;
}

function isWeekendGap(afterTs: number, beforeTs: number): boolean {
  const d1 = new Date(afterTs);
  const d2 = new Date(beforeTs);
  const day1 = d1.getUTCDay();
  const gapDays = Math.round((beforeTs - afterTs) / ONE_DAY_MS);
  // Friday→Monday is a normal weekend gap (2 days)
  if (day1 === 5 && gapDays <= 3) return true;
  // Gaps of 3-5 days near weekends are holiday+weekend combos
  if (gapDays <= 5 && (day1 >= 4 || d2.getUTCDay() <= 1)) return true;
  return false;
}

function validateCandles(candles: Candle[]): {
  total: number;
  startDate: string;
  endDate: string;
  ohlcErrors: number;
  zeroVolume: number;
  gaps: GapInfo[];
  weekdayGaps: GapInfo[];
} {
  let ohlcErrors = 0;
  let zeroVolume = 0;
  const gaps: GapInfo[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;

    if (c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) {
      ohlcErrors++;
    }

    if (c.volume === 0 || c.volume === undefined) {
      zeroVolume++;
    }

    if (i > 0) {
      const prev = candles[i - 1]!;
      const expected = prev.timestamp + ONE_DAY_MS;
      if (c.timestamp > expected + ONE_DAY_MS) {
        // More than 1 day gap (allow for timezone alignment)
        const missingDays = Math.round((c.timestamp - prev.timestamp) / ONE_DAY_MS) - 1;
        gaps.push({
          after: prev.timestamp,
          before: c.timestamp,
          missingDays,
          isWeekend: isWeekendGap(prev.timestamp, c.timestamp),
        });
      }
    }
  }

  const weekdayGaps = gaps.filter((g) => !g.isWeekend);

  return {
    total: candles.length,
    startDate: candles.length > 0 ? new Date(candles[0]!.timestamp).toISOString() : 'N/A',
    endDate: candles.length > 0 ? new Date(candles[candles.length - 1]!.timestamp).toISOString() : 'N/A',
    ohlcErrors,
    zeroVolume,
    gaps,
    weekdayGaps,
  };
}

async function downloadChunk(from: Date, to: Date, label: string): Promise<Candle[]> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const data = await getHistoricalRates({
        instrument: 'xauusd',
        dates: { from, to },
        timeframe: 'd1',
        format: 'json',
        priceType: 'bid',
        volumes: true,
        batchSize: 10,
        pauseBetweenBatchesMs: 1000,
        retryCount: 5,
        retryOnEmpty: true,
        pauseBetweenRetriesMs: 2000,
      });

      return data.map((item) => ({
        timestamp: item.timestamp,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume: item.volume ?? 0,
      }));
    } catch (err) {
      if (attempt < maxRetries) {
        console.log(`  ${label}: attempt ${attempt} failed, retrying in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        throw new Error(`Failed to download ${label} after ${maxRetries} attempts: ${err}`);
      }
    }
  }
  return []; // unreachable
}

function generateYearChunks(fromDate: string, toDate: string): Array<{ from: Date; to: Date; label: string }> {
  const chunks: Array<{ from: Date; to: Date; label: string }> = [];
  const endDate = new Date(toDate);

  let current = new Date(fromDate);
  while (current < endDate) {
    const year = current.getUTCFullYear();
    const nextYear = new Date(`${year + 1}-01-01T00:00:00Z`);
    const chunkEnd = nextYear < endDate ? nextYear : endDate;
    chunks.push({ from: new Date(current), to: chunkEnd, label: `${year}` });
    current = nextYear;
  }

  return chunks;
}

async function main(): Promise<void> {
  const fromDate = getArg('from') ?? '2005-01-01';
  const toDate = getArg('to') ?? new Date().toISOString().slice(0, 10);

  console.log(`Downloading XAU/USD Daily candles from Dukascopy`);
  console.log(`  Range: ${fromDate} → ${toDate}`);
  console.log(`  Instrument: xauusd (spot)`);
  console.log(`  Timeframe: D1 (daily)`);
  console.log(`  Downloading in yearly chunks...\n`);

  const startTime = Date.now();
  const chunks = generateYearChunks(fromDate, toDate);
  const allCandles: Candle[] = [];

  for (const chunk of chunks) {
    const chunkStart = Date.now();
    const chunkCandles = await downloadChunk(chunk.from, chunk.to, chunk.label);
    const chunkElapsed = ((Date.now() - chunkStart) / 1000).toFixed(1);
    allCandles.push(...chunkCandles);
    console.log(`  ${chunk.label}: ${chunkCandles.length.toLocaleString()} candles (${chunkElapsed}s)`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Total downloaded: ${allCandles.length.toLocaleString()} candles in ${elapsed}s\n`);

  // Sort and deduplicate
  allCandles.sort((a, b) => a.timestamp - b.timestamp);

  const seen = new Set<number>();
  const deduped = allCandles.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });

  if (deduped.length < allCandles.length) {
    console.log(`  Removed ${allCandles.length - deduped.length} duplicate candles`);
  }

  // Validate
  const validation = validateCandles(deduped);
  console.log('=== Data Quality Report ===');
  console.log(`  Total candles: ${validation.total.toLocaleString()}`);
  console.log(`  Date range: ${validation.startDate.slice(0, 10)} → ${validation.endDate.slice(0, 10)}`);
  console.log(`  OHLC errors: ${validation.ohlcErrors}`);
  console.log(`  Zero-volume candles: ${validation.zeroVolume}`);
  console.log(`  Total gaps: ${validation.gaps.length} (${validation.gaps.filter((g) => g.isWeekend).length} weekend, ${validation.weekdayGaps.length} weekday)`);

  if (validation.weekdayGaps.length > 0) {
    console.log('\n  WARNING: Weekday gaps found:');
    const sorted = [...validation.weekdayGaps].sort((a, b) => b.missingDays - a.missingDays);
    for (const gap of sorted.slice(0, 10)) {
      const after = new Date(gap.after).toISOString().slice(0, 10);
      const before = new Date(gap.before).toISOString().slice(0, 10);
      console.log(`    ${after} → ${before} (${gap.missingDays} days missing)`);
    }
  }

  // Years breakdown
  const yearCounts = new Map<number, number>();
  for (const c of deduped) {
    const year = new Date(c.timestamp).getUTCFullYear();
    yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
  }
  console.log('\n  Candles by year:');
  for (const [year, count] of [...yearCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    ${year}: ${count}`);
  }

  // Save
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(deduped));
  const sizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`\nSaved to ${OUTPUT_PATH} (${sizeMB} MB, ${deduped.length.toLocaleString()} candles)`);

  // Spot-check notable gold prices
  console.log('\n=== Spot-Check Notable Gold Prices ===');
  const spotChecks = [
    { date: '2005-01-03', label: 'Gold ~$430', expected: 430 },
    { date: '2011-09-06', label: 'Gold ATH ~$1,920', expected: 1920 },
    { date: '2015-12-03', label: 'Gold low ~$1,050', expected: 1050 },
    { date: '2020-08-06', label: 'Gold ATH ~$2,075', expected: 2075 },
    { date: '2024-01-02', label: 'Gold ~$2,060', expected: 2060 },
  ];

  for (const check of spotChecks) {
    const targetTs = new Date(check.date + 'T00:00:00Z').getTime();
    let nearest = deduped[0]!;
    let minDist = Math.abs(deduped[0]!.timestamp - targetTs);
    for (const c of deduped) {
      const dist = Math.abs(c.timestamp - targetTs);
      if (dist < minDist) {
        minDist = dist;
        nearest = c;
      }
    }
    const daysOff = Math.round(minDist / ONE_DAY_MS);
    const pctDiff = ((nearest.close - check.expected) / check.expected * 100).toFixed(1);
    console.log(`  ${check.date} (${check.label}): close=${nearest.close.toFixed(2)} (${pctDiff}% vs expected, ${daysOff}d off)`);
  }
}

main().catch((err) => {
  console.error('Download failed:', err);
  process.exit(1);
});
