#!/usr/bin/env tsx
/**
 * Download XAU/USD 1-minute candles from Dukascopy for gold scalp backtesting.
 *
 * Same source as download-gold-data.ts (XAU/USD spot via dukascopy-node),
 * but m1 timeframe downloaded in MONTHLY chunks — yearly 1m chunks time out.
 *
 * Restartable: each month is cached to data/.gold-1m-chunks/YYYY-MM.json and
 * skipped on re-run. Delete a chunk file to force re-download.
 *
 * Usage:
 *   npx tsx scripts/download-gold-1m.ts                    # Default: 2020-01-01 to now
 *   npx tsx scripts/download-gold-1m.ts --from 2023-01-01  # Custom start
 *   npx tsx scripts/download-gold-1m.ts --to 2025-01-01    # Custom end
 */

import * as fs from 'fs';
import * as path from 'path';
import { getHistoricalRates } from 'dukascopy-node';
import type { Candle } from '../src/types/candle';

const ONE_MINUTE_MS = 60_000;
const DEFAULT_OUTPUT = path.resolve(__dirname, '..', 'data', 'XAUUSD_1m.json');
const INSTRUMENT = process.env.DUKA_INSTRUMENT ?? 'xauusd';
// Instrument-scoped cache: chunks from different instruments must never mix
const CHUNK_DIR = path.resolve(__dirname, '..', 'data', `.duka-1m-chunks-${INSTRUMENT}`);

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
  missingMinutes: number;
  isWeekend: boolean;
}

function isWeekendOrHolidayGap(afterTs: number, beforeTs: number): boolean {
  const d1 = new Date(afterTs);
  const d2 = new Date(beforeTs);
  const day1 = d1.getUTCDay();
  const day2 = d2.getUTCDay();
  if (day1 === 5 && (day2 === 0 || day2 === 1)) return true;
  const gapHours = (beforeTs - afterTs) / 3_600_000;
  if (gapHours <= 80 && (day2 === 0 || day2 === 1 || day1 >= 4)) return true;
  return false;
}

function validateCandles(candles: Candle[]): {
  total: number;
  startDate: string;
  endDate: string;
  ohlcErrors: number;
  zeroVolume: number;
  weekendGaps: number;
  weekdayGaps: GapInfo[];
} {
  let ohlcErrors = 0;
  let zeroVolume = 0;
  let weekendGaps = 0;
  const weekdayGaps: GapInfo[] = [];

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
      const expected = prev.timestamp + ONE_MINUTE_MS;
      // 1m gold has routine sub-hour gaps in thin sessions; only report >30min
      if (c.timestamp - expected >= 30 * ONE_MINUTE_MS) {
        const missingMinutes = Math.round((c.timestamp - expected) / ONE_MINUTE_MS);
        if (isWeekendOrHolidayGap(prev.timestamp, c.timestamp)) {
          weekendGaps++;
        } else {
          weekdayGaps.push({ after: prev.timestamp, before: c.timestamp, missingMinutes, isWeekend: false });
        }
      }
    }
  }

  return {
    total: candles.length,
    startDate: candles.length > 0 ? new Date(candles[0]!.timestamp).toISOString() : 'N/A',
    endDate: candles.length > 0 ? new Date(candles[candles.length - 1]!.timestamp).toISOString() : 'N/A',
    ohlcErrors,
    zeroVolume,
    weekendGaps,
    weekdayGaps,
  };
}

async function downloadChunk(from: Date, to: Date, label: string): Promise<Candle[]> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const data = await getHistoricalRates({
        instrument: INSTRUMENT as 'xauusd',
        dates: { from, to },
        timeframe: 'm1',
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

function generateMonthChunks(fromDate: string, toDate: string): Array<{ from: Date; to: Date; label: string }> {
  const chunks: Array<{ from: Date; to: Date; label: string }> = [];
  const endDate = new Date(toDate);

  let current = new Date(fromDate);
  while (current < endDate) {
    const year = current.getUTCFullYear();
    const month = current.getUTCMonth();
    const nextMonth = new Date(Date.UTC(year, month + 1, 1));
    const chunkEnd = nextMonth < endDate ? nextMonth : endDate;
    const label = `${year}-${String(month + 1).padStart(2, '0')}`;
    chunks.push({ from: new Date(current), to: chunkEnd, label });
    current = nextMonth;
  }

  return chunks;
}

async function main(): Promise<void> {
  const fromDate = getArg('from') ?? '2020-01-01';
  const toDate = getArg('to') ?? new Date().toISOString().slice(0, 10);
  const outputPath = getArg('out')
    ? path.resolve(process.cwd(), getArg('out')!)
    : DEFAULT_OUTPUT;

  console.log(`Downloading XAU/USD 1m candles from Dukascopy`);
  console.log(`  Range: ${fromDate} → ${toDate}`);
  console.log(`  Instrument: xauusd (spot), monthly chunks, restartable\n`);

  if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });

  const startTime = Date.now();
  const chunks = generateMonthChunks(fromDate, toDate);
  let downloaded = 0;
  let skipped = 0;

  for (const chunk of chunks) {
    const chunkPath = path.resolve(CHUNK_DIR, `${chunk.label}.json`);
    if (fs.existsSync(chunkPath)) {
      skipped++;
      continue;
    }
    const chunkStart = Date.now();
    const chunkCandles = await downloadChunk(chunk.from, chunk.to, chunk.label);
    fs.writeFileSync(chunkPath, JSON.stringify(chunkCandles));
    downloaded++;
    const chunkElapsed = ((Date.now() - chunkStart) / 1000).toFixed(1);
    console.log(`  ${chunk.label}: ${chunkCandles.length.toLocaleString()} candles (${chunkElapsed}s) [${downloaded + skipped}/${chunks.length}]`);
  }

  console.log(`\n  Chunks: ${downloaded} downloaded, ${skipped} cached`);

  // Merge all chunks
  const allCandles: Candle[] = [];
  for (const chunk of chunks) {
    const chunkPath = path.resolve(CHUNK_DIR, `${chunk.label}.json`);
    if (!fs.existsSync(chunkPath)) continue;
    const chunkCandles: Candle[] = JSON.parse(fs.readFileSync(chunkPath, 'utf-8'));
    allCandles.push(...chunkCandles);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Total merged: ${allCandles.length.toLocaleString()} candles in ${elapsed}s\n`);

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

  const validation = validateCandles(deduped);
  console.log('=== Data Quality Report ===');
  console.log(`  Total candles: ${validation.total.toLocaleString()}`);
  console.log(`  Date range: ${validation.startDate.slice(0, 10)} → ${validation.endDate.slice(0, 10)}`);
  console.log(`  OHLC errors: ${validation.ohlcErrors}`);
  console.log(`  Zero-volume candles: ${validation.zeroVolume.toLocaleString()}`);
  console.log(`  Gaps >30min: ${validation.weekendGaps} weekend/holiday, ${validation.weekdayGaps.length} weekday`);

  if (validation.weekdayGaps.length > 0) {
    console.log('\n  Largest weekday gaps (may indicate data issues):');
    const sorted = [...validation.weekdayGaps].sort((a, b) => b.missingMinutes - a.missingMinutes);
    for (const gap of sorted.slice(0, 10)) {
      const after = new Date(gap.after).toISOString();
      const before = new Date(gap.before).toISOString();
      console.log(`    ${after} → ${before} (${gap.missingMinutes} min missing)`);
    }
  }

  const yearCounts = new Map<number, number>();
  for (const c of deduped) {
    const year = new Date(c.timestamp).getUTCFullYear();
    yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
  }
  console.log('\n  Candles by year:');
  for (const [year, count] of [...yearCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    ${year}: ${count.toLocaleString()}`);
  }

  fs.writeFileSync(outputPath, JSON.stringify(deduped));
  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`\nSaved to ${outputPath} (${sizeMB} MB, ${deduped.length.toLocaleString()} candles)`);

  // Spot-check notable dates against known gold prices
  console.log('\n=== Spot-Check Notable Gold Prices ===');
  const spotChecks = [
    { date: '2020-08-06', label: 'Gold ATH ~$2,075', expected: 2075 },
    { date: '2022-09-28', label: 'Gold bottom ~$1,620', expected: 1620 },
    { date: '2024-10-30', label: 'Gold ATH ~$2,780', expected: 2780 },
  ];

  for (const check of spotChecks) {
    const targetTs = new Date(check.date + 'T12:00:00Z').getTime();
    let lo = 0;
    let hi = deduped.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (deduped[mid]!.timestamp < targetTs) lo = mid + 1;
      else hi = mid;
    }
    const nearest = deduped[lo]!;
    const minutesOff = Math.round(Math.abs(nearest.timestamp - targetTs) / ONE_MINUTE_MS);
    const pctDiff = ((nearest.close - check.expected) / check.expected * 100).toFixed(1);
    console.log(`  ${check.date} (${check.label}): close=${nearest.close.toFixed(2)} (${pctDiff}% vs expected, ${minutesOff}min off)`);
  }
}

main().catch((err) => {
  console.error('Download failed:', err);
  process.exit(1);
});
