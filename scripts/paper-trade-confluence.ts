#!/usr/bin/env npx tsx
/**
 * Paper Trade — Confluence Scorer (Production Config)
 *
 * Connects the rule-based confluence scorer to Binance live data via WebSocket
 * for paper trading. Defaults match the CMA-ES Run 18 production config that
 * achieved 78.1% walk-forward pass rate (fitness=1071.7).
 *
 * Modes:
 *   Live:       npx tsx scripts/paper-trade-confluence.ts
 *   Backtest:   npx tsx scripts/paper-trade-confluence.ts --backtest 500
 *   Simulate:   npx tsx scripts/paper-trade-confluence.ts --simulate --start-date 2025-06-01
 *
 * Options:
 *   --symbols BTCUSDT,ETHUSDT,SOLUSDT  (default: all three)
 *   --symbol BTCUSDT                   (alias: single symbol)
 *   --threshold 4.672                  (default: 4.672)
 *   --capital 10000                    (default: 10000)
 *   --sl-mode dynamic_rr              (default: dynamic_rr)
 *   --suppress-regime "ranging+normal,ranging+high,downtrend+high"
 *   --friction 0.0007                 (default: 0.0007)
 *   --partial-tp "0.55,0.84,0.05"     (fraction,triggerR,beBuffer — default: 0.55,0.84,0.05)
 *   --no-partial-tp                   (disable partial TP)
 *   --atr-extension 4.10             (default: 4.10)
 *   --ob-half-life 18                (default: 18)
 *   --max-bars 108                   (default: 108, max position hold)
 *   --cooldown-bars 8                (default: 8, min bars between signals)
 *   --weights "key:val,key:val"      (override confluence weights)
 *   --regime-threshold "uptrend+high:2.86,uptrend+normal:6.17,..."
 *   --backtest <bars>                 (run on last N bars of saved data)
 *   --simulate                        (replay local data files at accelerated speed)
 *   --start-date 2025-01-01           (simulation start date, default: all data)
 *   --end-date 2026-02-01             (simulation end date, default: all data)
 *   --speed 1                         (candles/sec, 0=max speed, default: 0)
 *   --verbose                         (debug logging)
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  DEFAULT_WEIGHTS,
  PRODUCTION_STRATEGY_CONFIG,
  type ConfluenceConfig,
} from '../src/lib/rl/strategies/confluence-scorer';
import type { SLPlacementMode } from '../src/lib/rl/strategies/ict-strategies';
import { BinanceWebSocket } from '../src/lib/paper-trading/binance-ws';
import { CandleManager } from '../src/lib/paper-trading/candle-manager';
import { RiskManager, DEFAULT_RISK_LIMITS } from '../src/lib/paper-trading/risk-manager';
import { PositionSizer, DEFAULT_POSITION_SIZING_CONFIG } from '../src/lib/paper-trading/position-sizer';
import { PerformanceMonitor } from '../src/lib/paper-trading/performance-monitor';
import { TradeLogger } from '../src/lib/paper-trading/trade-logger';
import { createRepository } from '../src/lib/paper-trading/create-repository';
import type { PaperTradingRepository } from '../src/lib/paper-trading/repository';
import type { PaperTrade, PaperTraderConfig } from '../src/lib/paper-trading/types';
import type { LiveCandle } from '../src/lib/paper-trading/types';

// ============================================
// Constants
// ============================================

/** Default combined friction per side (0.07% = 0.0007) matching production */
const DEFAULT_FRICTION = 0.0007;

/** Metrics log interval (every N candles) */
const METRICS_LOG_INTERVAL = 10;

/** Default regime threshold overrides — CMA-ES Run 18 production config */
const PRODUCTION_REGIME_THRESHOLDS: Record<string, number> = {
  'uptrend+high': 2.86,
  'uptrend+normal': 6.17,
  'uptrend+low': 3.13,
  'downtrend+normal': 4.33,
  'downtrend+low': 4.48,
};

/** CMA-ES Run 18 optimized weights */
const PRODUCTION_WEIGHTS: Record<string, number> = {
  structureAlignment: 2.660,
  killZoneActive: 0.814,
  liquiditySweep: 1.733,
  obProximity: 1.103,
  fvgAtCE: 1.554,
  recentBOS: 1.255,
  rrRatio: 0.627,
  oteZone: 0.787,
  obFvgConfluence: 1.352,
};

// ============================================
// Types
// ============================================

interface PartialTPConfig {
  /** Fraction to close (0-1, e.g. 0.45 = 45%) */
  fraction: number;
  /** R-multiple trigger (e.g. 0.85 = at 0.85R profit) */
  triggerR: number;
  /** Breakeven buffer as fraction of risk distance (0 = exact BE, default: 0.1) */
  beBuffer: number;
}

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
  // Partial TP state
  partialTaken: boolean;
  partialPnl: number;       // PnL% locked in on partial close
  originalSL: number;       // SL before BE move
  riskDistance: number;      // Entry-to-SL distance for R calculations
}

interface CLIArgs {
  symbols: string[];
  threshold: number;
  capital: number;
  backtest: number | null;
  simulate: boolean;
  startDate: string | null;
  endDate: string | null;
  speed: number;
  verbose: boolean;
  suppressRegime: string[];
  slMode: SLPlacementMode;
  friction: number;
  partialTp: PartialTPConfig | null;
  atrExtension: number;
  obHalfLife: number;
  maxBars: number;
  cooldownBars: number;
  weights: Record<string, number>;
  regimeThresholds: Record<string, number>;
  noRiskManager: boolean;
}

// ============================================
// CLI Parsing
// ============================================

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    threshold: 4.672,
    capital: 10000,
    backtest: null,
    simulate: false,
    startDate: null,
    endDate: null,
    speed: 0,
    verbose: false,
    suppressRegime: ['ranging+normal', 'ranging+high', 'downtrend+high'],
    slMode: 'dynamic_rr',
    friction: DEFAULT_FRICTION,
    partialTp: { fraction: 0.55, triggerR: 0.84, beBuffer: 0.05 },
    atrExtension: 4.10,
    obHalfLife: 18,
    maxBars: 108,
    cooldownBars: 8,
    weights: { ...PRODUCTION_WEIGHTS },
    regimeThresholds: { ...PRODUCTION_REGIME_THRESHOLDS },
    noRiskManager: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--symbol':
        result.symbols = [args[++i] ?? 'BTCUSDT'];
        break;
      case '--symbols':
        result.symbols = (args[++i] ?? 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--threshold':
        result.threshold = parseFloat(args[++i] ?? '4.672');
        break;
      case '--capital':
        result.capital = parseFloat(args[++i] ?? '10000');
        break;
      case '--backtest':
        result.backtest = parseInt(args[++i] ?? '500', 10);
        break;
      case '--simulate':
        result.simulate = true;
        break;
      case '--start-date':
        result.startDate = args[++i] ?? null;
        break;
      case '--end-date':
        result.endDate = args[++i] ?? null;
        break;
      case '--speed':
        result.speed = parseFloat(args[++i] ?? '0');
        break;
      case '--verbose':
        result.verbose = true;
        break;
      case '--suppress-regime':
        result.suppressRegime = (args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--sl-mode': {
        const mode = args[++i] ?? 'dynamic_rr';
        if (['ob_based', 'entry_based', 'dynamic_rr'].includes(mode)) {
          result.slMode = mode as SLPlacementMode;
        }
        break;
      }
      case '--friction':
        result.friction = parseFloat(args[++i] ?? String(DEFAULT_FRICTION));
        break;
      case '--partial-tp': {
        const parts = (args[++i] ?? '0.55,0.84,0.05').split(',');
        result.partialTp = {
          fraction: parseFloat(parts[0] ?? '0.55'),
          triggerR: parseFloat(parts[1] ?? '0.84'),
          beBuffer: parseFloat(parts[2] ?? '0.05'),
        };
        break;
      }
      case '--no-partial-tp':
        result.partialTp = null;
        break;
      case '--no-risk-manager':
        result.noRiskManager = true;
        break;
      case '--atr-extension':
        result.atrExtension = parseFloat(args[++i] ?? '4.10');
        break;
      case '--ob-half-life':
        result.obHalfLife = parseFloat(args[++i] ?? '18');
        break;
      case '--max-bars':
        result.maxBars = parseInt(args[++i] ?? '108', 10);
        break;
      case '--cooldown-bars':
        result.cooldownBars = parseInt(args[++i] ?? '8', 10);
        break;
      case '--weights': {
        const weightPairs = (args[++i] ?? '').split(',');
        const baseWeights = { ...DEFAULT_WEIGHTS };
        for (const pair of weightPairs) {
          const [key, val] = pair.split(':');
          if (key && val && key.trim() in baseWeights) {
            (baseWeights as Record<string, number>)[key.trim()] = parseFloat(val);
          }
        }
        result.weights = baseWeights;
        break;
      }
      case '--regime-threshold': {
        const pairs = (args[++i] ?? '').split(',');
        result.regimeThresholds = {};
        for (const pair of pairs) {
          const [key, val] = pair.split(':');
          if (key && val) {
            result.regimeThresholds[key.trim()] = parseFloat(val.trim());
          }
        }
        break;
      }
    }
  }

  return result;
}

// ============================================
// Friction Helpers (mirrors backtest-confluence.ts)
// ============================================

function applyEntryFriction(price: number, direction: 'long' | 'short', friction: number): number {
  return direction === 'long'
    ? price * (1 + friction)
    : price * (1 - friction);
}

function applyExitFriction(price: number, direction: 'long' | 'short', friction: number): number {
  return direction === 'long'
    ? price * (1 - friction)
    : price * (1 + friction);
}

// ============================================
// Core Paper Trader (per-symbol)
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
  private tradeCounter = 0;
  private sessionId: string;
  private verbose: boolean;
  private symbol: string;
  private friction: number;
  private partialTp: PartialTPConfig | null;
  private maxBars: number;
  private noRiskManager: boolean;
  private shuttingDown = false;

  constructor(
    args: CLIArgs,
    symbol: string,
    private readonly repo: PaperTradingRepository,
  ) {
    this.symbol = symbol;
    this.verbose = args.verbose;
    this.friction = args.friction;
    this.partialTp = args.partialTp;
    this.maxBars = args.maxBars;
    this.noRiskManager = args.noRiskManager;
    this.sessionId = `confluence-${symbol}-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    // Initialize scorer with full production config
    const scorerConfig: Partial<ConfluenceConfig> = {
      activeStrategies: ['order_block'],
      minThreshold: args.threshold,
      strategyConfig: {
        ...PRODUCTION_STRATEGY_CONFIG,
        slPlacementMode: args.slMode,
      },
      ...(args.suppressRegime.length > 0 ? { suppressedRegimes: args.suppressRegime } : {}),
      obFreshnessHalfLife: args.obHalfLife,
      atrExtensionBands: args.atrExtension,
      regimeThresholdOverrides: args.regimeThresholds,
      cooldownBars: args.cooldownBars,
      ...(Object.keys(args.weights).length > 0 ? {
        weights: { ...DEFAULT_WEIGHTS, ...args.weights },
      } : {}),
    };
    this.scorer = new ConfluenceScorer(scorerConfig);

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
      symbol,
      timeframe: '1h',
      modelPath: 'confluence-scorer',
      initialCapital: args.capital,
      positionSize: 0.1,
      maxHoldBars: args.maxBars,
      slPercent: 0.02,
      tpPercent: 0.04,
      spread: 0.0001,
      slippage: 0.0005,
      commission: 0.001,
      kbEnabled: false,
      kbFeatures: false,
      kbRewards: false,
      persistTrades: true,
      logLevel: args.verbose ? 'debug' : 'info',
      consoleOutput: true,
    };

    this.tradeLogger = new TradeLogger(
      this.sessionId,
      symbol,
      '1h',
      'confluence-scorer',
      paperConfig,
      this.repo,
    );
  }

  getSymbol(): string { return this.symbol; }
  getSessionId(): string { return this.sessionId; }
  getMetrics() { return this.perfMonitor.getMetrics(); }
  isShuttingDown(): boolean { return this.shuttingDown; }

  // ------------------------------------------
  // Live Mode (called by multi-symbol orchestrator)
  // ------------------------------------------

  async initLive(): Promise<{ candleManager: CandleManager; ws: BinanceWebSocket }> {
    await this.tradeLogger.initSession();

    const candleManager = new CandleManager({
      symbol: this.symbol,
      timeframe: '1h',
      maxCandles: 2000,
      historyDays: 30,
    });
    await candleManager.initialize();
    console.log(`  [${this.symbol}] Candle buffer: ${candleManager.size()} candles loaded`);

    const ws = new BinanceWebSocket({ symbol: this.symbol, timeframe: '1h' });

    ws.on('candleClosed', (liveCandle: LiveCandle) => {
      const { isNew } = candleManager.handleLiveCandle(liveCandle);
      if (isNew) {
        const candles = candleManager.getCandles();
        const currentIndex = candleManager.getCurrentIndex();
        this.onCandleClosed(candles, currentIndex);
      }
    });

    ws.on('error', (error: Error) => {
      console.error(`  [${this.symbol}] WS Error: ${error.message}`);
    });

    ws.on('reconnecting', (attempt: number) => {
      console.log(`  [${this.symbol}] WS Reconnecting... attempt ${attempt}`);
    });

    await ws.connect();
    console.log(`  [${this.symbol}] Connected to Binance WebSocket`);

    return { candleManager, ws };
  }

  // ------------------------------------------
  // Backtest Mode
  // ------------------------------------------

  async runBacktest(numBars: number): Promise<void> {
    const dataPath = path.join(process.cwd(), `data/${this.symbol}_1h.json`);
    if (!fs.existsSync(dataPath)) {
      console.error(`  [${this.symbol}] Data file not found: ${dataPath}`);
      console.error('    Run: npx tsx scripts/fetch-historical-data.ts first');
      return;
    }

    const allCandles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    console.log(`  [${this.symbol}] Loaded ${allCandles.length} candles`);

    const warmup = 200;
    const startIndex = Math.max(0, allCandles.length - numBars - warmup);
    const candles = allCandles.slice(startIndex);
    const evalStart = candles.length - numBars;

    console.log(`  [${this.symbol}] Evaluating bars ${evalStart}-${candles.length - 1} (${numBars} bars, ${evalStart} warmup)`);

    await this.tradeLogger.initSession();

    for (let i = evalStart; i < candles.length; i++) {
      this.onCandleClosed(candles, i);
    }

    // Close any open position at the end
    if (this.position) {
      const lastCandle = candles[candles.length - 1]!;
      this.closePosition(lastCandle.close, lastCandle.timestamp, candles.length - 1, 'shutdown');
    }

    const metrics = this.perfMonitor.getMetrics();
    await this.tradeLogger.endSession({
      totalPnl: metrics.totalPnl,
      maxDrawdown: metrics.maxDrawdownPercent,
      sharpe: metrics.sharpe,
    });
  }

  // ------------------------------------------
  // Simulation Mode
  // ------------------------------------------

  async runSimulation(startDate: string | null, endDate: string | null, speed: number): Promise<void> {
    const dataPath = path.join(process.cwd(), `data/${this.symbol}_1h.json`);
    if (!fs.existsSync(dataPath)) {
      console.error(`  [${this.symbol}] Data file not found: ${dataPath}`);
      console.error('    Run: npx tsx scripts/fetch-historical-data.ts first');
      return;
    }

    const allCandles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    console.log(`  [${this.symbol}] Loaded ${allCandles.length} candles`);

    // Parse date boundaries
    const startTs = startDate ? new Date(startDate).getTime() : null;
    const endTs = endDate ? new Date(endDate).getTime() : null;

    // Find eval start index (first candle >= startDate)
    let evalStartCandle = 0;
    if (startTs) {
      evalStartCandle = allCandles.findIndex((c) => c.timestamp >= startTs);
      if (evalStartCandle === -1) {
        console.error(`  [${this.symbol}] No candles found after ${startDate}`);
        return;
      }
    }

    // Find eval end index (last candle <= endDate)
    let evalEndCandle = allCandles.length - 1;
    if (endTs) {
      const idx = allCandles.findIndex((c) => c.timestamp > endTs);
      evalEndCandle = idx === -1 ? allCandles.length - 1 : idx - 1;
    }

    // Include 200-bar warmup before eval start
    const warmup = 200;
    const sliceStart = Math.max(0, evalStartCandle - warmup);
    const candles = allCandles.slice(sliceStart, evalEndCandle + 1);
    const evalStart = evalStartCandle - sliceStart;
    const totalEvalBars = candles.length - evalStart;

    const startStr = new Date(candles[evalStart]!.timestamp).toISOString().slice(0, 10);
    const endStr = new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10);
    console.log(`  [${this.symbol}] Simulating ${totalEvalBars} bars (${startStr} to ${endStr}), ${evalStart} warmup`);

    // Override session ID with sim- prefix
    this.sessionId = `sim-${this.symbol}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await this.tradeLogger.initSession();

    for (let i = evalStart; i < candles.length; i++) {
      this.onCandleClosed(candles, i);

      // Progress logging every 500 bars
      const barsDone = i - evalStart + 1;
      if (barsDone % 500 === 0 || i === candles.length - 1) {
        const pct = ((barsDone / totalEvalBars) * 100).toFixed(0);
        const m = this.perfMonitor.getMetrics();
        console.log(`  [SIM] ${this.symbol} bar ${barsDone}/${totalEvalBars} (${pct}%) — ${m.closedTrades} trades`);
      }

      // Pacing
      if (speed > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000 / speed));
      }
    }

    // Close any open position at the end
    if (this.position) {
      const lastCandle = candles[candles.length - 1]!;
      this.closePosition(lastCandle.close, lastCandle.timestamp, candles.length - 1, 'shutdown');
    }

    const metrics = this.perfMonitor.getMetrics();
    await this.tradeLogger.endSession({
      totalPnl: metrics.totalPnl,
      maxDrawdown: metrics.maxDrawdownPercent,
      sharpe: metrics.sharpe,
    });
  }

  /** Force close open position and finalize session (for shutdown) */
  async shutdown(lastPrice?: number, lastTimestamp?: number, lastIndex?: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.position && lastPrice !== undefined && lastTimestamp !== undefined && lastIndex !== undefined) {
      this.closePosition(lastPrice, lastTimestamp, lastIndex, 'shutdown');
    }

    const metrics = this.perfMonitor.getMetrics();
    await this.tradeLogger.endSession({
      totalPnl: metrics.totalPnl,
      maxDrawdown: metrics.maxDrawdownPercent,
      sharpe: metrics.sharpe,
    });
  }

  hasPosition(): boolean { return this.position !== null; }

  // ------------------------------------------
  // Per-Bar Logic
  // ------------------------------------------

  private onCandleClosed(candles: Candle[], currentIndex: number): void {
    this.candleCount++;
    this.riskManager.onBar();

    const currentCandle = candles[currentIndex];
    if (!currentCandle) return;

    // If we have an open position, check for exit
    if (this.position) {
      const exited = this.checkPositionExit(currentCandle, currentIndex);
      if (exited) return;
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
    if (!this.noRiskManager) {
      const riskCheck = this.riskManager.checkRisk();
      if (!riskCheck.allowed) {
        if (this.verbose) {
          console.log(`  [${this.symbol}] [Risk] Blocked: ${riskCheck.reason}`);
        }
        return;
      }
    }

    const result = this.scorer.evaluate(candles, currentIndex);
    this.totalSignals += result.allScored.length;

    if (result.action === 'wait') {
      if (this.verbose && result.allScored.length > 0) {
        console.log(`  [${this.symbol}] [Scorer] Wait — ${result.reasoning[result.reasoning.length - 1]}`);
      }
      return;
    }

    const scored = result.selectedSignal!;
    const signal = scored.signal;
    const candle = candles[currentIndex]!;

    // Position sizing
    const equity = this.perfMonitor.getCurrentEquity();
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const sizerStats = this.positionSizer.getTrackedStats();

    const sizeResult = this.positionSizer.calculate({
      equity,
      atr: stopDistance,
      price: signal.entryPrice,
      winRate: sizerStats.winRate,
      avgRiskReward: sizerStats.avgRiskReward,
      currentDrawdown: this.riskManager.getState().currentDrawdown,
      confidence: signal.confidence,
      stopLossDistance: stopDistance,
    });

    // Apply entry friction
    const adjustedEntry = applyEntryFriction(signal.entryPrice, signal.direction, this.friction);

    // Calculate risk distance for R tracking
    const riskDistance = signal.direction === 'long'
      ? signal.entryPrice - signal.stopLoss
      : signal.stopLoss - signal.entryPrice;

    // Open position
    const tradeId = `${this.sessionId}-${++this.tradeCounter}`;
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
      // Partial TP state
      partialTaken: false,
      partialPnl: 0,
      originalSL: signal.stopLoss,
      riskDistance,
    };

    this.riskManager.onTradeOpened();

    const factorStr = Object.entries(scored.factorBreakdown)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v.toFixed(1)}`)
      .join(', ');

    console.log(`\n  >>> [${this.symbol}] ENTRY: ${signal.direction.toUpperCase()}`);
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
  // Exit Logic (Simple SL/TP + Partial TP)
  // ------------------------------------------

  private checkPositionExit(candle: Candle, currentIndex: number): boolean {
    if (!this.position) return false;

    this.position.barsHeld = currentIndex - this.position.entryIndex;

    // Check SL hit (uses current SL, which may have been moved to BE)
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

    // Partial TP: close fraction at triggerR, move SL to breakeven
    if (this.partialTp && !this.position.partialTaken && this.position.riskDistance > 0) {
      const unrealizedR = this.position.side === 'long'
        ? (candle.close - this.position.rawEntryPrice) / this.position.riskDistance
        : (this.position.rawEntryPrice - candle.close) / this.position.riskDistance;

      if (unrealizedR >= this.partialTp.triggerR) {
        this.position.partialTaken = true;
        const partialExit = applyExitFriction(candle.close, this.position.side, this.friction);
        const adjustedEntry = this.position.entryPrice;

        // Calculate partial PnL%
        if (this.position.side === 'long') {
          this.position.partialPnl = (partialExit - adjustedEntry) / adjustedEntry;
        } else {
          this.position.partialPnl = (adjustedEntry - partialExit) / adjustedEntry;
        }

        // Move SL to breakeven + buffer (use friction-adjusted entry so BE stop covers actual fill)
        if (this.partialTp.beBuffer >= 0) {
          const buffer = this.position.riskDistance * this.partialTp.beBuffer;
          if (this.position.side === 'long') {
            this.position.stopLoss = Math.max(this.position.stopLoss, this.position.entryPrice + buffer);
          } else {
            this.position.stopLoss = Math.min(this.position.stopLoss, this.position.entryPrice - buffer);
          }
        }

        if (this.verbose) {
          console.log(`  [${this.symbol}] PARTIAL TP: ${(this.partialTp.fraction * 100).toFixed(0)}% closed at ${candle.close.toFixed(2)} (${unrealizedR.toFixed(2)}R)`);
          console.log(`      Locked PnL: ${(this.position.partialPnl * 100).toFixed(2)}% | New SL: ${this.position.stopLoss.toFixed(2)}`);
        }
      }
    }

    // Max bars
    if (this.position.barsHeld >= this.maxBars) {
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
    const adjustedExit = applyExitFriction(rawExitPrice, pos.side, this.friction);

    // Calculate exit PnL%
    let exitPnl: number;
    if (pos.side === 'long') {
      exitPnl = (adjustedExit - pos.entryPrice) / pos.entryPrice;
    } else {
      exitPnl = (pos.entryPrice - adjustedExit) / pos.entryPrice;
    }

    // Blend with partial TP if taken
    let pnl: number;
    if (pos.partialTaken && this.partialTp) {
      pnl = this.partialTp.fraction * pos.partialPnl + (1 - this.partialTp.fraction) * exitPnl;
    } else {
      pnl = exitPnl;
    }

    const pnlDollar = pnl * pos.size;
    const barsHeld = exitIndex - pos.entryIndex;

    const pnlSign = pnlDollar >= 0 ? '+' : '';
    const emoji = pnlDollar >= 0 ? 'WIN' : 'LOSS';
    const partialNote = pos.partialTaken ? ' (partial TP taken)' : '';
    console.log(`\n  <<< [${this.symbol}] EXIT: ${reason.toUpperCase()} — ${emoji}${partialNote}`);
    console.log(`      Price: ${rawExitPrice.toFixed(2)} (adj: ${adjustedExit.toFixed(2)})`);
    console.log(`      PnL: ${pnlSign}$${pnlDollar.toFixed(2)} (${pnlSign}${(pnl * 100).toFixed(2)}%) | Bars: ${barsHeld}`);

    const paperTrade: PaperTrade = {
      id: pos.tradeId,
      sessionId: this.sessionId,
      symbol: this.symbol,
      timeframe: '1h',
      side: pos.side,
      status: 'closed',
      entryPrice: pos.entryPrice,
      exitPrice: adjustedExit,
      stopLoss: pos.originalSL,
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

    this.perfMonitor.recordTrade(paperTrade);
    this.riskManager.onTradeClosed(pnlDollar);
    this.positionSizer.recordTrade(pnlDollar > 0, pnl * 100);
    this.tradeLogger.logExit(paperTrade);

    const metrics = this.perfMonitor.getMetrics();
    this.tradeLogger.updateSessionMetrics(metrics.maxDrawdownPercent, metrics.sharpe);

    this.position = null;
  }

  // ------------------------------------------
  // Display
  // ------------------------------------------

  private printRollingMetrics(): void {
    const metrics = this.perfMonitor.getMetrics();

    if (metrics.closedTrades === 0) {
      if (this.verbose) {
        console.log(`  [${this.symbol}] [Bar ${this.candleCount}] No trades yet | Signals: ${this.totalSignals}`);
      }
      return;
    }

    const pnlSign = metrics.totalPnl >= 0 ? '+' : '';
    const risk = this.riskManager.getRiskSummary();

    console.log(
      `  [${this.symbol}] [Bar ${this.candleCount}] ` +
      `Trades: ${metrics.closedTrades} | ` +
      `WR: ${metrics.winRate.toFixed(1)}% | ` +
      `PnL: ${pnlSign}$${metrics.totalPnl.toFixed(2)} | ` +
      `DD: ${metrics.maxDrawdownPercent.toFixed(1)}% | ` +
      `Sharpe: ${metrics.sharpe.toFixed(2)} | ` +
      `Risk: ${risk.riskLevel}`,
    );
  }

  printSymbolSummary(): string {
    const m = this.perfMonitor.getMetrics();
    const pnlSign = m.totalPnl >= 0 ? '+' : '';
    return `  ${this.symbol}: ${m.closedTrades} trades | WR ${m.winRate.toFixed(1)}% | PnL ${pnlSign}$${m.totalPnl.toFixed(2)} | Sharpe ${m.sharpe.toFixed(2)} | DD ${m.maxDrawdownPercent.toFixed(1)}%`;
  }
}

// ============================================
// Header Display
// ============================================

function printHeader(args: CLIArgs, mode: 'LIVE' | 'BACKTEST' | 'SIMULATE', backtestBars?: number): void {
  const regimeStr = Object.entries(args.regimeThresholds)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');

  console.log('='.repeat(72));
  console.log(`CONFLUENCE PAPER TRADER — ${mode} MODE (Production Config)`);
  console.log('='.repeat(72));
  console.log(`  Symbols:    ${args.symbols.join(', ')}`);
  console.log(`  Threshold:  ${args.threshold}`);
  console.log(`  Capital:    $${args.capital.toLocaleString()}`);
  console.log(`  Strategy:   OB-only + reaction confirmation`);
  console.log(`  SL mode:    ${args.slMode}`);
  console.log(`  Suppress:   ${args.suppressRegime.length > 0 ? args.suppressRegime.join(', ') : 'none'}`);
  console.log(`  Friction:   ${(args.friction * 100).toFixed(3)}% per side`);
  console.log(`  Partial TP: ${args.partialTp ? `${(args.partialTp.fraction * 100).toFixed(0)}% @ ${args.partialTp.triggerR}R (BE buffer: ${args.partialTp.beBuffer})` : 'disabled'}`);
  console.log(`  ATR ext:    ${args.atrExtension > 0 ? `${args.atrExtension} bands` : 'disabled'}`);
  console.log(`  OB half-life: ${args.obHalfLife > 0 ? `${args.obHalfLife} bars` : 'legacy 3-tier'}`);
  console.log(`  Regime thresholds: ${regimeStr || 'none (use base threshold)'}`);
  console.log(`  Max hold:   ${args.maxBars} bars`);
  console.log(`  Cooldown:   ${args.cooldownBars} bars between signals`);
  if (args.noRiskManager) {
    console.log(`  Risk mgmt:  DISABLED (--no-risk-manager)`);
  }

  const weightOverrides = Object.entries(args.weights);
  if (weightOverrides.length > 0) {
    const weightStr = weightOverrides.map(([k, v]) => `${k}:${v.toFixed(3)}`).join(', ');
    console.log(`  Weights:    ${weightStr}`);
  } else {
    console.log(`  Weights:    default`);
  }

  console.log(`  Exits:      Simple SL/TP + ${args.maxBars}-bar max hold${args.partialTp ? ' + partial TP' : ''}`);
  if (mode === 'BACKTEST' && backtestBars) {
    console.log(`  Bars:       ${backtestBars}`);
  }
  console.log('='.repeat(72));
}

// ============================================
// Combined Summary
// ============================================

function printCombinedSummary(traders: ConfluencePaperTrader[]): void {
  console.log('\n' + '='.repeat(72));
  console.log('SESSION SUMMARY');
  console.log('='.repeat(72));

  if (traders.length > 1) {
    console.log('\n=== PER-SYMBOL ===');
    for (const trader of traders) {
      console.log(trader.printSymbolSummary());
    }
  }

  // Aggregate metrics
  let totalTrades = 0;
  let totalWins = 0;
  let totalPnl = 0;
  let maxDD = 0;
  const sharpes: number[] = [];

  for (const trader of traders) {
    const m = trader.getMetrics();
    totalTrades += m.closedTrades;
    totalWins += m.wins;
    totalPnl += m.totalPnl;
    maxDD = Math.max(maxDD, m.maxDrawdownPercent);
    if (m.closedTrades > 0) {
      sharpes.push(m.sharpe);
    }
  }

  const avgSharpe = sharpes.length > 0 ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length : 0;
  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const pnlSign = totalPnl >= 0 ? '+' : '';

  if (traders.length > 1) {
    console.log('\n=== COMBINED ===');
  }
  console.log(`  Total trades: ${totalTrades}`);
  console.log(`  Win rate:     ${winRate.toFixed(1)}%`);
  console.log(`  Total PnL:    ${pnlSign}$${totalPnl.toFixed(2)}`);
  console.log(`  Max DD:       ${maxDD.toFixed(1)}%`);
  console.log(`  Avg Sharpe:   ${avgSharpe.toFixed(2)}`);
  console.log('='.repeat(72));
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const args = parseArgs();
  const repo = await createRepository();

  if (args.simulate) {
    // ---- SIMULATION MODE ----
    printHeader(args, 'SIMULATE');
    const dateRange = [
      args.startDate ? `from ${args.startDate}` : 'all data',
      args.endDate ? `to ${args.endDate}` : '',
    ].filter(Boolean).join(' ');
    console.log(`  Date range: ${dateRange}`);
    console.log(`  Speed:      ${args.speed > 0 ? `${args.speed} candle/sec` : 'max'}`);
    console.log('='.repeat(72));

    const traders: ConfluencePaperTrader[] = [];

    for (const symbol of args.symbols) {
      console.log(`\n--- ${symbol} ---`);
      const trader = new ConfluencePaperTrader(args, symbol, repo);
      await trader.runSimulation(args.startDate, args.endDate, args.speed);
      traders.push(trader);
    }

    printCombinedSummary(traders);
    await repo.close();
  } else if (args.backtest !== null) {
    // ---- BACKTEST MODE ----
    printHeader(args, 'BACKTEST', args.backtest);

    const traders: ConfluencePaperTrader[] = [];

    for (const symbol of args.symbols) {
      console.log(`\n--- ${symbol} ---`);
      const trader = new ConfluencePaperTrader(args, symbol, repo);
      await trader.runBacktest(args.backtest);
      traders.push(trader);
    }

    printCombinedSummary(traders);
    await repo.close();
  } else {
    // ---- LIVE MODE ----
    printHeader(args, 'LIVE');

    const traders: ConfluencePaperTrader[] = [];
    const wsConnections: BinanceWebSocket[] = [];
    const candleManagers: CandleManager[] = [];

    // Initialize all symbols concurrently
    console.log('\n[Init] Connecting to symbols...');
    const initPromises = args.symbols.map(async (symbol) => {
      const trader = new ConfluencePaperTrader(args, symbol, repo);
      const { candleManager, ws } = await trader.initLive();
      return { trader, candleManager, ws };
    });

    const results = await Promise.all(initPromises);
    for (const { trader, candleManager, ws } of results) {
      traders.push(trader);
      candleManagers.push(candleManager);
      wsConnections.push(ws);
    }

    console.log(`\n[Live] ${args.symbols.length} WebSocket(s) connected. Waiting for candles...\n`);

    // Graceful shutdown handler
    const shutdown = async () => {
      console.log('\n[Shutdown] Graceful shutdown initiated...');

      // Close all open positions
      for (let i = 0; i < traders.length; i++) {
        const trader = traders[i]!;
        const cm = candleManagers[i]!;
        if (trader.hasPosition()) {
          const lastCandle = cm.getLatestCandle();
          if (lastCandle) {
            await trader.shutdown(lastCandle.close, lastCandle.timestamp, cm.getCurrentIndex());
          } else {
            await trader.shutdown();
          }
        } else {
          await trader.shutdown();
        }
      }

      printCombinedSummary(traders);

      // Disconnect all WebSockets
      for (const ws of wsConnections) {
        ws.disconnect();
      }

      await repo.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
