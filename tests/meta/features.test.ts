import { describe, it, expect } from 'vitest';
import { augmentFeatures } from '@/lib/meta/features';
import type { TradeFeatureRow } from '@/lib/meta/dataset';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(
  symbol: string,
  entryTimestamp: number,
  exitTimestamp: number,
  label: 0 | 1,
  features: Record<string, number> = {},
): TradeFeatureRow {
  return {
    symbol,
    entryTimestamp,
    exitTimestamp,
    direction: 'long',
    features: { confluenceScore: 4.0, ...features },
    label,
  };
}

/** Type-safe array element access (throws rather than returning undefined). */
function at<T>(arr: T[], idx: number): T {
  const el = arr[idx];
  if (el === undefined) throw new Error(`No element at index ${idx}`);
  return el;
}

// ---------------------------------------------------------------------------
// 1. priorOutcome — leakage-free
// ---------------------------------------------------------------------------

describe('priorOutcome (leakage-free)', () => {
  /**
   * Trade A: entry=100, exit=300 (open span: 100→300)
   * Trade B: entry=200, exit=400 (enters WHILE A is still open; A.exit=300 > B.entry=200)
   * Trade C: entry=350, exit=500 (enters after A closed; A.exit=300 <= C.entry=350)
   *
   * Expected:
   *   A: priorOutcome=0 (no prior trades)
   *   B: priorOutcome=0 (A hadn't closed yet)
   *   C: priorOutcome=+1 (A is a win and IS closed before C enters; B is still open at C.entry=350)
   */
  it('first trade has priorOutcome=0', () => {
    const tradeA = makeRow('BTC', 100, 300, 1);
    const result = augmentFeatures([tradeA]);
    expect(at(result, 0).features['priorOutcome']).toBe(0);
  });

  it('overlapping trade B does NOT see A (A still open at B entry)', () => {
    const tradeA = makeRow('BTC', 100, 300, 1); // win
    const tradeB = makeRow('BTC', 200, 400, 0); // B.entry=200 < A.exit=300 → A not closed
    const result = augmentFeatures([tradeA, tradeB]);
    // A.exitTimestamp=300 > B.entryTimestamp=200 → A is NOT a prior closed trade for B
    expect(at(result, 1).features['priorOutcome']).toBe(0);
  });

  it('trade C (entry after A exit) DOES see A; B (exit=400) still open at C entry=350', () => {
    const tradeA = makeRow('BTC', 100, 300, 1); // win → +1
    const tradeB = makeRow('BTC', 200, 400, 0); // overlaps A
    const tradeC = makeRow('BTC', 350, 500, 1); // C.entry=350 > A.exit=300; B.exit=400 > C.entry=350
    const result = augmentFeatures([tradeA, tradeB, tradeC]);
    // Only A is closed before C (A.exit=300 <= C.entry=350; B.exit=400 > 350)
    // A is a win → priorOutcome=+1
    expect(at(result, 2).features['priorOutcome']).toBe(1);
  });

  it('loss label is encoded as -1', () => {
    const tradeA = makeRow('BTC', 100, 200, 0); // loss
    const tradeB = makeRow('BTC', 300, 400, 1);
    const result = augmentFeatures([tradeA, tradeB]);
    // A.exit=200 <= B.entry=300 → B sees A; A is loss → -1
    expect(at(result, 1).features['priorOutcome']).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 2. recentWinRate
// ---------------------------------------------------------------------------

describe('recentWinRate', () => {
  it('no prior history → returns global base rate', () => {
    // 2 total rows: 1 win / 2 total → globalBaseRate=0.5
    // First row has no prior → gets base rate
    const row1 = makeRow('BTC', 100, 200, 1); // win
    const row2 = makeRow('BTC', 300, 400, 0); // loss (successor of row1)
    const result = augmentFeatures([row1, row2]);
    // row1 has no prior closed trades → recentWinRate = globalBaseRate = 1/2 = 0.5
    expect(at(result, 0).features['recentWinRate']).toBe(0.5);
  });

  it('uses last N=5 prior closed trades (not more)', () => {
    // 6 trades closed before the 7th.
    // Last 5 of those 6 (sorted by exitTimestamp): exits 200,300,400,500,600 → labels 0,1,1,1,1 → 4/5 = 0.8
    const rows: TradeFeatureRow[] = [
      makeRow('BTC', 0, 100, 1),    // exit=100, win   ← NOT in last-5 window
      makeRow('BTC', 101, 200, 0),  // exit=200, loss  ← oldest of last-5
      makeRow('BTC', 201, 300, 1),  // exit=300, win
      makeRow('BTC', 301, 400, 1),  // exit=400, win
      makeRow('BTC', 401, 500, 1),  // exit=500, win
      makeRow('BTC', 501, 600, 1),  // exit=600, win
      makeRow('BTC', 700, 800, 0),  // 7th row — subject under test
    ];
    const result = augmentFeatures(rows);
    // 7th row: 6 prior closed; last 5 = labels [0,1,1,1,1] → 4/5 = 0.8
    expect(at(result, 6).features['recentWinRate']).toBeCloseTo(0.8);
  });

  it('fewer than N prior closed trades → use all available', () => {
    const rows = [
      makeRow('BTC', 0, 100, 1),    // win
      makeRow('BTC', 101, 200, 1),  // win
      makeRow('BTC', 300, 400, 0),  // 3rd row — 2 priors, both wins → 2/2 = 1.0
    ];
    const result = augmentFeatures(rows);
    expect(at(result, 2).features['recentWinRate']).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// 3. priorCount
// ---------------------------------------------------------------------------

describe('priorCount', () => {
  it('counts only already-closed same-symbol trades', () => {
    const rows = [
      makeRow('BTC', 0, 100, 1),    // exit=100
      makeRow('BTC', 50, 200, 1),   // entry=50 < first.exit=100 → first NOT closed at entry=50
      makeRow('BTC', 300, 400, 0),  // entry=300; first.exit=100<=300, second.exit=200<=300 → 2 priors
    ];
    const result = augmentFeatures(rows);
    expect(at(result, 0).features['priorCount']).toBe(0);
    expect(at(result, 1).features['priorCount']).toBe(0); // first not yet closed at t=50
    expect(at(result, 2).features['priorCount']).toBe(2); // both exited before t=300
  });
});

// ---------------------------------------------------------------------------
// 4. Time features — known epoch → exact literals
// ---------------------------------------------------------------------------

describe('time features (epoch arithmetic)', () => {
  /**
   * 2024-01-15 10:30:00 UTC = 1705314600000 ms
   * hourOfDay = floor(1705314600000 / 3_600_000) % 24
   *           = 473698 % 24 = 10
   *
   * dayOfWeek = floor(1705314600000 / 86_400_000) % 7
   *           = 19737 % 7 = 4
   * (epoch day 19737 mod 7 = 4; epoch day 0 = Thu 1970-01-01)
   */
  it('computes hourOfDay correctly from epoch ms', () => {
    const entryMs = 1_705_314_600_000;
    // Verify test math inline so the test is self-documenting
    const expectedHour = Math.floor((entryMs / 3_600_000) % 24);
    expect(expectedHour).toBe(10); // sanity-check our arithmetic

    const row = makeRow('BTC', entryMs, entryMs + 3_600_000, 1);
    const result = augmentFeatures([row]);
    expect(at(result, 0).features['hourOfDay']).toBe(10);
  });

  it('computes dayOfWeek correctly from epoch ms', () => {
    const entryMs = 1_705_314_600_000;
    const expectedDay = Math.floor((entryMs / 86_400_000) % 7);

    const row = makeRow('BTC', entryMs, entryMs + 3_600_000, 1);
    const result = augmentFeatures([row]);
    expect(at(result, 0).features['dayOfWeek']).toBe(expectedDay);
  });
});

// ---------------------------------------------------------------------------
// 5. Purity / no-mutation + determinism
// ---------------------------------------------------------------------------

describe('purity and no-mutation', () => {
  it('does not mutate input rows features map', () => {
    const row = makeRow('BTC', 100, 200, 1, { confluenceScore: 5.0 });
    const originalFeatureKeys = Object.keys(row.features).slice().sort();

    augmentFeatures([row]);

    // Original row's features map must be unchanged
    expect(Object.keys(row.features).sort()).toEqual(originalFeatureKeys);
    expect(row.features['priorOutcome']).toBeUndefined();
    expect(row.features['recentWinRate']).toBeUndefined();
    expect(row.features['priorCount']).toBeUndefined();
    expect(row.features['hourOfDay']).toBeUndefined();
    expect(row.features['dayOfWeek']).toBeUndefined();
  });

  it('returns new objects (not same references)', () => {
    const row = makeRow('BTC', 100, 200, 1);
    const result = augmentFeatures([row]);
    const first = at(result, 0);
    expect(first).not.toBe(row);
    expect(first.features).not.toBe(row.features);
  });

  it('two calls on same input produce identical output (deterministic)', () => {
    const rows = [
      makeRow('BTC', 0, 100, 1),
      makeRow('BTC', 200, 300, 0),
    ];
    const result1 = augmentFeatures(rows);
    const result2 = augmentFeatures(rows);
    expect(at(result1, 0).features['priorOutcome']).toBe(at(result2, 0).features['priorOutcome']);
    expect(at(result1, 1).features['priorOutcome']).toBe(at(result2, 1).features['priorOutcome']);
    expect(at(result1, 1).features['recentWinRate']).toBe(at(result2, 1).features['recentWinRate']);
  });
});

// ---------------------------------------------------------------------------
// 6. Cross-symbol isolation
// ---------------------------------------------------------------------------

describe('cross-symbol isolation', () => {
  it('SOL trades are not affected by BTC trades', () => {
    const btcWin = makeRow('BTC', 0, 100, 1);
    const solTrade = makeRow('SOL', 200, 300, 0);
    const result = augmentFeatures([btcWin, solTrade]);

    // SOL has no prior SOL trades → priorOutcome=0 and priorCount=0
    expect(at(result, 1).features['priorOutcome']).toBe(0);
    expect(at(result, 1).features['priorCount']).toBe(0);
  });

  it('BTC and SOL history tracked independently', () => {
    const rows = [
      makeRow('BTC', 0, 100, 1),    // BTC win
      makeRow('SOL', 0, 100, 0),    // SOL loss
      makeRow('BTC', 200, 300, 0),  // BTC #2: should see BTC win → priorOutcome=+1
      makeRow('SOL', 200, 300, 1),  // SOL #2: should see SOL loss → priorOutcome=-1
    ];
    const result = augmentFeatures(rows);

    // Use .find() with optional chaining — type-safe without at()
    const btcTrade2 = result.find(
      (r) => r.symbol === 'BTC' && r.entryTimestamp === 200,
    );
    expect(btcTrade2?.features['priorOutcome']).toBe(1);

    const solTrade2 = result.find(
      (r) => r.symbol === 'SOL' && r.entryTimestamp === 200,
    );
    expect(solTrade2?.features['priorOutcome']).toBe(-1);
  });
});
