/**
 * Funding Arb Engine — Entry/Exit State Machine + Settlement
 *
 * Evaluates funding rate conditions for opening/closing arb positions.
 * Simulates funding settlement at 00:00, 08:00, 16:00 UTC.
 *
 * State machine:
 *   MONITORING ──rate > threshold + spread OK──→ OPEN
 *   OPEN ──rate drops / flips / timeout / spread──→ CLOSED
 */

import type {
  FundingRateSnapshot,
  FundingArbPosition,
  FundingArbConfig,
  ArbDirection,
  ArbEvaluation,
  FundingPayment,
} from '@/types/funding-arb';

/** Funding settlement times in hours UTC */
const SETTLEMENT_HOURS = [0, 8, 16];

export class FundingArbEngine {
  private config: FundingArbConfig;

  constructor(config: FundingArbConfig) {
    this.config = config;
  }

  /**
   * Evaluate whether to open a new arb position for a symbol.
   * Called when no arb position exists for the symbol.
   */
  evaluateEntry(snapshot: FundingRateSnapshot): ArbEvaluation {
    const absRate = Math.abs(snapshot.fundingRate);

    // Check minimum funding rate
    if (absRate < this.config.minFundingRate) {
      return {
        action: 'skip',
        reason: `rate ${(snapshot.fundingRate * 100).toFixed(4)}% below min ${(this.config.minFundingRate * 100).toFixed(4)}%`,
        fundingRate: snapshot.fundingRate,
      };
    }

    // Check spread
    if (snapshot.spread > this.config.maxEntrySpread) {
      return {
        action: 'skip',
        reason: `spread ${(snapshot.spread * 100).toFixed(4)}% exceeds max ${(this.config.maxEntrySpread * 100).toFixed(4)}%`,
        spread: snapshot.spread,
        fundingRate: snapshot.fundingRate,
      };
    }

    // Calculate break-even time (hours to recoup spread + commission costs)
    const totalEntryCost =
      snapshot.spread + this.config.commissionPerSide * 2; // entry + exit commission
    const ratePerHour = absRate / 8; // funding is per 8h
    const breakEvenHours =
      ratePerHour > 0 ? totalEntryCost / ratePerHour : Infinity;

    // Reject if break-even takes too long
    if (breakEvenHours > 16) {
      return {
        action: 'skip',
        reason: `break-even ${breakEvenHours.toFixed(1)}h > 16h limit`,
        fundingRate: snapshot.fundingRate,
        spread: snapshot.spread,
        breakEvenHours,
      };
    }

    // Determine direction: if rate positive, shorts pay longs → we go short perp
    const direction: ArbDirection =
      snapshot.fundingRate > 0 ? 'short_perp' : 'long_perp';

    return {
      action: 'open',
      reason: `rate ${(snapshot.fundingRate * 100).toFixed(4)}% (${direction}), BE ${breakEvenHours.toFixed(1)}h`,
      direction,
      fundingRate: snapshot.fundingRate,
      spread: snapshot.spread,
      breakEvenHours,
    };
  }

  /**
   * Evaluate whether to close an existing arb position.
   * Called when an arb position is open for the symbol.
   */
  evaluateExit(
    position: FundingArbPosition,
    snapshot: FundingRateSnapshot,
  ): ArbEvaluation {
    const absRate = Math.abs(snapshot.fundingRate);
    const holdTimeHours =
      (Date.now() - position.entryTimestamp) / (1000 * 60 * 60);

    // 1. Rate flipped sign — close immediately
    const expectedSign =
      position.direction === 'short_perp' ? 1 : -1;
    const currentSign = snapshot.fundingRate > 0 ? 1 : -1;
    if (currentSign !== expectedSign && absRate > this.config.closeBelowRate) {
      return {
        action: 'close',
        reason: `rate flipped to ${(snapshot.fundingRate * 100).toFixed(4)}%`,
        fundingRate: snapshot.fundingRate,
      };
    }

    // 2. Rate dropped below close threshold
    if (absRate < this.config.closeBelowRate) {
      return {
        action: 'close',
        reason: `rate ${(snapshot.fundingRate * 100).toFixed(4)}% below close threshold ${(this.config.closeBelowRate * 100).toFixed(4)}%`,
        fundingRate: snapshot.fundingRate,
      };
    }

    // 3. Max hold time exceeded
    if (holdTimeHours >= this.config.maxHoldTimeHours) {
      return {
        action: 'close',
        reason: `hold time ${holdTimeHours.toFixed(1)}h >= max ${this.config.maxHoldTimeHours}h`,
        fundingRate: snapshot.fundingRate,
      };
    }

    // 4. Spread too wide (might indicate illiquidity)
    if (snapshot.spread > this.config.maxEntrySpread * 2) {
      return {
        action: 'close',
        reason: `spread ${(snapshot.spread * 100).toFixed(4)}% too wide`,
        spread: snapshot.spread,
        fundingRate: snapshot.fundingRate,
      };
    }

    return {
      action: 'hold',
      reason: `rate ${(snapshot.fundingRate * 100).toFixed(4)}%, hold ${holdTimeHours.toFixed(1)}h`,
      fundingRate: snapshot.fundingRate,
    };
  }

  /**
   * Simulate funding settlement for an open position.
   * Should be called when the current time passes a settlement boundary.
   *
   * @returns The funding payment, or null if not a settlement time
   */
  simulateSettlement(
    position: FundingArbPosition,
    currentFundingRate: number,
    now = Date.now(),
  ): FundingPayment | null {
    // Funding payment: positionSize * rate
    const paymentUSDT =
      position.positionSizeUSDT * Math.abs(currentFundingRate);

    // Determine if we receive or pay
    // short_perp + positive rate → we receive
    // long_perp + negative rate → we receive
    const weReceive =
      (position.direction === 'short_perp' && currentFundingRate > 0) ||
      (position.direction === 'long_perp' && currentFundingRate < 0);

    return {
      timestamp: now,
      fundingRate: currentFundingRate,
      paymentUSDT: weReceive ? paymentUSDT : -paymentUSDT,
      direction: weReceive ? 'received' : 'paid',
    };
  }

  /**
   * Check if the current time is at a funding settlement boundary.
   * Settlements occur at 00:00, 08:00, 16:00 UTC.
   *
   * @param lastSettlementTime The timestamp of the last processed settlement
   * @param now Current timestamp
   * @returns The settlement timestamp if one is due, null otherwise
   */
  getNextSettlementTime(
    lastSettlementTime: number,
    now = Date.now(),
  ): number | null {
    const date = new Date(now);
    const utcHour = date.getUTCHours();

    // Find the most recent settlement hour
    let settlementHour = 0;
    for (const h of SETTLEMENT_HOURS) {
      if (utcHour >= h) {
        settlementHour = h;
      }
    }

    // Build the settlement timestamp for today at that hour
    const settlementDate = new Date(date);
    settlementDate.setUTCHours(settlementHour, 0, 0, 0);
    const settlementTs = settlementDate.getTime();

    // If the previous day's last settlement (16:00) hasn't been processed
    if (settlementHour === 0) {
      const yesterdaySettlement = new Date(date);
      yesterdaySettlement.setUTCDate(yesterdaySettlement.getUTCDate() - 1);
      yesterdaySettlement.setUTCHours(16, 0, 0, 0);
      if (yesterdaySettlement.getTime() > lastSettlementTime) {
        return yesterdaySettlement.getTime();
      }
    }

    // Check if this settlement is new (not yet processed)
    if (settlementTs > lastSettlementTime && settlementTs <= now) {
      return settlementTs;
    }

    return null;
  }

  /**
   * Calculate position size for an arb entry.
   * Uses fixed USDT sizing (not risk-based like directional trading).
   */
  calculatePositionSize(
    _snapshot: FundingRateSnapshot,
    maxSize: number,
  ): number {
    // Simple: use configured max, capped by notional
    return Math.min(maxSize, this.config.maxPositionSizeUSDT);
  }

  /**
   * Calculate net P&L for a closing arb position.
   * P&L = totalFundingCollected - spreadCosts - commissionCosts
   */
  calculateNetPnl(
    position: FundingArbPosition,
    exitSpread: number,
  ): { netPnlUSDT: number; spreadCost: number; annualizedAPY: number } {
    const entryCommission =
      position.positionSizeUSDT * this.config.commissionPerSide;
    const exitCommission =
      position.positionSizeUSDT * this.config.commissionPerSide;
    const entryCost = position.entrySpread * position.positionSizeUSDT;
    const exitCost = exitSpread * position.positionSizeUSDT;

    const spreadCost =
      entryCost + exitCost + entryCommission + exitCommission;
    const netPnlUSDT = position.totalFundingCollected - spreadCost;

    // Annualize
    const holdTimeHours =
      (Date.now() - position.entryTimestamp) / (1000 * 60 * 60);
    const holdTimeYears = holdTimeHours / (365.25 * 24);
    const annualizedAPY =
      holdTimeYears > 0 && position.positionSizeUSDT > 0
        ? netPnlUSDT / position.positionSizeUSDT / holdTimeYears
        : 0;

    return { netPnlUSDT, spreadCost, annualizedAPY };
  }
}
