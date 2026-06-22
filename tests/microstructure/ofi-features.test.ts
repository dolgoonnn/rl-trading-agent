import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseSnapshotLine,
  snapshotOFI,
  cvdDelta,
  cumulativeCVD,
  microprice,
  micropriceFromDepth,
  bookImbalance,
  bookImbalanceFromDepth,
  loadOrderflowDay,
  type Snapshot,
} from '@/lib/microstructure';

// A REAL line copied verbatim from data/orderflow/BTCUSDT_2026-06-11.ndjson.
const REAL_LINE_WITH_LIQ =
  '{"ts":1781162774485,"mid":62707.95,"spreadBps":0.02,"bidDepth5":1.379,"askDepth5":0.745,"imb5":0.298,"imb25":0.615,"buyVol":0,"sellVol":0,"tradeCount":0,"liqBuy":0,"liqSell":0,"liqCount":0}';
// A REAL line WITHOUT the optional liquidation fields (older collector lines).
const REAL_LINE_NO_LIQ =
  '{"ts":1781162775485,"mid":62710.75,"spreadBps":0.02,"bidDepth5":11.351,"askDepth5":0.022,"imb5":0.996,"imb25":0.93,"buyVol":0.123,"sellVol":0.009,"tradeCount":32}';

// Path to the real collected day file (pipeline sanity check, NOT a study).
const REAL_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  'data',
  'orderflow',
  'BTCUSDT_2026-06-11.ndjson',
);

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    ts: 1_000,
    mid: 62_700,
    spreadBps: 0.02,
    bidDepth5: 1,
    askDepth5: 1,
    imb5: 0,
    imb25: 0,
    buyVol: 0,
    sellVol: 0,
    tradeCount: 0,
    ...overrides,
  };
}

describe('parseSnapshotLine', () => {
  it('parses a real line that includes the optional liquidation fields', () => {
    const s = parseSnapshotLine(REAL_LINE_WITH_LIQ);
    expect(s.ts).toBe(1781162774485);
    expect(s.mid).toBe(62707.95);
    expect(s.spreadBps).toBe(0.02);
    expect(s.bidDepth5).toBe(1.379);
    expect(s.askDepth5).toBe(0.745);
    expect(s.imb5).toBe(0.298);
    expect(s.imb25).toBe(0.615);
    expect(s.tradeCount).toBe(0);
    expect(s.liqBuy).toBe(0);
    expect(s.liqSell).toBe(0);
    expect(s.liqCount).toBe(0);
  });

  it('parses a real line that omits the optional liquidation fields', () => {
    const s = parseSnapshotLine(REAL_LINE_NO_LIQ);
    expect(s.buyVol).toBe(0.123);
    expect(s.sellVol).toBe(0.009);
    expect(s.tradeCount).toBe(32);
    // Optional fields stay undefined rather than defaulting to 0.
    expect(s.liqBuy).toBeUndefined();
    expect(s.liqSell).toBeUndefined();
    expect(s.liqCount).toBeUndefined();
  });

  it('throws on malformed JSON', () => {
    expect(() => parseSnapshotLine('{not json')).toThrow();
  });

  it('throws when a core field is missing / non-finite', () => {
    expect(() => parseSnapshotLine('{"ts":1,"mid":"x"}')).toThrow(/mid/);
  });
});

describe('snapshotOFI — sign convention (CKS proxy)', () => {
  it('is POSITIVE when bid depth rises and mid moves up', () => {
    const prev = makeSnapshot({ mid: 62_700, bidDepth5: 1, askDepth5: 1 });
    const cur = makeSnapshot({ mid: 62_710, bidDepth5: 3, askDepth5: 1 });
    const ofi = snapshotOFI(prev, cur);
    expect(ofi.value).toBeGreaterThan(0);
    expect(ofi.bidComponent).toBeCloseTo(2, 9);
    expect(ofi.askComponent).toBeCloseTo(0, 9);
    expect(ofi.midDirection).toBe(1);
  });

  it('is NEGATIVE when ask depth rises and mid moves down', () => {
    const prev = makeSnapshot({ mid: 62_710, bidDepth5: 1, askDepth5: 1 });
    const cur = makeSnapshot({ mid: 62_700, bidDepth5: 1, askDepth5: 3 });
    const ofi = snapshotOFI(prev, cur);
    expect(ofi.value).toBeLessThan(0);
    expect(ofi.askComponent).toBeCloseTo(-2, 9);
    expect(ofi.midDirection).toBe(-1);
  });

  it('reports midDirection 0 on a flat mid', () => {
    const prev = makeSnapshot({ mid: 62_700 });
    const cur = makeSnapshot({ mid: 62_700, bidDepth5: 2 });
    expect(snapshotOFI(prev, cur).midDirection).toBe(0);
  });
});

describe('cvdDelta / cumulativeCVD', () => {
  it('cvdDelta is buyVol - sellVol', () => {
    expect(cvdDelta(makeSnapshot({ buyVol: 0.5, sellVol: 0.2 }))).toBeCloseTo(0.3, 9);
    expect(cvdDelta(makeSnapshot({ buyVol: 0.1, sellVol: 0.4 }))).toBeCloseTo(-0.3, 9);
  });

  it('accumulates monotonically on an all-buy fixture', () => {
    const snaps = [
      makeSnapshot({ buyVol: 1, sellVol: 0 }),
      makeSnapshot({ buyVol: 2, sellVol: 0 }),
      makeSnapshot({ buyVol: 0.5, sellVol: 0 }),
    ];
    const cvd = cumulativeCVD(snaps);
    expect(cvd).toEqual([1, 3, 3.5]);
    // strictly increasing because every window is net-buy
    for (let i = 1; i < cvd.length; i++) {
      expect(cvd[i]!).toBeGreaterThan(cvd[i - 1]!);
    }
  });

  it('decreases on net-sell windows and nets to the running total', () => {
    const snaps = [
      makeSnapshot({ buyVol: 1, sellVol: 0 }), // +1 -> 1
      makeSnapshot({ buyVol: 0, sellVol: 3 }), // -3 -> -2
      makeSnapshot({ buyVol: 0.5, sellVol: 0 }), // +0.5 -> -1.5
    ];
    expect(cumulativeCVD(snaps)).toEqual([1, -2, -1.5]);
  });

  it('returns an empty array for no snapshots', () => {
    expect(cumulativeCVD([])).toEqual([]);
  });
});

describe('microprice (Stoikov, explicit L1 sizes)', () => {
  const BID = 100;
  const ASK = 101;

  it('lies strictly between bid and ask', () => {
    const mp = microprice(BID, ASK, 3, 7);
    expect(mp).toBeGreaterThan(BID);
    expect(mp).toBeLessThan(ASK);
  });

  it('skews toward the ask (up) when the bid queue is heavier', () => {
    const mid = (BID + ASK) / 2;
    const mp = microprice(BID, ASK, 9, 1); // heavy bid
    expect(mp).toBeGreaterThan(mid);
  });

  it('skews toward the bid (down) when the ask queue is heavier', () => {
    const mid = (BID + ASK) / 2;
    const mp = microprice(BID, ASK, 1, 9); // heavy ask
    expect(mp).toBeLessThan(mid);
  });

  it('equals the mid when both queues are equal', () => {
    expect(microprice(BID, ASK, 5, 5)).toBeCloseTo((BID + ASK) / 2, 9);
  });

  it('falls back to the mid when total size is zero', () => {
    expect(microprice(BID, ASK, 0, 0)).toBeCloseTo((BID + ASK) / 2, 9);
  });

  it('micropriceFromDepth (proxy) lies within the reconstructed spread', () => {
    const s = makeSnapshot({ mid: 62_700, spreadBps: 1, bidDepth5: 9, askDepth5: 1 });
    const half = (s.mid * s.spreadBps) / 1e4 / 2;
    const mp = micropriceFromDepth(s);
    expect(mp).toBeGreaterThanOrEqual(s.mid - half);
    expect(mp).toBeLessThanOrEqual(s.mid + half);
    // heavy bid depth -> skews above mid
    expect(mp).toBeGreaterThan(s.mid);
  });
});

describe('bookImbalance', () => {
  it('returns the stored imb5 / imb25 by level', () => {
    const s = makeSnapshot({ imb5: 0.3, imb25: -0.4 });
    expect(bookImbalance(s)).toBe(0.3);
    expect(bookImbalance(s, 5)).toBe(0.3);
    expect(bookImbalance(s, 25)).toBe(-0.4);
  });

  it('recomputes top-5 imbalance from depth and matches the formula', () => {
    const s = makeSnapshot({ bidDepth5: 3, askDepth5: 1 });
    expect(bookImbalanceFromDepth(s)).toBeCloseTo((3 - 1) / (3 + 1), 9);
  });

  it('returns 0 imbalance when total depth is 0', () => {
    expect(bookImbalanceFromDepth(makeSnapshot({ bidDepth5: 0, askDepth5: 0 }))).toBe(0);
  });
});

describe('loadOrderflowDay (IO) — tiny temp fixture', () => {
  let tmpFile: string;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofi-fixture-'));
    tmpFile = path.join(dir, 'fixture.ndjson');
    fs.writeFileSync(
      tmpFile,
      `${REAL_LINE_WITH_LIQ}\n${REAL_LINE_NO_LIQ}\n\n`, // trailing blank line ignored
    );
  });

  afterAll(() => {
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it('streams an NDJSON file into typed snapshots, skipping blank lines', async () => {
    const snaps = await loadOrderflowDay(tmpFile);
    expect(snaps).toHaveLength(2);
    expect(snaps[0]!.liqBuy).toBe(0);
    expect(snaps[1]!.tradeCount).toBe(32);
  });

  it('throws on malformed lines in strict mode, but skips them when asked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofi-bad-'));
    const bad = path.join(dir, 'bad.ndjson');
    fs.writeFileSync(bad, `${REAL_LINE_NO_LIQ}\n{truncated`);
    await expect(loadOrderflowDay(bad)).rejects.toThrow();

    let skipped = 0;
    const snaps = await loadOrderflowDay(bad, { skipMalformed: true, onSkip: () => skipped++ });
    expect(snaps).toHaveLength(1);
    expect(skipped).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// END-TO-END SANITY CHECK on the REAL collected file.
// This asserts the pipeline RUNS and produces finite features at scale — it is
// explicitly NOT a predictive / edge claim (that study is deferred until
// >=30-60d of data; see experiments/microstructure-pipeline.md).
// ─────────────────────────────────────────────────────────────────────────────
describe('REAL-file pipeline sanity check (no predictive claim)', () => {
  const exists = fs.existsSync(REAL_FILE);
  const maybe = exists ? it : it.skip;

  maybe('loads >1000 snapshots with all-finite features and prints summary stats', async () => {
    const snaps = await loadOrderflowDay(REAL_FILE, { skipMalformed: true });
    expect(snaps.length).toBeGreaterThan(1000);

    let spreadSum = 0;
    let ofiMin = Infinity;
    let ofiMax = -Infinity;
    let mpMin = Infinity;
    let mpMax = -Infinity;
    let imbMin = Infinity;
    let imbMax = -Infinity;

    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i]!;
      // every core feature must be finite
      expect(Number.isFinite(s.mid)).toBe(true);
      expect(Number.isFinite(s.spreadBps)).toBe(true);
      spreadSum += s.spreadBps;

      const mp = micropriceFromDepth(s);
      expect(Number.isFinite(mp)).toBe(true);
      mpMin = Math.min(mpMin, mp);
      mpMax = Math.max(mpMax, mp);

      const imb = bookImbalance(s);
      expect(Number.isFinite(imb)).toBe(true);
      expect(imb).toBeGreaterThanOrEqual(-1.0001);
      expect(imb).toBeLessThanOrEqual(1.0001);
      imbMin = Math.min(imbMin, imb);
      imbMax = Math.max(imbMax, imb);

      if (i > 0) {
        const ofi = snapshotOFI(snaps[i - 1]!, s);
        expect(Number.isFinite(ofi.value)).toBe(true);
        ofiMin = Math.min(ofiMin, ofi.value);
        ofiMax = Math.max(ofiMax, ofi.value);
      }
    }

    const cvd = cumulativeCVD(snaps);
    expect(cvd).toHaveLength(snaps.length);
    expect(Number.isFinite(cvd[cvd.length - 1]!)).toBe(true);

    console.log(
      [
        '\n[microstructure sanity] BTCUSDT_2026-06-11.ndjson',
        `  snapshots:        ${snaps.length}`,
        `  mean spreadBps:   ${(spreadSum / snaps.length).toFixed(4)}`,
        `  snapshotOFI range:[${ofiMin.toFixed(3)}, ${ofiMax.toFixed(3)}]`,
        `  microprice range: [${mpMin.toFixed(2)}, ${mpMax.toFixed(2)}]`,
        `  imb5 range:       [${imbMin.toFixed(3)}, ${imbMax.toFixed(3)}]`,
        `  final cumulativeCVD: ${cvd[cvd.length - 1]!.toFixed(3)} (BTC, descriptive only)`,
        '  NOTE: descriptive sanity stats only — NO predictive verdict drawn.',
      ].join('\n'),
    );
  });
});
