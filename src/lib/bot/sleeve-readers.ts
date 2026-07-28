import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { summarizeSleeve, type SleeveSummary } from './track-record';
import type { AnalyticsTrade } from './trade-analytics';

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

/** Guard against querying a table that doesn't exist yet (fresh/partial schema). */
function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

export function readCryptoSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const db = openReadonly(dataDir);
  if (!db) return summarizeSleeve('crypto (Run 20)', [], 0, 10000);
  try {
    const rows = tableExists(db, 'bot_trades')
      ? (db.prepare('SELECT pnl_percent FROM bot_trades').all() as Array<{ pnl_percent: number }>)
      : [];
    const state = tableExists(db, 'bot_state')
      ? (db.prepare('SELECT equity FROM bot_state WHERE id = 1').get() as { equity: number } | undefined)
      : undefined;
    const open = tableExists(db, 'bot_positions')
      ? (db.prepare("SELECT COUNT(*) n FROM bot_positions WHERE status = 'open'").get() as { n: number }).n
      : 0;
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
      if (tableExists(db, 'bot_positions')) {
        const rows = db.prepare(
          "SELECT symbol, direction, entry_price, entry_timestamp, position_size_usdt, strategy FROM bot_positions WHERE status = 'open'",
        ).all() as Array<{ symbol: string; direction: string; entry_price: number; entry_timestamp: number; position_size_usdt: number; strategy: string }>;
        for (const r of rows) {
          out.push({ sleeve: 'crypto', symbol: r.symbol, direction: r.direction, entryPrice: r.entry_price, sizeUsdt: r.position_size_usdt, entryTimestamp: r.entry_timestamp, strategy: r.strategy });
        }
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
  id: string;
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
      if (tableExists(db, 'bot_trades')) {
        const rows = db.prepare(
          'SELECT id, symbol, direction, entry_timestamp, exit_timestamp, pnl_percent, pnl_usdt, exit_reason FROM bot_trades ORDER BY exit_timestamp DESC LIMIT ?',
        ).all(limit) as Array<{ id: string; symbol: string; direction: string; entry_timestamp: number; exit_timestamp: number; pnl_percent: number; pnl_usdt: number; exit_reason: string }>;
        for (const r of rows) {
          out.push({ id: r.id, sleeve: 'crypto', symbol: r.symbol, direction: r.direction, entryTimestamp: r.entry_timestamp, exitTimestamp: r.exit_timestamp, pnlPct: r.pnl_percent, pnlUsdt: r.pnl_usdt, exitReason: r.exit_reason });
        }
      }
    } finally {
      db.close();
    }
  }
  // Gold/metals JSON trades carry ISO timestamps; include when parseable, tagged by sleeve.
  const gold = readJson(path.join(dataDir, 'gold-bot-state.json')) as { trades?: Array<{ direction?: string; entryTime?: string; exitTime?: string; pnlPct?: number; pnlPercent?: number; exitReason?: string }> } | null;
  for (const t of gold?.trades ?? []) {
    out.push({ id: `gold:${t.exitTime ? Date.parse(t.exitTime) : 0}`, sleeve: 'gold', symbol: 'XAUTUSDT', direction: t.direction ?? '—', entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0, exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0, pnlPct: t.pnlPct ?? t.pnlPercent ?? 0, pnlUsdt: null, exitReason: t.exitReason ?? null });
  }
  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as { trades?: Array<{ leg?: string; entryTime?: string; exitTime?: string; pnlPct?: number; stale?: boolean }> } | null;
  for (const t of metals?.trades ?? []) {
    out.push({ id: `metals:${t.leg ?? 'metals'}:${t.exitTime ? Date.parse(t.exitTime) : 0}`, sleeve: 'metals', symbol: t.leg ?? 'metals', direction: '—', entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0, exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0, pnlPct: t.pnlPct ?? 0, pnlUsdt: null, exitReason: t.stale ? 'stale (downtime)' : null });
  }
  return out.sort((a, b) => b.exitTimestamp - a.exitTimestamp).slice(0, limit);
}

export interface EquityPoint { timestamp: number; equity: number; drawdown: number }
export interface EquityCurve {
  crypto: EquityPoint[];
  currentEquity: { crypto: number; gold: number; metals: number; total: number };
}

export function readEquityCurve(dataDir: string = defaultDataDir()): EquityCurve {
  const cryptoSummary = readCryptoSleeve(dataDir);
  const gold = readGoldSleeve(dataDir);
  const metals = readMetalsSleeve(dataDir);
  let crypto: EquityPoint[] = [];
  const db = openReadonly(dataDir);
  if (db) {
    try {
      // Only query if the snapshots table exists (older/fresh DBs may lack it).
      if (tableExists(db, 'bot_equity_snapshots')) {
        crypto = db.prepare('SELECT timestamp, equity, drawdown FROM bot_equity_snapshots ORDER BY timestamp ASC').all() as EquityPoint[];
      }
    } finally {
      db.close();
    }
  }
  const cur = { crypto: cryptoSummary.equity, gold: gold.equity, metals: metals.equity, total: 0 };
  cur.total = cur.crypto + cur.gold + cur.metals;
  return { crypto, currentEquity: cur };
}

export interface Freshness { cryptoLatestCandleMs: number | null; goldStateMtimeMs: number | null; metalsStateMtimeMs: number | null }

function mtimeMs(p: string): number | null {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

export function readFreshness(dataDir: string = defaultDataDir()): Freshness {
  let cryptoLatestCandleMs: number | null = null;
  const db = openReadonly(dataDir);
  if (db) {
    try {
      if (tableExists(db, 'bot_candles')) {
        const row = db.prepare('SELECT MAX(timestamp) ts FROM bot_candles').get() as { ts: number | null };
        cryptoLatestCandleMs = row?.ts ?? null;
      }
    } finally {
      db.close();
    }
  }
  return {
    cryptoLatestCandleMs,
    goldStateMtimeMs: mtimeMs(path.join(dataDir, 'gold-bot-state.json')),
    metalsStateMtimeMs: mtimeMs(path.join(dataDir, 'metals-bot-state.json')),
  };
}

export interface GovernanceStatus {
  available: boolean;
  action: 'trade' | 'derisk' | 'halt' | null;
  reason: string | null;
  multiplier: number | null;
}

export function readGovernance(dataDir: string = defaultDataDir()): GovernanceStatus {
  const d = readJson(path.join(dataDir, 'book-governance.json')) as
    | { action?: string; reason?: string; multiplier?: number }
    | null;
  if (!d) return { available: false, action: null, reason: null, multiplier: null };
  const action = d.action === 'trade' || d.action === 'derisk' || d.action === 'halt' ? d.action : null;
  return {
    available: true,
    action,
    reason: typeof d.reason === 'string' ? d.reason : null,
    multiplier: typeof d.multiplier === 'number' ? d.multiplier : null,
  };
}

export interface FactorScore { name: string; value: number }

export interface TradeDetail {
  found: boolean;
  id: string | null;
  sleeve: string;
  symbol: string;
  direction: string;
  entryPrice: number | null;
  exitPrice: number | null;
  entryTimestamp: number;
  exitTimestamp: number;
  pnlPct: number;
  pnlUsdt: number | null;
  exitReason: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskAmountUsdt: number | null;
  positionSizeUsdt: number | null;
  regime: string | null;
  barsHeld: number | null;
  confluenceScore: number | null;
  factors: FactorScore[] | null;
  grossReturn: number | null;
  frictionReturn: number | null;
  fundingReturn: number | null;
  netReturn: number | null;
  fundingPaidUsdt: number | null;
  rMultiple: number | null;
}

const NOT_FOUND: TradeDetail = {
  found: false, id: null, sleeve: '', symbol: '', direction: '',
  entryPrice: null, exitPrice: null, entryTimestamp: 0, exitTimestamp: 0,
  pnlPct: 0, pnlUsdt: null, exitReason: null, stopLoss: null, takeProfit: null,
  riskAmountUsdt: null, positionSizeUsdt: null, regime: null, barsHeld: null,
  confluenceScore: null, factors: null, grossReturn: null, frictionReturn: null,
  fundingReturn: null, netReturn: null, fundingPaidUsdt: null, rMultiple: null,
};

/** Parse the stored factor_breakdown JSON into sorted scores; null if unusable. */
function parseFactors(raw: unknown): FactorScore[] | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const out: FactorScore[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out.push({ name, value });
  }
  return out.sort((a, b) => b.value - a.value);
}

function rMultipleOf(pnlUsdt: number | null, risk: number | null): number | null {
  return pnlUsdt !== null && risk !== null && risk > 0 ? pnlUsdt / risk : null;
}

export function readTradeDetail(id: string, dataDir: string = defaultDataDir()): TradeDetail {
  const db = openReadonly(dataDir);
  if (db) {
    try {
      if (tableExists(db, 'bot_trades')) {
        const r = db.prepare('SELECT * FROM bot_trades WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        if (r) {
          const num = (k: string): number | null => (typeof r[k] === 'number' ? (r[k] as number) : null);
          const str = (k: string): string | null => (typeof r[k] === 'string' ? (r[k] as string) : null);
          const pnlUsdt = num('pnl_usdt');
          const risk = num('risk_amount_usdt');
          return {
            found: true, id, sleeve: 'crypto',
            symbol: str('symbol') ?? '', direction: str('direction') ?? '',
            entryPrice: num('entry_price'), exitPrice: num('exit_price'),
            entryTimestamp: num('entry_timestamp') ?? 0, exitTimestamp: num('exit_timestamp') ?? 0,
            pnlPct: num('pnl_percent') ?? 0, pnlUsdt,
            exitReason: str('exit_reason'), stopLoss: num('stop_loss'), takeProfit: num('take_profit'),
            riskAmountUsdt: risk, positionSizeUsdt: num('position_size_usdt'),
            regime: str('regime'), barsHeld: num('bars_held'),
            confluenceScore: num('confluence_score'), factors: parseFactors(r['factor_breakdown']),
            grossReturn: num('gross_return'), frictionReturn: num('friction_return'),
            fundingReturn: num('funding_return'), netReturn: num('net_return'),
            fundingPaidUsdt: num('funding_paid_usdt'),
            rMultiple: rMultipleOf(pnlUsdt, risk),
          };
        }
      }
    } finally {
      db.close();
    }
  }
  // Thin JSON sleeves: match on the synthetic id produced by readRecentTrades.
  const gold = readJson(path.join(dataDir, 'gold-bot-state.json')) as
    | { trades?: Array<{ direction?: string; entryPrice?: number; exitPrice?: number; entryTime?: string; exitTime?: string; pnlPct?: number; pnlPercent?: number; exitReason?: string }> }
    | null;
  for (const t of gold?.trades ?? []) {
    const tid = `gold:${t.exitTime ? Date.parse(t.exitTime) : 0}`;
    if (tid === id) {
      return {
        ...NOT_FOUND, found: true, id: tid, sleeve: 'gold', symbol: 'XAUTUSDT',
        direction: t.direction ?? '—', entryPrice: t.entryPrice ?? null, exitPrice: t.exitPrice ?? null,
        entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0,
        exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0,
        pnlPct: t.pnlPct ?? t.pnlPercent ?? 0, exitReason: t.exitReason ?? null,
      };
    }
  }
  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as
    | { trades?: Array<{ leg?: string; side?: string; entryPrice?: number; exitPrice?: number; entryTime?: string; exitTime?: string; pnlPct?: number; stale?: boolean }> }
    | null;
  for (const t of metals?.trades ?? []) {
    const tid = `metals:${t.leg ?? 'metals'}:${t.exitTime ? Date.parse(t.exitTime) : 0}`;
    if (tid === id) {
      return {
        ...NOT_FOUND, found: true, id: tid, sleeve: 'metals', symbol: t.leg ?? 'metals',
        direction: t.side ?? '—', entryPrice: t.entryPrice ?? null, exitPrice: t.exitPrice ?? null,
        entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0,
        exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0,
        pnlPct: t.pnlPct ?? 0, exitReason: t.stale ? 'stale (downtime)' : null,
      };
    }
  }
  return NOT_FOUND;
}

/** Crypto rows only — the sole sleeve carrying the fields analytics needs. */
export function readAllTradesForStats(dataDir: string = defaultDataDir()): AnalyticsTrade[] {
  const db = openReadonly(dataDir);
  if (!db) return [];
  try {
    if (!tableExists(db, 'bot_trades')) return [];
    const rows = db.prepare(
      'SELECT symbol, pnl_percent, pnl_usdt, risk_amount_usdt, exit_reason, regime, confluence_score FROM bot_trades',
    ).all() as Array<{ symbol: string; pnl_percent: number; pnl_usdt: number | null; risk_amount_usdt: number | null; exit_reason: string | null; regime: string | null; confluence_score: number | null }>;
    return rows.map((r) => ({
      symbol: r.symbol,
      pnlPct: r.pnl_percent,
      pnlUsdt: r.pnl_usdt,
      riskAmountUsdt: r.risk_amount_usdt,
      exitReason: r.exit_reason,
      regime: r.regime,
      confluenceScore: r.confluence_score,
    }));
  } finally {
    db.close();
  }
}

export function readDrawdownCurve(dataDir: string = defaultDataDir()): EquityPoint[] {
  const db = openReadonly(dataDir);
  if (!db) return [];
  try {
    if (!tableExists(db, 'bot_equity_snapshots')) return [];
    return db.prepare('SELECT timestamp, equity, drawdown FROM bot_equity_snapshots ORDER BY timestamp ASC').all() as EquityPoint[];
  } finally {
    db.close();
  }
}

export interface CostSummary {
  totalGross: number;
  totalFriction: number;
  totalFunding: number;
  totalNet: number;
  fundingBySymbol: Array<{ symbol: string; fundingPaidUsdt: number }>;
}

export function readCosts(dataDir: string = defaultDataDir()): CostSummary {
  const empty: CostSummary = { totalGross: 0, totalFriction: 0, totalFunding: 0, totalNet: 0, fundingBySymbol: [] };
  const db = openReadonly(dataDir);
  if (!db) return empty;
  try {
    if (!tableExists(db, 'bot_trades')) return empty;
    const rows = db.prepare(
      'SELECT symbol, gross_return, friction_return, funding_return, net_return, funding_paid_usdt FROM bot_trades',
    ).all() as Array<{ symbol: string; gross_return: number; friction_return: number; funding_return: number; net_return: number; funding_paid_usdt: number }>;
    const bySymbol = new Map<string, number>();
    const out: CostSummary = { ...empty, fundingBySymbol: [] };
    for (const r of rows) {
      out.totalGross += r.gross_return;
      out.totalFriction += r.friction_return;
      out.totalFunding += r.funding_return;
      out.totalNet += r.net_return;
      bySymbol.set(r.symbol, (bySymbol.get(r.symbol) ?? 0) + r.funding_paid_usdt);
    }
    out.fundingBySymbol = [...bySymbol].map(([symbol, fundingPaidUsdt]) => ({ symbol, fundingPaidUsdt }));
    return out;
  } finally {
    db.close();
  }
}
