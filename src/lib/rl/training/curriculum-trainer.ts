/**
 * Curriculum Trainer
 * Progressive difficulty training for RL agents
 *
 * Research: "Curriculum learning breaks complex tasks into simpler ones,
 * enabling progressive acquisition of capabilities" (JMLR 2021)
 *
 * Phases:
 * 1. Easy: Only high-confluence setups (4+ signals), clear trends
 * 2. Medium: Add 3-signal setups, introduce choppy periods
 * 3. Hard: Full market data, all setups
 */

import type { Candle } from '@/types';
import type {
  TrainingConfig,
  TrainingMetrics,
  EvaluationResult,
  DQNConfig,
  EnvironmentConfig,
} from '../types';
import { TradingEnvironment } from '../environment/trading-env';
import { DQNAgent, SerializedWeights } from '../agent/dqn-agent';
import { ReplayBuffer } from '../agent/replay-buffer';
import { Evaluator } from './evaluator';
import { RewardConfig } from '../environment/reward-calculator';
import { StateBuilderConfig } from '../environment/state-builder';
import { analyzeMarketStructure, detectOrderBlocks, detectFairValueGaps } from '../../ict';

export interface CurriculumPhase {
  name: string;
  minConfluence: number;
  volatilityFilter: 'low' | 'medium' | 'all';
  episodeRange: [number, number];
  description: string;
}

export interface CurriculumConfig {
  // Phase definitions
  phases: CurriculumPhase[];

  // Adaptive difficulty
  enableAdaptive: boolean;
  promotionWinRate: number; // Win rate threshold to advance
  demotionWinRate: number; // Win rate threshold to go back
  minEpisodesPerPhase: number; // Minimum episodes before phase change

  // Data filtering
  trendStrengthThreshold: number; // For filtering "clear trends"
  volatilityLowThreshold: number; // Below this = low volatility
  volatilityHighThreshold: number; // Above this = high volatility
}

const DEFAULT_PHASES: CurriculumPhase[] = [
  {
    name: 'Easy',
    minConfluence: 4,
    volatilityFilter: 'low',
    episodeRange: [1, 50],
    description: 'High-confluence setups with clear trends',
  },
  {
    name: 'Medium',
    minConfluence: 3,
    volatilityFilter: 'medium',
    episodeRange: [51, 150],
    description: '3+ signal setups with moderate volatility',
  },
  {
    name: 'Hard',
    minConfluence: 1,
    volatilityFilter: 'all',
    episodeRange: [151, 300],
    description: 'Full market data, all setups',
  },
];

const DEFAULT_CURRICULUM_CONFIG: CurriculumConfig = {
  phases: DEFAULT_PHASES,
  enableAdaptive: true,
  promotionWinRate: 0.6,
  demotionWinRate: 0.3,
  minEpisodesPerPhase: 20,
  trendStrengthThreshold: 0.3,
  volatilityLowThreshold: 0.01,
  volatilityHighThreshold: 0.03,
};

export interface CurriculumTrainerCallbacks {
  onEpisodeEnd?: (metrics: TrainingMetrics, phase: CurriculumPhase) => void;
  onPhaseChange?: (oldPhase: CurriculumPhase, newPhase: CurriculumPhase, reason: string) => void;
  onEvaluation?: (result: EvaluationResult) => void;
  onCheckpoint?: (weights: SerializedWeights) => void;
  onLog?: (message: string) => void;
}

export class CurriculumTrainer {
  private config: TrainingConfig;
  private curriculumConfig: CurriculumConfig;
  private envConfig: Partial<EnvironmentConfig>;
  private stateConfig: Partial<StateBuilderConfig>;
  private rewardConfig: Partial<RewardConfig>;

  private allCandles: Candle[];
  private filteredDatasets: Map<string, Candle[][]> = new Map();

  private agent: DQNAgent;
  private evaluator: Evaluator;
  private callbacks: CurriculumTrainerCallbacks;

  // Curriculum state
  private currentPhaseIndex: number = 0;
  private phaseEpisodeCount: number = 0;
  private phaseWinRates: number[] = [];

  // Training state
  private bestSharpe: number = -Infinity;
  private noImprovementCount: number = 0;
  private stopped: boolean = false;

  constructor(
    candles: Candle[],
    trainingConfig: Partial<TrainingConfig> = {},
    curriculumConfig: Partial<CurriculumConfig> = {},
    envConfig: Partial<EnvironmentConfig> = {},
    dqnConfig: Partial<DQNConfig> = {},
    stateConfig: Partial<StateBuilderConfig> = {},
    rewardConfig: Partial<RewardConfig> = {},
    callbacks: CurriculumTrainerCallbacks = {}
  ) {
    this.config = { ...this.getDefaultTrainingConfig(), ...trainingConfig };
    this.curriculumConfig = { ...DEFAULT_CURRICULUM_CONFIG, ...curriculumConfig };
    this.envConfig = envConfig;
    this.stateConfig = stateConfig;
    this.rewardConfig = rewardConfig;
    this.callbacks = callbacks;
    this.allCandles = candles;

    // Pre-filter data for each phase
    this.prepareFilteredDatasets();

    // Get actual state size from environment
    const tempEnv = new TradingEnvironment(candles.slice(0, 100), envConfig, stateConfig);
    const stateSize = tempEnv.getStateSize();

    // Initialize components
    const buffer = new ReplayBuffer();
    this.agent = new DQNAgent({ ...dqnConfig, inputSize: stateSize }, buffer);
    this.evaluator = new Evaluator();

    this.log(`Curriculum Trainer initialized with ${this.curriculumConfig.phases.length} phases`);
    this.log(`Total candles: ${candles.length}`);
    this.log(`State vector size: ${stateSize}`);
  }

  private getDefaultTrainingConfig(): TrainingConfig {
    return {
      episodes: 300,
      maxStepsPerEpisode: 0,
      saveInterval: 50,
      evalInterval: 10,
      earlyStoppingPatience: 30,
      minImprovement: 0.01,
      trainSplit: 0.8,
      logInterval: 10,
      verbose: true,
      trainFrequency: 8,
      useRollingValidation: false, // Curriculum handles data selection
    };
  }

  /**
   * Pre-filter and analyze data for each difficulty level
   */
  private prepareFilteredDatasets(): void {
    this.log('Preparing filtered datasets for curriculum phases...');

    // Analyze all candles to identify difficulty levels
    const windowSize = 100;
    const confluenceWindows: { startIdx: number; endIdx: number; confluence: number; volatility: number }[] = [];

    for (let i = 0; i + windowSize <= this.allCandles.length; i += windowSize / 2) {
      const windowCandles = this.allCandles.slice(i, i + windowSize);
      const { avgConfluence, volatility } = this.analyzeWindow(windowCandles);

      confluenceWindows.push({
        startIdx: i,
        endIdx: i + windowSize,
        confluence: avgConfluence,
        volatility,
      });
    }

    // Group windows by difficulty
    for (const phase of this.curriculumConfig.phases) {
      const matchingWindows = confluenceWindows.filter(w =>
        w.confluence >= phase.minConfluence &&
        this.matchesVolatilityFilter(w.volatility, phase.volatilityFilter)
      );

      const phaseCandles: Candle[][] = matchingWindows.map(w =>
        this.allCandles.slice(w.startIdx, w.endIdx)
      );

      this.filteredDatasets.set(phase.name, phaseCandles);
      this.log(`  ${phase.name}: ${phaseCandles.length} windows (${phaseCandles.length * windowSize} candles)`);
    }

    // Ensure each phase has at least some data
    for (const phase of this.curriculumConfig.phases) {
      const datasets = this.filteredDatasets.get(phase.name) ?? [];
      if (datasets.length === 0) {
        // Fallback: use all data with random sampling
        this.log(`  Warning: ${phase.name} has no matching windows, using random samples`);
        this.filteredDatasets.set(phase.name, [this.allCandles]);
      }
    }
  }

  /**
   * Analyze a window of candles for confluence and volatility
   */
  private analyzeWindow(candles: Candle[]): { avgConfluence: number; volatility: number } {
    // Calculate average confluence
    const structure = analyzeMarketStructure(candles);
    const orderBlocks = detectOrderBlocks(candles);
    const fvgs = detectFairValueGaps(candles);

    // Simple confluence scoring
    let totalConfluence = 0;
    let count = 0;

    for (let i = 50; i < candles.length; i++) {
      let conf = 0;
      const price = candles[i]!.close;

      // Check trend
      if (Math.abs(structure.bias === 'bullish' ? 1 : structure.bias === 'bearish' ? -1 : 0) > 0) conf++;

      // Check if near order blocks
      for (const ob of orderBlocks.slice(-5)) {
        if (price >= ob.low && price <= ob.high) {
          conf++;
          break;
        }
      }

      // Check if in FVG
      for (const fvg of fvgs.slice(-5)) {
        if (price >= fvg.low && price <= fvg.high) {
          conf++;
          break;
        }
      }

      totalConfluence += conf;
      count++;
    }

    const avgConfluence = count > 0 ? totalConfluence / count : 0;

    // Calculate volatility (average true range as percentage)
    let sumTR = 0;
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i]!.high;
      const low = candles[i]!.low;
      const prevClose = candles[i - 1]!.close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      sumTR += tr / prevClose;
    }
    const volatility = sumTR / (candles.length - 1);

    return { avgConfluence, volatility };
  }

  /**
   * Check if volatility matches the filter
   */
  private matchesVolatilityFilter(volatility: number, filter: 'low' | 'medium' | 'all'): boolean {
    switch (filter) {
      case 'low':
        return volatility <= this.curriculumConfig.volatilityLowThreshold;
      case 'medium':
        return volatility <= this.curriculumConfig.volatilityHighThreshold;
      case 'all':
        return true;
      default:
        return true;
    }
  }

  /**
   * Get training data for current phase
   */
  private getPhaseData(): Candle[] {
    const phase = this.curriculumConfig.phases[this.currentPhaseIndex]!;
    const datasets = this.filteredDatasets.get(phase.name) ?? [this.allCandles];

    // Random sample from available datasets
    const randomIdx = Math.floor(Math.random() * datasets.length);
    return datasets[randomIdx] ?? this.allCandles;
  }

  /**
   * Run the curriculum training loop
   */
  async train(): Promise<CurriculumTrainingResult> {
    const results: TrainingMetrics[] = [];
    const evaluations: EvaluationResult[] = [];
    const phaseHistory: { episode: number; phase: string; reason?: string }[] = [];

    phaseHistory.push({
      episode: 1,
      phase: this.curriculumConfig.phases[0]!.name,
    });

    for (let episode = 1; episode <= this.config.episodes; episode++) {
      if (this.stopped) {
        this.log('Training stopped by user');
        break;
      }

      const currentPhase = this.curriculumConfig.phases[this.currentPhaseIndex]!;

      // Run episode with current phase data
      const metrics = this.runEpisode(episode);
      results.push(metrics);
      this.phaseEpisodeCount++;

      // Track win rate for adaptive difficulty
      this.phaseWinRates.push(metrics.winRate);
      if (this.phaseWinRates.length > 20) {
        this.phaseWinRates.shift();
      }

      // Callbacks
      this.callbacks.onEpisodeEnd?.(metrics, currentPhase);

      // Logging
      if (episode % this.config.logInterval === 0) {
        const avgWinRate = this.phaseWinRates.reduce((a, b) => a + b, 0) / this.phaseWinRates.length;
        this.log(`[${currentPhase.name}] ${this.evaluator.formatMetrics(metrics)} | Phase WR: ${avgWinRate.toFixed(1)}%`);
      }

      // Check for phase transition (adaptive difficulty)
      if (this.curriculumConfig.enableAdaptive) {
        const transitionResult = this.checkPhaseTransition(episode);
        if (transitionResult) {
          phaseHistory.push({
            episode,
            phase: this.curriculumConfig.phases[this.currentPhaseIndex]!.name,
            reason: transitionResult.reason,
          });
        }
      } else {
        // Fixed phase transitions based on episode count
        const newPhaseIndex = this.curriculumConfig.phases.findIndex(
          p => episode >= p.episodeRange[0] && episode <= p.episodeRange[1]
        );
        if (newPhaseIndex !== -1 && newPhaseIndex !== this.currentPhaseIndex) {
          const oldPhase = this.curriculumConfig.phases[this.currentPhaseIndex]!;
          this.currentPhaseIndex = newPhaseIndex;
          const newPhase = this.curriculumConfig.phases[this.currentPhaseIndex]!;
          this.phaseEpisodeCount = 0;
          this.phaseWinRates = [];

          this.callbacks.onPhaseChange?.(oldPhase, newPhase, 'scheduled');
          this.log(`Phase transition: ${oldPhase.name} -> ${newPhase.name} (scheduled at episode ${episode})`);

          phaseHistory.push({
            episode,
            phase: newPhase.name,
            reason: 'scheduled',
          });
        }
      }

      // Evaluation
      if (episode % this.config.evalInterval === 0) {
        const evalResult = this.evaluate(episode);
        evaluations.push(evalResult);
        this.callbacks.onEvaluation?.(evalResult);

        // Early stopping check
        if (evalResult.metrics.sharpeRatio > this.bestSharpe + this.config.minImprovement) {
          this.bestSharpe = evalResult.metrics.sharpeRatio;
          this.noImprovementCount = 0;

          const weights = await this.agent.saveWeights();
          this.callbacks.onCheckpoint?.(weights);
        } else {
          this.noImprovementCount++;
          if (this.noImprovementCount >= this.config.earlyStoppingPatience) {
            this.log(`Early stopping: No improvement for ${this.config.earlyStoppingPatience} evaluations`);
            break;
          }
        }
      }

      // Periodic checkpoint
      if (episode % this.config.saveInterval === 0) {
        const weights = await this.agent.saveWeights();
        this.callbacks.onCheckpoint?.(weights);
      }
    }

    // Final evaluation
    const finalEval = this.evaluate(results.length);

    return {
      metrics: results,
      evaluations,
      finalEvaluation: finalEval,
      agent: this.agent,
      phaseHistory,
      curriculumStats: this.getCurriculumStats(phaseHistory),
    };
  }

  /**
   * Check if we should transition to a different phase (adaptive mode)
   */
  private checkPhaseTransition(_episode: number): { reason: string } | null {
    if (this.phaseEpisodeCount < this.curriculumConfig.minEpisodesPerPhase) {
      return null; // Not enough episodes in current phase
    }

    const avgWinRate = this.phaseWinRates.length > 0
      ? this.phaseWinRates.reduce((a, b) => a + b, 0) / this.phaseWinRates.length
      : 0.5;

    const currentPhase = this.curriculumConfig.phases[this.currentPhaseIndex]!;

    // Check for promotion (doing well, advance to harder phase)
    if (avgWinRate >= this.curriculumConfig.promotionWinRate * 100) {
      if (this.currentPhaseIndex < this.curriculumConfig.phases.length - 1) {
        const newPhaseIndex = this.currentPhaseIndex + 1;
        const newPhase = this.curriculumConfig.phases[newPhaseIndex]!;

        this.currentPhaseIndex = newPhaseIndex;
        this.phaseEpisodeCount = 0;
        this.phaseWinRates = [];

        this.callbacks.onPhaseChange?.(currentPhase, newPhase, 'promotion');
        this.log(`Phase PROMOTION: ${currentPhase.name} -> ${newPhase.name} (WR: ${avgWinRate.toFixed(1)}%)`);

        // Reset epsilon slightly to encourage exploration in new phase
        this.agent.resetEpsilon();

        return { reason: 'promotion' };
      }
    }

    // Check for demotion (struggling, go back to easier phase)
    if (avgWinRate <= this.curriculumConfig.demotionWinRate * 100) {
      if (this.currentPhaseIndex > 0) {
        const newPhaseIndex = this.currentPhaseIndex - 1;
        const newPhase = this.curriculumConfig.phases[newPhaseIndex]!;

        this.currentPhaseIndex = newPhaseIndex;
        this.phaseEpisodeCount = 0;
        this.phaseWinRates = [];

        this.callbacks.onPhaseChange?.(currentPhase, newPhase, 'demotion');
        this.log(`Phase DEMOTION: ${currentPhase.name} -> ${newPhase.name} (WR: ${avgWinRate.toFixed(1)}%)`);

        return { reason: 'demotion' };
      }
    }

    return null;
  }

  /**
   * Run a single training episode
   */
  private runEpisode(episode: number): TrainingMetrics {
    const phaseData = this.getPhaseData();
    const env = new TradingEnvironment(
      phaseData,
      { ...this.envConfig, randomStart: true },
      this.stateConfig,
      this.rewardConfig,
      true // Training mode
    );

    let state = env.reset();
    let totalReward = 0;
    let steps = 0;
    let totalLoss = 0;
    let lossCount = 0;

    const maxSteps = this.config.maxStepsPerEpisode > 0
      ? this.config.maxStepsPerEpisode
      : phaseData.length;

    const trainFrequency = this.config.trainFrequency ?? 4;

    while (!env.isDone() && steps < maxSteps) {
      const action = this.agent.selectAction(state.features);
      const { state: nextState, reward, done } = env.step(action);

      this.agent.storeExperience(
        state.features,
        action,
        reward,
        nextState.features,
        done
      );

      if (steps % trainFrequency === 0) {
        const loss = this.agent.train();
        if (loss > 0) {
          totalLoss += loss;
          lossCount++;
        }
      }

      totalReward += reward;
      state = nextState;
      steps++;
    }

    this.agent.endEpisode();

    const portfolio = env.getPortfolio();
    const trades = env.getTrades();

    return {
      episode,
      totalReward,
      averageReward: steps > 0 ? totalReward / steps : 0,
      epsilon: this.agent.getState().epsilon,
      loss: lossCount > 0 ? totalLoss / lossCount : 0,
      totalTrades: trades.length,
      winRate: trades.length > 0
        ? (portfolio.winningTrades / trades.length) * 100
        : 0,
      sharpeRatio: 0,
      maxDrawdown: portfolio.maxDrawdown * 100,
      totalPnL: portfolio.realizedPnL,
    };
  }

  /**
   * Evaluate on validation data (full dataset for curriculum)
   */
  private evaluate(episode: number): EvaluationResult {
    // Use last 20% of data for validation
    const splitIdx = Math.floor(this.allCandles.length * 0.8);
    const valCandles = this.allCandles.slice(splitIdx);

    const env = new TradingEnvironment(
      valCandles,
      { ...this.envConfig, randomStart: false },
      this.stateConfig,
      this.rewardConfig,
      false // Evaluation mode
    );

    let state = env.reset();
    let totalReward = 0;
    const equityCurve: number[] = [this.envConfig.initialCapital ?? 10000];

    while (!env.isDone()) {
      const action = this.agent.selectAction(state.features, false);
      const { state: nextState, reward } = env.step(action);

      totalReward += reward;
      equityCurve.push(env.getPortfolio().equity);
      state = nextState;
    }

    const trades = env.getTrades();
    const initialCapital = this.envConfig.initialCapital ?? 10000;

    return this.evaluator.evaluate(
      trades,
      equityCurve,
      initialCapital,
      episode,
      totalReward,
      this.agent.getState().epsilon,
      this.agent.getState().averageLoss
    );
  }

  /**
   * Get curriculum training statistics
   */
  private getCurriculumStats(phaseHistory: { episode: number; phase: string; reason?: string }[]): CurriculumStats {
    const phaseEpisodes: Record<string, number> = {};
    const phaseTransitions: { from: string; to: string; reason: string; episode: number }[] = [];

    for (let i = 0; i < phaseHistory.length; i++) {
      const entry = phaseHistory[i]!;

      // Count episodes per phase
      const nextEntry = phaseHistory[i + 1];
      const episodesInPhase = nextEntry
        ? nextEntry.episode - entry.episode
        : this.config.episodes - entry.episode;

      phaseEpisodes[entry.phase] = (phaseEpisodes[entry.phase] ?? 0) + episodesInPhase;

      // Track transitions
      if (i > 0 && entry.reason) {
        const prevEntry = phaseHistory[i - 1]!;
        phaseTransitions.push({
          from: prevEntry.phase,
          to: entry.phase,
          reason: entry.reason,
          episode: entry.episode,
        });
      }
    }

    return {
      phaseEpisodes,
      phaseTransitions,
      totalPromotions: phaseTransitions.filter(t => t.reason === 'promotion').length,
      totalDemotions: phaseTransitions.filter(t => t.reason === 'demotion').length,
      finalPhase: phaseHistory[phaseHistory.length - 1]?.phase ?? 'Unknown',
    };
  }

  /**
   * Stop training
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Get the trained agent
   */
  getAgent(): DQNAgent {
    return this.agent;
  }

  /**
   * Log message
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[CurriculumTrainer] ${message}`);
      this.callbacks.onLog?.(message);
    }
  }
}

export interface CurriculumTrainingResult {
  metrics: TrainingMetrics[];
  evaluations: EvaluationResult[];
  finalEvaluation: EvaluationResult;
  agent: DQNAgent;
  phaseHistory: { episode: number; phase: string; reason?: string }[];
  curriculumStats: CurriculumStats;
}

export interface CurriculumStats {
  phaseEpisodes: Record<string, number>;
  phaseTransitions: { from: string; to: string; reason: string; episode: number }[];
  totalPromotions: number;
  totalDemotions: number;
  finalPhase: string;
}
