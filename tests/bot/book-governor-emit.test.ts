import { describe, it, expect } from 'vitest';
import {
  computeBookGovernanceState,
  decideBookGovernance,
  writeBookGovernanceSignal,
  readBookGovernanceSignal,
} from '@/lib/bot/book-governance';
import { BOOK_GOVERNANCE_CONFIG } from '@/lib/bot/config';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

describe('book-governor-emit', () => {
  it('end-to-end: breaching sleeves ⇒ signal action=derisk on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-'));
    const now = 1_700_000_000_000;
    // 70 unique consecutive days with slight noise so std > 0, mean strongly negative
    // → bookSharpe60 << -1 (well below the breachSharpe60 threshold of -1.0)
    const start = new Date('2025-01-01');
    const losing = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        const key = d.toISOString().slice(0, 10);
        // alternate -0.012 / -0.008 so std > 0; both negative → large negative Sharpe
        const val = i % 2 === 0 ? -0.012 : -0.008;
        return [key, val] as [string, number];
      }),
    );
    const st = computeBookGovernanceState(
      [
        { name: 'crypto', byDay: losing },
        { name: 'sessionBookRetail', byDay: losing },
        { name: 'f2f', byDay: losing },
      ],
      { crypto: 0.5, sessionBookRetail: 0.3, f2f: 0.2 },
      365,
    );
    const d = decideBookGovernance({ ...st, config: BOOK_GOVERNANCE_CONFIG });
    writeBookGovernanceSignal(dir, {
      ...st,
      action: d.action,
      multiplier: d.multiplier,
      reason: d.reason,
      asOfMs: now,
    });
    const got = readBookGovernanceSignal(dir, now, BOOK_GOVERNANCE_CONFIG.signalMaxAgeMs);
    expect(['derisk', 'halt']).toContain(got?.action);
  });
});
