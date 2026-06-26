// src/lib/scalp/leverage/simulator.ts
import type { Candle } from '@/types/candle';
import type { TradeTapeEntry, LeverageConfig, LeverageResult } from './types';
import { resolveTradeUnderLeverage } from './liquidation';

/** Compound a leverage config over the tape sequentially; collect curve + stats. */
export function simulateLeverage(
  tape: TradeTapeEntry[],
  candlesBySymbol: Map<string, Candle[]>,
  cfg: LeverageConfig,
): LeverageResult {
  let equity = 1;
  const equityCurve: number[] = [1];
  const multipliers: number[] = [];
  const logMultipliers: number[] = [];
  let liquidations = 0;

  for (const trade of tape) {
    const candles = candlesBySymbol.get(trade.symbol);
    if (!candles) throw new Error(`missing 1m candles for symbol ${trade.symbol}`);
    const outcome = resolveTradeUnderLeverage(trade, candles, cfg);
    if (outcome.liquidated) liquidations++;
    const m = Math.max(outcome.equityMultiplier, 0); // isolated margin: cannot go below 0
    multipliers.push(m);
    // floor avoids log(0) = -Infinity on a full-margin liquidation (multiplier 0); 1e-12 is negligible vs any real multiplier
    logMultipliers.push(Math.log(Math.max(m, 1e-12)));
    equity *= m;
    equityCurve.push(equity);
    if (equity <= 0) break; // absorbing barrier
  }

  const meanLog = logMultipliers.length
    ? logMultipliers.reduce((s, x) => s + x, 0) / logMultipliers.length
    : 0;

  return {
    leverage: cfg.leverage,
    marginFraction: cfg.marginFraction,
    tradeCount: multipliers.length,
    liquidations,
    totalReturn: equity - 1,
    meanLogGrowthPerTrade: meanLog,
    maxDrawdown: maxDrawdown(equityCurve),
    ruinProbability: ruinProbability(multipliers, cfg.ruinThreshold, cfg.mcIterations),
    equityCurve,
  };
}

function maxDrawdown(curve: number[]): number {
  let peak = curve[0] ?? 1;
  let maxDD = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
}

/**
 * Monte Carlo ruin probability: shuffle the per-trade equity multipliers,
 * compound each path, count the fraction whose running equity ever drops below
 * ruinThreshold. (Per-trade multipliers are order-independent; only the
 * compounding sequence changes — the same assumption used by reshuffleTrades.)
 */
export function ruinProbability(
  multipliers: number[],
  ruinThreshold: number,
  iterations: number,
): number {
  if (multipliers.length === 0) return 0;
  let ruined = 0;
  for (let it = 0; it < iterations; it++) {
    const shuffled = shuffle(multipliers);
    let equity = 1;
    let hit = false;
    for (const m of shuffled) {
      equity *= m;
      if (equity < ruinThreshold) { hit = true; break; }
    }
    if (hit) ruined++;
  }
  return ruined / iterations;
}

function shuffle(arr: number[]): number[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]] as [number, number];
  }
  return a;
}
