/**
 * Deriv Synthetic Indices — Candle Downloader (WebSocket)
 *
 * Pulls historical OHLC candles from Deriv's public WebSocket API
 * (`ticks_history` with `style: "candles"`), paginating backwards in time.
 *
 * IMPORTANT — these are SYNTHETIC instruments:
 * - Boom/Crash/Volatility/Step/Jump indices are audited RNG processes, NOT
 *   real markets. There is no order flow, liquidity, or volume.
 * - The candle response carries NO volume field. We set `volume = 1` (uniform)
 *   so volume-derived indicators (VWAP, volume-ratio) degenerate to neutral /
 *   price-only values instead of dividing by zero. This injects NO information:
 *   uniform weights make VWAP a simple typical-price average and volume-ratio
 *   exactly 1.0 everywhere. The confluence `obVolumeQuality` factor is disabled
 *   by default and also neutral here.
 *
 * No authentication is required for synthetic-index market data; the public
 * app_id 1089 is sufficient for read-only history.
 */

import WebSocket from 'ws';
import type { Candle } from '@/types/candle';

/** Deriv WebSocket endpoint. app_id 1089 is Deriv's public/test id. */
const DERIV_WS_URL = (appId: string) =>
  `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;

/** Max candles Deriv returns per ticks_history request. */
const MAX_PER_REQUEST = 5000;

/** Deriv-supported candle granularities, in seconds. */
export const DERIV_GRANULARITIES = [
  60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400,
] as const;

/** Friendly timeframe token -> granularity seconds. */
export const TF_TO_GRANULARITY: Record<string, number> = {
  '1m': 60,
  '2m': 120,
  '3m': 180,
  '5m': 300,
  '10m': 600,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '8h': 28800,
  '1d': 86400,
};

export interface DerivDownloadProgress {
  totalCandles: number;
  oldestEpoch: number;
  newestEpoch: number;
  requestCount: number;
}

export type DerivProgressCallback = (p: DerivDownloadProgress) => void;

interface DerivCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface DerivResponse {
  msg_type?: string;
  req_id?: number;
  candles?: DerivCandle[];
  error?: { code: string; message: string };
}

export interface DownloadOptions {
  appId?: string;
  onProgress?: DerivProgressCallback;
  /** Delay between sequential requests (ms) to respect shared rate limits. */
  requestDelayMs?: number;
  /** Safety cap on number of paginated requests. */
  maxRequests?: number;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

/**
 * Lightweight request/response correlator over a single Deriv socket.
 * Deriv echoes `req_id`, so we match responses to in-flight requests.
 */
class DerivSocket {
  private ws: WebSocket;
  private nextReqId = 1;
  private pending = new Map<
    number,
    { resolve: (r: DerivResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private ready: Promise<void>;
  private closed = false;

  constructor(appId: string, private readonly timeoutMs: number) {
    this.ws = new WebSocket(DERIV_WS_URL(appId));

    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      let parsed: DerivResponse;
      try {
        parsed = JSON.parse(data.toString()) as DerivResponse;
      } catch {
        return; // ignore unparseable frames
      }
      const reqId = parsed.req_id;
      if (reqId === undefined) return;
      const entry = this.pending.get(reqId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(reqId);
      entry.resolve(parsed);
    });

    this.ws.on('close', () => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Deriv socket closed before response'));
      }
      this.pending.clear();
    });

    this.ws.on('error', (err) => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.pending.clear();
    });
  }

  async connect(): Promise<void> {
    return this.ready;
  }

  request(payload: Record<string, unknown>): Promise<DerivResponse> {
    if (this.closed) return Promise.reject(new Error('Deriv socket is closed'));
    const reqId = this.nextReqId++;
    return new Promise<DerivResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Deriv request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Download historical candles for a Deriv symbol, paginating backwards until
 * `targetCount` candles are collected or the server stops returning older data
 * (retention limit reached).
 *
 * @param symbol        Deriv symbol (e.g. 'BOOM500', 'CRASH1000', 'R_75')
 * @param granularitySec Candle granularity in seconds (see DERIV_GRANULARITIES)
 * @param targetCount   Desired number of candles
 */
export async function downloadDerivCandles(
  symbol: string,
  granularitySec: number,
  targetCount: number,
  opts: DownloadOptions = {},
): Promise<Candle[]> {
  if (!DERIV_GRANULARITIES.includes(granularitySec as (typeof DERIV_GRANULARITIES)[number])) {
    throw new Error(
      `Unsupported granularity ${granularitySec}s. Deriv supports: ${DERIV_GRANULARITIES.join(', ')}`,
    );
  }

  const appId = opts.appId ?? '1089';
  const requestDelayMs = opts.requestDelayMs ?? 600;
  const maxRequests = opts.maxRequests ?? 500;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const socket = new DerivSocket(appId, timeoutMs);
  await socket.connect();

  const byEpoch = new Map<number, Candle>();
  let requestCount = 0;
  let end: number | 'latest' = 'latest';
  let prevOldest = Number.POSITIVE_INFINITY;
  // Track range incrementally — spreading a 100k+ array into Math.min/max
  // overflows the call stack, so never do Math.min(...epochs).
  let oldestSoFar = Number.POSITIVE_INFINITY;
  let newestSoFar = Number.NEGATIVE_INFINITY;

  try {
    while (byEpoch.size < targetCount && requestCount < maxRequests) {
      const res = await socket.request({
        ticks_history: symbol,
        style: 'candles',
        granularity: granularitySec,
        count: MAX_PER_REQUEST,
        end: end === 'latest' ? 'latest' : String(end),
      });

      if (res.error) {
        throw new Error(`Deriv API error [${res.error.code}]: ${res.error.message}`);
      }
      const batch = res.candles ?? [];
      if (batch.length === 0) break; // no more data

      requestCount++;

      for (const c of batch) {
        if (!byEpoch.has(c.epoch)) {
          byEpoch.set(c.epoch, {
            timestamp: c.epoch * 1000, // Deriv epoch is seconds; our Candle uses ms
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: 1, // synthetic indices have no volume — see module header
          });
        }
      }

      // Batch is chronological ascending: [0] is oldest, [last] is newest.
      const oldest = batch[0]!.epoch;
      const newest = batch[batch.length - 1]!.epoch;
      if (oldest < oldestSoFar) oldestSoFar = oldest;
      if (newest > newestSoFar) newestSoFar = newest;

      if (opts.onProgress) {
        opts.onProgress({
          totalCandles: byEpoch.size,
          oldestEpoch: oldestSoFar,
          newestEpoch: newestSoFar,
          requestCount,
        });
      }

      // Stop if we've stopped making progress backwards (retention limit)
      if (oldest >= prevOldest) break;
      prevOldest = oldest;

      // Page backwards: request candles ending just before this batch's oldest
      end = oldest - granularitySec;

      if (end <= 0) break;
      await sleep(requestDelayMs);
    }
  } finally {
    socket.close();
  }

  return [...byEpoch.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
