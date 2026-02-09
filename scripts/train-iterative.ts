#!/usr/bin/env npx tsx
/**
 * Iterative RL Training Script with Experiment Tracking
 *
 * This script implements a systematic approach to model improvement:
 * 1. Documents hypothesis before training
 * 2. Logs all metrics to experiments.json
 * 3. Automatically runs 90-day backtest after training
 * 4. Updates PROGRESS.md with results
 *
 * Usage:
 *   npx tsx scripts/train-iterative.ts --hypothesis "Testing higher dropout"
 *   npx tsx scripts/train-iterative.ts --hypothesis "Testing regime detection" --dropout 0.35 --lr 0.0003
 *
 * Required:
 *   --hypothesis "Description of what we're testing and why"
 *
 * Optional training params (override defaults):
 *   --dropout <number>     Dropout rate (default: 0.30)
 *   --lr <number>          Learning rate (default: 0.0004)
 *   --l2 <number>          L2 regularization (default: 0.012)
 *   --episodes <number>    Training episodes (default: 150)
 *   --epsilon-end <number> Final exploration rate (default: 0.15)
 *   --skip-gate            Skip 90-day validation (for debugging)
 *
 * Advanced DQN features (EXP-015 to EXP-022):
 *   --use-dueling          Enable Dueling DQN architecture (EXP-015)
 *   --use-nstep            Enable N-step returns (EXP-017)
 *   --nsteps <number>      N-step return length (default: 3)
 *   --use-per              Enable Prioritized Experience Replay (EXP-018)
 *   --per-alpha <number>   PER priority exponent (default: 0.6)
 *   --per-beta <number>    PER importance sampling (default: 0.4)
 *   --use-noisy            Enable NoisyNet exploration (EXP-022)
 *   --noisy-sigma <number> NoisyNet sigma init (default: 0.5)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type { Candle } from '@/types';
import { DQNAgent, type WeightHealthReport, type ExplorationDiagnostics, type SerializedWeights } from '../src/lib/rl/agent/dqn-agent';
import { ReplayBuffer, PrioritizedReplayBuffer, NStepReplayBuffer } from '../src/lib/rl/agent/replay-buffer';
import {
  ICTMetaStrategyEnvironment,
} from '../src/lib/rl/environment/ict-meta-env';
import {
  type StrategyAction,
  STRATEGY_COUNT,
} from '../src/lib/rl/strategies';

// ============================================
// CLI Arguments
// ============================================

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

function getNumArg(name: string, defaultValue: number): number {
  const val = getArg(name);
  return val ? parseFloat(val) : defaultValue;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const HYPOTHESIS = getArg('hypothesis');
const SKIP_GATE = hasFlag('skip-gate');

// Advanced DQN feature flags
const USE_DUELING = hasFlag('use-dueling');
const USE_NSTEP = hasFlag('use-nstep');
const NSTEPS = getNumArg('nsteps', 3);
const USE_PER = hasFlag('use-per');
const PER_ALPHA = getNumArg('per-alpha', 0.6);
const PER_BETA = getNumArg('per-beta', 0.4);
const USE_NOISY = hasFlag('use-noisy');
const NOISY_SIGMA = getNumArg('noisy-sigma', 0.5);

// Symbol-specific epsilon scaling (EXP-019)
// BTC needs more exploration (lower signal quality), SOL needs less
const SYMBOL_EPSILON_SCALING: Record<string, number> = {
  'BTCUSDT': 1.15, // 15% more exploration for BTC
  'ETHUSDT': 1.0,  // Standard for ETH
  'SOLUSDT': 0.95, // 5% less exploration for SOL
};

if (!HYPOTHESIS) {
  console.error('ERROR: --hypothesis is required');
  console.error('');
  console.error('Usage: train-iterative.ts --hypothesis "What are we testing and why"');
  console.error('');
  console.error('Examples:');
  console.error('  --hypothesis "Testing if higher dropout (0.35) reduces overfitting on SOL"');
  console.error('  --hypothesis "Adding market regime detection to improve generalization"');
  process.exit(1);
}

// ============================================
// Configuration
// ============================================

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

const CONFIG = {
  symbols: SYMBOLS,
  numAgents: 3,

  // Data
  trainSplit: 0.8,
  monthsOfData: 6,

  // Training
  episodes: getNumArg('episodes', 150),
  episodeLength: 1000,
  trainFrequency: 4,
  batchSize: 64,
  bufferSize: 50000,

  // DQN Agent - Configurable via CLI
  dqn: {
    inputSize: 42, // 18 base + 20 strategy + 4 KB (multi-period disabled after EXP-015)
    hiddenLayers: [128, 64, 32],
    outputSize: STRATEGY_COUNT,
    learningRate: getNumArg('lr', 0.0004),
    gamma: 0.95,
    tau: 0.01,
    epsilonStart: USE_NOISY ? 0 : 1.0, // NoisyNet doesn't use epsilon
    epsilonEnd: USE_NOISY ? 0 : getNumArg('epsilon-end', 0.15),
    epsilonDecay: 0.995,
    dropout: getNumArg('dropout', 0.30),
    l2Regularization: getNumArg('l2', 0.012),
    useBatchNorm: true,
    gradientClipNorm: 0.5,
    useHuberLoss: true,
    huberDelta: 1.0,
    actionBias: !USE_NOISY, // Disable action bias when using NoisyNet
    actionBiasDecay: 0.997,
    useDoubleDQN: true,
    useLinearEpsilonDecay: !USE_NOISY,
    totalExpectedEpisodes: getNumArg('episodes', 150),
    rewardBasedEpsilonAdjustment: !USE_NOISY,
    lowWinRateThreshold: 0.4,
    epsilonBoostAmount: 0.1,
    // Advanced DQN features
    useDueling: USE_DUELING,
    useNoisyNetworks: USE_NOISY,
    noisySigmaInit: NOISY_SIGMA,
    // Symbol-specific epsilon scaling
    symbolEpsilonScaling: SYMBOL_EPSILON_SCALING,
  },

  // N-Step and PER configuration
  nstep: {
    enabled: USE_NSTEP,
    nSteps: NSTEPS,
    gamma: 0.95,
  },
  per: {
    enabled: USE_PER,
    alpha: PER_ALPHA,
    beta: PER_BETA,
    betaIncrement: 0.001,
  },

  // Environment
  env: {
    initialCapital: 10000,
    positionSizePercent: 0.1,
    commission: 0.001,
    slippage: 0.0005,
    lookbackPeriod: 100,
    maxBarsPerEpisode: null,
    maxDrawdownLimit: 0.15,
    maxBarsInPosition: 100,
    kbConfig: {
      enabled: true,
      addKBFeatures: true,
      useKBRewardShaping: true,
    },
  },

  // Early Stopping
  earlyStoppingPatience: 25,
  minImprovement: 0.01,

  // Logging
  logInterval: 10,
  evalInterval: 20,
};

// ============================================
// Experiment Tracking Types
// ============================================

interface ExperimentEntry {
  id: string;
  timestamp: string;
  hypothesis: string;
  config_changes: Record<string, unknown>;
  training_result: {
    episodes_completed: number;
    best_val_sharpe: number;
    training_duration_min: number;
    model_path: string;
  } | null;
  backtest_90day: {
    btc_sharpe: number;
    eth_sharpe: number;
    sol_sharpe: number;
    aggregate_win_rate: number;
    total_trades: number;
  } | null;
  outcome: 'PASS' | 'FAIL' | 'PENDING';
  fail_reasons: string[];
  learnings: string;
}

interface ExperimentsFile {
  version: string;
  experiments: ExperimentEntry[];
}

// ============================================
// Logging
// ============================================

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

// ============================================
// Experiment Management
// ============================================

function createExperimentEntry(): { id: string; entry: ExperimentEntry } {
  const experimentsPath = path.join('experiments', 'experiments.json');
  const experiments: ExperimentsFile = fs.existsSync(experimentsPath)
    ? JSON.parse(fs.readFileSync(experimentsPath, 'utf-8'))
    : { version: '1.0', experiments: [] };

  const id = `exp-${String(experiments.experiments.length + 1).padStart(3, '0')}`;

  const entry: ExperimentEntry = {
    id,
    timestamp: new Date().toISOString(),
    hypothesis: HYPOTHESIS!,
    config_changes: {
      dropout: CONFIG.dqn.dropout,
      learningRate: CONFIG.dqn.learningRate,
      l2Regularization: CONFIG.dqn.l2Regularization,
      epsilonEnd: CONFIG.dqn.epsilonEnd,
      episodes: CONFIG.episodes,
      // Advanced DQN features
      useDueling: USE_DUELING,
      useNStep: USE_NSTEP,
      nSteps: USE_NSTEP ? NSTEPS : undefined,
      usePER: USE_PER,
      perAlpha: USE_PER ? PER_ALPHA : undefined,
      perBeta: USE_PER ? PER_BETA : undefined,
      useNoisy: USE_NOISY,
      noisySigma: USE_NOISY ? NOISY_SIGMA : undefined,
    },
    training_result: null,
    backtest_90day: null,
    outcome: 'PENDING',
    fail_reasons: [],
    learnings: '',
  };

  experiments.experiments.push(entry);
  fs.writeFileSync(experimentsPath, JSON.stringify(experiments, null, 2));

  return { id, entry };
}

function updateExperiment(id: string, updates: Partial<ExperimentEntry>) {
  const experimentsPath = path.join('experiments', 'experiments.json');
  const experiments: ExperimentsFile = JSON.parse(fs.readFileSync(experimentsPath, 'utf-8'));

  const idx = experiments.experiments.findIndex((e) => e.id === id);
  if (idx !== -1) {
    experiments.experiments[idx] = { ...experiments.experiments[idx]!, ...updates };
    fs.writeFileSync(experimentsPath, JSON.stringify(experiments, null, 2));
  }
}

function updateProgressMd(exp: ExperimentEntry, symbolResults?: { symbol: string; sharpe: number }[]) {
  const progressPath = path.join('experiments', 'PROGRESS.md');
  let content = fs.readFileSync(progressPath, 'utf-8');

  // Find the iteration log section and append
  const iterationHeader = `### ${exp.id}: ${exp.hypothesis.slice(0, 50)}${exp.hypothesis.length > 50 ? '...' : ''}`;

  const symbolTable = symbolResults
    ? symbolResults.map((r) => `| ${r.symbol} | ${r.sharpe.toFixed(2)} | ${r.sharpe > 0 ? 'PASS' : 'FAIL'} |`).join('\n')
    : '| - | - | - |';

  const iterationEntry = `
${iterationHeader}

- **Date**: ${new Date().toISOString().slice(0, 10)}
- **Hypothesis**: ${exp.hypothesis}
- **Config**: dropout=${CONFIG.dqn.dropout}, LR=${CONFIG.dqn.learningRate}, L2=${CONFIG.dqn.l2Regularization}
- **Training Result**:
  - Episodes: ${exp.training_result?.episodes_completed ?? 'N/A'}
  - Val Sharpe: ${exp.training_result?.best_val_sharpe?.toFixed(2) ?? 'N/A'}
  - Model: \`${exp.training_result?.model_path ?? 'N/A'}\`
- **90-Day Backtest (GATE)**:

| Symbol | Sharpe | Status |
|--------|--------|--------|
${symbolTable}

- **Outcome**: **${exp.outcome}**
- **Fail Reasons**: ${exp.fail_reasons.length > 0 ? exp.fail_reasons.join(', ') : 'None'}
- **Learnings**: ${exp.learnings || 'TBD - Update after analysis'}

---
`;

  // Insert before the Research Notes section
  const researchIdx = content.indexOf('## Research Notes');
  if (researchIdx !== -1) {
    content = content.slice(0, researchIdx) + iterationEntry + '\n' + content.slice(researchIdx);
  } else {
    content += iterationEntry;
  }

  fs.writeFileSync(progressPath, content);
}

// ============================================
// Symbol Data
// ============================================

interface SymbolData {
  symbol: string;
  trainCandles: Candle[];
  valCandles: Candle[];
}

function loadSymbolData(): SymbolData[] {
  const symbolData: SymbolData[] = [];

  for (const symbol of SYMBOLS) {
    const dataPath = path.join('data', `${symbol}_1h.json`);
    if (!fs.existsSync(dataPath)) {
      log(`WARNING: Data file not found for ${symbol}: ${dataPath}`);
      continue;
    }

    const allCandles = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
    const recentCandles = allCandles.slice(-CONFIG.monthsOfData * 30 * 24);

    const splitIdx = Math.floor(recentCandles.length * CONFIG.trainSplit);

    symbolData.push({
      symbol,
      trainCandles: recentCandles.slice(0, splitIdx),
      valCandles: recentCandles.slice(splitIdx),
    });

    log(`  ${symbol}: ${recentCandles.length} candles (train: ${splitIdx}, val: ${recentCandles.length - splitIdx})`);
  }

  return symbolData;
}

// ============================================
// Ensemble Agent
// ============================================

class TrainingEnsemble {
  private agents: DQNAgent[];
  private tradingBias: number = 3.0;

  constructor(numAgents: number, config: typeof CONFIG.dqn) {
    this.agents = [];

    for (let i = 0; i < numAgents; i++) {
      // Select appropriate buffer type based on configuration
      let buffer: ReplayBuffer;

      if (CONFIG.per.enabled) {
        // Prioritized Experience Replay
        buffer = new PrioritizedReplayBuffer(
          {
            capacity: CONFIG.bufferSize,
            batchSize: CONFIG.batchSize,
            minExperience: CONFIG.batchSize * 2,
          },
          CONFIG.per.alpha,
          CONFIG.per.beta,
          CONFIG.per.betaIncrement
        );
        log(`Agent ${i + 1}: Using PrioritizedReplayBuffer (alpha=${CONFIG.per.alpha}, beta=${CONFIG.per.beta})`);
      } else if (CONFIG.nstep.enabled) {
        // N-Step Returns
        buffer = new NStepReplayBuffer(
          {
            capacity: CONFIG.bufferSize,
            batchSize: CONFIG.batchSize,
            minExperience: CONFIG.batchSize * 2,
          },
          CONFIG.nstep.nSteps,
          CONFIG.nstep.gamma
        );
        log(`Agent ${i + 1}: Using NStepReplayBuffer (n=${CONFIG.nstep.nSteps})`);
      } else {
        // Standard replay buffer
        buffer = new ReplayBuffer({
          capacity: CONFIG.bufferSize,
          batchSize: CONFIG.batchSize,
          minExperience: CONFIG.batchSize * 2,
        });
      }

      const agentConfig = {
        ...config,
        learningRate: config.learningRate * (0.9 + Math.random() * 0.2),
      };

      const agent = new DQNAgent(agentConfig, buffer);
      agent.resetDiagnostics();

      this.agents.push(agent);
    }
  }

  selectAction(features: number[], training: boolean): StrategyAction {
    const votes: number[] = new Array(STRATEGY_COUNT).fill(0);

    for (const agent of this.agents) {
      const action = agent.selectAction(features, training);
      if (action >= 0 && action < votes.length) {
        votes[action]!++;
      }
    }

    if (training && this.tradingBias > 0.1) {
      for (let i = 1; i < STRATEGY_COUNT; i++) {
        votes[i]! += this.tradingBias * 3;
      }
      votes[0]! *= 0.3;
    }

    let maxVotes = 0;
    let selectedAction = 0;
    for (let i = 0; i < votes.length; i++) {
      if (votes[i]! > maxVotes) {
        maxVotes = votes[i]!;
        selectedAction = i;
      }
    }

    return selectedAction as StrategyAction;
  }

  storeExperience(state: number[], action: StrategyAction, reward: number, nextState: number[], done: boolean) {
    for (const agent of this.agents) {
      agent.storeExperience(state, action as 0 | 1 | 2 | 3, reward, nextState, done);
    }
  }

  train(): number {
    let totalLoss = 0;
    for (const agent of this.agents) {
      totalLoss += agent.train();
    }
    return totalLoss / this.agents.length;
  }

  endEpisode() {
    for (const agent of this.agents) {
      agent.endEpisode();
    }
    this.tradingBias *= 0.998;
  }

  /**
   * Set current symbol for symbol-specific epsilon scaling (EXP-019)
   */
  setCurrentSymbol(symbol: string) {
    for (const agent of this.agents) {
      agent.setCurrentSymbol(symbol);
    }
  }

  async saveWeights(): Promise<SerializedWeights[]> {
    return Promise.all(this.agents.map((a) => a.saveWeights()));
  }

  dispose() {
    for (const agent of this.agents) {
      agent.dispose();
    }
  }
}

// ============================================
// Evaluation
// ============================================

interface EvalResult {
  symbol: string;
  trades: number;
  winRate: number;
  pnl: number;
  sharpe: number;
}

async function evaluateSymbol(
  ensemble: TrainingEnsemble,
  candles: Candle[],
  symbol: string
): Promise<EvalResult> {
  const env = new ICTMetaStrategyEnvironment(
    candles,
    { ...CONFIG.env, randomStart: false },
    false
  );
  await env.initializeKB();

  let state = env.reset();

  while (!env.isDone()) {
    if (state && !env.isInPosition()) {
      const action = ensemble.selectAction(state.features, false);
      const result = env.step(action);
      state = result.state;
    } else {
      const result = env.step(null);
      state = result.state;
    }
  }

  const portfolio = env.getPortfolio();
  const trades = env.getTrades();

  const returns = trades.map((t) => t.pnlPercent);
  let sharpe = 0;
  if (returns.length > 1) {
    const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdRet = Math.sqrt(
      returns.reduce((a, r) => a + Math.pow(r - avgRet, 2), 0) / returns.length
    );
    sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252 * 24) : 0;
  }

  return {
    symbol,
    trades: trades.length,
    winRate: trades.length > 0 ? (portfolio.winningTrades / trades.length) * 100 : 0,
    pnl: portfolio.realizedPnL,
    sharpe,
  };
}

async function evaluateAllSymbols(
  ensemble: TrainingEnsemble,
  symbolData: SymbolData[],
  useVal: boolean = true
): Promise<{ results: EvalResult[]; aggregateSharpe: number }> {
  const results: EvalResult[] = [];

  for (const sd of symbolData) {
    const candles = useVal ? sd.valCandles : sd.trainCandles;
    const result = await evaluateSymbol(ensemble, candles, sd.symbol);
    results.push(result);
  }

  const aggregateSharpe = results.reduce((a, r) => a + r.sharpe, 0) / results.length;

  return { results, aggregateSharpe };
}

// ============================================
// Training Loop
// ============================================

async function train(): Promise<{ modelPath: string; bestValSharpe: number; episodesCompleted: number }> {
  log('============================================================');
  log('ITERATIVE RL TRAINING');
  log('============================================================');
  log('');
  log(`Hypothesis: ${HYPOTHESIS}`);
  log('');
  log('Configuration:');
  log(`  Dropout: ${CONFIG.dqn.dropout}`);
  log(`  Learning Rate: ${CONFIG.dqn.learningRate}`);
  log(`  L2 Regularization: ${CONFIG.dqn.l2Regularization}`);
  log(`  Epsilon End: ${CONFIG.dqn.epsilonEnd}`);
  log(`  Episodes: ${CONFIG.episodes}`);
  log('');
  log('Advanced DQN Features:');
  log(`  Dueling DQN: ${USE_DUELING ? 'ENABLED' : 'disabled'}`);
  log(`  N-Step Returns: ${USE_NSTEP ? `ENABLED (n=${NSTEPS})` : 'disabled'}`);
  log(`  PER: ${USE_PER ? `ENABLED (alpha=${PER_ALPHA}, beta=${PER_BETA})` : 'disabled'}`);
  log(`  NoisyNet: ${USE_NOISY ? `ENABLED (sigma=${NOISY_SIGMA})` : 'disabled'}`);
  log('');

  const symbolData = loadSymbolData();
  if (symbolData.length === 0) {
    throw new Error('No valid symbol data found');
  }

  const ensemble = new TrainingEnsemble(CONFIG.numAgents, CONFIG.dqn);
  log(`Created ensemble with ${CONFIG.numAgents} agents`);

  // Initialize KB
  const initEnv = new ICTMetaStrategyEnvironment(
    symbolData[0]!.trainCandles.slice(0, 500),
    CONFIG.env,
    true
  );
  await initEnv.initializeKB();
  log('KB initialized');
  log('');

  let bestValSharpe = -Infinity;
  let bestModelPath = '';
  let noImprovementCount = 0;
  let currentSymbolIndex = 0;
  let episodesCompleted = 0;

  log('Starting training...');
  log('');

  for (let episode = 1; episode <= CONFIG.episodes; episode++) {
    const sd = symbolData[currentSymbolIndex]!;
    currentSymbolIndex = (currentSymbolIndex + 1) % symbolData.length;

    // Set current symbol for epsilon scaling (EXP-019)
    ensemble.setCurrentSymbol(sd.symbol);

    const startIdx = Math.floor(Math.random() * (sd.trainCandles.length - CONFIG.episodeLength - 150));
    const episodeCandles = sd.trainCandles.slice(startIdx, startIdx + CONFIG.episodeLength + 150);

    const env = new ICTMetaStrategyEnvironment(
      episodeCandles,
      { ...CONFIG.env, randomStart: true },
      true
    );
    await env.initializeKB();

    let state = env.reset();
    let episodeReward = 0;
    let stepCount = 0;

    while (!env.isDone() && stepCount < CONFIG.episodeLength) {
      if (state && !env.isInPosition()) {
        const action = ensemble.selectAction(state.features, true);
        const prevFeatures = state.features;
        const result = env.step(action);
        state = result.state;
        episodeReward += result.reward;

        if (result.state) {
          ensemble.storeExperience(prevFeatures, action, result.reward, result.state.features, result.done);
        }
      } else {
        const result = env.step(null);
        state = result.state;
        episodeReward += result.reward;
      }

      if (stepCount % CONFIG.trainFrequency === 0) {
        ensemble.train();
      }

      stepCount++;
    }

    ensemble.endEpisode();
    episodesCompleted = episode;

    const portfolio = env.getPortfolio();
    const trades = env.getTrades();
    const winRate = trades.length > 0 ? (portfolio.winningTrades / trades.length) * 100 : 0;

    if (episode % CONFIG.logInterval === 0) {
      log(`Ep ${episode.toString().padStart(3)} [${sd.symbol}]: R=${episodeReward.toFixed(2).padStart(7)} Tr=${trades.length.toString().padStart(3)} WR=${winRate.toFixed(1).padStart(5)}% PnL=${portfolio.realizedPnL.toFixed(0).padStart(6)}`);
    }

    // Validation
    if (episode % CONFIG.evalInterval === 0) {
      const valResults = await evaluateAllSymbols(ensemble, symbolData, true);

      log('');
      log('=== VALIDATION ===');
      for (const r of valResults.results) {
        log(`  ${r.symbol}: Sharpe=${r.sharpe.toFixed(2)} WR=${r.winRate.toFixed(1)}% Trades=${r.trades}`);
      }
      log(`  Aggregate Sharpe: ${valResults.aggregateSharpe.toFixed(3)}`);

      if (valResults.aggregateSharpe > bestValSharpe + CONFIG.minImprovement) {
        bestValSharpe = valResults.aggregateSharpe;
        noImprovementCount = 0;

        const weights = await ensemble.saveWeights();
        const modelData = {
          timestamp: new Date().toISOString(),
          episode,
          hypothesis: HYPOTHESIS,
          config: CONFIG,
          valSharpe: bestValSharpe,
          perSymbolResults: valResults.results,
          numAgents: CONFIG.numAgents,
          weights,
        };

        bestModelPath = `models/iterative_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
        fs.writeFileSync(bestModelPath, JSON.stringify(modelData, null, 2));
        log(`  NEW BEST MODEL: ${bestModelPath}`);
      } else {
        noImprovementCount++;
        if (noImprovementCount >= CONFIG.earlyStoppingPatience) {
          log('');
          log(`Early stopping: No improvement for ${CONFIG.earlyStoppingPatience} evaluations`);
          break;
        }
      }
      log('');
    }
  }

  ensemble.dispose();

  return { modelPath: bestModelPath, bestValSharpe, episodesCompleted };
}

// ============================================
// Main
// ============================================

async function main() {
  const startTime = Date.now();

  // Create experiment entry
  log('Creating experiment entry...');
  const { id: expId, entry: expEntry } = createExperimentEntry();
  log(`Experiment ID: ${expId}`);
  log('');

  try {
    // Run training
    const { modelPath, bestValSharpe, episodesCompleted } = await train();
    const trainingDuration = (Date.now() - startTime) / 1000 / 60;

    // Update experiment with training results
    updateExperiment(expId, {
      training_result: {
        episodes_completed: episodesCompleted,
        best_val_sharpe: bestValSharpe,
        training_duration_min: Math.round(trainingDuration),
        model_path: modelPath,
      },
    });

    if (!modelPath) {
      log('No model saved - training may have failed');
      updateExperiment(expId, { outcome: 'FAIL', fail_reasons: ['No model saved'] });
      process.exit(1);
    }

    log('');
    log('============================================================');
    log('TRAINING COMPLETE');
    log(`Model: ${modelPath}`);
    log(`Val Sharpe: ${bestValSharpe.toFixed(3)}`);
    log(`Duration: ${trainingDuration.toFixed(1)} minutes`);
    log('============================================================');

    if (SKIP_GATE) {
      log('');
      log('SKIPPING 90-DAY GATE (--skip-gate flag)');
      updateExperiment(expId, { outcome: 'PENDING', learnings: 'Gate skipped for debugging' });
      return;
    }

    // Run 90-day validation gate
    log('');
    log('============================================================');
    log('RUNNING 90-DAY VALIDATION GATE');
    log('============================================================');
    log('');

    try {
      const gateOutput = execSync(
        `npx tsx scripts/validate-90day.ts --model "${modelPath}" --json`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      );

      const gateResult = JSON.parse(gateOutput);

      // Extract results
      const btcSharpe = gateResult.symbols.find((s: { symbol: string }) => s.symbol === 'BTCUSDT')?.sharpe ?? 0;
      const ethSharpe = gateResult.symbols.find((s: { symbol: string }) => s.symbol === 'ETHUSDT')?.sharpe ?? 0;
      const solSharpe = gateResult.symbols.find((s: { symbol: string }) => s.symbol === 'SOLUSDT')?.sharpe ?? 0;

      // Update experiment
      updateExperiment(expId, {
        backtest_90day: {
          btc_sharpe: btcSharpe,
          eth_sharpe: ethSharpe,
          sol_sharpe: solSharpe,
          aggregate_win_rate: gateResult.aggregate.avgWinRate,
          total_trades: gateResult.aggregate.totalTrades,
        },
        outcome: gateResult.gate.passed ? 'PASS' : 'FAIL',
        fail_reasons: gateResult.gate.failReasons,
      });

      // Update PROGRESS.md
      const finalExp = { ...expEntry };
      finalExp.training_result = {
        episodes_completed: episodesCompleted,
        best_val_sharpe: bestValSharpe,
        training_duration_min: Math.round(trainingDuration),
        model_path: modelPath,
      };
      finalExp.backtest_90day = {
        btc_sharpe: btcSharpe,
        eth_sharpe: ethSharpe,
        sol_sharpe: solSharpe,
        aggregate_win_rate: gateResult.aggregate.avgWinRate,
        total_trades: gateResult.aggregate.totalTrades,
      };
      finalExp.outcome = gateResult.gate.passed ? 'PASS' : 'FAIL';
      finalExp.fail_reasons = gateResult.gate.failReasons;

      updateProgressMd(finalExp, [
        { symbol: 'BTCUSDT', sharpe: btcSharpe },
        { symbol: 'ETHUSDT', sharpe: ethSharpe },
        { symbol: 'SOLUSDT', sharpe: solSharpe },
      ]);

      // Print results
      log('');
      log('90-DAY VALIDATION RESULTS:');
      log(`  BTC Sharpe: ${btcSharpe.toFixed(2)} ${btcSharpe > 0 ? '✓' : '✗'}`);
      log(`  ETH Sharpe: ${ethSharpe.toFixed(2)} ${ethSharpe > 0 ? '✓' : '✗'}`);
      log(`  SOL Sharpe: ${solSharpe.toFixed(2)} ${solSharpe > 0 ? '✓' : '✗'}`);
      log(`  Aggregate Win Rate: ${gateResult.aggregate.avgWinRate.toFixed(1)}%`);
      log('');

      if (gateResult.gate.passed) {
        log('\x1b[32m============================================================\x1b[0m');
        log('\x1b[32m                    GATE: PASSED\x1b[0m');
        log('\x1b[32m============================================================\x1b[0m');
        log('');
        log('Congratulations! This model passes the 90-day validation gate.');
        log(`Model saved at: ${modelPath}`);
      } else {
        log('\x1b[31m============================================================\x1b[0m');
        log('\x1b[31m                    GATE: FAILED\x1b[0m');
        log('\x1b[31m============================================================\x1b[0m');
        log('');
        log('Fail reasons:');
        for (const reason of gateResult.gate.failReasons) {
          log(`  - ${reason}`);
        }
        log('');
        log('Next steps:');
        log('  1. Analyze why specific symbols failed');
        log('  2. Research potential solutions');
        log('  3. Document learnings in experiments.json');
        log('  4. Try next iteration with new hypothesis');
      }

    } catch (gateError) {
      log(`Gate validation error: ${gateError}`);
      updateExperiment(expId, { outcome: 'FAIL', fail_reasons: ['Gate validation script failed'] });
    }

  } catch (error) {
    log(`Training error: ${error}`);
    updateExperiment(expId, { outcome: 'FAIL', fail_reasons: [`Training error: ${error}`] });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
