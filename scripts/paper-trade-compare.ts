#!/usr/bin/env npx tsx
/**
 * Paper Trade Comparison Script
 * Compare paper trading results with backtest expectations
 *
 * Usage:
 *   npx tsx scripts/paper-trade-compare.ts --session pt_2026-02-01_143000
 *   npx tsx scripts/paper-trade-compare.ts --session pt_2026-02-01_143000 --backtest-data ./data/backtest-results.json
 */

import fs from 'fs';
import path from 'path';

import '@tensorflow/tfjs-node';

import {
  getSessionById,
  getTradesForSession,
  type PaperSession,
  type PaperTrade,
  type PaperBacktestComparison,
} from '../src/lib/paper-trading';

interface BacktestResult {
  trades: {
    entryIndex: number;
    exitIndex: number;
    entryPrice: number;
    exitPrice: number;
    side: 'long' | 'short';
    pnl: number;
    pnlPercent: number;
    holdingPeriod: number;
  }[];
  metrics: {
    totalTrades: number;
    winRate: number;
    sharpe: number;
    totalPnl: number;
    maxDrawdown: number;
  };
}

interface Args {
  session: string;
  backtestData?: string;
  signalThreshold: number;
  actionThreshold: number;
  sharpeThreshold: number;
  help: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options['help'] = 'true';
    } else if (arg?.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      } else {
        options[key] = 'true';
      }
    }
  }

  return {
    session: options['session'] || '',
    backtestData: options['backtest-data'],
    signalThreshold: parseFloat(options['signal-threshold'] || '0.95'), // 95%
    actionThreshold: parseFloat(options['action-threshold'] || '0.90'), // 90%
    sharpeThreshold: parseFloat(options['sharpe-threshold'] || '0.2'), // ±0.2
    help: options['help'] === 'true',
  };
}

function printHelp(): void {
  console.log(`
Paper Trading Comparison Tool

Compare paper trading results with backtest expectations to validate
the live trading system matches the training environment.

Usage:
  npx tsx scripts/paper-trade-compare.ts --session <session_id> [options]

Options:
  --session <id>              Paper trading session ID (required)
  --backtest-data <path>      Path to backtest results JSON file
  --signal-threshold <pct>    Signal match threshold (default: 0.95 = 95%)
  --action-threshold <pct>    Action match threshold (default: 0.90 = 90%)
  --sharpe-threshold <val>    Max Sharpe deviation (default: 0.2)
  --help, -h                  Show this help message

Success Criteria:
  1. Signal match rate > 95%
  2. Action match rate > 90%
  3. Sharpe deviation < ±0.2

Examples:
  # Compare session with automatic backtest detection
  npx tsx scripts/paper-trade-compare.ts --session pt_2026-02-01_143000

  # Compare with specific backtest file
  npx tsx scripts/paper-trade-compare.ts --session pt_2026-02-01_143000 --backtest-data ./results/backtest.json
  `);
}

async function loadBacktestData(dataPath: string | undefined, session: PaperSession): Promise<BacktestResult | null> {
  if (dataPath) {
    const absolutePath = path.resolve(dataPath);
    if (!fs.existsSync(absolutePath)) {
      console.error(`Backtest data not found: ${absolutePath}`);
      return null;
    }
    const content = fs.readFileSync(absolutePath, 'utf-8');
    return JSON.parse(content) as BacktestResult;
  }

  // Try to find backtest data automatically
  const possiblePaths = [
    `./data/backtest-${session.symbol}-${session.timeframe}.json`,
    `./results/backtest-${session.symbol}.json`,
    './data/backtest-results.json',
  ];

  for (const p of possiblePaths) {
    const absolutePath = path.resolve(p);
    if (fs.existsSync(absolutePath)) {
      console.log(`Found backtest data at: ${p}`);
      const content = fs.readFileSync(absolutePath, 'utf-8');
      return JSON.parse(content) as BacktestResult;
    }
  }

  console.warn('No backtest data found. Comparison will be limited to paper trading metrics only.');
  return null;
}

function compareSignals(
  paperTrades: PaperTrade[],
  backtestTrades: BacktestResult['trades']
): { matchRate: number; matched: number; missed: number; false: number } {
  if (backtestTrades.length === 0) {
    return { matchRate: 1, matched: paperTrades.length, missed: 0, false: 0 };
  }

  let matched = 0;
  let missed = 0;
  let falseSignals = 0;

  // Build index maps
  const paperEntryIndices = new Set(paperTrades.map((t) => t.entryIndex));
  const backtestEntryIndices = new Set(backtestTrades.map((t) => t.entryIndex));

  // Check for matches (within 1 bar tolerance)
  for (const btEntry of backtestEntryIndices) {
    const found = paperEntryIndices.has(btEntry) ||
      paperEntryIndices.has(btEntry - 1) ||
      paperEntryIndices.has(btEntry + 1);

    if (found) {
      matched++;
    } else {
      missed++;
    }
  }

  // Check for false signals (paper signals not in backtest)
  for (const ptEntry of paperEntryIndices) {
    const found = backtestEntryIndices.has(ptEntry) ||
      backtestEntryIndices.has(ptEntry - 1) ||
      backtestEntryIndices.has(ptEntry + 1);

    if (!found) {
      falseSignals++;
    }
  }

  const total = matched + missed;
  const matchRate = total > 0 ? matched / total : 1;

  return { matchRate, matched, missed, false: falseSignals };
}

function compareActions(
  paperTrades: PaperTrade[],
  backtestTrades: BacktestResult['trades']
): { matchRate: number; matched: number; mismatched: number } {
  if (backtestTrades.length === 0 || paperTrades.length === 0) {
    return { matchRate: 1, matched: 0, mismatched: 0 };
  }

  let matched = 0;
  let mismatched = 0;

  // Compare exit actions for matching trades
  for (const pt of paperTrades) {
    // Find matching backtest trade
    const bt = backtestTrades.find(
      (t) => Math.abs(t.entryIndex - pt.entryIndex) <= 1 && t.side === pt.side
    );

    if (!bt) continue;

    // Compare exit reasons/actions
    const ptExitType = pt.exitReason;
    const btExitType = inferBacktestExitType(bt);

    if (ptExitType === btExitType || areExitsCompatible(ptExitType, btExitType)) {
      matched++;
    } else {
      mismatched++;
    }
  }

  const total = matched + mismatched;
  const matchRate = total > 0 ? matched / total : 1;

  return { matchRate, matched, mismatched };
}

function inferBacktestExitType(trade: BacktestResult['trades'][0]): string {
  // Infer exit type from backtest trade characteristics
  // This is heuristic-based since backtest may not have explicit exit reasons
  const pnlPercent = trade.pnlPercent;

  if (pnlPercent <= -0.018) return 'stop_loss'; // ~2% loss
  if (pnlPercent >= 0.035) return 'take_profit'; // ~4% gain
  if (trade.holdingPeriod >= 45) return 'max_bars';
  return 'agent';
}

function areExitsCompatible(a: string | undefined, b: string): boolean {
  // Some exit types are functionally equivalent
  if (!a) return false;
  if (a === b) return true;
  if (a === 'agent' && b === 'agent') return true;
  return false;
}

function compareMetrics(
  paperMetrics: { sharpe: number; winRate: number; totalPnl: number },
  backtestMetrics: BacktestResult['metrics']
): { sharpeDeviation: number; winRateDeviation: number; pnlDeviation: number } {
  return {
    sharpeDeviation: paperMetrics.sharpe - backtestMetrics.sharpe,
    winRateDeviation: paperMetrics.winRate - backtestMetrics.winRate,
    pnlDeviation: paperMetrics.totalPnl - backtestMetrics.totalPnl,
  };
}

function printComparison(comparison: PaperBacktestComparison): void {
  console.log();
  console.log('='.repeat(80));
  console.log('PAPER TRADING vs BACKTEST COMPARISON');
  console.log('='.repeat(80));
  console.log();

  // Signal matching
  console.log('SIGNAL MATCHING');
  console.log('-'.repeat(40));
  console.log(`  Match Rate: ${(comparison.signalMatchRate * 100).toFixed(1)}%`);
  console.log(`  Matched: ${comparison.signalsMatched}`);
  console.log(`  Missed: ${comparison.signalsMissed}`);
  console.log(`  False Signals: ${comparison.falseSignals}`);
  console.log(`  Status: ${comparison.signalMatchPassed ? '✓ PASSED' : '✗ FAILED'} (threshold: 95%)`);
  console.log();

  // Action matching
  console.log('ACTION MATCHING');
  console.log('-'.repeat(40));
  console.log(`  Match Rate: ${(comparison.actionMatchRate * 100).toFixed(1)}%`);
  console.log(`  Matched: ${comparison.actionsMatched}`);
  console.log(`  Mismatched: ${comparison.actionsMismatched}`);
  console.log(`  Status: ${comparison.actionMatchPassed ? '✓ PASSED' : '✗ FAILED'} (threshold: 90%)`);
  console.log();

  // Performance comparison
  console.log('PERFORMANCE COMPARISON');
  console.log('-'.repeat(40));
  console.log(`  Paper Sharpe: ${comparison.paperSharpe.toFixed(2)}`);
  console.log(`  Backtest Sharpe: ${comparison.backtestSharpe.toFixed(2)}`);
  console.log(`  Deviation: ${comparison.sharpeDeviation >= 0 ? '+' : ''}${comparison.sharpeDeviation.toFixed(2)}`);
  console.log(`  Status: ${comparison.sharpeDeviationPassed ? '✓ PASSED' : '✗ FAILED'} (threshold: ±0.2)`);
  console.log();

  console.log(`  Paper Win Rate: ${comparison.paperWinRate.toFixed(1)}%`);
  console.log(`  Backtest Win Rate: ${comparison.backtestWinRate.toFixed(1)}%`);
  console.log(`  Deviation: ${comparison.winRateDeviation >= 0 ? '+' : ''}${comparison.winRateDeviation.toFixed(1)}%`);
  console.log();

  console.log(`  Paper PnL: $${comparison.paperPnl.toFixed(2)}`);
  console.log(`  Backtest PnL: $${comparison.backtestPnl.toFixed(2)}`);
  console.log(`  Deviation: ${comparison.pnlDeviation >= 0 ? '+' : ''}$${comparison.pnlDeviation.toFixed(2)}`);
  console.log();

  // Overall result
  console.log('='.repeat(80));
  if (comparison.overallPassed) {
    console.log('✓ OVERALL: VALIDATION PASSED');
    console.log('  Paper trading system matches backtest expectations.');
  } else {
    console.log('✗ OVERALL: VALIDATION FAILED');
    console.log('  Paper trading system deviates from backtest. Investigate discrepancies.');
  }
  console.log('='.repeat(80));
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.session) {
    console.error('Error: --session is required');
    printHelp();
    process.exit(1);
  }

  console.log('='.repeat(80));
  console.log('Paper Trading Comparison Tool');
  console.log('='.repeat(80));
  console.log();
  console.log(`Session: ${args.session}`);
  console.log();

  // Load session
  const session = await getSessionById(args.session);
  if (!session) {
    console.error(`Session not found: ${args.session}`);
    process.exit(1);
  }

  console.log('Session Details:');
  console.log(`  Symbol: ${session.symbol}`);
  console.log(`  Timeframe: ${session.timeframe}`);
  console.log(`  Model: ${session.modelPath}`);
  console.log(`  Trades: ${session.totalTrades}`);
  console.log(`  Win Rate: ${session.wins > 0 ? ((session.wins / session.totalTrades) * 100).toFixed(1) : 0}%`);
  console.log(`  Total PnL: $${session.totalPnl.toFixed(2)}`);
  console.log(`  Sharpe: ${session.sharpe.toFixed(2)}`);
  console.log();

  // Load paper trades
  const paperTrades = await getTradesForSession(args.session);
  console.log(`Loaded ${paperTrades.length} paper trades`);

  // Load backtest data
  const backtestData = await loadBacktestData(args.backtestData, session);

  if (!backtestData) {
    console.log();
    console.log('No backtest data available for comparison.');
    console.log('Run a backtest with the same model and save results to enable comparison.');
    console.log();
    console.log('To generate backtest data:');
    console.log('  npx tsx scripts/train-hybrid-kb.ts --data ./data/BTCUSDT_1h.json --output ./results/backtest.json');
    return;
  }

  console.log(`Loaded ${backtestData.trades.length} backtest trades`);
  console.log();

  // Compare signals
  const signalComparison = compareSignals(paperTrades, backtestData.trades);

  // Compare actions
  const actionComparison = compareActions(paperTrades, backtestData.trades);

  // Compare metrics
  const paperMetrics = {
    sharpe: session.sharpe,
    winRate: session.totalTrades > 0 ? (session.wins / session.totalTrades) * 100 : 0,
    totalPnl: session.totalPnl,
  };
  const metricComparison = compareMetrics(paperMetrics, backtestData.metrics);

  // Build comparison result
  const comparison: PaperBacktestComparison = {
    sessionId: args.session,

    signalMatchRate: signalComparison.matchRate,
    signalsMatched: signalComparison.matched,
    signalsMissed: signalComparison.missed,
    falseSignals: signalComparison.false,

    actionMatchRate: actionComparison.matchRate,
    actionsMatched: actionComparison.matched,
    actionsMismatched: actionComparison.mismatched,

    paperSharpe: paperMetrics.sharpe,
    backtestSharpe: backtestData.metrics.sharpe,
    sharpeDeviation: metricComparison.sharpeDeviation,

    paperWinRate: paperMetrics.winRate,
    backtestWinRate: backtestData.metrics.winRate,
    winRateDeviation: metricComparison.winRateDeviation,

    paperPnl: paperMetrics.totalPnl,
    backtestPnl: backtestData.metrics.totalPnl,
    pnlDeviation: metricComparison.pnlDeviation,

    signalMatchPassed: signalComparison.matchRate >= args.signalThreshold,
    actionMatchPassed: actionComparison.matchRate >= args.actionThreshold,
    sharpeDeviationPassed: Math.abs(metricComparison.sharpeDeviation) <= args.sharpeThreshold,
    overallPassed: false,
  };

  comparison.overallPassed = comparison.signalMatchPassed &&
    comparison.actionMatchPassed &&
    comparison.sharpeDeviationPassed;

  // Print results
  printComparison(comparison);

  // Exit with appropriate code
  process.exit(comparison.overallPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
