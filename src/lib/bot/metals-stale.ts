/**
 * Stale-hold detection for the session/metals book.
 *
 * Each metals leg intends a short, session-bounded hold (overnight ~9h, weekend
 * ~60-85h, intraday legs a few hours). When the bot is DOWN through a position's
 * scheduled exit window, the position rides open until the bot resumes. The exit
 * logic then closes it only inside the normal window, so a position can sit
 * open for days accruing unmanaged drift (observed: two overnight longs held 12
 * days for -12%).
 *
 * `isStrandedHold` gives the metals bot a force-close trigger: any position held
 * beyond its per-leg cap (set safely ABOVE the longest legitimate hold) is
 * definitionally stranded and should be flattened on the next tick regardless of
 * window, and flagged so its P&L is excluded from strategy attribution. The caps
 * never fire in normal operation — only after downtime.
 */

/** Per-leg max sane hold (hours), each safely above the leg's longest legit hold. */
const STALE_CAP_HOURS: Record<string, number> = {
  overnight: 24, // design ~9h
  weekend: 120, // design ~60-85h (incl. 3-day weekends)
  'us500-overnight': 36, // design ~17h
  'fix-short': 24, // design ~0.5h
  'amfix-long': 24,
  'agfix-short': 24,
  'eur-morning-short': 24,
  'eur-h22-long': 24,
  'nfp-mom': 24,
};

/** Conservative fallback for any unrecognized leg. */
const DEFAULT_CAP_HOURS = 24;

export function staleCapHoursFor(leg: string): number {
  return STALE_CAP_HOURS[leg] ?? DEFAULT_CAP_HOURS;
}

/** True when a position's hold exceeds its leg cap (strictly greater). */
export function isStrandedHold(leg: string, holdMs: number): boolean {
  return holdMs > staleCapHoursFor(leg) * 3_600_000;
}
