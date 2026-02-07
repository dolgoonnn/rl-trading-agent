/**
 * Production Configuration
 *
 * Centralized configuration for production paper/live trading.
 * Includes model selection, risk parameters, and notification settings.
 */

import type { RiskLimits } from './risk-manager';
import type { PositionSizingConfig } from './position-sizer';
import type { MetaStrategyEnvConfig } from '../rl/environment/ict-meta-env';

export interface NotificationConfig {
  /** Discord webhook URL for trade notifications */
  discordWebhook?: string;

  /** Telegram bot token */
  telegramBotToken?: string;

  /** Telegram chat ID */
  telegramChatId?: string;

  /** Email for critical alerts */
  alertEmail?: string;

  /** Notification levels: 'all' | 'trades' | 'critical' */
  level: 'all' | 'trades' | 'critical';

  /** Whether to send trade entry notifications */
  notifyOnEntry: boolean;

  /** Whether to send trade exit notifications */
  notifyOnExit: boolean;

  /** Whether to send daily summary */
  sendDailySummary: boolean;

  /** Whether to send risk warnings */
  sendRiskWarnings: boolean;
}

export interface ProductionConfig {
  /** Trading symbol (e.g., 'BTCUSDT') */
  symbol: string;

  /** Path to the trained model file */
  modelPath: string;

  /** Initial capital for paper trading */
  initialCapital: number;

  /** Risk management limits */
  riskLimits: RiskLimits;

  /** Position sizing configuration */
  positionSizing: PositionSizingConfig;

  /** Environment configuration (for ICT detection) */
  envConfig: Partial<MetaStrategyEnvConfig>;

  /** Notification settings */
  notifications: NotificationConfig;

  /** Trading hours (UTC) - only trade during these hours */
  tradingHours?: {
    enabled: boolean;
    startHour: number; // 0-23 UTC
    endHour: number; // 0-23 UTC
  };

  /** WebSocket configuration */
  websocket: {
    /** Reconnect attempts before giving up */
    maxReconnectAttempts: number;
    /** Reconnect delay in ms */
    reconnectDelay: number;
    /** Ping interval in ms */
    pingInterval: number;
  };

  /** Logging configuration */
  logging: {
    /** Log level: 'debug' | 'info' | 'warn' | 'error' */
    level: 'debug' | 'info' | 'warn' | 'error';
    /** Whether to log to file */
    logToFile: boolean;
    /** Log file path */
    logFilePath?: string;
    /** Whether to log each trade */
    logTrades: boolean;
    /** Whether to log KB reasoning */
    logKBReasoning: boolean;
  };

  /** Data persistence */
  persistence: {
    /** Whether to persist trades to database */
    persistTrades: boolean;
    /** Whether to persist performance metrics */
    persistMetrics: boolean;
    /** Database path (SQLite) */
    dbPath?: string;
  };
}

/** Default risk-averse production config */
export const DEFAULT_PRODUCTION_CONFIG: ProductionConfig = {
  symbol: 'BTCUSDT',
  modelPath: 'models/ict_ensemble_multi_latest.json',
  initialCapital: 10000,

  riskLimits: {
    maxDailyLoss: 0.02, // 2% max daily loss
    maxDrawdown: 0.05, // 5% max drawdown
    maxPositionSize: 0.1, // 10% max per position
    maxConcurrentPositions: 1,
    cooldownAfterLoss: 5,
    maxConsecutiveLosses: 3,
    forcedCooldownBars: 20,
    minTimeBetweenTrades: 3,
  },

  positionSizing: {
    baseSize: 0.05, // Start with 5% (conservative)
    minSize: 0.02,
    maxSize: 0.1,
    useKelly: true,
    kellyFraction: 0.25, // Quarter Kelly
    useVolatilityAdjustment: true,
    targetVolatility: 0.02,
    useDrawdownScaling: true,
    drawdownThreshold: 0.03,
    maxDrawdownReduction: 0.5,
    useConfidenceScaling: true,
    minConfidenceForFullSize: 0.6,
  },

  envConfig: {
    initialCapital: 10000,
    positionSizePercent: 0.05,
    commission: 0.001,
    slippage: 0.0005,
    lookbackPeriod: 100,
    maxDrawdownLimit: 0.15,
    maxBarsInPosition: 100,
    kbConfig: {
      enabled: true,
      addKBFeatures: true,
      useKBRewardShaping: false, // Disable reward shaping in production
    },
  },

  notifications: {
    level: 'trades',
    notifyOnEntry: true,
    notifyOnExit: true,
    sendDailySummary: true,
    sendRiskWarnings: true,
  },

  tradingHours: {
    enabled: false, // Trade 24/7 for crypto
    startHour: 8,
    endHour: 20,
  },

  websocket: {
    maxReconnectAttempts: 10,
    reconnectDelay: 5000,
    pingInterval: 30000,
  },

  logging: {
    level: 'info',
    logToFile: true,
    logFilePath: 'logs/trading.log',
    logTrades: true,
    logKBReasoning: false, // Enable for debugging
  },

  persistence: {
    persistTrades: true,
    persistMetrics: true,
    dbPath: 'data/ict-trading.db',
  },
};

/** Aggressive trading config (higher risk, higher potential return) */
export const AGGRESSIVE_CONFIG: Partial<ProductionConfig> = {
  riskLimits: {
    maxDailyLoss: 0.03, // 3%
    maxDrawdown: 0.08, // 8%
    maxPositionSize: 0.15, // 15%
    maxConcurrentPositions: 2,
    cooldownAfterLoss: 3,
    maxConsecutiveLosses: 4,
    forcedCooldownBars: 15,
    minTimeBetweenTrades: 2,
  },
  positionSizing: {
    baseSize: 0.1,
    minSize: 0.05,
    maxSize: 0.15,
    useKelly: true,
    kellyFraction: 0.5, // Half Kelly
    useVolatilityAdjustment: true,
    targetVolatility: 0.025,
    useDrawdownScaling: true,
    drawdownThreshold: 0.04,
    maxDrawdownReduction: 0.4,
    useConfidenceScaling: true,
    minConfidenceForFullSize: 0.5,
  },
};

/** Ultra-conservative config (paper trading / learning) */
export const CONSERVATIVE_CONFIG: Partial<ProductionConfig> = {
  riskLimits: {
    maxDailyLoss: 0.01, // 1%
    maxDrawdown: 0.03, // 3%
    maxPositionSize: 0.05, // 5%
    maxConcurrentPositions: 1,
    cooldownAfterLoss: 10,
    maxConsecutiveLosses: 2,
    forcedCooldownBars: 30,
    minTimeBetweenTrades: 5,
  },
  positionSizing: {
    baseSize: 0.03,
    minSize: 0.01,
    maxSize: 0.05,
    useKelly: false, // Disable Kelly
    kellyFraction: 0.25,
    useVolatilityAdjustment: true,
    targetVolatility: 0.015,
    useDrawdownScaling: true,
    drawdownThreshold: 0.02,
    maxDrawdownReduction: 0.6,
    useConfidenceScaling: true,
    minConfidenceForFullSize: 0.7,
  },
};

/**
 * Load production config from file or use defaults
 */
export function loadProductionConfig(configPath?: string): ProductionConfig {
  if (configPath) {
    try {
      const fs = require('fs');
      const raw = fs.readFileSync(configPath, 'utf-8');
      const loaded = JSON.parse(raw) as Partial<ProductionConfig>;
      return mergeConfig(DEFAULT_PRODUCTION_CONFIG, loaded);
    } catch {
      console.warn(`Failed to load config from ${configPath}, using defaults`);
    }
  }
  return DEFAULT_PRODUCTION_CONFIG;
}

/**
 * Deep merge configuration objects
 */
function mergeConfig(base: ProductionConfig, override: Partial<ProductionConfig>): ProductionConfig {
  const result = { ...base };

  for (const key of Object.keys(override) as (keyof ProductionConfig)[]) {
    const value = override[key];
    if (value !== undefined) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Deep merge for nested objects
        (result[key] as Record<string, unknown>) = {
          ...(base[key] as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      } else {
        (result[key] as unknown) = value;
      }
    }
  }

  return result;
}

/**
 * Validate production config
 */
export function validateProductionConfig(config: ProductionConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Symbol
  if (!config.symbol || config.symbol.length < 3) {
    errors.push('Invalid symbol');
  }

  // Model path
  if (!config.modelPath) {
    errors.push('Model path is required');
  }

  // Initial capital
  if (config.initialCapital <= 0) {
    errors.push('Initial capital must be positive');
  }

  // Risk limits
  if (config.riskLimits.maxDailyLoss <= 0 || config.riskLimits.maxDailyLoss > 1) {
    errors.push('maxDailyLoss must be between 0 and 1');
  }

  if (config.riskLimits.maxDrawdown <= 0 || config.riskLimits.maxDrawdown > 1) {
    errors.push('maxDrawdown must be between 0 and 1');
  }

  if (config.riskLimits.maxPositionSize <= 0 || config.riskLimits.maxPositionSize > 1) {
    errors.push('maxPositionSize must be between 0 and 1');
  }

  // Position sizing
  if (config.positionSizing.maxSize < config.positionSizing.minSize) {
    errors.push('positionSizing.maxSize must be >= minSize');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Symbol-specific config overrides
 */
export const SYMBOL_CONFIGS: Record<string, Partial<ProductionConfig>> = {
  BTCUSDT: {
    envConfig: {
      commission: 0.001,
      slippage: 0.0005,
    },
  },
  ETHUSDT: {
    envConfig: {
      commission: 0.001,
      slippage: 0.0006, // Slightly higher slippage
    },
  },
  SOLUSDT: {
    envConfig: {
      commission: 0.001,
      slippage: 0.0008, // Higher slippage for lower liquidity
    },
    positionSizing: {
      baseSize: 0.04,
      minSize: 0.02,
      maxSize: 0.08,
      useKelly: true,
      kellyFraction: 0.25,
      useVolatilityAdjustment: true,
      targetVolatility: 0.025, // Higher volatility expectation
      useDrawdownScaling: true,
      drawdownThreshold: 0.03,
      maxDrawdownReduction: 0.5,
      useConfidenceScaling: true,
      minConfidenceForFullSize: 0.6,
    },
  },
};

/**
 * Get config for specific symbol
 */
export function getSymbolConfig(symbol: string, baseConfig: ProductionConfig = DEFAULT_PRODUCTION_CONFIG): ProductionConfig {
  const symbolOverride = SYMBOL_CONFIGS[symbol] ?? {};
  return mergeConfig({ ...baseConfig, symbol }, symbolOverride);
}
