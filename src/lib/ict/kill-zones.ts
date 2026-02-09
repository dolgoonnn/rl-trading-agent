/**
 * ICT Kill Zones
 *
 * High-probability trading sessions based on ICT methodology.
 * Smart Money operates during specific time windows.
 *
 * Kill Zones (EST/EDT):
 * - London Open Kill Zone: 02:00-05:00 (NY time)
 * - NY Open Kill Zone: 08:00-11:00 (NY time)
 * - London Close Kill Zone: 10:00-12:00 (NY time)
 * - Asian Session: 20:00-00:00 (NY time) - optional, lower priority
 *
 * Note: Timestamps are typically in UTC. This module converts to NY time.
 */

export type KillZoneType = 'london_open' | 'ny_open' | 'london_close' | 'asian' | 'none';

export interface KillZoneInfo {
  type: KillZoneType;
  name: string;
  inKillZone: boolean;
  priority: number; // 1-3, higher = more significant
  hoursUntilNext: number;
  currentHourNY: number;
}

// Kill zone definitions (in NY/Eastern time hours)
const KILL_ZONES = {
  london_open: { start: 2, end: 5, name: 'London Open', priority: 3 },
  ny_open: { start: 8, end: 11, name: 'NY Open', priority: 3 },
  london_close: { start: 10, end: 12, name: 'London Close', priority: 2 },
  asian: { start: 20, end: 24, name: 'Asian Session', priority: 1 },
} as const;

/**
 * Get full NY date/time info
 * Handles EDT (March-November) and EST (November-March) automatically
 */
function getNewYorkDateTime(timestampMs: number): {
  hour: number;
  minute: number;
  dayOfWeek: number; // 0 = Sunday, 6 = Saturday
} {
  const date = new Date(timestampMs);

  let nyHour = parseInt(
    date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }),
    10
  );

  // Normalize hour 24 to 0 (some locales return 24 for midnight)
  if (nyHour === 24) nyHour = 0;

  const nyMinute = parseInt(
    date.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }),
    10
  );

  const nyDayStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[nyDayStr] ?? 0;

  return { hour: nyHour, minute: nyMinute, dayOfWeek };
}

/**
 * Check if timestamp is within a kill zone
 */
export function checkKillZone(timestampMs: number): KillZoneInfo {
  const { hour, dayOfWeek } = getNewYorkDateTime(timestampMs);

  // No trading on weekends
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      type: 'none',
      name: 'Weekend',
      inKillZone: false,
      priority: 0,
      hoursUntilNext: calculateHoursUntilNext(hour, dayOfWeek),
      currentHourNY: hour,
    };
  }

  // Check each kill zone (priority order)
  // Note: NY Open and London Close overlap (10-11), prioritize NY Open
  for (const [type, zone] of Object.entries(KILL_ZONES) as [KillZoneType, typeof KILL_ZONES[keyof typeof KILL_ZONES]][]) {
    if (type === 'asian') continue; // Check Asian last (lower priority)

    if (hour >= zone.start && hour < zone.end) {
      return {
        type,
        name: zone.name,
        inKillZone: true,
        priority: zone.priority,
        hoursUntilNext: 0,
        currentHourNY: hour,
      };
    }
  }

  // Check Asian session separately (wraps around midnight: 20:00-00:00 NY)
  const asian = KILL_ZONES.asian;
  // Asian is 20:00-24:00 (midnight), which means hours 20, 21, 22, 23
  if (hour >= asian.start && hour < 24) {
    return {
      type: 'asian',
      name: asian.name,
      inKillZone: true,
      priority: asian.priority,
      hoursUntilNext: 0,
      currentHourNY: hour,
    };
  }

  // Not in any kill zone
  return {
    type: 'none',
    name: 'Outside Kill Zones',
    inKillZone: false,
    priority: 0,
    hoursUntilNext: calculateHoursUntilNext(hour, dayOfWeek),
    currentHourNY: hour,
  };
}

/**
 * Quick check if in any kill zone (for filtering)
 */
export function isInKillZone(timestampMs: number, includeAsian = false): boolean {
  const info = checkKillZone(timestampMs);
  if (!info.inKillZone) return false;
  if (info.type === 'asian' && !includeAsian) return false;
  return true;
}

/**
 * Check if in a primary kill zone (London Open, NY Open, London Close)
 */
export function isInPrimaryKillZone(timestampMs: number): boolean {
  const info = checkKillZone(timestampMs);
  return info.inKillZone && info.priority >= 2;
}

/**
 * Get the highest priority kill zone for current time
 */
export function getActiveKillZone(timestampMs: number): KillZoneType {
  return checkKillZone(timestampMs).type;
}

/**
 * Calculate hours until next kill zone
 */
function calculateHoursUntilNext(currentHour: number, dayOfWeek: number): number {
  // Weekend - hours until Monday 2am (London Open)
  if (dayOfWeek === 0) {
    // Sunday - hours until Monday 2am
    return (24 - currentHour) + 2;
  }
  if (dayOfWeek === 6) {
    // Saturday - hours until Monday 2am
    return (24 - currentHour) + 24 + 2;
  }

  // Weekday - find next kill zone
  const nextZones = [
    { start: 2, hour: KILL_ZONES.london_open.start },
    { start: 8, hour: KILL_ZONES.ny_open.start },
    { start: 20, hour: KILL_ZONES.asian.start },
  ];

  for (const zone of nextZones) {
    if (currentHour < zone.hour) {
      return zone.hour - currentHour;
    }
  }

  // Next day London Open
  return (24 - currentHour) + 2;
}

/**
 * Get trading session quality score (0-1)
 * Higher during prime kill zones, lower outside
 */
export function getSessionQuality(timestampMs: number): number {
  const info = checkKillZone(timestampMs);

  if (!info.inKillZone) return 0.2; // Low but not zero (some setups still valid)

  switch (info.priority) {
    case 3: return 1.0;   // London Open, NY Open
    case 2: return 0.8;   // London Close
    case 1: return 0.5;   // Asian Session
    default: return 0.2;
  }
}

/**
 * Check if it's a high-probability trading day
 * Avoid major news days, FOMC, NFP, etc.
 * (Simplified - would need external calendar for real implementation)
 */
export function isTradingDay(timestampMs: number): boolean {
  const { dayOfWeek } = getNewYorkDateTime(timestampMs);

  // No weekends
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  // Friday afternoon can be choppy
  const info = checkKillZone(timestampMs);
  if (dayOfWeek === 5 && info.currentHourNY >= 14) return false;

  return true;
}

/**
 * Configuration for kill zone filtering
 */
export interface KillZoneConfig {
  /** Require primary kill zones only (default: true) */
  primaryOnly: boolean;
  /** Include Asian session (default: false) */
  includeAsian: boolean;
  /** Allow trades slightly before kill zones (minutes, default: 0) */
  preZoneMinutes: number;
  /** Allow trades slightly after kill zones (minutes, default: 0) */
  postZoneMinutes: number;
  /** Minimum session quality score (0-1, default: 0.5) */
  minSessionQuality: number;
}

const DEFAULT_KZ_CONFIG: KillZoneConfig = {
  primaryOnly: true,
  includeAsian: false,
  preZoneMinutes: 0,
  postZoneMinutes: 0,
  minSessionQuality: 0.5,
};

/**
 * Check if trade should be taken based on kill zone config
 */
export function shouldTradeByTime(
  timestampMs: number,
  config: Partial<KillZoneConfig> = {}
): { shouldTrade: boolean; reason: string } {
  const cfg = { ...DEFAULT_KZ_CONFIG, ...config };

  // Check trading day
  if (!isTradingDay(timestampMs)) {
    return { shouldTrade: false, reason: 'Not a trading day' };
  }

  // Check session quality
  const quality = getSessionQuality(timestampMs);
  if (quality < cfg.minSessionQuality) {
    return { shouldTrade: false, reason: `Session quality ${(quality * 100).toFixed(0)}% below threshold` };
  }

  // Check kill zone
  if (cfg.primaryOnly) {
    if (!isInPrimaryKillZone(timestampMs)) {
      return { shouldTrade: false, reason: 'Outside primary kill zones' };
    }
  } else {
    if (!isInKillZone(timestampMs, cfg.includeAsian)) {
      return { shouldTrade: false, reason: 'Outside all kill zones' };
    }
  }

  const info = checkKillZone(timestampMs);
  return { shouldTrade: true, reason: `In ${info.name} (${info.currentHourNY}:00 NY)` };
}
