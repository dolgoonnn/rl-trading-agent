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

/**
 * Paper notional each sleeve starts with. Crypto and gold persist a real running
 * equity (bot_state / gold state); the metals state only records per-trade PnL,
 * so its equity is DERIVED from this baseline — see readMetalsSleeve.
 */
export const SLEEVE_STARTING_EQUITY = 10000;

export function readCryptoSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const db = openReadonly(dataDir);
  if (!db) return summarizeSleeve('crypto (Run 20)', [], 0, SLEEVE_STARTING_EQUITY);
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
    return summarizeSleeve('crypto (Run 20)', rows.map((r) => r.pnl_percent), open, state?.equity ?? SLEEVE_STARTING_EQUITY);
  } finally {
    db.close();
  }
}

export function readMetalsSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const d = readJson(path.join(dataDir, 'metals-bot-state.json')) as
    | { trades?: Array<{ pnlPct: number }>; positions?: unknown[] }
    | null;
  const trades = d?.trades ?? [];
  // Metals state stores PERCENT (see run-metals-bot.ts); readers normalize to FRACTION.
  const pnls = trades.map((t) => t.pnlPct / 100);
  // The metals state carries no equity field, so derive it from booked PnL —
  // otherwise the sleeve would report a flat starting notional forever while
  // its own cumulative PnL says otherwise. Simple (non-compounded) aggregation,
  // matching how cumPnlPct itself is summed, so the two always agree.
  const equity = SLEEVE_STARTING_EQUITY * (1 + pnls.reduce((a, p) => a + p, 0));
  return summarizeSleeve('session/metals', pnls, (d?.positions ?? []).length, equity);
}

export function readGoldSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const d = readJson(path.join(dataDir, 'gold-bot-state.json')) as
    | { trades?: Array<{ pnlPct?: number; pnlPercent?: number }>; equity?: number; position?: unknown }
    | null;
  const trades = d?.trades ?? [];
  const pnls = trades.map((t) => t.pnlPct ?? t.pnlPercent ?? 0);
  return summarizeSleeve('gold F2F', pnls, d?.position ? 1 : 0, d?.equity ?? SLEEVE_STARTING_EQUITY);
}

export function readLetfSleeve(dataDir: string = defaultDataDir()): SleeveSummary {
  const d = readJson(path.join(dataDir, 'letf-bot-state.json')) as
    | { trades?: Array<{ pnlPct: number }>; instruments?: Record<string, { position?: unknown }> }
    | null;
  const trades = d?.trades ?? [];
  // LETF state stores PERCENT (metals convention, see run-letf-bot.ts); normalize to FRACTION.
  const pnls = trades.map((t) => t.pnlPct / 100);
  const open = d?.instruments ? Object.values(d.instruments).filter((i) => i.position).length : 0;
  const equity = SLEEVE_STARTING_EQUITY * (1 + pnls.reduce((a, p) => a + p, 0));
  return summarizeSleeve('LETF close-flow', pnls, open, equity);
}

export function readAllSleeves(dataDir: string = defaultDataDir()): SleeveSummary[] {
  return [readCryptoSleeve(dataDir), readMetalsSleeve(dataDir), readGoldSleeve(dataDir), readLetfSleeve(dataDir)];
}

export interface OpenPosition {
  sleeve: string;
  symbol: string;
  direction: string;
  entryPrice: number;
  sizeUsdt: number | null;
  entryTimestamp: number;
  strategy: string | null;
  /** Risk rails. Null for session legs, which carry no stop or target. */
  stopLoss: number | null;
  takeProfit: number | null;
  /** Latest known mark. Null when no price history is stored for the sleeve. */
  currentPrice: number | null;
  /** Unrealised return as a FRACTION, direction-aware. Null without a mark. */
  unrealizedPct: number | null;
  /**
   * 0..1 progress. `price` = entry->target for positions with a target;
   * `time` = elapsed/window for session legs, which exit on a clock not a target.
   */
  progress: number | null;
  progressKind: 'price' | 'time' | null;
  /** Designed window for a session leg, so the UI can show time remaining. */
  expectedHoldMs: number | null;
}

/**
 * Designed hold window per session leg, from the entry/exit clock rules in
 * run-metals-bot.ts. These legs have no stop or target — the window IS the
 * strategy — so elapsed-vs-window is the only meaningful "progress" for them.
 */
const LEG_WINDOW_HOURS: Record<string, number> = {
  overnight: 9,      // 22:00 -> 07:01 UTC
  weekend: 59,       // Fri 20:00 -> Mon 07:00
  'fix-short': 1,    // into the 15:00 London fix
  'agfix-short': 1,  // into silver's noon London fix
  'amfix-long': 1.5, // -> 11:30 London
  'eur-morning-short': 3,
  'eur-h22-long': 3,
  'us500-overnight': 13.5, // -> NY 09:31
};

/** Designed hold for a session leg, or null if the leg is unknown. */
export function expectedHoldMsFor(leg: string): number | null {
  const h = LEG_WINDOW_HOURS[leg];
  return h === undefined ? null : h * 3_600_000;
}

/** Latest stored close per symbol, or null when no candle history exists. */
function latestCloses(db: Database.Database): Map<string, number> {
  const out = new Map<string, number>();
  if (!tableExists(db, 'bot_candles')) return out;
  const rows = db.prepare(
    'SELECT symbol, close FROM bot_candles WHERE (symbol, timestamp) IN (SELECT symbol, MAX(timestamp) FROM bot_candles GROUP BY symbol)',
  ).all() as Array<{ symbol: string; close: number }>;
  for (const r of rows) out.set(r.symbol, r.close);
  return out;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function readOpenPositions(dataDir: string = defaultDataDir()): OpenPosition[] {
  const db = openReadonly(dataDir);
  const out: OpenPosition[] = [];
  if (db) {
    try {
      if (tableExists(db, 'bot_positions')) {
        // SELECT * and read defensively: older/partial schemas may lack the risk
        // rail columns, and a hard column list would throw instead of degrading.
        const rows = db.prepare(
          "SELECT * FROM bot_positions WHERE status = 'open'",
        ).all() as Array<Record<string, unknown>>;
        const marks = latestCloses(db);
        for (const raw of rows) {
          const num = (k: string): number | null => (typeof raw[k] === 'number' ? (raw[k] as number) : null);
          const str = (k: string): string => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
          const r = {
            symbol: str('symbol'),
            direction: str('direction'),
            entry_price: num('entry_price') ?? 0,
            entry_timestamp: num('entry_timestamp') ?? 0,
            position_size_usdt: num('position_size_usdt'),
            strategy: str('strategy') || null,
            stop_loss: num('stop_loss'),
            take_profit: num('take_profit'),
            current_sl: num('current_sl'),
          };
          const mark = marks.get(r.symbol) ?? null;
          const long = r.direction === 'long';
          const unreal = mark === null || r.entry_price === 0
            ? null
            : (long ? mark - r.entry_price : r.entry_price - mark) / r.entry_price;
          // Progress toward the target along the entry->TP leg.
          const tp = r.take_profit;
          const span = tp === null ? 0 : Math.abs(tp - r.entry_price);
          const moved = mark === null ? 0 : (long ? mark - r.entry_price : r.entry_price - mark);
          const progress = mark === null || span === 0 ? null : clamp01(moved / span);
          out.push({
            sleeve: 'crypto', symbol: r.symbol, direction: r.direction, entryPrice: r.entry_price,
            sizeUsdt: r.position_size_usdt, entryTimestamp: r.entry_timestamp, strategy: r.strategy,
            stopLoss: r.current_sl ?? r.stop_loss, takeProfit: r.take_profit,
            currentPrice: mark, unrealizedPct: unreal,
            progress, progressKind: progress === null ? null : 'price',
            expectedHoldMs: null,
          });
        }
      }
    } finally {
      db.close();
    }
  }
  // Gold: single open position flag in JSON (no rich fields) — surface as a marker.
  const gold = readJson(path.join(dataDir, 'gold-bot-state.json')) as { position?: { direction?: string; entryPrice?: number; entryTime?: number } } | null;
  if (gold?.position) {
    out.push({
      sleeve: 'gold', symbol: 'XAUTUSDT', direction: gold.position.direction ?? '—',
      entryPrice: gold.position.entryPrice ?? 0, sizeUsdt: null,
      entryTimestamp: gold.position.entryTime ?? 0, strategy: 'f2f_gold',
      stopLoss: null, takeProfit: null, currentPrice: null, unrealizedPct: null,
      progress: null, progressKind: null, expectedHoldMs: null,
    });
  }
  // Metals: open legs in JSON.
  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as {
    positions?: Array<{
      leg?: string; direction?: string; side?: string; entryPrice?: number; entryTime?: number;
      lastPrice?: number; lastPriceTime?: number;
    }>;
  } | null;
  for (const p of metals?.positions ?? []) {
    const leg = p.leg ?? 'metals';
    const entryTs = p.entryTime ?? 0;
    const window = expectedHoldMsFor(leg);
    // Session legs exit on a clock, so progress is elapsed-vs-window. No market
    // price is stored for them, so unrealised P&L stays null rather than invented.
    const progress = window !== null && entryTs > 0
      ? clamp01((Date.now() - entryTs) / window)
      : null;
    // The metals bot persists the latest quote on each open leg, so unrealised
    // P&L is available even though these legs carry no stop or target.
    const dir0 = p.direction ?? p.side ?? '—';
    const entryPx = p.entryPrice ?? 0;
    const mark = typeof p.lastPrice === 'number' ? p.lastPrice : null;
    const unreal = mark === null || entryPx === 0
      ? null
      : (dir0 === 'short' ? entryPx - mark : mark - entryPx) / entryPx;
    out.push({
      sleeve: 'metals', symbol: leg, direction: dir0,
      entryPrice: entryPx, sizeUsdt: null, entryTimestamp: entryTs, strategy: 'session',
      stopLoss: null, takeProfit: null, currentPrice: mark, unrealizedPct: unreal,
      // Progress stays TIME-based: these legs exit on the clock, not on a target.
      progress, progressKind: progress === null ? null : 'time', expectedHoldMs: window,
    });
  }
  // LETF close-flow: per-instrument open position in JSON (exits at the 16:00 ET
  // mark, ~1h max hold, so progress is elapsed-vs-window like session legs).
  const letf = readJson(path.join(dataDir, 'letf-bot-state.json')) as
    | { instruments?: Record<string, { position?: { side?: string; entryPrice?: number; entryTime?: number } | null }> }
    | null;
  for (const [instrument, inst] of Object.entries(letf?.instruments ?? {})) {
    const p = inst.position;
    if (!p) continue;
    const entryTs = p.entryTime ?? 0;
    const window = 3_600_000; // enter 15:00-15:30 ET, exit 16:00 ET
    const progress = entryTs > 0 ? clamp01((Date.now() - entryTs) / window) : null;
    out.push({
      sleeve: 'letf', symbol: `close-flow ${instrument}`, direction: p.side ?? '—',
      entryPrice: p.entryPrice ?? 0, sizeUsdt: null, entryTimestamp: entryTs, strategy: 'letf_close_flow',
      stopLoss: null, takeProfit: null, currentPrice: null, unrealizedPct: null,
      progress, progressKind: progress === null ? null : 'time', expectedHoldMs: window,
    });
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

/**
 * Stable synthetic id for a metals trade (its JSON state has no id column).
 *
 * MUST include `metal`: the gold and silver sides of a paired leg (e.g.
 * `overnight`) close at the SAME exit timestamp, so leg+exitTime alone collides
 * — both rows would resolve to one trade and the detail view would show the
 * wrong numbers for one of them. Shared by the list and the lookup so the two
 * can never drift apart.
 */
function metalsTradeId(t: { leg?: string; metal?: string; exitTime?: string }): string {
  return `metals:${t.leg ?? 'metals'}:${t.metal ?? 'na'}:${t.exitTime ? Date.parse(t.exitTime) : 0}`;
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
  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as { trades?: Array<{ leg?: string; metal?: string; side?: string; entryTime?: string; exitTime?: string; pnlPct?: number; stale?: boolean }> } | null;
  for (const t of metals?.trades ?? []) {
    // Metals state stores PERCENT (see run-metals-bot.ts); readers normalize to FRACTION.
    out.push({ id: metalsTradeId(t), sleeve: 'metals', symbol: t.leg ?? 'metals', direction: t.side ?? '—', entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0, exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0, pnlPct: (t.pnlPct ?? 0) / 100, pnlUsdt: null, exitReason: t.stale ? 'stale (downtime)' : null });
  }
  const letf = readJson(path.join(dataDir, 'letf-bot-state.json')) as { trades?: Array<{ instrument?: string; side?: string; entryTime?: string; exitTime?: string; pnlPct?: number }> } | null;
  for (const t of letf?.trades ?? []) {
    // LETF state stores PERCENT (metals convention); readers normalize to FRACTION.
    out.push({ id: letfTradeId(t), sleeve: 'letf', symbol: `close-flow ${t.instrument ?? '?'}`, direction: t.side ?? '—', entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0, exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0, pnlPct: (t.pnlPct ?? 0) / 100, pnlUsdt: null, exitReason: null });
  }
  return out.sort((a, b) => b.exitTimestamp - a.exitTimestamp).slice(0, limit);
}

/** Stable synthetic id for an LETF trade (instrument + exit time is unique: max 1 trade/day/instrument). */
function letfTradeId(t: { instrument?: string; exitTime?: string }): string {
  return `letf:${t.instrument ?? 'na'}:${t.exitTime ? Date.parse(t.exitTime) : 0}`;
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
    | { trades?: Array<{ leg?: string; metal?: string; side?: string; entryPrice?: number; exitPrice?: number; entryTime?: string; exitTime?: string; pnlPct?: number; stale?: boolean }> }
    | null;
  for (const t of metals?.trades ?? []) {
    const tid = metalsTradeId(t);
    if (tid === id) {
      // Metals state stores PERCENT (see run-metals-bot.ts); readers normalize to FRACTION.
      return {
        ...NOT_FOUND, found: true, id: tid, sleeve: 'metals', symbol: t.leg ?? 'metals',
        direction: t.side ?? '—', entryPrice: t.entryPrice ?? null, exitPrice: t.exitPrice ?? null,
        entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0,
        exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0,
        pnlPct: (t.pnlPct ?? 0) / 100, exitReason: t.stale ? 'stale (downtime)' : null,
      };
    }
  }
  const letfState = readJson(path.join(dataDir, 'letf-bot-state.json')) as
    | { trades?: Array<{ instrument?: string; side?: string; sig?: number; threshold?: number; entryPrice?: number; exitPrice?: number; entryTime?: string; exitTime?: string; pnlPct?: number }> }
    | null;
  for (const t of letfState?.trades ?? []) {
    const tid = letfTradeId(t);
    if (tid === id) {
      // LETF state stores PERCENT (metals convention); readers normalize to FRACTION.
      return {
        ...NOT_FOUND, found: true, id: tid, sleeve: 'letf', symbol: `close-flow ${t.instrument ?? '?'}`,
        direction: t.side ?? '—', entryPrice: t.entryPrice ?? null, exitPrice: t.exitPrice ?? null,
        entryTimestamp: t.entryTime ? Date.parse(t.entryTime) : 0,
        exitTimestamp: t.exitTime ? Date.parse(t.exitTime) : 0,
        pnlPct: (t.pnlPct ?? 0) / 100,
        exitReason: t.sig !== undefined && t.threshold !== undefined
          ? `sig ${(t.sig * 1e4).toFixed(0)}bp vs thr ${(t.threshold * 1e4).toFixed(0)}bp`
          : null,
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
  n: number;
}

export function readCosts(dataDir: string = defaultDataDir()): CostSummary {
  const empty: CostSummary = { totalGross: 0, totalFriction: 0, totalFunding: 0, totalNet: 0, fundingBySymbol: [], n: 0 };
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
    out.n = rows.length;
    return out;
  } finally {
    db.close();
  }
}

// ============================================================================
// Book attribution — "what moved the number"
// ============================================================================

/** One leg's contribution to the book. */
export interface LegAttribution {
  leg: string;
  sleeve: string;
  n: number;
  /** Net contribution as a FRACTION (0.015 = +1.5%). */
  netPnlPct: number;
  winRate: number;
  /** Trades flagged downtime-stranded — drift, not strategy. */
  staleCount: number;
}

/**
 * Per-leg P&L decomposition, biggest absolute impact first.
 *
 * The dashboard headline needs to state WHICH leg moved the book, not just the
 * total — a bare figure with no decomposition is what forced every "why did it
 * go negative?" question to be answered by hand.
 */
export function readLegAttribution(dataDir: string = defaultDataDir()): LegAttribution[] {
  const acc = new Map<string, LegAttribution>();
  const add = (leg: string, sleeve: string, pnlFraction: number, stale: boolean): void => {
    const key = `${sleeve}:${leg}`;
    const cur = acc.get(key) ?? { leg, sleeve, n: 0, netPnlPct: 0, winRate: 0, staleCount: 0 };
    cur.n += 1;
    cur.netPnlPct += pnlFraction;
    if (pnlFraction > 0) cur.winRate += 1; // running win count; normalised below
    if (stale) cur.staleCount += 1;
    acc.set(key, cur);
  };

  // Crypto: bot_trades, grouped by strategy (its "leg").
  const db = openReadonly(dataDir);
  if (db) {
    try {
      if (tableExists(db, 'bot_trades')) {
        const rows = db.prepare('SELECT strategy, pnl_percent FROM bot_trades').all() as Array<{ strategy: string; pnl_percent: number }>;
        for (const r of rows) add(r.strategy, 'crypto', r.pnl_percent, false);
      }
    } finally {
      db.close();
    }
  }

  // Gold: JSON state (already fraction-scale).
  const gold = readJson(path.join(dataDir, 'gold-bot-state.json')) as
    | { trades?: Array<{ pnlPct?: number; pnlPercent?: number }> } | null;
  for (const t of gold?.trades ?? []) add('f2f_gold', 'gold', t.pnlPct ?? t.pnlPercent ?? 0, false);

  // Metals: JSON state stores PERCENT — normalise to fraction (see legWeight note).
  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as
    | { trades?: Array<{ leg?: string; pnlPct?: number; stale?: boolean }> } | null;
  for (const t of metals?.trades ?? []) {
    add(t.leg ?? 'metals', 'metals', (t.pnlPct ?? 0) / 100, t.stale === true);
  }

  return [...acc.values()]
    .map((l) => ({ ...l, winRate: l.n > 0 ? l.winRate / l.n : 0 }))
    .sort((a, b) => Math.abs(b.netPnlPct) - Math.abs(a.netPnlPct));
}

/** The headline story: which leg dominates, and what the rest did. */
export interface AttributionSummary {
  total: number;
  topDetractor: LegAttribution | null;
  topContributor: LegAttribution | null;
  /** Net of everything EXCEPT the top detractor. */
  restNetPnlPct: number;
  /**
   * True when a single losing leg outweighs everything else combined — the case
   * where "one leg did this" is an honest headline rather than a cherry-pick.
   */
  dominatedByOneLeg: boolean;
}

export function summariseAttribution(legs: LegAttribution[]): AttributionSummary {
  const total = legs.reduce((a, l) => a + l.netPnlPct, 0);
  if (legs.length === 0) {
    return { total: 0, topDetractor: null, topContributor: null, restNetPnlPct: 0, dominatedByOneLeg: false };
  }
  const losers = legs.filter((l) => l.netPnlPct < 0).sort((a, b) => a.netPnlPct - b.netPnlPct);
  const winners = legs.filter((l) => l.netPnlPct > 0).sort((a, b) => b.netPnlPct - a.netPnlPct);
  const topDetractor = losers[0] ?? null;
  const topContributor = winners[0] ?? null;
  const restNetPnlPct = topDetractor ? total - topDetractor.netPnlPct : total;
  // Dominated when the worst leg is more negative than everything else is positive,
  // AND it is materially worse than the next-worst (not just first alphabetically).
  const secondWorst = losers[1]?.netPnlPct ?? 0;
  const dominatedByOneLeg = topDetractor !== null
    && Math.abs(topDetractor.netPnlPct) > Math.abs(restNetPnlPct)
    && Math.abs(topDetractor.netPnlPct) > Math.abs(secondWorst) * 1.5;
  return { total, topDetractor, topContributor, restNetPnlPct, dominatedByOneLeg };
}

/**
 * Book-level equity curve, reconstructed from the closed trades of ALL sleeves.
 *
 * Equity SNAPSHOTS only exist for crypto, so plotting them showed a flat line at
 * the crypto notional while the book was down several percent from metals — a
 * chart that contradicted its own headline. Each sleeve runs the same starting
 * notional, so the book is the sum of the three sleeve equities through time:
 * every trade moves the book by its own pnl fraction divided by the sleeve count.
 *
 * Downtime-stranded trades are EXCLUDED: they are unmanaged drift booked while
 * the bot was down, not strategy equity.
 */
export function readBookEquityCurve(dataDir: string = defaultDataDir()): EquityPoint[] {
  const events: Array<{ t: number; pnl: number }> = [];

  const db = openReadonly(dataDir);
  if (db) {
    try {
      if (tableExists(db, 'bot_trades')) {
        const rows = db.prepare('SELECT exit_timestamp, pnl_percent FROM bot_trades').all() as Array<{ exit_timestamp: number; pnl_percent: number }>;
        for (const r of rows) events.push({ t: r.exit_timestamp, pnl: r.pnl_percent });
      }
    } finally {
      db.close();
    }
  }

  const gold = readJson(path.join(dataDir, 'gold-bot-state.json')) as
    | { trades?: Array<{ exitTime?: string; pnlPct?: number; pnlPercent?: number }> } | null;
  for (const t of gold?.trades ?? []) {
    events.push({ t: t.exitTime ? Date.parse(t.exitTime) : 0, pnl: t.pnlPct ?? t.pnlPercent ?? 0 });
  }

  const metals = readJson(path.join(dataDir, 'metals-bot-state.json')) as
    | { trades?: Array<{ exitTime?: string; pnlPct?: number; stale?: boolean }> } | null;
  for (const t of metals?.trades ?? []) {
    if (t.stale === true) continue; // drift, not strategy
    events.push({ t: t.exitTime ? Date.parse(t.exitTime) : 0, pnl: (t.pnlPct ?? 0) / 100 });
  }

  if (events.length === 0) return [];
  events.sort((a, b) => a.t - b.t);

  // Derive the sleeve count — do NOT hardcode. Sleeves get added (letf was the
  // fourth), and a stale constant would silently mis-scale the whole curve.
  const SLEEVES = Math.max(1, readAllSleeves(dataDir).length);
  const start = SLEEVE_STARTING_EQUITY * SLEEVES;
  let cum = 0;
  let peak = start;
  const out: EquityPoint[] = [];
  for (const e of events) {
    cum += e.pnl / SLEEVES; // each sleeve carries an equal share of the book
    const equity = start * (1 + cum);
    if (equity > peak) peak = equity;
    out.push({ timestamp: e.t, equity, drawdown: peak > 0 ? (peak - equity) / peak : 0 });
  }
  return out;
}

// ============================================================================
// Trade chart — see the market, not just the number
// ============================================================================

export interface ChartCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TradeChart {
  available: boolean;
  /** Why there is no chart, when there isn't one. */
  reason: string | null;
  symbol: string;
  direction: string;
  candles: ChartCandle[];
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number | null;
  exitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** Bars of context to show either side of the trade so the move reads in situ. */
const CHART_PAD_BARS = 40;
const BAR_MS = 3_600_000;

const NO_CHART: TradeChart = {
  available: false, reason: null, symbol: '', direction: '', candles: [],
  entryTimestamp: 0, exitTimestamp: 0, entryPrice: null, exitPrice: null,
  stopLoss: null, takeProfit: null,
};

/** Fetches OHLC for a venue symbol over a window. Injectable so tests need no network. */
export type CandleFetcher = (symbol: string, fromMs: number, toMs: number) => Promise<ChartCandle[]>;

/** Instrument -> Yahoo symbol, mirroring run-metals-bot.ts's own map. */
const YAHOO_SYMBOL: Record<string, string> = {
  gold: 'GC=F', silver: 'SI=F', eurusd: 'EURUSD=X', us500: 'ES=F',
};

/**
 * Human names for the venue instruments.
 *
 * `GC=F`/`SI=F`/`ES=F` are Yahoo ticker conventions (`=F` futures, `=X` FX) and
 * mean nothing to a reader — the UI should name what a person recognises. These
 * ARE futures rather than spot on purpose: the session edge only survives at
 * futures-tier cost (~0.3-0.5bp/side; dead by 2bp), so the bot quotes the venue
 * it could actually be traded on.
 */
const INSTRUMENT_LABEL: Record<string, string> = {
  gold: 'Gold futures (COMEX GC)',
  silver: 'Silver futures (COMEX SI)',
  eurusd: 'EUR/USD spot',
  us500: 'S&P 500 E-mini (CME ES)',
};

/** Default fetcher: Yahoo 5m bars. Covers ~60 days, enough for any live trade. */
export const fetchYahooCandles: CandleFetcher = async (symbol, fromMs, toMs) => {
  const p1 = Math.floor(fromMs / 1000);
  const p2 = Math.ceil(toMs / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&period1=${p1}&period2=${p2}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return [];
  const j = (await res.json()) as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, Array<number | null>>> } }> };
  };
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!q) return [];
  const out: ChartCandle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i]; const h = q.high?.[i]; const l = q.low?.[i]; const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ timestamp: ts[i]! * 1000, open: o, high: h, low: l, close: c });
  }
  return out;
};

/** Instrument segment of a synthetic metals id (`metals:<leg>:<metal>:<ts>`). */
function metalsInstrumentFromId(id: string): string | null {
  const parts = id.split(':');
  return parts.length >= 4 ? (parts[2] ?? null) : null;
}

/**
 * Candles around a trade, plus the markers needed to draw it.
 *
 * Crypto reads stored OHLCV (`bot_candles`). The session legs and gold never
 * persist bars — they quote live and keep only fills — so rather than showing
 * nothing (which left 100% of the live book unchartable), those windows are
 * fetched ON DEMAND from the same venue the bot quotes from. No bot change and
 * it works retroactively for every trade already booked.
 */
export async function readTradeChart(
  id: string,
  dataDir: string = defaultDataDir(),
  fetcher: CandleFetcher = fetchYahooCandles,
): Promise<TradeChart> {
  const detail = readTradeDetail(id, dataDir);
  if (!detail.found) return { ...NO_CHART, reason: 'Trade not found.' };

  const base: TradeChart = {
    ...NO_CHART,
    symbol: detail.symbol,
    direction: detail.direction,
    entryTimestamp: detail.entryTimestamp,
    exitTimestamp: detail.exitTimestamp,
    entryPrice: detail.entryPrice,
    exitPrice: detail.exitPrice,
    stopLoss: detail.stopLoss,
    takeProfit: detail.takeProfit,
  };

  if (detail.sleeve !== 'crypto') {
    // Guard the instrument itself so both it and the venue symbol narrow.
    const instrument = detail.sleeve === 'metals' ? metalsInstrumentFromId(id) : null;
    const venueSymbol = instrument === null ? undefined : YAHOO_SYMBOL[instrument];
    if (instrument === null || venueSymbol === undefined) {
      return { ...base, reason: `No market data source mapped for the ${detail.sleeve} sleeve.` };
    }
    const pad = CHART_PAD_BARS * 5 * 60_000; // 5m bars
    try {
      const candles = await fetcher(venueSymbol, detail.entryTimestamp - pad, detail.exitTimestamp + pad);
      if (candles.length === 0) {
        return { ...base, reason: 'The venue returned no bars for this window.' };
      }
      const label = INSTRUMENT_LABEL[instrument] ?? venueSymbol;
      return { ...base, available: true, candles, symbol: `${detail.symbol} · ${label}` };
    } catch {
      // Never let a flaky upstream break the drawer.
      return { ...base, reason: 'Could not reach the market-data provider.' };
    }
  }

  const db = openReadonly(dataDir);
  if (!db) return { ...base, reason: 'No candle history available.' };
  try {
    if (!tableExists(db, 'bot_candles')) {
      return { ...base, reason: 'No candle history available.' };
    }
    const from = detail.entryTimestamp - CHART_PAD_BARS * BAR_MS;
    const to = detail.exitTimestamp + CHART_PAD_BARS * BAR_MS;
    const rows = db.prepare(
      'SELECT timestamp, open, high, low, close FROM bot_candles WHERE symbol = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC',
    ).all(detail.symbol, from, to) as ChartCandle[];
    if (rows.length === 0) {
      return { ...base, reason: 'No candles stored for this window.' };
    }
    return { ...base, available: true, candles: rows };
  } finally {
    db.close();
  }
}
