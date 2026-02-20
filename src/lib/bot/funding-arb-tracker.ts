/**
 * Funding Arb Tracker — SQLite Persistence for Arb Positions
 *
 * Persists funding rate snapshots and arb positions to SQLite.
 * Provides query methods for stats aggregation.
 */

import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '@/lib/data/db';
import {
  fundingRateSnapshots,
  fundingArbPositions,
} from '@/lib/data/schema';
import type {
  FundingRateSnapshot,
  FundingArbPosition,
  FundingPayment,
  ArbDirection,
  ArbExitReason,
} from '@/types/funding-arb';

export class FundingArbTracker {
  private openPositions: Map<string, FundingArbPosition> = new Map();
  /** Last settlement timestamp per symbol (to avoid double-counting) */
  private lastSettlement: Map<string, number> = new Map();

  constructor() {
    this.loadOpenPositions();
  }

  // ============================================
  // Snapshot Persistence
  // ============================================

  /** Save a funding rate snapshot to DB */
  saveSnapshot(snapshot: FundingRateSnapshot): void {
    db.insert(fundingRateSnapshots)
      .values({
        symbol: snapshot.symbol,
        fundingRate: snapshot.fundingRate,
        nextFundingTime: snapshot.nextFundingTime,
        markPrice: snapshot.markPrice,
        indexPrice: snapshot.indexPrice,
        bid1: snapshot.bid1,
        ask1: snapshot.ask1,
        spread: snapshot.spread,
        polledAt: snapshot.polledAt,
      })
      .run();
  }

  // ============================================
  // Position Lifecycle
  // ============================================

  /** Open a new arb position */
  openPosition(
    symbol: string,
    direction: ArbDirection,
    snapshot: FundingRateSnapshot,
    positionSizeUSDT: number,
  ): FundingArbPosition {
    const position: FundingArbPosition = {
      id: uuidv4(),
      symbol,
      direction,
      status: 'open',
      entryPrice: snapshot.markPrice,
      entrySpread: snapshot.spread,
      entryFundingRate: snapshot.fundingRate,
      entryTimestamp: Date.now(),
      positionSizeUSDT,
      fundingPayments: [],
      totalFundingCollected: 0,
      fundingPaymentCount: 0,
      spreadCost: 0,
      netPnlUSDT: 0,
      holdTimeHours: 0,
      annualizedAPY: 0,
    };

    // Save to DB
    db.insert(fundingArbPositions)
      .values({
        id: position.id,
        symbol: position.symbol,
        direction: position.direction,
        status: position.status,
        entryPrice: position.entryPrice,
        entrySpread: position.entrySpread,
        entryFundingRate: position.entryFundingRate,
        entryTimestamp: position.entryTimestamp,
        positionSizeUSDT: position.positionSizeUSDT,
        fundingPayments: JSON.stringify(position.fundingPayments),
        totalFundingCollected: position.totalFundingCollected,
        fundingPaymentCount: position.fundingPaymentCount,
        spreadCost: position.spreadCost,
        netPnlUSDT: position.netPnlUSDT,
        holdTimeHours: position.holdTimeHours,
        annualizedAPY: position.annualizedAPY,
        createdAt: Date.now(),
      })
      .run();

    this.openPositions.set(symbol, position);
    return position;
  }

  /** Record a funding payment for an open position */
  recordFundingPayment(symbol: string, payment: FundingPayment): void {
    const position = this.openPositions.get(symbol);
    if (!position) return;

    position.fundingPayments.push(payment);
    position.totalFundingCollected += payment.paymentUSDT;
    position.fundingPaymentCount++;

    // Update DB
    db.update(fundingArbPositions)
      .set({
        fundingPayments: JSON.stringify(position.fundingPayments),
        totalFundingCollected: position.totalFundingCollected,
        fundingPaymentCount: position.fundingPaymentCount,
      })
      .where(eq(fundingArbPositions.id, position.id))
      .run();
  }

  /** Close an arb position */
  closePosition(
    symbol: string,
    exitReason: ArbExitReason,
    exitPrice: number,
    exitSpread: number,
    netPnlUSDT: number,
    spreadCost: number,
    annualizedAPY: number,
  ): FundingArbPosition | null {
    const position = this.openPositions.get(symbol);
    if (!position) return null;

    const now = Date.now();
    position.status = 'closed';
    position.exitPrice = exitPrice;
    position.exitTimestamp = now;
    position.exitReason = exitReason;
    position.exitSpread = exitSpread;
    position.spreadCost = spreadCost;
    position.netPnlUSDT = netPnlUSDT;
    position.holdTimeHours =
      (now - position.entryTimestamp) / (1000 * 60 * 60);
    position.annualizedAPY = annualizedAPY;

    // Update DB
    db.update(fundingArbPositions)
      .set({
        status: 'closed',
        exitPrice: position.exitPrice,
        exitTimestamp: position.exitTimestamp,
        exitReason: position.exitReason,
        exitSpread: position.exitSpread,
        spreadCost: position.spreadCost,
        netPnlUSDT: position.netPnlUSDT,
        holdTimeHours: position.holdTimeHours,
        annualizedAPY: position.annualizedAPY,
        fundingPayments: JSON.stringify(position.fundingPayments),
        totalFundingCollected: position.totalFundingCollected,
        fundingPaymentCount: position.fundingPaymentCount,
      })
      .where(eq(fundingArbPositions.id, position.id))
      .run();

    this.openPositions.delete(symbol);
    return position;
  }

  // ============================================
  // Queries
  // ============================================

  /** Get open arb position for a symbol, or null */
  getOpenPosition(symbol: string): FundingArbPosition | null {
    return this.openPositions.get(symbol) ?? null;
  }

  /** Get all currently open arb positions */
  getOpenPositions(): FundingArbPosition[] {
    return Array.from(this.openPositions.values());
  }

  /** Get number of open arb positions */
  getOpenCount(): number {
    return this.openPositions.size;
  }

  /** Get last settlement timestamp for a symbol */
  getLastSettlement(symbol: string): number {
    return this.lastSettlement.get(symbol) ?? 0;
  }

  /** Set last settlement timestamp */
  setLastSettlement(symbol: string, timestamp: number): void {
    this.lastSettlement.set(symbol, timestamp);
  }

  /** Get total funding collected across all open positions */
  getTotalFundingCollected(): number {
    let total = 0;
    for (const pos of this.openPositions.values()) {
      total += pos.totalFundingCollected;
    }
    return total;
  }

  /** Get total net P&L from closed positions */
  getClosedPositionStats(): {
    totalTrades: number;
    totalNetPnl: number;
    avgAPY: number;
    avgHoldHours: number;
  } {
    const closed = db
      .select()
      .from(fundingArbPositions)
      .where(eq(fundingArbPositions.status, 'closed'))
      .all();

    if (closed.length === 0) {
      return { totalTrades: 0, totalNetPnl: 0, avgAPY: 0, avgHoldHours: 0 };
    }

    const totalNetPnl = closed.reduce((s, r) => s + r.netPnlUSDT, 0);
    const avgAPY =
      closed.reduce((s, r) => s + r.annualizedAPY, 0) / closed.length;
    const avgHoldHours =
      closed.reduce((s, r) => s + r.holdTimeHours, 0) / closed.length;

    return {
      totalTrades: closed.length,
      totalNetPnl,
      avgAPY,
      avgHoldHours,
    };
  }

  // ============================================
  // Load from DB
  // ============================================

  /** Load open positions from DB on startup */
  private loadOpenPositions(): void {
    const rows = db
      .select()
      .from(fundingArbPositions)
      .where(eq(fundingArbPositions.status, 'open'))
      .all();

    for (const row of rows) {
      const payments: FundingPayment[] = JSON.parse(
        row.fundingPayments,
      );
      const position: FundingArbPosition = {
        id: row.id,
        symbol: row.symbol,
        direction: row.direction as ArbDirection,
        status: 'open',
        entryPrice: row.entryPrice,
        entrySpread: row.entrySpread,
        entryFundingRate: row.entryFundingRate,
        entryTimestamp: row.entryTimestamp,
        positionSizeUSDT: row.positionSizeUSDT,
        fundingPayments: payments,
        totalFundingCollected: row.totalFundingCollected,
        fundingPaymentCount: row.fundingPaymentCount,
        spreadCost: row.spreadCost,
        netPnlUSDT: row.netPnlUSDT,
        holdTimeHours: row.holdTimeHours,
        annualizedAPY: row.annualizedAPY,
      };
      this.openPositions.set(row.symbol, position);

      // Set last settlement to latest payment timestamp
      if (payments.length > 0) {
        const lastPayment = payments[payments.length - 1]!;
        this.lastSettlement.set(row.symbol, lastPayment.timestamp);
      }
    }
  }
}
