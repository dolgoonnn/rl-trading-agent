/**
 * Base Agent Interface
 * Abstract interface for RL agents (DQN, PPO, etc.)
 */

import type { Action, AgentState } from '../types';

/**
 * Serialized weights format for saving/loading models
 */
export interface SerializedWeights {
  weights: { shape: number[]; data: number[] }[];
  config: Record<string, unknown>;
  state: AgentState;
  agentType: string;
}

/**
 * Base interface all agents must implement
 */
export interface BaseAgent {
  /**
   * Select an action given the current state
   * @param state Flattened state features
   * @param training Whether in training mode (affects exploration)
   */
  selectAction(state: number[], training: boolean): Action;

  /**
   * Train the agent on stored experiences
   * @returns Training loss (or 0 if not ready to train)
   */
  train(): number;

  /**
   * Called at the end of each episode for cleanup/updates
   */
  endEpisode(): void;

  /**
   * Get current agent state (epsilon, step count, etc.)
   */
  getState(): AgentState;

  /**
   * Save model weights to serializable format
   */
  saveWeights(): Promise<SerializedWeights>;

  /**
   * Load model weights from serialized format
   */
  loadWeights(data: SerializedWeights): Promise<void>;

  /**
   * Clean up resources (dispose tensors, etc.)
   */
  dispose(): void;
}

/**
 * Agent that uses experience replay
 */
export interface ReplayAgent extends BaseAgent {
  /**
   * Store an experience transition
   */
  storeExperience(
    state: number[],
    action: Action,
    reward: number,
    nextState: number[],
    done: boolean
  ): void;
}

/**
 * Agent that uses on-policy rollouts (PPO)
 */
export interface RolloutAgent extends BaseAgent {
  /**
   * Store a step in the rollout buffer
   */
  storeStep(
    state: number[],
    action: Action,
    reward: number,
    value: number,
    logProb: number,
    done: boolean
  ): void;

  /**
   * Complete rollout and train
   * @param lastValue Value estimate for the last state
   */
  completeRollout(lastValue: number): number;
}

/**
 * Agent type enum for factory pattern
 */
export type AgentType = 'dqn' | 'ppo';
