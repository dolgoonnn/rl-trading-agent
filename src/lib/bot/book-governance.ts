/**
 * Book-level governance — the central "risk team" decision over the sleeves.
 * PURE + DI (no Date.now/fetch/DB in this function). A single sleeve's decay is
 * expected and absorbed by diversification (see plan research grounding); the
 * book is where edge-decay is judged. Catastrophe (book absolute drawdown) is
 * still an unconditional hard halt.
 */
import { expectedMaxDD, hardKillDD } from '@/lib/bot/retirement';
import type { BookGovernanceConfig } from '@/lib/bot/config';
import { BOOK_GOVERNANCE_CONFIG } from '@/lib/bot/config';

export { BOOK_GOVERNANCE_CONFIG };

export type BookHaltAction = 'trade' | 'derisk' | 'halt';

export interface BookGovernanceInputs {
  bookSharpe30: number | null;
  bookSharpe60: number | null;
  bookDrawdown: number;
  days: number;
  config: BookGovernanceConfig;
}

export interface BookGovernanceDecision {
  action: BookHaltAction;
  multiplier: number;
  reason: string;
  watch: boolean;
  reviewRequired: boolean;
}

export function decideBookGovernance(inputs: BookGovernanceInputs): BookGovernanceDecision {
  const { bookSharpe30, bookSharpe60, bookDrawdown, days, config } = inputs;
  const eMaxDD = expectedMaxDD({
    sigmaAnnual: config.sigmaAnnual,
    sharpe: config.sharpe,
    horizonYears: config.horizonYears,
  });
  const hkDD = hardKillDD({ eMaxDD, bootstrapP5DD: config.bootstrapP5DD });

  // 1. Catastrophe: book absolute drawdown — unconditional HARD halt.
  if (bookDrawdown >= hkDD) {
    return {
      action: 'halt',
      multiplier: 0,
      reason: `book hard drawdown: ${(bookDrawdown * 100).toFixed(1)}% >= hardKillDD ${(hkDD * 100).toFixed(1)}%`,
      watch: false,
      reviewRequired: true,
    };
  }

  // Cold book: never act.
  if (days < config.minDays) {
    return { action: 'trade', multiplier: 1, reason: `cold book (days=${days} < ${config.minDays})`, watch: false, reviewRequired: false };
  }

  // 2. BREACH (sustained 60d edge collapse) — auto de-risk + flag for review.
  if (bookSharpe60 !== null && bookSharpe60 < config.breachSharpe60) {
    return {
      action: 'derisk',
      multiplier: config.deriskMultiplier,
      reason: `book BREACH: 60d Sharpe ${bookSharpe60.toFixed(2)} < ${config.breachSharpe60} — de-risk + review before kill`,
      watch: false,
      reviewRequired: true,
    };
  }

  // 3. WATCH (30d soft) — OBSERVE only, a flat stretch is normal.
  const watch = bookSharpe30 !== null && bookSharpe30 < config.watchSharpe30;
  return {
    action: 'trade',
    multiplier: 1,
    reason: watch
      ? `book WATCH: 30d Sharpe ${bookSharpe30!.toFixed(2)} < ${config.watchSharpe30} — observe only (flat is normal)`
      : 'book all-clear',
    watch,
    reviewRequired: false,
  };
}
