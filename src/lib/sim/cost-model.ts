import { frictionForExitSide, type MakerTakerConfig } from '@/lib/cost/trade-cost';
import type { CostContext } from './types';

export interface CostModel {
  apply(refPrice: number, direction: 'long' | 'short', ctx: CostContext): number;
}

/** Sign of the price markup: entry-long / exit-short push price UP; the others DOWN. */
function markup(direction: 'long' | 'short', side: 'entry' | 'exit'): 1 | -1 {
  const up = (direction === 'long' && side === 'entry') || (direction === 'short' && side === 'exit');
  return up ? 1 : -1;
}

/**
 * Reproduces scripts/backtest-confluence.ts applyEntryFriction/applyExitFriction
 * exactly: entry is taker; exit pays maker or taker per ctx.exitSide. With no
 * split, the blended frictionPerSide is used on both legs.
 */
export class FlatFrictionCostModel implements CostModel {
  constructor(private frictionPerSide: number, private makerTaker: MakerTakerConfig | null = null) {}

  apply(refPrice: number, direction: 'long' | 'short', ctx: CostContext): number {
    const side = ctx.side === 'entry' ? 'taker' : (ctx.exitSide ?? 'taker');
    const friction = this.makerTaker === null ? this.frictionPerSide : frictionForExitSide(side, this.makerTaker);
    return refPrice * (1 + markup(direction, ctx.side) * friction);
  }
}

/**
 * Calibratable model: taker/maker fee + half-spread (always), plus square-root
 * market impact gated on order size vs bar volume, capped at maxFillVolumeFrac.
 */
export class SpreadFeeImpactCostModel implements CostModel {
  constructor(private cfg: { takerFee: number; makerFee: number; impactCoef: number; maxFillVolumeFrac: number }) {}

  apply(refPrice: number, direction: 'long' | 'short', ctx: CostContext): number {
    const fee = ctx.side === 'entry' ? this.cfg.takerFee : (ctx.exitSide === 'maker' ? this.cfg.makerFee : this.cfg.takerFee);
    const halfSpread = ctx.halfSpread ?? 0;

    let impact = 0;
    if (ctx.barVolume && ctx.orderQty && ctx.barVolume > 0) {
      const frac = Math.min(ctx.orderQty / ctx.barVolume, this.cfg.maxFillVolumeFrac);
      const sigma = ctx.volatility ?? 1; // caller injects per-bar vol; 1 keeps it size-only when absent
      impact = this.cfg.impactCoef * sigma * Math.sqrt(frac);
    }

    const cost = fee + halfSpread + impact;
    return refPrice * (1 + markup(direction, ctx.side) * cost);
  }
}
