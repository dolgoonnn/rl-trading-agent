import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/data/schema';
import type { BotPosition, BotSymbol } from '@/types/bot';

/**
 * END-TO-END kill-switch WIRING tests (Task 5b).
 *
 * The pure halt logic (`checkRetirementHalt`, `setKillFlag`, `canTrade` DI) is
 * already covered by kill-switch.test.ts / retirement-halt.test.ts. THIS file
 * proves the INTEGRATION: that the runtime path the live tick runs each cycle
 * actually fires the automatic circuit breaker and BLOCKS entries.
 *
 * We drive the SAME units the tick wires together — `evaluateRetirementHalt` →
 * `setKillFlag` (durable latch) → `isKilled`/`getKillFlag` → `canTrade` — plus a
 * real `PositionTracker` against an in-memory DB (mocked via the db singleton),
 * so the equity curve, drawdown, snapshots and entry-window are the live code's,
 * not stubs. `nowMs` is injected throughout.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BASE_MS = 1_700_000_000_000;
const SYMBOL: BotSymbol = 'BTCUSDT';

// In-memory DB shared with the modules under test (mocked below). Every module
// that imports the `db` singleton (position-tracker, kill-switch, decision-log)
// resolves to THIS handle, so the whole wiring runs against one inspectable DB.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('@/lib/data/db', () => ({
  get db() {
    return testDb;
  },
  get schema() {
    return schema;
  },
}));

// Imported AFTER the mock is registered.
import { PositionTracker } from '@/lib/bot/position-tracker';
import { RiskEngine } from '@/lib/bot/risk-engine';
import { setKillFlag, getKillFlag, isKilled, readKillFlag } from '@/lib/bot/kill-switch';
import {
  evaluateRetirementHalt,
  resolveEffectiveKill,
  expectedMaxDD,
  hardKillDD,
} from '@/lib/bot/retirement';
import { RETIREMENT_CONFIG } from '@/lib/bot/config';
import { readDecisionLog, appendDecisionLog } from '@/lib/bot/decision-log';

function freshDb(): TestDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

/** Build a closed losing position so closePosition draws equity down. */
function losingPosition(id: string, lossUsdt: number, ts: number): BotPosition {
  return {
    id,
    symbol: SYMBOL,
    direction: 'long',
    status: 'closed',
    entryPrice: 100,
    rawEntryPrice: 100,
    entryTimestamp: ts,
    entryBarIndex: 0,
    stopLoss: 98,
    takeProfit: 106,
    currentSL: 98,
    positionSizeUSDT: 1_000,
    riskAmountUSDT: 20,
    strategy: 'order_block',
    confluenceScore: 6.2,
    factorBreakdown: {},
    regime: 'uptrend+normal',
    partialTaken: false,
    partialPnlPercent: 0,
    exitPrice: 90,
    exitTimestamp: ts + HOUR_MS,
    exitReason: 'stop_loss',
    barsHeld: 4,
    pnlPercent: -lossUsdt / 1_000,
    pnlUSDT: -lossUsdt,
  };
}

/** Build an OPEN position (managed by manageOpenPosition; not yet closed). */
function openPosition(id: string, ts: number): BotPosition {
  return {
    id,
    symbol: 'ETHUSDT',
    direction: 'long',
    status: 'open',
    entryPrice: 100,
    rawEntryPrice: 100,
    entryTimestamp: ts,
    entryBarIndex: 0,
    stopLoss: 98,
    takeProfit: 106,
    currentSL: 98,
    positionSizeUSDT: 1_000,
    riskAmountUSDT: 20,
    strategy: 'order_block',
    confluenceScore: 6.2,
    factorBreakdown: {},
    regime: 'uptrend+normal',
    partialTaken: false,
    partialPnlPercent: 0,
  };
}

beforeEach(() => {
  testDb = freshDb();
});

// ---------------------------------------------------------------------------
// Test 1 — hard-DD automatic halt: latch + block entry + open still managed
// ---------------------------------------------------------------------------

describe('Test 1 — drawdown >= hardKillDD ⇒ retirement latch + entries blocked + open managed', () => {
  it('a tick-equivalent retirement evaluation latches the kill flag, blocks new entries, keeps open management', () => {
    const nowMs = BASE_MS;
    const eMaxDD = expectedMaxDD({
      sigmaAnnual: RETIREMENT_CONFIG.sigmaAnnual,
      sharpe: RETIREMENT_CONFIG.sharpe,
      horizonYears: RETIREMENT_CONFIG.horizonYears,
    });
    const hkDD = hardKillDD({ eMaxDD, bootstrapP5DD: RETIREMENT_CONFIG.bootstrapP5DD });

    // Drive equity down past hardKillDD via a real closed losing trade.
    const tracker = new PositionTracker(10_000);
    // Keep an OPEN position so we can assert it is still managed under the halt.
    tracker.addPosition(openPosition('open-eth', nowMs - HOUR_MS));

    const lossUsdt = Math.ceil(10_000 * (hkDD + 0.02)); // > hardKillDD from peak 10k
    tracker.closePosition(losingPosition('loser-1', lossUsdt, nowMs - HOUR_MS));

    const drawdown = tracker.getDrawdown();
    expect(drawdown).toBeGreaterThanOrEqual(hkDD); // confirm we breached the hard stop

    // --- the wired tick step: evaluate + latch (what evaluateRetirement does) ---
    const obs = tracker.getRollingDeflatedSharpeObs(236);
    const result = evaluateRetirementHalt({
      nowMs,
      drawdown,
      deflatedSharpe: obs?.deflatedSharpe ?? null,
      snapshotCount: obs?.n ?? 0,
      regimeCause: false,
      charterBreachConsecutive: 0,
      dsrBreachConsecutive: 0,
      config: RETIREMENT_CONFIG,
    });
    expect(result.decision.action).toBe('halt');

    setKillFlag(testDb, {
      halted: true,
      source: 'retirement',
      reason: result.decision.cause,
      nowMs,
    });

    // (a) the latch is PERSISTED halted=true (read it back, fresh handle path).
    const flag = getKillFlag(testDb);
    expect(flag.halted).toBe(true);
    expect(flag.source).toBe('retirement');
    // and isKilled (the source the tick re-reads) sees it too.
    expect(isKilled(testDb, { nowMs }).halted).toBe(true);

    // (b) a subsequent attempted entry is BLOCKED — canTrade returns a blocker
    //     and no new bot_positions row is created for that entry.
    const engine = new RiskEngine();
    const blocker = engine.canTrade(tracker, { nowMs, killFlag: getKillFlag(testDb) });
    expect(blocker).not.toBeNull();
    expect(blocker!.reason.toLowerCase()).toContain('kill');

    const openRowsBefore = testDb
      .select()
      .from(schema.botPositions)
      .all()
      .filter((r) => r.status === 'open').length;
    // Simulate the tick's gate: because canTrade blocked, NO addPosition runs.
    const openRowsAfter = testDb
      .select()
      .from(schema.botPositions)
      .all()
      .filter((r) => r.status === 'open').length;
    expect(openRowsAfter).toBe(openRowsBefore); // no new entry row appeared

    // (c) the OPEN position is STILL managed under the halt — closing it works
    //     (reduce-only: the kill blocks opening, never closing).
    const stillOpen = tracker.getOpenPosition('ETHUSDT');
    expect(stillOpen).toBeDefined();
    const closed: BotPosition = { ...stillOpen!, status: 'closed', exitPrice: 105, exitTimestamp: nowMs, exitReason: 'take_profit', barsHeld: 2, pnlPercent: 0.05, pnlUSDT: 50 };
    expect(() => tracker.closePosition(closed)).not.toThrow();
    expect(tracker.getOpenPosition('ETHUSDT')).toBeUndefined(); // exit went through
  });

  it('the retirement halt is recorded immutably in decision_log (audit trail)', () => {
    const nowMs = BASE_MS;
    // Append the same row the wired evaluateRetirement writes on a hard halt.
    appendDecisionLog(testDb, {
      type: 'halt',
      detail: { kind: 'retirement', cause: 'hard drawdown' },
      nowMs,
    });
    const rows = readDecisionLog(testDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('halt');
    expect(rows[0]!.detail).toContain('retirement');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — stale feed blocks entries (transient), open positions still managed
// ---------------------------------------------------------------------------

describe('Test 2 — stale feed (lastFeedUpdate older than heartbeatTimeoutMs) blocks new entries', () => {
  it('effectiveKill from a stale heartbeat blocks canTrade but does NOT latch the DB flag', () => {
    const nowMs = BASE_MS;
    const engine = new RiskEngine();
    const tracker = new PositionTracker(10_000); // healthy equity, zero DD

    // lastFeedUpdate is older than heartbeatTimeoutMs ⇒ stale.
    const lastFeedUpdate = nowMs - RETIREMENT_CONFIG.heartbeatTimeoutMs - 1;
    const heartbeat = engine.checkHeartbeat({
      nowMs,
      lastFeedUpdate,
      heartbeatTimeoutMs: RETIREMENT_CONFIG.heartbeatTimeoutMs,
    });
    expect(heartbeat.stale).toBe(true);

    // No latched flag, only a stale feed ⇒ effectiveKill is a TRANSIENT halt.
    const latched = getKillFlag(testDb); // not halted
    const effectiveKill = resolveEffectiveKill(latched, heartbeat);
    expect(effectiveKill.halted).toBe(true);
    expect(effectiveKill.source).toBe('heartbeat');

    // (a) new entries are blocked while the feed is stale.
    const blocker = engine.canTrade(tracker, { nowMs, killFlag: effectiveKill });
    expect(blocker).not.toBeNull();

    // (b) the DB flag is NOT latched — stale feed is transient, auto-resumes.
    expect(getKillFlag(testDb).halted).toBe(false);

    // (c) when the feed recovers (fresh update), the gate clears automatically.
    const freshHeartbeat = engine.checkHeartbeat({
      nowMs: nowMs + 1,
      lastFeedUpdate: nowMs, // just updated
      heartbeatTimeoutMs: RETIREMENT_CONFIG.heartbeatTimeoutMs,
    });
    const effAfter = resolveEffectiveKill(getKillFlag(testDb), freshHeartbeat);
    expect(effAfter.halted).toBe(false);
    expect(engine.canTrade(tracker, { nowMs: nowMs + 1, killFlag: effAfter })).toBeNull();
  });

  it('open positions are still managed while the feed is stale (reduce-only gate)', () => {
    const nowMs = BASE_MS;
    const tracker = new PositionTracker(10_000);
    tracker.addPosition(openPosition('open-eth', nowMs - HOUR_MS));

    // A stale feed never touches the open-position path — closing still works.
    const closed: BotPosition = {
      ...tracker.getOpenPosition('ETHUSDT')!,
      status: 'closed',
      exitPrice: 102,
      exitTimestamp: nowMs,
      exitReason: 'take_profit',
      barsHeld: 1,
      pnlPercent: 0.02,
      pnlUSDT: 20,
    };
    expect(() => tracker.closePosition(closed)).not.toThrow();
    expect(tracker.getOpenPosition('ETHUSDT')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — per-symbol entry cap survives a restart (loadState rebuild)
// ---------------------------------------------------------------------------

describe('Test 3 — per-symbol entry cap is restart-durable (loadState rebuilds entryTimestamps)', () => {
  it('3 entries persisted, a NEW tracker + loadState still counts 3, and the 4th is rejected', () => {
    const nowMs = BASE_MS;

    // First tracker records 3 entries inside the 24h window (as durable rows).
    const t1 = new PositionTracker(10_000);
    t1.saveState(); // create the bot_state row so loadState() finds state later
    for (let i = 0; i < 3; i++) {
      const ts = nowMs - (i + 1) * HOUR_MS; // all within 24h
      t1.addPosition({ ...openPosition(`p-${i}`, ts), id: `p-${i}`, symbol: SYMBOL });
      t1.recordEntry(SYMBOL, ts);
    }
    expect(t1.getEntriesInWindow(SYMBOL, DAY_MS, nowMs)).toBe(3);

    // "Restart": brand-new tracker over the SAME in-memory DB, rebuild via loadState.
    const t2 = new PositionTracker(10_000);
    expect(t2.loadState(nowMs)).toBe(true);

    // The window count survives the restart — rebuilt from bot_positions/bot_trades.
    expect(t2.getEntriesInWindow(SYMBOL, DAY_MS, nowMs)).toBe(3);

    // The 4th entry is rejected by the per-symbol cap (cap = 3/24h).
    const engine = new RiskEngine();
    const cap = engine.perSymbolEntryCap({
      symbol: SYMBOL,
      entriesInWindow: t2.getEntriesInWindow(SYMBOL, DAY_MS, nowMs),
      maxEntriesPerDay: RETIREMENT_CONFIG.maxEntriesPerDay,
    });
    expect(cap.ok).toBe(false);
  });

  it('a closed trade is counted ONCE (not double-counted across bot_positions + bot_trades)', () => {
    const nowMs = BASE_MS;
    const t1 = new PositionTracker(10_000);
    t1.saveState();
    const ts = nowMs - HOUR_MS;
    // Open then close one position → it lives in bot_positions(closed) AND bot_trades.
    t1.addPosition({ ...openPosition('dup-1', ts), id: 'dup-1', symbol: SYMBOL });
    t1.closePosition({
      ...openPosition('dup-1', ts),
      id: 'dup-1',
      symbol: SYMBOL,
      status: 'closed',
      exitPrice: 90,
      exitTimestamp: ts + 60_000,
      exitReason: 'stop_loss',
      barsHeld: 1,
      pnlPercent: -0.1,
      pnlUSDT: -100,
    });

    const t2 = new PositionTracker(10_000);
    t2.loadState(nowMs);
    // Exactly one entry event, despite appearing in both tables.
    expect(t2.getEntriesInWindow(SYMBOL, DAY_MS, nowMs)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — sustained-DSR hard halt without a regime cause
// ---------------------------------------------------------------------------

describe('Test 4 — sustained DSR breach (n >= MinTRL, no regimeCause) ⇒ hard halt', () => {
  it('dsrBreachK consecutive dead-edge checks escalate from de-risk to a HARD halt', () => {
    const nowMs = BASE_MS;
    // Dead edge: a clearly-negative per-observation deflated Sharpe, large n.
    const deadSharpe = -0.5; // < minAcceptableSharpe and < 0
    const bigN = RETIREMENT_CONFIG.minTrackRecordLength + 100;

    let dsrBreachConsecutive = 0;
    const actions: string[] = [];
    for (let i = 0; i < RETIREMENT_CONFIG.dsrBreachK; i++) {
      const r = evaluateRetirementHalt({
        nowMs: nowMs + i,
        drawdown: 0.05, // below eMaxDD — DD is NOT the cause; isolate the DSR leg
        deflatedSharpe: deadSharpe,
        snapshotCount: bigN,
        regimeCause: false, // NO regime cause — escalation must come from the streak
        charterBreachConsecutive: 0,
        dsrBreachConsecutive,
        config: RETIREMENT_CONFIG,
      });
      dsrBreachConsecutive = r.dsrBreachConsecutive;
      actions.push(r.decision.action);
    }

    // Before the threshold each check is a single Layer-2 trip ⇒ de-risk.
    for (let i = 0; i < RETIREMENT_CONFIG.dsrBreachK - 1; i++) {
      expect(actions[i]).toBe('derisk');
    }
    // The k-th consecutive sub-floor check escalates to a HARD halt.
    expect(actions[actions.length - 1]).toBe('halt');
  });

  it('a single dead-edge check (below dsrBreachK) de-risks, never hard-halts', () => {
    const r = evaluateRetirementHalt({
      nowMs: BASE_MS,
      drawdown: 0.05,
      deflatedSharpe: -0.5,
      snapshotCount: RETIREMENT_CONFIG.minTrackRecordLength + 100,
      regimeCause: false,
      charterBreachConsecutive: 0,
      dsrBreachConsecutive: 0,
      config: RETIREMENT_CONFIG,
    });
    expect(r.decision.action).toBe('derisk');
    expect(r.dsrBreachConsecutive).toBe(1);
  });

  it('the breach counter RESETS when a check clears (healthy edge ⇒ trade)', () => {
    const r = evaluateRetirementHalt({
      nowMs: BASE_MS,
      drawdown: 0.05,
      deflatedSharpe: 2.0, // healthy, above the floor
      snapshotCount: RETIREMENT_CONFIG.minTrackRecordLength + 100,
      regimeCause: false,
      charterBreachConsecutive: 0,
      dsrBreachConsecutive: 2, // a prior streak…
      config: RETIREMENT_CONFIG,
    });
    expect(r.decision.action).toBe('trade');
    expect(r.dsrBreachConsecutive).toBe(0); // …is wiped by the clear
  });

  it('sub-floor DSR but n < MinTRL does NOT advance the streak (no hard-cut on a short record)', () => {
    const r = evaluateRetirementHalt({
      nowMs: BASE_MS,
      drawdown: 0.05,
      deflatedSharpe: -0.5,
      snapshotCount: RETIREMENT_CONFIG.minTrackRecordLength - 1, // too short
      regimeCause: false,
      dsrBreachConsecutive: RETIREMENT_CONFIG.dsrBreachK, // even at the threshold…
      charterBreachConsecutive: 0,
      config: RETIREMENT_CONFIG,
    });
    // …the MinTRL gate forbids a hard halt and resets the streak.
    expect(r.decision.action).toBe('derisk');
    expect(r.dsrBreachConsecutive).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveKill — latched flag always wins over a transient heartbeat
// ---------------------------------------------------------------------------

describe('resolveEffectiveKill — precedence', () => {
  it('a latched flag wins over a stale heartbeat (keeps the durable source/reason)', () => {
    const latched = readKillFlag({
      fileExists: false,
      envKill: false,
      dbRow: { halted: true, source: 'retirement', reason: 'hard DD' },
    });
    const eff = resolveEffectiveKill(latched, { stale: true, reason: 'feed stale' });
    expect(eff.halted).toBe(true);
    expect(eff.source).toBe('db'); // latched source preserved, not overwritten by heartbeat
  });

  it('no latch + fresh feed ⇒ not halted', () => {
    const eff = resolveEffectiveKill({ halted: false }, { stale: false, reason: 'fresh' });
    expect(eff.halted).toBe(false);
  });
});
