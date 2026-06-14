import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/data/schema';
import { OrderManager } from '@/lib/bot/order-manager';
import { RUN20_STRATEGY_CONFIG } from '@/lib/bot/config';
import { markToMarketEquity, unrealizedPnlUsdt } from '@/lib/bot/snapshot';
import { makeLongSignal } from '@/lib/bot/__fixtures__/candles';
import type { BotPosition, BotSymbol } from '@/types/bot';
import type { Candle } from '@/types/candle';
import type { ScoredSignal } from '@/lib/rl/strategies/confluence-scorer';

const BASE_MS = 1_704_067_200_000;
const SYMBOL: BotSymbol = 'BTCUSDT';

function candle(ts: number, o: number, h: number, l: number, c: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 1_000 };
}

describe('forward loop — open → exit → trade record → mark-to-market', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a position from a one-signal fixture', () => {
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG);
    const signal = makeLongSignal({ entryPrice: 100, stopLoss: 98, takeProfit: 106 });

    const position = om.openPosition(
      signal as unknown as ScoredSignal,
      SYMBOL,
      10_000,
      0.003,
      200,
    );

    expect(position).not.toBeNull();
    expect(position!.direction).toBe('long');
    expect(position!.symbol).toBe(SYMBOL);
    expect(position!.status).toBe('open');
    expect(position!.positionSizeUSDT).toBeGreaterThan(0);
  });

  it('exit hit → returns a closed position with pnlUSDT', () => {
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG);
    const signal = makeLongSignal({ entryPrice: 100, stopLoss: 98, takeProfit: 106 });
    const position = om.openPosition(signal as unknown as ScoredSignal, SYMBOL, 10_000, 0.003, 200)!;

    // TP candle: high reaches takeProfit (106).
    const tpBar = candle(BASE_MS + 3_600_000, 100, 107, 99.5, 106);
    const exit = om.checkPositionExit(position, tpBar, 201);

    expect(exit).not.toBeNull();
    expect(exit!.exitReason).toBe('take_profit');
    expect(exit!.position.status).toBe('closed');
    expect(exit!.position.pnlUSDT).toBeDefined();
    expect(exit!.position.pnlUSDT!).toBeGreaterThan(0); // long TP is a win
  });

  it('persists a bot_trades row with pnlUSDT after close (in-memory DB)', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './drizzle' });

    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG);
    const signal = makeLongSignal({ entryPrice: 100, stopLoss: 98, takeProfit: 106 });
    const opened = om.openPosition(signal as unknown as ScoredSignal, SYMBOL, 10_000, 0.003, 200)!;
    const tpBar = candle(BASE_MS + 3_600_000, 100, 107, 99.5, 106);
    const closed = om.checkPositionExit(opened, tpBar, 201)!.position;

    const equityAfter = 10_000 + (closed.pnlUSDT ?? 0);
    db.insert(schema.botTrades)
      .values({
        id: closed.id,
        symbol: closed.symbol,
        direction: closed.direction,
        entryPrice: closed.entryPrice,
        exitPrice: closed.exitPrice!,
        entryTimestamp: closed.entryTimestamp,
        exitTimestamp: closed.exitTimestamp!,
        stopLoss: closed.stopLoss,
        takeProfit: closed.takeProfit,
        positionSizeUSDT: closed.positionSizeUSDT,
        riskAmountUSDT: closed.riskAmountUSDT,
        strategy: closed.strategy,
        confluenceScore: closed.confluenceScore,
        factorBreakdown: JSON.stringify(closed.factorBreakdown),
        regime: closed.regime || 'uptrend+normal',
        exitReason: closed.exitReason!,
        barsHeld: closed.barsHeld!,
        pnlPercent: closed.pnlPercent!,
        pnlUSDT: closed.pnlUSDT!,
        equityAfter,
        drawdownFromPeak: 0,
        createdAt: Date.now(),
      })
      .run();

    const row = db.select().from(schema.botTrades).where(eq(schema.botTrades.id, closed.id)).get();
    expect(row).toBeDefined();
    expect(row!.pnlUSDT).toBeGreaterThan(0);
    expect(row!.equityAfter).toBeCloseTo(equityAfter);
  });

  it('mark-to-market: one open long + adverse candle ⇒ equity below flat realized', () => {
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG);
    const signal = makeLongSignal({ entryPrice: 100, stopLoss: 98, takeProfit: 106 });
    const position = om.openPosition(signal as unknown as ScoredSignal, SYMBOL, 10_000, 0.003, 200)!;

    const realizedEquity = 10_000;
    const adverseClose = 99; // below entry → unrealized loss for a long

    const mtm = markToMarketEquity(realizedEquity, [position], { [SYMBOL]: adverseClose });

    expect(mtm).toBeLessThan(realizedEquity);
    // Equality of components: realized + unrealized.
    const unreal = unrealizedPnlUsdt(position, adverseClose);
    expect(unreal).toBeLessThan(0);
    expect(mtm).toBeCloseTo(realizedEquity + unreal);
  });

  it('mark-to-market: no open positions ⇒ equals realized equity', () => {
    const mtm = markToMarketEquity(12_345, [], {});
    expect(mtm).toBe(12_345);
  });

  it('mark-to-market: missing price for a symbol is skipped (no NaN)', () => {
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG);
    const signal = makeLongSignal({ entryPrice: 100, stopLoss: 98, takeProfit: 106 });
    const position = om.openPosition(signal as unknown as ScoredSignal, SYMBOL, 10_000, 0.003, 200)!;
    const mtm = markToMarketEquity(10_000, [position], {}); // no price provided
    expect(mtm).toBe(10_000);
    expect(Number.isNaN(mtm)).toBe(false);
  });
});

describe('migrate-on-startup round-trip (:memory:)', () => {
  it('migrate() then bot_trades + bot_equity_snapshots round-trip', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    expect(() => migrate(db, { migrationsFolder: './drizzle' })).not.toThrow();

    db.insert(schema.botEquitySnapshots)
      .values({
        timestamp: BASE_MS,
        equity: 10_000,
        peakEquity: 10_000,
        drawdown: 0,
        openPositions: 1,
        dailyPnl: 0,
        cumulativePnl: 0,
      })
      .run();

    const snap = db.select().from(schema.botEquitySnapshots).get();
    expect(snap?.equity).toBe(10_000);

    const fakePos: BotPosition = {
      id: 'fwd-1',
      symbol: SYMBOL,
      direction: 'long',
      status: 'closed',
      entryPrice: 100,
      rawEntryPrice: 100,
      entryTimestamp: BASE_MS,
      entryBarIndex: 200,
      stopLoss: 98,
      takeProfit: 106,
      currentSL: 98,
      positionSizeUSDT: 1_000,
      riskAmountUSDT: 12,
      strategy: 'order_block',
      confluenceScore: 6.5,
      factorBreakdown: {},
      regime: 'uptrend+normal',
      partialTaken: false,
      partialPnlPercent: 0,
      exitPrice: 106,
      exitTimestamp: BASE_MS + 3_600_000,
      exitReason: 'take_profit',
      barsHeld: 1,
      pnlPercent: 0.06,
      pnlUSDT: 60,
    };

    db.insert(schema.botTrades)
      .values({
        id: fakePos.id,
        symbol: fakePos.symbol,
        direction: fakePos.direction,
        entryPrice: fakePos.entryPrice,
        exitPrice: fakePos.exitPrice!,
        entryTimestamp: fakePos.entryTimestamp,
        exitTimestamp: fakePos.exitTimestamp!,
        stopLoss: fakePos.stopLoss,
        takeProfit: fakePos.takeProfit,
        positionSizeUSDT: fakePos.positionSizeUSDT,
        riskAmountUSDT: fakePos.riskAmountUSDT,
        strategy: fakePos.strategy,
        confluenceScore: fakePos.confluenceScore,
        factorBreakdown: JSON.stringify(fakePos.factorBreakdown),
        regime: fakePos.regime,
        exitReason: fakePos.exitReason!,
        barsHeld: fakePos.barsHeld!,
        pnlPercent: fakePos.pnlPercent!,
        pnlUSDT: fakePos.pnlUSDT!,
        equityAfter: 10_060,
        drawdownFromPeak: 0,
        createdAt: BASE_MS + 3_600_000,
      })
      .run();

    const trade = db.select().from(schema.botTrades).where(eq(schema.botTrades.id, 'fwd-1')).get();
    expect(trade?.pnlUSDT).toBe(60);
    expect(trade?.symbol).toBe(SYMBOL);
  });
});
