/**
 * Book-level governance — the central "risk team" decision over the sleeves.
 * PURE + DI (no Date.now/fetch/DB in this function). A single sleeve's decay is
 * expected and absorbed by diversification (see plan research grounding); the
 * book is where edge-decay is judged. Catastrophe (book absolute drawdown) is
 * still an unconditional hard halt.
 */
import * as fs from 'fs';
import * as path from 'path';
import { expectedMaxDD, hardKillDD } from '@/lib/bot/retirement';
import { reviseSharpe } from '@/lib/bot/sharpe-revision';
import type { BookGovernanceConfig } from '@/lib/bot/config';
import { BOOK_GOVERNANCE_CONFIG } from '@/lib/bot/config';

export { BOOK_GOVERNANCE_CONFIG };

export type BookHaltAction = 'trade' | 'derisk' | 'halt';

export interface BookGovernanceInputs {
  bookSharpe30: number | null;
  bookSharpe60: number | null;
  bookDrawdown: number;
  days: number;
  /**
   * Realized annualized vol of the live book, when known.
   *
   * The revision leg deliberately tests against the FROZEN config vol, because
   * the allocation was sized on that assumption — but a book running hotter
   * than target produces deeper drawdowns for reasons that have nothing to do
   * with edge decay. Carrying the realized figure into the reason string makes
   * "which assumption broke" answerable at a glance instead of by re-derivation.
   */
  bookVolAnnualized?: number | null;
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
  const { bookSharpe30, bookSharpe60, bookDrawdown, days, bookVolAnnualized = null, config } = inputs;
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

  // 2. DRAWDOWN-BASED SHARPE REVISION — the leg that can actually decide.
  //
  // The Sharpe legs below need a track record we will not have for years
  // (MinTRL ~ 1/SR²), so on their own this book would coast until the
  // catastrophe stop. The drawdown is judgeable NOW: once it passes the depth
  // that refutes the assumed Sharpe, the assumption — not the market — is what
  // has been falsified, and the allocation was sized on that assumption.
  //
  // Deliberately does NOT hard-halt. Removing a sleeve is portfolio
  // construction, not risk control; this de-risks and demands a human review,
  // and the absolute-drawdown stop above keeps sole ownership of halting.
  const revision = reviseSharpe({
    drawdown: bookDrawdown,
    assumedSharpe: config.sharpe,
    annualizedVol: config.sigmaAnnual,
    alpha: config.revisionAlpha,
    minAllocatableSharpe: config.minAllocatableSharpe,
  });
  if (revision.verdict !== 'consistent') {
    // Name the hotter-than-designed case explicitly: the same drawdown means
    // something different if the book is running at double its target vol.
    const volNote =
      bookVolAnnualized !== null && bookVolAnnualized > config.sigmaAnnual * 1.25
        ? ` — NOTE realized vol ${(bookVolAnnualized * 100).toFixed(1)}% vs target ${(config.sigmaAnnual * 100).toFixed(1)}%, so check sizing before edge`
        : '';
    return {
      action: 'derisk',
      multiplier: config.deriskMultiplier,
      reason: `book Sharpe REVISION (${revision.verdict}): ${revision.reason}${volNote}`,
      watch: false,
      reviewRequired: true,
    };
  }

  // 3. BREACH (sustained 60d edge collapse) — auto de-risk + flag for review.
  if (bookSharpe60 !== null && bookSharpe60 < config.breachSharpe60) {
    return {
      action: 'derisk',
      multiplier: config.deriskMultiplier,
      reason: `book BREACH: 60d Sharpe ${bookSharpe60.toFixed(2)} < ${config.breachSharpe60} — de-risk + review before kill`,
      watch: false,
      reviewRequired: true,
    };
  }

  // 4. WATCH (30d soft) — OBSERVE only, a flat stretch is normal.
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

// ── Task 2: live-returns aggregation + signal IO ──────────────────────────────

export interface SleeveDaily {
  name: string;
  byDay: Record<string, number>;
}

export interface BookGovernanceState {
  bookSharpe30: number | null;
  bookSharpe60: number | null;
  bookDrawdown: number;
  days: number;
  /** Realized annualized vol of the book series; null until there are 2+ days. */
  bookVolAnnualized: number | null;
}

export interface BookGovernanceSignal extends BookGovernanceState {
  action: BookHaltAction;
  multiplier: number;
  reason: string;
  asOfMs: number;
}

const SIGNAL_FILE = 'book-governance.json';

// ── Pure math helpers (local; no scripts/ deps) ───────────────────────────────

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function annSharpe(xs: number[]): number {
  const s = std(xs);
  return s > 1e-10 ? (mean(xs) / s) * Math.sqrt(252) : 0;
}

/**
 * Pure: union-calendar align (0 when a sleeve is flat that day), builds the
 * weighted book daily series, returns rolling Sharpe and drawdown metrics.
 *
 * @param sleeves   Per-sleeve daily-return maps.
 * @param weights   Sleeve name → weight (should sum to 1, not enforced).
 * @param trailing  Maximum number of most-recent calendar days to include.
 * @param min30     Data gate for bookSharpe30 (default 10 obs).
 * @param min60     Data gate for bookSharpe60 (default 20 obs).
 */
export function computeBookGovernanceState(
  sleeves: SleeveDaily[],
  weights: Record<string, number>,
  trailing: number,
  min30 = 10,
  min60 = 20,
): BookGovernanceState {
  // Union all dates across sleeves, sort ascending, keep only the last `trailing` days.
  const allDates = new Set<string>();
  for (const s of sleeves) {
    for (const d of Object.keys(s.byDay)) allDates.add(d);
  }
  const dates = [...allDates].sort().slice(-trailing);

  // Build weighted book daily return series (0 when a sleeve has no entry for that day).
  const book = dates.map((d) =>
    sleeves.reduce((acc, s) => acc + (weights[s.name] ?? 0) * (s.byDay[d] ?? 0), 0),
  );

  // Rolling windows.
  const last30 = book.slice(-30);
  const last60 = book.slice(-60);

  // Drawdown from the cumulative-return peak.
  let eq = 1;
  let peak = 1;
  let maxdd = 0;
  for (const r of book) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxdd) maxdd = dd;
  }

  return {
    days: book.length,
    bookSharpe30: last30.length >= min30 ? annSharpe(last30) : null,
    bookSharpe60: last60.length >= min60 ? annSharpe(last60) : null,
    bookDrawdown: maxdd,
    bookVolAnnualized: book.length >= 2 ? std(book) * Math.sqrt(252) : null,
  };
}

/** Write the book governance signal JSON to `dir/book-governance.json`. */
export function writeBookGovernanceSignal(dir: string, signal: BookGovernanceSignal): void {
  fs.writeFileSync(path.join(dir, SIGNAL_FILE), JSON.stringify(signal, null, 2));
}

/**
 * Read and validate the book governance signal.
 * Fail-open: missing / stale / corrupt → null (never throws).
 *
 * @param dir       Directory containing `book-governance.json`.
 * @param nowMs     Current epoch milliseconds (injected for testability).
 * @param maxAgeMs  Maximum acceptable signal age in milliseconds.
 */
export function readBookGovernanceSignal(
  dir: string,
  nowMs: number,
  maxAgeMs: number,
): BookGovernanceDecision | null {
  try {
    const raw = fs.readFileSync(path.join(dir, SIGNAL_FILE), 'utf-8');
    const s = JSON.parse(raw) as BookGovernanceSignal;
    if (typeof s.asOfMs !== 'number' || nowMs - s.asOfMs > maxAgeMs) return null;
    return {
      action: s.action,
      multiplier: s.multiplier,
      reason: s.reason,
      watch: false,
      reviewRequired: false,
    };
  } catch {
    return null;
  }
}

// ── Task 5: combine local sleeve + book-level governance (most conservative wins) ──

export interface LocalGovernance {
  localMultiplier: number;
  localHalt: boolean;
}

export interface CombinedGovernance {
  multiplier: number;
  halt: boolean;
  source: 'local' | 'book';
}

/**
 * Most-conservative-wins: the book signal can only TIGHTEN, never loosen, the
 * local (sleeve-level) decision.
 *
 * Priority:
 *   1. Local halt          → halt (source='local'), regardless of book.
 *   2. book === null       → fail-open; keep local multiplier (source='local').
 *   3. book.action='halt'  → halt (source='book').
 *   4. Otherwise           → min(local, book) multiplier; source='book' if book tightens.
 */
export function combineGovernance(
  local: LocalGovernance,
  book: BookGovernanceDecision | null,
): CombinedGovernance {
  if (local.localHalt) return { multiplier: 0, halt: true, source: 'local' };
  if (book === null) return { multiplier: local.localMultiplier, halt: false, source: 'local' };
  if (book.action === 'halt') return { multiplier: 0, halt: true, source: 'book' };
  const m = Math.min(local.localMultiplier, book.multiplier);
  return { multiplier: m, halt: false, source: m < local.localMultiplier ? 'book' : 'local' };
}
