import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { summarizeSleeve, type SleeveSummary } from './track-record';

export function defaultDataDir(): string {
  return path.resolve('data');
}

function dbPath(dataDir: string): string {
  return path.join(dataDir, 'ict-trading.db');
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** Open the bot DB read-only, or null if it does not exist yet (fresh volume). */
function openReadonly(dataDir: string): Database.Database | null {
  const p = dbPath(dataDir);
  if (!fs.existsSync(p)) return null;
  const db = new Database(p, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

export function readCryptoSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const db = openReadonly(dataDir);
  if (!db) return summarizeSleeve('crypto (Run 20)', [], 0, 10000);
  try {
    const rows = db.prepare('SELECT pnl_percent FROM bot_trades').all() as Array<{ pnl_percent: number }>;
    const state = db.prepare('SELECT equity FROM bot_state WHERE id = 1').get() as { equity: number } | undefined;
    const open = (db.prepare("SELECT COUNT(*) n FROM bot_positions WHERE status = 'open'").get() as { n: number }).n;
    return summarizeSleeve('crypto (Run 20)', rows.map((r) => r.pnl_percent), open, state?.equity ?? 10000);
  } finally {
    db.close();
  }
}

export function readMetalsSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const d = readJson(path.join(dataDir, 'metals-bot-state.json')) as
    | { trades?: Array<{ pnlPct: number }>; positions?: unknown[] }
    | null;
  const trades = d?.trades ?? [];
  return summarizeSleeve('session/metals', trades.map((t) => t.pnlPct), (d?.positions ?? []).length, 10000);
}

export function readGoldSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const d = readJson(path.join(dataDir, 'gold-bot-state.json')) as
    | { trades?: Array<{ pnlPct?: number; pnlPercent?: number }>; equity?: number; position?: unknown }
    | null;
  const trades = d?.trades ?? [];
  const pnls = trades.map((t) => t.pnlPct ?? t.pnlPercent ?? 0);
  return summarizeSleeve('gold F2F', pnls, d?.position ? 1 : 0, d?.equity ?? 10000);
}

export function readAllSleeves(dataDir: string = defaultDataDir()): SleeveSummary[] {
  return [readCryptoSleeve(dataDir), readMetalsSleeve(dataDir), readGoldSleeve(dataDir)];
}
