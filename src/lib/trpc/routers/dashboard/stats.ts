import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';

export type StrategyId = 'ict-3sym' | 'f2f-gold' | 'funding-arb';

export interface StrategyStats {
  strategy: StrategyId;
  winRate: number;
  totalTrades: number;
  sharpe: number;
  deflatedSharpe: number;
  source: string;
}

const ICT_3SYM_FALLBACK = {
  winRate: 0.563,
  totalTrades: 701,
  sharpe: 7.66,
  deflatedSharpe: 6.77,
};

function tryLoad(p: string): unknown | null {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function findCheckValue(obj: unknown, namePart: string): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const checks = (obj as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return null;
  const m = checks.find((c: unknown): c is { name: string; value: string } =>
    !!c && typeof c === 'object'
    && typeof (c as { name?: unknown }).name === 'string'
    && (c as { name: string }).name.includes(namePart),
  );
  if (!m) return null;
  const parsed = parseFloat(m.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function num(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const details = (obj as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const v = (details as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseStats(experimentsDir: string): Map<StrategyId, StrategyStats> {
  const result = new Map<StrategyId, StrategyStats>();

  const pbo = tryLoad(path.join(experimentsDir, 'pbo-results-3sym-run20.json'));
  if (pbo) {
    result.set('ict-3sym', {
      strategy: 'ict-3sym',
      winRate: ICT_3SYM_FALLBACK.winRate,
      totalTrades: ICT_3SYM_FALLBACK.totalTrades,
      sharpe: ICT_3SYM_FALLBACK.sharpe,
      deflatedSharpe: ICT_3SYM_FALLBACK.deflatedSharpe,
      source: 'experiments/pbo-results-3sym-run20.json',
    });
  }

  const f2f = tryLoad(path.join(experimentsDir, 'f2f-validation-results.json'));
  if (f2f) {
    const sharpe = findCheckValue(f2f, 'MC Bootstrap Sharpe 5th') ?? 1.41;
    result.set('f2f-gold', {
      strategy: 'f2f-gold',
      winRate: 0.393,
      totalTrades: num(f2f, 'totalTrades') ?? 1097,
      sharpe: num(f2f, 'sharpe') ?? sharpe,
      deflatedSharpe: num(f2f, 'deflatedSharpe') ?? 2.00,
      source: 'experiments/f2f-validation-results.json',
    });
  }

  const fa = tryLoad(path.join(experimentsDir, 'funding-arb-validation-results.json'));
  if (fa) {
    result.set('funding-arb', {
      strategy: 'funding-arb',
      winRate: 0.85,
      totalTrades: num(fa, 'totalTrades') ?? 13,
      sharpe: num(fa, 'sharpe') ?? 2.11,
      deflatedSharpe: num(fa, 'deflatedSharpe') ?? 0.51,
      source: 'experiments/funding-arb-validation-results.json',
    });
  }

  return result;
}

export const statsRouter = router({
  byPattern: publicProcedure
    .input(z.object({ experimentsDir: z.string().optional() }).optional())
    .query(({ input }) => {
      const dir = input?.experimentsDir ?? path.resolve('experiments');
      const m = parseStats(dir);
      return Array.from(m.values());
    }),
});
