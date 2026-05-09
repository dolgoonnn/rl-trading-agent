export interface WfWindow {
  startMs: number;
  endMs: number;
}

export interface ValidationCheck {
  name: string;
  value: string;
  threshold: string;
  pass: boolean;
}

export interface ValidationResult {
  timestamp: string;
  dataRange: { start: string; end: string; bars: number };
  config: Record<string, unknown>;
  checks: ValidationCheck[];
  details: {
    totalTrades: number;
    totalFundingCollected: number;
    netPnl: number;
    sharpe: number;
    deflatedSharpe: number;
    bootstrapSharpe5: number;
    bootstrapPnl5Pct: number;
    skip20PassRate: number;
    wfWindowsPass: number;
    wfWindowsTotal: number;
  };
}
