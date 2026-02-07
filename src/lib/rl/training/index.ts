// Training module exports
export { Trainer, backtestAgent, type TrainingResult, type BacktestResult, type TrainerCallbacks, type WalkForwardMetrics } from './trainer';
export { Evaluator, type PerformanceMetrics } from './evaluator';
export {
  DataAugmentor,
  combineAugmentedDatasets,
  createCurriculumSamples,
  type AugmentationConfig,
  type AugmentationStats,
} from './data-augmentation';
export {
  MultiSymbolTrainer,
  type MultiSymbolConfig,
  type MultiSymbolResult,
  type MultiSymbolMetrics,
  type SymbolData,
} from './multi-symbol-trainer';
export {
  OfflineTrainer,
  type CQLConfig,
  type OfflineTrainingResult,
} from './offline-trainer';
export {
  CurriculumTrainer,
  type CurriculumPhase,
  type CurriculumConfig,
  type CurriculumTrainerCallbacks,
  type CurriculumTrainingResult,
  type CurriculumStats,
} from './curriculum-trainer';
