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
 * Crypto-only: BTC/ETH/SOL with order_block strategy (Run 18 CMA-ES config).
 *
 * Usage:
 *   npx tsx scripts/run-bot.ts                    # Default (BTC/ETH/SOL)
 *   npx tsx scripts/run-bot.ts --symbols BTCUSDT,ETHUSDT  # Custom symbols
 *   npx tsx scripts/run-bot.ts --ltf              # Enable LTF entry timing (5m confirmation)
 *   npx tsx scripts/run-bot.ts --funding-arb      # Enable funding rate arbitrage
 *   npx tsx scripts/run-bot.ts --arb-only         # Arb only (no directional)
 *   npx tsx scripts/run-bot.ts --capital 5000
 *   npx tsx scripts/run-bot.ts --risk 0.003
 *   npx tsx scripts/run-bot.ts --telegram-token BOT_TOKEN --telegram-chat CHAT_ID
 *   npx tsx scripts/run-bot.ts --verbose
 *   npx tsx scripts/run-bot.ts --resume           # Resume from saved state
 */

import {
  DataFeed,
  SignalEngine,
  OrderManager,
  PositionTracker,
  RiskEngine,
  AlertManager,
  FundingArbBot,
  DEFAULT_BOT_CONFIG,
  RUN18_STRATEGY_CONFIG,
  DEFAULT_CIRCUIT_BREAKERS,
  DEFAULT_LTF_CONFIG,
  DEFAULT_FUNDING_ARB_CONFIG,
} from '../src/lib/bot';
import { LTFConfirmation } from '../src/lib/bot/ltf-confirmation';
import type { BotConfig, BotSymbol, BotPosition, LTFConfig } from '../src/types/bot';

// ============================================
// Parse CLI arguments
// ============================================

function parseArgs(): {
  config: BotConfig;
  resume: boolean;
  ltfEnabled: boolean;
  fundingArbEnabled: boolean;
  arbOnly: boolean;
} {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_BOT_CONFIG };
  let resume = false;
  let ltfEnabled = false;
  let fundingArbEnabled = false;
  let arbOnly = false;

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
      case '--ltf':
        ltfEnabled = true;
        break;
      case '--funding-arb':
        fundingArbEnabled = true;
        break;
      case '--arb-only':
        arbOnly = true;
        fundingArbEnabled = true;
        break;
    }
  }

  return { config, resume, ltfEnabled, fundingArbEnabled, arbOnly };
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

  // LTF entry timing
  private ltfConfirmation: LTFConfirmation | null = null;
  private ltfConfig: LTFConfig;

  // Funding rate arbitrage
  private fundingArbBot: FundingArbBot | null = null;
  private arbOnly: boolean;

  constructor(
    config: BotConfig,
    resume: boolean,
    ltfEnabled: boolean,
    fundingArbEnabled: boolean,
    arbOnly: boolean,
  ) {
    this.config = config;
    this.arbOnly = arbOnly;

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

    // LTF entry timing (only for crypto, opt-in)
    this.ltfConfig = { ...DEFAULT_LTF_CONFIG, enabled: ltfEnabled };
    if (ltfEnabled) {
      this.ltfConfirmation = new LTFConfirmation(this.ltfConfig, this.dataFeed);
    }

    // Funding rate arbitrage
    if (fundingArbEnabled) {
      this.fundingArbBot = new FundingArbBot(
        DEFAULT_FUNDING_ARB_CONFIG,
        this.alerts,
        config.verbose,
      );
    }

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
    console.log(`Strategy: order_block (Run 18 CMA-ES)`);
    console.log(`Symbols: ${this.config.symbols.join(', ')}`);
    console.log(`Capital: $${this.config.initialCapital}`);
    console.log(`Risk/trade: ${(this.config.riskPerTrade * 100).toFixed(2)}%`);
    console.log(`Max positions: ${this.config.maxPositions}`);
    console.log(`Poll delay: ${this.config.pollDelaySeconds}s after hour close`);
    if (this.ltfConfirmation) {
      console.log(`LTF entry timing: ENABLED (5m confirmation)`);
    }
    if (this.fundingArbBot) {
      console.log(`Funding arb: ENABLED`);
    }
    if (this.arbOnly) {
      console.log(`Mode: ARB ONLY (no directional trading)`);
    }
    console.log('='.repeat(60));

    // Start funding arb bot (runs independently)
    if (this.fundingArbBot) {
      await this.fundingArbBot.start();
    }

    // If arb-only, skip directional setup
    if (this.arbOnly) {
      await this.alerts.botStarted();
      console.log('\nArb-only mode. Press Ctrl+C to stop.\n');
      return;
    }

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

    // Stop funding arb bot
    if (this.fundingArbBot) {
      await this.fundingArbBot.stop();
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
    // Process pending LTF setups first (polls 5m candles independently)
    if (this.ltfConfirmation && this.ltfConfirmation.hasPendingSetup(symbol)) {
      await this.processLTFSetup(symbol);
      return;
    }

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
      await this.manageOpenPosition(openPos, latestCandle);
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

    // 3. Evaluate signal (SignalEngine auto-routes to correct strategy per symbol)
    const result = this.signalEngine.evaluate(allCandles, symbol);

    if (!result.hasSignal || !result.signal) {
      if (this.config.verbose) {
        console.log(`  ${symbol}: no signal (${result.reasoning[result.reasoning.length - 1] ?? 'waiting'})`);
      }
      return;
    }

    // 4. LTF entry timing — if enabled, create LTF setup instead of immediate entry
    if (this.ltfConfirmation) {
      this.ltfConfirmation.createSetup(symbol, result.signal, allCandles);
      console.log(`  ${symbol}: LTF setup created — waiting for 5m confirmation`);

      await this.alerts.send({
        level: 'info',
        event: 'ltf_setup_created',
        message: [
          `LTF Setup: ${symbol} ${result.signal.signal.direction.toUpperCase()}`,
          `Score: ${result.signal.totalScore.toFixed(2)}`,
          `Waiting for 5m zone entry + MSS confirmation`,
        ].join('\n'),
        timestamp: Date.now(),
      });
      return;
    }

    // 5. Open position immediately
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

    console.log(`  ${symbol}: OPENED ${position.direction.toUpperCase()} @ $${position.entryPrice.toFixed(2)} (score: ${position.confluenceScore.toFixed(2)}, regime: ${position.regime}, strategy: ${position.strategy})`);
  }

  /**
   * Process a pending LTF setup — polls 5m candles and checks for confirmation.
   */
  private async processLTFSetup(symbol: BotSymbol): Promise<void> {
    if (!this.ltfConfirmation) return;

    const result = await this.ltfConfirmation.processSetup(symbol);
    if (!result) return;

    if (result.status === 'confirmed') {
      // Open position with LTF-tightened entry/SL
      const position = this.orderManager.openLTFPosition(
        result.signal,
        symbol,
        this.tracker.getEquity(),
        this.config.riskPerTrade,
        0, // barIndex not meaningful for LTF
        result.ltfEntry,
        result.ltfStopLoss,
      );

      if (position) {
        // Set LTF metadata
        position.ltfConfirmed = true;
        position.ltfEntryDelay = result.barsWaited;
        position.originalHTFEntry = result.signal.signal.entryPrice;
        position.originalHTFStopLoss = result.signal.signal.stopLoss;
        position.regime = '';

        this.tracker.addPosition(position);
        await this.alerts.positionOpened(position);
        await this.alerts.send({
          level: 'info',
          event: 'ltf_confirmed',
          message: [
            `LTF Confirmed: ${symbol} ${position.direction.toUpperCase()}`,
            `Entry: $${position.entryPrice.toFixed(2)} (1H was $${result.signal.signal.entryPrice.toFixed(2)})`,
            `SL: $${position.stopLoss.toFixed(2)} (1H was $${result.signal.signal.stopLoss.toFixed(2)})`,
            `Waited: ${result.barsWaited} bars (5m)`,
          ].join('\n'),
          timestamp: Date.now(),
        });

        console.log(`  ${symbol}: LTF CONFIRMED — OPENED ${position.direction.toUpperCase()} @ $${position.entryPrice.toFixed(2)} (5m SL: $${position.stopLoss.toFixed(2)})`);
      }
    } else if (result.status === 'expired') {
      if (this.ltfConfig.onTimeout === 'fallback') {
        // Fall back to 1H entry
        const position = this.orderManager.openPosition(
          result.signal,
          symbol,
          this.tracker.getEquity(),
          this.config.riskPerTrade,
          0,
        );
        if (position) {
          this.tracker.addPosition(position);
          await this.alerts.positionOpened(position);
          console.log(`  ${symbol}: LTF expired — FALLBACK to 1H entry @ $${position.entryPrice.toFixed(2)}`);
        }
      } else {
        console.log(`  ${symbol}: LTF expired — skipped`);
      }

      await this.alerts.send({
        level: 'info',
        event: 'ltf_expired',
        message: `LTF Expired: ${symbol} — ${this.ltfConfig.onTimeout === 'fallback' ? 'fell back to 1H entry' : 'skipped'}`,
        timestamp: Date.now(),
      });
    }
  }

  private async manageOpenPosition(
    position: BotPosition,
    candle: { timestamp: number; open: number; high: number; low: number; close: number; volume: number },
  ): Promise<void> {
    const wasPT = position.partialTaken;

    const exitResult = this.orderManager.checkPositionExit(position, candle);

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
  const { config, resume, ltfEnabled, fundingArbEnabled, arbOnly } = parseArgs();
  const bot = new TradingBot(config, resume, ltfEnabled, fundingArbEnabled, arbOnly);

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
