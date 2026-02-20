/**
 * LTF Confirmation — 5m Entry Timing State Machine
 *
 * When the 1H model fires a signal, this module watches 5m candles
 * for tighter entry confirmation:
 *
 * State machine:
 *   [1H signal] → WAITING_FOR_ZONE → WATCHING_CONFIRMATION → CONFIRMED
 *                        │ timeout          │ timeout
 *                        ▼                  ▼
 *                     EXPIRED            EXPIRED
 *
 * Confirmation requires:
 *   1. Price enters the order block zone on 5m
 *   2. 5m market structure shift (CHoCH/BOS) in trade direction
 *   3. CVD alignment (buy/sell pressure confirmation)
 *   4. Optional: volume spike above threshold
 */

import type { Candle } from '@/types/candle';
import type { LTFConfig } from '@/types/bot';
import type { ScoredSignal } from '@/lib/rl/strategies/confluence-scorer';
import {
  detectSwingHighs,
  detectSwingLows,
  detectBOS,
  detectCHoCH,
} from '@/lib/ict/market-structure';
import type { DataFeed } from './data-feed';
import type { BotSymbol } from '@/types/bot';

// ============================================
// Types
// ============================================

type LTFState = 'waiting_for_zone' | 'watching_confirmation' | 'confirmed' | 'expired';

interface LTFSetup {
  symbol: string;
  signal: ScoredSignal;
  state: LTFState;
  createdAt: number;
  /** Upper/lower bounds of the OB zone (from signal entry/SL) */
  zoneHigh: number;
  zoneLow: number;
  /** 5m bar count since setup created */
  barsWaited: number;
  /** 5m bar count since zone entry */
  barsInZone: number;
  /** Last processed 5m candle timestamp */
  lastLTFTimestamp: number;
  /** 1H candles at time of signal (for context) */
  htfCandles: Candle[];
}

export interface LTFResult {
  status: 'confirmed' | 'expired' | 'pending';
  signal: ScoredSignal;
  ltfEntry: number;
  ltfStopLoss: number;
  barsWaited: number;
}

// ============================================
// CVD Calculation
// ============================================

/**
 * Approximate Cumulative Volume Delta from OHLCV.
 * Buy volume ≈ ((close - low) / (high - low)) * volume
 * CVD = cumulative sum of (buy - sell) volume
 */
function calculateCVD(candles: Candle[]): number[] {
  const cvd: number[] = [];
  let cumulative = 0;

  for (const c of candles) {
    const range = c.high - c.low;
    if (range <= 0) {
      cvd.push(cumulative);
      continue;
    }
    const buyPct = (c.close - c.low) / range;
    const buyVol = buyPct * c.volume;
    const sellVol = (1 - buyPct) * c.volume;
    cumulative += buyVol - sellVol;
    cvd.push(cumulative);
  }

  return cvd;
}

/**
 * Check if CVD trend aligns with trade direction over a lookback window.
 * For longs: CVD should be rising (positive slope).
 * For shorts: CVD should be falling (negative slope).
 */
function isCVDAligned(
  cvd: number[],
  direction: 'long' | 'short',
  lookback: number,
): boolean {
  if (cvd.length < lookback + 1) return false;

  const start = cvd[cvd.length - lookback - 1]!;
  const end = cvd[cvd.length - 1]!;
  const slope = end - start;

  return direction === 'long' ? slope > 0 : slope < 0;
}

// ============================================
// Volume Spike Detection
// ============================================

function hasVolumeSpike(
  candles: Candle[],
  threshold: number,
  lookback = 20,
): boolean {
  if (candles.length < lookback + 1) return false;

  const recent = candles.slice(-lookback - 1, -1);
  const avgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const latest = candles[candles.length - 1]!;

  return avgVol > 0 && latest.volume / avgVol >= threshold;
}

// ============================================
// LTF Confirmation Engine
// ============================================

export class LTFConfirmation {
  private config: LTFConfig;
  private dataFeed: DataFeed;
  private setups: Map<string, LTFSetup> = new Map();

  constructor(config: LTFConfig, dataFeed: DataFeed) {
    this.config = config;
    this.dataFeed = dataFeed;
  }

  /** Check if there's a pending LTF setup for a symbol */
  hasPendingSetup(symbol: string): boolean {
    const setup = this.setups.get(symbol);
    return !!setup && (setup.state === 'waiting_for_zone' || setup.state === 'watching_confirmation');
  }

  /**
   * Create a new LTF setup when a 1H signal fires.
   * Defines the OB zone from the signal's entry and SL levels.
   */
  createSetup(
    symbol: string,
    signal: ScoredSignal,
    htfCandles: Candle[],
  ): void {
    const { entryPrice, stopLoss, direction } = signal.signal;

    // OB zone: area between entry and a fraction toward SL
    // For longs, zone is below entry. For shorts, zone is above entry.
    const zoneDepth = Math.abs(entryPrice - stopLoss) * 0.5;

    let zoneHigh: number;
    let zoneLow: number;

    if (direction === 'long') {
      zoneHigh = entryPrice;
      zoneLow = entryPrice - zoneDepth;
    } else {
      zoneLow = entryPrice;
      zoneHigh = entryPrice + zoneDepth;
    }

    this.setups.set(symbol, {
      symbol,
      signal,
      state: 'waiting_for_zone',
      createdAt: Date.now(),
      zoneHigh,
      zoneLow,
      barsWaited: 0,
      barsInZone: 0,
      lastLTFTimestamp: 0,
      htfCandles: htfCandles.slice(-50), // Keep last 50 1H candles for context
    });
  }

  /**
   * Process a pending LTF setup — poll 5m candles and advance state machine.
   * Should be called every tick (~30s).
   *
   * @returns Result if state transitioned to confirmed/expired, null if still pending
   */
  async processSetup(symbol: string): Promise<LTFResult | null> {
    const setup = this.setups.get(symbol);
    if (!setup) return null;

    // Fetch latest 5m candles
    const ltfCandles = await this.fetchLTFCandles(symbol as BotSymbol);
    if (ltfCandles.length === 0) return null;

    // Check for new 5m candles since last process
    const latestTimestamp = ltfCandles[ltfCandles.length - 1]!.timestamp;
    if (latestTimestamp <= setup.lastLTFTimestamp) return null;

    // Count new bars
    const newBars = ltfCandles.filter((c) => c.timestamp > setup.lastLTFTimestamp).length;
    setup.barsWaited += newBars;
    setup.lastLTFTimestamp = latestTimestamp;

    const latestCandle = ltfCandles[ltfCandles.length - 1]!;
    const direction = setup.signal.signal.direction;

    // ---- State Machine ----

    if (setup.state === 'waiting_for_zone') {
      // Check if price entered the OB zone
      const inZone = latestCandle.low <= setup.zoneHigh && latestCandle.high >= setup.zoneLow;

      if (inZone) {
        setup.state = 'watching_confirmation';
        setup.barsInZone = 0;
      } else if (setup.barsWaited >= this.config.zoneTimeoutBars) {
        // Zone timeout
        setup.state = 'expired';
        this.setups.delete(symbol);
        return {
          status: 'expired',
          signal: setup.signal,
          ltfEntry: 0,
          ltfStopLoss: 0,
          barsWaited: setup.barsWaited,
        };
      }
    }

    if (setup.state === 'watching_confirmation') {
      setup.barsInZone += newBars;

      // Check confirmation conditions
      const confirmed = this.checkConfirmation(ltfCandles, direction);

      if (confirmed) {
        setup.state = 'confirmed';

        // Calculate LTF entry and SL from 5m structure
        const { ltfEntry, ltfStopLoss } = this.calculateLTFLevels(
          ltfCandles,
          direction,
        );

        this.setups.delete(symbol);
        return {
          status: 'confirmed',
          signal: setup.signal,
          ltfEntry,
          ltfStopLoss,
          barsWaited: setup.barsWaited,
        };
      }

      // Check confirmation timeout
      if (setup.barsInZone >= this.config.confirmTimeoutBars) {
        setup.state = 'expired';
        this.setups.delete(symbol);
        return {
          status: 'expired',
          signal: setup.signal,
          ltfEntry: 0,
          ltfStopLoss: 0,
          barsWaited: setup.barsWaited,
        };
      }
    }

    return null; // Still pending
  }

  /**
   * Check all confirmation conditions on 5m candles.
   */
  private checkConfirmation(
    candles: Candle[],
    direction: 'long' | 'short',
  ): boolean {
    // 1. Market Structure Shift (MSS) — BOS or CHoCH in trade direction
    if (this.config.requireMSS) {
      const swingConfig = { lookback: this.config.ltfSwingLookback, minStrength: 1 };
      const highs = detectSwingHighs(candles, swingConfig);
      const lows = detectSwingLows(candles, swingConfig);

      const bosBreaks = detectBOS(candles, highs, lows);
      const chochBreaks = detectCHoCH(candles, highs, lows);
      const allBreaks = [...bosBreaks, ...chochBreaks];

      // Need a recent break (within last 5 candles) in our direction
      const recentBreaks = allBreaks.filter((b) => {
        const isRecent = b.breakIndex >= candles.length - 5;
        const isAligned =
          (direction === 'long' && b.direction === 'bullish') ||
          (direction === 'short' && b.direction === 'bearish');
        return isRecent && isAligned;
      });

      if (recentBreaks.length === 0) return false;
    }

    // 2. CVD alignment
    if (this.config.requireCVD) {
      const cvd = calculateCVD(candles);
      if (!isCVDAligned(cvd, direction, this.config.cvdLookback)) {
        return false;
      }
    }

    // 3. Volume spike (optional)
    if (this.config.requireVolumeSpike) {
      if (!hasVolumeSpike(candles, this.config.volumeSpikeThreshold)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Calculate tighter entry and SL levels from 5m price action.
   * Entry: latest 5m close (where MSS confirmed).
   * SL: most recent 5m swing in the opposite direction.
   */
  private calculateLTFLevels(
    candles: Candle[],
    direction: 'long' | 'short',
  ): { ltfEntry: number; ltfStopLoss: number } {
    const latestClose = candles[candles.length - 1]!.close;
    const swingConfig = { lookback: this.config.ltfSwingLookback, minStrength: 1 };

    if (direction === 'long') {
      // SL below recent 5m swing low
      const lows = detectSwingLows(candles, swingConfig);
      const recentLow = lows.length > 0 ? lows[lows.length - 1]! : null;
      const ltfStopLoss = recentLow
        ? recentLow.price * 0.999 // Small buffer below swing low
        : candles[candles.length - 1]!.low * 0.999;

      return { ltfEntry: latestClose, ltfStopLoss };
    } else {
      // SL above recent 5m swing high
      const highs = detectSwingHighs(candles, swingConfig);
      const recentHigh = highs.length > 0 ? highs[highs.length - 1]! : null;
      const ltfStopLoss = recentHigh
        ? recentHigh.price * 1.001 // Small buffer above swing high
        : candles[candles.length - 1]!.high * 1.001;

      return { ltfEntry: latestClose, ltfStopLoss };
    }
  }

  /**
   * Fetch LTF candles from Bybit using the data feed's REST client.
   */
  private async fetchLTFCandles(symbol: BotSymbol): Promise<Candle[]> {
    return this.dataFeed.fetchLTFCandles(
      symbol,
      this.config.ltfInterval,
      100,
    );
  }

  /** Clear all pending setups (e.g., on shutdown) */
  clearAll(): void {
    this.setups.clear();
  }

  /** Get info about pending setups for logging */
  getPendingSetups(): Array<{ symbol: string; state: LTFState; barsWaited: number }> {
    return Array.from(this.setups.values()).map((s) => ({
      symbol: s.symbol,
      state: s.state,
      barsWaited: s.barsWaited,
    }));
  }
}
