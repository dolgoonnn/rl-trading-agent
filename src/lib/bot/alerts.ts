/**
 * Alerts — Telegram Bot Integration
 *
 * Sends notifications for signals, fills, PnL summaries, errors.
 * Falls back to console logging if Telegram is not configured.
 */

import type {
  BotAlert,
  AlertLevel,
  AlertEvent,
  BotPosition,
  BotTradeRecord,
} from '@/types/bot';
import type { PositionTracker } from './position-tracker';

export class AlertManager {
  private botToken: string | undefined;
  private chatId: string | undefined;
  private enabled: boolean;
  private queue: BotAlert[] = [];
  private sending = false;

  constructor(botToken?: string, chatId?: string) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.enabled = !!(botToken && chatId);
  }

  // ============================================
  // High-Level Alert Methods
  // ============================================

  async signalDetected(
    symbol: string,
    score: number,
    direction: string,
    strategy: string,
    regime: string,
  ): Promise<void> {
    await this.send({
      level: 'info',
      event: 'signal_detected',
      message: [
        `Signal: ${symbol} ${direction.toUpperCase()}`,
        `Strategy: ${strategy}`,
        `Score: ${score.toFixed(2)}`,
        `Regime: ${regime}`,
      ].join('\n'),
      timestamp: Date.now(),
    });
  }

  async positionOpened(position: BotPosition): Promise<void> {
    const riskR = position.direction === 'long'
      ? (position.takeProfit - position.entryPrice) / (position.entryPrice - position.stopLoss)
      : (position.entryPrice - position.takeProfit) / (position.stopLoss - position.entryPrice);

    await this.send({
      level: 'info',
      event: 'position_opened',
      message: [
        `Opened: ${position.symbol} ${position.direction.toUpperCase()}`,
        `Entry: $${position.entryPrice.toFixed(2)}`,
        `SL: $${position.stopLoss.toFixed(2)}`,
        `TP: $${position.takeProfit.toFixed(2)}`,
        `R:R: ${riskR.toFixed(2)}`,
        `Size: $${position.positionSizeUSDT.toFixed(2)}`,
        `Risk: $${position.riskAmountUSDT.toFixed(2)}`,
        `Score: ${position.confluenceScore.toFixed(2)}`,
      ].join('\n'),
      timestamp: Date.now(),
    });
  }

  async positionClosed(position: BotPosition): Promise<void> {
    const pnlEmoji = (position.pnlUSDT ?? 0) >= 0 ? '+' : '';
    await this.send({
      level: (position.pnlUSDT ?? 0) >= 0 ? 'info' : 'warning',
      event: 'position_closed',
      message: [
        `Closed: ${position.symbol} ${position.direction.toUpperCase()}`,
        `Exit: $${position.exitPrice?.toFixed(2) ?? 'N/A'}`,
        `Reason: ${position.exitReason ?? 'unknown'}`,
        `PnL: ${pnlEmoji}$${(position.pnlUSDT ?? 0).toFixed(2)} (${pnlEmoji}${((position.pnlPercent ?? 0) * 100).toFixed(2)}%)`,
        `Bars: ${position.barsHeld ?? 0}`,
      ].join('\n'),
      timestamp: Date.now(),
    });
  }

  async partialTPTaken(position: BotPosition, partialPnl: number): Promise<void> {
    await this.send({
      level: 'info',
      event: 'partial_tp_taken',
      message: [
        `Partial TP: ${position.symbol} ${position.direction.toUpperCase()}`,
        `Partial PnL: ${(partialPnl * 100).toFixed(2)}%`,
        `New SL: $${position.currentSL.toFixed(2)} (moved to BE)`,
      ].join('\n'),
      timestamp: Date.now(),
    });
  }

  async circuitBreakerTriggered(type: string, reason: string): Promise<void> {
    await this.send({
      level: 'critical',
      event: 'circuit_breaker_triggered',
      message: `CIRCUIT BREAKER: ${type}\n${reason}`,
      timestamp: Date.now(),
    });
  }

  async dailySummary(tracker: PositionTracker): Promise<void> {
    const state = tracker.getState();
    const drawdown = tracker.getDrawdown();

    await this.send({
      level: 'info',
      event: 'daily_summary',
      message: [
        '--- Daily Summary ---',
        `Equity: $${state.equity.toFixed(2)}`,
        `Daily PnL: $${state.dailyPnl.toFixed(2)}`,
        `Drawdown: ${(drawdown * 100).toFixed(2)}%`,
        `Open positions: ${state.openPositions.length}`,
        `Total trades: ${state.totalTrades}`,
        `Consecutive losses: ${state.consecutiveLosses}`,
      ].join('\n'),
      timestamp: Date.now(),
    });
  }

  async botStarted(): Promise<void> {
    await this.send({
      level: 'info',
      event: 'bot_started',
      message: 'Bot started successfully',
      timestamp: Date.now(),
    });
  }

  async botStopped(reason: string): Promise<void> {
    await this.send({
      level: 'warning',
      event: 'bot_stopped',
      message: `Bot stopped: ${reason}`,
      timestamp: Date.now(),
    });
  }

  async error(message: string, details?: Record<string, unknown>): Promise<void> {
    await this.send({
      level: 'error',
      event: 'error',
      message: `ERROR: ${message}`,
      details,
      timestamp: Date.now(),
    });
  }

  // ============================================
  // Core Send Logic
  // ============================================

  private async send(alert: BotAlert): Promise<void> {
    // Always log to console
    const prefix = `[${alert.level.toUpperCase()}] [${alert.event}]`;
    console.log(`${prefix} ${alert.message}`);

    if (!this.enabled) return;

    this.queue.push(alert);
    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;

    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const alert = this.queue.shift()!;
        await this.sendTelegram(alert);
        // Rate limit: max 1 msg per second
        await sleep(1000);
      }
    } finally {
      this.sending = false;
    }
  }

  private async sendTelegram(alert: BotAlert): Promise<void> {
    if (!this.botToken || !this.chatId) return;

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: alert.message,
          parse_mode: 'HTML',
        }),
      });

      if (!response.ok) {
        console.error(`Telegram API error: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      console.error('Telegram send failed:', err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
