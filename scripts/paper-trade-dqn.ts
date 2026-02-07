#!/usr/bin/env npx tsx
/**
 * Paper Trade DQN Model
 *
 * Run paper trading with the trained DQN model on live Binance data.
 *
 * Usage:
 *   npx tsx scripts/paper-trade-dqn.ts --model ./models/model_anti_overfit_2026-02-02T07-57-32.json
 */

import '@tensorflow/tfjs-node';

import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

import type { Candle } from '@/types';
import {
  DQNAgent,
  ReplayBuffer,
  type SerializedWeights,
  type Action,
  Actions,
  actionToName,
  type Portfolio,
  type Position,
  type TradeRecord,
} from '../src/lib/rl';
import { StateBuilder } from '../src/lib/rl/environment/state-builder';
import { FeatureReducer, type SerializedFeatureReducer } from '../src/lib/rl/environment/feature-reducer';

// ============================================
// Configuration
// ============================================

interface Config {
  symbol: string;
  timeframe: string;
  modelPath: string;
  initialCapital: number;
  positionSize: number;
  spread: number;
  commission: number;
  slippage: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  lookbackPeriod: number;
  backtestBars: number; // Number of bars to backtest (0 = live mode)
}

const DEFAULT_CONFIG: Config = {
  symbol: 'BTCUSDT',
  timeframe: '1h',
  modelPath: './models/model_anti_overfit_2026-02-02T07-57-32.json',
  initialCapital: 10000,
  positionSize: 0.1,
  spread: 0.0001,
  commission: 0.0004,
  slippage: 0.0005,
  stopLossPercent: 0.02,
  takeProfitPercent: 0.04,
  lookbackPeriod: 60,
  backtestBars: 0, // 0 = live mode
};

// ============================================
// Argument parsing
// ============================================

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg?.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      }
    }
  }

  return {
    ...DEFAULT_CONFIG,
    symbol: options['symbol'] || DEFAULT_CONFIG.symbol,
    timeframe: options['timeframe'] || DEFAULT_CONFIG.timeframe,
    modelPath: options['model'] || DEFAULT_CONFIG.modelPath,
    initialCapital: parseFloat(options['capital'] || String(DEFAULT_CONFIG.initialCapital)),
    positionSize: parseFloat(options['position-size'] || String(DEFAULT_CONFIG.positionSize)),
    backtestBars: parseInt(options['backtest'] || '0', 10),
  };
}

function printHelp(): void {
  console.log(`
DQN Paper Trading

Usage:
  npx tsx scripts/paper-trade-dqn.ts [options]

Options:
  --symbol <symbol>        Trading symbol (default: BTCUSDT)
  --timeframe <tf>         Timeframe (default: 1h)
  --model <path>           Path to trained model JSON
  --capital <amount>       Initial capital (default: 10000)
  --position-size <frac>   Position size as fraction (default: 0.1)
  --backtest <bars>        Run backtest on N historical bars (default: 0 = live mode)
  --help, -h               Show this help

Examples:
  # Live paper trading
  npx tsx scripts/paper-trade-dqn.ts --model ./models/model_anti_overfit_2026-02-02T07-57-32.json

  # Backtest on last 200 bars
  npx tsx scripts/paper-trade-dqn.ts --model ./models/model_anti_overfit_2026-02-02T07-57-32.json --backtest 200
`);
}

// ============================================
// Paper Trader
// ============================================

class DQNPaperTrader {
  private config: Config;
  private agent: DQNAgent | null = null;
  private stateBuilder: StateBuilder;
  private featureReducer: FeatureReducer | null = null;
  private modelInputSize: number = 104;

  // Market data
  private candles: Candle[] = [];
  private ws: WebSocket | null = null;

  // Trading state
  private portfolio: Portfolio;
  private trades: TradeRecord[] = [];
  private lastAction: Action = Actions.HOLD;
  private consecutiveHolds: number = 0;
  private warmupComplete: boolean = false;

  // Statistics
  private totalBars: number = 0;
  private actionCounts: Record<string, number> = {
    hold: 0,
    buy: 0,
    sell: 0,
    close: 0,
  };

  constructor(config: Config) {
    this.config = config;
    this.stateBuilder = new StateBuilder({
      lookbackPeriod: config.lookbackPeriod,
      normalize: true,
      useATRNormalization: true,
      featureNoiseLevel: 0, // No noise in live trading
    });
    this.portfolio = this.createInitialPortfolio();
  }

  private createInitialPortfolio(): Portfolio {
    return {
      cash: this.config.initialCapital,
      equity: this.config.initialCapital,
      position: null,
      realizedPnL: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      maxDrawdown: 0,
      peakEquity: this.config.initialCapital,
    };
  }

  async start(): Promise<void> {
    console.log('='.repeat(70));
    console.log('DQN Paper Trading');
    console.log('='.repeat(70));
    console.log(`Symbol: ${this.config.symbol} | Timeframe: ${this.config.timeframe}`);
    console.log(`Model: ${path.basename(this.config.modelPath)}`);
    console.log(`Capital: $${this.config.initialCapital} | Position Size: ${(this.config.positionSize * 100).toFixed(0)}%`);
    if (this.config.backtestBars > 0) {
      console.log(`Mode: BACKTEST (${this.config.backtestBars} bars)`);
    } else {
      console.log('Mode: LIVE');
    }
    console.log('-'.repeat(70));

    // Load model
    await this.loadModel();

    // Fetch historical candles
    await this.fetchHistoricalCandles();

    // Skip WebSocket for backtest mode
    if (this.config.backtestBars > 0) {
      return; // Backtest is run in fetchHistoricalCandles
    }

    // Connect to WebSocket for live mode
    await this.connectWebSocket();

    console.log('\nPaper trading started. Press Ctrl+C to stop.\n');
  }

  private async loadModel(): Promise<void> {
    const modelPath = path.resolve(this.config.modelPath);

    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model not found: ${modelPath}`);
    }

    console.log(`Loading model from ${modelPath}...`);

    const content = fs.readFileSync(modelPath, 'utf-8');
    const modelFile = JSON.parse(content) as {
      timestamp: string;
      episode: number;
      config: {
        dqn: SerializedWeights['config'];
      };
      weights: {
        weights: SerializedWeights['weights'];
      };
      featureReducerModel?: SerializedFeatureReducer | null;
    };

    // Transform to expected SerializedWeights format
    const weights: SerializedWeights = {
      weights: modelFile.weights.weights,
      config: modelFile.config.dqn,
      state: {
        epsilon: modelFile.config.dqn.epsilonEnd, // Use end epsilon for inference
        totalSteps: 0,
        episodeCount: modelFile.episode,
        averageReward: 0,
        averageLoss: 0,
      },
      agentType: 'dqn',
    };

    // Check actual input size from weights
    const firstWeightShape = weights.weights[0]?.shape;
    const actualInputSize = firstWeightShape ? firstWeightShape[0] : weights.config.inputSize;
    this.modelInputSize = actualInputSize;

    console.log(`Model config: inputSize=${actualInputSize} (config says ${weights.config.inputSize})`);
    console.log(`Hidden layers: ${weights.config.hiddenLayers.join('-')}`);
    console.log(`Weights: ${weights.weights.length} tensors`);

    // Override inputSize if it doesn't match weights
    if (actualInputSize !== weights.config.inputSize) {
      console.log(`Note: Actual input size (${actualInputSize}) differs from config (${weights.config.inputSize})`);
      weights.config.inputSize = actualInputSize;

      // Check if saved PCA model is available
      if (modelFile.featureReducerModel) {
        console.log('      Loading saved PCA model from training...');
        this.featureReducer = new FeatureReducer();
        this.featureReducer.importModel(modelFile.featureReducerModel);
        this.warmupComplete = true;
      } else {
        console.log(`      No saved PCA model found. Will re-fit PCA to ${actualInputSize} dimensions.`);
        console.log('      ⚠️  Warning: Re-fitted PCA may not match training PCA exactly.');

        // Initialize feature reducer targeting exact model input size
        this.featureReducer = new FeatureReducer({
          method: 'pca',
          targetDimensions: actualInputSize, // Match model exactly
          varianceThreshold: 0.999, // Use target dimensions, not variance
          warmupSamples: 1000,
        });
      }
    }

    // Create agent with corrected config
    const buffer = new ReplayBuffer({
      capacity: 1000,
      batchSize: 32,
      minExperience: 100,
    });

    this.agent = new DQNAgent(weights.config, buffer);
    await this.agent.loadWeights(weights);

    console.log('Model loaded successfully.\n');
  }

  private async fetchHistoricalCandles(): Promise<void> {
    console.log('Fetching historical candles...');

    const interval = this.config.timeframe;
    // Need more candles for PCA warmup if feature reduction is enabled
    const needsWarmup = this.featureReducer !== null;
    const limit = needsWarmup ? 1500 : this.config.lookbackPeriod + 100;

    const url = `https://api.binance.com/api/v3/klines?symbol=${this.config.symbol}&interval=${interval}&limit=${limit}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch historical candles: ${response.statusText}`);
    }

    const data = await response.json() as Array<[
      number, string, string, string, string, string,
      number, string, number, string, string, string
    ]>;

    this.candles = data.map((k) => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    console.log(`Loaded ${this.candles.length} historical candles.`);

    // Perform PCA warmup if feature reduction is needed and not already loaded
    if (this.featureReducer && !this.warmupComplete) {
      await this.warmupFeatureReducer();
    } else if (this.featureReducer && this.warmupComplete) {
      console.log('PCA model already loaded from training.\n');
    }

    // Run backtest if requested
    if (this.config.backtestBars > 0) {
      await this.runBacktest();
    }
  }

  private async runBacktest(): Promise<void> {
    if (!this.agent) return;

    console.log(`\nRunning backtest on last ${this.config.backtestBars} bars...\n`);
    console.log('-'.repeat(70));

    const startIdx = Math.max(
      this.config.lookbackPeriod,
      this.candles.length - this.config.backtestBars
    );

    for (let i = startIdx; i < this.candles.length; i++) {
      const candle = this.candles[i]!;
      this.onCandleClosed(candle);
    }

    // Close any open position at end
    if (this.portfolio.position && this.candles.length > 0) {
      const lastPrice = this.candles[this.candles.length - 1]!.close;
      this.closePosition(lastPrice, 'backtest_end');
    }

    this.printSummary();
  }

  private async warmupFeatureReducer(): Promise<void> {
    if (!this.featureReducer) return;

    console.log('Warming up feature reducer (fitting PCA)...');

    const warmupSamples = 1000;
    const startIdx = Math.max(this.config.lookbackPeriod, this.candles.length - warmupSamples - 100);

    for (let i = startIdx; i < this.candles.length - 1; i++) {
      const lookbackCandles = this.candles.slice(Math.max(0, i - this.config.lookbackPeriod + 1), i + 1);
      if (lookbackCandles.length < this.config.lookbackPeriod) continue;

      const currentPrice = lookbackCandles[lookbackCandles.length - 1]!.close;
      const state = this.stateBuilder.build(
        lookbackCandles,
        i,
        currentPrice,
        null, // No position during warmup
        false
      );

      this.featureReducer.addSample(state.features);

      if (this.featureReducer.isReady()) {
        break;
      }
    }

    if (!this.featureReducer.isReady()) {
      // Force fit if not enough samples
      this.featureReducer.fit();
    }

    const stats = this.featureReducer.getStats();
    console.log(`PCA fitted: ${stats.inputDimension} → ${stats.outputDimension} features`);
    console.log(`Explained variance: ${((stats.explainedVariance ?? 0) * 100).toFixed(1)}%\n`);

    this.warmupComplete = true;
  }

  private async connectWebSocket(): Promise<void> {
    const symbol = this.config.symbol.toLowerCase();
    const interval = this.config.timeframe;
    const url = `wss://stream.binance.com:9443/ws/${symbol}@kline_${interval}`;

    console.log(`Connecting to ${url}...`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log('WebSocket connected.\n');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`WebSocket closed: ${code} - ${reason?.toString() || 'unknown'}`);
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        reject(error);
      });
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as {
        e: string;
        k: {
          t: number;
          o: string;
          h: string;
          l: string;
          c: string;
          v: string;
          x: boolean;
        };
      };

      if (message.e !== 'kline') return;

      const kline = message.k;
      const candle: Candle = {
        timestamp: kline.t,
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c),
        volume: parseFloat(kline.v),
      };

      // Update or add candle
      const lastCandle = this.candles[this.candles.length - 1];
      if (lastCandle && lastCandle.timestamp === candle.timestamp) {
        // Update current candle
        this.candles[this.candles.length - 1] = candle;
      } else if (kline.x) {
        // Candle closed - add new one and process
        this.candles.push(candle);
        if (this.candles.length > this.config.lookbackPeriod + 200) {
          this.candles.shift();
        }
        this.onCandleClosed(candle);
      }

      // Update unrealized PnL display
      if (this.portfolio.position) {
        this.updateUnrealizedPnL(candle.close);
      }
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  }

  private onCandleClosed(candle: Candle): void {
    if (!this.agent || this.candles.length < this.config.lookbackPeriod) {
      return;
    }

    this.totalBars++;
    const currentPrice = candle.close;
    const currentIndex = this.candles.length - 1;

    // Check stop loss / take profit first
    const slTpHit = this.checkStopLossTakeProfit(candle);
    if (slTpHit) {
      this.closePosition(slTpHit.price, slTpHit.reason);
      return;
    }

    // Build state
    const lookbackCandles = this.candles.slice(-this.config.lookbackPeriod);
    const state = this.stateBuilder.build(
      lookbackCandles,
      currentIndex,
      currentPrice,
      this.portfolio.position,
      false // Not training
    );

    // Apply feature reduction if enabled
    let features = state.features;
    if (this.featureReducer && this.featureReducer.isReady()) {
      features = this.featureReducer.transform(features);
    }

    // Verify feature size matches model expectation
    if (features.length !== this.modelInputSize) {
      console.warn(`Feature size mismatch: got ${features.length}, expected ${this.modelInputSize}`);
      return;
    }

    // Get agent action (no exploration in live trading)
    const action = this.agent.selectAction(features, false) as Action;
    this.lastAction = action;
    this.actionCounts[actionToName(action)]++;

    // Track consecutive holds
    if (action === Actions.HOLD) {
      this.consecutiveHolds++;
    } else {
      this.consecutiveHolds = 0;
    }

    // Execute action
    this.executeAction(action, currentPrice);

    // Print status
    this.printStatus(candle);
  }

  private executeAction(action: Action, currentPrice: number): void {
    switch (action) {
      case Actions.BUY:
        if (!this.portfolio.position) {
          this.openPosition('long', currentPrice);
        } else if (this.portfolio.position.side === 'short') {
          this.closePosition(currentPrice, 'signal');
          this.openPosition('long', currentPrice);
        }
        break;

      case Actions.SELL:
        if (!this.portfolio.position) {
          this.openPosition('short', currentPrice);
        } else if (this.portfolio.position.side === 'long') {
          this.closePosition(currentPrice, 'signal');
          this.openPosition('short', currentPrice);
        }
        break;

      case Actions.CLOSE:
        if (this.portfolio.position) {
          this.closePosition(currentPrice, 'signal');
        }
        break;

      case Actions.HOLD:
        // Do nothing
        break;
    }
  }

  private openPosition(side: 'long' | 'short', price: number): void {
    // Apply slippage
    const slippage = this.config.slippage;
    const entryPrice = side === 'long'
      ? price * (1 + slippage)
      : price * (1 - slippage);

    const positionValue = this.portfolio.cash * this.config.positionSize;
    const size = positionValue / entryPrice;

    this.portfolio.position = {
      side,
      entryPrice,
      entryIndex: this.candles.length - 1,
      size,
      unrealizedPnL: 0,
    };

    // Calculate SL/TP levels
    const sl = side === 'long'
      ? entryPrice * (1 - this.config.stopLossPercent)
      : entryPrice * (1 + this.config.stopLossPercent);
    const tp = side === 'long'
      ? entryPrice * (1 + this.config.takeProfitPercent)
      : entryPrice * (1 - this.config.takeProfitPercent);

    const time = new Date().toISOString().slice(11, 19);
    console.log();
    console.log(`[${time}] ▶ ENTRY ${side.toUpperCase()}`);
    console.log(`         Price: $${entryPrice.toFixed(2)} | Size: ${size.toFixed(6)}`);
    console.log(`         SL: $${sl.toFixed(2)} (-${(this.config.stopLossPercent * 100).toFixed(1)}%) | TP: $${tp.toFixed(2)} (+${(this.config.takeProfitPercent * 100).toFixed(1)}%)`);
  }

  private closePosition(exitPrice: number, reason: string): void {
    if (!this.portfolio.position) return;

    const position = this.portfolio.position;

    // Apply slippage
    const slippage = this.config.slippage;
    const actualExitPrice = position.side === 'long'
      ? exitPrice * (1 - slippage)
      : exitPrice * (1 + slippage);

    // Calculate PnL
    const pnl = position.side === 'long'
      ? (actualExitPrice - position.entryPrice) * position.size
      : (position.entryPrice - actualExitPrice) * position.size;

    // Apply commission
    const commission = (position.entryPrice * position.size + actualExitPrice * position.size) * this.config.commission;
    const netPnl = pnl - commission;

    const pnlPercent = (netPnl / (position.entryPrice * position.size)) * 100;

    // Update portfolio
    this.portfolio.cash += netPnl;
    this.portfolio.equity = this.portfolio.cash;
    this.portfolio.realizedPnL += netPnl;
    this.portfolio.totalTrades++;

    if (netPnl > 0) {
      this.portfolio.winningTrades++;
    } else {
      this.portfolio.losingTrades++;
    }

    if (this.portfolio.equity > this.portfolio.peakEquity) {
      this.portfolio.peakEquity = this.portfolio.equity;
    }

    const drawdown = (this.portfolio.peakEquity - this.portfolio.equity) / this.portfolio.peakEquity;
    this.portfolio.maxDrawdown = Math.max(this.portfolio.maxDrawdown, drawdown);

    // Record trade
    const holdingPeriod = this.candles.length - 1 - position.entryIndex;
    this.trades.push({
      entryIndex: position.entryIndex,
      exitIndex: this.candles.length - 1,
      entryPrice: position.entryPrice,
      exitPrice: actualExitPrice,
      side: position.side,
      pnl: netPnl,
      pnlPercent,
      holdingPeriod,
    });

    const time = new Date().toISOString().slice(11, 19);
    const pnlSign = netPnl >= 0 ? '+' : '';
    console.log();
    console.log(`[${time}] ◼ EXIT ${position.side.toUpperCase()} (${reason})`);
    console.log(`         Price: $${actualExitPrice.toFixed(2)} | PnL: ${pnlSign}$${netPnl.toFixed(2)} (${pnlSign}${pnlPercent.toFixed(2)}%)`);
    console.log(`         Holding: ${holdingPeriod} bars | Trades: ${this.portfolio.totalTrades}`);

    // Clear position
    this.portfolio.position = null;
  }

  private checkStopLossTakeProfit(candle: Candle): { price: number; reason: string } | null {
    if (!this.portfolio.position) return null;

    const position = this.portfolio.position;
    const slPrice = position.side === 'long'
      ? position.entryPrice * (1 - this.config.stopLossPercent)
      : position.entryPrice * (1 + this.config.stopLossPercent);
    const tpPrice = position.side === 'long'
      ? position.entryPrice * (1 + this.config.takeProfitPercent)
      : position.entryPrice * (1 - this.config.takeProfitPercent);

    if (position.side === 'long') {
      if (candle.low <= slPrice) {
        return { price: slPrice, reason: 'stop_loss' };
      }
      if (candle.high >= tpPrice) {
        return { price: tpPrice, reason: 'take_profit' };
      }
    } else {
      if (candle.high >= slPrice) {
        return { price: slPrice, reason: 'stop_loss' };
      }
      if (candle.low <= tpPrice) {
        return { price: tpPrice, reason: 'take_profit' };
      }
    }

    return null;
  }

  private updateUnrealizedPnL(currentPrice: number): void {
    if (!this.portfolio.position) return;

    const position = this.portfolio.position;
    position.unrealizedPnL = position.side === 'long'
      ? (currentPrice - position.entryPrice) * position.size
      : (position.entryPrice - currentPrice) * position.size;

    this.portfolio.equity = this.portfolio.cash + position.unrealizedPnL;
  }

  private printStatus(candle: Candle): void {
    const time = new Date().toISOString().slice(11, 19);
    const price = candle.close.toFixed(2);
    const action = actionToName(this.lastAction).toUpperCase().padEnd(5);

    const posStr = this.portfolio.position
      ? `${this.portfolio.position.side.toUpperCase()} @ $${this.portfolio.position.entryPrice.toFixed(2)}`
      : 'FLAT';

    const equityStr = `$${this.portfolio.equity.toFixed(2)}`;
    const pnlStr = this.portfolio.realizedPnL >= 0
      ? `+$${this.portfolio.realizedPnL.toFixed(2)}`
      : `-$${Math.abs(this.portfolio.realizedPnL).toFixed(2)}`;

    const winRate = this.portfolio.totalTrades > 0
      ? ((this.portfolio.winningTrades / this.portfolio.totalTrades) * 100).toFixed(1)
      : '0.0';

    console.log(
      `[${time}] ${price} | ${action} | ${posStr.padEnd(20)} | Equity: ${equityStr} | PnL: ${pnlStr} | WR: ${winRate}% | Trades: ${this.portfolio.totalTrades}`
    );
  }

  async stop(): Promise<void> {
    console.log('\nShutting down...');

    // Close any open position
    if (this.portfolio.position && this.candles.length > 0) {
      const lastPrice = this.candles[this.candles.length - 1]!.close;
      this.closePosition(lastPrice, 'shutdown');
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
    }

    // Dispose agent
    if (this.agent) {
      this.agent.dispose();
    }

    // Print summary
    this.printSummary();
  }

  private printSummary(): void {
    console.log('\n' + '='.repeat(70));
    console.log('SESSION SUMMARY');
    console.log('='.repeat(70));

    const winRate = this.portfolio.totalTrades > 0
      ? (this.portfolio.winningTrades / this.portfolio.totalTrades) * 100
      : 0;

    console.log(`Total Bars: ${this.totalBars}`);
    console.log(`Total Trades: ${this.portfolio.totalTrades}`);
    console.log(`Win Rate: ${winRate.toFixed(1)}% (${this.portfolio.winningTrades}W / ${this.portfolio.losingTrades}L)`);
    console.log(`Realized PnL: $${this.portfolio.realizedPnL.toFixed(2)}`);
    console.log(`Final Equity: $${this.portfolio.equity.toFixed(2)}`);
    console.log(`Max Drawdown: ${(this.portfolio.maxDrawdown * 100).toFixed(2)}%`);

    console.log('\nAction Distribution:');
    const totalActions = Object.values(this.actionCounts).reduce((a, b) => a + b, 0);
    for (const [action, count] of Object.entries(this.actionCounts)) {
      const pct = totalActions > 0 ? ((count / totalActions) * 100).toFixed(1) : '0.0';
      console.log(`  ${action.toUpperCase()}: ${count} (${pct}%)`);
    }

    if (this.trades.length > 0) {
      const avgPnl = this.trades.reduce((sum, t) => sum + t.pnl, 0) / this.trades.length;
      const avgHoldingPeriod = this.trades.reduce((sum, t) => sum + t.holdingPeriod, 0) / this.trades.length;

      console.log('\nTrade Statistics:');
      console.log(`  Avg PnL per Trade: $${avgPnl.toFixed(2)}`);
      console.log(`  Avg Holding Period: ${avgHoldingPeriod.toFixed(1)} bars`);
    }

    console.log('='.repeat(70));
  }
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const config = parseArgs();
  const trader = new DQNPaperTrader(config);

  // Handle shutdown
  let isShuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    await trader.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await trader.start();

    // Keep running
    await new Promise(() => {
      // Never resolves
    });
  } catch (error) {
    console.error('Error:', error);
    await trader.stop();
    process.exit(1);
  }
}

main().catch(console.error);
