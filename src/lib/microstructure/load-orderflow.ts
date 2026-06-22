/**
 * IO helper for the order-flow microstructure pipeline — STREAMS an NDJSON day
 * file into typed Snapshot[]. Kept SEPARATE from the pure feature math in
 * ofi-features.ts so the numeric functions stay IO-free and unit-testable.
 *
 * Day files are written by scripts/collect-btc-orderflow.ts (one ~150-byte
 * JSON line per second; ~86k lines / ~8 MB per full day). We stream line-by-line
 * rather than readFileSync + split so a multi-day load does not balloon memory.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { parseSnapshotLine, type Snapshot } from './ofi-features';

export interface LoadOptions {
  /**
   * When true, skip lines that fail to parse instead of throwing. A count of
   * skipped lines is returned via the onSkip callback. Default false (strict).
   */
  skipMalformed?: boolean;
  /** Called once per skipped line with the line and the parse error. */
  onSkip?: (line: string, error: unknown) => void;
}

/**
 * Stream an NDJSON order-flow day file into Snapshot[]. Blank lines are
 * ignored. With { skipMalformed: true } a partial/truncated trailing line (the
 * collector appends, so the last line can be mid-write) is dropped rather than
 * throwing. IO only — all feature math lives in ofi-features.ts.
 */
export async function loadOrderflowDay(
  filePath: string,
  options: LoadOptions = {},
): Promise<Snapshot[]> {
  const snapshots: Snapshot[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const raw of rl) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      snapshots.push(parseSnapshotLine(line));
    } catch (error) {
      if (options.skipMalformed) {
        options.onSkip?.(line, error);
        continue;
      }
      rl.close();
      stream.destroy();
      throw error;
    }
  }

  return snapshots;
}
