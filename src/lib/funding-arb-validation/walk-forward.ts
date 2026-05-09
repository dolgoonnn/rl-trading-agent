import type { WfWindow } from './types';

const DAY_MS = 86_400_000;

export function walkForwardValWindows(
  rangeStartMs: number,
  rangeEndMs: number,
  trainDays: number,
  valDays: number,
  slideDays: number,
): WfWindow[] {
  const windows: WfWindow[] = [];
  const trainMs = trainDays * DAY_MS;
  const valMs = valDays * DAY_MS;
  const slideMs = slideDays * DAY_MS;

  let valStart = rangeStartMs + trainMs;
  while (valStart + valMs <= rangeEndMs) {
    windows.push({ startMs: valStart, endMs: valStart + valMs });
    valStart += slideMs;
  }
  return windows;
}
