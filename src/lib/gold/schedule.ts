/**
 * Sleep-robust daily-tick scheduling for the gold F2F bot.
 *
 * The bot originally slept ONE ~20h `setTimeout` until the next daily close.
 * On a laptop that intermittently sleeps, that timer (monotonic clock, paused
 * during system sleep) drifts hours late with no recovery — observed live: the
 * daily tick ran 9.5h+ overdue while the process was up. The loop already
 * dedupes by processed-date, so the fix is to poll on a SHORT capped interval:
 * far from the close it re-checks every `maxPollMs`, the dedupe skips until a
 * genuinely new daily bar appears, and the next poll after a machine wake picks
 * it up within `maxPollMs`.
 */

/** Cap on a single wait so a paused timer re-polls soon after wake. */
export const GOLD_MAX_POLL_MS = 30 * 60 * 1000; // 30 min

/**
 * Delay until the bot's next fetch/evaluate: the time until the next daily
 * close (+ post-close publish delay), but never longer than `maxPollMs`, so the
 * schedule stays responsive and sleep-robust. Guards against negative/NaN input
 * (returns a short poll) so a bad clock read can never wedge the loop.
 */
export function nextGoldPollDelayMs(
  msUntilNextClose: number,
  postCloseDelayMs: number,
  maxPollMs: number = GOLD_MAX_POLL_MS,
): number {
  const target = msUntilNextClose + postCloseDelayMs;
  if (!Number.isFinite(target) || target <= 0) return Math.min(maxPollMs, postCloseDelayMs);
  return Math.min(target, maxPollMs);
}
