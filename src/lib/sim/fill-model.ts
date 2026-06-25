import type { BarFillRequest, FillResult, CostContext } from './types';
import { pessimisticResolve, ohlcHeuristicResolve, subBarResolve } from './intrabar';
import type { CostModel } from './cost-model';

export interface FillModel {
  /** Resolve whether/where this bar exits. null = still open. Records the tier used. */
  resolveExit(req: BarFillRequest): FillResult | null;
  /** Realized fill price after cost for an order at refPrice. */
  applyCost(refPrice: number, side: 'entry' | 'exit', dir: 'long' | 'short', ctx: Omit<CostContext, 'side'>): number;
}

/**
 * Best-available-wins with a guaranteed floor:
 *   subBars present        -> subbar_1m
 *   else allowHeuristic    -> ohlc_heuristic
 *   else                   -> pessimistic
 * The l2_depth rung is reserved for Spec 3 (event-driven engine); it is not
 * selectable here because latency/queue require the event loop.
 */
export class DefaultFillModel implements FillModel {
  constructor(private readonly cost: CostModel, private readonly opts: { allowHeuristic?: boolean } = {}) {}

  resolveExit(req: BarFillRequest): FillResult | null {
    if (req.subBars && req.subBars.length > 0) return subBarResolve(req);
    if (this.opts.allowHeuristic) return ohlcHeuristicResolve(req);
    return pessimisticResolve(req);
  }

  applyCost(refPrice: number, side: 'entry' | 'exit', dir: 'long' | 'short', ctx: Omit<CostContext, 'side'>): number {
    return this.cost.apply(refPrice, dir, { ...ctx, side });
  }
}
