import type { Database as BetterSqlite3Database } from 'better-sqlite3';

export interface RiskState {
  equityUsdt: number;
  dailyPnlUsdt: number;
  dailyPnlPct: number;
  riskUsedPct: number;
  riskLimitPct: number;
  tradesTodayCount: number;
  tradesTodayLimit: number;
  openPositions: number;
  maxOpenPositions: number;
  blocked: boolean;
  blockedReason: string | null;
}

export const RISK_LIMIT_PCT = 2.0;
export const TRADES_PER_DAY_LIMIT = 3;
export const MAX_OPEN_POSITIONS = 2;

interface EquityRow {
  equity: number;
}
interface CountRow {
  c: number;
  pnl: number | null;
}

function startOfDayMs(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export function computeRiskState(db: BetterSqlite3Database, now: number = Date.now()): RiskState {
  const todayStart = startOfDayMs(now);
  let equity = 10_000;
  try {
    const eq = db
      .prepare(`SELECT equity FROM bot_equity_snapshots ORDER BY timestamp DESC LIMIT 1`)
      .get() as EquityRow | undefined;
    if (eq) equity = eq.equity;
  } catch {
    // table may not exist
  }

  let dailyPnl = 0;
  let tradesToday = 0;
  try {
    const r = db
      .prepare(`SELECT COUNT(*) AS c, SUM(pnl_usdt) AS pnl FROM bot_trades WHERE created_at >= ?`)
      .get(todayStart) as CountRow | undefined;
    if (r) {
      tradesToday = r.c ?? 0;
      dailyPnl = r.pnl ?? 0;
    }
  } catch {
    // table may not exist
  }

  let openPositions = 0;
  try {
    const r = db
      .prepare(`SELECT COUNT(*) AS c FROM bot_positions WHERE status = 'open'`)
      .get() as { c: number } | undefined;
    if (r) openPositions = r.c;
  } catch {
    // table may not exist
  }

  const dailyPnlPct = equity > 0 ? (dailyPnl / equity) * 100 : 0;
  const riskUsedPct = dailyPnl < 0 ? (Math.abs(dailyPnl) / equity) * 100 : 0;

  let blocked = false;
  let blockedReason: string | null = null;
  if (riskUsedPct >= RISK_LIMIT_PCT) {
    blocked = true;
    blockedReason = `daily loss limit hit (${riskUsedPct.toFixed(2)}% used / ${RISK_LIMIT_PCT}%)`;
  } else if (tradesToday >= TRADES_PER_DAY_LIMIT) {
    blocked = true;
    blockedReason = `daily trade cap reached (${tradesToday}/${TRADES_PER_DAY_LIMIT})`;
  } else if (openPositions >= MAX_OPEN_POSITIONS) {
    blocked = true;
    blockedReason = `max open positions (${openPositions}/${MAX_OPEN_POSITIONS})`;
  }

  return {
    equityUsdt: equity,
    dailyPnlUsdt: dailyPnl,
    dailyPnlPct,
    riskUsedPct,
    riskLimitPct: RISK_LIMIT_PCT,
    tradesTodayCount: tradesToday,
    tradesTodayLimit: TRADES_PER_DAY_LIMIT,
    openPositions,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    blocked,
    blockedReason,
  };
}
