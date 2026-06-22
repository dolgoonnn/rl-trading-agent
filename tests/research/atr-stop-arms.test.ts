import { describe, it, expect } from 'vitest';
import {
  simulateBaseline,
  simulateAtrFloor,
  simulateChandelier,
  simulateVerticalBarrier,
  type Candle,
  type RateAt,
} from '@/lib/research/atr-stop-arms';

const HOUR_MS = 3_600_000;
// 2024-01-01T00:00:00.000Z — a clean UTC day start (00:00 settlement instant).
const DAY0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

/** Build a candle at bar index `i` (1 bar = 1 hour) with explicit OHLC. */
function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { timestamp: DAY0 + i * HOUR_MS, open: o, high: h, low: l, close: c };
}

const NO_FUNDING: RateAt = () => 0;

describe('ARM C chandelier — exit at the trail when price retraces k·ATR below the peak', () => {
  it('a long that rises then retraces k·ATR below the highest high exits at the chandelier level with the correct R', () => {
    // entry = 100, original stop 95 (slDist = 5 → 1R = 5). ATR = 2, k = 1.5 ⇒ gap = 3.
    // Price climbs to a high of 120 (peak), then a later bar's low drops to 116
    // (= 120 − 4) which is ≤ trail (120 − 3 = 117) ⇒ exit at the trail = 117.
    // R = (117 − 100) / 5 = 3.4.
    const entry = 100;
    const sl = 95;
    const atr = 2;
    const k = 1.5;
    const candles: Candle[] = [
      bar(0, 100, 101, 99, 100), // entry bar (idx 0)
      bar(1, 100, 110, 100, 109), // rises, high 110 → trail 107
      bar(2, 109, 120, 108, 118), // peak high 120 → trail 117
      bar(3, 118, 119, 116, 116), // low 116 ≤ trail 117 ⇒ exit at 117
      bar(4, 116, 130, 115, 129), // (would keep running, but we already exited)
    ];
    const out = simulateChandelier({
      candles,
      entryIdx: 0,
      direction: 'long',
      entry,
      sl,
      atr,
      k,
      maxBars: 10,
      rateAt: NO_FUNDING,
    });
    expect(out.exitReason).toBe('trailing_stop');
    expect(out.exitPrice).toBeCloseTo(117, 9);
    expect(out.grossR).toBeCloseTo(3.4, 9);
    expect(out.barsHeld).toBe(3);
  });

  it('mirrors for a short: trail = lowest-low + k·ATR, exit when a bar crosses up', () => {
    // entry = 100, original stop 105 (slDist = 5). ATR = 2, k = 1.5 ⇒ gap = 3.
    // Price falls to a low of 80 (trough), then a bar's high rises to 84 ≥ trail (80 + 3 = 83) ⇒ exit at 83.
    // short R = (entry − exit) / slDist = (100 − 83) / 5 = 3.4.
    const candles: Candle[] = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 100, 90, 91), // low 90 → trail 93
      bar(2, 91, 92, 80, 82), // trough low 80 → trail 83
      bar(3, 82, 84, 81, 83), // high 84 ≥ trail 83 ⇒ exit at 83
    ];
    const out = simulateChandelier({
      candles,
      entryIdx: 0,
      direction: 'short',
      entry: 100,
      sl: 105,
      atr: 2,
      k: 1.5,
      maxBars: 10,
      rateAt: NO_FUNDING,
    });
    expect(out.exitReason).toBe('trailing_stop');
    expect(out.exitPrice).toBeCloseTo(83, 9);
    expect(out.grossR).toBeCloseTo(3.4, 9);
    // Trail ratchets to 83 using bar-2's low, then bar-3's high (84) crosses it.
    // Conservative intrabar order: the trail formed FROM a bar's low is not
    // crossed by that same bar's high ⇒ exit is bar 3, not bar 2.
    expect(out.barsHeld).toBe(3);
  });
});

describe('ARM D vertical_barrier — time-stop at bar N when no SL/TP hit', () => {
  it('no SL or TP touched within N bars ⇒ exit at the bar-N close', () => {
    // entry 100, sl 90, tp 130. Price drifts within (90, 130) for the whole
    // horizon ⇒ no barrier hit ⇒ exit at bar-N close.
    const entry = 100;
    const sl = 90;
    const tp = 130;
    const candles: Candle[] = [
      bar(0, 100, 101, 99, 100), // entry
      bar(1, 100, 105, 98, 102),
      bar(2, 102, 108, 100, 104),
      bar(3, 104, 109, 101, 106), // bar-3 close = 106 ← horizon exit (N=3)
      bar(4, 106, 140, 105, 138), // beyond horizon; must NOT be reached
    ];
    const out = simulateVerticalBarrier({
      candles,
      entryIdx: 0,
      direction: 'long',
      entry,
      sl,
      tp,
      horizonBars: 3,
      rateAt: NO_FUNDING,
    });
    expect(out.exitReason).toBe('time_stop');
    expect(out.exitPrice).toBeCloseTo(106, 9);
    expect(out.barsHeld).toBe(3);
    // R = (106 − 100) / (100 − 90) = 0.6
    expect(out.grossR).toBeCloseTo(0.6, 9);
  });
});

describe('funding debit — net R falls below gross R by the funding paid, and longer holds pay more', () => {
  // Constant positive funding: every 00/08/16 settlement resolves to +10bp.
  const RATE = 0.001;
  const posFunding: RateAt = () => RATE;

  it('a long held across 3 positive-funding settlements has meanNetR < grossR by the funding amount', () => {
    // entry exactly at 2024-01-01 00:00, slDist = 5, 1R = 5 (= 5% of the 100 entry).
    // Hold to 2024-01-02 01:00 ⇒ crosses 08:00, 16:00 (day0) + 00:00 (day1) = 3 settlements.
    // funding fraction = -(3·RATE) = -0.003 (long pays). In R: fundingR = -0.003 · entry/slDist
    //                  = -0.003 · 100/5 = -0.06 R.
    const entry = 100;
    const sl = 95; // slDist 5
    const tp = 130;
    // Build 26 hourly bars (idx 0 = 00:00 day0 … idx 25 = 01:00 day1) that never
    // hit SL or TP, so the vertical barrier marks-to-close at the horizon.
    const candles: Candle[] = [];
    for (let i = 0; i <= 25; i++) candles.push(bar(i, 100, 102, 99, 100));
    const horizon = 25; // 25 bars after entry = 01:00 next day

    const grossArm = simulateVerticalBarrier({
      candles,
      entryIdx: 0,
      direction: 'long',
      entry,
      sl,
      tp,
      horizonBars: horizon,
      rateAt: NO_FUNDING,
    });
    const netArm = simulateVerticalBarrier({
      candles,
      entryIdx: 0,
      direction: 'long',
      entry,
      sl,
      tp,
      horizonBars: horizon,
      rateAt: posFunding,
    });
    // 3 settlements crossed, long pays.
    const expectedFundingR = -(3 * RATE) * (entry / 5); // -0.06
    expect(netArm.fundingR).toBeCloseTo(expectedFundingR, 9);
    expect(netArm.netR).toBeCloseTo(grossArm.grossR + expectedFundingR, 9);
    expect(netArm.netR).toBeLessThan(grossArm.grossR);
  });

  it('the longer-hold arm pays MORE funding than the shorter baseline over the same trade', () => {
    // Same entry; a SHORT-horizon vertical-barrier crosses fewer settlements than
    // a LONG-horizon one ⇒ the longer arm shows more (more negative) funding.
    const entry = 100;
    const sl = 95;
    const tp = 130;
    const candles: Candle[] = [];
    for (let i = 0; i <= 25; i++) candles.push(bar(i, 100, 102, 99, 100));

    // Short hold: entry 00:00 → exit 07:00 (idx 7) crosses NO settlement (08:00 not yet).
    const shortArm = simulateVerticalBarrier({
      candles,
      entryIdx: 0,
      direction: 'long',
      entry,
      sl,
      tp,
      horizonBars: 7,
      rateAt: posFunding,
    });
    // Long hold: entry 00:00 → exit 01:00 next day (idx 25) crosses 3 settlements.
    const longArm = simulateVerticalBarrier({
      candles,
      entryIdx: 0,
      direction: 'long',
      entry,
      sl,
      tp,
      horizonBars: 25,
      rateAt: posFunding,
    });
    expect(shortArm.fundingR).toBeCloseTo(0, 9); // no settlement crossed
    expect(longArm.fundingR).toBeLessThan(shortArm.fundingR); // longer arm pays more (more negative)
    expect(longArm.barsHeld).toBeGreaterThan(shortArm.barsHeld);
  });
});

describe('ARM B atr_floor — RR-preservation invariant', () => {
  it('widened stop keeps reward:risk equal to the original RR', () => {
    // entry 100, sl 98 (slDist 2), tp 106 (tpDist 6) ⇒ RR = 3.
    // ATR = 5, k = 1.5 ⇒ k·ATR = 7.5 > 2 ⇒ newSlDist = 7.5, newTpDist must = 22.5
    // (RR preserved). With a TP-hit, R measured vs the WIDENED risk = +RR = +3.
    const entry = 100;
    const sl = 98;
    const tp = 106;
    const k = 1.5;
    // Need ≥14 bars of history for ATR. Build a flat warmup with TR ≈ 5/bar,
    // then a bar that tags the widened TP (100 + 22.5 = 122.5).
    const candles: Candle[] = [];
    // 15 warmup bars (idx 0..14) each with a 5-wide range so ATR14 = 5, and the
    // entry bar (idx 14) has idx ≥ period so ATR14 is computable (not 0).
    for (let i = 0; i < 15; i++) candles.push(bar(i, 100, 102.5, 97.5, 100));
    const entryIdx = 14;
    // entry bar is idx 14 (close 100). Next bar spikes up to ≥122.5 to hit widened TP.
    candles.push(bar(15, 100, 123, 99, 122)); // idx 15: high 123 ≥ 122.5 ⇒ TP

    const out = simulateAtrFloor({
      candles,
      entryIdx,
      direction: 'long',
      entry,
      sl,
      tp,
      k,
      maxBars: 10,
      rateAt: NO_FUNDING,
    });
    expect(out.exitReason).toBe('take_profit');
    // RR preserved ⇒ a TP hit pays exactly +RR (=3) in R units vs the widened risk.
    expect(out.grossR).toBeCloseTo(3, 9);
    expect(out.exitPrice).toBeCloseTo(122.5, 9);
  });

  it('when k·ATR is below the original stop the floor is a no-op (stop unchanged, RR unchanged)', () => {
    const entry = 100;
    const sl = 90; // slDist 10
    const tp = 130; // RR 3
    const k = 1.0;
    const candles: Candle[] = [];
    for (let i = 0; i < 15; i++) candles.push(bar(i, 100, 101, 99, 100)); // ATR14 = 2 ⇒ k·ATR = 2 < 10
    const entryIdx = 14;
    candles.push(bar(15, 100, 131, 99, 130)); // hits original TP 130

    const out = simulateAtrFloor({
      candles,
      entryIdx,
      direction: 'long',
      entry,
      sl,
      tp,
      k,
      maxBars: 10,
      rateAt: NO_FUNDING,
    });
    expect(out.exitReason).toBe('take_profit');
    expect(out.grossR).toBeCloseTo(3, 9); // unchanged RR
  });
});

describe('ARM A baseline — sanity', () => {
  it('a clean TP hit pays the stored RR; SL hit pays −1R', () => {
    const candles: Candle[] = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 131, 100, 130), // hits TP 130
    ];
    const tpOut = simulateBaseline({ candles, entryIdx: 0, direction: 'long', entry: 100, sl: 90, tp: 130, maxBars: 10, rateAt: NO_FUNDING });
    expect(tpOut.exitReason).toBe('take_profit');
    expect(tpOut.grossR).toBeCloseTo(3, 9); // (130-100)/(100-90)

    const slCandles: Candle[] = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 100, 89, 90), // hits SL 90
    ];
    const slOut = simulateBaseline({ candles: slCandles, entryIdx: 0, direction: 'long', entry: 100, sl: 90, tp: 130, maxBars: 10, rateAt: NO_FUNDING });
    expect(slOut.exitReason).toBe('stop_loss');
    expect(slOut.grossR).toBeCloseTo(-1, 9);
  });
});
