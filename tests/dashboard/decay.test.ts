import { describe, it, expect } from 'vitest';
import { parseDecayStatus } from '@/lib/trpc/routers/dashboard/decay';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function tmpFile(name: string, body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decay-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
}

describe('parseDecayStatus', () => {
  it('returns the raw structure when present', () => {
    const p = tmpFile('decay-status.json', {
      generatedAt: 12345,
      statuses: [{ strategy: 'ict-3sym', tripped: false }],
      warnings: [],
    });
    expect(parseDecayStatus(p)).toEqual({
      available: true,
      generatedAt: 12345,
      statuses: [{ strategy: 'ict-3sym', tripped: false }],
      warnings: [],
    });
  });

  it('returns available:false when file missing', () => {
    expect(parseDecayStatus('/tmp/nonexistent-12345.json')).toEqual({ available: false });
  });

  it('returns available:false on malformed JSON', () => {
    const p = tmpFile('decay-status.json', 'not json');
    expect(parseDecayStatus(p)).toEqual({ available: false });
  });
});
