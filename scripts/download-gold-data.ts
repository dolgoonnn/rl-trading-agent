#!/usr/bin/env tsx
/**
 * Download XAU/USD 1H candles from Dukascopy for gold backtesting.
 *
 * Uses dukascopy-node (free historical data, no API key required).
 * XAU/USD spot — not exactly GC futures, but spread is <0.3% and
 * session patterns (Asian/London/NY) are identical.
 *
 * Usage:
 *   npx tsx scripts/download-gold-data.ts                    # Default: 2015-01-01 to now
 *   npx tsx scripts/download-gold-data.ts --from 2013-01-01  # Custom start
 *   npx tsx scripts/download-gold-data.ts --to 2025-01-01    # Custom end
 */

import * as fs from 'fs';
import * as path from 'path';
import { getHistoricalRates } from 'dukascopy-node';
import type { Candle } from '../src/types/candle';

const ONE_HOUR_MS = 3_600_000;
const OUTPUT_PATH = path.resolve(__dirname, '..', 'data', 'GC_F_1h.json');

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
  missingHours: number;
  isWeekend: boolean;
}

function isWeekendOrHolidayGap(afterTs: number, beforeTs: number): boolean {
  const d1 = new Date(afterTs);
  const d2 = new Date(beforeTs);
  const day1 = d1.getUTCDay();
  const day2 = d2.getUTCDay();
  // Friday→Sunday/Monday is a weekend gap
  if (day1 === 5 && (day2 === 0 || day2 === 1)) return true;
  // Thursday/Friday close → Sunday/Monday open near holidays (Christmas, Easter, etc.)
  // Gaps of exactly 73-77 hours crossing a weekend are holiday+weekend combos
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
  gaps: GapInfo[];
  weekdayGaps: GapInfo[];
} {
  let ohlcErrors = 0;
  let zeroVolume = 0;
  const gaps: GapInfo[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // OHLC consistency: high >= max(open,close), low <= min(open,close)
    if (c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) {
      ohlcErrors++;
    }

    if (c.volume === 0 || c.volume === undefined) {
      zeroVolume++;
    }

    // Gap detection
    if (i > 0) {
      const expected = candles[i - 1].timestamp + ONE_HOUR_MS;
      if (c.timestamp > expected) {
        const missingHours = Math.round((c.timestamp - expected) / ONE_HOUR_MS);
        gaps.push({
          after: candles[i - 1].timestamp,
          before: c.timestamp,
          missingHours,
          isWeekend: isWeekendOrHolidayGap(candles[i - 1].timestamp, c.timestamp),
        });
      }
    }
  }

  const weekdayGaps = gaps.filter((g) => !g.isWeekend);

  return {
    total: candles.length,
    startDate: candles.length > 0 ? new Date(candles[0].timestamp).toISOString() : 'N/A',
    endDate: candles.length > 0 ? new Date(candles[candles.length - 1].timestamp).toISOString() : 'N/A',
    ohlcErrors,
    zeroVolume,
    gaps,
    weekdayGaps,
  };
}

function crossValidateWithExisting(newCandles: Candle[]): void {
  if (!fs.existsSync(OUTPUT_PATH)) {
    console.log('\n  No existing data to cross-validate against.\n');
    return;
  }

  const existing: Candle[] = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
  if (existing.length === 0) return;

  const existingStart = existing[0].timestamp;
  const existingEnd = existing[existing.length - 1].timestamp;

  // Build lookup from new data for overlap period
  const newMap = new Map<number, Candle>();
  for (const c of newCandles) {
    if (c.timestamp >= existingStart && c.timestamp <= existingEnd) {
      newMap.set(c.timestamp, c);
    }
  }

  // Sample up to 100 random existing candles
  const sampleSize = Math.min(100, existing.length);
  const step = Math.max(1, Math.floor(existing.length / sampleSize));
  let matched = 0;
  let deviations = 0;
  const devList: Array<{ ts: string; field: string; old: number; new: number; pctDiff: number }> = [];

  for (let i = 0; i < existing.length; i += step) {
    const old = existing[i];
    const neu = newMap.get(old.timestamp);
    if (!neu) continue;
    matched++;

    for (const field of ['open', 'high', 'low', 'close'] as const) {
      const pctDiff = Math.abs(neu[field] - old[field]) / old[field] * 100;
      if (pctDiff > 0.5) {
        deviations++;
        devList.push({
          ts: new Date(old.timestamp).toISOString(),
          field,
          old: old[field],
          new: neu[field],
          pctDiff: Math.round(pctDiff * 100) / 100,
        });
      }
    }
  }

  console.log('\n=== Cross-Validation (Dukascopy spot vs existing futures) ===');
  console.log(`  Overlap period: ${new Date(existingStart).toISOString().slice(0, 10)} → ${new Date(existingEnd).toISOString().slice(0, 10)}`);
  console.log(`  Candles matched: ${matched} / ${sampleSize} samples`);
  console.log(`  Price deviations > 0.5%: ${deviations}`);

  if (devList.length > 0) {
    console.log('  Largest deviations:');
    const sorted = devList.sort((a, b) => b.pctDiff - a.pctDiff).slice(0, 5);
    for (const d of sorted) {
      console.log(`    ${d.ts} ${d.field}: old=${d.old.toFixed(2)}, new=${d.new.toFixed(2)} (${d.pctDiff}%)`);
    }
  }
  console.log();
}

async function downloadChunk(from: Date, to: Date, label: string): Promise<Candle[]> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const data = await getHistoricalRates({
        instrument: 'xauusd',
        dates: { from, to },
        timeframe: 'h1',
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
  const startYear = new Date(fromDate).getUTCFullYear();
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
  const fromDate = getArg('from') ?? '2015-01-01';
  const toDate = getArg('to') ?? new Date().toISOString().slice(0, 10);

  console.log(`Downloading XAU/USD 1H candles from Dukascopy`);
  console.log(`  Range: ${fromDate} → ${toDate}`);
  console.log(`  Instrument: xauusd (spot)`);
  console.log(`  Downloading in yearly chunks to avoid timeouts...\n`);

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

  const candles = allCandles;

  // Sort by timestamp (should already be sorted, but be safe)
  candles.sort((a, b) => a.timestamp - b.timestamp);

  // Remove duplicates
  const seen = new Set<number>();
  const deduped = candles.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });

  if (deduped.length < candles.length) {
    console.log(`  Removed ${candles.length - deduped.length} duplicate candles`);
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
    console.log('\n  WARNING: Weekday gaps found (may indicate data issues):');
    const sorted = [...validation.weekdayGaps].sort((a, b) => b.missingHours - a.missingHours);
    for (const gap of sorted.slice(0, 10)) {
      const after = new Date(gap.after).toISOString();
      const before = new Date(gap.before).toISOString();
      console.log(`    ${after} → ${before} (${gap.missingHours} hours missing)`);
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
    console.log(`    ${year}: ${count.toLocaleString()}`);
  }

  // Cross-validate with existing data
  crossValidateWithExisting(deduped);

  // Save
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(deduped));
  const sizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`Saved to ${OUTPUT_PATH} (${sizeMB} MB, ${deduped.length.toLocaleString()} candles)`);

  // Spot-check notable dates
  console.log('\n=== Spot-Check Notable Gold Prices ===');
  const spotChecks = [
    { date: '2020-08-06', label: 'Gold ATH ~$2,075', expected: 2075 },
    { date: '2022-09-28', label: 'Gold bottom ~$1,620', expected: 1620 },
    { date: '2015-12-03', label: 'Gold low ~$1,050', expected: 1050 },
    { date: '2024-10-30', label: 'Gold new ATH ~$2,780', expected: 2780 },
  ];

  for (const check of spotChecks) {
    const targetTs = new Date(check.date + 'T12:00:00Z').getTime();
    // Find nearest candle
    let nearest = deduped[0];
    let minDist = Math.abs(deduped[0].timestamp - targetTs);
    for (const c of deduped) {
      const dist = Math.abs(c.timestamp - targetTs);
      if (dist < minDist) {
        minDist = dist;
        nearest = c;
      }
    }
    const hoursOff = Math.round(minDist / ONE_HOUR_MS);
    const pctDiff = ((nearest.close - check.expected) / check.expected * 100).toFixed(1);
    console.log(`  ${check.date} (${check.label}): close=${nearest.close.toFixed(2)} (${pctDiff}% vs expected, ${hoursOff}h off)`);
  }
}

main().catch((err) => {
  console.error('Download failed:', err);
  process.exit(1);
});
