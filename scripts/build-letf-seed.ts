#!/usr/bin/env tsx
/**
 * Seed the LETF close-flow bot's rolling threshold history from historical
 * silver 1m data. Writes data/letf-seed.json: the last 250 daily |sig| values
 * (sig = log(P15:00ET / prev P16:00ET)) so run-letf-bot.ts has a full
 * lookback window from day one.
 *
 * Usage: NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/build-letf-seed.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

function nthSundayUTC(year: number, month: number, n: number): number {
  const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return Date.UTC(year, month, 1 + ((7 - dow) % 7) + (n - 1) * 7);
}
function nyOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const start = nthSundayUTC(y, 2, 2) + 7 * 3_600_000;
  const end = nthSundayUTC(y, 10, 1) + 6 * 3_600_000;
  return ts >= start && ts < end ? -4 : -5;
}

function main(): void {
  const candles = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'data', 'XAGUSD_1m.json'), 'utf-8'),
  ) as Candle[];
  candles.sort((a, b) => a.timestamp - b.timestamp);

  const byDay = new Map<string, { m1500?: number; m1600?: number }>();
  for (const c of candles) {
    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day);
    if (!rec) { rec = {}; byDay.set(day, rec); }
    if (lm <= 900 && lm > 870) rec.m1500 = c.close;
    if (lm <= 960 && lm > 930) rec.m1600 = c.close;
  }

  const days = [...byDay.keys()].sort();
  const hist: { day: string; absSig: number }[] = [];
  let prev1600: number | undefined;
  let prev1600Day = '';
  for (const day of days) {
    const rec = byDay.get(day)!;
    if (prev1600 && rec.m1500) {
      const sig = Math.log(rec.m1500 / prev1600);
      if (isFinite(sig) && sig !== 0) hist.push({ day, absSig: Math.abs(sig) });
    }
    if (rec.m1600) { prev1600 = rec.m1600; prev1600Day = day; }
  }

  const seed = {
    generatedAt: new Date().toISOString(),
    instrument: 'silver',
    note: 'daily |log(P15:00ET / prev P16:00ET)| history for the rolling p95 threshold of run-letf-bot.ts',
    lastDay: prev1600Day,
    absSigHistory: hist.slice(-250),
  };
  // Lives under scripts/ (not data/) so it ships in the Docker image — the
  // Railway volume mount shadows /app/data, and .railwayignore drops experiments/.
  fs.writeFileSync(path.resolve(__dirname, 'letf-seed.json'), JSON.stringify(seed, null, 2));
  console.log(`Seed written: ${seed.absSigHistory.length} days ending ${hist.at(-1)?.day} (data through ${prev1600Day})`);
}

main();
