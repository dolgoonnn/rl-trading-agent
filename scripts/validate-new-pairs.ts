#!/usr/bin/env npx tsx
/**
 * Batch Pair Validation Script
 *
 * Fetches 1H data and runs walk-forward validation for candidate crypto pairs
 * using the CMA-ES Run 18 production config. Generates a report of which pairs
 * pass the minimum WF pass rate threshold.
 *
 * Usage:
 *   npx tsx scripts/validate-new-pairs.ts                          # Full pipeline (fetch + validate)
 *   npx tsx scripts/validate-new-pairs.ts --skip-fetch             # Skip data fetch
 *   npx tsx scripts/validate-new-pairs.ts --symbols BNBUSDT,XRPUSDT
 *   npx tsx scripts/validate-new-pairs.ts --min-pass-rate 0.6      # Custom threshold (default: 0.6)
 *   npx tsx scripts/validate-new-pairs.ts --include-existing       # Also validate BTC/ETH/SOL
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCryptoSymbols } from '../src/lib/rl/config/symbols';

// ============================================
// Run 18 Production Config (CMA-ES optimized)
// ============================================

const RUN18_ARGS = [
  '--strategy', 'ob',
  '--sl-mode', 'dynamic_rr',
  '--friction', '0.0007',
  '--suppress-regime', 'ranging+normal,ranging+high,downtrend+high',
  '--threshold', '4.672',
  '--exit-mode', 'simple',
  '--partial-tp', '0.55,0.84,0.05',
  '--atr-extension', '4.10',
  '--ob-half-life', '18',
  '--max-bars', '108',
  '--cooldown-bars', '8',
  '--regime-threshold', 'uptrend+high:2.86,uptrend+normal:6.17,uptrend+low:3.13,downtrend+normal:4.33,downtrend+low:4.48',
  '--weights', 'structureAlignment:2.660,killZoneActive:0.814,liquiditySweep:1.733,obProximity:1.103,fvgAtCE:1.554,recentBOS:1.255,rrRatio:0.627,oteZone:0.787,obFvgConfluence:1.352',
];

// Original 3 pairs (excluded by default to avoid re-testing known goods)
const EXISTING_PAIRS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);

// ============================================
// Types
// ============================================

interface PairResult {
  symbol: string;
  passRate: number;
  totalWindows: number;
  passedWindows: number;
  totalTrades: number;
  winRate: number;
  avgSharpe: number;
  totalPnl: number;
  passed: boolean;
  error?: string;
}

// ============================================
// CLI Parsing
// ============================================

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

// ============================================
// Data Fetching
// ============================================

function fetchDataForSymbol(symbol: string): boolean {
  const dataPath = path.join(process.cwd(), 'data', `${symbol}_1h.json`);

  // Skip if data already exists and is recent enough (>1000 candles)
  if (fs.existsSync(dataPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      if (Array.isArray(data) && data.length > 1000) {
        console.log(`  [skip] ${symbol}_1h.json already exists (${data.length} candles)`);
        return true;
      }
    } catch {
      // Corrupted file, re-fetch
    }
  }

  console.log(`  [fetch] ${symbol} 1H data (3 years)...`);
  try {
    execSync(
      `npx tsx scripts/fetch-historical-data.ts --symbol ${symbol} --timeframe 1h --days 1095`,
      { cwd: process.cwd(), stdio: 'pipe', timeout: 120_000 }
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [error] Failed to fetch ${symbol}: ${message}`);
    return false;
  }
}

// ============================================
// Walk-Forward Validation
// ============================================

function validateSymbol(symbol: string): PairResult {
  const args = [
    ...RUN18_ARGS,
    '--symbols', symbol,
    '--json',
  ];

  // Write JSON output to a temp file to avoid pipe buffer truncation (8KB limit).
  // backtest-confluence.ts exits with code 1 when WF fails but still writes valid JSON.
  const tmpFile = path.join(os.tmpdir(), `validate-${symbol}-${Date.now()}.json`);
  const cmd = `npx tsx scripts/backtest-confluence.ts ${args.join(' ')} > "${tmpFile}" 2>&1`;

  try {
    try {
      execSync(cmd, {
        cwd: process.cwd(),
        shell: true,
        timeout: 300_000,
      });
    } catch {
      // Exit code 1 is expected for failed WF validation — output is still in tmpFile
    }

    if (!fs.existsSync(tmpFile)) {
      throw new Error('No output file produced');
    }

    const stdout = fs.readFileSync(tmpFile, 'utf-8');
    fs.unlinkSync(tmpFile);

    if (!stdout.trim().startsWith('{')) {
      const lastLines = stdout.split('\n').filter(Boolean).slice(-3).join(' | ');
      throw new Error(lastLines || 'No JSON output');
    }

    const result = JSON.parse(stdout);

    const wfResult = result.walkForwardResult;
    const symbolResult = wfResult.symbols[0];

    return {
      symbol,
      passRate: wfResult.passRate,
      totalWindows: symbolResult?.totalWindows ?? 0,
      passedWindows: symbolResult?.positiveWindows ?? 0,
      totalTrades: result.totalTrades,
      winRate: result.overallWinRate,
      avgSharpe: symbolResult?.avgSharpe ?? 0,
      totalPnl: result.overallPnl * 100,
      passed: false, // Set later based on threshold
    };
  } catch (err) {
    // Clean up temp file on error
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : String(err);
    return {
      symbol,
      passRate: 0,
      totalWindows: 0,
      passedWindows: 0,
      totalTrades: 0,
      winRate: 0,
      avgSharpe: 0,
      totalPnl: 0,
      passed: false,
      error: message,
    };
  }
}

// ============================================
// Report Generation
// ============================================

function generateReport(results: PairResult[], minPassRate: number): string {
  const passed = results.filter((r) => r.passed && !r.error);
  const failed = results.filter((r) => !r.passed || r.error);
  const sorted = [...results].sort((a, b) => b.passRate - a.passRate);
  const date = new Date().toISOString().split('T')[0];

  let md = `# Pair Validation Report — ${date}\n\n`;
  md += `## Summary\n`;
  md += `- **Candidates tested:** ${results.length}\n`;
  md += `- **Passed (>= ${(minPassRate * 100).toFixed(0)}% WF pass rate):** ${passed.length}\n`;
  md += `- **Failed:** ${failed.length}\n`;
  md += `- **Config:** CMA-ES Run 18 (threshold=${RUN18_ARGS[RUN18_ARGS.indexOf('--threshold') + 1]})\n\n`;

  md += `## Results (sorted by pass rate)\n\n`;
  md += `| Pair | WF Pass Rate | Windows | Trades | Win Rate | Avg Sharpe | Total PnL | Verdict |\n`;
  md += `|------|-------------|---------|--------|----------|------------|-----------|--------|\n`;

  for (const r of sorted) {
    if (r.error) {
      md += `| ${r.symbol} | — | — | — | — | — | — | ERROR |\n`;
    } else {
      const verdict = r.passed ? 'PASS' : 'FAIL';
      md += `| ${r.symbol} | ${(r.passRate * 100).toFixed(1)}% | ${r.passedWindows}/${r.totalWindows} | ${r.totalTrades} | ${r.winRate.toFixed(1)}% | ${r.avgSharpe.toFixed(2)} | ${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(1)}% | ${verdict} |\n`;
    }
  }

  if (passed.length > 0) {
    const allValidated = [...Array.from(EXISTING_PAIRS), ...passed.map((r) => r.symbol)];
    md += `\n## Validated Pairs for Paper Trading\n`;
    md += `\`${allValidated.join(', ')}\`\n\n`;
    md += `## Paper Trade Command\n`;
    md += `\`\`\`bash\nnpx tsx scripts/paper-trade-confluence.ts --symbols ${allValidated.join(',')}\n\`\`\`\n`;
  }

  // Errors section
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    md += `\n## Errors\n`;
    for (const r of errors) {
      md += `- **${r.symbol}:** ${r.error}\n`;
    }
  }

  return md;
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const skipFetch = hasFlag('skip-fetch');
  const includeExisting = hasFlag('include-existing');
  const minPassRate = parseFloat(getArg('min-pass-rate') ?? '0.6');
  const symbolsArg = getArg('symbols');

  // Determine which pairs to validate
  let candidates: string[];
  if (symbolsArg) {
    candidates = symbolsArg.split(',').map((s) => s.trim().toUpperCase());
  } else {
    candidates = getCryptoSymbols().filter(
      (s) => includeExisting || !EXISTING_PAIRS.has(s)
    );
  }

  console.log('='.repeat(60));
  console.log('ICT Trading — Batch Pair Validation');
  console.log('='.repeat(60));
  console.log(`Candidates: ${candidates.length} pairs`);
  console.log(`Min pass rate: ${(minPassRate * 100).toFixed(0)}%`);
  console.log(`Skip fetch: ${skipFetch}`);
  console.log(`Config: CMA-ES Run 18 production`);
  console.log('');

  // Step 1: Fetch data
  if (!skipFetch) {
    console.log('--- Step 1: Fetching historical data ---');
    const fetchFailed: string[] = [];
    for (const symbol of candidates) {
      const ok = fetchDataForSymbol(symbol);
      if (!ok) fetchFailed.push(symbol);
    }
    if (fetchFailed.length > 0) {
      console.log(`\nFailed to fetch: ${fetchFailed.join(', ')}`);
      candidates = candidates.filter((s) => !fetchFailed.includes(s));
    }
    console.log('');
  }

  // Step 2: Validate each pair
  console.log('--- Step 2: Walk-forward validation ---');
  const results: PairResult[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const symbol = candidates[i];
    console.log(`[${i + 1}/${candidates.length}] Validating ${symbol}...`);
    const start = Date.now();
    const result = validateSymbol(symbol);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    result.passed = !result.error && result.passRate >= minPassRate;
    results.push(result);

    if (result.error) {
      console.log(`  ERROR: ${result.error} (${elapsed}s)`);
    } else {
      const verdict = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(
        `  ${verdict} — WF: ${(result.passRate * 100).toFixed(1)}%, ` +
        `Trades: ${result.totalTrades}, WR: ${result.winRate.toFixed(1)}%, ` +
        `Sharpe: ${result.avgSharpe.toFixed(2)}, PnL: ${result.totalPnl >= 0 ? '+' : ''}${result.totalPnl.toFixed(1)}% (${elapsed}s)`
      );
    }
  }

  // Step 3: Generate reports
  console.log('\n--- Step 3: Generating reports ---');

  const expDir = path.join(process.cwd(), 'experiments');
  if (!fs.existsSync(expDir)) {
    fs.mkdirSync(expDir, { recursive: true });
  }

  const reportMd = generateReport(results, minPassRate);
  const mdPath = path.join(expDir, 'pair-validation-report.md');
  fs.writeFileSync(mdPath, reportMd);
  console.log(`Report: ${mdPath}`);

  const jsonPath = path.join(expDir, 'pair-validation-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ date: new Date().toISOString(), minPassRate, config: 'cmaes-run18', results }, null, 2));
  console.log(`JSON:   ${jsonPath}`);

  // Summary
  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Passed: ${passed.length}/${results.length} pairs (>= ${(minPassRate * 100).toFixed(0)}% WF pass rate)`);
  if (passed.length > 0) {
    console.log(`Validated: ${passed.map((r) => r.symbol).join(', ')}`);
  }
  if (failed.length > 0) {
    console.log(`Failed:    ${failed.map((r) => r.symbol).join(', ')}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
