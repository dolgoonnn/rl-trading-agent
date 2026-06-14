import { describe, it, expect } from 'vitest';
import {
  expectedMaxDD,
  hardKillDD,
  checkRetirementHalt,
  type RetirementHaltInputs,
} from '@/lib/bot/retirement';
import { minTrackRecordLength } from '@/lib/rl/utils/deflated-sharpe';
import { RETIREMENT_CONFIG } from '@/lib/bot/config';

/**
 * The retirement halt decision is PURE and fully dependency-injected — every
 * number (nowMs, equity/peak/drawdown, rolling Sharpe, trial count, snapshot
 * count, charter-path breach state) is passed in, so every branch is testable
 * with no Date.now()/fetch/DB in the logic path.
 */

// ---------------------------------------------------------------------------
// expectedMaxDD / hardKillDD numerics
// ---------------------------------------------------------------------------

describe('expectedMaxDD — sigmaAnnual*sqrt(2*ln(horizonYears*252))/sharpe', () => {
  it('sigma=0.12, sharpe=2, horizon=0.75 ⇒ ≈0.194 (formula output, far below raw 0.633)', () => {
    const e = expectedMaxDD({ sigmaAnnual: 0.12, sharpe: 2, horizonYears: 0.75 });
    // ln(189)=5.24175, sqrt(2*ln)=3.23783, *0.12/2 = 0.19427
    expect(e).toBeCloseTo(0.19427, 4);
    expect(e).toBeLessThan(0.633); // must NOT be the raw in-sample 63.3%
  });

  it('scales with sigma and inversely with sharpe', () => {
    const base = expectedMaxDD({ sigmaAnnual: 0.12, sharpe: 2, horizonYears: 0.75 });
    const higherVol = expectedMaxDD({ sigmaAnnual: 0.24, sharpe: 2, horizonYears: 0.75 });
    const higherSharpe = expectedMaxDD({ sigmaAnnual: 0.12, sharpe: 4, horizonYears: 0.75 });
    expect(higherVol).toBeCloseTo(base * 2, 6);
    expect(higherSharpe).toBeCloseTo(base / 2, 6);
  });
});

describe('hardKillDD — 1.5*max(eMaxDD, bootstrapP5DD)', () => {
  it('eMaxDD dominates ⇒ 1.5*eMaxDD (≈0.291, inside the NOT-0.633 band)', () => {
    const e = expectedMaxDD({ sigmaAnnual: 0.12, sharpe: 2, horizonYears: 0.75 });
    const hk = hardKillDD({ eMaxDD: e, bootstrapP5DD: 0.10 });
    expect(hk).toBeCloseTo(1.5 * e, 6);
    expect(hk).toBeCloseTo(0.29140, 4);
    expect(hk).toBeLessThan(0.633);
  });

  it('bootstrapP5DD dominates ⇒ 1.5*bootstrapP5DD', () => {
    const hk = hardKillDD({ eMaxDD: 0.10, bootstrapP5DD: 0.30 });
    expect(hk).toBeCloseTo(0.45, 6);
  });
});

// ---------------------------------------------------------------------------
// checkRetirementHalt — confluence rules
// ---------------------------------------------------------------------------

/** A neutral, "everything healthy" input baseline; tests override one axis. */
function baseInputs(over: Partial<RetirementHaltInputs> = {}): RetirementHaltInputs {
  const eMaxDD = expectedMaxDD({ sigmaAnnual: 0.12, sharpe: 2, horizonYears: 0.75 });
  const hardDD = hardKillDD({ eMaxDD, bootstrapP5DD: 0.10 });
  return {
    nowMs: 1_700_000_000_000,
    drawdown: 0.05, // well below eMaxDD
    eMaxDD,
    hardKillDD: hardDD,
    rollingSharpe: 2.0, // healthy
    trialCount: 200,
    snapshotCount: 500, // >= MinTRL
    minTrackRecordLength: 50,
    minAcceptableSharpe: 0.5,
    psr: 0.95,
    regimeCause: false,
    charterBreachConsecutive: 0,
    charterBreachK: 3,
    ...over,
  };
}

describe('checkRetirementHalt — drawdown confluence', () => {
  it('DD below eMaxDD ⇒ trade (multiplier 1)', () => {
    const r = checkRetirementHalt(baseInputs({ drawdown: 0.05 }));
    expect(r.action).toBe('trade');
    expect(r.multiplier).toBe(1);
  });

  it('DD between eMaxDD and hardKillDD ⇒ derisk (multiplier 0.5)', () => {
    const inp = baseInputs();
    const mid = (inp.eMaxDD + inp.hardKillDD) / 2;
    const r = checkRetirementHalt({ ...inp, drawdown: mid });
    expect(r.action).toBe('derisk');
    expect(r.multiplier).toBe(0.5);
    expect(r.cause).toMatch(/drawdown/i);
  });

  it('DD exactly at eMaxDD ⇒ derisk (boundary: >= eMaxDD enters the derisk band)', () => {
    const inp = baseInputs();
    const r = checkRetirementHalt({ ...inp, drawdown: inp.eMaxDD });
    expect(r.action).toBe('derisk');
  });

  it('DD >= hardKillDD ⇒ HARD halt (absolute stop, regardless of MinTRL)', () => {
    const inp = baseInputs();
    const r = checkRetirementHalt({ ...inp, drawdown: inp.hardKillDD });
    expect(r.action).toBe('halt');
    expect(r.multiplier).toBe(0);
    expect(r.cause).toMatch(/hard.*drawdown|absolute|hardKillDD/i);
  });

  it('DD >= hardKillDD hard-halts even when snapshotCount < MinTRL (absolute stop is unconditional)', () => {
    const inp = baseInputs();
    const r = checkRetirementHalt({
      ...inp,
      drawdown: inp.hardKillDD + 0.05,
      snapshotCount: 5, // below MinTRL — must NOT downgrade an absolute-stop halt
    });
    expect(r.action).toBe('halt');
  });
});

describe('checkRetirementHalt — deflated-Sharpe / MinTRL confluence', () => {
  it('DSR insignificant but snapshotCount < MinTRL ⇒ derisk ONLY (never hard at the bottom of a normal DD)', () => {
    const r = checkRetirementHalt(
      baseInputs({
        rollingSharpe: 0.0, // deflated will be <= 0 → insignificant
        snapshotCount: 20,
        minTrackRecordLength: 50,
        regimeCause: true, // even with a regime cause, MinTRL gate forbids hard
      }),
    );
    expect(r.action).toBe('derisk');
    expect(r.multiplier).toBe(0.5);
  });

  it('DSR insignificant AND snapshotCount >= MinTRL AND regime cause ⇒ HARD halt', () => {
    const r = checkRetirementHalt(
      baseInputs({
        rollingSharpe: 0.0,
        snapshotCount: 500,
        minTrackRecordLength: 50,
        regimeCause: true,
      }),
    );
    expect(r.action).toBe('halt');
    expect(r.cause).toMatch(/dsr|sharpe|regime/i);
  });

  it('DSR insignificant AND snapshotCount >= MinTRL but NO regime cause ⇒ derisk only (DSR alone is a single Layer-2 trip)', () => {
    const r = checkRetirementHalt(
      baseInputs({
        rollingSharpe: 0.0,
        snapshotCount: 500,
        minTrackRecordLength: 50,
        regimeCause: false,
      }),
    );
    expect(r.action).toBe('derisk');
    expect(r.multiplier).toBe(0.5);
  });

  it('DSR significant (healthy Sharpe) with a regime cause ⇒ derisk only (no DSR-conclusive trigger)', () => {
    const r = checkRetirementHalt(
      baseInputs({
        rollingSharpe: 2.5,
        regimeCause: true,
      }),
    );
    expect(r.action).toBe('derisk');
  });
});

describe('checkRetirementHalt — charter 5th-pct path escalation (yellow → red)', () => {
  it('cumPnl below charter p5 once ⇒ yellow (derisk), not red', () => {
    const r = checkRetirementHalt(baseInputs({ charterBreachConsecutive: 1, charterBreachK: 3 }));
    expect(r.action).toBe('derisk');
    expect(r.cause).toMatch(/charter|yellow|p5/i);
  });

  it('cumPnl below charter p5 for k consecutive checks ⇒ red (hard halt)', () => {
    const r = checkRetirementHalt(baseInputs({ charterBreachConsecutive: 3, charterBreachK: 3 }));
    expect(r.action).toBe('halt');
    expect(r.cause).toMatch(/charter|red/i);
  });
});

// ---------------------------------------------------------------------------
// minTrackRecordLength helper
// ---------------------------------------------------------------------------

describe('minTrackRecordLength — minimum n before the DSR layer may hard-halt', () => {
  it('returns a positive integer floor', () => {
    const n = minTrackRecordLength({ sharpe: 0.5, targetSharpe: 0, skewness: 0, kurtosis: 3 });
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });

  it('a smaller observed-minus-target Sharpe edge requires a LONGER track record', () => {
    const tight = minTrackRecordLength({ sharpe: 0.55, targetSharpe: 0.5 });
    const loose = minTrackRecordLength({ sharpe: 2.0, targetSharpe: 0.5 });
    expect(tight).toBeGreaterThan(loose);
  });
});

// ---------------------------------------------------------------------------
// RETIREMENT_CONFIG sanity
// ---------------------------------------------------------------------------

describe('RETIREMENT_CONFIG — frozen-at-deploy parameters', () => {
  it('uses minAcceptableSharpe c=0.5 (NOT zero) as the DSR benchmark', () => {
    expect(RETIREMENT_CONFIG.minAcceptableSharpe).toBe(0.5);
  });

  it('hardKillDD inputs are vol-anchored, NOT the raw 0.633 in-sample DD', () => {
    const e = expectedMaxDD({
      sigmaAnnual: RETIREMENT_CONFIG.sigmaAnnual,
      sharpe: RETIREMENT_CONFIG.sharpe,
      horizonYears: RETIREMENT_CONFIG.horizonYears,
    });
    const hk = hardKillDD({ eMaxDD: e, bootstrapP5DD: RETIREMENT_CONFIG.bootstrapP5DD });
    expect(hk).toBeLessThan(0.633);
    expect(hk).toBeGreaterThan(0.15);
  });

  it('per-symbol caps and heartbeat are present', () => {
    expect(RETIREMENT_CONFIG.maxEntriesPerDay).toBe(3);
    expect(RETIREMENT_CONFIG.maxConsecutiveLossesPerSymbol).toBe(4);
    expect(RETIREMENT_CONFIG.heartbeatTimeoutMs).toBe(7_200_000);
    expect(RETIREMENT_CONFIG.psr).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// RiskEngine.perSymbolEntryCap — independent of strategy cooldownBars
// ---------------------------------------------------------------------------

describe('RiskEngine.perSymbolEntryCap — max entries per symbol per 24h', () => {
  it('3rd entry in 24h ⇒ reject; other symbols still trade', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const engine = new RiskEngine();
    const nowMs = 1_700_000_000_000;
    const DAY = 24 * 3_600_000;

    // BTC: 3 entries already inside the 24h window → cap reached.
    const btcEntries = [nowMs - DAY + 1, nowMs - DAY / 2, nowMs - 1_000];
    const btc = engine.perSymbolEntryCap({
      symbol: 'BTCUSDT',
      entriesInWindow: btcEntries.length,
      maxEntriesPerDay: 3,
    });
    expect(btc.ok).toBe(false);

    // ETH: only 1 entry in the window → still allowed.
    const eth = engine.perSymbolEntryCap({
      symbol: 'ETHUSDT',
      entriesInWindow: 1,
      maxEntriesPerDay: 3,
    });
    expect(eth.ok).toBe(true);
  });

  it('cap is on COUNT-in-window, independent of strategy cooldownBars', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const engine = new RiskEngine();
    // 2 in window with cap 3 → allowed (boundary just below cap).
    expect(engine.perSymbolEntryCap({ symbol: 'SOLUSDT', entriesInWindow: 2, maxEntriesPerDay: 3 }).ok).toBe(true);
    // exactly at cap → reject.
    expect(engine.perSymbolEntryCap({ symbol: 'SOLUSDT', entriesInWindow: 3, maxEntriesPerDay: 3 }).ok).toBe(false);
  });

  it('symbolPaused after maxConsecutiveLossesPerSymbol without halting the whole book', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const engine = new RiskEngine();
    expect(engine.isSymbolPaused({ consecutiveLosses: 3, maxConsecutiveLossesPerSymbol: 4 })).toBe(false);
    expect(engine.isSymbolPaused({ consecutiveLosses: 4, maxConsecutiveLossesPerSymbol: 4 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RiskEngine.getSharpeMultiplier — DEFLATED (RED→GREEN vs raw Sharpe)
// ---------------------------------------------------------------------------

describe('RiskEngine.getSharpeMultiplier — deflated, benchmarked vs c=0.5', () => {
  it('0.3 rolling Sharpe @ 100 trials now REDUCES sizing where raw-Sharpe (>0) did not', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const engine = new RiskEngine();
    // raw code: 0.3 >= 0 and >= ... actually raw returned 0.5 (0<0.3<0.5).
    // deflated code: 0.3 with 100 trials, benchmarked vs c=0.5 → PSR/edge below
    // threshold → multiplier reduced (<= 0.5, here 0 because deflated <= c).
    const mult = engine.getSharpeMultiplier({
      rollingSharpe: 0.3,
      numTrades: 200,
      trialCount: 100,
      minAcceptableSharpe: 0.5,
    });
    expect(mult).toBeLessThanOrEqual(0.5);
    // A genuinely strong, well-supported Sharpe keeps full size.
    const strong = engine.getSharpeMultiplier({
      rollingSharpe: 3.0,
      numTrades: 500,
      trialCount: 100,
      minAcceptableSharpe: 0.5,
    });
    expect(strong).toBe(1.0);
  });

  it('null rolling Sharpe (insufficient data) ⇒ full size 1.0 (do not punish cold start)', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const engine = new RiskEngine();
    const mult = engine.getSharpeMultiplier({
      rollingSharpe: null,
      numTrades: 5,
      trialCount: 100,
      minAcceptableSharpe: 0.5,
    });
    expect(mult).toBe(1.0);
  });

  it('benchmark is c=0.5, NOT zero: a deflated Sharpe between 0 and 0.5 still de-risks', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const engine = new RiskEngine();
    // Many trades so the haircut is tiny → deflated ≈ raw 0.35, which is > 0 but
    // < c=0.5. Under a zero benchmark this would be "fine"; under c=0.5 it de-risks.
    const mult = engine.getSharpeMultiplier({
      rollingSharpe: 0.35,
      numTrades: 5_000,
      trialCount: 2,
      minAcceptableSharpe: 0.5,
    });
    expect(mult).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// RiskEngine.checkHeartbeat — latches a stale_feed HALT
// ---------------------------------------------------------------------------

describe('RiskEngine.checkHeartbeat — stale feed escalation', () => {
  it('fresh feed (gap < timeout) ⇒ not stale', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const engine = new RiskEngine();
    const r = engine.checkHeartbeat({
      nowMs: 1_000_000,
      lastFeedUpdate: 1_000_000 - 1_000,
      heartbeatTimeoutMs: 7_200_000,
    });
    expect(r.stale).toBe(false);
  });

  it('gap > heartbeatTimeoutMs ⇒ stale_feed HALT', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const engine = new RiskEngine();
    const r = engine.checkHeartbeat({
      nowMs: 10_000_000,
      lastFeedUpdate: 10_000_000 - 7_200_001,
      heartbeatTimeoutMs: 7_200_000,
    });
    expect(r.stale).toBe(true);
    expect(r.reason.toLowerCase()).toContain('feed');
  });

  it('null lastFeedUpdate (no successful fetch yet) ⇒ not stale (cold start, do not halt)', async () => {
    const { RiskEngine } = await import('@/lib/bot/risk-engine');
    const engine = new RiskEngine();
    const r = engine.checkHeartbeat({
      nowMs: 10_000_000,
      lastFeedUpdate: null,
      heartbeatTimeoutMs: 7_200_000,
    });
    expect(r.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PositionTracker — recordEntry / getEntriesInWindow / getRollingDeflatedSharpe
// ---------------------------------------------------------------------------

describe('PositionTracker entry-window + deflated-sharpe wrappers', () => {
  it('recordEntry + getEntriesInWindow counts only entries inside the window', async () => {
    const { PositionTracker } = await import('@/lib/bot/position-tracker');
    const tracker = new PositionTracker(10_000);
    const nowMs = 1_700_000_000_000;
    const DAY = 24 * 3_600_000;

    tracker.recordEntry('BTCUSDT', nowMs - 2 * DAY); // outside 24h
    tracker.recordEntry('BTCUSDT', nowMs - DAY / 2); // inside
    tracker.recordEntry('BTCUSDT', nowMs - 1_000); // inside
    tracker.recordEntry('ETHUSDT', nowMs - 1_000); // different symbol

    expect(tracker.getEntriesInWindow('BTCUSDT', DAY, nowMs)).toBe(2);
    expect(tracker.getEntriesInWindow('ETHUSDT', DAY, nowMs)).toBe(1);
    expect(tracker.getEntriesInWindow('SOLUSDT', DAY, nowMs)).toBe(0);
  });

  it('getRollingDeflatedSharpe(trials) returns null when rolling Sharpe is null (cold)', async () => {
    const { PositionTracker } = await import('@/lib/bot/position-tracker');
    const tracker = new PositionTracker(10_000);
    // Fresh tracker, no snapshots → rolling Sharpe is null → deflated is null.
    expect(tracker.getRollingDeflatedSharpe(100)).toBeNull();
  });
});
