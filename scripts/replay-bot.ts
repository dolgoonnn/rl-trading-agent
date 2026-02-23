#!/usr/bin/env npx tsx
/**
 * Replay Bot — Fast-Forward Paper Trading with Historical Data
 *
 * Feeds prefetched 1H candles through the exact same bot pipeline
 * (SignalEngine, OrderManager, PositionTracker, RiskEngine) at
 * accelerated speed. Validates that the full bot stack produces
 * trades consistent with backtesting, and generates trade records
 * in the bot DB tables.
 *
 * Usage:
 *   npx tsx scripts/replay-bot.ts                          # Default (BTC/ETH/SOL), max speed
 *   npx tsx scripts/replay-bot.ts --symbols BTCUSDT,ETHUSDT  # Custom symbols
 *   npx tsx scripts/replay-bot.ts --delay 1000             # 1 candle per second
 *   npx tsx scripts/replay-bot.ts --delay 0 --verbose      # Max speed + logs
 *   npx tsx scripts/replay-bot.ts --start-date 2024-06-01  # Start from a date
 *   npx tsx scripts/replay-bot.ts --fresh                  # Reset bot DB tables first
 *   npx tsx scripts/replay-bot.ts --compare                # Compare bot vs backtest sim bar-by-bar
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '../src/types/candle';
import type { BotSymbol } from '../src/types/bot';
import {
  SignalEngine,
  OrderManager,
  PositionTracker,
  RiskEngine,
  RUN18_STRATEGY_CONFIG,
  DEFAULT_CIRCUIT_BREAKERS,
} from '../src/lib/bot';
import { db } from '../src/lib/data/db';
import { botState, botPositions, botTrades, botEquitySnapshots, botCandles } from '../src/lib/data/schema';

// ============================================
// Data Loading
// ============================================

/** Map bot symbol to candle data file path */
function getDataFilePath(symbol: BotSymbol): string {
  return path.join(process.cwd(), 'data', `${symbol}_1h.json`);
}

function loadCandles(symbol: BotSymbol): Candle[] {
  const filePath = getDataFilePath(symbol);
  if (!fs.existsSync(filePath)) {
    console.error(`Data file not found: ${filePath}`);
    process.exit(1);
  }
  const raw: Candle[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  // Ensure chronological order
  raw.sort((a, b) => a.timestamp - b.timestamp);
  return raw;
}

// ============================================
// CLI Parsing
// ============================================

interface ReplayConfig {
  symbols: BotSymbol[];
  delayMs: number;
  capital: number;
  riskPerTrade: number;
  verbose: boolean;
  startDate: number | null; // epoch ms
  fresh: boolean;
  compare: boolean; // Run backtest sim in parallel and compare divergences
}

function parseArgs(): ReplayConfig {
  const args = process.argv.slice(2);
  const config: ReplayConfig = {
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    delayMs: 0,        // Max speed by default
    capital: 10000,
    riskPerTrade: 0.003,
    verbose: false,
    startDate: null,
    fresh: false,
    compare: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--delay':
        config.delayMs = parseInt(args[++i]!, 10);
        break;
      case '--capital':
        config.capital = parseFloat(args[++i]!);
        break;
      case '--risk':
        config.riskPerTrade = parseFloat(args[++i]!);
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--start-date':
        config.startDate = new Date(args[++i]!).getTime();
        break;
      case '--symbols': {
        config.symbols = args[++i]!.split(',') as BotSymbol[];
        break;
      }
      case '--fresh':
        config.fresh = true;
        break;
      case '--compare':
        config.compare = true;
        break;
    }
  }

  return config;
}

// ============================================
// DB Cleanup
// ============================================

function resetBotTables(): void {
  db.delete(botTrades).run();
  db.delete(botPositions).run();
  db.delete(botEquitySnapshots).run();
  db.delete(botCandles).run();
  db.delete(botState).run();
  console.log('Cleared all bot DB tables.');
}

// ============================================
// Replay Engine
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================
// Backtest Simulation (for --compare mode)
// ============================================

/** Mirrors backtest-confluence.ts friction functions exactly */
function btApplyEntryFriction(price: number, direction: 'long' | 'short'): number {
  const friction = RUN18_STRATEGY_CONFIG.frictionPerSide;
  return direction === 'long' ? price * (1 + friction) : price * (1 - friction);
}

function btApplyExitFriction(price: number, direction: 'long' | 'short'): number {
  const friction = RUN18_STRATEGY_CONFIG.frictionPerSide;
  return direction === 'long' ? price * (1 - friction) : price * (1 + friction);
}

function btCalcPnl(adjustedEntry: number, adjustedExit: number, direction: 'long' | 'short'): number {
  return direction === 'long'
    ? (adjustedExit - adjustedEntry) / adjustedEntry
    : (adjustedEntry - adjustedExit) / adjustedEntry;
}

interface BacktestTradeResult {
  exitBarIndex: number;
  exitReason: string;
  pnlPercent: number;
  partialTriggerBar: number | null;
}

/**
 * Run the backtest's simulatePositionPartialTP logic inline.
 * Uses position.entryPrice (raw signal price) for riskDistance/unrealizedR,
 * and adjustedEntry for PnL and BE buffer — exactly matching the backtest.
 */
function simulateBacktestPartialTP(
  rawEntry: number,
  stopLoss: number,
  takeProfit: number,
  direction: 'long' | 'short',
  entryIndex: number,
  candles: Candle[],
  maxBars: number,
): BacktestTradeResult {
  const adjustedEntry = btApplyEntryFriction(rawEntry, direction);
  let currentSL = stopLoss;
  const partialConfig = RUN18_STRATEGY_CONFIG.partialTP;

  const riskDistance = direction === 'long'
    ? rawEntry - stopLoss
    : stopLoss - rawEntry;
  let partialTaken = false;
  let partialPnl = 0;
  let partialTriggerBar: number | null = null;

  for (let i = entryIndex + 1; i < candles.length; i++) {
    const candle = candles[i]!;
    const barsHeld = i - entryIndex;

    // Check SL
    if (direction === 'long' && candle.low <= currentSL) {
      const adjustedExit = btApplyExitFriction(currentSL, direction);
      const exitPnl = btCalcPnl(adjustedEntry, adjustedExit, direction);
      const finalPnl = partialTaken
        ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
        : exitPnl;
      return { exitBarIndex: i, exitReason: 'stop_loss', pnlPercent: finalPnl, partialTriggerBar };
    }
    if (direction === 'short' && candle.high >= currentSL) {
      const adjustedExit = btApplyExitFriction(currentSL, direction);
      const exitPnl = btCalcPnl(adjustedEntry, adjustedExit, direction);
      const finalPnl = partialTaken
        ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
        : exitPnl;
      return { exitBarIndex: i, exitReason: 'stop_loss', pnlPercent: finalPnl, partialTriggerBar };
    }

    // Check TP
    if (direction === 'long' && candle.high >= takeProfit) {
      const adjustedExit = btApplyExitFriction(takeProfit, direction);
      const exitPnl = btCalcPnl(adjustedEntry, adjustedExit, direction);
      const finalPnl = partialTaken
        ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
        : exitPnl;
      return { exitBarIndex: i, exitReason: 'take_profit', pnlPercent: finalPnl, partialTriggerBar };
    }
    if (direction === 'short' && candle.low <= takeProfit) {
      const adjustedExit = btApplyExitFriction(takeProfit, direction);
      const exitPnl = btCalcPnl(adjustedEntry, adjustedExit, direction);
      const finalPnl = partialTaken
        ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
        : exitPnl;
      return { exitBarIndex: i, exitReason: 'take_profit', pnlPercent: finalPnl, partialTriggerBar };
    }

    // Partial TP check
    if (!partialTaken && riskDistance > 0) {
      const unrealizedR = direction === 'long'
        ? (candle.close - rawEntry) / riskDistance
        : (rawEntry - candle.close) / riskDistance;

      if (unrealizedR >= partialConfig.triggerR) {
        partialTaken = true;
        partialTriggerBar = i;
        const partialExit = btApplyExitFriction(candle.close, direction);
        partialPnl = btCalcPnl(adjustedEntry, partialExit, direction);

        if (partialConfig.beBuffer >= 0) {
          const buffer = riskDistance * partialConfig.beBuffer;
          if (direction === 'long') {
            currentSL = Math.max(currentSL, adjustedEntry + buffer);
          } else {
            currentSL = Math.min(currentSL, adjustedEntry - buffer);
          }
        }
      }
    }

    // Max bars
    if (barsHeld >= maxBars) {
      const adjustedExit = btApplyExitFriction(candle.close, direction);
      const exitPnl = btCalcPnl(adjustedEntry, adjustedExit, direction);
      const finalPnl = partialTaken
        ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
        : exitPnl;
      return { exitBarIndex: i, exitReason: 'max_bars', pnlPercent: finalPnl, partialTriggerBar };
    }
  }

  // End of data — close at last candle
  const lastIdx = candles.length - 1;
  const lastCandle = candles[lastIdx]!;
  const adjustedExit = btApplyExitFriction(lastCandle.close, direction);
  const exitPnl = btCalcPnl(adjustedEntry, adjustedExit, direction);
  const finalPnl = partialTaken
    ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
    : exitPnl;
  return { exitBarIndex: lastIdx, exitReason: 'end_of_data', pnlPercent: finalPnl, partialTriggerBar };
}

/** A single divergence record between bot and backtest */
interface Divergence {
  tradeNum: number;
  symbol: string;
  entryBar: number;
  field: string;
  botValue: string;
  backtestValue: string;
}

interface ReplayStats {
  symbol: string;
  totalCandles: number;
  processedCandles: number;
  trades: number;
  wins: number;
  losses: number;
  pnlPercent: number;
  pnlUSDT: number;
  maxDrawdownPercent: number;
}

async function runReplay(config: ReplayConfig): Promise<void> {
  // Initialize bot components
  const signalEngine = new SignalEngine(RUN18_STRATEGY_CONFIG);
  const orderManager = new OrderManager('paper', RUN18_STRATEGY_CONFIG);
  const tracker = new PositionTracker(config.capital);
  // Circuit breakers are DISABLED in replay mode. They use Date.now() for
  // time-based expiry which is wall-clock time — in fast-forward mode, a
  // 48-hour consecutive-loss breaker would never expire (the replay finishes
  // in seconds). The backtest also has no circuit breakers, so disabling
  // them here ensures replay ↔ backtest parity.
  const riskEngine = new RiskEngine({
    circuitBreakers: { dailyLossLimit: 1, weeklyLossLimit: 1, maxDrawdown: 1, maxConsecutiveLosses: 999, maxSystemErrorsPerHour: 999 },
    drawdownTiers: [{ maxDrawdown: Infinity, sizeMultiplier: 1.0, label: 'disabled' }],
    maxPositions: config.symbols.length,
    regimeSizeMultipliers: {},
  });
  // AlertManager omitted in replay — all output goes to console directly

  // Load all candle data upfront
  const symbolData = new Map<BotSymbol, Candle[]>();
  console.log('\nLoading candle data...');
  for (const symbol of config.symbols) {
    const candles = loadCandles(symbol);
    symbolData.set(symbol, candles);
    console.log(`  ${symbol}: ${candles.length} candles (${new Date(candles[0]!.timestamp).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10)})`);
  }

  // Merge all timestamps and sort chronologically
  // Each entry: { timestamp, symbol, candleIndex }
  interface CandleEvent {
    timestamp: number;
    symbol: BotSymbol;
    candleIndex: number;
  }

  const events: CandleEvent[] = [];
  for (const [symbol, candles] of symbolData) {
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i]!;
      // Skip candles before start date (but keep lookback window)
      if (config.startDate && candle.timestamp < config.startDate && i > 200) {
        continue;
      }
      events.push({ timestamp: candle.timestamp, symbol, candleIndex: i });
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp || a.symbol.localeCompare(b.symbol));

  // Find the minimum lookback index per symbol (need 200 bars for ICT analysis)
  const MIN_LOOKBACK = 200;
  const symbolStartIndex = new Map<BotSymbol, number>();
  for (const [symbol, candles] of symbolData) {
    if (config.startDate) {
      // Find first candle at or after start date
      const idx = candles.findIndex((c) => c.timestamp >= config.startDate!);
      symbolStartIndex.set(symbol, Math.max(idx, MIN_LOOKBACK));
    } else {
      symbolStartIndex.set(symbol, MIN_LOOKBACK);
    }
  }

  // Track per-symbol stats
  const stats = new Map<BotSymbol, ReplayStats>();
  for (const symbol of config.symbols) {
    stats.set(symbol, {
      symbol,
      totalCandles: symbolData.get(symbol)!.length,
      processedCandles: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      pnlPercent: 0,
      pnlUSDT: 0,
      maxDrawdownPercent: 0,
    });
  }

  // Filter events to only those past the lookback window
  const processableEvents = events.filter((e) => {
    const startIdx = symbolStartIndex.get(e.symbol) ?? MIN_LOOKBACK;
    return e.candleIndex >= startIdx;
  });

  const totalEvents = processableEvents.length;
  let processedEvents = 0;
  let lastProgressPercent = -1;
  const startTime = Date.now();

  console.log(`\nReplaying ${totalEvents} candle events across ${config.symbols.length} symbols...`);
  if (config.delayMs > 0) {
    console.log(`  Speed: 1 candle every ${config.delayMs}ms`);
  } else {
    console.log('  Speed: MAX (no delay)');
  }
  if (config.compare) {
    console.log('  Mode: COMPARE (bot vs backtest simulation)');
  }
  console.log('');

  // --compare tracking
  const pendingBTResults = new Map<string, BacktestTradeResult>(); // positionId → expected result
  const pendingBTMeta = new Map<string, { symbol: string; entryBar: number; direction: string }>(); // positionId → metadata
  const divergences: Divergence[] = [];
  let tradeNum = 0;
  // Track bot partial TP bar per position
  const botPartialTriggerBars = new Map<string, number>(); // positionId → bar index

  // Main replay loop
  for (const event of processableEvents) {
    const { symbol, candleIndex } = event;
    const candles = symbolData.get(symbol)!;
    const candle = candles[candleIndex]!;

    // Pass the FULL candle array with an explicit currentIndex.
    // The scorer internally takes a 100-bar lookback for ICT analysis and
    // 500-bar lookback for regime detection — same as the backtest.
    // Using the full array with monotonic candleIndex ensures cooldown
    // tracking works correctly (cooldownBars comparison needs monotonic indices).
    const barIndex = candleIndex;

    // 1. Manage open positions first
    const openPos = tracker.getOpenPositions().find((p) => p.symbol === symbol);
    if (openPos) {
      const wasPT = openPos.partialTaken;
      const exitResult = orderManager.checkPositionExit(openPos, candle, barIndex);

      if (!wasPT && openPos.partialTaken) {
        tracker.updatePosition(openPos);
        // Track partial TP bar for comparison
        if (config.compare) {
          botPartialTriggerBars.set(openPos.id, barIndex);
        }
        if (config.verbose) {
          console.log(`  ${symbol}: Partial TP taken, SL → $${openPos.currentSL.toFixed(2)}`);
        }
      }

      if (exitResult) {
        const closedPos = exitResult.position;
        tracker.closePosition(closedPos);

        const stat = stats.get(symbol)!;
        stat.trades++;
        const pnl = closedPos.pnlPercent ?? 0;
        const pnlUSDT = closedPos.pnlUSDT ?? 0;
        stat.pnlPercent += pnl;
        stat.pnlUSDT += pnlUSDT;
        if (pnl > 0) stat.wins++;
        else stat.losses++;

        // Track max drawdown
        const dd = ((tracker.getPeakEquity() - tracker.getEquity()) / tracker.getPeakEquity()) * 100;
        if (dd > stat.maxDrawdownPercent) stat.maxDrawdownPercent = dd;

        const pnlStr = pnlUSDT >= 0 ? '+' : '';
        if (config.verbose) {
          console.log(`  ${closedPos.symbol}: CLOSED ${closedPos.direction.toUpperCase()} — ${closedPos.exitReason} — PnL: ${pnlStr}$${pnlUSDT.toFixed(2)} (${pnlStr}${(pnl * 100).toFixed(2)}%) [${new Date(candle.timestamp).toISOString().slice(0, 16)}]`);
        }

        // --compare: check against backtest result
        if (config.compare && pendingBTResults.has(closedPos.id)) {
          tradeNum++;
          const bt = pendingBTResults.get(closedPos.id)!;
          const meta = pendingBTMeta.get(closedPos.id)!;
          const botPTBar = botPartialTriggerBars.get(closedPos.id) ?? null;

          // Compare exit bar
          const botExitBar = barIndex;
          if (botExitBar !== bt.exitBarIndex) {
            divergences.push({
              tradeNum, symbol: meta.symbol, entryBar: meta.entryBar,
              field: 'exitBar',
              botValue: String(botExitBar),
              backtestValue: String(bt.exitBarIndex),
            });
          }

          // Compare exit reason
          const botReason = closedPos.exitReason ?? 'unknown';
          if (botReason !== bt.exitReason) {
            divergences.push({
              tradeNum, symbol: meta.symbol, entryBar: meta.entryBar,
              field: 'exitReason',
              botValue: botReason,
              backtestValue: bt.exitReason,
            });
          }

          // Compare PnL (within 0.001% tolerance for float precision)
          const pnlDiff = Math.abs(pnl - bt.pnlPercent);
          if (pnlDiff > 0.00001) {
            divergences.push({
              tradeNum, symbol: meta.symbol, entryBar: meta.entryBar,
              field: 'pnlPercent',
              botValue: (pnl * 100).toFixed(4) + '%',
              backtestValue: (bt.pnlPercent * 100).toFixed(4) + '%',
            });
          }

          // Compare partial TP trigger bar
          if (botPTBar !== bt.partialTriggerBar) {
            divergences.push({
              tradeNum, symbol: meta.symbol, entryBar: meta.entryBar,
              field: 'partialTriggerBar',
              botValue: String(botPTBar),
              backtestValue: String(bt.partialTriggerBar),
            });
          }

          pendingBTResults.delete(closedPos.id);
          pendingBTMeta.delete(closedPos.id);
          botPartialTriggerBars.delete(closedPos.id);
        }

        // Evaluate circuit breakers
        riskEngine.evaluateAfterTrade(tracker);
        tracker.saveState();
      }

      // Don't open new position while managing an existing one
    } else {
      // 2. Check if trading allowed
      riskEngine.cleanupExpiredBreakers(tracker);
      const blocker = riskEngine.canTrade(tracker);
      if (!blocker && riskEngine.canTradeSymbol(tracker, symbol)) {
        // 3. Evaluate signal (full array + explicit index)
        const result = signalEngine.evaluate(candles, symbol, candleIndex);

        if (result.hasSignal && result.signal) {
          const position = orderManager.openPosition(
            result.signal,
            symbol,
            tracker.getEquity(),
            config.riskPerTrade,
            barIndex,
          );

          if (position) {
            position.regime = result.regime;
            position.entryTimestamp = candle.timestamp; // Use candle time for replay (not Date.now())
            tracker.addPosition(position);

            // --compare: run backtest simulation for this trade
            if (config.compare) {
              const sig = result.signal.signal;
              const btResult = simulateBacktestPartialTP(
                sig.entryPrice,  // Raw signal price (pre-friction)
                sig.stopLoss,
                sig.takeProfit,
                sig.direction,
                barIndex,
                candles,
                RUN18_STRATEGY_CONFIG.maxBars,
              );
              pendingBTResults.set(position.id, btResult);
              pendingBTMeta.set(position.id, { symbol, entryBar: barIndex, direction: sig.direction });
            }

            if (config.verbose) {
              console.log(`  ${symbol}: OPENED ${position.direction.toUpperCase()} @ $${position.entryPrice.toFixed(2)} (score: ${position.confluenceScore.toFixed(2)}, regime: ${position.regime}, strategy: ${position.strategy}) [${new Date(candle.timestamp).toISOString().slice(0, 16)}]`);
            }
          }
        }
      }
    }

    stats.get(symbol)!.processedCandles++;
    processedEvents++;

    // Progress indicator (every 1%)
    const pct = Math.floor((processedEvents / totalEvents) * 100);
    if (pct > lastProgressPercent && pct % 5 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processedEvents / elapsed;
      const remaining = (totalEvents - processedEvents) / rate;
      process.stdout.write(`\r  Progress: ${pct}% (${processedEvents}/${totalEvents}) | ${rate.toFixed(0)} candles/sec | ~${remaining.toFixed(0)}s remaining | Equity: $${tracker.getEquity().toFixed(2)}`);
      lastProgressPercent = pct;
    }

    // Optional delay between candles
    if (config.delayMs > 0) {
      await sleep(config.delayMs);
    }
  }

  // Force-close any remaining open positions at last known price
  for (const position of tracker.getOpenPositions()) {
    const candles = symbolData.get(position.symbol)!;
    const lastPrice = candles[candles.length - 1]!.close;
    const result = orderManager.forceClose(position, lastPrice, 'shutdown');
    tracker.closePosition(result.position);

    const stat = stats.get(position.symbol)!;
    stat.trades++;
    const pnl = result.position.pnlPercent ?? 0;
    if (pnl > 0) stat.wins++;
    else stat.losses++;
    stat.pnlPercent += pnl;
    stat.pnlUSDT += result.position.pnlUSDT ?? 0;
  }

  tracker.saveState();
  tracker.recordSnapshot();

  // Print results
  const elapsed = (Date.now() - startTime) / 1000;
  console.log('\n\n' + '='.repeat(70));
  console.log('REPLAY COMPLETE');
  console.log('='.repeat(70));
  console.log(`Duration: ${elapsed.toFixed(1)}s (${(processedEvents / elapsed).toFixed(0)} candles/sec)`);
  console.log(`Final Equity: $${tracker.getEquity().toFixed(2)} (started at $${config.capital})`);
  console.log(`Total Return: ${(((tracker.getEquity() - config.capital) / config.capital) * 100).toFixed(2)}%`);
  console.log(`Peak Equity:  $${tracker.getPeakEquity().toFixed(2)}`);
  console.log(`Max Drawdown: ${(((tracker.getPeakEquity() - tracker.getEquity()) / tracker.getPeakEquity()) * 100).toFixed(2)}%`);
  console.log('');

  // Per-symbol breakdown
  console.log('Per-Symbol Breakdown:');
  console.log('-'.repeat(70));
  console.log('Symbol      | Strategy          | Trades | W/L     | WR%   | PnL%     | PnL$');
  console.log('-'.repeat(70));

  let totalTrades = 0;
  let totalWins = 0;

  for (const symbol of config.symbols) {
    const stat = stats.get(symbol)!;
    const wr = stat.trades > 0 ? ((stat.wins / stat.trades) * 100).toFixed(1) : '0.0';
    const pnlStr = stat.pnlUSDT >= 0 ? '+' : '';
    console.log(
      `${symbol.padEnd(12)}| ${'order_block'.padEnd(18)}| ${String(stat.trades).padEnd(7)}| ${stat.wins}W/${stat.losses}L${' '.repeat(Math.max(0, 4 - String(stat.losses).length))}| ${wr.padStart(5)}%| ${pnlStr}${(stat.pnlPercent * 100).toFixed(2).padStart(7)}%| ${pnlStr}$${stat.pnlUSDT.toFixed(2)}`
    );
    totalTrades += stat.trades;
    totalWins += stat.wins;
  }

  console.log('-'.repeat(70));
  const totalWR = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';
  console.log(`Total: ${totalTrades} trades, ${totalWR}% win rate`);
  console.log('');

  // Trade history summary
  const history = tracker.getTradeHistory(10);
  if (history.length > 0) {
    console.log('Last 10 Trades:');
    console.log('-'.repeat(70));
    for (const trade of history.slice(-10)) {
      const date = new Date(trade.exitTimestamp).toISOString().slice(0, 16);
      const pnlStr = trade.pnlUSDT >= 0 ? '+' : '';
      console.log(`  ${date} | ${trade.symbol.padEnd(10)} | ${trade.direction.padEnd(5)} | ${trade.exitReason.padEnd(12)} | ${pnlStr}$${trade.pnlUSDT.toFixed(2)} (${pnlStr}${(trade.pnlPercent * 100).toFixed(2)}%)`);
    }
  }

  console.log('\nTrades persisted to bot DB tables. Use `pnpm db:studio` to inspect.');

  // --compare: Print divergence report
  if (config.compare) {
    console.log('\n' + '='.repeat(70));
    console.log('DIVERGENCE REPORT (Bot vs Backtest Simulation)');
    console.log('='.repeat(70));

    if (divergences.length === 0) {
      console.log('PERFECT MATCH — Zero divergences across all trades.');
    } else {
      console.log(`Found ${divergences.length} divergence(s) across ${tradeNum} trades:\n`);
      console.log('Trade | Symbol     | Entry Bar | Field             | Bot Value        | Backtest Value');
      console.log('-'.repeat(95));
      for (const d of divergences) {
        console.log(
          `${String(d.tradeNum).padStart(5)} | ${d.symbol.padEnd(10)} | ${String(d.entryBar).padStart(9)} | ${d.field.padEnd(17)} | ${d.botValue.padEnd(16)} | ${d.backtestValue}`
        );
      }

      // Summary by field
      const fieldCounts = new Map<string, number>();
      for (const d of divergences) {
        fieldCounts.set(d.field, (fieldCounts.get(d.field) ?? 0) + 1);
      }
      console.log('\nDivergence Summary:');
      for (const [field, count] of fieldCounts) {
        console.log(`  ${field}: ${count} divergence(s)`);
      }
    }
    console.log('');
  }
}

// ============================================
// Entry Point
// ============================================

async function main(): Promise<void> {
  const config = parseArgs();

  console.log('='.repeat(70));
  console.log('ICT Replay Bot — Fast-Forward Paper Trading');
  console.log('='.repeat(70));

  console.log(`Strategy: order_block (Run 18 CMA-ES)`);
  console.log(`Symbols: ${config.symbols.join(', ')}`);
  console.log(`Capital: $${config.capital}`);
  console.log(`Risk/trade: ${(config.riskPerTrade * 100).toFixed(2)}%`);
  console.log(`Delay: ${config.delayMs === 0 ? 'none (max speed)' : `${config.delayMs}ms per candle`}`);
  if (config.startDate) {
    console.log(`Start date: ${new Date(config.startDate).toISOString().slice(0, 10)}`);
  }
  if (config.compare) {
    console.log('Compare: ENABLED (bot vs backtest divergence check)');
  }

  if (config.fresh) {
    resetBotTables();
  }

  await runReplay(config);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
