import { describe, it, expect } from 'vitest';
import { walkForwardValWindows } from '@/lib/funding-arb-validation/walk-forward';
import type { WfWindow } from '@/lib/funding-arb-validation/types';

const D = (utc: string) => new Date(utc).getTime();
const DAY = 86_400_000;

describe('walkForwardValWindows', () => {
  it('emits val windows that start after the warm-up (train) window', () => {
    const windows = walkForwardValWindows(
      D('2026-01-01T00:00:00Z'),
      D('2026-12-31T00:00:00Z'),
      180,
      30,
      30,
    );
    expect(windows.length).toBeGreaterThan(0);
    const firstStartDay = (windows[0]!.startMs - D('2026-01-01T00:00:00Z')) / DAY;
    expect(firstStartDay).toBeCloseTo(180, 0);
    for (const w of windows) {
      expect((w.endMs - w.startMs) / DAY).toBeCloseTo(30, 0);
    }
    const startDeltas = windows.slice(1).map(
      (w: WfWindow, i: number) => (w.startMs - windows[i]!.startMs) / DAY,
    );
    for (const d of startDeltas) {
      expect(d).toBeCloseTo(30, 0);
    }
  });

  it('returns empty when range is shorter than train + val', () => {
    const windows = walkForwardValWindows(
      D('2026-01-01T00:00:00Z'),
      D('2026-03-01T00:00:00Z'),
      180,
      30,
      30,
    );
    expect(windows).toEqual([]);
  });
});
