/**
 * Paper Trading Module
 * Live paper trading system for validating KB-enhanced RL agents
 */

// Types
export * from './types';

// Components
export { BinanceWebSocket } from './binance-ws';
export { CandleManager } from './candle-manager';
export { PaperTrader } from './paper-trader';
export { TradeLogger, getAllSessions, getActiveSessions, getSessionById } from './trade-logger';

// Repository
export { type PaperTradingRepository } from './repository';
export { createRepository } from './create-repository';
export { PerformanceMonitor } from './performance-monitor';
export {
  PositionManager,
  createPositionManager,
  shouldExitOnStructure,
  type PositionManagerConfig,
  type PositionUpdate,
  type PositionManagerState,
} from './position-manager';

// Risk Management
export {
  RiskManager,
  DEFAULT_RISK_LIMITS,
  type RiskLimits,
  type RiskState,
  type RiskCheckResult,
} from './risk-manager';

// Position Sizing
export {
  PositionSizer,
  DEFAULT_POSITION_SIZING_CONFIG,
  type PositionSizingConfig,
  type PositionSizeInput,
  type PositionSizeResult,
} from './position-sizer';

// Production Config
export {
  DEFAULT_PRODUCTION_CONFIG,
  AGGRESSIVE_CONFIG,
  CONSERVATIVE_CONFIG,
  SYMBOL_CONFIGS,
  loadProductionConfig,
  validateProductionConfig,
  getSymbolConfig,
  type ProductionConfig,
  type NotificationConfig,
} from './production-config';
