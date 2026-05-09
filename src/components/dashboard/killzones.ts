/**
 * Client-side kill-zone window enumeration.
 *
 * Generates all kill-zone windows that fall within a given timestamp range,
 * for rendering as background bands on the chart.
 *
 * Windows are in NY time (handles EST/EDT). One day boundary at NY-midnight.
 */

export type KillZoneKind = 'london_open' | 'ny_open' | 'london_close' | 'asian';

export interface KillZoneWindow {
  kind: KillZoneKind;
  startMs: number;
  endMs: number;
}

const ZONES: Record<KillZoneKind, { startHour: number; endHour: number }> = {
  asian: { startHour: 20, endHour: 24 },
  london_open: { startHour: 2, endHour: 5 },
  ny_open: { startHour: 8, endHour: 11 },
  london_close: { startHour: 10, endHour: 12 },
};

function nyDateParts(ms: number): { year: number; month: number; day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) === 24 ? 0 : Number(map.hour),
  };
}

/** Return ms timestamp for a given NY-local date+hour. Approximate (within 1 hour) — good enough for chart bands. */
function nyDateToUTC(year: number, month: number, day: number, hour: number): number {
  // Build a UTC guess, then correct using the actual NY offset at that date.
  const guessUTC = Date.UTC(year, month - 1, day, hour);
  const back = nyDateParts(guessUTC);
  // Compute hour drift between guess and what we wanted
  const driftHours =
    (back.year - year) * 365 * 24 +
    (back.month - month) * 30 * 24 +
    (back.day - day) * 24 +
    (back.hour - hour);
  return guessUTC - driftHours * 3_600_000;
}

export function killZoneWindowsInRange(startMs: number, endMs: number): KillZoneWindow[] {
  if (endMs <= startMs) return [];
  const windows: KillZoneWindow[] = [];
  const startNY = nyDateParts(startMs);
  const endNY = nyDateParts(endMs);

  // iterate day by day in NY time, padding by 1 day on each side
  let cursor = new Date(Date.UTC(startNY.year, startNY.month - 1, startNY.day - 1));
  const endCursor = new Date(Date.UTC(endNY.year, endNY.month - 1, endNY.day + 1));

  while (cursor <= endCursor) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const dow = cursor.getUTCDay(); // 0=Sun ... 6=Sat
    if (dow !== 0 && dow !== 6) {
      for (const [kind, z] of Object.entries(ZONES) as [KillZoneKind, { startHour: number; endHour: number }][]) {
        const ws = nyDateToUTC(y, m, d, z.startHour);
        const we = nyDateToUTC(y, m, d, z.endHour);
        if (we < startMs || ws > endMs) continue;
        windows.push({ kind, startMs: Math.max(ws, startMs), endMs: Math.min(we, endMs) });
      }
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return windows;
}

export const KILL_ZONE_FILL: Record<KillZoneKind, string> = {
  asian: 'rgba(120, 120, 140, 0.07)',
  london_open: 'rgba(56, 189, 248, 0.10)',
  ny_open: 'rgba(168, 85, 247, 0.10)',
  london_close: 'rgba(34, 197, 94, 0.07)',
};
