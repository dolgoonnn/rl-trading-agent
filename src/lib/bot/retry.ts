/**
 * Retry with exponential backoff + full jitter for exchange REST calls.
 *
 * Motivation: the 2026-06-27 outage — a DNS blip (`getaddrinfo ENOTFOUND
 * api.bybit.com`) crashed the bot during startup backfill; PM2 restarted it
 * into the same dead network until max_restarts was exhausted, leaving the
 * paper pipeline down for 8 days. Transient network failures must be ridden
 * out in-process, not escalated to process death.
 *
 * Classification is deliberately conservative: only errors with a known
 * transient signature are retried; anything else (auth, params, application
 * bugs) throws immediately.
 */

/** Bybit API responded but with a non-zero retCode. */
export class BybitApiError extends Error {
  readonly retCode: number;

  constructor(retMsg: string, retCode: number) {
    super(`Bybit API error: ${retMsg} (code: ${retCode})`);
    this.name = 'BybitApiError';
    this.retCode = retCode;
  }
}

/** Transient Bybit retCodes: 10002 recv_window/expired, 10006 rate limit, 10016 system error. */
const RETRYABLE_BYBIT_CODES = new Set([10002, 10006, 10016]);

/** Transient Node network/DNS error codes. */
const RETRYABLE_NET_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const RETRYABLE_MESSAGE = /socket hang up|network error|fetch failed|timeout/i;

function statusOf(err: Error): number | undefined {
  const withStatus = err as Error & { status?: unknown; statusCode?: unknown };
  const raw = withStatus.statusCode ?? withStatus.status;
  return typeof raw === 'number' ? raw : undefined;
}

/**
 * Walks the error and its `cause` chain (axios/undici wrap DNS errors) looking
 * for a transient signature: known net code, HTTP 5xx/429, transient Bybit
 * retCode, or a transient message.
 */
export function isRetryableError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof BybitApiError) {
      return RETRYABLE_BYBIT_CODES.has(current.retCode);
    }
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && RETRYABLE_NET_CODES.has(code)) return true;
    const status = statusOf(current);
    if (status !== undefined && (status >= 500 || status === 429)) return true;
    if (RETRYABLE_MESSAGE.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

export interface RetryOptions {
  /** Attempts including the first call. Number.POSITIVE_INFINITY = keep trying (startup paths). Default 5. */
  maxAttempts?: number;
  /** First backoff delay. Default 1000ms. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 60_000ms. */
  maxDelayMs?: number;
  /** Called before each sleep with the error, 1-based attempt number, and chosen delay. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Override which errors are retried. Default isRetryableError. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0,1]. Default Math.random. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Runs `fn`, retrying transient failures with exponential backoff + full
 * jitter: delay = random() * min(maxDelayMs, baseDelayMs * 2^(attempt-1)).
 * Non-retryable errors and the final failed attempt rethrow.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 1000,
    maxDelayMs = 60_000,
    onRetry,
    isRetryable = isRetryableError,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = random() * ceiling;
      onRetry?.(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
