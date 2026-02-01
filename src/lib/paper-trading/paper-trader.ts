/**
 * Paper Trader
 * Core paper trading loop connecting trained agent to live data
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import type { Candle } from '@/types';
import {
  DQNAgent,
  ReplayBuffer,
  type SerializedWeights,
  type ExitAction,
  type HybridPosition,
  KBHybridTradingEnvironment,
  type KBHybridEnvConfig,
  type EntryFilterConfig,
  type KBIntegrationConfig,
  ExitActions,
  EntryFilter,
} from '../rl';

import type {
  PaperTrade,
  PaperSession,
  PaperTraderConfig,
  PaperTraderEvents,
  LiveCandle,
  PerformanceMetrics,
} from './types';
import { DEFAULT_PAPER_TRADER_CONFIG } from './types';
import { BinanceWebSocket } from './binance-ws';
import { CandleManager } from './candle-manager';
import { TradeLogger } from './trade-logger';
import { PerformanceMonitor } from './performance-monitor';

export class PaperTrader extends EventEmitter {
  private config: PaperTraderConfig;
  private sessionId: string;
  private session: PaperSession | null = null;

  // Components
  private ws: BinanceWebSocket | null = null;
  private candleManager: CandleManager | null = null;
  private agent: DQNAgent | null = null;
  private logger: TradeLogger | null = null;
  private monitor: PerformanceMonitor | null = null;

  // State
  private isRunning: boolean = false;
  private currentPosition: HybridPosition | null = null;
  private currentTrade: PaperTrade | null = null;
  private lastCandle: Candle | null = null;

  // Entry filter for signal detection
  private entryFilter: EntryFilter | null = null;

  // KB environment wrapper for state building
  private env: KBHybridTradingEnvironment | null = null;
  private stateSize: number = 22; // 18 base + 4 KB features

  constructor(config: Partial<PaperTraderConfig> = {}) {
    super();
    this.config = { ...DEFAULT_PAPER_TRADER_CONFIG, ...config };
    this.sessionId = `pt_${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}`;
  }

  /**
   * Start paper trading
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Paper trader is already running');
    }

    this.log('info', 'Starting paper trader...');

    try {
      // 1. Load trained model
      await this.loadModel();

      // 2. Initialize candle manager with historical data
      this.candleManager = new CandleManager({
        symbol: this.config.symbol,
        timeframe: this.config.timeframe,
        maxCandles: 2000,
        historyDays: 30,
      });
      await this.candleManager.initialize();

      // 3. Initialize KB environment for state building
      await this.initializeEnvironment();

      // 4. Initialize logger and monitor
      this.logger = new TradeLogger(
        this.sessionId,
        this.config.symbol,
        this.config.timeframe,
        this.config.modelPath,
        this.config
      );
      this.session = await this.logger.initSession();

      this.monitor = new PerformanceMonitor(this.config.initialCapital);

      // 5. Connect to WebSocket
      this.ws = new BinanceWebSocket({
        symbol: this.config.symbol,
        timeframe: this.config.timeframe,
      });

      this.setupWebSocketHandlers();
      await this.ws.connect();

      this.isRunning = true;
      this.emit('started', this.session);

      this.printHeader();
    } catch (error) {
      this.log('error', `Failed to start: ${error}`);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Stop paper trading
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.log('info', 'Stopping paper trader...');
    this.isRunning = false;

    // Close any open position
    if (this.currentPosition && this.currentTrade && this.lastCandle) {
      await this.closePosition(this.lastCandle.close, 'shutdown');
    }

    // End session
    if (this.logger && this.monitor) {
      const metrics = this.monitor.getMetrics();
      await this.logger.endSession({
        totalPnl: metrics.totalPnl,
        maxDrawdown: metrics.maxDrawdown,
        sharpe: metrics.sharpe,
      });
    }

    // Cleanup
    await this.cleanup();

    if (this.session) {
      this.emit('stopped', this.session);
    }

    this.printSummary();
  }

  /**
   * Load trained model
   */
  private async loadModel(): Promise<void> {
    const modelPath = path.resolve(this.config.modelPath);

    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model not found: ${modelPath}`);
    }

    this.log('info', `Loading model from ${modelPath}...`);

    const content = fs.readFileSync(modelPath, 'utf-8');
    const weights = JSON.parse(content) as SerializedWeights;

    // Determine input size from model config
    this.stateSize = weights.config.inputSize;

    // Create agent with model config
    const buffer = new ReplayBuffer({
      capacity: 1000, // Small buffer, we're not training
      batchSize: 32,
      minExperience: 100,
    });

    this.agent = new DQNAgent(weights.config, buffer);
    await this.agent.loadWeights(weights);

    this.log('info', `Model loaded: ${this.stateSize} features, epsilon=${weights.state.epsilon.toFixed(3)}`);
  }

  /**
   * Initialize KB environment for state building
   */
  private async initializeEnvironment(): Promise<void> {
    if (!this.candleManager) {
      throw new Error('Candle manager not initialized');
    }

    const candles = this.candleManager.getCandles();

    const entryConfig: Partial<EntryFilterConfig> = {
      minConfluence: 3,
      requireOBTouch: true,
      requireTrendAlignment: true,
    };

    // Create entry filter for live signal detection
    this.entryFilter = new EntryFilter(entryConfig);

    const kbConfig: Partial<KBIntegrationConfig> = {
      enabled: this.config.kbEnabled,
      addKBFeatures: this.config.kbFeatures,
      useKBRewardShaping: false, // Don't use reward shaping in live
    };

    const envConfig: Partial<KBHybridEnvConfig> = {
      initialCapital: this.config.initialCapital,
      positionSize: this.config.positionSize,
      maxHoldBars: this.config.maxHoldBars,
      defaultSLPercent: this.config.slPercent,
      defaultTPPercent: this.config.tpPercent,
      spread: this.config.spread,
      commission: this.config.commission,
      slippage: this.config.slippage,
      kbConfig,
    };

    this.env = new KBHybridTradingEnvironment(
      candles,
      envConfig,
      entryConfig,
      {},
      false // Not training
    );

    if (kbConfig.enabled) {
      await this.env.initializeKB();
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.on('connected', () => {
      this.log('info', 'WebSocket connected');
    });

    this.ws.on('disconnected', (reason) => {
      this.log('warn', `WebSocket disconnected: ${reason}`);
    });

    this.ws.on('reconnecting', (attempt) => {
      this.log('info', `Reconnecting (attempt ${attempt})...`);
    });

    this.ws.on('error', (error) => {
      this.log('error', `WebSocket error: ${error.message}`);
      this.emit('error', error);
    });

    this.ws.on('candle', (candle) => {
      this.handleCandleUpdate(candle);
    });

    this.ws.on('candleClosed', (candle) => {
      this.handleCandleClosed(candle);
    });
  }

  /**
   * Handle live candle update (not yet closed)
   */
  private handleCandleUpdate(liveCandle: LiveCandle): void {
    this.emit('candleReceived', liveCandle);

    // Update unrealized PnL display if in position
    if (this.currentPosition && this.monitor) {
      const currentPrice = liveCandle.close;
      const unrealizedPnl = this.calculateUnrealizedPnl(currentPrice);
      this.monitor.updateUnrealizedPnl(unrealizedPnl);
    }
  }

  /**
   * Handle closed candle - main trading logic
   */
  private async handleCandleClosed(liveCandle: LiveCandle): Promise<void> {
    if (!this.candleManager || !this.agent || !this.env) {
      return;
    }

    // Update candle buffer
    const { isNew, candle } = this.candleManager.handleLiveCandle(liveCandle);

    if (!isNew) {
      return; // Duplicate candle
    }

    this.lastCandle = candle;
    const currentPrice = candle.close;
    const currentIndex = this.candleManager.getCurrentIndex();

    // Debug: Log candle close
    this.log('debug', `Candle closed: ${new Date(candle.timestamp).toISOString()} | Price: ${currentPrice.toFixed(2)} | Index: ${currentIndex}`);

    // Update environment with new candles
    this.updateEnvironmentCandles();

    // ============================================
    // Not in position: Check for entry signal
    // ============================================
    if (!this.currentPosition) {
      const signal = this.checkEntrySignal(currentIndex);

      if (signal) {
        await this.openPosition(signal, candle);
      } else {
        this.log('debug', `No entry signal at index ${currentIndex}`);
      }
    }
    // ============================================
    // In position: Agent decides exit action
    // ============================================
    else {
      // First check SL/TP
      const slTpHit = this.checkStopLossTakeProfit(candle);
      if (slTpHit) {
        await this.closePosition(slTpHit.price, slTpHit.reason);
        return;
      }

      // Check max hold bars
      if (this.currentPosition.barsHeld >= this.config.maxHoldBars) {
        await this.closePosition(currentPrice, 'max_bars');
        return;
      }

      // Build state and get agent action
      const state = this.buildState(currentIndex);
      const action = this.agent.selectAction(state, false) as ExitAction;

      // Execute action
      await this.executeAction(action, currentPrice);

      // Update position state
      this.currentPosition.barsHeld++;
      this.updatePositionPnL(currentPrice);
    }

    // Print status periodically
    if (currentIndex % 10 === 0) {
      this.printStatus();
    }
  }

  /**
   * Check for entry signal using environment's entry filter
   */
  private checkEntrySignal(currentIndex: number): {
    direction: 'long' | 'short';
    confluence: number;
    factors: string[];
    price: number;
    stopLoss: number;
    takeProfit: number;
  } | null {
    if (!this.entryFilter || !this.candleManager) return null;

    // Get live candle data
    const candles = this.candleManager.getCandles();
    const currentCandle = candles[currentIndex];
    if (!currentCandle) return null;

    // Use EntryFilter directly on live candle data
    const signal = this.entryFilter.checkEntry(candles, currentIndex);

    // Debug: Get entry filter diagnostics
    if (this.config.logLevel === 'debug') {
      const diagnostics = this.entryFilter.getDiagnostics();
      this.log('debug', `Entry check: OBs=${diagnostics.orderBlocks} (${diagnostics.unmitigated} unmitigated), FVGs=${diagnostics.fvgs}, bias=${diagnostics.bias}, trend=${diagnostics.trendStrength.toFixed(2)}`);
    }

    if (signal) {
      const price = signal.triggerPrice;
      return {
        direction: signal.direction,
        confluence: signal.confluenceCount,
        factors: signal.additionalFactors,
        price,
        stopLoss: signal.direction === 'long'
          ? price * (1 - this.config.slPercent)
          : price * (1 + this.config.slPercent),
        takeProfit: signal.direction === 'long'
          ? price * (1 + this.config.tpPercent)
          : price * (1 - this.config.tpPercent),
      };
    }

    return null;
  }

  /**
   * Open a new position
   */
  private async openPosition(
    signal: {
      direction: 'long' | 'short';
      confluence: number;
      factors: string[];
      price: number;
      stopLoss: number;
      takeProfit: number;
    },
    _candle: Candle
  ): Promise<void> {
    const now = new Date();
    const tradeId = uuidv4();

    // Apply slippage to entry
    const slippage = this.config.slippage;
    const entryPrice = signal.direction === 'long'
      ? signal.price * (1 + slippage)
      : signal.price * (1 - slippage);

    // Create position
    const entryIndex = this.candleManager?.getCurrentIndex() ?? 0;
    this.currentPosition = {
      side: signal.direction,
      entryPrice,
      entryIndex,
      size: (this.config.initialCapital * this.config.positionSize) / entryPrice,
      unrealizedPnL: 0,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      confluenceLevel: signal.confluence >= 5 ? 'A+' : signal.confluence >= 4 ? 'A' : signal.confluence >= 3 ? 'B' : 'C',
      entryATR: this.calculateATR(),
      peakPnL: 0,
      barsHeld: 0,
      partialExitTaken: false,
      stopTightened: false,
      trailingLevel: 0,
    };

    // Create trade record
    this.currentTrade = {
      id: tradeId,
      sessionId: this.sessionId,
      symbol: this.config.symbol,
      timeframe: this.config.timeframe,
      side: signal.direction,
      status: 'open',
      entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      entryTime: now,
      entryIndex,
      exitIndex: 0,
      barsHeld: 0,
      holdingPeriod: 0,
      entryConfluence: signal.confluence,
      pnl: 0,
      pnlPercent: 0,
      createdAt: now,
    };

    // Get KB context if available
    if (this.env?.isKBEnabled() && this.currentTrade) {
      const kbContext = this.env.getKBContext();
      if (kbContext) {
        this.currentTrade.kbPrimaryConcept = kbContext.primaryConcept;
        this.currentTrade.kbAlignmentScore = kbContext.matches[0]?.similarity ?? 0;
      }
    }

    // Log entry
    if (this.logger && this.currentTrade) {
      await this.logger.logEntry(this.currentTrade, {
        confluence: signal.confluence,
        factors: signal.factors,
      });
    }

    // Print entry
    this.printEntry(signal);

    if (this.currentTrade) {
      this.emit('entry', this.currentTrade, { confluence: signal.confluence, factors: signal.factors });
    }
  }

  /**
   * Close current position
   */
  private async closePosition(
    exitPrice: number,
    reason: 'agent' | 'stop_loss' | 'take_profit' | 'max_bars' | 'shutdown'
  ): Promise<void> {
    if (!this.currentPosition || !this.currentTrade) {
      return;
    }

    const now = new Date();

    // Apply slippage to exit
    const slippage = this.config.slippage;
    const actualExitPrice = this.currentPosition.side === 'long'
      ? exitPrice * (1 - slippage)
      : exitPrice * (1 + slippage);

    // Calculate PnL
    const pnl = this.currentPosition.side === 'long'
      ? (actualExitPrice - this.currentPosition.entryPrice) * this.currentPosition.size
      : (this.currentPosition.entryPrice - actualExitPrice) * this.currentPosition.size;

    // Apply commission
    const commission = Math.abs(pnl) * this.config.commission;
    const netPnl = pnl - commission;

    const pnlPercent = (netPnl / (this.currentPosition.entryPrice * this.currentPosition.size)) * 100;

    // Update trade record
    this.currentTrade.status = 'closed';
    this.currentTrade.exitPrice = actualExitPrice;
    this.currentTrade.exitTime = now;
    this.currentTrade.exitIndex = this.candleManager?.getCurrentIndex() ?? 0;
    this.currentTrade.barsHeld = this.currentPosition.barsHeld;
    this.currentTrade.holdingPeriod = this.currentPosition.barsHeld;
    this.currentTrade.exitReason = reason;
    this.currentTrade.pnl = netPnl;
    this.currentTrade.pnlPercent = pnlPercent;

    // Log exit
    if (this.logger) {
      await this.logger.logExit(this.currentTrade);
    }

    // Record in monitor
    if (this.monitor) {
      this.monitor.recordTrade(this.currentTrade);
    }

    // Print exit
    this.printExit(reason, actualExitPrice, netPnl, pnlPercent);

    this.emit('exit', this.currentTrade);

    // Clear position
    this.currentPosition = null;
    this.currentTrade = null;
  }

  /**
   * Execute agent action
   */
  private async executeAction(action: ExitAction, currentPrice: number): Promise<void> {
    if (!this.currentPosition || !this.currentTrade) return;

    switch (action) {
      case ExitActions.HOLD:
        // Do nothing
        break;

      case ExitActions.EXIT_MARKET:
        await this.closePosition(currentPrice, 'agent');
        break;

      case ExitActions.TIGHTEN_STOP:
        this.tightenStop(currentPrice);
        break;

      case ExitActions.TAKE_PARTIAL:
        await this.takePartialProfit(currentPrice);
        break;
    }
  }

  /**
   * Tighten stop to breakeven
   */
  private tightenStop(currentPrice: number): void {
    if (!this.currentPosition || this.currentPosition.stopTightened) return;

    const pnlPercent = this.currentPosition.side === 'long'
      ? (currentPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice
      : (this.currentPosition.entryPrice - currentPrice) / this.currentPosition.entryPrice;

    // Only tighten if in profit
    if (pnlPercent < 0.01) return; // 1% minimum profit

    const buffer = this.currentPosition.entryPrice * 0.002;
    this.currentPosition.stopLoss = this.currentPosition.side === 'long'
      ? this.currentPosition.entryPrice + buffer
      : this.currentPosition.entryPrice - buffer;

    this.currentPosition.stopTightened = true;
    this.log('debug', `Stop tightened to ${this.currentPosition.stopLoss.toFixed(2)}`);
  }

  /**
   * Take partial profit
   */
  private async takePartialProfit(currentPrice: number): Promise<void> {
    if (!this.currentPosition || this.currentPosition.partialExitTaken) return;

    const pnlPercent = this.currentPosition.side === 'long'
      ? (currentPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice
      : (this.currentPosition.entryPrice - currentPrice) / this.currentPosition.entryPrice;

    // Only take partial if in profit
    if (pnlPercent <= 0) return;

    // Close 50% of position
    const partialSize = this.currentPosition.size * 0.5;
    const pnl = this.currentPosition.side === 'long'
      ? (currentPrice - this.currentPosition.entryPrice) * partialSize
      : (this.currentPosition.entryPrice - currentPrice) * partialSize;

    this.currentPosition.size -= partialSize;
    this.currentPosition.partialExitTaken = true;

    // Also tighten stop
    this.tightenStop(currentPrice);

    this.log('info', `Partial exit: ${partialSize.toFixed(4)} units at ${currentPrice.toFixed(2)}, PnL: $${pnl.toFixed(2)}`);
  }

  /**
   * Check if stop loss or take profit was hit
   */
  private checkStopLossTakeProfit(candle: Candle): { price: number; reason: 'stop_loss' | 'take_profit' } | null {
    if (!this.currentPosition) return null;

    if (this.currentPosition.side === 'long') {
      if (candle.low <= this.currentPosition.stopLoss) {
        return { price: this.currentPosition.stopLoss, reason: 'stop_loss' };
      }
      if (candle.high >= this.currentPosition.takeProfit) {
        return { price: this.currentPosition.takeProfit, reason: 'take_profit' };
      }
    } else {
      if (candle.high >= this.currentPosition.stopLoss) {
        return { price: this.currentPosition.stopLoss, reason: 'stop_loss' };
      }
      if (candle.low <= this.currentPosition.takeProfit) {
        return { price: this.currentPosition.takeProfit, reason: 'take_profit' };
      }
    }

    return null;
  }

  /**
   * Build state vector for agent
   */
  private buildState(currentIndex: number): number[] {
    if (!this.candleManager || !this.currentPosition) {
      return new Array(this.stateSize).fill(0);
    }

    const candles = this.candleManager.getCandles();
    const currentCandle = candles[currentIndex];
    if (!currentCandle) {
      return new Array(this.stateSize).fill(0);
    }

    const currentPrice = currentCandle.close;
    const position = this.currentPosition;

    // Position info (4)
    const pnlPercent = position.side === 'long'
      ? (currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - currentPrice) / position.entryPrice;
    const unrealizedPnL = Math.max(-1, Math.min(1, pnlPercent * 10));
    const barsInPosition = Math.min(position.barsHeld / 50, 1);

    const slDistance = position.side === 'long'
      ? (currentPrice - position.stopLoss) / position.entryATR
      : (position.stopLoss - currentPrice) / position.entryATR;
    const distanceToSL = Math.max(0, Math.min(1, slDistance / 3));

    const tpDistance = position.side === 'long'
      ? (position.takeProfit - currentPrice) / position.entryATR
      : (currentPrice - position.takeProfit) / position.entryATR;
    const distanceToTP = Math.max(0, Math.min(1, tpDistance / 6));

    // Market context (6)
    const priceVsEntry = Math.max(-1, Math.min(1, pnlPercent * 20));
    const volatilityRatio = 1.0;
    const trendStrength = 0.0;
    const nearestOBDistance = 1.0;
    const fvgProximity = 1.0;
    const sessionProgress = 0.5;

    // Price action (8)
    const getReturn = (bars: number): number => {
      if (currentIndex < bars) return 0;
      const prev = candles[currentIndex - bars]?.close ?? currentPrice;
      const ret = (currentPrice - prev) / prev;
      return Math.max(-1, Math.min(1, ret * 20));
    };

    const returns1bar = getReturn(1);
    const returns3bar = getReturn(3);
    const returns5bar = getReturn(5);
    const returns10bar = getReturn(10);

    let highestSinceEntry = 0;
    let lowestSinceEntry = 0;
    for (let i = position.entryIndex; i <= currentIndex; i++) {
      const c = candles[i];
      if (c) {
        const highPct = (c.high - position.entryPrice) / position.entryPrice;
        const lowPct = (position.entryPrice - c.low) / position.entryPrice;
        highestSinceEntry = Math.max(highestSinceEntry, highPct);
        lowestSinceEntry = Math.max(lowestSinceEntry, lowPct);
      }
    }
    highestSinceEntry = Math.min(1, highestSinceEntry * 10);
    lowestSinceEntry = Math.min(1, lowestSinceEntry * 10);

    const candlePatternScore = currentCandle.close > currentCandle.open ? 0.3 : -0.3;
    const volumeRatio = 1.0;

    // Base 18 features
    const baseFeatures = [
      unrealizedPnL,
      barsInPosition,
      distanceToSL,
      distanceToTP,
      priceVsEntry,
      volatilityRatio,
      trendStrength,
      nearestOBDistance,
      fvgProximity,
      sessionProgress,
      returns1bar,
      returns3bar,
      returns5bar,
      returns10bar,
      highestSinceEntry,
      lowestSinceEntry,
      candlePatternScore,
      volumeRatio,
    ];

    // Add KB features if using 22-feature model
    if (this.stateSize > 18) {
      const kbFeatures = [0, 0, 0, 0]; // Placeholder KB features
      return [...baseFeatures, ...kbFeatures];
    }

    return baseFeatures;
  }

  /**
   * Update environment with new candles
   */
  private updateEnvironmentCandles(): void {
    if (!this.env || !this.candleManager) return;

    // Recreate environment with updated candles
    // This is inefficient but ensures state consistency
    // Note: In production, we'd want a more efficient update mechanism
    // For now, we just ensure the candle manager has latest data
    // The environment reference stays the same
  }

  /**
   * Calculate unrealized PnL
   */
  private calculateUnrealizedPnl(currentPrice: number): number {
    if (!this.currentPosition) return 0;

    return this.currentPosition.side === 'long'
      ? (currentPrice - this.currentPosition.entryPrice) * this.currentPosition.size
      : (this.currentPosition.entryPrice - currentPrice) * this.currentPosition.size;
  }

  /**
   * Update position PnL
   */
  private updatePositionPnL(currentPrice: number): void {
    if (!this.currentPosition) return;

    this.currentPosition.unrealizedPnL = this.calculateUnrealizedPnl(currentPrice);

    if (this.currentPosition.unrealizedPnL > this.currentPosition.peakPnL) {
      this.currentPosition.peakPnL = this.currentPosition.unrealizedPnL;
    }
  }

  /**
   * Calculate ATR
   */
  private calculateATR(): number {
    if (!this.candleManager) return 1;

    const candles = this.candleManager.getLatestCandles(14);
    if (candles.length < 2) return 1;

    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i]!.high;
      const low = candles[i]!.low;
      const prevClose = candles[i - 1]!.close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }

    return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length || 1;
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }

    if (this.agent) {
      this.agent.dispose();
      this.agent = null;
    }

    if (this.logger) {
      this.logger.stopPeriodicFlush();
      this.logger = null;
    }
  }

  /**
   * Log message
   */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (!this.config.consoleOutput) return;

    const levels = ['debug', 'info', 'warn', 'error'];
    if (levels.indexOf(level) < levels.indexOf(this.config.logLevel)) return;

    const timestamp = new Date().toISOString().slice(11, 19);
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '';
    console.log(`[${timestamp}] ${prefix} ${message}`);
  }

  /**
   * Print header
   */
  private printHeader(): void {
    console.log('='.repeat(80));
    console.log('ICT Paper Trading - KB-Enhanced Hybrid Agent');
    console.log('='.repeat(80));
    console.log(`Symbol: ${this.config.symbol} | Timeframe: ${this.config.timeframe} | Model: ${path.basename(this.config.modelPath)}`);
    console.log(`Session: ${this.sessionId} | KB Enabled: ${this.config.kbEnabled ? 'YES' : 'NO'}`);
    console.log('-'.repeat(80));
    console.log();
  }

  /**
   * Print entry
   */
  private printEntry(signal: { direction: string; confluence: number; factors: string[] }): void {
    const confluenceLabel = signal.confluence >= 5 ? 'A+' : signal.confluence >= 4 ? 'A' : signal.confluence >= 3 ? 'B' : 'C';
    const timestamp = new Date().toISOString().slice(11, 19);

    console.log();
    console.log(`[${timestamp}] ENTRY SIGNAL - ${signal.direction.toUpperCase()}`);
    console.log(`           Confluence: ${confluenceLabel} (${signal.confluence} factors)`);
    console.log(`           Entry: $${this.currentPosition?.entryPrice.toFixed(2)} | SL: $${this.currentPosition?.stopLoss.toFixed(2)} (-${(this.config.slPercent * 100).toFixed(1)}%) | TP: $${this.currentPosition?.takeProfit.toFixed(2)} (+${(this.config.tpPercent * 100).toFixed(1)}%)`);

    if (this.currentTrade?.kbPrimaryConcept) {
      console.log(`           KB Concept: "${this.currentTrade.kbPrimaryConcept}" (${(this.currentTrade.kbAlignmentScore ?? 0).toFixed(2)} similarity)`);
    }
  }

  /**
   * Print exit
   */
  private printExit(reason: string, exitPrice: number, pnl: number, pnlPercent: number): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    const pnlSign = pnl >= 0 ? '+' : '';
    const reasonLabel = reason.replace('_', ' ').toUpperCase();

    console.log();
    console.log(`[${timestamp}] EXIT - ${reasonLabel}`);
    console.log(`           Exit: $${exitPrice.toFixed(2)} | PnL: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPercent.toFixed(2)}%)`);
    console.log(`           Holding: ${this.currentTrade?.barsHeld ?? 0} bars`);
  }

  /**
   * Print status
   */
  private printStatus(): void {
    if (!this.monitor) return;

    const metrics = this.monitor.getMetrics(
      this.currentPosition ? this.calculateUnrealizedPnl(this.lastCandle?.close ?? 0) : 0
    );

    console.log(this.monitor.formatMetrics(metrics));
  }

  /**
   * Print summary
   */
  private printSummary(): void {
    if (!this.monitor) return;

    console.log();
    console.log('='.repeat(80));
    console.log('SESSION SUMMARY');
    console.log('='.repeat(80));

    const metrics = this.monitor.getMetrics();
    console.log(this.monitor.formatMetrics(metrics));
  }

  /**
   * Get current session
   */
  getSession(): PaperSession | null {
    return this.session;
  }

  /**
   * Get current metrics
   */
  getMetrics(): PerformanceMetrics | null {
    return this.monitor?.getMetrics() ?? null;
  }

  /**
   * Check if running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof PaperTraderEvents>(
    event: K,
    listener: PaperTraderEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof PaperTraderEvents>(
    event: K,
    ...args: Parameters<PaperTraderEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
