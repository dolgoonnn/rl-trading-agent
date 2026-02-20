#!/usr/bin/env npx tsx
/**
 * F2F Gold Paper Trading Bot — Standalone Daily Process
 *
 * Polls XAUTUSDT daily candle from Bybit, computes F2F signal,
 * and manages a single paper position.
 *
 * Completely independent from the crypto ICT bot.
 * PM2-compatible: handles SIGTERM/SIGINT for graceful shutdown.
 * Persistent: saves/loads state to JSON file on each tick.
 *
 * Schedule: ticks once per day at ~00:05 UTC (after Bybit daily close at 00:00 UTC).
 *
 * Usage:
 *   npx tsx scripts/run-gold-bot.ts                              # Default
 *   npx tsx scripts/run-gold-bot.ts --capital 5000                # Custom capital
 *   npx tsx scripts/run-gold-bot.ts --telegram-token T --telegram-chat C
 *   npx tsx scripts/run-gold-bot.ts --verbose
 *   npx tsx scripts/run-gold-bot.ts --dry-run                    # Compute signal only, no trades
 *   npx tsx scripts/run-gold-bot.ts --params '{"lambda":0.95,"theta":0.91}'
 *   npx tsx scripts/run-gold-bot.ts --regime-filter zscore50      # Enable regime filter
 */

import * as fs from 'fs';
import * as path from 'path';
import { RestClientV5 } from 'bybit-api';
import type { Candle } from '../src/types/candle';
import { AlertManager } from '../src/lib/bot/alerts';
import {
  generateSignals,
  computePositionWeight,
  F2F_FIXED_PARAMS,
  type F2FOptimizedParams,
  type F2FTrainStats,
  type F2FSignal,
  type RegimeFilterType,
} from '../src/lib/gold';

// ============================================
// Constants
// ============================================

let SYMBOL = 'XAUTUSDT'; // Tether Gold — tracks 1 troy oz (XAUUSDT delisted from Bybit)
const BYBIT_CATEGORY = 'linear' as const;
const BYBIT_INTERVAL = 'D' as const;
const MIN_CANDLES = 1000; // Bybit max kline limit; sufficient for momentum(50) + EWMA warm-up
const POST_CLOSE_DELAY_MS = 5 * 60 * 1000; // 5 min after daily close
const STATE_FILE = path.resolve(__dirname, '..', 'data', 'gold-bot-state.json');

// ============================================
// Bot State (persisted to JSON)
// ============================================

interface GoldBotState {
  equity: number;
  initialCapital: number;
  position: GoldBotPosition | null;
  trades: GoldBotTradeRecord[];
  lastTickTimestamp: number;
  /** Rolling 30d PnL values for Sharpe monitoring */
  rolling30dReturns: number[];
  startedAt: number;
}

interface GoldBotPosition {
  entryPrice: number;
  entryTimestamp: number;
  weight: number;
  hardStop: number;
  trailingStop: number;
  peakPrice: number;
  daysHeld: number;
  pBullAtEntry: number;
  atrAtEntry: number;
}

interface GoldBotTradeRecord {
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  weight: number;
  pnlPercent: number;
  daysHeld: number;
}

// ============================================
// CLI Parsing
// ============================================

interface BotOptions {
  capital: number;
  params: F2FOptimizedParams;
  trainStats?: F2FTrainStats;
  telegramToken?: string;
  telegramChat?: string;
  verbose: boolean;
  dryRun: boolean;
  friction: number;
  regimeFilter: RegimeFilterType;
}

function parseArgs(): BotOptions {
  const args = process.argv.slice(2);
  const opts: BotOptions = {
    capital: 10000,
    params: { lambda: 0.95, theta: 0.91 }, // Optimal from WF validation (zscore50 filter)
    verbose: false,
    dryRun: false,
    friction: 0.0005,
    regimeFilter: 'zscore50', // Best regime filter from Phase 3
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--capital':
        opts.capital = parseFloat(args[++i]!);
        break;
      case '--params':
        opts.params = JSON.parse(args[++i]!) as F2FOptimizedParams;
        break;
      case '--telegram-token':
        opts.telegramToken = args[++i];
        break;
      case '--telegram-chat':
        opts.telegramChat = args[++i];
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--friction':
        opts.friction = parseFloat(args[++i]!);
        break;
      case '--train-stats':
        opts.trainStats = JSON.parse(args[++i]!) as F2FTrainStats;
        break;
      case '--symbol':
        SYMBOL = args[++i]!;
        break;
      case '--regime-filter':
        opts.regimeFilter = args[++i]! as RegimeFilterType;
        break;
    }
  }

  // Env var fallbacks for PM2
  if (!opts.telegramToken && process.env.TELEGRAM_BOT_TOKEN) {
    opts.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  }
  if (!opts.telegramChat && process.env.TELEGRAM_CHAT_ID) {
    opts.telegramChat = process.env.TELEGRAM_CHAT_ID;
  }

  return opts;
}

// ============================================
// State Persistence
// ============================================

function loadState(capital: number): GoldBotState {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as GoldBotState;
      console.log(`  State loaded from ${STATE_FILE} (equity=$${data.equity.toFixed(2)}, trades=${data.trades.length})`);
      return data;
    } catch (err) {
      console.warn(`  Warning: Failed to load state, starting fresh: ${err}`);
    }
  }
  return {
    equity: capital,
    initialCapital: capital,
    position: null,
    trades: [],
    lastTickTimestamp: 0,
    rolling30dReturns: [],
    startedAt: Date.now(),
  };
}

function saveState(state: GoldBotState): void {
  // Ensure data directory exists
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================
// Bybit Data Fetcher
// ============================================

async function fetchDailyCandles(
  client: RestClientV5,
  limit: number,
): Promise<Candle[]> {
  const response = await client.getKline({
    category: BYBIT_CATEGORY,
    symbol: SYMBOL,
    interval: BYBIT_INTERVAL,
    limit,
  });

  if (response.retCode !== 0) {
    throw new Error(`Bybit API error: ${response.retMsg} (code: ${response.retCode})`);
  }

  const rawCandles = response.result.list;
  if (!rawCandles || rawCandles.length === 0) {
    throw new Error('No candle data returned from Bybit');
  }

  // Bybit returns newest-first, we need oldest-first
  const candles: Candle[] = rawCandles
    .map((item) => ({
      timestamp: parseInt(item[0], 10),
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      volume: parseFloat(item[5]),
    }))
    .reverse();

  return candles;
}

// ============================================
// Monitoring
// ============================================

function computeRolling30dSharpe(returns: number[]): number {
  if (returns.length < 10) return NaN;
  const recent = returns.slice(-30);
  const mean = recent.reduce((s, r) => s + r, 0) / recent.length;
  const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / recent.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
}

// ============================================
// Core Tick Logic
// ============================================

function processTick(
  candles: Candle[],
  state: GoldBotState,
  opts: BotOptions,
): { signal: F2FSignal; action: string } {
  const fp = F2F_FIXED_PARAMS;

  // Use the full candle history for training stats
  const trainEnd = candles.length - 1;
  const trainStart = 0;

  // Generate signal for the last bar (with regime filter)
  const signals = generateSignals(
    candles,
    opts.params,
    trainStart,
    trainEnd,
    candles.length - 1,
    candles.length,
    opts.regimeFilter,
  );

  if (signals.length === 0) {
    return { signal: {} as F2FSignal, action: 'no_signal' };
  }

  const signal = signals[0]!;
  let action = 'hold';

  // Track daily return (flat = 0)
  let dailyReturn = 0;

  // Check position management
  if (state.position !== null) {
    state.position.daysHeld++;

    // Update trailing stop — uses CURRENT ATR (paper: ATR₁₄(t))
    if (signal.close > state.position.peakPrice) {
      state.position.peakPrice = signal.close;
      state.position.trailingStop = state.position.peakPrice - fp.trailingStopAtrMultiple * signal.atr;
    }

    // Check exits
    let exitReason: string | null = null;

    if (signal.close <= state.position.hardStop) {
      exitReason = 'hard_stop';
    } else if (signal.close <= state.position.trailingStop) {
      exitReason = 'trailing_stop';
    } else if (state.position.daysHeld >= fp.timeoutDays) {
      exitReason = 'timeout';
    } else if (signal.pBear > 0.50) {
      exitReason = 'derisk';
    }

    if (exitReason !== null && !opts.dryRun) {
      const exitPrice = signal.close;
      const grossReturn = (exitPrice - state.position.entryPrice) / state.position.entryPrice;
      const netReturn = state.position.weight * grossReturn - 2 * opts.friction * state.position.weight;

      dailyReturn = netReturn;
      state.equity *= 1 + netReturn;

      state.trades.push({
        entryTimestamp: state.position.entryTimestamp,
        exitTimestamp: signal.timestamp,
        entryPrice: state.position.entryPrice,
        exitPrice,
        exitReason,
        weight: state.position.weight,
        pnlPercent: netReturn,
        daysHeld: state.position.daysHeld,
      });

      action = `exit_${exitReason}`;
      state.position = null;
    } else if (exitReason !== null) {
      action = `dry_exit_${exitReason}`;
    } else {
      // In position, no exit — compute unrealized daily return
      const prevClose = candles[candles.length - 2]?.close ?? signal.close;
      dailyReturn = state.position.weight * (signal.close - prevClose) / prevClose;
    }
  }

  // Check entry
  if (state.position === null && signal.isLongEntry && !opts.dryRun) {
    const weight = computePositionWeight(signal);

    if (weight > 0.01) {
      state.position = {
        entryPrice: signal.close,
        entryTimestamp: signal.timestamp,
        weight,
        hardStop: signal.close - fp.hardStopAtrMultiple * signal.atr,
        trailingStop: signal.close - fp.trailingStopAtrMultiple * signal.atr,
        peakPrice: signal.close,
        daysHeld: 0,
        pBullAtEntry: signal.pBull,
        atrAtEntry: signal.atr,
      };
      action = 'entry_long';
    }
  } else if (state.position === null && signal.isLongEntry && opts.dryRun) {
    action = 'dry_entry_long';
  }

  // Track daily return for rolling Sharpe
  state.rolling30dReturns.push(dailyReturn);
  if (state.rolling30dReturns.length > 90) {
    state.rolling30dReturns = state.rolling30dReturns.slice(-90); // Keep 90d max
  }

  state.lastTickTimestamp = signal.timestamp;

  return { signal, action };
}

// ============================================
// Main Loop
// ============================================

async function main(): Promise<void> {
  const opts = parseArgs();
  const alerts = new AlertManager(opts.telegramToken, opts.telegramChat);

  console.log('=== F2F Gold Paper Trading Bot ===\n');
  console.log(`  Symbol: ${SYMBOL}`);
  console.log(`  Capital: $${opts.capital.toLocaleString()}`);
  console.log(`  Params: λ=${opts.params.lambda}, θ=${opts.params.theta}`);
  console.log(`  Regime filter: ${opts.regimeFilter}`);
  console.log(`  Friction: ${(opts.friction * 10000).toFixed(1)} bps/side`);
  console.log(`  Mode: ${opts.dryRun ? 'DRY RUN (signals only)' : 'PAPER TRADING'}`);
  console.log(`  State file: ${STATE_FILE}`);
  console.log(`  Train stats: ${opts.trainStats ? `frozen (mu=${opts.trainStats.mu.toFixed(6)}, sigma=${opts.trainStats.sigma.toFixed(6)})` : `live (${MIN_CANDLES} bars from Bybit)`}`);
  console.log(`  Verbose: ${opts.verbose}`);
  if (!opts.trainStats) {
    console.log(`  WARNING: Using ${MIN_CANDLES}-bar live training stats vs 2520-bar WF validation.`);
    console.log(`           Pass --train-stats from backtest results for consistency.\n`);
  } else {
    console.log();
  }

  const client = new RestClientV5({});

  // Load persisted state or create new
  const state = loadState(opts.capital);

  // Graceful shutdown
  let running = true;
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    running = false;
    saveState(state);
    console.log('  State saved.');
    await alerts.send({
      level: 'warning',
      event: 'bot_stopped',
      message: `F2F Gold Bot stopped: ${signal}`,
      timestamp: Date.now(),
    });
    printSummary(state);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await alerts.send({
    level: 'info',
    event: 'bot_started',
    message: [
      `F2F Gold Bot started — ${SYMBOL}`,
      `Capital: $${opts.capital}`,
      `Regime: ${opts.regimeFilter}`,
      `λ=${opts.params.lambda}, θ=${opts.params.theta}`,
    ].join('\n'),
    timestamp: Date.now(),
  });

  // Main loop: tick once, then wait for next daily close
  while (running) {
    try {
      // Fetch candles
      const candles = await fetchDailyCandles(client, MIN_CANDLES);
      const latestTimestamp = candles[candles.length - 1]!.timestamp;
      const latestDate = new Date(latestTimestamp).toISOString().slice(0, 10);
      const latestClose = candles[candles.length - 1]!.close;

      if (opts.verbose) {
        console.log(`\n[${new Date().toISOString()}] Tick: ${latestDate}, close=${latestClose.toFixed(2)}, bars=${candles.length}`);
      }

      // Skip if we already processed this candle
      if (latestTimestamp <= state.lastTickTimestamp) {
        if (opts.verbose) {
          console.log(`  Skipping: already processed ${latestDate}`);
        }
      } else {
        // Process tick
        const { signal, action } = processTick(candles, state, opts);

        // Log
        const posStatus = state.position
          ? `IN POSITION (${state.position.daysHeld}d, SL=$${state.position.trailingStop.toFixed(2)})`
          : 'FLAT';

        const suppressed = signal.isRegimeSuppressed ? ' [REGIME SUPPRESSED]' : '';
        console.log(
          `[${latestDate}] p_bull=${signal.pBull?.toFixed(3) ?? 'N/A'} ` +
          `z=${signal.zScore?.toFixed(2) ?? 'N/A'} ` +
          `vol=${((signal.ewmaVol ?? 0) * 100).toFixed(2)}% ` +
          `ATR=${signal.atr?.toFixed(2) ?? 'N/A'} ` +
          `action=${action} ${posStatus} ` +
          `equity=$${state.equity.toFixed(2)}${suppressed}`
        );

        // Alert on entry/exit
        if (action === 'entry_long' && state.position) {
          await alerts.send({
            level: 'info',
            event: 'position_opened',
            message: [
              `F2F LONG: ${SYMBOL}`,
              `Entry: $${state.position.entryPrice.toFixed(2)}`,
              `SL: $${state.position.hardStop.toFixed(2)}`,
              `Trailing: $${state.position.trailingStop.toFixed(2)}`,
              `Weight: ${(state.position.weight * 100).toFixed(1)}%`,
              `p_bull: ${state.position.pBullAtEntry.toFixed(3)}`,
            ].join('\n'),
            timestamp: Date.now(),
          });
        }

        if (action.startsWith('exit_') && state.trades.length > 0) {
          const lastTrade = state.trades[state.trades.length - 1]!;
          const pnlSign = lastTrade.pnlPercent >= 0 ? '+' : '';
          await alerts.send({
            level: lastTrade.pnlPercent >= 0 ? 'info' : 'warning',
            event: 'position_closed',
            message: [
              `F2F EXIT: ${SYMBOL}`,
              `Reason: ${lastTrade.exitReason}`,
              `PnL: ${pnlSign}${(lastTrade.pnlPercent * 100).toFixed(2)}%`,
              `Days: ${lastTrade.daysHeld}`,
              `Equity: $${state.equity.toFixed(2)}`,
            ].join('\n'),
            timestamp: Date.now(),
          });
        }

        // Monitoring: check rolling 30d Sharpe degradation
        const rolling30dSharpe = computeRolling30dSharpe(state.rolling30dReturns);
        if (!isNaN(rolling30dSharpe) && rolling30dSharpe < -1.0) {
          await alerts.send({
            level: 'error',
            event: 'degradation_alert',
            message: [
              `DEGRADATION ALERT: ${SYMBOL}`,
              `Rolling 30d Sharpe: ${rolling30dSharpe.toFixed(2)} (threshold: > -1.0)`,
              `Consider investigating: market regime change?`,
            ].join('\n'),
            timestamp: Date.now(),
          });
        }

        // Persist state after each tick
        saveState(state);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Tick error:`, err);
      await alerts.send({
        level: 'error',
        event: 'error',
        message: `F2F Gold Bot error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      });
    }

    // Dry-run: tick once and exit
    if (opts.dryRun) {
      console.log('\nDry run complete — exiting.');
      break;
    }

    // Wait until next daily close + delay
    if (running) {
      const now = Date.now();
      const msUntilMidnightUTC = getMsUntilNextDailyClose(now);
      const waitMs = msUntilMidnightUTC + POST_CLOSE_DELAY_MS;

      if (opts.verbose) {
        const nextTick = new Date(now + waitMs);
        console.log(`  Next tick: ${nextTick.toISOString()} (${(waitMs / 3600000).toFixed(1)}h)`);
      }

      await sleep(waitMs);
    }
  }
}

// ============================================
// Helpers
// ============================================

function getMsUntilNextDailyClose(nowMs: number): number {
  const now = new Date(nowMs);
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime() - nowMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printSummary(state: GoldBotState): void {
  console.log('\n=== Session Summary ===');
  console.log(`  Final equity: $${state.equity.toFixed(2)}`);
  console.log(`  Total trades: ${state.trades.length}`);
  console.log(`  Running since: ${new Date(state.startedAt).toISOString()}`);

  if (state.trades.length > 0) {
    const wins = state.trades.filter((t) => t.pnlPercent > 0).length;
    const totalPnl = state.trades.reduce((s, t) => s + t.pnlPercent, 0);
    console.log(`  Win rate: ${((wins / state.trades.length) * 100).toFixed(1)}%`);
    console.log(`  Total PnL: ${(totalPnl * 100).toFixed(2)}%`);
  }

  const rolling30d = computeRolling30dSharpe(state.rolling30dReturns);
  if (!isNaN(rolling30d)) {
    console.log(`  Rolling 30d Sharpe: ${rolling30d.toFixed(2)}`);
  }

  if (state.position) {
    console.log(`  Open position: entry=$${state.position.entryPrice.toFixed(2)}, ${state.position.daysHeld}d held`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
