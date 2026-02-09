#!/usr/bin/env npx tsx
/**
 * Train Weight Optimizer
 *
 * Trains a continuous PPO agent to learn regime-adaptive weight multipliers
 * for the 10 confluence scoring factors.
 *
 * Episode = one walk-forward window (720 bars / ~1 month)
 * Every 24 bars (1 day): PPO observes regime context, outputs multipliers
 * Confluence scorer runs with adjusted weights, reward = risk-adjusted PnL
 *
 * Multi-symbol training: BTC + ETH + SOL simultaneously (prevents single-asset memorization)
 *
 * Usage:
 *   npx tsx scripts/train-weight-optimizer.ts
 *   npx tsx scripts/train-weight-optimizer.ts --episodes 500
 *   npx tsx scripts/train-weight-optimizer.ts --symbols BTC,ETH,SOL --episodes 1000
 *   npx tsx scripts/train-weight-optimizer.ts --load models/weight_optimizer_latest.json
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  WeightOptimizerEnvironment,
  STATE_SIZE,
  ACTION_SIZE,
  type WeightOptimizerConfig,
} from '../src/lib/rl/environment/weight-optimizer-env';
import {
  ContinuousPPOAgent,
  type ContinuousPPOConfig,
} from '../src/lib/rl/agent/continuous-ppo-agent';

// ============================================
// Config
// ============================================

interface TrainingConfig {
  episodes: number;
  symbols: string[];
  dataDir: string;
  timeframe: string;
  modelDir: string;
  saveInterval: number;
  logInterval: number;
  loadModel: string | null;

  // Environment
  decisionInterval: number;
  episodeLength: number;
  commission: number;
  slippage: number;
  maxHoldBars: number;

  // PPO
  learningRate: number;
  nSteps: number;
  nEpochs: number;
  miniBatchSize: number;
  gamma: number;
  lambda: number;
  clipRatio: number;
  entropyCoef: number;

  // Episode sampling
  windowSlide: number;
}

const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  episodes: 300,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  dataDir: path.join(process.cwd(), 'data'),
  timeframe: '1h',
  modelDir: path.join(process.cwd(), 'models'),
  saveInterval: 50,
  logInterval: 10,
  loadModel: null,

  decisionInterval: 24,  // Daily weight adjustment (30 steps per episode)
  episodeLength: 720,
  commission: 0.0005,   // Maker fee: 0.05%/side
  slippage: 0.0002,     // Minimal: 0.02%/side
  maxHoldBars: 72,

  learningRate: 0.0002,  // Lower LR for stability
  nSteps: 30,           // 1 episode = 30 steps (720/24)
  nEpochs: 3,           // Fewer epochs to prevent overfitting per batch
  miniBatchSize: 15,
  gamma: 0.99,
  lambda: 0.95,
  clipRatio: 0.15,      // Tighter clipping for more conservative updates
  entropyCoef: 0.1,     // High entropy — 3-dim space needs lots of exploration

  windowSlide: 360, // Half-episode overlap for diversity
};

// ============================================
// CLI
// ============================================

function parseArgs(): TrainingConfig {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_TRAINING_CONFIG };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--episodes':
        config.episodes = parseInt(args[++i] ?? '300', 10);
        break;
      case '--symbols':
        config.symbols = (args[++i] ?? 'BTCUSDT').split(',').map((s) => {
          const upper = s.toUpperCase().trim();
          return upper.endsWith('USDT') ? upper : `${upper}USDT`;
        });
        break;
      case '--timeframe':
        config.timeframe = args[++i] ?? '1h';
        break;
      case '--save-interval':
        config.saveInterval = parseInt(args[++i] ?? '50', 10);
        break;
      case '--load':
        config.loadModel = args[++i] ?? null;
        break;
      case '--lr':
        config.learningRate = parseFloat(args[++i] ?? '0.0003');
        break;
      case '--entropy':
        config.entropyCoef = parseFloat(args[++i] ?? '0.01');
        break;
    }
  }

  return config;
}

// ============================================
// Data Loading
// ============================================

interface SymbolData {
  symbol: string;
  candles: Candle[];
  /** Start indices for walk-forward episodes */
  episodeStarts: number[];
}

function loadSymbolData(config: TrainingConfig): SymbolData[] {
  const data: SymbolData[] = [];

  for (const symbol of config.symbols) {
    const filePath = path.join(config.dataDir, `${symbol}_${config.timeframe}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`[Warning] Data not found: ${filePath}, skipping ${symbol}`);
      continue;
    }

    const candles: Candle[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    console.log(`[Data] ${symbol}: ${candles.length} candles`);

    // Generate episode start indices with overlap
    const lookback = 200; // ICT detection warmup
    const episodeStarts: number[] = [];
    let start = lookback;
    while (start + config.episodeLength <= candles.length) {
      episodeStarts.push(start);
      start += config.windowSlide;
    }

    console.log(`[Data] ${symbol}: ${episodeStarts.length} possible episodes`);
    data.push({ symbol, candles, episodeStarts });
  }

  return data;
}

// ============================================
// Training Loop
// ============================================

interface EpisodeMetrics {
  episode: number;
  symbol: string;
  totalReward: number;
  trades: number;
  wins: number;
  pnl: number;
  winRate: number;
  avgMultiplier: number;
  loss: number;
}

async function train(config: TrainingConfig): Promise<void> {
  console.log('='.repeat(60));
  console.log('Weight Optimizer Training');
  console.log('='.repeat(60));
  console.log(`  Episodes:    ${config.episodes}`);
  console.log(`  Symbols:     ${config.symbols.join(', ')}`);
  console.log(`  Timeframe:   ${config.timeframe}`);
  console.log(`  State size:  ${STATE_SIZE}`);
  console.log(`  Action size: ${ACTION_SIZE} (weight multipliers)`);
  console.log(`  Decision interval: ${config.decisionInterval} bars`);
  console.log(`  Episode length: ${config.episodeLength} bars`);
  console.log('='.repeat(60));

  // Load data
  const symbolData = loadSymbolData(config);
  if (symbolData.length === 0) {
    console.error('[Error] No data loaded. Exiting.');
    process.exit(1);
  }

  // Create agent
  const ppoConfig: Partial<ContinuousPPOConfig> = {
    inputSize: STATE_SIZE,
    actionSize: ACTION_SIZE,
    hiddenLayers: [32, 16],
    learningRate: config.learningRate,
    nSteps: config.nSteps,
    nEpochs: config.nEpochs,
    miniBatchSize: config.miniBatchSize,
    gamma: config.gamma,
    lambda: config.lambda,
    clipRatio: config.clipRatio,
    entropyCoef: config.entropyCoef,
  };

  const agent = new ContinuousPPOAgent(ppoConfig);

  // Load existing model if specified
  if (config.loadModel && fs.existsSync(config.loadModel)) {
    console.log(`[Load] Loading model from ${config.loadModel}`);
    const savedData = JSON.parse(fs.readFileSync(config.loadModel, 'utf-8'));
    await agent.loadWeights(savedData);
    console.log('[Load] Model loaded successfully');
  }

  // Print param count
  const params = agent.getParamCount();
  console.log(`[Model] Params: actor=${params.actor}, critic=${params.critic}, total=${params.total}`);

  // Create environment
  const envConfig: Partial<WeightOptimizerConfig> = {
    decisionInterval: config.decisionInterval,
    episodeLength: config.episodeLength,
    commission: config.commission,
    slippage: config.slippage,
    maxHoldBars: config.maxHoldBars,
  };

  const env = new WeightOptimizerEnvironment(envConfig);

  // Training history
  const history: EpisodeMetrics[] = [];
  let bestAvgReward = -Infinity;

  // Ensure model dir exists
  if (!fs.existsSync(config.modelDir)) {
    fs.mkdirSync(config.modelDir, { recursive: true });
  }

  // Main training loop
  for (let ep = 0; ep < config.episodes; ep++) {
    // Pick random symbol and random episode start
    const symIdx = Math.floor(Math.random() * symbolData.length);
    const sym = symbolData[symIdx]!;
    const startIdx = Math.floor(Math.random() * sym.episodeStarts.length);
    const episodeStart = sym.episodeStarts[startIdx]!;

    // Set data and reset
    env.setData(sym.candles);
    let state = env.reset(episodeStart);

    let totalReward = 0;
    let totalTrades = 0;
    let totalWins = 0;
    let totalPnL = 0;
    let stepCount = 0;
    let totalLoss = 0;
    let trainCount = 0;

    // Episode loop (1 step per episode in bandit mode, 30 steps in sequential mode)
    let done = false;
    while (!done) {
      // PPO selects continuous actions
      const action = agent.selectAction(state.features, true);

      // Environment steps
      const result = env.step(action);

      // Store in rollout buffer
      agent.storeStep(state.features, action, result.reward, result.done);

      totalReward += result.reward;
      totalTrades += result.info.trades;
      totalWins += result.info.wins;
      totalPnL += result.info.pnl;
      stepCount++;

      state = result.state;
      done = result.done;
    }

    // Train when buffer has accumulated enough episodes
    if (agent.isReadyToTrain()) {
      const loss = agent.train();
      totalLoss += loss;
      trainCount++;
    }

    agent.endEpisode();

    // Metrics
    const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
    const avgLoss = trainCount > 0 ? totalLoss / trainCount : 0;

    // Compute average multiplier deviation from 1.0 (how much PPO adjusts)
    const lastMultipliers = Object.values(state.features);
    const avgMult = lastMultipliers.length > 0
      ? lastMultipliers.reduce((s, v) => s + Math.abs(v), 0) / lastMultipliers.length
      : 0;

    const metrics: EpisodeMetrics = {
      episode: ep,
      symbol: sym.symbol,
      totalReward,
      trades: totalTrades,
      wins: totalWins,
      pnl: totalPnL,
      winRate,
      avgMultiplier: avgMult,
      loss: avgLoss,
    };

    history.push(metrics);

    // Logging
    if (ep % config.logInterval === 0 || ep === config.episodes - 1) {
      const recentWindow = history.slice(-config.logInterval);
      const avgReward = recentWindow.reduce((s, m) => s + m.totalReward, 0) / recentWindow.length;
      const avgTrades = recentWindow.reduce((s, m) => s + m.trades, 0) / recentWindow.length;
      const avgWR = recentWindow.reduce((s, m) => s + m.winRate, 0) / recentWindow.length;
      const avgPnL = recentWindow.reduce((s, m) => s + m.pnl, 0) / recentWindow.length;

      console.log(
        `[Ep ${ep.toString().padStart(4)}] ` +
        `${sym.symbol.padEnd(8)} | ` +
        `R: ${avgReward.toFixed(3).padStart(7)} | ` +
        `Trades: ${avgTrades.toFixed(1).padStart(5)} | ` +
        `WR: ${(avgWR * 100).toFixed(1).padStart(5)}% | ` +
        `PnL: ${(avgPnL * 100).toFixed(2).padStart(7)}% | ` +
        `Loss: ${avgLoss.toFixed(4).padStart(7)}`,
      );
    }

    // Save checkpoint
    if ((ep + 1) % config.saveInterval === 0 || ep === config.episodes - 1) {
      const weights = await agent.saveWeights();

      // Save latest
      const latestPath = path.join(config.modelDir, 'weight_optimizer_latest.json');
      fs.writeFileSync(latestPath, JSON.stringify(weights, null, 2));

      // Save numbered checkpoint
      const checkpointPath = path.join(config.modelDir, `weight_optimizer_ep${ep + 1}.json`);
      fs.writeFileSync(checkpointPath, JSON.stringify(weights, null, 2));
      console.log(`[Save] Checkpoint saved: ${path.basename(checkpointPath)}`);

      // Track best
      const recentAvg = history.slice(-config.saveInterval)
        .reduce((s, m) => s + m.totalReward, 0) / config.saveInterval;
      if (recentAvg > bestAvgReward) {
        bestAvgReward = recentAvg;
        const bestPath = path.join(config.modelDir, 'weight_optimizer_best.json');
        fs.writeFileSync(bestPath, JSON.stringify(weights, null, 2));
        console.log(`[Save] New best model (avg reward: ${bestAvgReward.toFixed(3)})`);
      }
    }
  }

  // Final summary
  printSummary(history, config);

  // Save training report
  const reportPath = path.join(
    config.modelDir,
    `weight_optimizer_report_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`,
  );
  fs.writeFileSync(reportPath, JSON.stringify({
    config,
    paramCount: agent.getParamCount(),
    history,
    summary: computeSummary(history),
  }, null, 2));
  console.log(`\n[Report] Training report saved to ${reportPath}`);

  agent.dispose();
}

// ============================================
// Summary
// ============================================

interface TrainingSummary {
  totalEpisodes: number;
  avgReward: number;
  avgTrades: number;
  avgWinRate: number;
  avgPnL: number;
  bestEpisodeReward: number;
  worstEpisodeReward: number;
  rewardTrend: 'improving' | 'stable' | 'declining';
  perSymbol: Record<string, { avgReward: number; avgWR: number; avgPnL: number; episodes: number }>;
}

function computeSummary(history: EpisodeMetrics[]): TrainingSummary {
  const n = history.length;
  const avgReward = history.reduce((s, m) => s + m.totalReward, 0) / n;
  const avgTrades = history.reduce((s, m) => s + m.trades, 0) / n;
  const avgWR = history.reduce((s, m) => s + m.winRate, 0) / n;
  const avgPnL = history.reduce((s, m) => s + m.pnl, 0) / n;

  const best = Math.max(...history.map((m) => m.totalReward));
  const worst = Math.min(...history.map((m) => m.totalReward));

  // Trend: compare first quarter vs last quarter
  const q = Math.floor(n / 4);
  const firstQ = history.slice(0, q).reduce((s, m) => s + m.totalReward, 0) / q;
  const lastQ = history.slice(-q).reduce((s, m) => s + m.totalReward, 0) / q;
  const trend = lastQ > firstQ + 0.1 ? 'improving' : lastQ < firstQ - 0.1 ? 'declining' : 'stable';

  // Per-symbol breakdown
  const perSymbol: TrainingSummary['perSymbol'] = {};
  for (const m of history) {
    if (!perSymbol[m.symbol]) {
      perSymbol[m.symbol] = { avgReward: 0, avgWR: 0, avgPnL: 0, episodes: 0 };
    }
    perSymbol[m.symbol]!.avgReward += m.totalReward;
    perSymbol[m.symbol]!.avgWR += m.winRate;
    perSymbol[m.symbol]!.avgPnL += m.pnl;
    perSymbol[m.symbol]!.episodes++;
  }
  for (const sym of Object.keys(perSymbol)) {
    const s = perSymbol[sym]!;
    s.avgReward /= s.episodes;
    s.avgWR /= s.episodes;
    s.avgPnL /= s.episodes;
  }

  return {
    totalEpisodes: n,
    avgReward,
    avgTrades,
    avgWinRate: avgWR,
    avgPnL,
    bestEpisodeReward: best,
    worstEpisodeReward: worst,
    rewardTrend: trend,
    perSymbol,
  };
}

function printSummary(history: EpisodeMetrics[], _config: TrainingConfig): void {
  const summary = computeSummary(history);

  console.log('\n' + '='.repeat(60));
  console.log('TRAINING SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Episodes:     ${summary.totalEpisodes}`);
  console.log(`  Avg Reward:   ${summary.avgReward.toFixed(3)}`);
  console.log(`  Avg Trades:   ${summary.avgTrades.toFixed(1)} per episode`);
  console.log(`  Avg Win Rate: ${(summary.avgWinRate * 100).toFixed(1)}%`);
  console.log(`  Avg PnL:      ${(summary.avgPnL * 100).toFixed(2)}% per episode`);
  console.log(`  Best Episode:  ${summary.bestEpisodeReward.toFixed(3)}`);
  console.log(`  Worst Episode: ${summary.worstEpisodeReward.toFixed(3)}`);
  console.log(`  Reward Trend:  ${summary.rewardTrend}`);

  console.log('\n  Per-Symbol Breakdown:');
  for (const [sym, stats] of Object.entries(summary.perSymbol)) {
    console.log(
      `    ${sym.padEnd(10)} | ` +
      `R: ${stats.avgReward.toFixed(3).padStart(7)} | ` +
      `WR: ${(stats.avgWR * 100).toFixed(1).padStart(5)}% | ` +
      `PnL: ${(stats.avgPnL * 100).toFixed(2).padStart(7)}% | ` +
      `Eps: ${stats.episodes}`,
    );
  }

  console.log('\n' + '='.repeat(60));
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const config = parseArgs();
  await train(config);
}

main().catch((err) => {
  console.error('Training failed:', err);
  process.exit(1);
});
