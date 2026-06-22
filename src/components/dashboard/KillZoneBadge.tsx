'use client';

import { useEffect, useState } from 'react';

type KZ = 'london_open' | 'ny_open' | 'london_close' | 'asian' | 'none';

const NAMES: Record<KZ, string> = {
  london_open: 'London Open',
  ny_open: 'NY Open',
  london_close: 'London Close',
  asian: 'Asian',
  none: 'Outside KZ',
};

const COLORS: Record<KZ, string> = {
  london_open: 'border-sky-700/50 bg-sky-900/40 text-sky-200',
  ny_open: 'border-purple-700/50 bg-purple-900/40 text-purple-200',
  london_close: 'border-emerald-700/50 bg-emerald-900/40 text-emerald-200',
  asian: 'border-zinc-700/50 bg-zinc-900/40 text-zinc-300',
  none: 'border-zinc-800 bg-zinc-950 text-zinc-500',
};

interface ZoneSpec {
  kind: Exclude<KZ, 'none'>;
  startHour: number;
  endHour: number;
}

const ZONES: ZoneSpec[] = [
  { kind: 'london_open', startHour: 2, endHour: 5 },
  { kind: 'ny_open', startHour: 8, endHour: 11 },
  { kind: 'london_close', startHour: 10, endHour: 12 },
  { kind: 'asian', startHour: 20, endHour: 24 },
];

function nyHourMin(ms: number): { hour: number; minute: number; dow: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const minute = Number(map.minute);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = map.weekday ?? 'Mon';
  const dow = dowMap[weekday] ?? 0;
  return { hour, minute, dow };
}

function currentZone(ms: number): { kind: KZ; minutesLeft: number; nextKind: KZ; minutesUntilNext: number } {
  const { hour, minute, dow } = nyHourMin(ms);
  const isWeekend = dow === 0 || dow === 6;
  const minOfDay = hour * 60 + minute;

  if (!isWeekend) {
    // Prefer NY/London open over the overlapping London Close
    const order: ZoneSpec[] = [
      { kind: 'london_open', startHour: 2, endHour: 5 },
      { kind: 'ny_open', startHour: 8, endHour: 11 },
      { kind: 'london_close', startHour: 10, endHour: 12 },
      { kind: 'asian', startHour: 20, endHour: 24 },
    ];
    for (const z of order) {
      const start = z.startHour * 60;
      const end = z.endHour * 60;
      if (minOfDay >= start && minOfDay < end) {
        return { kind: z.kind, minutesLeft: end - minOfDay, ...nextZoneAfter(minOfDay, dow) };
      }
    }
  }

  return { kind: 'none', minutesLeft: 0, ...nextZoneAfter(minOfDay, dow) };
}

function nextZoneAfter(minOfDay: number, dow: number): { nextKind: KZ; minutesUntilNext: number } {
  const isWeekend = dow === 0 || dow === 6;
  if (isWeekend) {
    const daysToMonday = dow === 0 ? 1 : 2;
    return { nextKind: 'london_open', minutesUntilNext: daysToMonday * 24 * 60 + 2 * 60 - minOfDay };
  }
  const todayZones = ZONES.map((z) => ({ kind: z.kind, start: z.startHour * 60 }))
    .filter((z) => z.start > minOfDay)
    .sort((a, b) => a.start - b.start);
  if (todayZones.length > 0) {
    const z = todayZones[0]!;
    return { nextKind: z.kind, minutesUntilNext: z.start - minOfDay };
  }
  // tomorrow's first KZ (London Open at 02:00 NY)
  return { nextKind: 'london_open', minutesUntilNext: 24 * 60 - minOfDay + 2 * 60 };
}

function fmtDuration(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function KillZoneBadge() {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const z = currentZone(tick);
  const cls = COLORS[z.kind];
  const label = NAMES[z.kind];
  const detail =
    z.kind === 'none'
      ? `next ${NAMES[z.nextKind]} in ${fmtDuration(z.minutesUntilNext)}`
      : `${fmtDuration(z.minutesLeft)} left`;

  return (
    <div className={`inline-flex flex-col rounded-md border px-2 py-1 text-xs ${cls}`}>
      <span className="font-mono uppercase tracking-wide">{label}</span>
      <span className="text-[10px] opacity-75">{detail}</span>
    </div>
  );
}
