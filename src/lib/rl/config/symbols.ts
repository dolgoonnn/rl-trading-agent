/**
 * Symbol Configurations
 * Defines data sources and trading costs for each supported asset
 */

export type DataProvider = 'binance' | 'yahoo';

export interface SymbolConfig {
  provider: DataProvider;
  spread: number; // Bid-ask spread as fraction
  commission: number; // Per-trade commission as fraction
  slippage?: number; // Slippage factor (optional, defaults based on provider)
  name?: string; // Human-readable name
  minOrderSize?: number; // Minimum order size
  priceDecimals?: number; // Price decimal places
}

/**
 * Supported symbols with their configurations
 * Costs are realistic estimates for retail trading
 */
export const SYMBOLS: Record<string, SymbolConfig> = {
  // ============================================
  // Crypto (Binance)
  // ============================================
  BTCUSDT: {
    provider: 'binance',
    spread: 0.0001, // 0.01% (very liquid)
    commission: 0.001, // 0.1% maker/taker
    slippage: 0.0003,
    name: 'Bitcoin',
    priceDecimals: 2,
  },
  ETHUSDT: {
    provider: 'binance',
    spread: 0.0001,
    commission: 0.001,
    slippage: 0.0003,
    name: 'Ethereum',
    priceDecimals: 2,
  },
  SOLUSDT: {
    provider: 'binance',
    spread: 0.0002, // Slightly less liquid
    commission: 0.001,
    slippage: 0.0005,
    name: 'Solana',
    priceDecimals: 2,
  },
  BNBUSDT: {
    provider: 'binance',
    spread: 0.0002,
    commission: 0.001,
    slippage: 0.0004,
    name: 'BNB',
    priceDecimals: 2,
  },
  XRPUSDT: {
    provider: 'binance',
    spread: 0.0002,
    commission: 0.001,
    slippage: 0.0004,
    name: 'Ripple',
    priceDecimals: 4,
  },
  ADAUSDT: {
    provider: 'binance',
    spread: 0.0003,
    commission: 0.001,
    slippage: 0.0005,
    name: 'Cardano',
    priceDecimals: 4,
  },
  DOGEUSDT: {
    provider: 'binance',
    spread: 0.0003,
    commission: 0.001,
    slippage: 0.0005,
    name: 'Dogecoin',
    priceDecimals: 5,
  },
  AVAXUSDT: {
    provider: 'binance',
    spread: 0.0003,
    commission: 0.001,
    slippage: 0.0005,
    name: 'Avalanche',
    priceDecimals: 2,
  },
  LINKUSDT: {
    provider: 'binance',
    spread: 0.0003,
    commission: 0.001,
    slippage: 0.0005,
    name: 'Chainlink',
    priceDecimals: 2,
  },
  DOTUSDT: {
    provider: 'binance',
    spread: 0.0003,
    commission: 0.001,
    slippage: 0.0005,
    name: 'Polkadot',
    priceDecimals: 2,
  },
  MATICUSDT: {
    provider: 'binance',
    spread: 0.0003,
    commission: 0.001,
    slippage: 0.0005,
    name: 'Polygon',
    priceDecimals: 4,
  },
  LTCUSDT: {
    provider: 'binance',
    spread: 0.0002,
    commission: 0.001,
    slippage: 0.0004,
    name: 'Litecoin',
    priceDecimals: 2,
  },
  ATOMUSDT: {
    provider: 'binance',
    spread: 0.0003,
    commission: 0.001,
    slippage: 0.0005,
    name: 'Cosmos',
    priceDecimals: 3,
  },
  NEARUSDT: {
    provider: 'binance',
    spread: 0.0004,
    commission: 0.001,
    slippage: 0.0006,
    name: 'NEAR Protocol',
    priceDecimals: 3,
  },
  FILUSDT: {
    provider: 'binance',
    spread: 0.0004,
    commission: 0.001,
    slippage: 0.0006,
    name: 'Filecoin',
    priceDecimals: 3,
  },
  APTUSDT: {
    provider: 'binance',
    spread: 0.0004,
    commission: 0.001,
    slippage: 0.0006,
    name: 'Aptos',
    priceDecimals: 2,
  },
  ARBUSDT: {
    provider: 'binance',
    spread: 0.0004,
    commission: 0.001,
    slippage: 0.0006,
    name: 'Arbitrum',
    priceDecimals: 4,
  },
  UNIUSDT: {
    provider: 'binance',
    spread: 0.0003,
    commission: 0.001,
    slippage: 0.0005,
    name: 'Uniswap',
    priceDecimals: 3,
  },
  AAVEUSDT: {
    provider: 'binance',
    spread: 0.0004,
    commission: 0.001,
    slippage: 0.0006,
    name: 'Aave',
    priceDecimals: 2,
  },
  ICPUSDT: {
    provider: 'binance',
    spread: 0.0004,
    commission: 0.001,
    slippage: 0.0006,
    name: 'Internet Computer',
    priceDecimals: 2,
  },

  // ============================================
  // Forex Major Pairs (Yahoo Finance)
  // Forex has tighter spreads but different dynamics
  // ============================================
  'EURUSD=X': {
    provider: 'yahoo',
    spread: 0.00005, // ~0.5 pips
    commission: 0.00005, // Very low for forex
    slippage: 0.00003,
    name: 'EUR/USD',
    priceDecimals: 5,
  },
  'GBPUSD=X': {
    provider: 'yahoo',
    spread: 0.00008, // ~0.8 pips
    commission: 0.00005,
    slippage: 0.00005,
    name: 'GBP/USD',
    priceDecimals: 5,
  },
  'USDJPY=X': {
    provider: 'yahoo',
    spread: 0.00008, // ~0.8 pips
    commission: 0.00005,
    slippage: 0.00005,
    name: 'USD/JPY',
    priceDecimals: 3,
  },
  'AUDUSD=X': {
    provider: 'yahoo',
    spread: 0.0001, // ~1 pip
    commission: 0.00005,
    slippage: 0.00006,
    name: 'AUD/USD',
    priceDecimals: 5,
  },

  // ============================================
  // Commodities (Yahoo Finance)
  // ============================================
  'GC=F': {
    provider: 'yahoo',
    spread: 0.0003, // Gold has wider spreads
    commission: 0.0001,
    slippage: 0.0002,
    name: 'Gold (XAUUSD)',
    priceDecimals: 2,
  },
};

/**
 * Get all symbols for a specific provider
 */
export function getSymbolsByProvider(provider: DataProvider): string[] {
  return Object.entries(SYMBOLS)
    .filter(([_, config]) => config.provider === provider)
    .map(([symbol]) => symbol);
}

/**
 * Get all crypto symbols
 */
export function getCryptoSymbols(): string[] {
  return getSymbolsByProvider('binance');
}

/**
 * Get all forex symbols
 */
export function getForexSymbols(): string[] {
  return Object.entries(SYMBOLS)
    .filter(([symbol, config]) => config.provider === 'yahoo' && symbol.endsWith('=X'))
    .map(([symbol]) => symbol);
}

/**
 * Get all commodity symbols
 */
export function getCommoditySymbols(): string[] {
  return Object.entries(SYMBOLS)
    .filter(([symbol, config]) => config.provider === 'yahoo' && symbol.endsWith('=F'))
    .map(([symbol]) => symbol);
}

/**
 * Get environment config overrides for a symbol
 */
export function getEnvConfigForSymbol(symbol: string): {
  spread: number;
  commission: number;
  slippage: number;
} {
  const config = SYMBOLS[symbol];
  if (!config) {
    // Default to crypto-like costs
    return { spread: 0.0001, commission: 0.001, slippage: 0.0005 };
  }
  return {
    spread: config.spread,
    commission: config.commission,
    slippage: config.slippage ?? 0.0005,
  };
}

/**
 * Normalize symbol for file naming (remove special chars)
 */
export function normalizeSymbolName(symbol: string): string {
  return symbol.replace(/[=]/g, '_');
}
