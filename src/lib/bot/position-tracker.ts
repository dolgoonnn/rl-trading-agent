/**
 * Position Tracker — State Persistence & Equity Tracking
 *
 * Manages the bot's persistent state: open positions, equity curve,
 * trade history, and equity snapshots. All state is stored in SQLite
 * via Drizzle ORM for crash recovery.
 */

import { eq, desc } from 'drizzle-orm';
import type {
  BotPosition,
  BotTradeRecord,
  BotState,
  CircuitBreakerState,
} from '@/types/bot';
import { db } from '@/lib/data/db';
import {
  botState,
  botPositions,
  botTrades,
  botEquitySnapshots,
} from '@/lib/data/schema';
import { markToMarketEquity } from './snapshot';
import { RUN20_STRATEGY_CONFIG } from './config';
import {
  fundingReturn as computeFundingReturn,
  decomposeReturn,
  type FundingSettlementSeries,
} from '@/lib/cost/funding-ledger';
import { calculateDeflatedSharpe } from '@/lib/rl/utils/deflated-sharpe';

export class PositionTracker {
  private state: BotState;
  /**
   * Per-symbol entry timestamps (ms), in chronological order, for the rolling
   * per-symbol entry cap. Kept in memory: the cap is a 24h throttle, so old
   * timestamps fall out of every window query naturally and we prune on read.
   */
  private entryTimestamps: Map<string, number[]> = new Map();

  constructor(initialCapital: number) {
    this.state = {
      openPositions: [],
      equity: initialCapital,
      peakEquity: initialCapital,
      consecutiveLosses: 0,
      circuitBreakers: [],
      lastProcessedTimestamp: {},
      dailyPnl: 0,
      weeklyPnl: 0,
      recentErrors: [],
      startedAt: Date.now(),
      totalTrades: 0,
    };
  }

  // ============================================
  // State Management
  // ============================================

  /**
   * Load state from DB (returns false if no saved state).
   *
   * @param nowMs Injected clock for the per-symbol entry-window rebuild (Issue 3).
   *        Defaults to Date.now(); tests pass a fixed clock so the 24h window
   *        lines up with the timestamps they seeded.
   */
  loadState(nowMs: number = Date.now()): boolean {
    const row = db.select().from(botState).where(eq(botState.id, 1)).get();
    if (!row) return false;

    // Load open positions
    const openPosRows = db.select()
      .from(botPositions)
      .where(eq(botPositions.status, 'open'))
      .all();

    this.state = {
      openPositions: openPosRows.map(this.rowToPosition),
      equity: row.equity,
      peakEquity: row.peakEquity,
      consecutiveLosses: row.consecutiveLosses,
      circuitBreakers: JSON.parse(row.circuitBreakers) as CircuitBreakerState[],
      lastProcessedTimestamp: JSON.parse(row.lastProcessedTimestamp) as Record<string, number>,
      dailyPnl: row.dailyPnl,
      weeklyPnl: row.weeklyPnl,
      recentErrors: JSON.parse(row.recentErrors) as number[],
      startedAt: row.startedAt,
      totalTrades: row.totalTrades,
    };

    // Rebuild the per-symbol entry-cap window from durable rows (Issue 3) so the
    // 24h cap survives a restart. Both open positions (bot_positions) and closed
    // trades (bot_trades) count as entries — the cap is about how many times a
    // symbol was ENTERED in the window, regardless of whether it has since
    // closed. We pull every entryTimestamp inside the last 24h and seed the
    // in-memory map; getEntriesInWindow then prunes lazily on read.
    this.rebuildEntryWindow(nowMs);

    return true;
  }

  /**
   * Rebuild `entryTimestamps` from durable DB rows (bot_positions + bot_trades)
   * whose entryTimestamp falls inside the last 24h. Idempotent; ordered
   * chronologically per symbol. Called from loadState() on restart.
   */
  private rebuildEntryWindow(nowMs: number): void {
    const cutoff = nowMs - 24 * 3_600_000;
    // De-dupe by position id: a CLOSED position survives as a row in BOTH
    // bot_positions (status='closed') AND bot_trades (same id + entryTimestamp),
    // so a naive union would double-count it. Keying on id collapses the pair to
    // one entry. Each position id is exactly one entry event.
    const byId = new Map<string, { symbol: string; ts: number }>();

    const consider = (id: string, symbol: string, ts: number): void => {
      if (ts <= cutoff || ts > nowMs) return;
      if (!byId.has(id)) byId.set(id, { symbol, ts });
    };

    const posRows = db.select({
      id: botPositions.id,
      symbol: botPositions.symbol,
      entryTimestamp: botPositions.entryTimestamp,
    }).from(botPositions).all();
    for (const r of posRows) consider(r.id, r.symbol, r.entryTimestamp);

    const tradeRows = db.select({
      id: botTrades.id,
      symbol: botTrades.symbol,
      entryTimestamp: botTrades.entryTimestamp,
    }).from(botTrades).all();
    for (const r of tradeRows) consider(r.id, r.symbol, r.entryTimestamp);

    const bySymbol = new Map<string, number[]>();
    for (const { symbol, ts } of byId.values()) {
      const list = bySymbol.get(symbol) ?? [];
      list.push(ts);
      bySymbol.set(symbol, list);
    }
    for (const [symbol, list] of bySymbol) {
      list.sort((a, b) => a - b);
      this.entryTimestamps.set(symbol, list);
    }
  }

  /** Save state to DB */
  saveState(): void {
    const existing = db.select().from(botState).where(eq(botState.id, 1)).get();

    const values = {
      id: 1,
      equity: this.state.equity,
      peakEquity: this.state.peakEquity,
      consecutiveLosses: this.state.consecutiveLosses,
      dailyPnl: this.state.dailyPnl,
      weeklyPnl: this.state.weeklyPnl,
      circuitBreakers: JSON.stringify(this.state.circuitBreakers),
      lastProcessedTimestamp: JSON.stringify(this.state.lastProcessedTimestamp),
      recentErrors: JSON.stringify(this.state.recentErrors),
      totalTrades: this.state.totalTrades,
      startedAt: this.state.startedAt,
      updatedAt: Date.now(),
    };

    if (existing) {
      db.update(botState).set(values).where(eq(botState.id, 1)).run();
    } else {
      db.insert(botState).values(values).run();
    }
  }

  // ============================================
  // Position Tracking
  // ============================================

  /** Add a newly opened position */
  addPosition(position: BotPosition): void {
    this.state.openPositions.push(position);

    // Persist to DB
    db.insert(botPositions).values({
      id: position.id,
      symbol: position.symbol,
      direction: position.direction,
      status: 'open',
      entryPrice: position.entryPrice,
      rawEntryPrice: position.rawEntryPrice,
      entryTimestamp: position.entryTimestamp,
      entryBarIndex: position.entryBarIndex,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      currentSL: position.currentSL,
      positionSizeUSDT: position.positionSizeUSDT,
      riskAmountUSDT: position.riskAmountUSDT,
      strategy: position.strategy,
      confluenceScore: position.confluenceScore,
      factorBreakdown: JSON.stringify(position.factorBreakdown),
      regime: position.regime,
      partialTaken: position.partialTaken,
      partialPnlPercent: position.partialPnlPercent,
      createdAt: Date.now(),
    }).run();

    this.saveState();
  }

  /** Update a position (e.g., partial TP taken, SL moved) */
  updatePosition(position: BotPosition): void {
    const idx = this.state.openPositions.findIndex((p) => p.id === position.id);
    if (idx >= 0) {
      this.state.openPositions[idx] = position;
    }

    db.update(botPositions).set({
      currentSL: position.currentSL,
      partialTaken: position.partialTaken,
      partialPnlPercent: position.partialPnlPercent,
    }).where(eq(botPositions.id, position.id)).run();
  }

  /**
   * Close a position and record the trade.
   *
   * @param position The closed position (pnlPercent/pnlUSDT already computed by
   *        OrderManager, friction already baked into entry/exit prices).
   * @param fundingSeries Optional realized-funding source for the symbol. When
   *        provided, the funding leg is debited via the shared funding-ledger
   *        keystone (same math as the backtest ⇒ zero sim/live mismatch). When
   *        omitted (the live ICT bot has no funding series at close time today),
   *        fundingReturn is 0 — never crash.
   */
  closePosition(position: BotPosition, fundingSeries?: FundingSettlementSeries): void {
    // Remove from open positions
    this.state.openPositions = this.state.openPositions.filter((p) => p.id !== position.id);

    // Update equity
    const pnlUSDT = position.pnlUSDT ?? 0;
    this.state.equity += pnlUSDT;
    this.state.peakEquity = Math.max(this.state.peakEquity, this.state.equity);
    this.state.dailyPnl += pnlUSDT;
    this.state.weeklyPnl += pnlUSDT;
    this.state.totalTrades++;

    // Track consecutive losses
    if (pnlUSDT < 0) {
      this.state.consecutiveLosses++;
    } else {
      this.state.consecutiveLosses = 0;
    }

    // Update position in DB
    db.update(botPositions).set({
      status: 'closed',
      exitPrice: position.exitPrice,
      exitTimestamp: position.exitTimestamp,
      exitReason: position.exitReason,
      barsHeld: position.barsHeld,
      pnlPercent: position.pnlPercent,
      pnlUSDT: position.pnlUSDT,
      currentSL: position.currentSL,
      partialTaken: position.partialTaken,
      partialPnlPercent: position.partialPnlPercent,
    }).where(eq(botPositions.id, position.id)).run();

    // Insert trade record
    const drawdown = this.state.peakEquity > 0
      ? (this.state.peakEquity - this.state.equity) / this.state.peakEquity
      : 0;

    // 4-component return decomposition (funding-ledger keystone).
    //
    // NOTE on accounting: OrderManager bakes per-side friction directly into
    // `entryPrice`/`exitPrice` (slippage simulation), so `pnlPercent` is ALREADY
    // net-of-friction. We do NOT touch pnlPercent/pnlUSDT. Instead we ATTRIBUTE
    // the friction leg so the per-cell review's `sumFriction` is non-zero (and
    // consistent with the gold sleeve, which also attributes friction). Friction
    // sides: entry + final exit always (2); a taken partial TP adds one more
    // exit fill weighted by the partial fraction (the 3-fill case in
    // OrderManager). `grossReturn` is then the friction-free, FIRST-ORDER
    // estimate `pnlPercent − frictionReturn` (friction is multiplicative in
    // price and the partial blend is fraction-weighted, so this is an estimate,
    // not an exact reconstruction) — matching the gold sleeve convention. The
    // additive invariant gross + friction + funding === net stays exact, and
    // net resolves to pnlPercent + funding (friction cancels by construction).
    const frictionPerSide = RUN20_STRATEGY_CONFIG.frictionPerSide;
    const partialTPFraction = RUN20_STRATEGY_CONFIG.partialTP.fraction;
    const nSides = position.partialTaken ? (2 + partialTPFraction) : 2;
    const frictionReturn = -(nSides * frictionPerSide);
    const grossReturn = (position.pnlPercent ?? 0) - frictionReturn; // friction-free, first-order ESTIMATE

    let fundingReturn = 0;
    if (fundingSeries && position.exitTimestamp !== undefined) {
      try {
        fundingReturn = computeFundingReturn({
          entryMs: position.entryTimestamp,
          exitMs: position.exitTimestamp,
          direction: position.direction,
          rateAt: fundingSeries.rateAt,
        });
      } catch (err) {
        // Funding lookup must never break a close. Fall back to zero + log.
        console.warn(
          `[funding-ledger] funding return failed for ${position.symbol} ${position.id}; storing 0:`,
          err,
        );
        fundingReturn = 0;
      }
    }

    // Independently-computed realized net for the de-tautologized audit. Net is
    // realized PnL (already net-of-friction) plus the signed funding leg; this
    // is derived from `pnlPercent` directly, NOT from the gross/friction split,
    // so a mis-attribution between gross and friction can no longer pass
    // silently. Non-strict in production (logs a warning, never crashes a close).
    const expectedNet = (position.pnlPercent ?? 0) + fundingReturn;
    const decomposed = decomposeReturn({
      grossReturn,
      frictionReturn,
      fundingReturn,
      expectedNet,
    });
    // fundingPaidUsdt: sign-correct USDT funding (negative = paid, positive = received).
    const fundingPaidUsdt = decomposed.fundingReturn * position.positionSizeUSDT;

    db.insert(botTrades).values({
      id: position.id,
      symbol: position.symbol,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice: position.exitPrice!,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp: position.exitTimestamp!,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      positionSizeUSDT: position.positionSizeUSDT,
      riskAmountUSDT: position.riskAmountUSDT,
      strategy: position.strategy,
      confluenceScore: position.confluenceScore,
      factorBreakdown: JSON.stringify(position.factorBreakdown),
      regime: position.regime,
      exitReason: position.exitReason!,
      barsHeld: position.barsHeld!,
      pnlPercent: position.pnlPercent!,
      pnlUSDT: position.pnlUSDT!,
      equityAfter: this.state.equity,
      drawdownFromPeak: drawdown,
      grossReturn: decomposed.grossReturn,
      frictionReturn: decomposed.frictionReturn,
      fundingReturn: decomposed.fundingReturn,
      netReturn: decomposed.netReturn,
      fundingPaidUsdt,
      createdAt: Date.now(),
    }).run();

    this.saveState();
  }

  // ============================================
  // Equity Snapshots
  // ============================================

  /**
   * Mark-to-market equity: realized equity + Σ unrealized PnL of all open
   * positions valued at the supplied latest prices. With no prices (or no
   * open positions) this equals realized equity.
   */
  markToMarketEquity(latestPrices: Partial<Record<string, number>> = {}): number {
    return markToMarketEquity(this.state.equity, this.state.openPositions, latestPrices);
  }

  /**
   * Record an equity snapshot.
   *
   * @param latestPrices Latest close per symbol — when provided, the snapshot
   *        equity is MARK-TO-MARKET (realized + unrealized of open positions).
   *        Omitting it records realized equity only (e.g. shutdown/trade-close
   *        where positions are already booked).
   * @param nowMs Snapshot timestamp (defaults to Date.now()).
   */
  recordSnapshot(latestPrices: Partial<Record<string, number>> = {}, nowMs: number = Date.now()): void {
    const equity = this.markToMarketEquity(latestPrices);
    const peakEquity = Math.max(this.state.peakEquity, equity);
    const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    const cumulativePnl = equity - this.getInitialCapital();

    db.insert(botEquitySnapshots).values({
      timestamp: nowMs,
      equity,
      peakEquity,
      drawdown,
      openPositions: this.state.openPositions.length,
      dailyPnl: this.state.dailyPnl,
      cumulativePnl,
    }).run();
  }

  // ============================================
  // Getters
  // ============================================

  getState(): BotState { return this.state; }
  getEquity(): number { return this.state.equity; }
  getPeakEquity(): number { return this.state.peakEquity; }
  getOpenPositions(): BotPosition[] { return [...this.state.openPositions]; }
  getConsecutiveLosses(): number { return this.state.consecutiveLosses; }
  getDailyPnl(): number { return this.state.dailyPnl; }
  getWeeklyPnl(): number { return this.state.weeklyPnl; }
  getTotalTrades(): number { return this.state.totalTrades; }

  getDrawdown(): number {
    if (this.state.peakEquity <= 0) return 0;
    return (this.state.peakEquity - this.state.equity) / this.state.peakEquity;
  }

  hasOpenPosition(symbol: string): boolean {
    return this.state.openPositions.some((p) => p.symbol === symbol);
  }

  getOpenPosition(symbol: string): BotPosition | undefined {
    return this.state.openPositions.find((p) => p.symbol === symbol);
  }

  // ============================================
  // Daily/Weekly Reset
  // ============================================

  /** Reset daily PnL counter (call at midnight UTC) */
  resetDailyPnl(): void {
    this.state.dailyPnl = 0;
    this.saveState();
  }

  /** Reset weekly PnL counter (call on Monday UTC) */
  resetWeeklyPnl(): void {
    this.state.weeklyPnl = 0;
    this.saveState();
  }

  /** Record last processed timestamp for a symbol */
  setLastProcessedTimestamp(symbol: string, timestamp: number): void {
    this.state.lastProcessedTimestamp[symbol] = timestamp;
  }

  getLastProcessedTimestamp(symbol: string): number {
    return this.state.lastProcessedTimestamp[symbol] ?? 0;
  }

  // ============================================
  // Circuit Breakers
  // ============================================

  setCircuitBreakers(breakers: CircuitBreakerState[]): void {
    this.state.circuitBreakers = breakers;
    this.saveState();
  }

  getCircuitBreakers(): CircuitBreakerState[] {
    return this.state.circuitBreakers;
  }

  // ============================================
  // Error tracking
  // ============================================

  recordError(): void {
    this.state.recentErrors.push(Date.now());
    // Keep only last hour
    const hourAgo = Date.now() - 3600_000;
    this.state.recentErrors = this.state.recentErrors.filter((t) => t > hourAgo);
    this.saveState();
  }

  getRecentErrorCount(): number {
    const hourAgo = Date.now() - 3600_000;
    return this.state.recentErrors.filter((t) => t > hourAgo).length;
  }

  // ============================================
  // Performance Stats
  // ============================================

  /** Get trade history from DB */
  getTradeHistory(limit = 100): BotTradeRecord[] {
    const rows = db.select()
      .from(botTrades)
      .orderBy(botTrades.createdAt)
      .limit(limit)
      .all();

    return rows.map((row) => ({
      id: row.id,
      symbol: row.symbol as BotTradeRecord['symbol'],
      direction: row.direction as BotTradeRecord['direction'],
      entryPrice: row.entryPrice,
      exitPrice: row.exitPrice,
      entryTimestamp: row.entryTimestamp,
      exitTimestamp: row.exitTimestamp,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      positionSizeUSDT: row.positionSizeUSDT,
      riskAmountUSDT: row.riskAmountUSDT,
      strategy: row.strategy,
      confluenceScore: row.confluenceScore,
      factorBreakdown: row.factorBreakdown,
      regime: row.regime,
      exitReason: row.exitReason as BotTradeRecord['exitReason'],
      barsHeld: row.barsHeld,
      pnlPercent: row.pnlPercent,
      pnlUSDT: row.pnlUSDT,
      equityAfter: row.equityAfter,
      drawdownFromPeak: row.drawdownFromPeak,
    }));
  }

  // ============================================
  // Kelly Sizing
  // ============================================

  /**
   * Compute quarter-Kelly fraction from the last N trades.
   * Kelly = WR * (avg_win / avg_loss) - (1 - WR)
   * Returns null if insufficient trades for a meaningful estimate.
   *
   * @param windowSize Number of recent trades to use (default 30)
   * @param kellyFraction Kelly divisor (default 0.25 for quarter-Kelly)
   * @param floor Minimum risk fraction (default 0.001 = 0.1%)
   * @param ceiling Maximum risk fraction (default 0.005 = 0.5%)
   */
  getKellyRisk(
    windowSize = 30,
    kellyFraction = 0.25,
    floor = 0.001,
    ceiling = 0.005,
  ): number | null {
    const trades = this.getRecentTradePnls(windowSize);
    if (trades.length < 10) return null; // Need minimum 10 trades for any signal

    const wins = trades.filter((t) => t > 0);
    const losses = trades.filter((t) => t < 0);

    if (wins.length === 0 || losses.length === 0) return null;

    const winRate = wins.length / trades.length;
    const avgWin = wins.reduce((s, v) => s + v, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length);

    if (avgLoss === 0) return ceiling;

    const kelly = winRate * (avgWin / avgLoss) - (1 - winRate);
    const quarterKelly = kelly * kellyFraction;

    // Clamp to floor/ceiling
    return Math.max(floor, Math.min(ceiling, quarterKelly));
  }

  // ============================================
  // Rolling Sharpe
  // ============================================

  /**
   * Compute rolling Sharpe ratio from equity snapshots.
   * Uses daily equity returns over the last N days.
   *
   * @param windowDays Number of days for rolling window (default 30)
   * @returns Annualized Sharpe ratio, or null if insufficient data
   */
  getRollingSharpe(windowDays = 30): number | null {
    const cutoff = Date.now() - windowDays * 24 * 3_600_000;

    const snapshots = db.select()
      .from(botEquitySnapshots)
      .orderBy(botEquitySnapshots.timestamp)
      .all()
      .filter((s) => s.timestamp >= cutoff);

    if (snapshots.length < 7) return null; // Need at least a week of data

    // Compute daily returns from equity snapshots
    const returns: number[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1]!.equity;
      const curr = snapshots[i]!.equity;
      if (prev > 0) {
        returns.push((curr - prev) / prev);
      }
    }

    if (returns.length < 5) return null;

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return mean > 0 ? Infinity : 0;

    // Annualize: assume ~1 snapshot per hour, ~24 per day
    // Sharpe = mean / stdDev * sqrt(periods_per_year)
    // With hourly snapshots: sqrt(24 * 365) ≈ sqrt(8760) ≈ 93.6
    // But if snapshots are daily: sqrt(365) ≈ 19.1
    // Detect frequency from actual data
    const avgIntervalMs = (snapshots[snapshots.length - 1]!.timestamp - snapshots[0]!.timestamp) / (snapshots.length - 1);
    const periodsPerYear = (365 * 24 * 3_600_000) / avgIntervalMs;

    return (mean / stdDev) * Math.sqrt(periodsPerYear);
  }

  // ============================================
  // Per-symbol entry window (retirement kill-switch cap)
  // ============================================

  /**
   * Record a NEW entry for a symbol at timestamp `ts` (ms). Feeds the per-symbol
   * entry cap. Stored in memory in chronological order; old entries are pruned
   * lazily on read so the list never grows unbounded for a long-lived symbol.
   */
  recordEntry(symbol: string, ts: number): void {
    const list = this.entryTimestamps.get(symbol) ?? [];
    list.push(ts);
    this.entryTimestamps.set(symbol, list);
  }

  /**
   * Count entries for `symbol` whose timestamp is within `windowMs` before
   * `nowMs` — i.e. in the half-open window `(nowMs − windowMs, nowMs]`. Prunes
   * timestamps that have fallen out of the window as a side effect.
   */
  getEntriesInWindow(symbol: string, windowMs: number, nowMs: number): number {
    const list = this.entryTimestamps.get(symbol);
    if (!list || list.length === 0) return 0;
    const cutoff = nowMs - windowMs;
    const kept = list.filter((t) => t > cutoff && t <= nowMs);
    // Prune anything older than the window so memory stays bounded.
    this.entryTimestamps.set(symbol, list.filter((t) => t > cutoff));
    return kept.length;
  }

  /**
   * Rolling DEFLATED Sharpe — the rolling Sharpe (from equity snapshots)
   * deflated for `trials` selection-bias. Returns null when the rolling Sharpe
   * is null (insufficient snapshot history) so the caller can treat a cold start
   * as "not enough data" rather than a failing edge.
   *
   * NOTE (Issue D): this uses the ANNUALIZED rolling Sharpe with T = totalTrades,
   * which mixes scales (annualized magnitude vs per-trade variance count). It is
   * retained for backward compatibility, but the retirement gate should use the
   * SCALE-CONSISTENT pair below (`getRollingPerObservationSharpe` +
   * `getRollingDeflatedSharpeObs`), which deflate a per-OBSERVATION Sharpe with
   * T = the number of return OBSERVATIONS that produced it.
   */
  getRollingDeflatedSharpe(trials: number, windowDays = 30): number | null {
    const sharpe = this.getRollingSharpe(windowDays);
    if (sharpe === null) return null;
    // Deflation needs >1 observation: the Sharpe-variance estimate diverges as
    // trades→1 (yielding an Infinite haircut → −Infinity deflated). A tracker
    // with <2 closed trades (e.g. a cold start) has no meaningful deflated
    // Sharpe → return null, not a spurious −Infinity.
    if (this.state.totalTrades < 2) return null;
    const dsr = calculateDeflatedSharpe(
      sharpe,
      this.state.totalTrades,
      Math.max(1, trials),
    );
    // Guard any non-finite result (Infinite/ -Infinite / NaN) as "no signal".
    return Number.isFinite(dsr.deflatedSharpe) ? dsr.deflatedSharpe : null;
  }

  /**
   * Per-OBSERVATION rolling Sharpe (NOT annualized) plus the observation count.
   *
   * Issue D — DSR scale fix. The deflated-Sharpe variance estimator
   * `Var(SR) ≈ (1 + 0.5·SR²)/T` is defined on a PER-OBSERVATION Sharpe and
   * T = number of return observations. Feeding it an annualized Sharpe (≈√252×
   * larger) and `totalTrades` (a different count) is a scale mismatch that makes
   * the deflated value coarse. This returns the raw `mean/std` of the
   * snapshot-to-snapshot returns with `n` = the count of those returns, so the
   * caller can deflate consistently.
   *
   * Returns null under the same data-sufficiency rules as `getRollingSharpe`.
   */
  getRollingPerObservationSharpe(
    windowDays = 30,
  ): { sharpe: number; n: number } | null {
    const cutoff = Date.now() - windowDays * 24 * 3_600_000;

    const snapshots = db.select()
      .from(botEquitySnapshots)
      .orderBy(botEquitySnapshots.timestamp)
      .all()
      .filter((s) => s.timestamp >= cutoff);

    if (snapshots.length < 7) return null; // Need at least a week of data

    const returns: number[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1]!.equity;
      const curr = snapshots[i]!.equity;
      if (prev > 0) {
        returns.push((curr - prev) / prev);
      }
    }

    if (returns.length < 5) return null;

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return { sharpe: mean > 0 ? Infinity : 0, n: returns.length };

    // PER-OBSERVATION Sharpe: mean/std of the per-return observations, NOT annualized.
    return { sharpe: mean / stdDev, n: returns.length };
  }

  /**
   * Scale-consistent rolling DEFLATED Sharpe for the retirement gate (Issue D).
   *
   * Deflates the PER-OBSERVATION Sharpe with T = the number of return
   * OBSERVATIONS that produced it (NOT totalTrades) and `trials` selection-bias.
   * Returns the deflated per-observation Sharpe and the same `n`, or null on a
   * cold start. Compare the deflated value against `minAcceptableSharpe` ON THE
   * SAME per-observation scale (the gate's benchmark `c` is interpreted likewise).
   */
  getRollingDeflatedSharpeObs(
    trials: number,
    windowDays = 30,
  ): { deflatedSharpe: number; n: number } | null {
    const obs = this.getRollingPerObservationSharpe(windowDays);
    if (obs === null) return null;
    if (obs.n < 2 || !Number.isFinite(obs.sharpe)) return null;
    const dsr = calculateDeflatedSharpe(obs.sharpe, obs.n, Math.max(1, trials));
    if (!Number.isFinite(dsr.deflatedSharpe)) return null;
    return { deflatedSharpe: dsr.deflatedSharpe, n: obs.n };
  }

  /**
   * Per-symbol consecutive-loss count (Issue 4) — the length of the current
   * losing streak for `symbol`, counting back from its most-recent closed trade.
   * A win (or no trades) ⇒ 0. Independent of the global `consecutiveLosses`
   * (which mixes symbols); this pauses ONE symbol without halting the book.
   */
  getSymbolConsecutiveLosses(symbol: string): number {
    const rows = db.select({ pnlUSDT: botTrades.pnlUSDT })
      .from(botTrades)
      .where(eq(botTrades.symbol, symbol))
      .orderBy(desc(botTrades.createdAt))
      .limit(50)
      .all();

    let streak = 0;
    for (const r of rows) {
      if (r.pnlUSDT < 0) streak++;
      else break;
    }
    return streak;
  }

  // ============================================
  // Private
  // ============================================

  /**
   * Get PnL percentages from recent trades (newest first from DB, returned chronological).
   */
  private getRecentTradePnls(count: number): number[] {
    const rows = db.select({ pnlPercent: botTrades.pnlPercent })
      .from(botTrades)
      .orderBy(desc(botTrades.createdAt))
      .limit(count)
      .all();

    return rows.reverse().map((r) => r.pnlPercent);
  }

  private getInitialCapital(): number {
    // Derived from first equity snapshot or from state start
    const firstSnapshot = db.select()
      .from(botEquitySnapshots)
      .orderBy(botEquitySnapshots.timestamp)
      .limit(1)
      .get();

    return firstSnapshot?.equity ?? this.state.equity;
  }

  private rowToPosition(row: typeof botPositions.$inferSelect): BotPosition {
    return {
      id: row.id,
      symbol: row.symbol as BotPosition['symbol'],
      direction: row.direction as BotPosition['direction'],
      status: row.status as BotPosition['status'],
      entryPrice: row.entryPrice,
      rawEntryPrice: row.rawEntryPrice ?? row.entryPrice, // Fallback for old rows without rawEntryPrice
      entryTimestamp: row.entryTimestamp,
      entryBarIndex: row.entryBarIndex,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      currentSL: row.currentSL,
      positionSizeUSDT: row.positionSizeUSDT,
      riskAmountUSDT: row.riskAmountUSDT,
      strategy: row.strategy,
      confluenceScore: row.confluenceScore,
      factorBreakdown: JSON.parse(row.factorBreakdown) as Record<string, number>,
      regime: row.regime,
      partialTaken: row.partialTaken ?? false,
      partialPnlPercent: row.partialPnlPercent ?? 0,
      exitPrice: row.exitPrice ?? undefined,
      exitTimestamp: row.exitTimestamp ?? undefined,
      exitReason: row.exitReason as BotPosition['exitReason'],
      barsHeld: row.barsHeld ?? undefined,
      pnlPercent: row.pnlPercent ?? undefined,
      pnlUSDT: row.pnlUSDT ?? undefined,
    };
  }
}
