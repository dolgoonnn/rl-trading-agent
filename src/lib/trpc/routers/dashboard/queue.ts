import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';
import { computeRiskState } from '@/lib/queue/risk-gate';
import { generateProposals } from '@/lib/queue/proposal-generator';
import type { ProposalReasoning } from '@/lib/queue/proposal-generator';

export interface ProposalView {
  id: string;
  createdAt: number;
  symbol: string;
  strategy: string;
  side: 'long' | 'short';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  score: number;
  threshold: number;
  rrRatio: number;
  regime: string;
  reasoning: ProposalReasoning;
  caveats: string[];
  status: string;
  decisionReason: string | null;
  decisionAt: number | null;
  outcomePnlR: number | null;
}

interface ProposalRow {
  id: string;
  created_at: number;
  symbol: string;
  strategy: string;
  side: string;
  entry: number;
  stop_loss: number;
  take_profit: number;
  score: number;
  threshold: number;
  rr_ratio: number;
  regime: string;
  reasoning: string;
  caveats: string;
  status: string;
  decision_reason: string | null;
  decision_at: number | null;
  outcome_pnl_r: number | null;
}

interface BotPositionRow {
  id: string;
  symbol: string;
  direction: string;
  entry_price: number;
  current_sl: number;
  take_profit: number;
  position_size_usdt: number;
  bars_held: number | null;
  pnl_percent: number | null;
  strategy: string;
  entry_timestamp: number;
}

function toView(r: ProposalRow): ProposalView {
  let reasoning: ProposalReasoning;
  try {
    reasoning = JSON.parse(r.reasoning) as ProposalReasoning;
  } catch {
    reasoning = { topFactors: [], factorBreakdown: {}, fullReasoning: [] };
  }
  let caveats: string[];
  try {
    const parsed = JSON.parse(r.caveats) as unknown;
    caveats = Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    caveats = [];
  }
  return {
    id: r.id,
    createdAt: r.created_at,
    symbol: r.symbol,
    strategy: r.strategy,
    side: r.side === 'long' ? 'long' : 'short',
    entry: r.entry,
    stopLoss: r.stop_loss,
    takeProfit: r.take_profit,
    score: r.score,
    threshold: r.threshold,
    rrRatio: r.rr_ratio,
    regime: r.regime,
    reasoning,
    caveats,
    status: r.status,
    decisionReason: r.decision_reason,
    decisionAt: r.decision_at,
    outcomePnlR: r.outcome_pnl_r,
  };
}

function openDb() {
  const p = path.resolve('data/ict-trading.db');
  if (!fs.existsSync(p)) return null;
  return new Database(p);
}

function expirePending(db: Database.Database, now: number): number {
  const cutoff = now - 4 * 3_600_000; // expire after 4h
  const r = db
    .prepare(`UPDATE proposals SET status = 'expired' WHERE status = 'pending' AND created_at < ?`)
    .run(cutoff);
  return r.changes;
}

export const queueRouter = router({
  feed: publicProcedure
    .input(
      z.object({
        auditLimit: z.number().int().min(1).max(100).default(20),
      }).optional(),
    )
    .query(({ input }) => {
      const db = openDb();
      if (!db) {
        return {
          available: false as const,
          pending: [] as ProposalView[],
          recentDecisions: [] as ProposalView[],
          openPositions: [] as BotPositionRow[],
          risk: null,
          stats: { pendingCount: 0, approvedToday: 0, rejectedToday: 0, expiredToday: 0 },
        };
      }
      try {
        const now = Date.now();
        const auditLimit = input?.auditLimit ?? 20;
        expirePending(db, now);

        const pending = db
          .prepare(
            `SELECT * FROM proposals
             WHERE status = 'pending' OR (status = 'snoozed' AND snooze_until <= ?)
             ORDER BY score DESC, created_at DESC`,
          )
          .all(now) as ProposalRow[];
        const todayStart = new Date(now);
        todayStart.setUTCHours(0, 0, 0, 0);
        const recent = db
          .prepare(
            `SELECT * FROM proposals
             WHERE status IN ('approved', 'rejected', 'expired', 'executed')
               AND COALESCE(decision_at, created_at) >= ?
             ORDER BY COALESCE(decision_at, created_at) DESC
             LIMIT ?`,
          )
          .all(todayStart.getTime(), auditLimit) as ProposalRow[];

        const counts = db
          .prepare(
            `SELECT status, COUNT(*) AS c FROM proposals
             WHERE COALESCE(decision_at, created_at) >= ?
             GROUP BY status`,
          )
          .all(todayStart.getTime()) as Array<{ status: string; c: number }>;
        const countMap = new Map(counts.map((c) => [c.status, c.c]));

        let positions: BotPositionRow[] = [];
        try {
          positions = db
            .prepare(
              `SELECT id, symbol, direction, entry_price, current_sl, take_profit,
                      position_size_usdt, bars_held, pnl_percent, strategy, entry_timestamp
               FROM bot_positions WHERE status = 'open' ORDER BY entry_timestamp DESC`,
            )
            .all() as BotPositionRow[];
        } catch {
          // table may not exist
        }

        const risk = computeRiskState(db, now);

        return {
          available: true as const,
          pending: pending.map(toView),
          recentDecisions: recent.map(toView),
          openPositions: positions,
          risk,
          stats: {
            pendingCount: pending.length,
            approvedToday: countMap.get('approved') ?? 0,
            rejectedToday: countMap.get('rejected') ?? 0,
            expiredToday: countMap.get('expired') ?? 0,
          },
        };
      } finally {
        db.close();
      }
    }),

  forSymbol: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(({ input }) => {
      const db = openDb();
      if (!db) {
        return { available: false as const, pending: [] as ProposalView[], risk: null };
      }
      try {
        const now = Date.now();
        const pending = db
          .prepare(
            `SELECT * FROM proposals
             WHERE symbol = ? AND (status = 'pending' OR (status = 'snoozed' AND snooze_until <= ?))
             ORDER BY score DESC, created_at DESC
             LIMIT 5`,
          )
          .all(input.symbol, now) as ProposalRow[];
        const risk = computeRiskState(db, now);
        return { available: true as const, pending: pending.map(toView), risk };
      } finally {
        db.close();
      }
    }),

  generate: publicProcedure
    .input(
      z.object({
        symbols: z.array(z.string()).optional(),
      }).optional(),
    )
    .mutation(({ input }) => {
      const db = openDb();
      if (!db) return { ok: false as const, error: 'no database' };
      try {
        const result = generateProposals(db, { symbols: input?.symbols });
        return { ok: true as const, ...result };
      } finally {
        db.close();
      }
    }),

  decide: publicProcedure
    .input(
      z.object({
        id: z.string(),
        decision: z.enum(['approved', 'rejected', 'snoozed']),
        reason: z.string().min(3).max(2000),
        snoozeMinutes: z.number().int().min(5).max(240).optional(),
      }),
    )
    .mutation(({ input }) => {
      const db = openDb();
      if (!db) return { ok: false as const, error: 'no database' };
      try {
        const now = Date.now();
        if (input.decision === 'snoozed') {
          const minutes = input.snoozeMinutes ?? 30;
          db.prepare(
            `UPDATE proposals
             SET status = 'snoozed', decision_reason = ?, decision_at = ?, snooze_until = ?
             WHERE id = ? AND status = 'pending'`,
          ).run(input.reason, now, now + minutes * 60_000, input.id);
        } else {
          // For approval, enforce risk gate at decision time too — defense in depth.
          if (input.decision === 'approved') {
            const risk = computeRiskState(db, now);
            if (risk.blocked) {
              return { ok: false as const, error: `risk gate blocks: ${risk.blockedReason}` };
            }
          }
          db.prepare(
            `UPDATE proposals
             SET status = ?, decision_reason = ?, decision_at = ?
             WHERE id = ? AND status IN ('pending', 'snoozed')`,
          ).run(input.decision, input.reason, now, input.id);
        }
        return { ok: true as const };
      } finally {
        db.close();
      }
    }),
});
