/**
 * CMA-ES (Covariance Matrix Adaptation Evolution Strategy)
 *
 * Gradient-free, population-based optimizer for continuous spaces.
 * Excellent for 5-30 dimensional optimization problems.
 *
 * Key properties:
 * - No gradients needed (avoids sparse reward problem)
 * - Population-based (naturally explores diverse solutions)
 * - Adapts search distribution via covariance matrix
 * - Invariant to monotonic transformations of fitness
 *
 * Reference: Hansen & Ostermeier (2001) "Completely Derandomized
 * Self-Adaptation in Evolution Strategies"
 */

export interface CMAESConfig {
  /** Dimensionality of the search space */
  dim: number;
  /** Population size (lambda). Default: 4 + floor(3 * ln(dim)) */
  populationSize?: number;
  /** Initial step size (sigma). Default: 0.5 */
  initialSigma?: number;
  /** Initial mean of the search distribution */
  initialMean?: number[];
  /** Lower bounds for each dimension (optional) */
  lowerBounds?: number[];
  /** Upper bounds for each dimension (optional) */
  upperBounds?: number[];
  /** Maximum generations */
  maxGenerations: number;
  /** Seed for reproducibility (optional) */
  seed?: number;
}

export interface CMAESCandidate {
  /** Parameter vector */
  params: number[];
  /** Fitness value (higher is better) */
  fitness: number;
}

export interface CMAESResult {
  /** Best solution found */
  bestParams: number[];
  /** Best fitness achieved */
  bestFitness: number;
  /** Generation where best was found */
  bestGeneration: number;
  /** Fitness history per generation [mean, best] */
  history: Array<{ generation: number; meanFitness: number; bestFitness: number; sigma: number }>;
}

/**
 * Simplified CMA-ES implementation optimized for small dimensions (5-30).
 *
 * Uses diagonal covariance approximation for simplicity and robustness.
 * Full covariance is overkill for <30 dimensions and can be numerically unstable.
 */
export class CMAES {
  private dim: number;
  private lambda: number; // population size
  private mu: number;     // number of parents
  private sigma: number;  // step size
  private mean: number[]; // distribution mean
  private diagC: number[]; // diagonal covariance (variance per dimension)
  private ps: number[];   // evolution path for sigma
  private pc: number[];   // evolution path for covariance
  private weights: number[]; // recombination weights
  private muEff: number;  // variance effective selection mass
  private cs: number;     // sigma learning rate
  private ds: number;     // sigma damping
  private cc: number;     // covariance learning rate
  private c1: number;     // rank-one update rate
  private cmu: number;    // rank-mu update rate
  private chiN: number;   // expected norm of N(0,I)
  private lowerBounds: number[];
  private upperBounds: number[];
  private maxGenerations: number;
  private generation: number;
  private bestParams: number[];
  private bestFitness: number;
  private bestGeneration: number;
  private history: CMAESResult['history'];

  constructor(config: CMAESConfig) {
    this.dim = config.dim;
    this.lambda = config.populationSize ?? (4 + Math.floor(3 * Math.log(config.dim)));
    this.mu = Math.floor(this.lambda / 2);
    this.sigma = config.initialSigma ?? 0.5;
    this.mean = config.initialMean ?? new Array(config.dim).fill(0);
    this.lowerBounds = config.lowerBounds ?? new Array(config.dim).fill(-Infinity);
    this.upperBounds = config.upperBounds ?? new Array(config.dim).fill(Infinity);
    this.maxGenerations = config.maxGenerations;

    // Initialize covariance (identity)
    this.diagC = new Array(config.dim).fill(1);

    // Evolution paths
    this.ps = new Array(config.dim).fill(0);
    this.pc = new Array(config.dim).fill(0);

    // Recombination weights (log-linear)
    this.weights = [];
    for (let i = 0; i < this.mu; i++) {
      this.weights.push(Math.log(this.mu + 0.5) - Math.log(i + 1));
    }
    const wSum = this.weights.reduce((a, b) => a + b, 0);
    this.weights = this.weights.map(w => w / wSum);

    // Variance effective selection mass
    this.muEff = 1 / this.weights.reduce((a, w) => a + w * w, 0);

    // Learning rates
    this.cs = (this.muEff + 2) / (this.dim + this.muEff + 5);
    this.ds = 1 + 2 * Math.max(0, Math.sqrt((this.muEff - 1) / (this.dim + 1)) - 1) + this.cs;
    this.cc = (4 + this.muEff / this.dim) / (this.dim + 4 + 2 * this.muEff / this.dim);
    this.c1 = 2 / ((this.dim + 1.3) * (this.dim + 1.3) + this.muEff);
    this.cmu = Math.min(1 - this.c1, 2 * (this.muEff - 2 + 1 / this.muEff) / ((this.dim + 2) * (this.dim + 2) + this.muEff));

    // Expected norm of N(0,I)
    this.chiN = Math.sqrt(this.dim) * (1 - 1 / (4 * this.dim) + 1 / (21 * this.dim * this.dim));

    this.generation = 0;
    this.bestParams = [...this.mean];
    this.bestFitness = -Infinity;
    this.bestGeneration = 0;
    this.history = [];
  }

  /** Sample a new population of candidates */
  samplePopulation(): number[][] {
    const population: number[][] = [];

    for (let i = 0; i < this.lambda; i++) {
      const candidate = new Array(this.dim);
      for (let j = 0; j < this.dim; j++) {
        // Sample from N(mean, sigma^2 * C)
        const z = gaussianRandom();
        candidate[j] = this.mean[j]! + this.sigma * Math.sqrt(this.diagC[j]!) * z;
        // Clamp to bounds
        candidate[j] = Math.max(this.lowerBounds[j]!, Math.min(this.upperBounds[j]!, candidate[j]!));
      }
      population.push(candidate);
    }

    return population;
  }

  /** Update the search distribution based on fitness evaluations */
  update(population: number[][], fitnesses: number[]): void {
    // Sort by fitness (descending — higher is better)
    const indices = Array.from({ length: this.lambda }, (_, i) => i);
    indices.sort((a, b) => fitnesses[b]! - fitnesses[a]!);

    // Track best
    const genBest = fitnesses[indices[0]!]!;
    const genMean = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;

    if (genBest > this.bestFitness) {
      this.bestFitness = genBest;
      this.bestParams = [...population[indices[0]!]!];
      this.bestGeneration = this.generation;
    }

    this.history.push({
      generation: this.generation,
      meanFitness: genMean,
      bestFitness: genBest,
      sigma: this.sigma,
    });

    // Compute weighted mean of selected points
    const oldMean = [...this.mean];
    const newMean = new Array(this.dim).fill(0);

    for (let i = 0; i < this.mu; i++) {
      const idx = indices[i]!;
      const w = this.weights[i]!;
      for (let j = 0; j < this.dim; j++) {
        newMean[j] += w * population[idx]![j]!;
      }
    }
    this.mean = newMean;

    // Mean displacement
    const dy = new Array(this.dim);
    for (let j = 0; j < this.dim; j++) {
      dy[j] = (newMean[j]! - oldMean[j]!) / this.sigma;
    }

    // Update evolution path for sigma (conjugate)
    const sqrtCs = Math.sqrt(this.cs * (2 - this.cs) * this.muEff);
    for (let j = 0; j < this.dim; j++) {
      this.ps[j] = (1 - this.cs) * this.ps[j]! + sqrtCs * dy[j]! / Math.sqrt(this.diagC[j]!);
    }

    // Update sigma
    const psNorm = Math.sqrt(this.ps.reduce((a, v) => a + v! * v!, 0));
    this.sigma *= Math.exp((this.cs / this.ds) * (psNorm / this.chiN - 1));

    // Clamp sigma to prevent explosion/collapse
    this.sigma = Math.max(1e-8, Math.min(2.0, this.sigma));

    // Update evolution path for covariance
    const hsig = psNorm / Math.sqrt(1 - Math.pow(1 - this.cs, 2 * (this.generation + 1))) < (1.4 + 2 / (this.dim + 1)) * this.chiN ? 1 : 0;
    const sqrtCc = Math.sqrt(this.cc * (2 - this.cc) * this.muEff);

    for (let j = 0; j < this.dim; j++) {
      this.pc[j] = (1 - this.cc) * this.pc[j]! + hsig * sqrtCc * dy[j]!;
    }

    // Update diagonal covariance
    for (let j = 0; j < this.dim; j++) {
      // Rank-one update
      let newC = (1 - this.c1 - this.cmu) * this.diagC[j]!;
      newC += this.c1 * (this.pc[j]! * this.pc[j]! + (1 - hsig) * this.cc * (2 - this.cc) * this.diagC[j]!);

      // Rank-mu update
      for (let i = 0; i < this.mu; i++) {
        const idx = indices[i]!;
        const zj = (population[idx]![j]! - oldMean[j]!) / (this.sigma * Math.sqrt(this.diagC[j]!));
        newC += this.cmu * this.weights[i]! * zj * zj * this.diagC[j]!;
      }

      this.diagC[j] = Math.max(1e-10, newC);
    }

    this.generation++;
  }

  /** Get current generation number */
  getGeneration(): number {
    return this.generation;
  }

  /** Get current sigma (step size) */
  getSigma(): number {
    return this.sigma;
  }

  /** Get current mean of the search distribution */
  getMean(): number[] {
    return [...this.mean];
  }

  /** Get current best result */
  getBest(): { params: number[]; fitness: number; generation: number } {
    return {
      params: [...this.bestParams],
      fitness: this.bestFitness,
      generation: this.bestGeneration,
    };
  }

  /** Get full result with history */
  getResult(): CMAESResult {
    return {
      bestParams: [...this.bestParams],
      bestFitness: this.bestFitness,
      bestGeneration: this.bestGeneration,
      history: [...this.history],
    };
  }

  /** Check if optimization should terminate */
  shouldStop(): boolean {
    if (this.generation >= this.maxGenerations) return true;

    // Early stop if sigma is very small (converged)
    if (this.sigma < 1e-6) return true;

    // Early stop if no improvement for many generations
    if (this.history.length > 20) {
      const recent = this.history.slice(-20);
      const oldBest = recent[0]!.bestFitness;
      const newBest = recent[recent.length - 1]!.bestFitness;
      if (Math.abs(newBest - oldBest) < 1e-8) return true;
    }

    return false;
  }
}

/** Box-Muller transform for Gaussian random numbers */
function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
