import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StrategyId } from './types';

// Memory-of-record fallbacks from the 2026-05-03 spec.
// Used when a validation JSON file is absent or malformed.
const FALLBACK_FLOORS: Record<StrategyId, number> = {
  'ict-3sym': 3.03,
  'ict-7sym': 0.72,
  'f2f-gold': 1.41,
};

const FALLBACK_DRAWDOWN_CEILINGS: Record<StrategyId, number> = {
  'ict-3sym': 0.633,
  'ict-7sym': 0.805,
  'f2f-gold': 0.153,
};

export function parseF2fValidationFloor(obj: unknown): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const checks = (obj as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return null;
  const match = checks.find(
    (c: unknown) =>
      c &&
      typeof c === 'object' &&
      typeof (c as { name?: unknown }).name === 'string' &&
      ((c as { name: string }).name).includes('MC Bootstrap Sharpe 5th'),
  );
  if (!match) return null;
  const valueStr = (match as { value?: unknown }).value;
  if (typeof valueStr !== 'string') return null;
  const parsed = parseFloat(valueStr);
  return Number.isFinite(parsed) ? parsed : null;
}

function tryLoadJson(p: string): unknown | null {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function loadBootstrapFloors(experimentsDir: string): Map<StrategyId, number> {
  const result = new Map<StrategyId, number>();

  // f2f-gold
  const f2f = tryLoadJson(path.join(experimentsDir, 'f2f-validation-results.json'));
  const f2fFloor = parseF2fValidationFloor(f2f);
  result.set('f2f-gold', f2fFloor ?? FALLBACK_FLOORS['f2f-gold']);

  // ict-3sym, ict-7sym: no parsed file shape committed yet → fallback to memory.
  // When PBO/MC artifacts standardize a shape, add parsers here.
  result.set('ict-3sym', FALLBACK_FLOORS['ict-3sym']);
  result.set('ict-7sym', FALLBACK_FLOORS['ict-7sym']);

  return result;
}

export function loadDrawdownCeilings(): Map<StrategyId, number> {
  const m = new Map<StrategyId, number>();
  for (const k of Object.keys(FALLBACK_DRAWDOWN_CEILINGS) as StrategyId[]) {
    m.set(k, FALLBACK_DRAWDOWN_CEILINGS[k]);
  }
  return m;
}
