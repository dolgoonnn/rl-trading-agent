import * as fs from 'node:fs';
import * as path from 'node:path';
import { router, publicProcedure } from '../../init';

interface DecayStatusEntry {
  strategy: string;
  tripped: boolean;
  reason?: string;
  liveSharpe30d?: number | null;
  liveDrawdown90d?: number | null;
}

export type ParsedDecay =
  | { available: false }
  | { available: true; generatedAt: number; statuses: DecayStatusEntry[]; warnings: string[] };

export function parseDecayStatus(filePath: string): ParsedDecay {
  if (!fs.existsSync(filePath)) return { available: false };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      generatedAt?: unknown;
      statuses?: unknown;
      warnings?: unknown;
    };
    if (typeof parsed.generatedAt !== 'number' || !Array.isArray(parsed.statuses)) {
      return { available: false };
    }
    return {
      available: true,
      generatedAt: parsed.generatedAt,
      statuses: parsed.statuses as DecayStatusEntry[],
      warnings: Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : [],
    };
  } catch {
    return { available: false };
  }
}

export const decayRouter = router({
  status: publicProcedure.query(() => {
    return parseDecayStatus(path.resolve('data/decay-status.json'));
  }),
});
