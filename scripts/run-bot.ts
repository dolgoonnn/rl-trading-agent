#!/usr/bin/env npx tsx
/**
 * Paper Trading Bot — Main Entry Point
 *
 * Runs 24/7, polls Bybit for 1H candle closes, evaluates ICT confluence
 * signals, and manages paper positions with the exact same logic as
 * the backtest system.
 *
 * PM2-compatible: handles SIGTERM/SIGINT for graceful shutdown.
 *
 * Crypto-only: BTC/ETH/SOL with order_block strategy (Run 20 CMA-ES config).
 *
 * Usage:
 *   npx tsx scripts/run-bot.ts                    # Default (BTC/ETH/SOL)
 *   npx tsx scripts/run-bot.ts --symbols BTCUSDT,ETHUSDT  # Custom symbols
 *   npx tsx scripts/run-bot.ts --ltf              # Enable LTF entry timing (5m confirmation)
 *   npx tsx scripts/run-bot.ts --funding-arb      # Enable funding rate arbitrage
 *   npx tsx scripts/run-bot.ts --arb-only         # Arb only (no directional)
 *   npx tsx scripts/run-bot.ts --capital 5000
 *   npx tsx scripts/run-bot.ts --risk 0.003
 *   npx tsx scripts/run-bot.ts --telegram-token BOT_TOKEN --telegram-chat CHAT_ID
 *   npx tsx scripts/run-bot.ts --verbose
 *   npx tsx scripts/run-bot.ts --resume           # Resume from saved state
 */

import {
  DataFeed,
  SignalEngine,
  OrderManager,
  PositionTracker,
  RiskEngine,
  AlertManager,
  FundingArbBot,
  LimitOrderExecutor,
  DEFAULT_BOT_CONFIG,
  RUN20_STRATEGY_CONFIG,
  DEFAULT_RISK_CONFIG,
  DEFAULT_LTF_CONFIG,
  DEFAULT_FUNDING_ARB_CONFIG,
} from '../src/lib/bot';
import { LTFConfirmation } from '../src/lib/bot/ltf-confirmation';
import type { LiveGuardInputs } from '../src/lib/bot/order-manager';
import { computePositionSize } from '../src/lib/bot/guards';
import { shouldSnapshot } from '../src/lib/bot/snapshot';
import { logSkippedSignal, appendDecisionLog } from '../src/lib/bot/decision-log';
import { isKilled, setKillFlag, type KillFlag } from '../src/lib/bot/kill-switch';
import {
  evaluateRetirementHalt,
  resolveEffectiveKill,
} from '../src/lib/bot/retirement';
import { RETIREMENT_CONFIG, SAFETY_GATE_CONFIG, SYMBOL_ALLOCATION } from '../src/lib/bot/config';
import { db } from '../src/lib/data/db';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BotConfig, BotSymbol, BotPosition, LTFConfig } from '../src/types/bot';
import type { Candle } from '../src/types/candle';

// ============================================
// Parse CLI arguments
// ============================================

function parseArgs(): {
  config: BotConfig;
  resume: boolean;
  ltfEnabled: boolean;
  fundingArbEnabled: boolean;
  arbOnly: boolean;
  limitOrdersEnabled: boolean;
} {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_BOT_CONFIG };
  let resume = false;
  let ltfEnabled = false;
  let fundingArbEnabled = false;
  let arbOnly = false;
  let limitOrdersEnabled = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--capital':
        config.initialCapital = parseFloat(args[++i]!);
        break;
      case '--risk':
        config.riskPerTrade = parseFloat(args[++i]!);
        break;
      case '--mode':
        config.mode = args[++i] as BotConfig['mode'];
        break;
      case '--telegram-token':
        config.telegramBotToken = args[++i];
        break;
      case '--telegram-chat':
        config.telegramChatId = args[++i];
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--resume':
        resume = true;
        break;
      case '--symbols': {
        const syms = args[++i]!.split(',') as BotSymbol[];
        config.symbols = syms;
        break;
      }
      case '--poll-delay':
        config.pollDelaySeconds = parseInt(args[++i]!, 10);
        break;
      case '--ltf':
        ltfEnabled = true;
        break;
      case '--funding-arb':
        fundingArbEnabled = true;
        break;
      case '--arb-only':
        arbOnly = true;
        fundingArbEnabled = true;
        break;
      case '--limit-orders':
        limitOrdersEnabled = true;
        break;
    }
  }

  return { config, resume, ltfEnabled, fundingArbEnabled, arbOnly, limitOrdersEnabled };
}

// ============================================
// Main Bot Loop
// ============================================

class TradingBot {
  private dataFeed: DataFeed;
  private signalEngine: SignalEngine;
  private orderManager: OrderManager;
  private tracker: PositionTracker;
  private riskEngine: RiskEngine;
  private alerts: AlertManager;
  private config: BotConfig;
  private running = false;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private dailyResetInterval: ReturnType<typeof setInterval> | null = null;

  // Hourly equity-snapshot checkpoint. We snapshot ONCE per UTC hour (deduped
  // by floor(now/3_600_000)); this stores the last recorded hour bucket so a
  // 30s tick that lands in the same hour does not re-snapshot.
  private lastSnapshotHourBucket: number | null = null;
  // Latest close per symbol, updated each tick — used to mark-to-market the
  // hourly snapshot (realized equity + unrealized PnL of open positions).
  private latestPrices: Partial<Record<BotSymbol, number>> = {};

  // LTF entry timing
  private ltfConfirmation: LTFConfirmation | null = null;
  private ltfConfig: LTFConfig;

  // Funding rate arbitrage
  private fundingArbBot: FundingArbBot | null = null;
  private arbOnly: boolean;

  // Limit order execution
  private limitOrderExecutor: LimitOrderExecutor | null = null;

  // Retirement kill-switch. We read the latched flag (fs sentinel + env + DB row)
  // BEFORE processing any symbol each tick. `killAlerted` dedupes the alert so a
  // sustained halt does not spam Telegram every 30s.
  private killAlerted = false;
  // Heartbeat: latches a stale_feed halt once the feed goes quiet past the
  // configured timeout. Reset only after a fresh feed update + manual review.
  private heartbeatAlerted = false;

  // ---- Automatic retirement halt (Issue 2, Task 5b) ----
  // Sustained-DSR breach counter (Issue B): carried across ticks so k consecutive
  // sub-floor deflated-Sharpe checks escalate to a HARD halt. Reset on any clear.
  private dsrBreachConsecutive = 0;
  // Consecutive charter-p5 path breaches (yellow→red). INERT: declared =0 and
  // never mutated because no charter-p5 cumulative-PnL-vs-path probe is wired yet.
  // The charter legs are therefore gated OFF via RETIREMENT_CONFIG.charterPathHaltEnabled
  // = false (FIX-3) — even this stale 0 (or any nonzero) value can NOT trip the
  // charter RED/YELLOW legs while that flag is false. To activate: wire a probe
  // that increments this when live cumulative PnL drops below the p5 MC path, then
  // flip charterPathHaltEnabled to true.
  private charterBreachConsecutive = 0;
  // De-risk gross-exposure multiplier carried INTO sizing for the current tick
  // when the retirement decision is 'derisk'. 1 = full size. Recomputed each tick.
  private retirementMultiplier = 1;
  // Dedupes the retirement HALT alert/log so a sustained halt does not spam.
  private retirementAlerted = false;
  // NOTE (Issue A / FIX-3): an EDGE-TRIGGERED regime/mechanism cause would be
  // memoed here (last-seen regime tag) so we raise regimeCause only on a FRESH
  // decay transition, never as a sticky level. No regime-decay detector feeds the
  // tick yet, so consumeRegimeCause() returns a hardcoded false and the regime
  // legs are gated OFF via RETIREMENT_CONFIG.regimeHaltEnabled = false — even a
  // stray/stale regimeCause=true can NOT trip a halt or de-risk while that flag is
  // false. The sustained-DSR streak (Issue B) carries the durable-edge-collapse
  // signal. To activate: wire the detector to feed regimeCause, then flip
  // regimeHaltEnabled to true.

  constructor(
    config: BotConfig,
    resume: boolean,
    ltfEnabled: boolean,
    fundingArbEnabled: boolean,
    arbOnly: boolean,
    limitOrdersEnabled = false,
  ) {
    this.config = config;
    this.arbOnly = arbOnly;

    // Initialize components
    this.dataFeed = new DataFeed();
    this.signalEngine = new SignalEngine(RUN20_STRATEGY_CONFIG);
    this.orderManager = new OrderManager(
      config.mode,
      RUN20_STRATEGY_CONFIG,
      // Persist guard rejects to skipped_signals. Non-crashing: logSkippedSignal
      // is wrapped by OrderManager.emitSkip, and we also guard here so a DB
      // hiccup can never break the order path.
      (info) => {
        try {
          logSkippedSignal(db, {
            ts: info.ts,
            symbol: info.symbol,
            reason: info.reason,
            signalEntry: info.signalEntry,
            score: info.score,
            detail: info.detail,
          });
        } catch (err) {
          console.warn('[run-bot] failed to persist skipped_signal:', err);
        }
      },
    );
    this.tracker = new PositionTracker(config.initialCapital);
    this.riskEngine = new RiskEngine({
      ...DEFAULT_RISK_CONFIG,
      maxPositions: config.maxPositions,
    });
    this.alerts = new AlertManager(config.telegramBotToken, config.telegramChatId);

    // LTF entry timing (only for crypto, opt-in)
    this.ltfConfig = { ...DEFAULT_LTF_CONFIG, enabled: ltfEnabled };
    if (ltfEnabled) {
      this.ltfConfirmation = new LTFConfirmation(this.ltfConfig, this.dataFeed);
    }

    // Funding rate arbitrage
    if (fundingArbEnabled) {
      this.fundingArbBot = new FundingArbBot(
        DEFAULT_FUNDING_ARB_CONFIG,
        this.alerts,
        config.verbose,
      );
    }

    // Limit order execution (requires API keys)
    if (limitOrdersEnabled) {
      const apiKey = process.env.BYBIT_API_KEY;
      const apiSecret = process.env.BYBIT_API_SECRET;
      if (apiKey && apiSecret) {
        this.limitOrderExecutor = new LimitOrderExecutor(apiKey, apiSecret, {
          maxWaitBars: 2,
          postOnly: true,
          enabled: true,
        });
        console.log('Limit order execution: ENABLED (maker fills)');
      } else {
        console.warn('--limit-orders requires BYBIT_API_KEY and BYBIT_API_SECRET env vars');
      }
    }

    // Attempt to resume from saved state
    if (resume) {
      const loaded = this.tracker.loadState();
      if (loaded) {
        console.log(`Resumed from saved state: equity=$${this.tracker.getEquity().toFixed(2)}, open=${this.tracker.getOpenPositions().length} positions`);
      } else {
        console.log('No saved state found, starting fresh');
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;

    console.log('='.repeat(60));
    console.log('ICT Paper Trading Bot');
    console.log('='.repeat(60));
    console.log(`Mode: ${this.config.mode}`);
    console.log(`Strategy: order_block (Run 20 CMA-ES)`);
    console.log(`Symbols: ${this.config.symbols.join(', ')}`);
    console.log(`Capital: $${this.config.initialCapital}`);
    console.log(`Risk/trade: ${(this.config.riskPerTrade * 100).toFixed(2)}%`);
    console.log(`Max positions: ${this.config.maxPositions}`);
    console.log(`Poll delay: ${this.config.pollDelaySeconds}s after hour close`);
    if (this.ltfConfirmation) {
      console.log(`LTF entry timing: ENABLED (5m confirmation)`);
    }
    if (this.fundingArbBot) {
      console.log(`Funding arb: ENABLED`);
    }
    if (this.arbOnly) {
      console.log(`Mode: ARB ONLY (no directional trading)`);
    }
    // FIX-3: be HONEST about which retirement halt legs can actually fire. Two
    // legs (regime/mechanism + charter-p5 path) are DISABLED-pending-inputs, so
    // an operator is not misled into thinking 5 protections are live.
    const activeHalts = [
      'absolute-DD hard halt',
      `sustained-DSR streak hard halt (k=${RETIREMENT_CONFIG.dsrBreachK}, n>=${RETIREMENT_CONFIG.minTrackRecordLength})`,
      'soft de-risk band (eMaxDD→hardKillDD, ×0.5)',
    ];
    const disabledHalts = [
      ...(RETIREMENT_CONFIG.regimeHaltEnabled ? [] : ['regime/mechanism (no detector wired)']),
      ...(RETIREMENT_CONFIG.charterPathHaltEnabled ? [] : ['charter-p5 path (no cumulative-PnL probe wired)']),
    ];
    console.log(`Retirement ACTIVE halts: ${activeHalts.join('; ')}`);
    if (disabledHalts.length > 0) {
      console.log(`Retirement DISABLED-pending-inputs: ${disabledHalts.join('; ')}`);
    }
    console.log('='.repeat(60));

    // Start funding arb bot (runs independently)
    if (this.fundingArbBot) {
      await this.fundingArbBot.start();
    }

    // If arb-only, skip directional setup
    if (this.arbOnly) {
      await this.alerts.botStarted();
      console.log('\nArb-only mode. Press Ctrl+C to stop.\n');
      return;
    }

    // Backfill candle history
    console.log('\nBackfilling candle history...');
    for (const symbol of this.config.symbols) {
      const count = await this.dataFeed.backfill(symbol);
      console.log(`  ${symbol}: ${count} candles cached`);
    }

    // Save initial state
    this.tracker.saveState();
    this.tracker.recordSnapshot();

    await this.alerts.botStarted();

    // Main loop: check every 30 seconds
    this.tickInterval = setInterval(() => this.tick(), 30_000);

    // Daily reset at midnight UTC
    this.scheduleDailyReset();

    // Run first tick immediately
    await this.tick();
  }

  async stop(reason = 'shutdown'): Promise<void> {
    this.running = false;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.dailyResetInterval) {
      clearInterval(this.dailyResetInterval);
      this.dailyResetInterval = null;
    }

    // Stop funding arb bot
    if (this.fundingArbBot) {
      await this.fundingArbBot.stop();
    }

    // Cancel pending limit orders
    if (this.limitOrderExecutor) {
      await this.limitOrderExecutor.cancelAll();
    }

    // Close all open positions on shutdown
    const openPositions = this.tracker.getOpenPositions();
    for (const position of openPositions) {
      try {
        const price = await this.dataFeed.getLatestPrice(position.symbol);
        if (price === null) {
          console.error(`No price available to close ${position.symbol} on shutdown`);
          continue;
        }
        const result = this.orderManager.forceClose(position, price, 'shutdown');
        this.tracker.closePosition(result.position);
        await this.alerts.positionClosed(result.position);
      } catch (err) {
        console.error(`Failed to close ${position.symbol} position on shutdown:`, err);
      }
    }

    this.tracker.saveState();
    this.tracker.recordSnapshot();
    await this.alerts.botStopped(reason);
    console.log(`Bot stopped: ${reason}`);
  }

  // ============================================
  // Core Tick Logic
  // ============================================

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      // Cleanup expired circuit breakers
      this.riskEngine.cleanupExpiredBreakers(this.tracker);

      const nowMs = Date.now();

      // 0. Hourly mark-to-market equity snapshot FIRST (deduped by UTC hour
      // bucket) so the retirement evaluation below reads the freshest equity
      // curve (drawdown + rolling deflated Sharpe) before deciding to halt.
      this.recordHourlySnapshot();

      // 0a. LATCHED kill flag — read the out-of-band sources (data/KILL sentinel,
      // env KILL_SWITCH, bot_kill_switch DB row) BEFORE touching any symbol. When
      // halted we skip ALL new-entry processing (reduce-only). Open positions are
      // still managed by manageOpenPosition inside processSymbol, so we DO NOT
      // return early — we pass the kill flag down so only NEW entries are blocked.
      let killFlag = isKilled(db, { nowMs });
      await this.handleKillFlag(killFlag);

      // 0b. AUTOMATIC retirement halt (Issue 2). Compute the confluence decision
      // from REAL inputs; on 'halt' latch the durable DB kill flag (so it blocks
      // entries on THIS tick and every subsequent tick via isKilled→canTrade); on
      // 'derisk' carry the multiplier into this tick's sizing.
      await this.evaluateRetirement(nowMs);
      // Re-read the latched flag in case the retirement halt just tripped it.
      if (!killFlag.halted) {
        killFlag = isKilled(db, { nowMs });
        if (killFlag.halted) await this.handleKillFlag(killFlag);
      }

      // 0c. Heartbeat — a stale feed BLOCKS new entries (Issue 1). The stale gate
      // is TRANSIENT (auto-resumes on feed recovery — see resolveEffectiveKill),
      // so it is NOT persisted via setKillFlag; we fold it into an effectiveKill
      // that is passed down to block entries while the feed is wedged.
      const heartbeat = this.riskEngine.checkHeartbeat({
        nowMs,
        lastFeedUpdate: this.dataFeed.lastFeedUpdate,
        heartbeatTimeoutMs: RETIREMENT_CONFIG.heartbeatTimeoutMs,
      });
      await this.handleHeartbeat(heartbeat);

      // effectiveKill = latched flag if halted, else a transient heartbeat gate
      // when the feed is stale. Entries are blocked under either; open-position
      // management still runs (reduce-only).
      const effectiveKill = resolveEffectiveKill(killFlag, heartbeat);

      for (const symbol of this.config.symbols) {
        await this.processSymbol(symbol, effectiveKill);
      }
    } catch (err) {
      console.error('Tick error:', err);
      this.tracker.recordError();
      await this.alerts.error(`Tick failed: ${(err as Error).message}`);

      // Check system error circuit breaker
      const triggered = this.riskEngine.evaluateAfterTrade(this.tracker);
      for (const cb of triggered) {
        if (cb.type === 'system_errors') {
          await this.alerts.circuitBreakerTriggered(cb.type, cb.reason);
        }
      }
    }
  }

  /**
   * Record an equity snapshot at most once per UTC hour.
   *
   * The tick fires every 30s but snapshots are HOURLY — deduped by
   * floor(now/3_600_000). Equity is MARK-TO-MARKET: realized equity plus the
   * unrealized PnL of every open position valued at the latest candle close.
   * This is what makes the equity curve dense enough for getRollingSharpe to
   * annualize correctly (one snapshot per hour, not 2 lifetime rows).
   */
  private recordHourlySnapshot(): void {
    const nowMs = Date.now();
    const decision = shouldSnapshot(this.lastSnapshotHourBucket, nowMs);
    if (!decision.snapshot) return;
    this.lastSnapshotHourBucket = decision.bucket;
    this.tracker.recordSnapshot(this.latestPrices, nowMs);
  }

  /**
   * Latched kill-flag handler. On a fresh trip, append an immutable decision_log
   * row + fire one critical alert. Deduped so a sustained halt does not spam.
   */
  private async handleKillFlag(killFlag: KillFlag): Promise<void> {
    if (killFlag.halted) {
      if (!this.killAlerted) {
        this.killAlerted = true;
        try {
          appendDecisionLog(db, {
            type: 'halt',
            detail: {
              kind: 'kill_switch',
              source: killFlag.source,
              reason: killFlag.reason,
            },
          });
        } catch (err) {
          console.warn('[run-bot] failed to append kill-switch decision_log:', err);
        }
        await this.alerts.circuitBreakerTriggered(
          'kill_switch',
          `KILL SWITCH active (${killFlag.source ?? 'unknown'}): ${killFlag.reason ?? 'manual review required'} — reduce-only (new entries blocked)`,
        );
      }
    } else {
      // Manual reset detected (flag cleared) — log the resume once.
      if (this.killAlerted) {
        this.killAlerted = false;
        try {
          appendDecisionLog(db, { type: 'resume', detail: { kind: 'kill_switch' } });
        } catch (err) {
          console.warn('[run-bot] failed to append kill-switch resume decision_log:', err);
        }
      }
    }
  }

  /**
   * Automatic retirement halt evaluation (Issue 2, Task 5b).
   *
   * Gathers REAL inputs each tick — drawdown from peak, the SCALE-CONSISTENT
   * per-observation deflated Sharpe (Issue D), the snapshot/observation count,
   * the charter-path breach count, and an EDGE-TRIGGERED regime cause (Issue A) —
   * runs the pure confluence decision, then ACTS:
   *   - 'halt'   → setKillFlag(source:'retirement') durable latch + decision_log +
   *                one deduped critical alert. The latch then blocks entries via
   *                isKilled→canTrade on this and every subsequent tick.
   *   - 'derisk' → carry decision.multiplier into this tick's sizing.
   *   - 'trade'  → full size; clears the de-risk and resets the alert dedupe.
   */
  private async evaluateRetirement(nowMs: number): Promise<void> {
    const trialCount = 236; // independent trials counted in DSR validation (MEMORY.md)

    // Scale-consistent per-observation deflated Sharpe + observation count (Issue D).
    const obs = this.tracker.getRollingDeflatedSharpeObs(trialCount);
    const deflatedSharpe = obs?.deflatedSharpe ?? null;
    const snapshotCount = obs?.n ?? 0;

    const result = evaluateRetirementHalt({
      nowMs,
      drawdown: this.tracker.getDrawdown(),
      deflatedSharpe,
      snapshotCount,
      regimeCause: this.consumeRegimeCause(),
      charterBreachConsecutive: this.charterBreachConsecutive,
      dsrBreachConsecutive: this.dsrBreachConsecutive,
      config: RETIREMENT_CONFIG,
    });

    // Persist the advanced sustained-DSR counter for the next tick.
    this.dsrBreachConsecutive = result.dsrBreachConsecutive;

    if (result.decision.action === 'halt') {
      // Latch the durable DB kill flag — blocks entries here AND on every future
      // tick (reduce-only). Idempotent: setKillFlag writes the singleton row id=1.
      setKillFlag(db, {
        halted: true,
        source: 'retirement',
        reason: result.decision.cause,
        nowMs,
      });
      this.retirementMultiplier = 0;
      if (!this.retirementAlerted) {
        this.retirementAlerted = true;
        try {
          appendDecisionLog(db, {
            type: 'halt',
            detail: {
              kind: 'retirement',
              cause: result.decision.cause,
              drawdown: this.tracker.getDrawdown(),
              hardKillDD: result.hardKillDD,
              deflatedSharpe,
              snapshotCount,
            },
            nowMs,
          });
        } catch (err) {
          console.warn('[run-bot] failed to append retirement halt decision_log:', err);
        }
        await this.alerts.circuitBreakerTriggered(
          'retirement',
          `RETIREMENT HALT: ${result.decision.cause} — reduce-only (new entries blocked, manual review required)`,
        );
      }
      return;
    }

    // Not a hard halt — clear the alert dedupe so a future trip re-alerts.
    this.retirementAlerted = false;

    if (result.decision.action === 'derisk') {
      this.retirementMultiplier = result.decision.multiplier; // 0.5
      if (this.config.verbose) {
        console.log(`  RETIREMENT DE-RISK: ${result.decision.cause} → sizing × ${result.decision.multiplier}`);
      }
    } else {
      this.retirementMultiplier = 1;
    }
  }

  /**
   * EDGE-TRIGGERED regime/mechanism cause (Issue A).
   *
   * Returns true ONLY on the tick where a FRESH regime-decay transition is newly
   * detected (a suppressed/downtrend regime appearing where the prior regime was
   * different), never as a sticky level. Today the bot has no standalone regime
   * decay detector wired into the tick, so this is a conservative one-shot edge
   * derived from the last-seen regime tag; it defaults to false so a healthy book
   * is never pinned at 0.5× by a latched level.
   *
   * TODO (Issue A follow-up): replace `lastRegimeSeen` heuristic with the regime
   * decay detector's fresh-transition event once that probe (Task 7) lands.
   */
  private consumeRegimeCause(): boolean {
    // No regime-decay detector feeds the tick yet → no edge to raise. Returning
    // false here keeps the contract (edge-triggered, not latched) honest: we do
    // not invent a cause, and the sustained-DSR escalation (Issue B) is what
    // carries a durable-edge-collapse signal across ticks.
    return false;
  }

  /** Stale-feed heartbeat handler — alert + decision_log once per stale episode. */
  private async handleHeartbeat(heartbeat: { stale: boolean; reason: string }): Promise<void> {
    if (heartbeat.stale && !this.heartbeatAlerted) {
      this.heartbeatAlerted = true;
      try {
        appendDecisionLog(db, {
          type: 'halt',
          detail: { kind: 'stale_feed', reason: heartbeat.reason },
        });
      } catch (err) {
        console.warn('[run-bot] failed to append stale_feed decision_log:', err);
      }
      await this.alerts.circuitBreakerTriggered('stale_feed', heartbeat.reason);
    } else if (!heartbeat.stale && this.heartbeatAlerted) {
      this.heartbeatAlerted = false;
    }
  }

  /**
   * Fetch the LIVE pre-trade guard inputs (mark price + L2 orderbook) at
   * INTENDED-ENTRY time — called only right before an entry would open, never
   * every tick, so the tickers/orderbook endpoints aren't hammered (both feeds
   * are 5s-cached in DataFeed regardless).
   *
   * FAIL SAFE: if either fetch throws or returns a bad value we log + return
   * `null`, and the caller SKIPS the entry rather than entering blind. The
   * built signal candle is the latest closed candle (the same bar that produced
   * the signal), and `nowMs` is injected so the guard is deterministic.
   */
  private async fetchLiveGuardInputs(
    symbol: BotSymbol,
    signalCandle: Candle,
    nowMs: number,
  ): Promise<LiveGuardInputs | null> {
    try {
      const markPrice = await this.dataFeed.getMarkPrice(symbol, nowMs);
      const orderbook = await this.dataFeed.getOrderbook(symbol, nowMs);
      if (!Number.isFinite(markPrice) || markPrice <= 0 || !orderbook) {
        console.warn(
          `[run-bot] ${symbol}: invalid mark/orderbook — skipping entry (mark=${markPrice})`,
        );
        return null;
      }
      return {
        orderbook,
        markGuard: {
          markPrice,
          candleHigh: signalCandle.high,
          candleLow: signalCandle.low,
          candleClose: signalCandle.close,
          candleCloseMs: signalCandle.timestamp,
          nowMs,
        },
      };
    } catch (err) {
      console.warn(
        `[run-bot] ${symbol}: mark/orderbook fetch failed — skipping entry (fail-safe):`,
        err,
      );
      return null;
    }
  }

  /** Latest cached candle for a symbol, or null if the cache is empty. */
  private async latestCachedCandle(symbol: BotSymbol): Promise<Candle | null> {
    const cached = await this.dataFeed.getCachedCandles(symbol);
    return cached.length > 0 ? cached[cached.length - 1]! : null;
  }

  private async processSymbol(symbol: BotSymbol, killFlag?: KillFlag): Promise<void> {
    // Process pending limit orders first
    if (this.limitOrderExecutor?.hasPendingOrder(symbol)) {
      await this.processLimitOrder(symbol);
      return;
    }

    // Process pending LTF setups first (polls 5m candles independently)
    if (this.ltfConfirmation && this.ltfConfirmation.hasPendingSetup(symbol)) {
      await this.processLTFSetup(symbol);
      return;
    }

    // Check for new candle
    const { allCandles, latestCandle, isNew } = await this.dataFeed.processNewCandle(symbol);

    if (!latestCandle || !isNew) return;

    // Record latest close for mark-to-market hourly snapshots.
    this.latestPrices[symbol] = latestCandle.close;

    // Skip if already processed
    const lastProcessed = this.tracker.getLastProcessedTimestamp(symbol);
    if (latestCandle.timestamp <= lastProcessed) return;

    if (this.config.verbose) {
      console.log(`[${new Date().toISOString()}] ${symbol}: new candle at ${new Date(latestCandle.timestamp).toISOString()}, close=$${latestCandle.close}`);
    }

    // Mark as processed
    this.tracker.setLastProcessedTimestamp(symbol, latestCandle.timestamp);

    // 1. Check existing open position for this symbol
    const openPos = this.tracker.getOpenPosition(symbol);
    if (openPos) {
      // Use candle array length - 1 as currentBarIndex (matches backtest index)
      await this.manageOpenPosition(openPos, latestCandle, allCandles.length - 1);
      return; // Don't open new position while one is open for this symbol
    }

    // 2. Check if trading is allowed (kill flag FIRST, then circuit breakers).
    // Reduce-only: this gate blocks NEW entries; the open-position management
    // above (manageOpenPosition) already ran, so existing positions still exit.
    const blocker = this.riskEngine.canTrade(this.tracker, { nowMs: Date.now(), killFlag });
    if (blocker) {
      if (this.config.verbose) {
        console.log(`  ${symbol}: trading blocked — ${blocker.reason}`);
      }
      return;
    }

    if (!this.riskEngine.canTradeSymbol(this.tracker, symbol)) return;

    // 2b. Per-symbol entry cap (independent of strategy cooldownBars). Caps NEW
    // entries to maxEntriesPerDay per symbol over a rolling 24h window; this
    // pauses ONE symbol, never the whole book.
    const nowMs = Date.now();
    const entriesInWindow = this.tracker.getEntriesInWindow(symbol, 24 * 3_600_000, nowMs);
    const capCheck = this.riskEngine.perSymbolEntryCap({
      symbol,
      entriesInWindow,
      maxEntriesPerDay: RETIREMENT_CONFIG.maxEntriesPerDay,
    });
    if (!capCheck.ok) {
      if (this.config.verbose) console.log(`  ${symbol}: ${capCheck.reason}`);
      try {
        logSkippedSignal(db, { ts: nowMs, symbol, reason: 'per_symbol_entry_cap', detail: { entriesInWindow } });
      } catch (err) {
        console.warn('[run-bot] failed to persist per_symbol_entry_cap skip:', err);
      }
      return;
    }

    // 2c. Per-symbol consecutive-loss pause (Issue 4). Pauses ONE symbol after
    // maxConsecutiveLossesPerSymbol losing trades in a row on THAT symbol —
    // independent of the global circuit breaker, so the rest of the book trades.
    const symConsecLosses = this.tracker.getSymbolConsecutiveLosses(symbol);
    if (this.riskEngine.isSymbolPaused({
      consecutiveLosses: symConsecLosses,
      maxConsecutiveLossesPerSymbol: RETIREMENT_CONFIG.maxConsecutiveLossesPerSymbol,
    })) {
      if (this.config.verbose) {
        console.log(`  ${symbol}: paused — ${symConsecLosses} consecutive losses (cap ${RETIREMENT_CONFIG.maxConsecutiveLossesPerSymbol})`);
      }
      try {
        logSkippedSignal(db, { ts: nowMs, symbol, reason: 'per_symbol_loss_pause', detail: { consecutiveLosses: symConsecLosses } });
      } catch (err) {
        console.warn('[run-bot] failed to persist per_symbol_loss_pause skip:', err);
      }
      return;
    }

    // 3. Evaluate signal (SignalEngine auto-routes to correct strategy per symbol)
    const result = this.signalEngine.evaluate(allCandles, symbol);

    if (!result.hasSignal || !result.signal) {
      if (this.config.verbose) {
        console.log(`  ${symbol}: no signal (${result.reasoning[result.reasoning.length - 1] ?? 'waiting'})`);
      }
      return;
    }

    // 4. LTF entry timing — if enabled, create LTF setup instead of immediate entry
    if (this.ltfConfirmation) {
      this.ltfConfirmation.createSetup(symbol, result.signal, allCandles);
      console.log(`  ${symbol}: LTF setup created — waiting for 5m confirmation`);

      await this.alerts.send({
        level: 'info',
        event: 'ltf_setup_created',
        message: [
          `LTF Setup: ${symbol} ${result.signal.signal.direction.toUpperCase()}`,
          `Score: ${result.signal.totalScore.toFixed(2)}`,
          `Waiting for 5m zone entry + MSS confirmation`,
        ].join('\n'),
        timestamp: Date.now(),
      });
      return;
    }

    // 5. Apply risk-adjusted position sizing (drawdown tiers + regime + Sharpe)
    const { multiplier, breakdown } = this.riskEngine.getPositionSizeMultiplier(
      this.tracker,
      result.regime,
    );

    if (multiplier === 0) {
      if (this.config.verbose) {
        console.log(`  ${symbol}: signal detected but sizing multiplier is 0 (dd=${breakdown.drawdown}, regime=${breakdown.regime}, sharpe=${breakdown.sharpe})`);
      }
      return;
    }

    // 5b. Correlation-aware exposure scaling
    const openSymbols = this.tracker.getOpenPositions().map((p) => p.symbol);
    const candlesBySymbol = new Map<BotSymbol, Candle[]>();
    candlesBySymbol.set(symbol, allCandles);
    for (const openSym of openSymbols) {
      const cached = await this.dataFeed.getCachedCandles(openSym);
      candlesBySymbol.set(openSym, cached);
    }
    const corrMultiplier = this.riskEngine.getCorrelationMultiplier(
      openSymbols, symbol, candlesBySymbol,
    );

    // Apply quarter-Kelly if enough trade history, otherwise use base risk.
    // The retirement de-risk multiplier (Issue 2) is folded in here so a 'derisk'
    // decision halves gross exposure for this tick (1.0 when trading normally,
    // 0 is impossible to reach here because a halt latches the kill flag and
    // canTrade above already blocked the entry).
    const baseRisk = this.riskEngine.getKellyAdjustedRisk(this.tracker, this.config.riskPerTrade);
    const adjustedRisk = baseRisk * multiplier * corrMultiplier * this.retirementMultiplier;

    // 6. Open position (limit order or immediate paper fill)
    if (this.limitOrderExecutor?.isEnabled) {
      // Place a post-only limit order at candle close price
      const entryPrice = result.signal.signal.entryPrice;
      const riskDistance = result.signal.signal.direction === 'long'
        ? entryPrice - result.signal.signal.stopLoss
        : result.signal.signal.stopLoss - entryPrice;
      if (riskDistance <= 0) return;

      // Route the placed qty through the SAME safety sizing as openPosition so
      // the limit order is itself notional-capped + stop-floored (no unbounded
      // qty = riskAmount/riskDistance). Hard-reject (max_notional) → skip + log.
      const symbolAlloc = SYMBOL_ALLOCATION[symbol] ?? 0.33;
      const sizing = computePositionSize({
        equity: this.tracker.getEquity(),
        riskPerTrade: adjustedRisk,
        symbolAlloc,
        riskDistance,
        entryPrice,
        maxNotionalPctEquity: SAFETY_GATE_CONFIG.maxNotionalPctEquity,
        minStopPct: SAFETY_GATE_CONFIG.minStopPct,
      });
      if (!sizing.ok) {
        console.warn(`  ${symbol}: LIMIT ORDER rejected — ${sizing.reason}`);
        try {
          logSkippedSignal(db, {
            ts: nowMs,
            symbol,
            reason: sizing.reason,
            signalEntry: entryPrice,
            score: result.signal.totalScore,
            regime: result.regime,
            detail: { path: 'limitOrder', riskDistance },
          });
        } catch (err) {
          console.warn('[run-bot] failed to persist limit-order sizing skip:', err);
        }
        return;
      }
      const qty = sizing.size.toFixed(4);

      const pending = await this.limitOrderExecutor.placeOrder(
        result.signal, symbol, qty, entryPrice,
        result.regime, allCandles.length - 1, adjustedRisk,
      );

      if (pending) {
        console.log(`  ${symbol}: LIMIT ORDER placed — ${result.signal.signal.direction.toUpperCase()} @ $${entryPrice.toFixed(2)} (waiting for fill)`);
      }
      return;
    }

    // Fetch LIVE guard inputs (mark + L2 book) AT intended-entry time. Fail-safe:
    // on fetch failure we skip the entry rather than enter blind.
    const liveGuards = await this.fetchLiveGuardInputs(symbol, latestCandle, nowMs);
    if (!liveGuards) {
      if (this.config.verbose) {
        console.log(`  ${symbol}: skipped entry — could not fetch mark/orderbook`);
      }
      return;
    }

    // Immediate fill — pre-trade guards (mark collar + stale/crossed candle) and
    // the L2 tradeability gate run inside openPosition with these live inputs.
    const position = this.orderManager.openPosition(
      result.signal,
      symbol,
      this.tracker.getEquity(),
      adjustedRisk,
      allCandles.length - 1,
      liveGuards,
    );

    if (!position) {
      // Null here may be a guard reject (already logged to skipped_signals) or a
      // sizing failure — either way, do not open.
      console.log(`  ${symbol}: signal detected but position not opened (guard/sizing reject)`);
      return;
    }

    // Set regime on position
    position.regime = result.regime;

    // Track and alert
    this.tracker.addPosition(position);
    // Record the entry for the rolling per-symbol entry cap.
    this.tracker.recordEntry(symbol, position.entryTimestamp);
    await this.alerts.signalDetected(
      symbol,
      result.signal.totalScore,
      result.signal.signal.direction,
      result.signal.signal.strategy,
      result.regime,
    );
    await this.alerts.positionOpened(position);

    const totalMult = multiplier * corrMultiplier;
    const sizeInfo = totalMult < 1.0 ? ` [size: ${(totalMult * 100).toFixed(0)}%]` : '';
    console.log(`  ${symbol}: OPENED ${position.direction.toUpperCase()} @ $${position.entryPrice.toFixed(2)} (score: ${position.confluenceScore.toFixed(2)}, regime: ${position.regime}, strategy: ${position.strategy})${sizeInfo}`);
  }

  /**
   * Process a pending LTF setup — polls 5m candles and checks for confirmation.
   */
  private async processLTFSetup(symbol: BotSymbol): Promise<void> {
    if (!this.ltfConfirmation) return;

    const result = await this.ltfConfirmation.processSetup(symbol);
    if (!result) return;

    if (result.status === 'confirmed') {
      // Fetch LIVE guard inputs at intended-entry time (fail-safe → skip entry).
      const nowMs = Date.now();
      const ltfCandle = await this.latestCachedCandle(symbol);
      if (!ltfCandle) {
        console.log(`  ${symbol}: LTF confirmed but no cached candle — skipped`);
        return;
      }
      const liveGuards = await this.fetchLiveGuardInputs(symbol, ltfCandle, nowMs);
      if (!liveGuards) {
        console.log(`  ${symbol}: LTF confirmed but could not fetch mark/orderbook — skipped`);
        return;
      }

      // Open position with LTF-tightened entry/SL — pre-trade + L2 guards run
      // inside openLTFPosition with these live inputs.
      const position = this.orderManager.openLTFPosition(
        result.signal,
        symbol,
        this.tracker.getEquity(),
        this.config.riskPerTrade,
        0, // barIndex not meaningful for LTF
        result.ltfEntry,
        result.ltfStopLoss,
        liveGuards,
      );

      if (position) {
        // Set LTF metadata
        position.ltfConfirmed = true;
        position.ltfEntryDelay = result.barsWaited;
        position.originalHTFEntry = result.signal.signal.entryPrice;
        position.originalHTFStopLoss = result.signal.signal.stopLoss;
        position.regime = '';

        this.tracker.addPosition(position);
        await this.alerts.positionOpened(position);
        await this.alerts.send({
          level: 'info',
          event: 'ltf_confirmed',
          message: [
            `LTF Confirmed: ${symbol} ${position.direction.toUpperCase()}`,
            `Entry: $${position.entryPrice.toFixed(2)} (1H was $${result.signal.signal.entryPrice.toFixed(2)})`,
            `SL: $${position.stopLoss.toFixed(2)} (1H was $${result.signal.signal.stopLoss.toFixed(2)})`,
            `Waited: ${result.barsWaited} bars (5m)`,
          ].join('\n'),
          timestamp: Date.now(),
        });

        console.log(`  ${symbol}: LTF CONFIRMED — OPENED ${position.direction.toUpperCase()} @ $${position.entryPrice.toFixed(2)} (5m SL: $${position.stopLoss.toFixed(2)})`);
      }
    } else if (result.status === 'expired') {
      if (this.ltfConfig.onTimeout === 'fallback') {
        // Fall back to 1H entry — fetch LIVE guard inputs (fail-safe → skip).
        const nowMs = Date.now();
        const fbCandle = await this.latestCachedCandle(symbol);
        if (!fbCandle) {
          console.log(`  ${symbol}: LTF fallback but no cached candle — skipped`);
          return;
        }
        const liveGuards = await this.fetchLiveGuardInputs(symbol, fbCandle, nowMs);
        if (!liveGuards) {
          console.log(`  ${symbol}: LTF fallback but could not fetch mark/orderbook — skipped`);
          return;
        }
        const position = this.orderManager.openPosition(
          result.signal,
          symbol,
          this.tracker.getEquity(),
          this.config.riskPerTrade,
          0,
          liveGuards,
        );
        if (position) {
          this.tracker.addPosition(position);
          await this.alerts.positionOpened(position);
          console.log(`  ${symbol}: LTF expired — FALLBACK to 1H entry @ $${position.entryPrice.toFixed(2)}`);
        }
      } else {
        console.log(`  ${symbol}: LTF expired — skipped`);
      }

      await this.alerts.send({
        level: 'info',
        event: 'ltf_expired',
        message: `LTF Expired: ${symbol} — ${this.ltfConfig.onTimeout === 'fallback' ? 'fell back to 1H entry' : 'skipped'}`,
        timestamp: Date.now(),
      });
    }
  }

  private async manageOpenPosition(
    position: BotPosition,
    candle: { timestamp: number; open: number; high: number; low: number; close: number; volume: number },
    currentBarIndex: number,
  ): Promise<void> {
    const wasPT = position.partialTaken;

    const exitResult = this.orderManager.checkPositionExit(position, candle, currentBarIndex);

    // Check if partial TP was taken (position still open but state changed)
    if (!wasPT && position.partialTaken) {
      this.tracker.updatePosition(position);
      await this.alerts.partialTPTaken(position, position.partialPnlPercent);
      console.log(`  ${position.symbol}: Partial TP taken, SL moved to $${position.currentSL.toFixed(2)}`);
    }

    if (!exitResult) return; // Still open

    // Position closed
    const closedPos = exitResult.position;
    this.tracker.closePosition(closedPos);
    await this.alerts.positionClosed(closedPos);

    const pnlStr = (closedPos.pnlUSDT ?? 0) >= 0 ? '+' : '';
    console.log(`  ${closedPos.symbol}: CLOSED ${closedPos.direction.toUpperCase()} — ${closedPos.exitReason} — PnL: ${pnlStr}$${(closedPos.pnlUSDT ?? 0).toFixed(2)} (${pnlStr}${((closedPos.pnlPercent ?? 0) * 100).toFixed(2)}%)`);

    // Evaluate circuit breakers after trade
    const triggered = this.riskEngine.evaluateAfterTrade(this.tracker);
    for (const cb of triggered) {
      await this.alerts.circuitBreakerTriggered(cb.type, cb.reason);
      console.log(`  CIRCUIT BREAKER: ${cb.type} — ${cb.reason}`);
    }

    // Log rolling performance after each trade
    if (this.config.verbose) {
      const sharpe = this.tracker.getRollingSharpe();
      const kelly = this.tracker.getKellyRisk();
      const ddTier = this.riskEngine.getDrawdownTier(this.tracker.getDrawdown());
      const parts: string[] = [];
      if (sharpe !== null) parts.push(`Sharpe: ${sharpe.toFixed(2)}`);
      if (kelly !== null) parts.push(`Kelly: ${(kelly * 100).toFixed(2)}%`);
      parts.push(`DD tier: ${ddTier.label} (${(ddTier.sizeMultiplier * 100).toFixed(0)}%)`);
      console.log(`  Performance: ${parts.join(', ')}`);
    }

    // Save state after trade close
    this.tracker.saveState();
    this.tracker.recordSnapshot();
  }

  // ============================================
  // Limit Order Processing
  // ============================================

  /**
   * Check status of a pending limit order and create position if filled.
   */
  private async processLimitOrder(symbol: BotSymbol): Promise<void> {
    if (!this.limitOrderExecutor) return;

    const { allCandles } = await this.dataFeed.processNewCandle(symbol);
    const currentBarIndex = allCandles.length - 1;

    const result = await this.limitOrderExecutor.checkOrder(symbol, currentBarIndex);

    if (result.status === 'filled' && result.fillPrice) {
      // Fetch LIVE guard inputs at fill time (fail-safe → skip opening the
      // position; the maker order already filled so we log loudly).
      const nowMs = Date.now();
      const fillCandle = allCandles.length > 0 ? allCandles[allCandles.length - 1]! : null;
      if (!fillCandle) {
        console.warn(`  ${symbol}: LIMIT FILLED but no candle to guard — position NOT tracked`);
        return;
      }
      const liveGuards = await this.fetchLiveGuardInputs(symbol, fillCandle, nowMs);
      if (!liveGuards) {
        console.warn(`  ${symbol}: LIMIT FILLED but mark/orderbook unavailable — position NOT tracked`);
        return;
      }

      // Create position from the filled order — pre-trade + L2 guards run inside.
      const position = this.orderManager.openPosition(
        result.order.signal,
        symbol,
        this.tracker.getEquity(),
        result.order.riskPerTrade,
        currentBarIndex,
        liveGuards,
      );

      if (position) {
        position.regime = result.order.regime;
        this.tracker.addPosition(position);
        await this.alerts.positionOpened(position);
        console.log(`  ${symbol}: LIMIT FILLED — ${position.direction.toUpperCase()} @ $${result.fillPrice.toFixed(2)} (maker)`);
      }
    } else if (result.status === 'expired') {
      console.log(`  ${symbol}: LIMIT EXPIRED — order cancelled (not filled in ${2} bars)`);
    }
    // 'pending' — still waiting, do nothing
  }

  // ============================================
  // Performance Monitoring
  // ============================================

  /**
   * Check rolling Sharpe ratio and alert if below thresholds.
   * Called daily at midnight UTC.
   */
  private async checkRollingSharpe(): Promise<void> {
    const sharpe = this.tracker.getRollingSharpe();
    if (sharpe === null) return; // Not enough data

    const kelly = this.tracker.getKellyRisk();
    const kellyStr = kelly !== null ? `, Kelly risk: ${(kelly * 100).toFixed(2)}%` : '';

    if (sharpe < 0) {
      await this.alerts.send({
        level: 'critical',
        event: 'circuit_breaker_triggered',
        message: `Rolling 30d Sharpe is NEGATIVE (${sharpe.toFixed(2)}) — new entries halted${kellyStr}`,
        timestamp: Date.now(),
      });
      console.log(`  SHARPE ALERT: Rolling 30d Sharpe ${sharpe.toFixed(2)} < 0 — entries halted`);
    } else if (sharpe < 0.5) {
      await this.alerts.send({
        level: 'warning',
        event: 'circuit_breaker_triggered',
        message: `Rolling 30d Sharpe is LOW (${sharpe.toFixed(2)}) — position sizing reduced 50%${kellyStr}`,
        timestamp: Date.now(),
      });
      console.log(`  SHARPE WARNING: Rolling 30d Sharpe ${sharpe.toFixed(2)} < 0.5 — sizing reduced`);
    } else if (this.config.verbose) {
      console.log(`  Rolling 30d Sharpe: ${sharpe.toFixed(2)}${kellyStr}`);
    }
  }

  // ============================================
  // Scheduling
  // ============================================

  private scheduleDailyReset(): void {
    // Check every hour if we need to reset daily/weekly PnL
    this.dailyResetInterval = setInterval(() => {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcDay = now.getUTCDay();

      // Reset daily PnL at midnight UTC
      if (utcHour === 0) {
        this.tracker.resetDailyPnl();

        // Send daily summary
        this.alerts.dailySummary(this.tracker).catch(console.error);

        // Reset weekly PnL on Monday
        if (utcDay === 1) {
          this.tracker.resetWeeklyPnl();
        }

        // Rolling Sharpe check (daily)
        this.checkRollingSharpe().catch(console.error);
      }
    }, HOUR_MS);
  }
}

const HOUR_MS = 3_600_000;

// ============================================
// Entry Point
// ============================================

async function main(): Promise<void> {
  // Migrate-on-startup: apply any pending migrations before the loop runs so
  // it never trades against a stale schema. The dev DB already records
  // migrations 0000–0004, so this is a clean no-op there; on a fresh DB it
  // creates every table. Relies on a non-empty __drizzle_migrations table.
  migrate(db, { migrationsFolder: './drizzle' });

  const { config, resume, ltfEnabled, fundingArbEnabled, arbOnly, limitOrdersEnabled } = parseArgs();
  const bot = new TradingBot(config, resume, ltfEnabled, fundingArbEnabled, arbOnly, limitOrdersEnabled);

  // Graceful shutdown handlers (PM2 compatible)
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    await bot.stop(signal);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await bot.start();

  // Keep process alive
  console.log('\nBot running. Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
