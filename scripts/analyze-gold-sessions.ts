#!/usr/bin/env npx tsx
/**
 * Gold (XAUUSD / GC_F) Session Analysis Script
 *
 * Reads data/GC_F_1h.json and produces statistical analysis of gold's
 * session-driven microstructure to validate the Asian Range + Session model
 * before building a strategy.
 *
 * Analyses:
 * D1. Session-Decomposed Returns
 * D2. Asian Range Statistics
 * D3. Day-of-Week Effects
 * D4. Monthly Seasonality
 * D5. ICT Detection Statistics
 * D6. Regime Distribution
 * D7. Kill Zone Signal Quality (baseline OB strategy)
 * D8. LBMA Fix Window Analysis
 *
 * Usage:
 *   npx tsx scripts/analyze-gold-sessions.ts
 *   npx tsx scripts/analyze-gold-sessions.ts --json
 *   npx tsx scripts/analyze-gold-sessions.ts --save
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  detectOrderBlocks,
  detectFairValueGaps,
  checkKillZone,
  detectLiquidityLevels,
  detectLiquiditySweeps,
} from '@/lib/ict';
import { detectRegime, regimeLabel } from '@/lib/ict/regime-detector';

// ============================================
// Helpers
// ============================================

/** Get NY time info from a UTC timestamp */
function getNewYorkDateTime(timestampMs: number): {
  hour: number;
  dayOfWeek: number; // 0=Sun, 6=Sat
  month: number; // 0-11
  year: number;
  dateStr: string; // YYYY-MM-DD in NY time
} {
  const date = new Date(timestampMs);

  let hour = parseInt(
    date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }),
    10,
  );
  if (hour === 24) hour = 0;

  const dayStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[dayStr] ?? 0;

  const monthStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric' });
  const month = parseInt(monthStr, 10) - 1;

  const yearStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric' });
  const year = parseInt(yearStr, 10);

  const dayNum = date.toLocaleString('en-US', { timeZone: 'America/New_York', day: 'numeric' });
  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(parseInt(dayNum, 10)).padStart(2, '0')}`;

  return { hour, dayOfWeek, month, year, dateStr };
}

/** Session classification for gold */
type GoldSession = 'asian' | 'london' | 'ny_overlap' | 'ny_afternoon' | 'dead_zone';

function classifySession(hourNY: number): GoldSession {
  // Asian: 7pm-12am (19-23)
  if (hourNY >= 19 || hourNY === 0) return 'asian';
  // London: 2am-7am (pre-NY)
  if (hourNY >= 2 && hourNY < 8) return 'london';
  // NY / London overlap: 8am-12pm
  if (hourNY >= 8 && hourNY < 12) return 'ny_overlap';
  // NY afternoon: 12pm-4pm
  if (hourNY >= 12 && hourNY < 16) return 'ny_afternoon';
  // Dead zone: 4pm-7pm (16-18) and 1am
  return 'dead_zone';
}

/** Calculate Sharpe ratio from an array of returns */
function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? (mean / std) * Math.sqrt(252 * 24) : 0; // Annualized hourly Sharpe
}

/** Format a number to fixed decimals */
function fmt(n: number, d = 4): string {
  return n.toFixed(d);
}

function fmtPct(n: number, d = 2): string {
  return (n * 100).toFixed(d) + '%';
}

// ============================================
// D1: Session-Decomposed Returns
// ============================================

interface SessionReturnStats {
  session: string;
  count: number;
  meanReturn: number;
  stdReturn: number;
  sharpe: number;
  totalReturn: number;
}

function analyzeSessionReturns(candles: Candle[]): SessionReturnStats[] {
  const sessionReturns: Record<string, number[]> = {
    asian: [],
    london: [],
    ny_overlap: [],
    ny_afternoon: [],
    dead_zone: [],
  };

  // Also compute per-hour returns
  const hourlyReturns: Record<number, number[]> = {};
  for (let h = 0; h < 24; h++) hourlyReturns[h] = [];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    const ret = (curr.close - prev.close) / prev.close;
    const { hour } = getNewYorkDateTime(curr.timestamp);

    const session = classifySession(hour);
    sessionReturns[session]!.push(ret);
    hourlyReturns[hour]!.push(ret);
  }

  const stats: SessionReturnStats[] = [];
  for (const [session, returns] of Object.entries(sessionReturns)) {
    const mean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (Math.max(1, returns.length - 1));
    const std = Math.sqrt(variance);
    stats.push({
      session,
      count: returns.length,
      meanReturn: mean,
      stdReturn: std,
      sharpe: calcSharpe(returns),
      totalReturn: returns.reduce((s, r) => s + r, 0),
    });
  }

  return stats;
}

// ============================================
// D2: Asian Range Statistics
// ============================================

interface AsianRangeDay {
  date: string;
  high: number;
  low: number;
  rangeSize: number;
  rangePct: number;
  londonBrokeHigh: boolean;
  londonBrokeLow: boolean;
  firstBreakDirection: 'above' | 'below' | 'none';
  reversedAfterSweep: boolean;
}

interface AsianRangeStats {
  totalDays: number;
  avgRangePct: number;
  medianRangePct: number;
  brokenInLondonPct: number;
  brokenHighPct: number;
  brokenLowPct: number;
  firstBreakAbovePct: number;
  firstBreakBelowPct: number;
  reversalAfterSweepPct: number;
  days: AsianRangeDay[];
}

function analyzeAsianRange(candles: Candle[]): AsianRangeStats {
  // Group candles by NY trading day
  const dayCandles = new Map<string, { hour: number; candle: Candle }[]>();

  for (const c of candles) {
    const { hour, dateStr, dayOfWeek } = getNewYorkDateTime(c.timestamp);
    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    // Asian range spans 7pm-12am, which is end of previous day into current day.
    // Group by the trading day that follows the Asian session:
    // Candles at hours 19-23 belong to NEXT day's Asian range.
    // We'll use a slightly different approach: build ranges from the data.
    if (!dayCandles.has(dateStr)) {
      dayCandles.set(dateStr, []);
    }
    dayCandles.get(dateStr)!.push({ hour, candle: c });
  }

  // Build Asian ranges: for each day, Asian range = hours 19,20,21,22,23 of the PREVIOUS day + hour 0 of current day
  // Simpler: iterate candles sequentially and build ranges from 7pm-12am windows
  const asianRanges: AsianRangeDay[] = [];
  let currentAsianHigh = -Infinity;
  let currentAsianLow = Infinity;
  let asianBarCount = 0;
  let currentDate = '';
  let inAsianSession = false;

  // Track the asian range for the subsequent London/NY session
  let pendingAsian: { high: number; low: number; date: string } | null = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const { hour, dayOfWeek, dateStr } = getNewYorkDateTime(c.timestamp);

    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    // Asian session: hours 19-23 (7pm-11pm NY)
    const isAsianHour = hour >= 19 && hour <= 23;

    if (isAsianHour) {
      if (!inAsianSession) {
        // Start new Asian range
        if (asianBarCount > 0 && pendingAsian === null) {
          // Save the completed range
          pendingAsian = { high: currentAsianHigh, low: currentAsianLow, date: currentDate };
        }
        currentAsianHigh = -Infinity;
        currentAsianLow = Infinity;
        asianBarCount = 0;
        inAsianSession = true;
      }
      currentAsianHigh = Math.max(currentAsianHigh, c.high);
      currentAsianLow = Math.min(currentAsianLow, c.low);
      asianBarCount++;
      currentDate = dateStr;
    } else {
      if (inAsianSession && asianBarCount >= 3) {
        // Asian session just ended, save range
        pendingAsian = { high: currentAsianHigh, low: currentAsianLow, date: currentDate };
        inAsianSession = false;
      }

      // During London/NY, check if Asian range was broken
      if (pendingAsian !== null && (hour >= 2 && hour < 16)) {
        const ar = pendingAsian;
        // Find existing day entry or create one
        let dayEntry = asianRanges.find(d => d.date === ar.date);
        if (!dayEntry) {
          const mid = (ar.high + ar.low) / 2;
          dayEntry = {
            date: ar.date,
            high: ar.high,
            low: ar.low,
            rangeSize: ar.high - ar.low,
            rangePct: mid > 0 ? (ar.high - ar.low) / mid : 0,
            londonBrokeHigh: false,
            londonBrokeLow: false,
            firstBreakDirection: 'none',
            reversedAfterSweep: false,
          };
          asianRanges.push(dayEntry);
        }

        // Check London breaks (hours 2-7)
        if (hour >= 2 && hour < 8) {
          if (c.high > ar.high && !dayEntry.londonBrokeHigh) {
            dayEntry.londonBrokeHigh = true;
            if (dayEntry.firstBreakDirection === 'none') {
              dayEntry.firstBreakDirection = 'above';
            }
          }
          if (c.low < ar.low && !dayEntry.londonBrokeLow) {
            dayEntry.londonBrokeLow = true;
            if (dayEntry.firstBreakDirection === 'none') {
              dayEntry.firstBreakDirection = 'below';
            }
          }
        }

        // Check NY session breaks (hours 8-15)
        if (hour >= 8 && hour < 16) {
          if (c.high > ar.high) dayEntry.londonBrokeHigh = true;
          if (c.low < ar.low) dayEntry.londonBrokeLow = true;
        }

        // Check reversal after sweep
        // If price broke above Asian high then closed below it, or vice versa
        if (dayEntry.londonBrokeHigh && c.close < ar.high) {
          dayEntry.reversedAfterSweep = true;
        }
        if (dayEntry.londonBrokeLow && c.close > ar.low) {
          dayEntry.reversedAfterSweep = true;
        }

        // Stop tracking after NY afternoon (4pm)
        if (hour >= 15) {
          pendingAsian = null;
        }
      }
    }
  }

  // Compute aggregate stats
  const rangePcts = asianRanges.map(d => d.rangePct).sort((a, b) => a - b);
  const totalDays = asianRanges.length;
  const brokenCount = asianRanges.filter(d => d.londonBrokeHigh || d.londonBrokeLow).length;
  const brokenHighCount = asianRanges.filter(d => d.londonBrokeHigh).length;
  const brokenLowCount = asianRanges.filter(d => d.londonBrokeLow).length;
  const firstAbove = asianRanges.filter(d => d.firstBreakDirection === 'above').length;
  const firstBelow = asianRanges.filter(d => d.firstBreakDirection === 'below').length;
  const reversals = asianRanges.filter(d => d.reversedAfterSweep).length;

  return {
    totalDays,
    avgRangePct: rangePcts.reduce((s, v) => s + v, 0) / (totalDays || 1),
    medianRangePct: rangePcts[Math.floor(rangePcts.length / 2)] ?? 0,
    brokenInLondonPct: brokenCount / (totalDays || 1),
    brokenHighPct: brokenHighCount / (totalDays || 1),
    brokenLowPct: brokenLowCount / (totalDays || 1),
    firstBreakAbovePct: firstAbove / (totalDays || 1),
    firstBreakBelowPct: firstBelow / (totalDays || 1),
    reversalAfterSweepPct: reversals / (totalDays || 1),
    days: asianRanges,
  };
}

// ============================================
// D3: Day-of-Week Effects
// ============================================

interface DayOfWeekStats {
  day: string;
  count: number;
  meanReturn: number;
  stdReturn: number;
  sharpe: number;
  totalReturn: number;
}

function analyzeDayOfWeek(candles: Candle[]): DayOfWeekStats[] {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayReturns: Record<number, number[]> = {};
  for (let d = 0; d < 7; d++) dayReturns[d] = [];

  // Compute daily returns (open-to-close for each trading day)
  const dailyCandles = new Map<string, Candle[]>();

  for (const c of candles) {
    const { dateStr, dayOfWeek } = getNewYorkDateTime(c.timestamp);
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    if (!dailyCandles.has(dateStr)) dailyCandles.set(dateStr, []);
    dailyCandles.get(dateStr)!.push(c);
  }

  for (const [, dayCs] of dailyCandles) {
    if (dayCs.length < 2) continue;
    const first = dayCs[0]!;
    const last = dayCs[dayCs.length - 1]!;
    const dailyReturn = (last.close - first.open) / first.open;
    const { dayOfWeek } = getNewYorkDateTime(first.timestamp);
    dayReturns[dayOfWeek]!.push(dailyReturn);
  }

  const stats: DayOfWeekStats[] = [];
  for (let d = 1; d <= 5; d++) {
    const returns = dayReturns[d]!;
    const mean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, returns.length - 1);
    stats.push({
      day: dayNames[d]!,
      count: returns.length,
      meanReturn: mean,
      stdReturn: Math.sqrt(variance),
      sharpe: calcSharpe(returns),
      totalReturn: returns.reduce((s, r) => s + r, 0),
    });
  }
  return stats;
}

// ============================================
// D4: Monthly Seasonality
// ============================================

interface MonthlyStats {
  month: string;
  count: number;
  meanReturn: number;
  totalReturn: number;
  sharpe: number;
}

function analyzeMonthlySeasonality(candles: Candle[]): MonthlyStats[] {
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthReturns: Record<number, number[]> = {};
  for (let m = 0; m < 12; m++) monthReturns[m] = [];

  // Group candles by month, compute monthly returns
  const monthlyCandles = new Map<string, Candle[]>();

  for (const c of candles) {
    const { month, year } = getNewYorkDateTime(c.timestamp);
    const key = `${year}-${month}`;
    if (!monthlyCandles.has(key)) monthlyCandles.set(key, []);
    monthlyCandles.get(key)!.push(c);
  }

  for (const [key, mcs] of monthlyCandles) {
    if (mcs.length < 10) continue;
    const first = mcs[0]!;
    const last = mcs[mcs.length - 1]!;
    const monthlyReturn = (last.close - first.open) / first.open;
    const month = parseInt(key.split('-')[1]!, 10);
    monthReturns[month]!.push(monthlyReturn);
  }

  return Array.from({ length: 12 }, (_, m) => {
    const returns = monthReturns[m]!;
    const mean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
    return {
      month: monthNames[m]!,
      count: returns.length,
      meanReturn: mean,
      totalReturn: returns.reduce((s, r) => s + r, 0),
      sharpe: calcSharpe(returns),
    };
  }).filter(m => m.count > 0);
}

// ============================================
// D5: ICT Detection Statistics
// ============================================

interface ICTDetectionStats {
  obsPerDay: number;
  obsPerSession: Record<string, number>;
  obRetestPct: number;
  obReversalPct: number;
  fvgsPerDay: number;
  fvgsPerSession: Record<string, number>;
  fvgFillPct: number;
  avgFvgSizePct: number;
  sweepsPerDay: number;
  sweepsPerSession: Record<string, number>;
}

function analyzeICTDetection(candles: Candle[]): ICTDetectionStats {
  // We'll process in rolling windows of 100 bars to match strategy behavior
  const sessionOBs: Record<string, number> = { asian: 0, london: 0, ny_overlap: 0, ny_afternoon: 0, dead_zone: 0 };
  const sessionFVGs: Record<string, number> = { asian: 0, london: 0, ny_overlap: 0, ny_afternoon: 0, dead_zone: 0 };
  const sessionSweeps: Record<string, number> = { asian: 0, london: 0, ny_overlap: 0, ny_afternoon: 0, dead_zone: 0 };

  let totalOBs = 0;
  let totalFVGs = 0;
  let totalSweeps = 0;
  let totalOBRetests = 0;
  let totalOBReversals = 0;
  let totalFVGFills = 0;
  let fvgSizeSum = 0;

  // Process full candle set for detection stats
  const allOBs = detectOrderBlocks(candles);
  const allFVGs = detectFairValueGaps(candles);

  totalOBs = allOBs.length;
  totalFVGs = allFVGs.length;

  // Attribute OBs/FVGs to sessions
  for (const ob of allOBs) {
    const c = candles[ob.index];
    if (!c) continue;
    const { hour } = getNewYorkDateTime(c.timestamp);
    const session = classifySession(hour);
    sessionOBs[session]!++;
  }

  for (const fvg of allFVGs) {
    const c = candles[fvg.index];
    if (!c) continue;
    const { hour } = getNewYorkDateTime(c.timestamp);
    const session = classifySession(hour);
    sessionFVGs[session]!++;
    fvgSizeSum += fvg.sizePercent;
  }

  // Check OB retests and reversals
  for (const ob of allOBs) {
    let retested = false;
    for (let j = ob.index + 5; j < Math.min(ob.index + 75, candles.length); j++) {
      const c = candles[j];
      if (!c) continue;
      if (ob.type === 'bullish') {
        if (c.low <= ob.high && !retested) {
          retested = true;
          totalOBRetests++;
          // Check if price reversed after retest (closed above OB)
          if (c.close > ob.high) {
            totalOBReversals++;
          }
          break;
        }
      } else {
        if (c.high >= ob.low && !retested) {
          retested = true;
          totalOBRetests++;
          if (c.close < ob.low) {
            totalOBReversals++;
          }
          break;
        }
      }
    }
  }

  // Check FVG fills
  for (const fvg of allFVGs) {
    for (let j = fvg.index + 2; j < Math.min(fvg.index + 50, candles.length); j++) {
      const c = candles[j];
      if (!c) continue;
      if (fvg.type === 'bullish' && c.low <= fvg.low) {
        totalFVGFills++;
        break;
      }
      if (fvg.type === 'bearish' && c.high >= fvg.high) {
        totalFVGFills++;
        break;
      }
    }
  }

  // Sweep detection
  const liquidityLevels = detectLiquidityLevels(candles);
  const sweeps = detectLiquiditySweeps(candles, liquidityLevels);
  totalSweeps = sweeps.length;

  for (const s of sweeps) {
    const c = candles[s.sweepIndex];
    if (!c) continue;
    const { hour } = getNewYorkDateTime(c.timestamp);
    const session = classifySession(hour);
    sessionSweeps[session]!++;
  }

  // Estimate trading days
  const tradingDays = new Set<string>();
  for (const c of candles) {
    const { dateStr, dayOfWeek } = getNewYorkDateTime(c.timestamp);
    if (dayOfWeek >= 1 && dayOfWeek <= 5) tradingDays.add(dateStr);
  }
  const numDays = tradingDays.size || 1;

  return {
    obsPerDay: totalOBs / numDays,
    obsPerSession: Object.fromEntries(
      Object.entries(sessionOBs).map(([k, v]) => [k, v / numDays]),
    ),
    obRetestPct: totalOBRetests / (totalOBs || 1),
    obReversalPct: totalOBReversals / (totalOBRetests || 1),
    fvgsPerDay: totalFVGs / numDays,
    fvgsPerSession: Object.fromEntries(
      Object.entries(sessionFVGs).map(([k, v]) => [k, v / numDays]),
    ),
    fvgFillPct: totalFVGFills / (totalFVGs || 1),
    avgFvgSizePct: fvgSizeSum / (totalFVGs || 1),
    sweepsPerDay: totalSweeps / numDays,
    sweepsPerSession: Object.fromEntries(
      Object.entries(sessionSweeps).map(([k, v]) => [k, v / numDays]),
    ),
  };
}

// ============================================
// D6: Regime Distribution
// ============================================

interface RegimeDistribution {
  label: string;
  count: number;
  pct: number;
}

function analyzeRegimeDistribution(candles: Candle[]): RegimeDistribution[] {
  const counts: Record<string, number> = {};
  let total = 0;

  for (let i = 500; i < candles.length; i++) {
    const regime = detectRegime(candles, i);
    const label = regimeLabel(regime);
    counts[label] = (counts[label] ?? 0) + 1;
    total++;
  }

  return Object.entries(counts)
    .map(([label, count]) => ({
      label,
      count,
      pct: count / (total || 1),
    }))
    .sort((a, b) => b.count - a.count);
}

// ============================================
// D7: Kill Zone Signal Quality
// ============================================

interface KillZoneQuality {
  killZone: string;
  tradeCount: number;
  winRate: number;
  avgR: number;
  sharpe: number;
}

function analyzeKillZoneQuality(candles: Candle[]): KillZoneQuality[] {
  // Quick baseline: run OB strategy on gold with simplified simulation
  // Group trades by kill zone at entry time
  const kzTrades: Record<string, number[]> = {
    london_open: [],
    ny_open: [],
    london_close: [],
    asian: [],
    none: [],
  };

  const allOBs = detectOrderBlocks(candles);

  for (const ob of allOBs) {
    // Find retest within 75 bars
    for (let j = ob.index + 3; j < Math.min(ob.index + 75, candles.length - 20); j++) {
      const c = candles[j];
      if (!c) continue;

      let entry = false;
      let entryPrice = 0;
      let stopLoss = 0;
      let takeProfit = 0;
      let direction: 'long' | 'short' = 'long';

      if (ob.type === 'bullish' && c.low <= ob.high && c.close > ob.high) {
        entry = true;
        entryPrice = c.close;
        stopLoss = ob.low;
        const risk = entryPrice - stopLoss;
        takeProfit = entryPrice + risk * 2;
        direction = 'long';
      } else if (ob.type === 'bearish' && c.high >= ob.low && c.close < ob.low) {
        entry = true;
        entryPrice = c.close;
        stopLoss = ob.high;
        const risk = stopLoss - entryPrice;
        takeProfit = entryPrice - risk * 2;
        direction = 'short';
      }

      if (entry && stopLoss !== entryPrice) {
        // Simulate trade
        const kz = checkKillZone(c.timestamp);
        let exitPrice = entryPrice;
        const risk = Math.abs(entryPrice - stopLoss);

        for (let k = j + 1; k < Math.min(j + 100, candles.length); k++) {
          const ec = candles[k];
          if (!ec) continue;
          if (direction === 'long') {
            if (ec.low <= stopLoss) { exitPrice = stopLoss; break; }
            if (ec.high >= takeProfit) { exitPrice = takeProfit; break; }
          } else {
            if (ec.high >= stopLoss) { exitPrice = stopLoss; break; }
            if (ec.low <= takeProfit) { exitPrice = takeProfit; break; }
          }
          exitPrice = ec.close; // Max bars close
        }

        const pnl = direction === 'long'
          ? (exitPrice - entryPrice) / risk
          : (entryPrice - exitPrice) / risk;

        kzTrades[kz.type]!.push(pnl);
        break; // Only first retest per OB
      }
    }
  }

  return Object.entries(kzTrades).map(([kz, pnls]) => {
    const wins = pnls.filter(p => p > 0).length;
    const mean = pnls.reduce((s, p) => s + p, 0) / (pnls.length || 1);
    return {
      killZone: kz,
      tradeCount: pnls.length,
      winRate: wins / (pnls.length || 1),
      avgR: mean,
      sharpe: calcSharpe(pnls),
    };
  });
}

// ============================================
// D8: LBMA Fix Window Analysis
// ============================================

interface LBMAFixStats {
  fixHour: number;
  count: number;
  meanReturn: number;
  stdReturn: number;
  sharpe: number;
  surroundingHours: { hour: number; meanReturn: number; stdReturn: number }[];
}

function analyzeLBMAFix(candles: Candle[]): LBMAFixStats {
  // LBMA PM Fix is at 3pm London = 10am NY
  const fixHour = 10;
  const hourReturns: Record<number, number[]> = {};
  for (let h = 7; h <= 13; h++) hourReturns[h] = [];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    const ret = (curr.close - prev.close) / prev.close;
    const { hour } = getNewYorkDateTime(curr.timestamp);

    if (hour >= 7 && hour <= 13) {
      hourReturns[hour]!.push(ret);
    }
  }

  const fixReturns = hourReturns[fixHour]!;
  const fixMean = fixReturns.reduce((s, r) => s + r, 0) / (fixReturns.length || 1);
  const fixVar = fixReturns.reduce((s, r) => s + (r - fixMean) ** 2, 0) / Math.max(1, fixReturns.length - 1);

  const surrounding = Object.entries(hourReturns)
    .filter(([h]) => parseInt(h) !== fixHour)
    .map(([h, rets]) => {
      const m = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
      const v = rets.reduce((s, r) => s + (r - m) ** 2, 0) / Math.max(1, rets.length - 1);
      return { hour: parseInt(h), meanReturn: m, stdReturn: Math.sqrt(v) };
    });

  return {
    fixHour,
    count: fixReturns.length,
    meanReturn: fixMean,
    stdReturn: Math.sqrt(fixVar),
    sharpe: calcSharpe(fixReturns),
    surroundingHours: surrounding,
  };
}

// ============================================
// Hourly Volatility Profile
// ============================================

interface HourlyVolProfile {
  hour: number;
  session: string;
  avgRange: number;
  avgRangePct: number;
  count: number;
}

function analyzeHourlyVolatility(candles: Candle[]): HourlyVolProfile[] {
  const hourData: Record<number, { ranges: number[]; rangePcts: number[] }> = {};
  for (let h = 0; h < 24; h++) hourData[h] = { ranges: [], rangePcts: [] };

  for (const c of candles) {
    const { hour } = getNewYorkDateTime(c.timestamp);
    const r = c.high - c.low;
    const mid = (c.high + c.low) / 2;
    hourData[hour]!.ranges.push(r);
    hourData[hour]!.rangePcts.push(mid > 0 ? r / mid : 0);
  }

  return Array.from({ length: 24 }, (_, h) => {
    const data = hourData[h]!;
    return {
      hour: h,
      session: classifySession(h),
      avgRange: data.ranges.reduce((s, v) => s + v, 0) / (data.ranges.length || 1),
      avgRangePct: data.rangePcts.reduce((s, v) => s + v, 0) / (data.rangePcts.length || 1),
      count: data.ranges.length,
    };
  });
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const jsonMode = process.argv.includes('--json');
  const shouldSave = process.argv.includes('--save');

  // Load gold data
  const dataPath = path.join(process.cwd(), 'data', 'GC_F_1h.json');
  if (!fs.existsSync(dataPath)) {
    console.error(`Error: Gold data not found at ${dataPath}`);
    console.error('Run data download script first.');
    process.exit(1);
  }

  const candles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`Loaded ${candles.length} hourly gold candles`);
  console.log(`Period: ${new Date(candles[0]!.timestamp).toISOString()} to ${new Date(candles[candles.length - 1]!.timestamp).toISOString()}`);
  console.log(`Price range: $${candles.reduce((m, c) => Math.min(m, c.low), Infinity).toFixed(0)} - $${candles.reduce((m, c) => Math.max(m, c.high), 0).toFixed(0)}`);
  console.log('');

  // D1: Session Returns
  console.log('=== D1: Session-Decomposed Returns ===');
  const sessionStats = analyzeSessionReturns(candles);
  console.log('Session          | Count | Mean Return | Std Dev    | Sharpe  | Total Return');
  console.log('-----------------|-------|-------------|------------|---------|-------------');
  for (const s of sessionStats) {
    console.log(
      `${s.session.padEnd(16)} | ${String(s.count).padStart(5)} | ${fmtPct(s.meanReturn, 4).padStart(11)} | ${fmtPct(s.stdReturn, 4).padStart(10)} | ${fmt(s.sharpe, 2).padStart(7)} | ${fmtPct(s.totalReturn, 2).padStart(11)}`,
    );
  }
  console.log('');

  // Hourly Volatility Profile
  console.log('=== Hourly Volatility Profile (NY time) ===');
  const hourlyVol = analyzeHourlyVolatility(candles);
  console.log('Hour | Session        | Avg Range ($) | Avg Range (%) | Count');
  console.log('-----|----------------|---------------|---------------|------');
  for (const h of hourlyVol) {
    console.log(
      `  ${String(h.hour).padStart(2)} | ${h.session.padEnd(14)} | ${h.avgRange.toFixed(2).padStart(13)} | ${fmtPct(h.avgRangePct, 3).padStart(13)} | ${h.count}`,
    );
  }
  console.log('');

  // D2: Asian Range
  console.log('=== D2: Asian Range Statistics ===');
  const asianStats = analyzeAsianRange(candles);
  console.log(`Total trading days analyzed: ${asianStats.totalDays}`);
  console.log(`Average Asian range: ${fmtPct(asianStats.avgRangePct, 3)} ($${(asianStats.avgRangePct * candles[candles.length - 1]!.close).toFixed(1)})`);
  console.log(`Median Asian range: ${fmtPct(asianStats.medianRangePct, 3)}`);
  console.log(`Broken in London/NY: ${fmtPct(asianStats.brokenInLondonPct, 1)}`);
  console.log(`  - High broken: ${fmtPct(asianStats.brokenHighPct, 1)}`);
  console.log(`  - Low broken: ${fmtPct(asianStats.brokenLowPct, 1)}`);
  console.log(`First break direction:`);
  console.log(`  - Above: ${fmtPct(asianStats.firstBreakAbovePct, 1)}`);
  console.log(`  - Below: ${fmtPct(asianStats.firstBreakBelowPct, 1)}`);
  console.log(`Reversal after sweep: ${fmtPct(asianStats.reversalAfterSweepPct, 1)}`);
  console.log('');

  // D3: Day-of-Week
  console.log('=== D3: Day-of-Week Effects ===');
  const dowStats = analyzeDayOfWeek(candles);
  console.log('Day       | Days | Mean Return | Std Dev    | Sharpe  | Total Return');
  console.log('----------|------|-------------|------------|---------|-------------');
  for (const d of dowStats) {
    console.log(
      `${d.day.padEnd(9)} | ${String(d.count).padStart(4)} | ${fmtPct(d.meanReturn, 4).padStart(11)} | ${fmtPct(d.stdReturn, 4).padStart(10)} | ${fmt(d.sharpe, 2).padStart(7)} | ${fmtPct(d.totalReturn, 2).padStart(11)}`,
    );
  }
  console.log('');

  // D4: Monthly Seasonality
  console.log('=== D4: Monthly Seasonality ===');
  const monthStats = analyzeMonthlySeasonality(candles);
  console.log('Month | Months | Mean Return | Total Return | Sharpe');
  console.log('------|--------|-------------|--------------|-------');
  for (const m of monthStats) {
    console.log(
      `${m.month.padEnd(5)} | ${String(m.count).padStart(6)} | ${fmtPct(m.meanReturn, 3).padStart(11)} | ${fmtPct(m.totalReturn, 2).padStart(12)} | ${fmt(m.sharpe, 2).padStart(6)}`,
    );
  }
  console.log('');

  // D5: ICT Detection
  console.log('=== D5: ICT Detection Statistics ===');
  const ictStats = analyzeICTDetection(candles);
  console.log(`Order Blocks per day: ${ictStats.obsPerDay.toFixed(1)}`);
  console.log('  Per session:');
  for (const [session, count] of Object.entries(ictStats.obsPerSession)) {
    console.log(`    ${session.padEnd(14)}: ${count.toFixed(2)}`);
  }
  console.log(`  OB retest rate: ${fmtPct(ictStats.obRetestPct, 1)}`);
  console.log(`  OB reversal rate (after retest): ${fmtPct(ictStats.obReversalPct, 1)}`);
  console.log('');
  console.log(`Fair Value Gaps per day: ${ictStats.fvgsPerDay.toFixed(1)}`);
  console.log('  Per session:');
  for (const [session, count] of Object.entries(ictStats.fvgsPerSession)) {
    console.log(`    ${session.padEnd(14)}: ${count.toFixed(2)}`);
  }
  console.log(`  FVG fill rate: ${fmtPct(ictStats.fvgFillPct, 1)}`);
  console.log(`  Avg FVG size: ${ictStats.avgFvgSizePct.toFixed(3)}%`);
  console.log('');
  console.log(`Liquidity Sweeps per day: ${ictStats.sweepsPerDay.toFixed(2)}`);
  console.log('  Per session:');
  for (const [session, count] of Object.entries(ictStats.sweepsPerSession)) {
    console.log(`    ${session.padEnd(14)}: ${count.toFixed(3)}`);
  }
  console.log('');

  // D6: Regime Distribution
  console.log('=== D6: Regime Distribution ===');
  const regimes = analyzeRegimeDistribution(candles);
  console.log('Regime              | Count | Pct');
  console.log('--------------------|-------|--------');
  for (const r of regimes) {
    console.log(`${r.label.padEnd(19)} | ${String(r.count).padStart(5)} | ${fmtPct(r.pct, 1).padStart(6)}`);
  }
  console.log('');

  // D7: Kill Zone Signal Quality
  console.log('=== D7: Kill Zone Signal Quality (Baseline OB Strategy) ===');
  const kzQuality = analyzeKillZoneQuality(candles);
  console.log('Kill Zone      | Trades | Win Rate | Avg R  | Sharpe');
  console.log('---------------|--------|----------|--------|-------');
  for (const kz of kzQuality) {
    console.log(
      `${kz.killZone.padEnd(14)} | ${String(kz.tradeCount).padStart(6)} | ${fmtPct(kz.winRate, 1).padStart(8)} | ${fmt(kz.avgR, 2).padStart(6)} | ${fmt(kz.sharpe, 2).padStart(6)}`,
    );
  }
  console.log('');

  // D8: LBMA Fix
  console.log('=== D8: LBMA PM Fix Window (10am NY) ===');
  const lbma = analyzeLBMAFix(candles);
  console.log(`Fix hour (10am NY): ${lbma.count} observations`);
  console.log(`  Mean return: ${fmtPct(lbma.meanReturn, 4)}`);
  console.log(`  Std dev: ${fmtPct(lbma.stdReturn, 4)}`);
  console.log(`  Sharpe: ${fmt(lbma.sharpe, 2)}`);
  console.log('Surrounding hours:');
  for (const sh of lbma.surroundingHours) {
    console.log(`  ${sh.hour}am NY: mean=${fmtPct(sh.meanReturn, 4)}, std=${fmtPct(sh.stdReturn, 4)}`);
  }
  console.log('');

  // ATR% for reference
  const atrPcts: number[] = [];
  for (let i = 14; i < candles.length; i++) {
    let atrSum = 0;
    for (let j = i - 13; j <= i; j++) {
      const curr = candles[j]!;
      const prev = candles[j - 1]!;
      const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
      atrSum += tr;
    }
    const atr14 = atrSum / 14;
    atrPcts.push(atr14 / candles[i]!.close);
  }
  atrPcts.sort((a, b) => a - b);
  const medianAtrPct = atrPcts[Math.floor(atrPcts.length / 2)] ?? 0;
  const p25AtrPct = atrPcts[Math.floor(atrPcts.length * 0.25)] ?? 0;
  const p75AtrPct = atrPcts[Math.floor(atrPcts.length * 0.75)] ?? 0;

  console.log('=== Gold ATR% Reference ===');
  console.log(`Median 14-bar ATR%: ${fmtPct(medianAtrPct, 3)}`);
  console.log(`25th percentile: ${fmtPct(p25AtrPct, 3)}`);
  console.log(`75th percentile: ${fmtPct(p75AtrPct, 3)}`);
  console.log(`Volatility scale (current): ${medianAtrPct >= 0.002 ? '1.0 (treated as crypto — BUG)' : (medianAtrPct / 0.006).toFixed(3)}`);
  console.log(`Volatility scale (proposed): ${Math.min(1.0, medianAtrPct / 0.015).toFixed(3)}`);
  console.log('');

  // Save results
  if (shouldSave || jsonMode) {
    const results = {
      metadata: {
        candleCount: candles.length,
        periodStart: new Date(candles[0]!.timestamp).toISOString(),
        periodEnd: new Date(candles[candles.length - 1]!.timestamp).toISOString(),
        priceRange: {
          low: candles.reduce((m, c) => Math.min(m, c.low), Infinity),
          high: candles.reduce((m, c) => Math.max(m, c.high), 0),
        },
        medianAtrPct,
      },
      sessionReturns: sessionStats,
      hourlyVolatility: hourlyVol,
      asianRange: {
        totalDays: asianStats.totalDays,
        avgRangePct: asianStats.avgRangePct,
        medianRangePct: asianStats.medianRangePct,
        brokenInLondonPct: asianStats.brokenInLondonPct,
        brokenHighPct: asianStats.brokenHighPct,
        brokenLowPct: asianStats.brokenLowPct,
        firstBreakAbovePct: asianStats.firstBreakAbovePct,
        firstBreakBelowPct: asianStats.firstBreakBelowPct,
        reversalAfterSweepPct: asianStats.reversalAfterSweepPct,
      },
      dayOfWeek: dowStats,
      monthly: monthStats,
      ictDetection: ictStats,
      regimeDistribution: regimes,
      killZoneQuality: kzQuality,
      lbmaFix: lbma,
    };

    const outDir = path.join(process.cwd(), 'experiments');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'gold-session-analysis.json');
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`Results saved to: ${outPath}`);
  }

  // Decision gate summary
  console.log('');
  console.log('=== DECISION GATES ===');
  const asianBrokenPct = asianStats.brokenInLondonPct * 100;
  console.log(`[${asianBrokenPct >= 50 ? 'PASS' : 'FAIL'}] Asian range broken in London/NY: ${asianBrokenPct.toFixed(1)}% (threshold: 50%)`);

  const londonVol = sessionStats.find(s => s.session === 'london');
  const asianVol = sessionStats.find(s => s.session === 'asian');
  const volRatio = (londonVol?.stdReturn ?? 0) / (asianVol?.stdReturn ?? 1);
  console.log(`[${volRatio > 1.2 ? 'PASS' : 'FAIL'}] London volatility > Asian: ratio=${volRatio.toFixed(2)}x (threshold: 1.2x)`);

  const reversalPct = asianStats.reversalAfterSweepPct * 100;
  console.log(`[${reversalPct >= 40 ? 'PASS' : 'WARN'}] Reversal after Asian sweep: ${reversalPct.toFixed(1)}% (threshold: 40%)`);

  const bestKZ = kzQuality.reduce((best, kz) => kz.tradeCount > 10 && kz.winRate > best.winRate ? kz : best, { killZone: 'none', winRate: 0, tradeCount: 0, avgR: 0, sharpe: 0 });
  console.log(`[INFO] Best kill zone: ${bestKZ.killZone} (${bestKZ.tradeCount} trades, ${fmtPct(bestKZ.winRate, 1)} WR, ${fmt(bestKZ.avgR, 2)}R)`);
}

// Run
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('analyze-gold-sessions.ts') ||
    process.argv[1].endsWith('analyze-gold-sessions'));

if (isMain) {
  main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}

export { analyzeSessionReturns, analyzeAsianRange, analyzeDayOfWeek, analyzeMonthlySeasonality };
