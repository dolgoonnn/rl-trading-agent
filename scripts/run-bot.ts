#!/usr/bin/env npx tsx
/**
 * Paper Trading Bot — Main Entry Point
 *
 * Runs 24/7, polls Bybit for 1H candle closes, evaluates ICT confluence
 * signals, and manages paper positions with the exact same logic as
 * the backtest system.
 *
 * PM2-compatible: handles SIGTERM/SIGINT for graceful shutdown.
 *
 * Usage:
 *   npx tsx scripts/run-bot.ts
 *   npx tsx scripts/run-bot.ts --capital 5000
 *   npx tsx scripts/run-bot.ts --risk 0.003
 *   npx tsx scripts/run-bot.ts --telegram-token BOT_TOKEN --telegram-chat CHAT_ID
 *   npx tsx scripts/run-bot.ts --verbose
 *   npx tsx scripts/run-bot.ts --resume  # Resume from saved state
 */

import {
  DataFeed,
  SignalEngine,
  OrderManager,
  PositionTracker,
  RiskEngine,
  AlertManager,
  DEFAULT_BOT_CONFIG,
  RUN18_STRATEGY_CONFIG,
  DEFAULT_CIRCUIT_BREAKERS,
} from '../src/lib/bot';
import type { BotConfig, BotSymbol } from '../src/types/bot';

// ============================================
// Parse CLI arguments
// ============================================

function parseArgs(): {
  config: BotConfig;
  resume: boolean;
} {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_BOT_CONFIG };
  let resume = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--capital':
        config.initialCapital = parseFloat(args[++i]!);
        break;
      case '--risk':
        config.riskPerTrade = parseFloat(args[++i]!);
        break;
      case '--mode':
        config.mode = args[++i] as BotConfig['mode'];
        break;
      case '--telegram-token':
        config.telegramBotToken = args[++i];
        break;
      case '--telegram-chat':
        config.telegramChatId = args[++i];
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--resume':
        resume = true;
        break;
      case '--symbols': {
        const syms = args[++i]!.split(',') as BotSymbol[];
        config.symbols = syms;
        break;
      }
      case '--poll-delay':
        config.pollDelaySeconds = parseInt(args[++i]!, 10);
        break;
    }
  }

  return { config, resume };
}

// ============================================
// Main Bot Loop
// ============================================

class TradingBot {
  private dataFeed: DataFeed;
  private signalEngine: SignalEngine;
  private orderManager: OrderManager;
  private tracker: PositionTracker;
  private riskEngine: RiskEngine;
  private alerts: AlertManager;
  private config: BotConfig;
  private running = false;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private dailyResetInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: BotConfig, resume: boolean) {
    this.config = config;

    // Initialize components
    this.dataFeed = new DataFeed();
    this.signalEngine = new SignalEngine(RUN18_STRATEGY_CONFIG);
    this.orderManager = new OrderManager(
      config.mode,
      RUN18_STRATEGY_CONFIG,
      config.paperSlippage,
    );
    this.tracker = new PositionTracker(config.initialCapital);
    this.riskEngine = new RiskEngine(DEFAULT_CIRCUIT_BREAKERS, config.maxPositions);
    this.alerts = new AlertManager(config.telegramBotToken, config.telegramChatId);

    // Attempt to resume from saved state
    if (resume) {
      const loaded = this.tracker.loadState();
      if (loaded) {
        console.log(`Resumed from saved state: equity=$${this.tracker.getEquity().toFixed(2)}, open=${this.tracker.getOpenPositions().length} positions`);
      } else {
        console.log('No saved state found, starting fresh');
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('='.repeat(60));
    console.log('ICT Paper Trading Bot');
    console.log('='.repeat(60));
    console.log(`Mode: ${this.config.mode}`);
    console.log(`Symbols: ${this.config.symbols.join(', ')}`);
    console.log(`Capital: $${this.config.initialCapital}`);
    console.log(`Risk/trade: ${(this.config.riskPerTrade * 100).toFixed(2)}%`);
    console.log(`Poll delay: ${this.config.pollDelaySeconds}s after hour close`);
    console.log('='.repeat(60));

    // Backfill candle history
    console.log('\nBackfilling candle history...');
    for (const symbol of this.config.symbols) {
      const count = await this.dataFeed.backfill(symbol);
      console.log(`  ${symbol}: ${count} candles cached`);
    }

    // Save initial state
    this.tracker.saveState();
    this.tracker.recordSnapshot();

    await this.alerts.botStarted();

    // Main loop: check every 30 seconds
    this.tickInterval = setInterval(() => this.tick(), 30_000);

    // Daily reset at midnight UTC
    this.scheduleDailyReset();

    // Run first tick immediately
    await this.tick();
  }

  async stop(reason = 'shutdown'): Promise<void> {
    this.running = false;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.dailyResetInterval) {
      clearInterval(this.dailyResetInterval);
      this.dailyResetInterval = null;
    }

    // Close all open positions on shutdown
    const openPositions = this.tracker.getOpenPositions();
    for (const position of openPositions) {
      try {
        const price = await this.dataFeed.getLatestPrice(position.symbol);
        const result = this.orderManager.forceClose(position, price, 'shutdown');
        this.tracker.closePosition(result.position);
        await this.alerts.positionClosed(result.position);
      } catch (err) {
        console.error(`Failed to close ${position.symbol} position on shutdown:`, err);
      }
    }

    this.tracker.saveState();
    this.tracker.recordSnapshot();
    await this.alerts.botStopped(reason);
    console.log(`Bot stopped: ${reason}`);
  }

  // ============================================
  // Core Tick Logic
  // ============================================

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      // Cleanup expired circuit breakers
      this.riskEngine.cleanupExpiredBreakers(this.tracker);

      for (const symbol of this.config.symbols) {
        await this.processSymbol(symbol);
      }
    } catch (err) {
      console.error('Tick error:', err);
      this.tracker.recordError();
      await this.alerts.error(`Tick failed: ${(err as Error).message}`);

      // Check system error circuit breaker
      const triggered = this.riskEngine.evaluateAfterTrade(this.tracker);
      for (const cb of triggered) {
        if (cb.type === 'system_errors') {
          await this.alerts.circuitBreakerTriggered(cb.type, cb.reason);
        }
      }
    }
  }

  private async processSymbol(symbol: BotSymbol): Promise<void> {
    // Check for new candle
    const { allCandles, latestCandle, isNew } = await this.dataFeed.processNewCandle(symbol);

    if (!latestCandle || !isNew) return;

    // Skip if already processed
    const lastProcessed = this.tracker.getLastProcessedTimestamp(symbol);
    if (latestCandle.timestamp <= lastProcessed) return;

    if (this.config.verbose) {
      console.log(`[${new Date().toISOString()}] ${symbol}: new candle at ${new Date(latestCandle.timestamp).toISOString()}, close=$${latestCandle.close}`);
    }

    // Mark as processed
    this.tracker.setLastProcessedTimestamp(symbol, latestCandle.timestamp);

    // 1. Check existing open position for this symbol
    const openPos = this.tracker.getOpenPosition(symbol);
    if (openPos) {
      await this.manageOpenPosition(openPos, latestCandle, allCandles.length - 1);
      return; // Don't open new position while one is open for this symbol
    }

    // 2. Check if trading is allowed (circuit breakers)
    const blocker = this.riskEngine.canTrade(this.tracker);
    if (blocker) {
      if (this.config.verbose) {
        console.log(`  ${symbol}: trading blocked — ${blocker.reason}`);
      }
      return;
    }

    if (!this.riskEngine.canTradeSymbol(this.tracker, symbol)) return;

    // 3. Evaluate signal
    const result = this.signalEngine.evaluate(allCandles, symbol);

    if (!result.hasSignal || !result.signal) {
      if (this.config.verbose) {
        console.log(`  ${symbol}: no signal (${result.reasoning[result.reasoning.length - 1] ?? 'waiting'})`);
      }
      return;
    }

    // 4. Open position
    const position = this.orderManager.openPosition(
      result.signal,
      symbol,
      this.tracker.getEquity(),
      this.config.riskPerTrade,
      allCandles.length - 1,
    );

    if (!position) {
      console.log(`  ${symbol}: signal detected but position creation failed`);
      return;
    }

    // Set regime on position
    position.regime = result.regime;

    // Track and alert
    this.tracker.addPosition(position);
    await this.alerts.signalDetected(
      symbol,
      result.signal.totalScore,
      result.signal.signal.direction,
      result.signal.signal.strategy,
      result.regime,
    );
    await this.alerts.positionOpened(position);

    console.log(`  ${symbol}: OPENED ${position.direction.toUpperCase()} @ $${position.entryPrice.toFixed(2)} (score: ${position.confluenceScore.toFixed(2)}, regime: ${position.regime})`);
  }

  private async manageOpenPosition(
    position: BotPosition,
    candle: { timestamp: number; open: number; high: number; low: number; close: number; volume: number },
    barIndex: number,
  ): Promise<void> {
    const wasPT = position.partialTaken;

    const exitResult = this.orderManager.checkPositionExit(position, candle, barIndex);

    // Check if partial TP was taken (position still open but state changed)
    if (!wasPT && position.partialTaken) {
      this.tracker.updatePosition(position);
      await this.alerts.partialTPTaken(position, position.partialPnlPercent);
      console.log(`  ${position.symbol}: Partial TP taken, SL moved to $${position.currentSL.toFixed(2)}`);
    }

    if (!exitResult) return; // Still open

    // Position closed
    const closedPos = exitResult.position;
    this.tracker.closePosition(closedPos);
    await this.alerts.positionClosed(closedPos);

    const pnlStr = (closedPos.pnlUSDT ?? 0) >= 0 ? '+' : '';
    console.log(`  ${closedPos.symbol}: CLOSED ${closedPos.direction.toUpperCase()} — ${closedPos.exitReason} — PnL: ${pnlStr}$${(closedPos.pnlUSDT ?? 0).toFixed(2)} (${pnlStr}${((closedPos.pnlPercent ?? 0) * 100).toFixed(2)}%)`);

    // Evaluate circuit breakers after trade
    const triggered = this.riskEngine.evaluateAfterTrade(this.tracker);
    for (const cb of triggered) {
      await this.alerts.circuitBreakerTriggered(cb.type, cb.reason);
      console.log(`  CIRCUIT BREAKER: ${cb.type} — ${cb.reason}`);
    }

    // Save state after trade close
    this.tracker.saveState();
    this.tracker.recordSnapshot();
  }

  // ============================================
  // Scheduling
  // ============================================

  private scheduleDailyReset(): void {
    // Check every hour if we need to reset daily/weekly PnL
    this.dailyResetInterval = setInterval(() => {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcDay = now.getUTCDay();

      // Reset daily PnL at midnight UTC
      if (utcHour === 0) {
        this.tracker.resetDailyPnl();

        // Send daily summary
        this.alerts.dailySummary(this.tracker).catch(console.error);

        // Reset weekly PnL on Monday
        if (utcDay === 1) {
          this.tracker.resetWeeklyPnl();
        }
      }
    }, HOUR_MS);
  }
}

const HOUR_MS = 3_600_000;

// ============================================
// Entry Point
// ============================================

async function main(): Promise<void> {
  const { config, resume } = parseArgs();
  const bot = new TradingBot(config, resume);

  // Graceful shutdown handlers (PM2 compatible)
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    await bot.stop(signal);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await bot.start();

  // Keep process alive
  console.log('\nBot running. Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
