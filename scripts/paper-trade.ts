#!/usr/bin/env npx tsx
/**
 * Paper Trade CLI
 * Run paper trading with trained KB-enhanced hybrid agent
 *
 * Usage:
 *   npx tsx scripts/paper-trade.ts --symbol BTCUSDT --timeframe 1h
 *   npx tsx scripts/paper-trade.ts --symbol BTCUSDT --model ./models/hybrid-kb-full.json
 *   npx tsx scripts/paper-trade.ts --help
 */

import '@tensorflow/tfjs-node';

import {
  PaperTrader,
  type PaperTraderConfig,
  DEFAULT_PAPER_TRADER_CONFIG,
} from '../src/lib/paper-trading';

interface Args {
  symbol: string;
  timeframe: string;
  model: string;
  capital: number;
  positionSize: number;
  slPercent: number;
  tpPercent: number;
  maxHoldBars: number;
  kbEnabled: boolean;
  kbFeatures: boolean;
  persist: boolean;
  verbose: boolean;
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
    symbol: options['symbol'] || DEFAULT_PAPER_TRADER_CONFIG.symbol,
    timeframe: options['timeframe'] || DEFAULT_PAPER_TRADER_CONFIG.timeframe,
    model: options['model'] || DEFAULT_PAPER_TRADER_CONFIG.modelPath,
    capital: parseFloat(options['capital'] || String(DEFAULT_PAPER_TRADER_CONFIG.initialCapital)),
    positionSize: parseFloat(options['position-size'] || String(DEFAULT_PAPER_TRADER_CONFIG.positionSize)),
    slPercent: parseFloat(options['sl-percent'] || String(DEFAULT_PAPER_TRADER_CONFIG.slPercent)),
    tpPercent: parseFloat(options['tp-percent'] || String(DEFAULT_PAPER_TRADER_CONFIG.tpPercent)),
    maxHoldBars: parseInt(options['max-hold-bars'] || String(DEFAULT_PAPER_TRADER_CONFIG.maxHoldBars), 10),
    kbEnabled: options['no-kb'] !== 'true',
    kbFeatures: options['no-kb-features'] !== 'true',
    persist: options['no-persist'] !== 'true',
    verbose: options['verbose'] === 'true',
    help: options['help'] === 'true',
  };
}

function printHelp(): void {
  console.log(`
ICT Paper Trading - KB-Enhanced Hybrid Agent

Usage:
  npx tsx scripts/paper-trade.ts [options]

Options:
  --symbol <symbol>        Trading symbol (default: BTCUSDT)
  --timeframe <tf>         Timeframe (default: 1h)
  --model <path>           Path to trained model (default: ./models/hybrid-kb-full.json)
  --capital <amount>       Initial capital (default: 10000)
  --position-size <frac>   Position size as fraction of capital (default: 0.1)
  --sl-percent <pct>       Stop loss percentage (default: 0.02)
  --tp-percent <pct>       Take profit percentage (default: 0.04)
  --max-hold-bars <n>      Maximum bars to hold position (default: 50)
  --no-kb                  Disable KB integration
  --no-kb-features         Disable KB features (use 18-feature model)
  --no-persist             Don't save trades to database
  --verbose                Enable verbose logging
  --help, -h               Show this help message

Examples:
  # Start paper trading on BTCUSDT 1h
  npx tsx scripts/paper-trade.ts --symbol BTCUSDT --timeframe 1h

  # Use specific model
  npx tsx scripts/paper-trade.ts --symbol BTCUSDT --model ./models/hybrid-kb-full.json

  # Disable KB integration
  npx tsx scripts/paper-trade.ts --symbol BTCUSDT --no-kb

Keyboard Commands:
  Ctrl+C   - Graceful shutdown (closes positions, saves state)
  `);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  console.log('='.repeat(80));
  console.log('ICT Paper Trading - KB-Enhanced Hybrid Agent');
  console.log('='.repeat(80));
  console.log();
  console.log('Configuration:');
  console.log(`  Symbol: ${args.symbol}`);
  console.log(`  Timeframe: ${args.timeframe}`);
  console.log(`  Model: ${args.model}`);
  console.log(`  Capital: $${args.capital}`);
  console.log(`  Position Size: ${(args.positionSize * 100).toFixed(0)}%`);
  console.log(`  Stop Loss: ${(args.slPercent * 100).toFixed(1)}%`);
  console.log(`  Take Profit: ${(args.tpPercent * 100).toFixed(1)}%`);
  console.log(`  Max Hold Bars: ${args.maxHoldBars}`);
  console.log(`  KB Integration: ${args.kbEnabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(`  KB Features: ${args.kbFeatures ? 'ENABLED' : 'DISABLED'}`);
  console.log(`  Persist Trades: ${args.persist ? 'YES' : 'NO'}`);
  console.log();

  const config: Partial<PaperTraderConfig> = {
    symbol: args.symbol,
    timeframe: args.timeframe,
    modelPath: args.model,
    initialCapital: args.capital,
    positionSize: args.positionSize,
    slPercent: args.slPercent,
    tpPercent: args.tpPercent,
    maxHoldBars: args.maxHoldBars,
    kbEnabled: args.kbEnabled,
    kbFeatures: args.kbFeatures,
    persistTrades: args.persist,
    logLevel: args.verbose ? 'debug' : 'info',
    consoleOutput: true,
  };

  const trader = new PaperTrader(config);

  // Handle graceful shutdown
  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log();
    console.log(`Received ${signal}, shutting down gracefully...`);

    try {
      await trader.stop();
      console.log('Shutdown complete.');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Event handlers
  trader.on('started', (session) => {
    console.log(`Session started: ${session.id}`);
  });

  trader.on('stopped', (session) => {
    console.log(`Session ended: ${session.id}`);
  });

  trader.on('error', (error) => {
    console.error('Error:', error.message);
  });

  // Start trading
  try {
    await trader.start();

    console.log();
    console.log('Paper trading is running. Press Ctrl+C to stop.');
    console.log();

    // Keep process alive
    await new Promise(() => {
      // Never resolves - wait for shutdown signal
    });
  } catch (error) {
    console.error('Failed to start paper trading:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
