/**
 * Gold-specific context that AUGMENTS the existing setup page.
 * Not duplicated here: HTF bias (HTFMiniGrid), kill zone (KillZoneBadge),
 * checklist (ChecklistCard), OB/FVG/liquidity overlays (SetupChart).
 *
 * What lives here is gold-only signal: midnight-open anchor, Asian range
 * judas state, DXY inversion, US news flag, and an aggregate verdict.
 */

export type Verdict = 'TRADE' | 'WAIT' | 'SKIP';
export type TrafficLight = 'green' | 'amber' | 'red';
export type Direction = 'long' | 'short' | 'neutral';
export type Premium = 'premium' | 'discount' | 'at_open';

export interface MidnightOpenRow {
  price: number;
  priceVsMidnight: Premium;
  light: TrafficLight;
  note: string;
}

export interface AsianRangeRow {
  high: number;
  low: number;
  highSwept: boolean;
  lowSwept: boolean;
  judasComplete: boolean;
  light: TrafficLight;
  note: string;
}

export interface DXYRow {
  dxyBias: Direction;
  goldImpliedBias: Direction;
  alignedWithGold: boolean;
  light: TrafficLight;
  note: string;
}

export interface NewsFlagRow {
  todayEvents: Array<{ time: string; name: string; impact: 'high' | 'medium' }>;
  yesterdayHadHighImpact: boolean;
  light: TrafficLight;
  note: string;
}

export interface GoldContext {
  symbol: string;
  generatedAt: number;
  verdict: Verdict;
  verdictReason: string;
  midnightOpen: MidnightOpenRow;
  asianRange: AsianRangeRow;
  dxy: DXYRow;
  news: NewsFlagRow;
}

export const GOLD_SYMBOLS = ['XAUUSD', 'XAUTUSDT', 'XAU/USD'] as const;
export function isGoldSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return GOLD_SYMBOLS.some((g) => s === g) || s.startsWith('XAU');
}
