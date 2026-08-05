/**
 * Every sleeve must report whether its bot is ALIVE.
 *
 * The LETF sleeve had booked zero trades and the dashboard had no way to say
 * whether that meant "correctly quiet" or "process died" — `readFreshness`
 * covered crypto, gold and metals only, and a fourth sleeve had been added
 * without anyone extending it. "We don't know if it is running" is the worst
 * state a live system can be in, and it silently blocked the highest-value
 * action available (getting the idle sleeves contributing).
 *
 * The list is now derived from one table, so adding a sleeve without a liveness
 * signal fails here rather than going unnoticed for weeks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFreshness, SLEEVE_LIVENESS } from '../../src/lib/bot/sleeve-readers';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('per-sleeve liveness', () => {
  it('covers every sleeve the book trades', () => {
    const names = readFreshness(dir).sleeves.map((s) => s.sleeve).sort();
    expect(names).toEqual(['crypto', 'gold', 'letf', 'metals']);
  });

  it('reports null when a bot has never written — never a stale-looking zero', () => {
    for (const s of readFreshness(dir).sleeves) {
      expect(s.lastWriteMs, s.sleeve).toBeNull();
    }
  });

  it('reports the state file mtime once a bot writes', () => {
    fs.writeFileSync(path.join(dir, 'letf-bot-state.json'), '{"positions":[],"trades":[]}');
    const letf = readFreshness(dir).sleeves.find((s) => s.sleeve === 'letf');
    expect(letf?.lastWriteMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it('carries a staleness threshold matched to each bot’s write cadence', () => {
    // The threshold belongs with the source knowledge, not the UI — the reader
    // knows LETF and metals tick every 30s while the gold bot runs daily.
    for (const s of readFreshness(dir).sleeves) {
      expect(s.staleAfterMs, s.sleeve).toBeGreaterThan(0);
    }
    const by = new Map(readFreshness(dir).sleeves.map((s) => [s.sleeve, s.staleAfterMs]));
    expect(by.get('letf')!).toBeLessThan(by.get('gold')!); // 30s ticker vs once-a-day bot
    expect(by.get('metals')).toBe(by.get('letf'));
  });

  it('exposes the table so a new sleeve cannot be added without a signal', () => {
    expect(SLEEVE_LIVENESS.map((s) => s.sleeve)).toContain('letf');
  });
});
