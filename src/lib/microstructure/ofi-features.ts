/**
 * Order-flow microstructure features — GROUNDED feature-extraction pipeline.
 *
 * SCOPE: pure, dependency-injected feature math + a thin IO loader. This module
 * builds reusable INFRASTRUCTURE; it draws NO predictive / edge / Sharpe
 * conclusion. A net-of-cost predictive study is deliberately DEFERRED until
 * >=30-60 days of data accrue (see experiments/microstructure-pipeline.md). The
 * project canon forbids underpowered microstructure verdicts, and the prior on
 * order-book scalp signals is already negative (OBI/CVD scalp OOS Sharpe 0.12).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GROUNDING — Order Flow Imbalance (OFI)
 * Cont, Kukanov & Stoikov, "The Price Impact of Order Book Events",
 *   Journal of Financial Econometrics 12(1):47-88 (2014). arXiv:1011.6402.
 *
 * Classical OFI is the cumulative sum of SIGNED best-bid/ask QUEUE-SIZE changes
 * over an interval, computed event-by-event from L1 updates:
 *   - increases when the bid size increases, the ask size decreases, or the
 *     best bid/ask PRICE moves up;
 *   - decreases on the opposite events.
 * Empirically OFI has a near-linear contemporaneous relation to price change
 * with slope ~ inverse market depth; the paper reports R^2 >= 50% for 44/50
 * stocks. That contemporaneous fit is partly TAUTOLOGICAL (trades that move
 * price ARE the OFI) — it is NOT a free forecast, and nothing here claims one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE 1s SNAPSHOTS LET US COMPUTE (and what they DON'T)
 * The collector (scripts/collect-btc-orderflow.ts) writes ONE aggregated
 * snapshot per second. It does NOT store event-level L1 updates and does NOT
 * store the best-bid/ask queue SIZES separately — only top-5 / top-25 DEPTH
 * aggregates. Consequences:
 *   - We CANNOT compute true event-level OFI. We compute a SNAPSHOT-level OFI
 *     PROXY from the change in top-5 depth aggregates + the mid move between two
 *     consecutive 1s snapshots. This collapses every event within a 1s window
 *     into a single net delta and uses aggregated depth rather than the L1
 *     queue, so it is a coarse approximation of the Cont-Kukanov-Stoikov OFI.
 *   - We CANNOT compute the true Stoikov microprice (needs best-bid/ask SIZE).
 *     We compute a DEPTH-WEIGHTED microprice proxy using bidDepth5/askDepth5 as
 *     stand-ins for the L1 queue sizes — see micropriceFromDepth().
 *   - We CAN compute cumulative volume delta (CVD): buyVol/sellVol (aggressor-
 *     signed taker volume per 1s window) ARE in the schema.
 *   - We CAN read book imbalance directly: imb5/imb25 are precomputed
 *     (bidDepth - askDepth)/(bidDepth + askDepth) at 5 and 25 levels.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One 1s order-flow snapshot, exactly as written by collect-btc-orderflow.ts.
 *
 * Core depth/trade fields are ALWAYS present. The liquidation fields
 * (liqBuy/liqSell/liqCount) are OPTIONAL: the collector only emits them once it
 * has received liquidation events, so earlier lines in a day file may omit them
 * (verified: 27238 lines with vs 20917 without in BTCUSDT_2026-06-11.ndjson).
 */
export interface Snapshot {
  /** epoch ms (Date.now() at snapshot time) */
  ts: number;
  /** (bestBid + bestAsk) / 2 */
  mid: number;
  /** (bestAsk - bestBid) / mid * 1e4, in basis points */
  spreadBps: number;
  /** summed resting size over the top 5 bid levels (base units, e.g. BTC) */
  bidDepth5: number;
  /** summed resting size over the top 5 ask levels (base units, e.g. BTC) */
  askDepth5: number;
  /** (bidDepth5 - askDepth5) / (bidDepth5 + askDepth5), in [-1, 1] */
  imb5: number;
  /** top-25-level book imbalance, in [-1, 1] */
  imb25: number;
  /** aggressor-buy (taker-buy) volume since previous snapshot, base units */
  buyVol: number;
  /** aggressor-sell (taker-sell) volume since previous snapshot, base units */
  sellVol: number;
  /** number of public trades since previous snapshot */
  tradeCount: number;
  /** forced shorts (buy-side liquidations) since previous snapshot — OPTIONAL */
  liqBuy?: number;
  /** forced longs (sell-side liquidations) since previous snapshot — OPTIONAL */
  liqSell?: number;
  /** number of liquidation events since previous snapshot — OPTIONAL */
  liqCount?: number;
}

/** Snapshot-level OFI proxy decomposition (see snapshotOFI). */
export interface SnapshotOFI {
  /** signed bid-side contribution: +Δ resting bid depth (demand added) */
  bidComponent: number;
  /** signed ask-side contribution: -Δ resting ask depth (supply added => negative) */
  askComponent: number;
  /** sign of the mid move between the two snapshots: -1 | 0 | +1 */
  midDirection: -1 | 0 | 1;
  /**
   * Snapshot OFI proxy = bidComponent + askComponent. Positive => net demand
   * pressure (bid depth grew and/or ask depth shrank) over the 1s window.
   * NOT event-level OFI — see module header caveat.
   */
  value: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing (pure)
// ─────────────────────────────────────────────────────────────────────────────

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Snapshot field "${field}" is not a finite number: ${String(value)}`);
  }
  return value;
}

function asOptionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return asFiniteNumber(value, field);
}

/**
 * Parse one NDJSON line into a typed Snapshot. Throws on malformed JSON or a
 * missing/non-finite CORE field; optional liquidation fields may be absent.
 * Pure: no IO.
 */
export function parseSnapshotLine(line: string): Snapshot {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Snapshot line is not a JSON object');
  }
  const o = parsed as Record<string, unknown>;
  return {
    ts: asFiniteNumber(o.ts, 'ts'),
    mid: asFiniteNumber(o.mid, 'mid'),
    spreadBps: asFiniteNumber(o.spreadBps, 'spreadBps'),
    bidDepth5: asFiniteNumber(o.bidDepth5, 'bidDepth5'),
    askDepth5: asFiniteNumber(o.askDepth5, 'askDepth5'),
    imb5: asFiniteNumber(o.imb5, 'imb5'),
    imb25: asFiniteNumber(o.imb25, 'imb25'),
    buyVol: asFiniteNumber(o.buyVol, 'buyVol'),
    sellVol: asFiniteNumber(o.sellVol, 'sellVol'),
    tradeCount: asFiniteNumber(o.tradeCount, 'tradeCount'),
    liqBuy: asOptionalFiniteNumber(o.liqBuy, 'liqBuy'),
    liqSell: asOptionalFiniteNumber(o.liqSell, 'liqSell'),
    liqCount: asOptionalFiniteNumber(o.liqCount, 'liqCount'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature math (pure, typed, no IO)
// ─────────────────────────────────────────────────────────────────────────────

function sign(x: number): -1 | 0 | 1 {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

/**
 * Snapshot-level OFI PROXY between two consecutive 1s snapshots.
 *
 * This APPROXIMATES the Cont-Kukanov-Stoikov OFI using the only book state we
 * persist — the aggregated top-5 depth — instead of the L1 best-bid/ask queue,
 * and over a 1s window instead of per event. Following the CKS sign convention:
 *   - rising bid depth contributes POSITIVELY (demand added at the bid),
 *   - rising ask depth contributes NEGATIVELY (supply added at the ask).
 * value = ΔbidDepth5 - ΔaskDepth5. midDirection is reported separately as a
 * cross-check (true event OFI also flips sign on best-price moves; we cannot
 * attribute the depth change to a price move vs a size change from snapshots
 * alone, so price direction is surfaced but not folded into `value`).
 *
 * Pure. Caller supplies prev & cur.
 */
export function snapshotOFI(prev: Snapshot, cur: Snapshot): SnapshotOFI {
  const bidComponent = cur.bidDepth5 - prev.bidDepth5;
  const askComponent = -(cur.askDepth5 - prev.askDepth5);
  return {
    bidComponent,
    askComponent,
    midDirection: sign(cur.mid - prev.mid),
    value: bidComponent + askComponent,
  };
}

/**
 * Signed taker volume delta for a single snapshot window:
 *   buyVol - sellVol  (positive => aggressor buyers dominated this 1s window).
 * Pure.
 */
export function cvdDelta(snapshot: Snapshot): number {
  return snapshot.buyVol - snapshot.sellVol;
}

/**
 * Cumulative volume delta over a sequence of snapshots — running sum of
 * per-window cvdDelta. Index i holds CVD through snapshots[0..i].
 * Pure; returns a new array of the same length as the input.
 */
export function cumulativeCVD(snapshots: readonly Snapshot[]): number[] {
  const out: number[] = new Array(snapshots.length);
  let running = 0;
  for (let i = 0; i < snapshots.length; i++) {
    running += cvdDelta(snapshots[i]!);
    out[i] = running;
  }
  return out;
}

/**
 * Stoikov size-weighted microprice from EXPLICIT best-bid/ask prices & sizes:
 *   microprice = (ask * bidSize + bid * askSize) / (bidSize + askSize)
 * It skews toward the side with the HEAVIER queue (more bid size => price
 * pulled toward the ask, i.e. upward), reflecting where the mid is likely to
 * move next.
 *
 * NOTE: our 1s snapshots do NOT store L1 best-bid/ask SIZE, so this exact
 * function cannot be fed from the collected data — it is provided for L1 data
 * (e.g. live bot book state) and for testing the invariants. For snapshot data,
 * use micropriceFromDepth(), which substitutes top-5 depth for queue size.
 * Pure. Falls back to the simple mid when total size is zero.
 */
export function microprice(
  bid: number,
  ask: number,
  bidSize: number,
  askSize: number,
): number {
  const total = bidSize + askSize;
  if (total <= 0) return (bid + ask) / 2;
  return (ask * bidSize + bid * askSize) / total;
}

/**
 * Depth-weighted microprice PROXY computable from a 1s Snapshot.
 *
 * Reconstructs best bid/ask from mid +/- half-spread (spreadBps is the only
 * spread info we keep) and substitutes bidDepth5/askDepth5 for the L1 queue
 * sizes. This is a PROXY for the Stoikov microprice — top-5 depth is a coarser,
 * deeper aggregate than the best-level queue, so the skew is attenuated vs a
 * true L1 microprice. Pure.
 */
export function micropriceFromDepth(snapshot: Snapshot): number {
  const halfSpread = (snapshot.mid * snapshot.spreadBps) / 1e4 / 2;
  const bid = snapshot.mid - halfSpread;
  const ask = snapshot.mid + halfSpread;
  return microprice(bid, ask, snapshot.bidDepth5, snapshot.askDepth5);
}

/**
 * Book imbalance in [-1, 1]. Prefers the precomputed top-5 imbalance (imb5);
 * pass `levels: 25` to read the top-25 imbalance (imm25). Both are already
 * (bidDepth - askDepth)/(bidDepth + askDepth) and are returned as-is.
 * Pure.
 */
export function bookImbalance(snapshot: Snapshot, levels: 5 | 25 = 5): number {
  return levels === 25 ? snapshot.imb25 : snapshot.imb5;
}

/**
 * Book imbalance recomputed directly from the top-5 depth aggregates rather
 * than reading the stored imb5. Useful as a cross-check that the stored field
 * matches the depth fields. Pure; returns 0 when total depth is 0.
 */
export function bookImbalanceFromDepth(snapshot: Snapshot): number {
  const total = snapshot.bidDepth5 + snapshot.askDepth5;
  if (total <= 0) return 0;
  return (snapshot.bidDepth5 - snapshot.askDepth5) / total;
}
