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

export interface OpenPosition {
  sleeve: string;
  symbol: string;
  direction: string;
  entryPrice: number;
  sizeUsdt: number | null;
  entryTimestamp: number;
  strategy: string | null;
}

export function readOpenPositions(dataDir: string = defaultDataDir()): OpenPosition[] {
  const db = openReadonly(dataDir);
  const out: OpenPosition[] = [];
  if (db) {
    try {
      const rows = db.prepare(
        "SELECT symbol, direction, entry_price, entry_timestamp, position_size_usdt, strategy FROM bot_positions WHERE status = 'open'",
      ).all() as Array<{ symbol: string; direction: string; entry_price: number; entry_timestamp: number; position_size_usdt: number; strategy: string }>;
      for (const r of rows) {
        out.push({ sleeve: 'crypto', symbol: r.symbol, direction: r.direction, entryPrice: r.entry_price, sizeUsdt: r.position_size_usdt, entryTimestamp: r.entry_timestamp, strategy: r.strategy });
      }
    } finally {
      db.close();
    }
  }
  // Gold: single open position flag in JSON (no rich fields) — surface as a marker.
  const gold = readJson(path.join(dataDir, 'gold-bot-state.json')) as { position?: { direction?: string; entryPrice?: number; entryTime?: number } } | null;
  if (gold?.position) {
    out.push({ sleeve: 'gold', symbol: 'XAUTUSDT', direction: gold.position.direction ?? '—', entryPrice: gold.position.entryPrice ?? 0, sizeUsdt: null, entryTimestamp: gold.position.entryTime ?? 0, strategy: 'f2f_gold' });
  }
  // Metals: open legs in JSON.
  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as { positions?: Array<{ leg?: string; direction?: string; entryPrice?: number; entryTime?: number }> } | null;
  for (const p of metals?.positions ?? []) {
    out.push({ sleeve: 'metals', symbol: p.leg ?? 'metals', direction: p.direction ?? '—', entryPrice: p.entryPrice ?? 0, sizeUsdt: null, entryTimestamp: p.entryTime ?? 0, strategy: 'session' });
  }
  return out;
}

export interface ClosedTrade {
  sleeve: string;
  symbol: string;
  direction: string;
  entryTimestamp: number;
  exitTimestamp: number;
  pnlPct: number;
  pnlUsdt: number | null;
  exitReason: string | null;
}

export function readRecentTrades(limit: number, dataDir: string = defaultDataDir()): ClosedTrade[] {
  const out: ClosedTrade[] = [];
  const db = openReadonly(dataDir);
  if (db) {
    try {
      const rows = db.prepare(
        'SELECT symbol, direction, entry_timestamp, exit_timestamp, pnl_percent, pnl_usdt, exit_reason FROM bot_trades ORDER BY exit_timestamp DESC LIMIT ?',
      ).all(limit) as Array<{ symbol: string; direction: string; entry_timestamp: number; exit_timestamp: number; pnl_percent: number; pnl_usdt: number; exit_reason: string }>;
      for (const r of rows) {
        out.push({ sleeve: 'crypto', symbol: r.symbol, direction: r.direction, entryTimestamp: r.entry_timestamp, exitTimestamp: r.exit_timestamp, pnlPct: r.pnl_percent, pnlUsdt: r.pnl_usdt, exitReason: r.exit_reason });
      }
    } finally {
      db.close();
    }
  }
  // Gold/metals JSON trades carry ISO timestamps; include when parseable, tagged by sleeve.
  const gold = readJson(path.join(dataDir, 'gold-bot-state.json')) as { trades?: Array<{ direction?: string; entryTime?: string; exitTime?: string; pnlPct?: number; pnlPercent?: number; exitReason?: string }> } | null;
  for (const t of gold?.trades ?? []) {
    out.push({ sleeve: 'gold', symbol: 'XAUTUSDT', direction: t.direction ?? '—', entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0, exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0, pnlPct: t.pnlPct ?? t.pnlPercent ?? 0, pnlUsdt: null, exitReason: t.exitReason ?? null });
  }
  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as { trades?: Array<{ leg?: string; entryTime?: string; exitTime?: string; pnlPct?: number; stale?: boolean }> } | null;
  for (const t of metals?.trades ?? []) {
    out.push({ sleeve: 'metals', symbol: t.leg ?? 'metals', direction: '—', entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0, exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0, pnlPct: t.pnlPct ?? 0, pnlUsdt: null, exitReason: t.stale ? 'stale (downtime)' : null });
  }
  return out.sort((a, b) => b.exitTimestamp - a.exitTimestamp).slice(0, limit);
}
