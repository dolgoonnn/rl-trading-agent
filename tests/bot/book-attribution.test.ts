/**
 * Book attribution — "what moved the number".
 *
 * WHY THIS EXISTS: every question asked of this dashboard so far ("why did it go
 * negative?", "why no crypto trades?", "how's it going?") required running ad-hoc
 * queries, because the page showed a bare equity figure with no decomposition.
 * The dashboard research is blunt about this failure mode: a metric listed without
 * the question it answers, and with no comparison, cannot inform a decision.
 *
 * This computes the decomposition the headline needs: which leg moved the book,
 * and what everything else did — so the page can state the story instead of
 * leaving the reader to derive it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLegAttribution, summariseAttribution } from '../../src/lib/bot/sleeve-readers';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attrib-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Metals state stores PERCENT; readers normalise to fraction. */
function seedMetals(trades: Array<{ leg: string; metal: string; pnlPct: number; stale?: boolean }>): void {
  fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
    trades: trades.map((t, i) => ({
      leg: t.leg,
      metal: t.metal,
      side: 'long',
      entryTime: `2026-07-2${(i % 9) + 1}T22:00:00Z`,
      exitTime: `2026-07-2${(i % 9) + 1}T23:00:00Z`,
      pnlPct: t.pnlPct,
      ...(t.stale ? { stale: true } : {}),
    })),
    positions: [],
  }));
}

describe('readLegAttribution', () => {
  it('groups trades by leg with count, net pnl and win rate', () => {
    seedMetals([
      { leg: 'overnight', metal: 'gold', pnlPct: -2 },
      { leg: 'overnight', metal: 'silver', pnlPct: -1 },
      { leg: 'agfix-short', metal: 'silver', pnlPct: 0.5 },
      { leg: 'agfix-short', metal: 'silver', pnlPct: 0.3 },
    ]);
    const legs = readLegAttribution(dir);
    const ov = legs.find((l) => l.leg === 'overnight');
    const ag = legs.find((l) => l.leg === 'agfix-short');
    expect(ov?.n).toBe(2);
    expect(ov?.netPnlPct).toBeCloseTo(-0.03); // (-2 + -1)/100
    expect(ov?.winRate).toBe(0);
    expect(ag?.n).toBe(2);
    expect(ag?.netPnlPct).toBeCloseTo(0.008);
    expect(ag?.winRate).toBe(1);
  });

  it('sorts by absolute impact so the biggest mover is first', () => {
    seedMetals([
      { leg: 'small', metal: 'gold', pnlPct: 0.1 },
      { leg: 'huge', metal: 'silver', pnlPct: -5 },
      { leg: 'mid', metal: 'gold', pnlPct: 1 },
    ]);
    expect(readLegAttribution(dir).map((l) => l.leg)).toEqual(['huge', 'mid', 'small']);
  });

  it('counts downtime-stranded trades separately so they can be flagged', () => {
    seedMetals([
      { leg: 'weekend', metal: 'gold', pnlPct: -1, stale: true },
      { leg: 'weekend', metal: 'gold', pnlPct: 0.5 },
    ]);
    expect(readLegAttribution(dir).find((l) => l.leg === 'weekend')?.staleCount).toBe(1);
  });

  it('returns an empty list on a fresh volume without throwing', () => {
    expect(readLegAttribution(dir)).toEqual([]);
  });
});

describe('summariseAttribution', () => {
  it('names the biggest detractor and what everything else did', () => {
    seedMetals([
      { leg: 'overnight', metal: 'gold', pnlPct: -3 },
      { leg: 'overnight', metal: 'silver', pnlPct: -1.5 },
      { leg: 'agfix-short', metal: 'silver', pnlPct: 1 },
      { leg: 'fix-short', metal: 'gold', pnlPct: 0.5 },
    ]);
    const s = summariseAttribution(readLegAttribution(dir));
    expect(s.topDetractor?.leg).toBe('overnight');
    expect(s.topDetractor?.netPnlPct).toBeCloseTo(-0.045);
    // everything except the top detractor
    expect(s.restNetPnlPct).toBeCloseTo(0.015);
    expect(s.total).toBeCloseTo(-0.03);
    // the story only holds when one leg dominates
    expect(s.dominatedByOneLeg).toBe(true);
  });

  it('does not claim domination when losses are spread evenly', () => {
    seedMetals([
      { leg: 'a', metal: 'gold', pnlPct: -1 },
      { leg: 'b', metal: 'gold', pnlPct: -1 },
      { leg: 'c', metal: 'gold', pnlPct: -1 },
    ]);
    expect(summariseAttribution(readLegAttribution(dir)).dominatedByOneLeg).toBe(false);
  });

  it('handles an empty book', () => {
    const s = summariseAttribution([]);
    expect(s.topDetractor).toBeNull();
    expect(s.topContributor).toBeNull();
    expect(s.total).toBe(0);
    expect(s.dominatedByOneLeg).toBe(false);
  });
});
