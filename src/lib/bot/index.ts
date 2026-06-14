export { DataFeed } from './data-feed';
export { SignalEngine } from './signal-engine';
export { OrderManager } from './order-manager';
export { PositionTracker } from './position-tracker';
export { RiskEngine } from './risk-engine';
export { AlertManager } from './alerts';
export { FundingDataFeed } from './funding-data-feed';
export { FundingArbEngine } from './funding-arb-engine';
export { FundingArbTracker } from './funding-arb-tracker';
export { FundingArbBot } from './funding-arb-bot';
export { LTFConfirmation } from './ltf-confirmation';
export { LimitOrderExecutor, DEFAULT_LIMIT_ORDER_CONFIG } from './limit-order-executor';
export type { PendingLimitOrder, LimitOrderConfig } from './limit-order-executor';

// Review / observability layer (read-or-append only — no live-trading path)
export {
  bucketConfluence,
  decomposePnlCells,
  coldCohortScan,
  materializePnlCells,
  readReviewTrades,
  MIN_CELL_N,
  FUNDING_PCT_TRAP,
  MIN_COHORT_N,
} from './review';
export type {
  ConfluenceBucket,
  ReviewTradeRow,
  PnlCell,
  CohortStat,
} from './review';

// Decision log + skipped-signal logging (append-only API surface)
export {
  appendDecisionLog,
  logSkippedSignal,
  readDecisionLog,
  readSkippedSignals,
} from './decision-log';
export type {
  BotDb,
  AppendDecisionLogArgs,
  LogSkippedSignalArgs,
} from './decision-log';
export {
  DEFAULT_BOT_CONFIG,
  RUN20_STRATEGY_CONFIG,
  DEFAULT_CIRCUIT_BREAKERS,
  DEFAULT_RISK_CONFIG,
  DEFAULT_LTF_CONFIG,
  DEFAULT_FUNDING_ARB_CONFIG,
  SYMBOL_ALLOCATION,
} from './config';
