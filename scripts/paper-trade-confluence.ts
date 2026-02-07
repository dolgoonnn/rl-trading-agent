#!/usr/bin/env npx tsx
/**
 * Paper Trade — Confluence Scorer
 *
 * Connects the rule-based confluence scorer (OB-only, t=3.5, reaction confirmation)
 * to Binance live data via WebSocket for paper trading.
 *
 * Modes:
 *   Live:     npx tsx scripts/paper-trade-confluence.ts --symbol BTCUSDT
 *   Backtest: npx tsx scripts/paper-trade-confluence.ts --symbol BTCUSDT --backtest 500
 *
 * Options:
 *   --symbol BTCUSDT|ETHUSDT|SOLUSDT  (default: BTCUSDT)
 *   --threshold 3.5                    (default: 3.5)
 *   --capital 10000                    (default: 10000)
 *   --backtest <bars>                  (run on last N bars of saved data)
 *   --verbose                          (debug logging)
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  PRODUCTION_STRATEGY_CONFIG,
} from '../src/lib/rl/strategies/confluence-scorer';
import { BinanceWebSocket } from '../src/lib/paper-trading/binance-ws';
import { CandleManager } from '../src/lib/paper-trading/candle-manager';
import { RiskManager, DEFAULT_RISK_LIMITS } from '../src/lib/paper-trading/risk-manager';
import { PositionSizer, DEFAULT_POSITION_SIZING_CONFIG } from '../src/lib/paper-trading/position-sizer';
import { PerformanceMonitor } from '../src/lib/paper-trading/performance-monitor';
import { TradeLogger } from '../src/lib/paper-trading/trade-logger';
import type { PaperTrade, PaperTraderConfig } from '../src/lib/paper-trading/types';
import type { LiveCandle } from '../src/lib/paper-trading/types';

// ============================================
// Constants
// ============================================

/** Commission per side (0.1% = 0.001) */
const COMMISSION_RATE = 0.001;

/** Slippage per side (0.05% = 0.0005) */
const SLIPPAGE_RATE = 0.0005;

/** Combined friction per side */
const FRICTION_PER_SIDE = COMMISSION_RATE + SLIPPAGE_RATE;

/** Max bars to hold a position */
const MAX_HOLD_BARS = 72;

/** Metrics log interval (every N candles) */
const METRICS_LOG_INTERVAL = 10;

// ============================================
// Types
// ============================================

interface LivePosition {
  side: 'long' | 'short';
  entryPrice: number;       // After slippage
  rawEntryPrice: number;    // Before slippage
  stopLoss: number;
  takeProfit: number;
  size: number;             // Position value in USD
  units: number;            // Units of the asset
  entryIndex: number;       // Global candle index
  entryTimestamp: number;
  barsHeld: number;
  confluenceScore: number;
  reasoning: string[];
  tradeId: string;
}

interface CLIArgs {
  symbol: string;
  threshold: number;
  capital: number;
  backtest: number | null;
  verbose: boolean;
}

// ============================================
// CLI Parsing
// ============================================

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {
    symbol: 'BTCUSDT',
    threshold: 3.5,
    capital: 10000,
    backtest: null,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--symbol':
        result.symbol = args[++i] ?? 'BTCUSDT';
        break;
      case '--threshold':
        result.threshold = parseFloat(args[++i] ?? '3.5');
        break;
      case '--capital':
        result.capital = parseFloat(args[++i] ?? '10000');
        break;
      case '--backtest':
        result.backtest = parseInt(args[++i] ?? '500', 10);
        break;
      case '--verbose':
        result.verbose = true;
        break;
    }
  }

  return result;
}

// ============================================
// Friction Helpers (mirrors backtest-confluence.ts)
// ============================================

function applyEntryFriction(price: number, direction: 'long' | 'short'): number {
  return direction === 'long'
    ? price * (1 + FRICTION_PER_SIDE)
    : price * (1 - FRICTION_PER_SIDE);
}

function applyExitFriction(price: number, direction: 'long' | 'short'): number {
  return direction === 'long'
    ? price * (1 - FRICTION_PER_SIDE)
    : price * (1 + FRICTION_PER_SIDE);
}

// ============================================
// Core Paper Trader
// ============================================

class ConfluencePaperTrader {
  private scorer: ConfluenceScorer;
  private riskManager: RiskManager;
  private positionSizer: PositionSizer;
  private perfMonitor: PerformanceMonitor;
  private tradeLogger: TradeLogger;

  private position: LivePosition | null = null;
  private candleCount = 0;
  private totalSignals = 0;
  private sessionId: string;
  private verbose: boolean;
  private capital: number;
  private symbol: string;
  private shuttingDown = false;

  constructor(
    private readonly args: CLIArgs,
  ) {
    this.symbol = args.symbol;
    this.capital = args.capital;
    this.verbose = args.verbose;
    this.sessionId = `confluence-${args.symbol}-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    // Initialize scorer with production config
    this.scorer = new ConfluenceScorer({
      activeStrategies: ['order_block'],
      minThreshold: args.threshold,
      strategyConfig: { ...PRODUCTION_STRATEGY_CONFIG },
    });

    // Risk manager with default circuit breakers
    this.riskManager = new RiskManager(args.capital, DEFAULT_RISK_LIMITS);

    // Position sizer with production config
    this.positionSizer = new PositionSizer({
      ...DEFAULT_POSITION_SIZING_CONFIG,
      baseSize: 0.10,
      maxSize: 0.15,
    });

    // Performance monitor
    this.perfMonitor = new PerformanceMonitor(args.capital);

    // Trade logger for SQLite persistence
    const paperConfig: PaperTraderConfig = {
      symbol: args.symbol,
      timeframe: '1h',
      modelPath: 'confluence-scorer',
      initialCapital: args.capital,
      positionSize: 0.1,
      maxHoldBars: MAX_HOLD_BARS,
      slPercent: 0.02,
      tpPercent: 0.04,
      spread: 0.0001,
      slippage: SLIPPAGE_RATE,
      commission: COMMISSION_RATE,
      kbEnabled: false,
      kbFeatures: false,
      kbRewards: false,
      persistTrades: true,
      logLevel: args.verbose ? 'debug' : 'info',
      consoleOutput: true,
    };

    this.tradeLogger = new TradeLogger(
      this.sessionId,
      args.symbol,
      '1h',
      'confluence-scorer',
      paperConfig,
    );
  }

  // ------------------------------------------
  // Live Mode
  // ------------------------------------------

  async runLive(): Promise<void> {
    console.log('='.repeat(72));
    console.log('CONFLUENCE PAPER TRADER — LIVE MODE');
    console.log('='.repeat(72));
    console.log(`  Symbol:    ${this.symbol}`);
    console.log(`  Threshold: ${this.args.threshold}`);
    console.log(`  Capital:   $${this.capital.toLocaleString()}`);
    console.log(`  Strategy:  OB-only + reaction confirmation`);
    console.log(`  Exits:     Simple SL/TP + ${MAX_HOLD_BARS}-bar max hold`);
    console.log(`  Session:   ${this.sessionId}`);
    console.log('='.repeat(72));

    // Initialize trade logger session
    await this.tradeLogger.initSession();

    // Initialize candle manager with 30 days history
    const candleManager = new CandleManager({
      symbol: this.symbol,
      timeframe: '1h',
      maxCandles: 2000,
      historyDays: 30,
    });
    await candleManager.initialize();

    console.log(`[Init] Candle buffer: ${candleManager.size()} candles loaded`);

    // Connect to Binance WebSocket
    const ws = new BinanceWebSocket({ symbol: this.symbol, timeframe: '1h' });

    // Setup shutdown handlers
    const shutdown = async () => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;

      console.log('\n[Shutdown] Graceful shutdown initiated...');

      // Close open position at current market price
      if (this.position) {
        const lastCandle = candleManager.getLatestCandle();
        if (lastCandle) {
          this.closePosition(lastCandle.close, lastCandle.timestamp, candleManager.getCurrentIndex(), 'shutdown');
        }
      }

      // Print final summary
      this.printSessionSummary();

      // End logger session
      const metrics = this.perfMonitor.getMetrics();
      await this.tradeLogger.endSession({
        totalPnl: metrics.totalPnl,
        maxDrawdown: metrics.maxDrawdownPercent,
        sharpe: metrics.sharpe,
      });

      ws.disconnect();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Handle closed candles
    ws.on('candleClosed', (liveCandle: LiveCandle) => {
      const { isNew } = candleManager.handleLiveCandle(liveCandle);

      if (isNew) {
        const candles = candleManager.getCandles();
        const currentIndex = candleManager.getCurrentIndex();

        this.onCandleClosed(candles, currentIndex);
      }
    });

    // Handle WS errors
    ws.on('error', (error: Error) => {
      console.error(`[WS] Error: ${error.message}`);
    });

    ws.on('reconnecting', (attempt: number) => {
      console.log(`[WS] Reconnecting... attempt ${attempt}`);
    });

    // Connect
    await ws.connect();
    console.log('[Live] Connected to Binance WebSocket. Waiting for candles...\n');
  }

  // ------------------------------------------
  // Backtest Mode
  // ------------------------------------------

  async runBacktest(numBars: number): Promise<void> {
    console.log('='.repeat(72));
    console.log('CONFLUENCE PAPER TRADER — BACKTEST MODE');
    console.log('='.repeat(72));
    console.log(`  Symbol:    ${this.symbol}`);
    console.log(`  Threshold: ${this.args.threshold}`);
    console.log(`  Capital:   $${this.capital.toLocaleString()}`);
    console.log(`  Bars:      ${numBars}`);
    console.log(`  Strategy:  OB-only + reaction confirmation`);
    console.log(`  Exits:     Simple SL/TP + ${MAX_HOLD_BARS}-bar max hold`);
    console.log('='.repeat(72));

    // Load historical data
    const dataPath = path.join(process.cwd(), `data/${this.symbol}_1h.json`);
    if (!fs.existsSync(dataPath)) {
      console.error(`[Error] Data file not found: ${dataPath}`);
      console.error('  Run: npx tsx scripts/fetch-historical-data.ts first');
      process.exit(1);
    }

    const allCandles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    console.log(`[Data] Loaded ${allCandles.length} candles from ${dataPath}`);

    // Use last N bars with lookback prefix (need ~200 bars for ICT detection warmup)
    const warmup = 200;
    const startIndex = Math.max(0, allCandles.length - numBars - warmup);
    const candles = allCandles.slice(startIndex);
    const evalStart = candles.length - numBars;

    console.log(`[Data] Evaluating bars ${evalStart} to ${candles.length - 1} (${numBars} bars)`);
    console.log(`[Data] Warmup: ${evalStart} bars\n`);

    // Initialize trade logger session (no persistence in backtest mode)
    await this.tradeLogger.initSession();

    // Run through candles
    for (let i = evalStart; i < candles.length; i++) {
      this.onCandleClosed(candles, i);
    }

    // Close any open position at the end
    if (this.position) {
      const lastCandle = candles[candles.length - 1]!;
      this.closePosition(lastCandle.close, lastCandle.timestamp, candles.length - 1, 'shutdown');
    }

    // Print final summary
    this.printSessionSummary();

    // End logger session
    const metrics = this.perfMonitor.getMetrics();
    await this.tradeLogger.endSession({
      totalPnl: metrics.totalPnl,
      maxDrawdown: metrics.maxDrawdownPercent,
      sharpe: metrics.sharpe,
    });
  }

  // ------------------------------------------
  // Per-Bar Logic
  // ------------------------------------------

  private onCandleClosed(candles: Candle[], currentIndex: number): void {
    this.candleCount++;
    this.riskManager.onBar();

    const currentCandle = candles[currentIndex];
    if (!currentCandle) return;

    // If we have an open position, check for SL/TP/maxBars exit
    if (this.position) {
      const exited = this.checkPositionExit(currentCandle, currentIndex);
      if (exited) return; // Position closed, don't enter same bar
    }

    // No position — evaluate for new entry
    if (!this.position) {
      this.evaluateEntry(candles, currentIndex);
    }

    // Periodic metrics log
    if (this.candleCount % METRICS_LOG_INTERVAL === 0) {
      this.printRollingMetrics();
    }
  }

  // ------------------------------------------
  // Entry Logic
  // ------------------------------------------

  private evaluateEntry(candles: Candle[], currentIndex: number): void {
    // Risk manager gate
    const riskCheck = this.riskManager.checkRisk();
    if (!riskCheck.allowed) {
      if (this.verbose) {
        console.log(`  [Risk] Blocked: ${riskCheck.reason}`);
      }
      return;
    }

    // Evaluate confluence
    const result = this.scorer.evaluate(candles, currentIndex);
    this.totalSignals += result.allScored.length;

    if (result.action === 'wait') {
      if (this.verbose && result.allScored.length > 0) {
        console.log(`  [Scorer] Wait — ${result.reasoning[result.reasoning.length - 1]}`);
      }
      return;
    }

    // We have a signal
    const scored = result.selectedSignal!;
    const signal = scored.signal;
    const candle = candles[currentIndex]!;

    // Position sizing
    const equity = this.perfMonitor.getCurrentEquity();
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const sizerStats = this.positionSizer.getTrackedStats();

    const sizeResult = this.positionSizer.calculate({
      equity,
      atr: stopDistance, // Approximate ATR from SL distance
      price: signal.entryPrice,
      winRate: sizerStats.winRate,
      avgRiskReward: sizerStats.avgRiskReward,
      currentDrawdown: this.riskManager.getState().currentDrawdown,
      confidence: signal.confidence,
      stopLossDistance: stopDistance,
    });

    // Apply entry friction
    const adjustedEntry = applyEntryFriction(signal.entryPrice, signal.direction);

    // Open position
    const tradeId = `${this.sessionId}-${Date.now()}`;
    this.position = {
      side: signal.direction,
      entryPrice: adjustedEntry,
      rawEntryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      size: sizeResult.positionValue,
      units: sizeResult.units,
      entryIndex: currentIndex,
      entryTimestamp: candle.timestamp,
      barsHeld: 0,
      confluenceScore: scored.totalScore,
      reasoning: signal.reasoning,
      tradeId,
    };

    // Record with risk manager
    this.riskManager.onTradeOpened();

    // Log entry
    const factorStr = Object.entries(scored.factorBreakdown)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v.toFixed(1)}`)
      .join(', ');

    console.log(`\n  >>> ENTRY: ${signal.direction.toUpperCase()} ${this.symbol}`);
    console.log(`      Price: ${signal.entryPrice.toFixed(2)} (adj: ${adjustedEntry.toFixed(2)})`);
    console.log(`      SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)} | R:R: ${signal.riskReward.toFixed(2)}`);
    console.log(`      Score: ${scored.totalScore.toFixed(2)} | Factors: ${factorStr}`);
    console.log(`      Size: $${sizeResult.positionValue.toFixed(0)} (${(sizeResult.sizeFraction * 100).toFixed(1)}%) | Risk: $${sizeResult.dollarRisk.toFixed(0)}`);

    // Persist entry
    const paperTrade: PaperTrade = {
      id: tradeId,
      sessionId: this.sessionId,
      symbol: this.symbol,
      timeframe: '1h',
      side: signal.direction,
      status: 'open',
      entryPrice: adjustedEntry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      entryIndex: currentIndex,
      exitIndex: 0,
      entryTime: new Date(candle.timestamp),
      barsHeld: 0,
      holdingPeriod: 0,
      pnl: 0,
      pnlPercent: 0,
      entryConfluence: scored.totalScore,
      createdAt: new Date(),
    };

    this.tradeLogger.logEntry(paperTrade, {
      confluence: scored.totalScore,
      factors: Object.entries(scored.factorBreakdown)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}:${v.toFixed(2)}`),
    });
  }

  // ------------------------------------------
  // Exit Logic (Simple SL/TP)
  // ------------------------------------------

  private checkPositionExit(candle: Candle, currentIndex: number): boolean {
    if (!this.position) return false;

    this.position.barsHeld = currentIndex - this.position.entryIndex;

    // Check SL hit
    if (this.position.side === 'long') {
      if (candle.low <= this.position.stopLoss) {
        this.closePosition(this.position.stopLoss, candle.timestamp, currentIndex, 'stop_loss');
        return true;
      }
      if (candle.high >= this.position.takeProfit) {
        this.closePosition(this.position.takeProfit, candle.timestamp, currentIndex, 'take_profit');
        return true;
      }
    } else {
      if (candle.high >= this.position.stopLoss) {
        this.closePosition(this.position.stopLoss, candle.timestamp, currentIndex, 'stop_loss');
        return true;
      }
      if (candle.low <= this.position.takeProfit) {
        this.closePosition(this.position.takeProfit, candle.timestamp, currentIndex, 'take_profit');
        return true;
      }
    }

    // Max bars
    if (this.position.barsHeld >= MAX_HOLD_BARS) {
      this.closePosition(candle.close, candle.timestamp, currentIndex, 'max_bars');
      return true;
    }

    return false;
  }

  private closePosition(
    rawExitPrice: number,
    exitTimestamp: number,
    exitIndex: number,
    reason: 'stop_loss' | 'take_profit' | 'max_bars' | 'shutdown',
  ): void {
    if (!this.position) return;

    const pos = this.position;
    const adjustedExit = applyExitFriction(rawExitPrice, pos.side);

    // Calculate PnL
    let pnl: number;
    if (pos.side === 'long') {
      pnl = (adjustedExit - pos.entryPrice) / pos.entryPrice;
    } else {
      pnl = (pos.entryPrice - adjustedExit) / pos.entryPrice;
    }

    const pnlDollar = pnl * pos.size;
    const barsHeld = exitIndex - pos.entryIndex;

    // Log exit
    const pnlSign = pnlDollar >= 0 ? '+' : '';
    const emoji = pnlDollar >= 0 ? 'WIN' : 'LOSS';
    console.log(`\n  <<< EXIT: ${reason.toUpperCase()} — ${emoji}`);
    console.log(`      Price: ${rawExitPrice.toFixed(2)} (adj: ${adjustedExit.toFixed(2)})`);
    console.log(`      PnL: ${pnlSign}$${pnlDollar.toFixed(2)} (${pnlSign}${(pnl * 100).toFixed(2)}%) | Bars: ${barsHeld}`);

    // Create closed trade record
    const paperTrade: PaperTrade = {
      id: pos.tradeId,
      sessionId: this.sessionId,
      symbol: this.symbol,
      timeframe: '1h',
      side: pos.side,
      status: 'closed',
      entryPrice: pos.entryPrice,
      exitPrice: adjustedExit,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      entryIndex: pos.entryIndex,
      exitIndex,
      entryTime: new Date(pos.entryTimestamp),
      exitTime: new Date(exitTimestamp),
      barsHeld,
      holdingPeriod: barsHeld,
      pnl: pnlDollar,
      pnlPercent: pnl * 100,
      entryConfluence: pos.confluenceScore,
      exitReason: reason,
      createdAt: new Date(pos.entryTimestamp),
    };

    // Record with all subsystems
    this.perfMonitor.recordTrade(paperTrade);
    this.riskManager.onTradeClosed(pnlDollar);
    this.positionSizer.recordTrade(pnlDollar > 0, pnl * 100);
    this.tradeLogger.logExit(paperTrade);

    // Update session metrics periodically
    const metrics = this.perfMonitor.getMetrics();
    this.tradeLogger.updateSessionMetrics(metrics.maxDrawdownPercent, metrics.sharpe);

    // Clear position
    this.position = null;
  }

  // ------------------------------------------
  // Display
  // ------------------------------------------

  private printRollingMetrics(): void {
    const metrics = this.perfMonitor.getMetrics();

    if (metrics.closedTrades === 0) {
      console.log(`  [Bar ${this.candleCount}] No trades yet | Signals evaluated: ${this.totalSignals}`);
      return;
    }

    const pnlSign = metrics.totalPnl >= 0 ? '+' : '';
    const risk = this.riskManager.getRiskSummary();

    console.log(
      `  [Bar ${this.candleCount}] ` +
      `Trades: ${metrics.closedTrades} | ` +
      `WR: ${metrics.winRate.toFixed(1)}% | ` +
      `PnL: ${pnlSign}$${metrics.totalPnl.toFixed(2)} | ` +
      `DD: ${metrics.maxDrawdownPercent.toFixed(1)}% | ` +
      `Sharpe: ${metrics.sharpe.toFixed(2)} | ` +
      `Risk: ${risk.riskLevel}`,
    );
  }

  private printSessionSummary(): void {
    const metrics = this.perfMonitor.getMetrics();

    console.log('\n' + '='.repeat(72));
    console.log('SESSION SUMMARY');
    console.log('='.repeat(72));
    console.log(`  Session:        ${this.sessionId}`);
    console.log(`  Symbol:         ${this.symbol}`);
    console.log(`  Candles:        ${this.candleCount}`);
    console.log(`  Signals:        ${this.totalSignals}`);
    console.log('');

    console.log(this.perfMonitor.formatMetrics(metrics));

    const risk = this.riskManager.getRiskSummary();
    console.log(`  Daily PnL:     $${risk.dailyPnL} (${risk.dailyLossPercent})`);
    console.log(`  Consec Losses: ${risk.consecutiveLosses}`);
    console.log(`  Risk Level:    ${risk.riskLevel}`);

    if (risk.warnings.length > 0) {
      console.log(`  Warnings:      ${risk.warnings.join('; ')}`);
    }

    console.log('='.repeat(72));
  }
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const args = parseArgs();

  const trader = new ConfluencePaperTrader(args);

  if (args.backtest !== null) {
    await trader.runBacktest(args.backtest);
  } else {
    await trader.runLive();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
