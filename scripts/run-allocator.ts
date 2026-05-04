#!/usr/bin/env tsx
/**
 * Weekly Portfolio Allocator (advisory)
 *
 * Computes inverse-vol weights for currently deployed strategies and writes
 * recommendations to data/allocator-recommendations.json + Telegram.
 *
 * Cron: Sundays 00:05 UTC (PM2 entry added in Task 13 of the allocator plan).
 *
 * NO BOT CONFIG IS MUTATED. Output is informational only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  getDailyReturnsForStrategy,
  computeInverseVolWeights,
  type EquitySources,
} from '@/lib/portfolio';
import type { AllocatorResult, StrategyId } from '@/lib/portfolio/types';
import { AlertManager } from '@/lib/bot/alerts';
import { DEFAULT_BOT_CONFIG } from '@/lib/bot/config';

const LOOKBACK_DAYS = 60;
const OUT_PATH = path.resolve('data/allocator-recommendations.json');
const DEPLOYED: StrategyId[] = ['ict-3sym', 'f2f-gold'];

// Each deployed strategy's currently configured riskPerTrade.
// Both bots use DEFAULT_BOT_CONFIG.riskPerTrade today (0.003 = 0.3%).
// If they diverge, refactor here.
const CURRENT_RISK_PER_TRADE: Record<StrategyId, number> = {
  'ict-3sym': DEFAULT_BOT_CONFIG.riskPerTrade,
  'ict-7sym': DEFAULT_BOT_CONFIG.riskPerTrade,
  'f2f-gold': DEFAULT_BOT_CONFIG.riskPerTrade,
};

function openCryptoDb(): Database.Database | null {
  const dbPath = path.resolve('data/app.db');
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

async function main(): Promise<void> {
  const cryptoDb = openCryptoDb();
  try {
    const sources: EquitySources = {
      cryptoDb,
      goldStatePath: path.resolve('data/gold-bot-state.json'),
    };

    const inputs = DEPLOYED.map((strategy) => ({
      strategy,
      dailyReturns: getDailyReturnsForStrategy(strategy, LOOKBACK_DAYS, sources),
    }));

    const { allocations, warnings } = computeInverseVolWeights(inputs);

    const totalCurrentRiskBudget = DEPLOYED.reduce(
      (s, k) => s + CURRENT_RISK_PER_TRADE[k],
      0,
    );

    for (const a of allocations) {
      a.currentRiskPerTrade = CURRENT_RISK_PER_TRADE[a.strategy];
      a.recommendedRiskPerTrade = a.weight * totalCurrentRiskBudget;
    }

    const result: AllocatorResult = {
      generatedAt: Date.now(),
      lookbackDays: LOOKBACK_DAYS,
      totalCurrentRiskBudget,
      allocations,
      warnings,
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));

    // Telegram credentials — accept either CLI args or env vars (PM2 supplies env).
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

    const lines: string[] = [
      `📊 Allocator (advisory) — ${LOOKBACK_DAYS}d inverse-vol`,
      `Total risk budget: ${(totalCurrentRiskBudget * 100).toFixed(2)}%`,
      '',
    ];
    for (const a of allocations) {
      if (a.excluded) {
        lines.push(`• ${a.strategy}: EXCLUDED (${a.excluded.reason})`);
        continue;
      }
      const cur = (a.currentRiskPerTrade * 100).toFixed(3);
      const rec = (a.recommendedRiskPerTrade * 100).toFixed(3);
      const arrow =
        Math.abs(a.recommendedRiskPerTrade - a.currentRiskPerTrade) < 1e-5
          ? '='
          : '→';
      lines.push(
        `• ${a.strategy}: weight ${(a.weight * 100).toFixed(1)}% | risk/trade ${cur}% ${arrow} ${rec}% | annVol ${(a.annualizedVol * 100).toFixed(1)}%`,
      );
    }
    if (warnings.length) {
      lines.push('', '⚠️ ' + warnings.join('; '));
    }

    const alerts = new AlertManager(telegramToken, telegramChatId);
    await alerts.send({
      level: 'info',
      event: 'daily_summary',
      message: lines.join('\n'),
      timestamp: Date.now(),
    });

    console.log(`Wrote ${OUT_PATH}`);
  } finally {
    cryptoDb?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
