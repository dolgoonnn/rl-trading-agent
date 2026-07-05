#!/usr/bin/env tsx
/**
 * Download Deriv synthetic-index candles for backtesting.
 *
 * These are RNG-generated synthetic instruments (Boom/Crash/Volatility/Step/
 * Jump). They have NO volume (set to uniform 1 — see downloader header) and
 * are NOT real markets. Used here to stress-test our bots against a process
 * with no underlying order-flow mechanism.
 *
 * Usage:
 *   npx tsx scripts/download-deriv-data.ts --symbol BOOM500 --tf 1m --count 100000
 *   npx tsx scripts/download-deriv-data.ts --symbols BOOM500,CRASH500,R_75 --tf 1h --count 20000
 *   npx tsx scripts/download-deriv-data.ts --symbols BOOM500,CRASH500 --tf 1m,1h
 *
 * Common synthetic symbols:
 *   BOOM500 BOOM1000 CRASH500 CRASH1000   (spike indices — structural asymmetry)
 *   R_10 R_25 R_50 R_75 R_100             (constant-volatility GBM)
 *   1HZ10V 1HZ25V 1HZ50V 1HZ75V 1HZ100V   (1-second volatility)
 *   stpRNG (step)  JD10 JD25 ... (jump)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  downloadDerivCandles,
  TF_TO_GRANULARITY,
} from '../src/lib/deriv/downloader';
import { validateCandles } from '../src/lib/scalp/data/downloader';

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

async function downloadOne(symbol: string, tf: string, count: number, appId: string): Promise<void> {
  const granularity = TF_TO_GRANULARITY[tf];
  if (!granularity) {
    throw new Error(`Unknown --tf "${tf}". Supported: ${Object.keys(TF_TO_GRANULARITY).join(', ')}`);
  }

  console.log(`\n→ ${symbol} ${tf} (target ${count.toLocaleString()} candles)`);
  const candles = await downloadDerivCandles(symbol, granularity, count, {
    appId,
    onProgress: (p) => {
      const oldest = new Date(p.oldestEpoch * 1000).toISOString().slice(0, 10);
      const newest = new Date(p.newestEpoch * 1000).toISOString().slice(0, 10);
      process.stdout.write(
        `\r  req ${p.requestCount} | candles ${p.totalCandles.toLocaleString()} | ${oldest} → ${newest}`,
      );
    },
  });
  console.log('');

  if (candles.length === 0) {
    console.error(`  ✗ No data returned for ${symbol} ${tf}`);
    return;
  }

  const validation = validateCandles(candles, granularity * 1000);
  console.log(`  candles: ${validation.totalCandles.toLocaleString()} | ${validation.startDate.slice(0, 10)} → ${validation.endDate.slice(0, 10)}`);
  console.log(`  ohlc errors: ${validation.ohlcErrors} | gaps: ${validation.gaps.length}`);

  const outPath = path.resolve(__dirname, '..', 'data', `${symbol}_${tf}.json`);
  fs.writeFileSync(outPath, JSON.stringify(candles));
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ saved ${outPath} (${sizeMB} MB)`);
}

async function main(): Promise<void> {
  const symbolsArg = getArg('symbols') ?? getArg('symbol') ?? 'BOOM500';
  const tfArg = getArg('tf') ?? '1m';
  const count = parseInt(getArg('count') ?? '100000', 10);
  const appId = getArg('app-id') ?? '1089';

  const symbols = symbolsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const timeframes = tfArg.split(',').map((s) => s.trim()).filter(Boolean);

  console.log(`Deriv downloader | app_id=${appId} | symbols=[${symbols.join(', ')}] | tf=[${timeframes.join(', ')}]`);

  for (const symbol of symbols) {
    for (const tf of timeframes) {
      try {
        await downloadOne(symbol, tf, count, appId);
      } catch (err) {
        console.error(`  ✗ ${symbol} ${tf} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
}

main().catch((err) => {
  console.error('Deriv download failed:', err);
  process.exit(1);
});
