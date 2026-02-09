/**
 * Ensemble Agent
 * Combines multiple RL agents (DQN, PPO) using vote-based ensemble strategy
 *
 * Research: "Ensemble using PPO, A2C, and DDPG robustly adjusts to different
 * market situations" (KDD 2024)
 *
 * The ensemble agent aggregates predictions from multiple agents and weights
 * them by recent performance to make final trading decisions.
 */

import type { Action, AgentState } from '../types';
import { Actions } from '../types';
import type { SerializedWeights } from './base-agent';
import { DQNAgent } from './dqn-agent';
import { PPOAgent } from './ppo-agent';

/**
 * Agent wrapper type that both DQN and PPO implement
 * Using 'any' for weights to avoid type conflicts between different agent implementations
 */
interface AgentWrapper {
  selectAction(state: number[], training: boolean): Action;
  train(): number;
  endEpisode(): void;
  getState(): AgentState;
  saveWeights(): Promise<unknown>;
  loadWeights(data: unknown): Promise<void>;
  dispose(): void;
}

export interface EnsembleConfig {
  // Agent types to include in ensemble
  useDQN: boolean;
  usePPO: boolean;

  // Voting configuration
  votingMethod: 'majority' | 'weighted' | 'confidence';

  // Performance tracking
  performanceWindowSize: number; // How many recent trades to consider
  minTradesForWeight: number; // Minimum trades before weighting kicks in

  // Agent-specific configs (optional overrides)
  dqnConfig?: Partial<import('./dqn-agent').DQNConfig>;
  ppoConfig?: Partial<import('./ppo-agent').PPOConfig>;

  // Confidence threshold for agreement
  confidenceThreshold?: number;
}

interface AgentEntry {
  agent: AgentWrapper;
  type: 'dqn' | 'ppo';
  weight: number;
  recentRewards: number[];
  winRate: number;
  totalTrades: number;
}

const DEFAULT_CONFIG: EnsembleConfig = {
  useDQN: true,
  usePPO: true,
  votingMethod: 'weighted',
  performanceWindowSize: 50,
  minTradesForWeight: 10,
  confidenceThreshold: 0.6,
};

export class EnsembleAgent implements AgentWrapper {
  private config: EnsembleConfig;
  private agents: AgentEntry[] = [];

  // Ensemble state
  private totalSteps: number = 0;
  private episodeCount: number = 0;
  private lastAction: Action = Actions.HOLD;
  private lastReward: number = 0;
  private actionVotes: Map<Action, number[]> = new Map(); // Track which agents voted for what

  constructor(
    config: Partial<EnsembleConfig> = {},
    inputSize: number = 104
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize agents based on config
    if (this.config.useDQN) {
      const dqnConfig = {
        inputSize,
        ...this.config.dqnConfig,
      };
      this.agents.push({
        agent: new DQNAgent(dqnConfig),
        type: 'dqn',
        weight: 1.0,
        recentRewards: [],
        winRate: 0.5,
        totalTrades: 0,
      });
    }

    if (this.config.usePPO) {
      const ppoConfig = {
        inputSize,
        ...this.config.ppoConfig,
      };
      this.agents.push({
        agent: new PPOAgent(ppoConfig),
        type: 'ppo',
        weight: 1.0,
        recentRewards: [],
        winRate: 0.5,
        totalTrades: 0,
      });
    }

    if (this.agents.length === 0) {
      throw new Error('EnsembleAgent requires at least one agent type enabled');
    }
  }

  /**
   * Select action using ensemble voting
   * Aggregates predictions from all agents and selects the best action
   */
  selectAction(state: number[], training: boolean = true): Action {
    const votes: Map<Action, number> = new Map();
    const agentActions: { agent: AgentEntry; action: Action }[] = [];

    // Collect votes from each agent
    for (const entry of this.agents) {
      const action = entry.agent.selectAction(state, training);
      agentActions.push({ agent: entry, action });

      const currentVote = votes.get(action) ?? 0;
      const voteWeight = this.getVoteWeight(entry);
      votes.set(action, currentVote + voteWeight);
    }

    // Track which agents voted for what (for diagnostics)
    this.actionVotes.clear();
    for (const { agent, action } of agentActions) {
      const existing = this.actionVotes.get(action) ?? [];
      existing.push(this.agents.indexOf(agent));
      this.actionVotes.set(action, existing);
    }

    // Select action based on voting method
    let selectedAction: Action;
    switch (this.config.votingMethod) {
      case 'majority':
        selectedAction = this.majorityVote(votes);
        break;
      case 'weighted':
        selectedAction = this.weightedVote(votes);
        break;
      case 'confidence':
        selectedAction = this.confidenceVote(votes, agentActions);
        break;
      default:
        selectedAction = this.weightedVote(votes);
    }

    this.lastAction = selectedAction;
    this.totalSteps++;

    return selectedAction;
  }

  /**
   * Get vote weight for an agent based on recent performance
   */
  private getVoteWeight(entry: AgentEntry): number {
    if (this.config.votingMethod === 'majority') {
      return 1.0; // Equal weight in majority voting
    }

    if (entry.totalTrades < this.config.minTradesForWeight) {
      return 1.0; // Not enough data, use equal weight
    }

    // Weight by win rate and recent performance
    // Agents with higher win rates get more influence
    const winRateWeight = 0.5 + entry.winRate; // 0.5 to 1.5 range

    // Recent reward trend
    const recentRewardSum = entry.recentRewards.reduce((a, b) => a + b, 0);
    const recentRewardAvg = recentRewardSum / Math.max(1, entry.recentRewards.length);
    const rewardWeight = 1.0 + Math.tanh(recentRewardAvg * 10) * 0.5; // 0.5 to 1.5 range

    return winRateWeight * rewardWeight;
  }

  /**
   * Simple majority voting
   */
  private majorityVote(votes: Map<Action, number>): Action {
    let maxVotes = -1;
    let selectedAction: Action = Actions.HOLD;

    for (const [action, count] of votes) {
      if (count > maxVotes) {
        maxVotes = count;
        selectedAction = action;
      }
    }

    return selectedAction;
  }

  /**
   * Weighted voting based on agent performance
   */
  private weightedVote(votes: Map<Action, number>): Action {
    let maxWeight = -1;
    let selectedAction: Action = Actions.HOLD;

    for (const [action, weight] of votes) {
      if (weight > maxWeight) {
        maxWeight = weight;
        selectedAction = action;
      }
    }

    return selectedAction;
  }

  /**
   * Confidence-based voting
   * Requires strong agreement, otherwise defaults to HOLD
   */
  private confidenceVote(
    votes: Map<Action, number>,
    _agentActions: { agent: AgentEntry; action: Action }[]
  ): Action {
    const totalWeight = Array.from(votes.values()).reduce((a, b) => a + b, 0);
    const threshold = this.config.confidenceThreshold ?? 0.6;

    let maxAction: Action = Actions.HOLD;
    let maxWeight = 0;

    for (const [action, weight] of votes) {
      if (weight > maxWeight) {
        maxWeight = weight;
        maxAction = action;
      }
    }

    // Check if the winning action has enough confidence
    const confidence = maxWeight / totalWeight;
    if (confidence >= threshold) {
      return maxAction;
    }

    // Low confidence - default to HOLD (conservative)
    return Actions.HOLD;
  }

  /**
   * Train all agents in the ensemble
   */
  train(): number {
    let totalLoss = 0;
    let lossCount = 0;

    for (const entry of this.agents) {
      const loss = entry.agent.train();
      if (loss > 0) {
        totalLoss += loss;
        lossCount++;
      }
    }

    return lossCount > 0 ? totalLoss / lossCount : 0;
  }

  /**
   * Store experience in all agents
   * For ensemble, we need to track performance per agent
   */
  storeExperience(
    state: number[],
    action: Action,
    reward: number,
    nextState: number[],
    done: boolean
  ): void {
    // Update performance tracking
    this.lastReward = reward;

    // Store in all agents that support it
    for (const entry of this.agents) {
      if (entry.type === 'dqn') {
        (entry.agent as DQNAgent).storeExperience(state, action, reward, nextState, done);
      } else if (entry.type === 'ppo') {
        (entry.agent as PPOAgent).storeExperience(state, action, reward, nextState, done);
      }

      // Track agent-specific performance
      entry.recentRewards.push(reward);
      if (entry.recentRewards.length > this.config.performanceWindowSize) {
        entry.recentRewards.shift();
      }

      // Update win rate (positive reward = win)
      if (reward !== 0) {
        entry.totalTrades++;
        const wins = entry.recentRewards.filter(r => r > 0).length;
        entry.winRate = wins / Math.max(1, entry.recentRewards.length);
      }
    }
  }

  /**
   * End episode for all agents
   */
  endEpisode(): void {
    this.episodeCount++;

    for (const entry of this.agents) {
      entry.agent.endEpisode();
    }

    // Update weights based on episode performance
    this.updateAgentWeights();
  }

  /**
   * Update agent weights based on recent performance
   */
  private updateAgentWeights(): void {
    if (this.config.votingMethod === 'majority') {
      return; // No weight updates for majority voting
    }

    // Normalize weights
    let totalWeight = 0;
    for (const entry of this.agents) {
      entry.weight = this.getVoteWeight(entry);
      totalWeight += entry.weight;
    }

    // Normalize to sum to number of agents
    for (const entry of this.agents) {
      entry.weight = (entry.weight / totalWeight) * this.agents.length;
    }
  }

  /**
   * Get ensemble state
   */
  getState(): AgentState {
    // Aggregate state from all agents
    let totalReward = 0;
    let totalLoss = 0;
    let epsilon = 0;

    for (const entry of this.agents) {
      const state = entry.agent.getState();
      totalReward += state.averageReward;
      totalLoss += state.averageLoss;
      epsilon = Math.max(epsilon, state.epsilon);
    }

    return {
      epsilon,
      totalSteps: this.totalSteps,
      episodeCount: this.episodeCount,
      averageReward: totalReward / this.agents.length,
      averageLoss: totalLoss / this.agents.length,
    };
  }

  /**
   * Get detailed ensemble diagnostics
   */
  getDiagnostics(): EnsembleDiagnostics {
    const agentStats = this.agents.map((entry, idx) => ({
      index: idx,
      type: entry.type,
      weight: entry.weight,
      winRate: entry.winRate,
      totalTrades: entry.totalTrades,
      recentRewardAvg: entry.recentRewards.length > 0
        ? entry.recentRewards.reduce((a, b) => a + b, 0) / entry.recentRewards.length
        : 0,
    }));

    return {
      agentStats,
      lastAction: this.lastAction,
      lastReward: this.lastReward,
      totalSteps: this.totalSteps,
      episodeCount: this.episodeCount,
    };
  }

  /**
   * Save all agent weights
   */
  async saveWeights(): Promise<SerializedWeights> {
    const agentWeights: unknown[] = [];

    for (const entry of this.agents) {
      const weights = await entry.agent.saveWeights();
      agentWeights.push(weights);
    }

    return {
      weights: [],
      config: {
        ensembleConfig: this.config,
        agentWeights,
        agentMetrics: this.agents.map(e => ({
          type: e.type,
          weight: e.weight,
          winRate: e.winRate,
          totalTrades: e.totalTrades,
        })),
      },
      state: this.getState(),
      agentType: 'ensemble',
    };
  }

  /**
   * Load all agent weights
   */
  async loadWeights(data: SerializedWeights): Promise<void> {
    const agentWeights = (data.config.agentWeights as unknown[]) ?? [];
    const agentMetrics = (data.config.agentMetrics as {
      type: string;
      weight: number;
      winRate: number;
      totalTrades: number;
    }[]) ?? [];

    for (let i = 0; i < Math.min(this.agents.length, agentWeights.length); i++) {
      await this.agents[i]!.agent.loadWeights(agentWeights[i]!);

      // Restore metrics if available
      if (agentMetrics[i]) {
        this.agents[i]!.weight = agentMetrics[i]!.weight;
        this.agents[i]!.winRate = agentMetrics[i]!.winRate;
        this.agents[i]!.totalTrades = agentMetrics[i]!.totalTrades;
      }
    }

    this.totalSteps = data.state.totalSteps;
    this.episodeCount = data.state.episodeCount;
  }

  /**
   * Dispose all agents
   */
  dispose(): void {
    for (const entry of this.agents) {
      entry.agent.dispose();
    }
    this.agents = [];
  }

  /**
   * Get individual agent for advanced usage
   */
  getAgent(type: 'dqn' | 'ppo'): AgentWrapper | undefined {
    const entry = this.agents.find(e => e.type === type);
    return entry?.agent;
  }

  /**
   * Get DQN agent specifically (for type-safe access)
   */
  getDQNAgent(): DQNAgent | undefined {
    const entry = this.agents.find(e => e.type === 'dqn');
    return entry?.agent as unknown as DQNAgent | undefined;
  }

  /**
   * Get PPO agent specifically (for type-safe access)
   */
  getPPOAgent(): PPOAgent | undefined {
    const entry = this.agents.find(e => e.type === 'ppo');
    return entry?.agent as unknown as PPOAgent | undefined;
  }

  /**
   * Get number of agents in ensemble
   */
  getAgentCount(): number {
    return this.agents.length;
  }
}

export interface EnsembleDiagnostics {
  agentStats: {
    index: number;
    type: 'dqn' | 'ppo';
    weight: number;
    winRate: number;
    totalTrades: number;
    recentRewardAvg: number;
  }[];
  lastAction: Action;
  lastReward: number;
  totalSteps: number;
  episodeCount: number;
}
