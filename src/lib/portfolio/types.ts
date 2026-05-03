export type StrategyId = 'ict-3sym' | 'ict-7sym' | 'f2f-gold';

export interface EquityPoint {
  timestamp: number; // ms epoch
  equity: number;
}

export interface StrategyAllocation {
  strategy: StrategyId;
  weight: number; // [0, 1]
  annualizedVol: number; // e.g., 0.45 = 45%/yr
  recommendedRiskPerTrade: number; // e.g., 0.0018 = 0.18%
  currentRiskPerTrade: number;
  excluded?: { reason: string };
}

export interface AllocatorResult {
  generatedAt: number;
  lookbackDays: number;
  totalCurrentRiskBudget: number;
  allocations: StrategyAllocation[];
  warnings: string[];
}

export interface DecayStatus {
  strategy: StrategyId;
  liveSharpe30d: number | null;
  bootstrapFloor: number | null;
  liveDrawdown90d: number | null;
  drawdownCeiling: number | null;
  tripped: boolean;
  reason?: string;
}

export interface MonitorResult {
  generatedAt: number;
  statuses: DecayStatus[];
  warnings: string[];
}
