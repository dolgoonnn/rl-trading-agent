import { describe, it, expect } from 'vitest';
import {
  parseF2fValidationFloor,
  loadBootstrapFloors,
} from '@/lib/portfolio/bootstrap-floors';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('parseF2fValidationFloor', () => {
  it('extracts the bootstrap Sharpe 5th from the checks array', () => {
    const obj = {
      checks: [
        { name: 'Walk-Forward >=60%', value: '51.1%', pass: false },
        { name: 'MC Bootstrap Sharpe 5th >0', value: '1.41', pass: true },
      ],
    };
    expect(parseF2fValidationFloor(obj)).toBeCloseTo(1.41, 4);
  });

  it('returns null when the check is missing', () => {
    expect(parseF2fValidationFloor({ checks: [] })).toBeNull();
    expect(parseF2fValidationFloor({})).toBeNull();
  });
});

describe('loadBootstrapFloors', () => {
  it('returns a Map with floors for known strategies', () => {
    // Use a temp dir that mimics the experiments/ layout
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floors-'));
    fs.writeFileSync(
      path.join(tmp, 'f2f-validation-results.json'),
      JSON.stringify({
        checks: [{ name: 'MC Bootstrap Sharpe 5th >0', value: '1.41', pass: true }],
      }),
    );
    const floors = loadBootstrapFloors(tmp);
    expect(floors.get('f2f-gold')).toBeCloseTo(1.41, 4);
  });

  it('falls back to memory constants when validation files are missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floors-empty-'));
    const floors = loadBootstrapFloors(tmp);
    // Memory constants from the spec
    expect(floors.get('ict-3sym')).toBeCloseTo(3.03, 4);
    expect(floors.get('ict-7sym')).toBeCloseTo(0.72, 4);
  });
});
