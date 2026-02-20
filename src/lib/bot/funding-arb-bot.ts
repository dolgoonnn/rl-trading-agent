/**
 * Funding Arb Bot — Orchestrator
 *
 * Wires FundingDataFeed + FundingArbEngine + FundingArbTracker + AlertManager.
 * Runs alongside the directional trading bot, operates independently.
 *
 * Tick loop:
 *   1. Poll funding rates for arb symbols
 *   2. Process settlements for open positions
 *   3. Evaluate exits for open positions
 *   4. Evaluate entries for monitored symbols
 */

import type { FundingArbConfig, FundingArbPosition } from '@/types/funding-arb';
import { FundingDataFeed } from './funding-data-feed';
import { FundingArbEngine } from './funding-arb-engine';
import { FundingArbTracker } from './funding-arb-tracker';
import type { AlertManager } from './alerts';

export class FundingArbBot {
  private feed: FundingDataFeed;
  private engine: FundingArbEngine;
  private tracker: FundingArbTracker;
  private alerts: AlertManager;
  private config: FundingArbConfig;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private verbose: boolean;

  constructor(
    config: FundingArbConfig,
    alerts: AlertManager,
    verbose = false,
  ) {
    this.config = config;
    this.feed = new FundingDataFeed();
    this.engine = new FundingArbEngine(config);
    this.tracker = new FundingArbTracker();
    this.alerts = alerts;
    this.verbose = verbose;
  }

  async start(): Promise<void> {
    this.running = true;

    console.log('\n--- Funding Rate Arbitrage ---');
    console.log(`Symbols: ${this.config.arbSymbols.join(', ')}`);
    console.log(`Min rate: ${(this.config.minFundingRate * 100).toFixed(4)}%`);
    console.log(`Max position: $${this.config.maxPositionSizeUSDT}`);
    console.log(`Max arb positions: ${this.config.maxArbPositions}`);
    console.log(`Poll interval: ${this.config.pollIntervalMinutes}min`);

    // Load existing open positions
    const openPositions = this.tracker.getOpenPositions();
    if (openPositions.length > 0) {
      console.log(`Resumed ${openPositions.length} open arb position(s):`);
      for (const pos of openPositions) {
        console.log(
          `  ${pos.symbol}: ${pos.direction} since ${new Date(pos.entryTimestamp).toISOString()}, ` +
            `funding collected: $${pos.totalFundingCollected.toFixed(4)}`,
        );
      }
    }

    // Run first tick immediately
    await this.tick();

    // Schedule periodic polling
    const intervalMs = this.config.pollIntervalMinutes * 60 * 1000;
    this.pollInterval = setInterval(() => this.tick(), intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Close all open arb positions on shutdown
    const openPositions = this.tracker.getOpenPositions();
    for (const pos of openPositions) {
      try {
        const snapshot = await this.feed.fetchCurrentRate(pos.symbol);
        const { netPnlUSDT, spreadCost, annualizedAPY } =
          this.engine.calculateNetPnl(pos, snapshot.spread);

        const closed = this.tracker.closePosition(
          pos.symbol,
          'shutdown',
          snapshot.markPrice,
          snapshot.spread,
          netPnlUSDT,
          spreadCost,
          annualizedAPY,
        );

        if (closed) {
          await this.alertArbClosed(closed);
        }
      } catch (err) {
        console.error(
          `Failed to close arb position ${pos.symbol} on shutdown:`,
          err,
        );
      }
    }

    console.log('Funding arb bot stopped');
  }

  // ============================================
  // Core Tick
  // ============================================

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      // 1. Poll current funding rates
      const snapshots = await this.feed.fetchCurrentRates(
        this.config.arbSymbols,
      );

      // 2. Process each symbol
      for (const symbol of this.config.arbSymbols) {
        const snapshot = snapshots.get(symbol);
        if (!snapshot) continue;

        // Save snapshot to DB
        this.tracker.saveSnapshot(snapshot);

        // Check for settlement
        await this.processSettlement(symbol, snapshot);

        // Evaluate position
        const openPos = this.tracker.getOpenPosition(symbol);
        if (openPos) {
          await this.processExit(symbol, openPos, snapshot);
        } else {
          await this.processEntry(symbol, snapshot);
        }
      }
    } catch (err) {
      console.error('Funding arb tick error:', err);
      await this.alerts.error(
        `Funding arb tick failed: ${(err as Error).message}`,
      );
    }
  }

  // ============================================
  // Entry Logic
  // ============================================

  private async processEntry(
    symbol: string,
    snapshot: import('@/types/funding-arb').FundingRateSnapshot,
  ): Promise<void> {
    // Check max concurrent positions
    if (this.tracker.getOpenCount() >= this.config.maxArbPositions) {
      if (this.verbose) {
        console.log(
          `[ARB] ${symbol}: max positions (${this.config.maxArbPositions}) reached`,
        );
      }
      return;
    }

    const evaluation = this.engine.evaluateEntry(snapshot);

    if (evaluation.action !== 'open' || !evaluation.direction) {
      if (this.verbose) {
        console.log(`[ARB] ${symbol}: ${evaluation.reason}`);
      }
      return;
    }

    // Open arb position
    const positionSize = this.engine.calculatePositionSize(
      snapshot,
      this.config.maxPositionSizeUSDT,
    );

    const position = this.tracker.openPosition(
      symbol,
      evaluation.direction,
      snapshot,
      positionSize,
    );

    console.log(
      `[ARB] ${symbol}: OPENED ${position.direction} @ $${position.entryPrice.toFixed(2)}, ` +
        `rate=${(snapshot.fundingRate * 100).toFixed(4)}%, size=$${positionSize.toFixed(2)}`,
    );

    await this.alertArbOpened(position, evaluation.breakEvenHours ?? 0);
  }

  // ============================================
  // Exit Logic
  // ============================================

  private async processExit(
    symbol: string,
    position: FundingArbPosition,
    snapshot: import('@/types/funding-arb').FundingRateSnapshot,
  ): Promise<void> {
    const evaluation = this.engine.evaluateExit(position, snapshot);

    if (evaluation.action === 'hold') {
      if (this.verbose) {
        console.log(`[ARB] ${symbol}: hold — ${evaluation.reason}`);
      }
      return;
    }

    if (evaluation.action === 'close') {
      const { netPnlUSDT, spreadCost, annualizedAPY } =
        this.engine.calculateNetPnl(position, snapshot.spread);

      const closed = this.tracker.closePosition(
        symbol,
        evaluation.reason.includes('flipped')
          ? 'rate_flipped'
          : evaluation.reason.includes('hold time')
            ? 'max_hold_time'
            : evaluation.reason.includes('spread')
              ? 'spread_too_wide'
              : 'rate_dropped',
        snapshot.markPrice,
        snapshot.spread,
        netPnlUSDT,
        spreadCost,
        annualizedAPY,
      );

      if (closed) {
        console.log(
          `[ARB] ${symbol}: CLOSED ${closed.direction} — ${closed.exitReason}, ` +
            `netPnL=$${netPnlUSDT.toFixed(4)}, funding=$${closed.totalFundingCollected.toFixed(4)}, ` +
            `held=${closed.holdTimeHours.toFixed(1)}h`,
        );

        await this.alertArbClosed(closed);
      }
    }
  }

  // ============================================
  // Settlement
  // ============================================

  private async processSettlement(
    symbol: string,
    snapshot: import('@/types/funding-arb').FundingRateSnapshot,
  ): Promise<void> {
    const position = this.tracker.getOpenPosition(symbol);
    if (!position) return;

    const lastSettlement = this.tracker.getLastSettlement(symbol);
    const settlementTime = this.engine.getNextSettlementTime(lastSettlement);

    if (!settlementTime) return;

    const payment = this.engine.simulateSettlement(
      position,
      snapshot.fundingRate,
      settlementTime,
    );

    if (payment) {
      this.tracker.recordFundingPayment(symbol, payment);
      this.tracker.setLastSettlement(symbol, settlementTime);

      if (this.verbose) {
        const dir = payment.direction === 'received' ? '+' : '-';
        console.log(
          `[ARB] ${symbol}: settlement ${dir}$${Math.abs(payment.paymentUSDT).toFixed(4)} ` +
            `(rate=${(payment.fundingRate * 100).toFixed(4)}%)`,
        );
      }

      await this.alertSettlement(symbol, payment);
    }
  }

  // ============================================
  // Alerts
  // ============================================

  private async alertArbOpened(
    position: FundingArbPosition,
    breakEvenHours: number,
  ): Promise<void> {
    await this.alerts.send({
      level: 'info',
      event: 'arb_position_opened',
      message: [
        `ARB Opened: ${position.symbol} ${position.direction}`,
        `Rate: ${(position.entryFundingRate * 100).toFixed(4)}%`,
        `Size: $${position.positionSizeUSDT.toFixed(2)}`,
        `Spread: ${(position.entrySpread * 100).toFixed(4)}%`,
        `BE: ${breakEvenHours.toFixed(1)}h`,
      ].join('\n'),
      timestamp: Date.now(),
    });
  }

  private async alertArbClosed(position: FundingArbPosition): Promise<void> {
    const pnlSign = position.netPnlUSDT >= 0 ? '+' : '';
    await this.alerts.send({
      level: position.netPnlUSDT >= 0 ? 'info' : 'warning',
      event: 'arb_position_closed',
      message: [
        `ARB Closed: ${position.symbol} ${position.direction}`,
        `Reason: ${position.exitReason ?? 'unknown'}`,
        `Funding: $${position.totalFundingCollected.toFixed(4)} (${position.fundingPaymentCount} payments)`,
        `Spread cost: $${position.spreadCost.toFixed(4)}`,
        `Net PnL: ${pnlSign}$${position.netPnlUSDT.toFixed(4)}`,
        `Hold: ${position.holdTimeHours.toFixed(1)}h`,
        `APY: ${(position.annualizedAPY * 100).toFixed(1)}%`,
      ].join('\n'),
      timestamp: Date.now(),
    });
  }

  private async alertSettlement(
    symbol: string,
    payment: import('@/types/funding-arb').FundingPayment,
  ): Promise<void> {
    await this.alerts.send({
      level: 'info',
      event: 'funding_settlement',
      message: `Settlement: ${symbol} ${payment.direction} $${Math.abs(payment.paymentUSDT).toFixed(4)} (rate=${(payment.fundingRate * 100).toFixed(4)}%)`,
      timestamp: Date.now(),
    });
  }

  // ============================================
  // Stats
  // ============================================

  getStats(): {
    openPositions: number;
    totalFundingCollected: number;
    closedStats: ReturnType<FundingArbTracker['getClosedPositionStats']>;
  } {
    return {
      openPositions: this.tracker.getOpenCount(),
      totalFundingCollected: this.tracker.getTotalFundingCollected(),
      closedStats: this.tracker.getClosedPositionStats(),
    };
  }
}
