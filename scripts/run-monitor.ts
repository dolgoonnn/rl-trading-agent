#!/usr/bin/env tsx
/**
 * Daily Decay Monitor
 *
 * Compares each deployed strategy's live 30d Sharpe against its bootstrap 5th
 * percentile, and 90d drawdown against 1.5× backtest MaxDD. Writes status to
 * data/decay-status.json and sends a Telegram alert (debounced 24h) only when
 * a tripwire fires.
 *
 * Cron: daily 00:10 UTC.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  getDailyReturnsForStrategy,
  resampleToUtcDaily,
  readCryptoEquityFromDb,
  loadBootstrapFloors,
  loadDrawdownCeilings,
  evaluateDecay,
  type EquitySources,
} from '@/lib/portfolio';
import type {
  DecayStatus,
  EquityPoint,
  MonitorResult,
  StrategyId,
} from '@/lib/portfolio/types';
import { AlertManager } from '@/lib/bot/alerts';

const LOOKBACK_RETURNS_DAYS = 30;
const LOOKBACK_EQUITY_DAYS = 90;
const ALERT_DEBOUNCE_MS = 24 * 60 * 60 * 1000;
const STATUS_PATH = path.resolve('data/decay-status.json');
const ALERT_LOG_PATH = path.resolve('data/decay-alerts-log.json');
const DEPLOYED: StrategyId[] = ['ict-3sym', 'f2f-gold'];

function openCryptoDb(): Database.Database | null {
  const dbPath = path.resolve('data/app.db');
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

function load90dEquityForStrategy(
  strategy: StrategyId,
  sources: EquitySources,
): EquityPoint[] {
  if (strategy === 'f2f-gold') {
    // Gold persists only daily returns + a current equity scalar. Reconstruct
    // a 90-bar equity curve from the rolling30dReturns array (best available).
    if (!fs.existsSync(sources.goldStatePath)) return [];
    const raw = fs.readFileSync(sources.goldStatePath, 'utf-8');
    let parsed: { equity?: number; rolling30dReturns?: number[] };
    try {
      parsed = JSON.parse(raw) as { equity?: number; rolling30dReturns?: number[] };
    } catch {
      return [];
    }
    if (!parsed.rolling30dReturns || parsed.rolling30dReturns.length === 0)
      return [];
    const startEquity = parsed.equity ?? 10000;
    let eq = startEquity;
    // Walk backwards: reconstruct equity at each prior day from the most recent.
    const reverseEquity: EquityPoint[] = [
      { timestamp: Date.now(), equity: eq },
    ];
    const rs = parsed.rolling30dReturns;
    let t = Date.now();
    for (let i = rs.length - 1; i >= 0; i--) {
      t -= 86_400_000;
      eq = eq / (1 + rs[i]!); // invert the return
      reverseEquity.push({ timestamp: t, equity: eq });
    }
    return reverseEquity.reverse();
  }
  // crypto: pull last 90 daily-resampled equity points from DB
  if (!sources.cryptoDb) return [];
  const all = readCryptoEquityFromDb(sources.cryptoDb);
  const daily = resampleToUtcDaily(all);
  return daily.slice(-LOOKBACK_EQUITY_DAYS);
}

interface AlertLogEntry {
  strategy: StrategyId;
  lastAlertedAt: number;
}

function loadAlertLog(): AlertLogEntry[] {
  if (!fs.existsSync(ALERT_LOG_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ALERT_LOG_PATH, 'utf-8')) as AlertLogEntry[];
  } catch {
    return [];
  }
}

function saveAlertLog(entries: AlertLogEntry[]): void {
  fs.writeFileSync(ALERT_LOG_PATH, JSON.stringify(entries, null, 2));
}

async function main(): Promise<void> {
  const cryptoDb = openCryptoDb();
  try {
    const sources: EquitySources = {
      cryptoDb,
      goldStatePath: path.resolve('data/gold-bot-state.json'),
    };
    const floors = loadBootstrapFloors(path.resolve('experiments'));
    const ceilings = loadDrawdownCeilings();

    const statuses: DecayStatus[] = [];
    const warnings: string[] = [];

    for (const strategy of DEPLOYED) {
      const returns = getDailyReturnsForStrategy(
        strategy,
        LOOKBACK_RETURNS_DAYS,
        sources,
      );
      const equity = load90dEquityForStrategy(strategy, sources);
      const floor = floors.get(strategy);
      const ceiling = ceilings.get(strategy);
      if (floor === undefined || ceiling === undefined) {
        warnings.push(
          `${strategy}: bootstrap floor or DD ceiling missing — skipped`,
        );
        continue;
      }
      statuses.push(
        evaluateDecay({
          strategy,
          dailyReturns30d: returns,
          equity90d: equity,
          bootstrapFloor: floor,
          drawdownCeiling: ceiling,
        }),
      );
    }

    const result: MonitorResult = {
      generatedAt: Date.now(),
      statuses,
      warnings,
    };
    fs.writeFileSync(STATUS_PATH, JSON.stringify(result, null, 2));

    // Telegram credentials — CLI args + env-var fallback (PM2 supplies env)
    const args = process.argv.slice(2);
    let telegramToken: string | undefined;
    let telegramChatId: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--telegram-token') telegramToken = args[++i];
      else if (args[i] === '--telegram-chat') telegramChatId = args[++i];
    }
    if (!telegramToken && process.env.TELEGRAM_BOT_TOKEN) {
      telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    }
    if (!telegramChatId && process.env.TELEGRAM_CHAT_ID) {
      telegramChatId = process.env.TELEGRAM_CHAT_ID;
    }

    // Debounced Telegram alerts
    const log = loadAlertLog();
    const now = Date.now();
    const newLog: AlertLogEntry[] = [...log];
    const tripped = statuses.filter((s) => s.tripped);
    const alerts = new AlertManager(telegramToken, telegramChatId);

    for (const s of tripped) {
      const last = log.find((e) => e.strategy === s.strategy);
      if (last && now - last.lastAlertedAt < ALERT_DEBOUNCE_MS) continue;
      await alerts.send({
        level: 'critical',
        event: 'circuit_breaker_triggered',
        message: `DECAY ALERT — ${s.strategy}\n${s.reason}`,
        timestamp: now,
      });
      const idx = newLog.findIndex((e) => e.strategy === s.strategy);
      if (idx >= 0) newLog[idx] = { strategy: s.strategy, lastAlertedAt: now };
      else newLog.push({ strategy: s.strategy, lastAlertedAt: now });
    }
    saveAlertLog(newLog);

    console.log(`Wrote ${STATUS_PATH}, ${tripped.length} tripped`);
  } finally {
    cryptoDb?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
