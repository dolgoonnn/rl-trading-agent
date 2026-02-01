/**
 * Experience Replay Buffer
 * Stores and samples transitions for DQN training
 */

import type { Transition, Action, ReplayBufferConfig } from '../types';

const DEFAULT_CONFIG: ReplayBufferConfig = {
  capacity: 100000,
  batchSize: 64,
  minExperience: 1000,
};

export { ReplayBufferConfig };

export class ReplayBuffer {
  private buffer: Transition[];
  private config: ReplayBufferConfig;
  private position: number = 0;
  private size: number = 0;

  constructor(config: Partial<ReplayBufferConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.buffer = new Array(this.config.capacity);
  }

  /**
   * Store a new transition
   */
  store(
    state: number[],
    action: Action,
    reward: number,
    nextState: number[],
    done: boolean
  ): void {
    const transition: Transition = {
      state: [...state], // Copy to prevent mutation
      action,
      reward,
      nextState: [...nextState],
      done,
    };

    this.buffer[this.position] = transition;
    this.position = (this.position + 1) % this.config.capacity;
    this.size = Math.min(this.size + 1, this.config.capacity);
  }

  /**
   * Sample a random batch of transitions
   */
  sample(batchSize?: number): Transition[] {
    const size = batchSize ?? this.config.batchSize;

    if (this.size < size) {
      throw new Error(`Not enough experiences. Have ${this.size}, need ${size}`);
    }

    const batch: Transition[] = [];
    const indices = new Set<number>();

    while (indices.size < size) {
      const idx = Math.floor(Math.random() * this.size);
      if (!indices.has(idx)) {
        indices.add(idx);
        const transition = this.buffer[idx];
        if (transition) {
          batch.push(transition);
        }
      }
    }

    return batch;
  }

  /**
   * Check if buffer has enough experiences for training
   */
  isReady(): boolean {
    return this.size >= this.config.minExperience;
  }

  /**
   * Get current buffer size
   */
  getSize(): number {
    return this.size;
  }

  /**
   * Get buffer capacity
   */
  getCapacity(): number {
    return this.config.capacity;
  }

  /**
   * Clear all stored experiences
   */
  clear(): void {
    this.buffer = new Array(this.config.capacity);
    this.position = 0;
    this.size = 0;
  }

  /**
   * Get statistics about the buffer
   */
  getStats(): BufferStats {
    if (this.size === 0) {
      return {
        size: 0,
        capacity: this.config.capacity,
        fillPercent: 0,
        avgReward: 0,
        minReward: 0,
        maxReward: 0,
        doneCount: 0,
      };
    }

    let totalReward = 0;
    let minReward = Infinity;
    let maxReward = -Infinity;
    let doneCount = 0;

    for (let i = 0; i < this.size; i++) {
      const t = this.buffer[i]!;
      totalReward += t.reward;
      minReward = Math.min(minReward, t.reward);
      maxReward = Math.max(maxReward, t.reward);
      if (t.done) doneCount++;
    }

    return {
      size: this.size,
      capacity: this.config.capacity,
      fillPercent: (this.size / this.config.capacity) * 100,
      avgReward: totalReward / this.size,
      minReward,
      maxReward,
      doneCount,
    };
  }

  /**
   * Export buffer to serializable format
   */
  export(): SerializedBuffer {
    return {
      transitions: this.buffer.slice(0, this.size),
      position: this.position,
      size: this.size,
      config: this.config,
    };
  }

  /**
   * Import buffer from serialized format
   */
  static import(data: SerializedBuffer): ReplayBuffer {
    const buffer = new ReplayBuffer(data.config);
    buffer.buffer = [...data.transitions, ...new Array(data.config.capacity - data.transitions.length)];
    buffer.position = data.position;
    buffer.size = data.size;
    return buffer;
  }
}

export interface BufferStats {
  size: number;
  capacity: number;
  fillPercent: number;
  avgReward: number;
  minReward: number;
  maxReward: number;
  doneCount: number;
}

export interface SerializedBuffer {
  transitions: Transition[];
  position: number;
  size: number;
  config: ReplayBufferConfig;
}

/**
 * Prioritized Replay Buffer (optional upgrade)
 * Uses TD error for sampling priority
 */
export class PrioritizedReplayBuffer extends ReplayBuffer {
  private priorities: number[];
  private alpha: number; // Priority exponent
  private beta: number; // Importance sampling exponent
  private betaIncrement: number;
  private currentPosition: number = 0; // Track position for priority updates

  constructor(
    config: Partial<ReplayBufferConfig> = {},
    alpha: number = 0.6,
    beta: number = 0.4,
    betaIncrement: number = 0.001
  ) {
    super(config);
    this.priorities = new Array(this.getCapacity()).fill(1.0);
    this.alpha = alpha;
    this.beta = beta;
    this.betaIncrement = betaIncrement;
  }

  /**
   * Store with initial max priority
   * Uses proper position tracking instead of broken getSize() % getCapacity()
   */
  override store(
    state: number[],
    action: Action,
    reward: number,
    nextState: number[],
    done: boolean
  ): void {
    const maxPriority = Math.max(...this.priorities.slice(0, Math.max(1, this.getSize())), 1.0);
    // Use tracked position, not getSize() which gives wrong index after buffer wraps
    this.priorities[this.currentPosition] = maxPriority;
    super.store(state, action, reward, nextState, done);
    // Advance position with wraparound
    this.currentPosition = (this.currentPosition + 1) % this.getCapacity();
  }

  /**
   * Sample with priority-based probability
   */
  override sample(batchSize?: number): Transition[] {
    return this.sampleWithIndices(batchSize).batch;
  }

  /**
   * Sample with priority-based probability and return indices for later priority update
   * Also returns importance sampling weights for loss correction
   */
  sampleWithIndices(batchSize?: number): {
    batch: Transition[];
    indices: number[];
    weights: number[];
  } {
    const size = batchSize ?? 64;

    if (this.getSize() < size) {
      throw new Error(`Not enough experiences`);
    }

    // Calculate sampling probabilities
    const totalPriority = this.priorities
      .slice(0, this.getSize())
      .reduce((a, b) => a + Math.pow(b, this.alpha), 0);

    const probabilities = this.priorities
      .slice(0, this.getSize())
      .map((p) => Math.pow(p, this.alpha) / totalPriority);

    // Sample based on probabilities
    const batch: Transition[] = [];
    const indices: number[] = [];
    const sampledProbs: number[] = [];

    while (batch.length < size) {
      const rand = Math.random();
      let cumProb = 0;

      for (let i = 0; i < this.getSize(); i++) {
        cumProb += probabilities[i]!;
        if (rand <= cumProb && !indices.includes(i)) {
          const t = (this as unknown as { buffer: Transition[] }).buffer[i];
          if (t) {
            batch.push(t);
            indices.push(i);
            sampledProbs.push(probabilities[i]!);
          }
          break;
        }
      }
    }

    // Calculate importance sampling weights
    // w_i = (N * P(i))^(-beta) / max(w)
    const N = this.getSize();
    const rawWeights = sampledProbs.map((p) => Math.pow(N * p, -this.beta));
    const maxWeight = Math.max(...rawWeights);
    const weights = rawWeights.map((w) => w / maxWeight);

    // Anneal beta
    this.beta = Math.min(1.0, this.beta + this.betaIncrement);

    return { batch, indices, weights };
  }

  /**
   * Update priorities based on TD errors
   */
  updatePriorities(indices: number[], tdErrors: number[]): void {
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]!;
      const error = tdErrors[i]!;
      this.priorities[idx] = Math.abs(error) + 0.01; // Small constant to ensure non-zero
    }
  }
}
