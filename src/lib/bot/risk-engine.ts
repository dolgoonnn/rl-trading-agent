/**
 * Risk Engine — Circuit Breakers, Drawdown Tiers & Position Sizing
 *
 * Enforces risk management rules:
 * - Daily/weekly loss limits (circuit breakers)
 * - Max drawdown from peak
 * - Consecutive loss limits
 * - System error rate limits
 * - Max concurrent positions
 * - Graduated drawdown tiers (reduce sizing as DD increases)
 * - Regime-aware position sizing
 * - Rolling Sharpe-based sizing adjustment
 *
 * Circuit breakers pause trading for a defined period when triggered.
 * Drawdown tiers and regime multipliers reduce position size gradually.
 */

import type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  DrawdownTier,
  RiskConfig,
  BotSymbol,
} from '@/types/bot';
import type { Candle } from '@/types/candle';
import type { PositionTracker } from './position-tracker';
import { DEFAULT_RISK_CONFIG } from './config';
import { calculateDeflatedSharpe } from '@/lib/rl/utils/deflated-sharpe';
import { cppiExposureMultiplier } from '@/lib/risk/sizing';
import type { KillFlag } from './kill-switch';

/**
 * CPPI continuous-drawdown exposure multiplier (re-exported as a risk-engine
 * surface for callers wiring sizing into the bot/allocator path).
 *
 *   mult = clamp(1 - (drawdown - eMaxDD)/(hardKillDD - eMaxDD), 0, 1)
 *
 * This is a thin pass-through to the pure `src/lib/risk/sizing` math so the
 * risk-engine module exposes a single sizing surface. CRITICAL: this CPPI cut
 * is RECOVERABLE (it un-cuts as drawdown recovers from a trailing peak) and is
 * kept INDEPENDENT of the latched circuit-breaker / kill-switch. Stacking
 * CPPI×vol-target×retirement-derisk can drive sizing toward 0 transiently, but
 * because every factor here rises back as conditions recover, the stack cannot
 * permanently pin the book flat — only the latched kill (manual reset) does that.
 *
 * Use the SAME frozen-at-deploy eMaxDD/hardKillDD the retirement layer uses.
 */
export function getCppiExposureMultiplier(args: {
  drawdown: number;
  eMaxDD: number;
  hardKillDD: number;
}): number {
  return cppiExposureMultiplier(args);
}

/** Duration constants in milliseconds */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * Minimum resolved trades before the deflated-Sharpe SIZING HALT may engage.
 * Below this, a rolling Sharpe is noise (and a flat, tradeless equity curve
 * yields exactly 0), so sizing stays at full — otherwise the halt zeroes size
 * before the first trade can ever book (chicken-and-egg).
 */
const MIN_TRADES_FOR_SHARPE_GATE = 20;

export class RiskEngine {
  private cbConfig: CircuitBreakerConfig;
  private drawdownTiers: DrawdownTier[];
  private maxPositions: number;
  private regimeSizeMultipliers: Record<string, number>;
  /** Selection-bias trial count used to deflate the rolling Sharpe. */
  private deflationTrialCount: number;
  /** Deflated-Sharpe benchmark `c` for the sizing multiplier (NOT zero). */
  private minAcceptableSharpe: number;

  constructor(
    riskConfig: RiskConfig = DEFAULT_RISK_CONFIG,
    opts: { deflationTrialCount?: number; minAcceptableSharpe?: number } = {},
  ) {
    this.cbConfig = riskConfig.circuitBreakers;
    this.drawdownTiers = riskConfig.drawdownTiers;
    this.maxPositions = riskConfig.maxPositions;
    this.regimeSizeMultipliers = riskConfig.regimeSizeMultipliers;
    // 236 independent trials counted in DSR validation (see MEMORY.md). The c=0.5
    // benchmark comes from RETIREMENT_CONFIG; both are injectable for tests.
    this.deflationTrialCount = opts.deflationTrialCount ?? 236;
    this.minAcceptableSharpe = opts.minAcceptableSharpe ?? 0.5;
  }

  /**
   * Check if trading is allowed. Returns null if OK, or the blocking
   * circuit breaker if trading should be paused.
   *
   * The LATCHED kill flag is checked FIRST (before any equity/drawdown logic):
   * if halted, NEW entries are blocked regardless of equity. This is REDUCE-ONLY
   * — it blocks opening positions; it does NOT close existing ones (the caller's
   * `manageOpenPosition` path still runs). The kill flag is injected (DI) so the
   * decision stays testable; `nowMs` is injected for symmetry.
   */
  canTrade(
    tracker: PositionTracker,
    opts: { nowMs?: number; killFlag?: KillFlag } = {},
  ): CircuitBreakerState | null {
    const nowMs = opts.nowMs ?? Date.now();

    // 0. LATCHED kill flag — checked FIRST, blocks NEW entries regardless of equity.
    if (opts.killFlag?.halted) {
      return {
        type: 'max_drawdown',
        triggeredAt: nowMs,
        resumeAt: Infinity,
        reason: `KILL SWITCH active (${opts.killFlag.source ?? 'unknown'}): ${opts.killFlag.reason ?? 'manual review required'} — reduce-only`,
      };
    }

    // Check active circuit breakers
    const activeBreakers = tracker.getCircuitBreakers()
      .filter((cb) => Date.now() < cb.resumeAt);

    if (activeBreakers.length > 0) {
      return activeBreakers[0]!;
    }

    // Check drawdown halt tier (sizeMultiplier === 0)
    const ddTier = this.getDrawdownTier(tracker.getDrawdown());
    if (ddTier.sizeMultiplier === 0) {
      return {
        type: 'max_drawdown',
        triggeredAt: Date.now(),
        resumeAt: Infinity,
        reason: `Drawdown tier "${ddTier.label}": DD ${(tracker.getDrawdown() * 100).toFixed(1)}% — halted, manual review required`,
      };
    }

    // Check position count limit
    if (tracker.getOpenPositions().length >= this.maxPositions) {
      return {
        type: 'max_drawdown',
        triggeredAt: Date.now(),
        resumeAt: Date.now() + 60_000,
        reason: `Max positions reached (${this.maxPositions})`,
      };
    }

    return null;
  }

  /**
   * Check if a specific symbol can be traded (no existing position).
   */
  canTradeSymbol(tracker: PositionTracker, symbol: BotSymbol): boolean {
    return !tracker.hasOpenPosition(symbol);
  }

  /**
   * Per-symbol entry cap — reject a NEW entry when the symbol has already opened
   * `maxEntriesPerDay` positions inside the rolling 24h window. This is a HARD
   * per-symbol throttle that is INDEPENDENT of the strategy `cooldownBars` (a
   * burst of fast bars must not punch through a daily cap). It pauses ONE symbol;
   * it never halts the whole book. The window count is supplied by the caller
   * (`PositionTracker.getEntriesInWindow`) so this method stays pure.
   */
  perSymbolEntryCap(args: {
    symbol: BotSymbol;
    entriesInWindow: number;
    maxEntriesPerDay: number;
  }): { ok: boolean; reason?: string } {
    if (args.entriesInWindow >= args.maxEntriesPerDay) {
      return {
        ok: false,
        reason: `per-symbol entry cap: ${args.symbol} has ${args.entriesInWindow} entries in 24h (cap ${args.maxEntriesPerDay})`,
      };
    }
    return { ok: true };
  }

  /**
   * Pause a single symbol after `maxConsecutiveLossesPerSymbol` consecutive
   * losses on THAT symbol — without halting the whole book. Pure; the caller
   * supplies the per-symbol consecutive-loss count.
   */
  isSymbolPaused(args: {
    consecutiveLosses: number;
    maxConsecutiveLossesPerSymbol: number;
  }): boolean {
    return args.consecutiveLosses >= args.maxConsecutiveLossesPerSymbol;
  }

  /**
   * Heartbeat check — latches a `stale_feed` HALT when the data feed has gone
   * quiet for longer than `heartbeatTimeoutMs`. PURE and DI: `nowMs` and
   * `lastFeedUpdate` are injected (the live caller passes `DataFeed.lastFeedUpdate`).
   * A null `lastFeedUpdate` (no successful fetch yet) is a COLD START, not a
   * stale feed — we do not halt on it.
   */
  checkHeartbeat(args: {
    nowMs: number;
    lastFeedUpdate: number | null;
    heartbeatTimeoutMs: number;
  }): { stale: boolean; reason: string } {
    const { nowMs, lastFeedUpdate, heartbeatTimeoutMs } = args;
    if (lastFeedUpdate === null) {
      return { stale: false, reason: 'no feed update yet (cold start)' };
    }
    const gap = nowMs - lastFeedUpdate;
    if (gap > heartbeatTimeoutMs) {
      return {
        stale: true,
        reason: `stale_feed: ${Math.round(gap / 1000)}s since last feed update (> ${Math.round(heartbeatTimeoutMs / 1000)}s)`,
      };
    }
    return { stale: false, reason: 'feed fresh' };
  }

  /**
   * Get the combined position size multiplier based on all risk factors.
   * Multiply this by the base risk-per-trade to get effective risk.
   *
   * Factors:
   * 1. Drawdown tier (0.0 - 1.0)
   * 2. Regime (0.5 - 1.0, default 1.0)
   * 3. Rolling Sharpe (0.5 or 1.0)
   *
   * All multipliers are combined multiplicatively.
   */
  getPositionSizeMultiplier(
    tracker: PositionTracker,
    regime: string,
  ): { multiplier: number; breakdown: { drawdown: number; regime: number; sharpe: number } } {
    // 1. Drawdown tier multiplier
    const ddTier = this.getDrawdownTier(tracker.getDrawdown());
    const drawdownMult = ddTier.sizeMultiplier;

    // 2. Regime multiplier (default 1.0 for unknown regimes)
    const regimeMult = this.regimeSizeMultipliers[regime] ?? 1.0;

    // 3. Rolling DEFLATED-Sharpe multiplier (selection-bias corrected).
    const sharpeMult = this.getSharpeMultiplier({
      rollingSharpe: tracker.getRollingSharpe(),
      numTrades: tracker.getTotalTrades(),
      trialCount: this.deflationTrialCount,
      minAcceptableSharpe: this.minAcceptableSharpe,
    });

    const multiplier = drawdownMult * regimeMult * sharpeMult;

    return {
      multiplier,
      breakdown: { drawdown: drawdownMult, regime: regimeMult, sharpe: sharpeMult },
    };
  }

  /**
   * Get the Kelly-adjusted risk per trade.
   * Returns quarter-Kelly when enough history exists, otherwise falls back to baseRisk.
   *
   * @param tracker Position tracker with trade history
   * @param baseRisk Default risk per trade (e.g. 0.003)
   * @returns Effective risk per trade
   */
  getKellyAdjustedRisk(tracker: PositionTracker, baseRisk: number): number {
    const kellyRisk = tracker.getKellyRisk();
    if (kellyRisk === null) return baseRisk; // Not enough trades yet
    return kellyRisk;
  }

  /**
   * Get the current drawdown tier based on DD percentage.
   */
  getDrawdownTier(drawdown: number): DrawdownTier {
    for (const tier of this.drawdownTiers) {
      if (drawdown < tier.maxDrawdown) {
        return tier;
      }
    }
    // Fallback to last tier (halt)
    return this.drawdownTiers[this.drawdownTiers.length - 1]!;
  }

  /**
   * Evaluate circuit breaker conditions after a trade close.
   * Returns any newly triggered circuit breakers.
   */
  evaluateAfterTrade(tracker: PositionTracker): CircuitBreakerState[] {
    const triggered: CircuitBreakerState[] = [];
    const now = Date.now();

    // 1. Daily loss limit
    const dailyPnlPct = tracker.getDailyPnl() / tracker.getEquity();
    if (dailyPnlPct < -this.cbConfig.dailyLossLimit) {
      triggered.push({
        type: 'daily_loss',
        triggeredAt: now,
        resumeAt: now + DAY_MS,
        reason: `Daily loss limit hit: ${(dailyPnlPct * 100).toFixed(2)}% < -${(this.cbConfig.dailyLossLimit * 100).toFixed(1)}%`,
      });
    }

    // 2. Weekly loss limit
    const weeklyPnlPct = tracker.getWeeklyPnl() / tracker.getEquity();
    if (weeklyPnlPct < -this.cbConfig.weeklyLossLimit) {
      triggered.push({
        type: 'weekly_loss',
        triggeredAt: now,
        resumeAt: now + WEEK_MS,
        reason: `Weekly loss limit hit: ${(weeklyPnlPct * 100).toFixed(2)}% < -${(this.cbConfig.weeklyLossLimit * 100).toFixed(1)}%`,
      });
    }

    // 3. Max drawdown from peak
    const drawdown = tracker.getDrawdown();
    if (drawdown > this.cbConfig.maxDrawdown) {
      triggered.push({
        type: 'max_drawdown',
        triggeredAt: now,
        resumeAt: Infinity,
        reason: `Max drawdown exceeded: ${(drawdown * 100).toFixed(2)}% > ${(this.cbConfig.maxDrawdown * 100).toFixed(1)}%`,
      });
    }

    // 4. Consecutive losses
    if (tracker.getConsecutiveLosses() >= this.cbConfig.maxConsecutiveLosses) {
      triggered.push({
        type: 'consecutive_losses',
        triggeredAt: now,
        resumeAt: now + 2 * DAY_MS,
        reason: `${tracker.getConsecutiveLosses()} consecutive losses (limit: ${this.cbConfig.maxConsecutiveLosses})`,
      });
    }

    // 5. System error rate
    if (tracker.getRecentErrorCount() >= this.cbConfig.maxSystemErrorsPerHour) {
      triggered.push({
        type: 'system_errors',
        triggeredAt: now,
        resumeAt: now + HOUR_MS,
        reason: `${tracker.getRecentErrorCount()} errors in the last hour (limit: ${this.cbConfig.maxSystemErrorsPerHour})`,
      });
    }

    // Update tracker with new breakers
    if (triggered.length > 0) {
      const existing = tracker.getCircuitBreakers().filter((cb) => Date.now() < cb.resumeAt);
      tracker.setCircuitBreakers([...existing, ...triggered]);
    }

    return triggered;
  }

  /**
   * Clean up expired circuit breakers.
   */
  cleanupExpiredBreakers(tracker: PositionTracker): void {
    const active = tracker.getCircuitBreakers().filter((cb) => Date.now() < cb.resumeAt);
    tracker.setCircuitBreakers(active);
  }

  /**
   * Get human-readable status of all risk factors.
   */
  getStatus(tracker: PositionTracker): string[] {
    const lines: string[] = [];
    const breakers = tracker.getCircuitBreakers();

    if (breakers.length === 0) {
      lines.push('All circuit breakers OK');
    } else {
      for (const cb of breakers) {
        const active = Date.now() < cb.resumeAt;
        const resumeStr = cb.resumeAt === Infinity
          ? 'manual review required'
          : new Date(cb.resumeAt).toISOString();
        lines.push(
          `[${active ? 'ACTIVE' : 'EXPIRED'}] ${cb.type}: ${cb.reason} (resume: ${resumeStr})`,
        );
      }
    }

    const ddTier = this.getDrawdownTier(tracker.getDrawdown());
    lines.push(`Equity: $${tracker.getEquity().toFixed(2)}`);
    lines.push(`Peak: $${tracker.getPeakEquity().toFixed(2)}`);
    lines.push(`Drawdown: ${(tracker.getDrawdown() * 100).toFixed(2)}% [tier: ${ddTier.label}, ${(ddTier.sizeMultiplier * 100).toFixed(0)}% size]`);
    lines.push(`Daily PnL: $${tracker.getDailyPnl().toFixed(2)}`);
    lines.push(`Open positions: ${tracker.getOpenPositions().length}/${this.maxPositions}`);

    const rollingSharpe = tracker.getRollingSharpe();
    if (rollingSharpe !== null) {
      lines.push(`Rolling 30d Sharpe: ${rollingSharpe.toFixed(2)}`);
    }

    return lines;
  }

  // ============================================
  // Correlation-Aware Exposure
  // ============================================

  /**
   * Compute correlation-based position size multiplier.
   *
   * When multiple correlated assets have open positions in the same direction,
   * effective risk is higher than it appears. This scales sizing down
   * by 1/sqrt(n) where n = number of correlated positions (correlation > threshold).
   *
   * @param openSymbols Symbols with currently open positions
   * @param newSymbol Symbol being considered for a new position
   * @param candlesBySymbol Map of symbol → recent candles (need at least `lookback` candles)
   * @param lookback Number of bars for correlation window (default 20)
   * @param threshold Correlation threshold to consider assets "correlated" (default 0.85)
   * @returns Multiplier (1.0 if no correlation concern, lower if correlated)
   */
  getCorrelationMultiplier(
    openSymbols: BotSymbol[],
    newSymbol: BotSymbol,
    candlesBySymbol: Map<BotSymbol, Candle[]>,
    lookback = 20,
    threshold = 0.85,
  ): number {
    if (openSymbols.length === 0) return 1.0;

    const newCandles = candlesBySymbol.get(newSymbol);
    if (!newCandles || newCandles.length < lookback) return 1.0;

    const newReturns = this.computeReturns(newCandles, lookback);
    if (newReturns.length < lookback - 1) return 1.0;

    let correlatedCount = 0;

    for (const openSym of openSymbols) {
      const openCandles = candlesBySymbol.get(openSym);
      if (!openCandles || openCandles.length < lookback) continue;

      const openReturns = this.computeReturns(openCandles, lookback);
      if (openReturns.length < lookback - 1) continue;

      // Align lengths
      const len = Math.min(newReturns.length, openReturns.length);
      const corr = this.pearsonCorrelation(
        newReturns.slice(-len),
        openReturns.slice(-len),
      );

      if (corr > threshold) {
        correlatedCount++;
      }
    }

    if (correlatedCount === 0) return 1.0;

    // Scale by 1/sqrt(n+1) where n = correlated open positions, +1 for the new one
    return 1.0 / Math.sqrt(correlatedCount + 1);
  }

  // ============================================
  // Private helpers
  // ============================================

  /**
   * Compute log returns from close prices over last N bars.
   */
  private computeReturns(candles: Candle[], lookback: number): number[] {
    const start = Math.max(0, candles.length - lookback);
    const returns: number[] = [];
    for (let i = start + 1; i < candles.length; i++) {
      const prev = candles[i - 1]!.close;
      const curr = candles[i]!.close;
      if (prev > 0) {
        returns.push(Math.log(curr / prev));
      }
    }
    return returns;
  }

  /**
   * Pearson correlation coefficient between two arrays of equal length.
   */
  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n === 0) return 0;

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i]!;
      sumY += y[i]!;
      sumXY += x[i]! * y[i]!;
      sumX2 += x[i]! * x[i]!;
      sumY2 += y[i]! * y[i]!;
    }

    const denom = Math.sqrt(
      (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY),
    );
    if (denom === 0) return 0;

    return (n * sumXY - sumX * sumY) / denom;
  }

  /**
   * DEFLATED-Sharpe sizing multiplier.
   *
   * Replaces the old raw-Sharpe rule. We deflate the rolling Sharpe for
   * selection bias (trial count) via `calculateDeflatedSharpe`, then benchmark
   * the deflated Sharpe against `minAcceptableSharpe` (c = 0.5, NOT zero):
   *   - deflated >= c            → full size (1.0)
   *   - 0 <  deflated <  c       → de-risk (0.5)
   *   - deflated <= 0            → halt sizing (0)
   *   - rolling Sharpe null      → full size (1.0; do not punish a cold start)
   *
   * Consequence (the RED→GREEN case): a 0.3 rolling Sharpe at 100 trials now
   * reduces sizing — the deflation haircut from 100 trials drags it to ~0, where
   * the old raw rule kept it at 0.5 (and never deflated at all).
   */
  getSharpeMultiplier(args: {
    rollingSharpe: number | null;
    numTrades: number;
    trialCount: number;
    minAcceptableSharpe: number;
  }): number {
    const { rollingSharpe, numTrades, trialCount, minAcceptableSharpe } = args;
    if (rollingSharpe === null) return 1.0; // Not enough data yet — cold start

    // COLD-START GUARD (regression fix): the deflated-Sharpe SIZING HALT must not
    // engage before there is a meaningful trade sample. Otherwise a flat equity
    // curve (no trades) yields rollingSharpe 0, which deflates ≤ 0 and returns 0 —
    // zeroing position size so the bot can NEVER open its first trade
    // (chicken-and-egg). A rolling Sharpe over a handful of trades is noise, not an
    // edge-decay signal, so full-size until the sample is real.
    if (numTrades < MIN_TRADES_FOR_SHARPE_GATE) return 1.0;

    const dsr = calculateDeflatedSharpe(
      rollingSharpe,
      Math.max(1, numTrades),
      Math.max(1, trialCount),
    );
    const deflated = dsr.deflatedSharpe;

    if (deflated <= 0) return 0; // Halt sizing
    if (deflated < minAcceptableSharpe) return 0.5; // De-risk: positive but below the c=0.5 floor
    return 1.0;
  }
}
