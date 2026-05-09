import { describe, it, expect } from 'vitest';
import { parseStats, type StrategyStats } from '@/lib/trpc/routers/dashboard/stats';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function writeFixture(filename: string, body: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(body));
  return dir;
}

describe('parseStats', () => {
  it('parses pbo-results-3sym-run20.json shape into ict-3sym entry', () => {
    const dir = writeFixture('pbo-results-3sym-run20.json', {
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      pbo: 0.21,
      passes: true,
    });
    const m = parseStats(dir);
    const s: StrategyStats | undefined = m.get('ict-3sym');
    expect(s).toBeDefined();
    expect(s!.source).toBe('experiments/pbo-results-3sym-run20.json');
    expect(s!.winRate).toBeCloseTo(0.563, 2);
    expect(s!.sharpe).toBeCloseTo(7.66, 1);
  });

  it('parses f2f-validation-results.json checks[] for f2f-gold', () => {
    const dir = writeFixture('f2f-validation-results.json', {
      checks: [
        { name: 'MC Bootstrap Sharpe 5th >0', value: '1.41', pass: true },
      ],
      details: { totalTrades: 1097 },
    });
    const m = parseStats(dir);
    const s = m.get('f2f-gold');
    expect(s).toBeDefined();
    expect(s!.totalTrades).toBe(1097);
    expect(s!.source).toBe('experiments/f2f-validation-results.json');
  });

  it('parses funding-arb-validation-results.json details', () => {
    const dir = writeFixture('funding-arb-validation-results.json', {
      details: { totalTrades: 13, sharpe: 2.11 },
    });
    const m = parseStats(dir);
    const s = m.get('funding-arb');
    expect(s!.totalTrades).toBe(13);
    expect(s!.sharpe).toBeCloseTo(2.11, 2);
  });

  it('omits strategies whose files are missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
    const m = parseStats(dir);
    expect(m.size).toBe(0);
  });

  it('falls back gracefully on malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-'));
    fs.writeFileSync(path.join(dir, 'pbo-results-3sym-run20.json'), 'not json');
    const m = parseStats(dir);
    expect(m.size).toBe(0);
  });
});
