/**
 * Core, testable primitives for the pre-FOMC drift re-validation
 * (scripts/research-fomc-revalidation.ts).
 *
 * Kept PURE so the two no-look-ahead-sensitive bits — the event-window log
 * return and the trailing-vol uncertainty gate — can be unit-tested in
 * isolation. No file IO, no Date-in-the-loop surprises.
 *
 * The drift itself: Lucca & Moench (2015), "The Pre-FOMC Announcement Drift",
 * Journal of Finance 70(1), 329-371. Documented window = the ~24h ending 15min
 * before a scheduled FOMC announcement; +49bp average over Sep-1994..Mar-2011.
 * Announcements have been at 14:00 ET since 2013, so the published window maps
 * to ~T-1 13:45 ET -> T 13:45 ET for our 2015+ sample.
 */

/** A NY-local minute map: day(YYYY-MM-DD) -> minute-of-day(0..1439) -> close. */
export type DayMinuteMarks = Map<string, Map<number, number>>;

/**
 * Price at or just before NY minute `minute` on `day`, tolerating up to
 * `staleMin` minutes of gap (illiquid off-hours print). Returns null if no
 * print is found in the lookback window. Looks BACKWARD only — never forward —
 * so it can never read a price from after the requested instant.
 */
export function markAt(
  marks: DayMinuteMarks,
  day: string,
  minute: number,
  staleMin = 10,
): number | null {
  const m = marks.get(day);
  if (!m) return null;
  for (let k = minute; k >= minute - staleMin; k--) {
    const p = m.get(k);
    if (p !== undefined) return p;
  }
  return null;
}

/**
 * Log return of being long from (`entryDay`, `entryMin`) to (`exitDay`,
 * `exitMin`), NET of round-trip friction (`frictionPerSide` charged twice).
 * Returns null if either leg has no usable price. This is the single source of
 * truth for "event-window return" — both the ungated and gated paths use it, so
 * a window edit can't silently diverge between them.
 */
export function windowReturn(
  marks: DayMinuteMarks,
  entryDay: string,
  entryMin: number,
  exitDay: string,
  exitMin: number,
  frictionPerSide = 0,
  staleMin = 10,
): number | null {
  const entry = markAt(marks, entryDay, entryMin, staleMin);
  const exit = markAt(marks, exitDay, exitMin, staleMin);
  if (entry === null || exit === null || entry <= 0 || exit <= 0) return null;
  return Math.log(exit / entry) - 2 * frictionPerSide;
}

/**
 * No-look-ahead trailing-vol uncertainty gate (the "trade only when uncertain"
 * filter from the original pre-registration). Given an ASCENDING list of daily
 * realized-vol observations and an index `i` to decide AT, return whether
 * vol[i] exceeds the MEDIAN of the prior `lookback` observations (strictly
 * before i). The decision at i uses only vol[0..i-1] for the threshold and
 * vol[i] itself (which is realized by close of the decision day, i.e. known
 * before the next-day entry) — never any future observation.
 *
 * Returns null when there is insufficient history (cannot decide), which the
 * caller must treat as "skip", not "trade".
 */
export function volGateAbove(
  vols: number[],
  i: number,
  lookback = 252,
  minHistory = 100,
): boolean | null {
  if (i < lookback || i < 0 || i >= vols.length) return null;
  const v = vols[i];
  if (v === undefined) return null;
  const hist = vols.slice(i - lookback, i).filter((x): x is number => Number.isFinite(x));
  if (hist.length < minHistory) return null;
  const sorted = [...hist].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return v > median;
}

// ---- small stats helpers (shared by script + tests) ----

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** One-sample t-stat against H0: mean = 0. */
export function tstat(xs: number[]): number {
  const s = std(xs);
  return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : 0;
}
