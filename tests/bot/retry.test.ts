import { describe, it, expect, vi } from 'vitest';
import {
  withRetry,
  isRetryableError,
  BybitApiError,
} from '../../src/lib/bot/retry';

/** Build an error with a `code` property like Node net/dns errors carry. */
function codeError(code: string): Error & { code: string } {
  const err = new Error(`boom: ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

/** Injectable sleep that records requested delays and resolves instantly. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe('isRetryableError — classification', () => {
  it('retries DNS failures (ENOTFOUND) — the June-27 outage signature', () => {
    expect(isRetryableError(codeError('ENOTFOUND'))).toBe(true);
  });

  it('retries DNS failures nested in error.cause (axios/undici wrap them)', () => {
    const wrapper = new Error('request failed');
    (wrapper as Error & { cause: unknown }).cause = codeError('ENOTFOUND');
    expect(isRetryableError(wrapper)).toBe(true);
  });

  it.each(['EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE'])(
    'retries transient network code %s',
    (code) => {
      expect(isRetryableError(codeError(code))).toBe(true);
    },
  );

  it('retries socket hang up / timeout by message when no code present', () => {
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError(new Error('timeout of 10000ms exceeded'))).toBe(true);
  });

  it('retries HTTP 5xx and 429 via statusCode/status fields', () => {
    const e503 = new Error('service unavailable') as Error & { statusCode: number };
    e503.statusCode = 503;
    const e429 = new Error('too many requests') as Error & { status: number };
    e429.status = 429;
    expect(isRetryableError(e503)).toBe(true);
    expect(isRetryableError(e429)).toBe(true);
  });

  it('retries transient Bybit retCodes (10002 recv_window, 10006 rate limit, 10016 system error)', () => {
    expect(isRetryableError(new BybitApiError('request expired', 10002))).toBe(true);
    expect(isRetryableError(new BybitApiError('rate limit', 10006))).toBe(true);
    expect(isRetryableError(new BybitApiError('system error', 10016))).toBe(true);
  });

  it('does NOT retry Bybit auth/param errors (10001, 10003, 10004)', () => {
    expect(isRetryableError(new BybitApiError('params error', 10001))).toBe(false);
    expect(isRetryableError(new BybitApiError('invalid api key', 10003))).toBe(false);
    expect(isRetryableError(new BybitApiError('sign error', 10004))).toBe(false);
  });

  it('does NOT retry plain application errors', () => {
    expect(isRetryableError(new Error('candle parse failed'))).toBe(false);
    expect(isRetryableError('not even an error')).toBe(false);
    expect(isRetryableError(codeError('SOMETHING_ELSE'))).toBe(false);
  });
});

describe('withRetry — behavior', () => {
  it('returns immediately on success without sleeping', async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn, { sleep });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries a retryable error until success', async () => {
    const { sleep } = fakeSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(codeError('ENOTFOUND'))
      .mockRejectedValueOnce(codeError('ECONNRESET'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { sleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('backs off exponentially with jitter, capped at maxDelayMs', async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(codeError('ETIMEDOUT'));
    await expect(
      withRetry(fn, {
        sleep,
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 4000,
        random: () => 1, // deterministic: full jitter at its upper bound
      }),
    ).rejects.toThrow();
    // attempts 1..4 fail then sleep; attempt 5 fails and gives up (no sleep after last)
    expect(delays).toEqual([1000, 2000, 4000, 4000]);
  });

  it('applies full jitter (delay scales with random())', async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn().mockRejectedValueOnce(codeError('ETIMEDOUT')).mockResolvedValue('ok');
    await withRetry(fn, { sleep, baseDelayMs: 1000, random: () => 0.5 });
    expect(delays).toEqual([500]);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const { sleep } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(codeError('ENOTFOUND'));
    await expect(withRetry(fn, { sleep, maxAttempts: 3 })).rejects.toThrow('ENOTFOUND');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry non-retryable errors', async () => {
    const { sleep } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new BybitApiError('invalid api key', 10003));
    await expect(withRetry(fn, { sleep, maxAttempts: 5 })).rejects.toThrow('invalid api key');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('supports effectively-infinite attempts for startup paths', async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    const fn = vi.fn().mockImplementation(() => {
      calls += 1;
      return calls < 12 ? Promise.reject(codeError('ENOTFOUND')) : Promise.resolve('up');
    });
    const result = await withRetry(fn, { sleep, maxAttempts: Number.POSITIVE_INFINITY });
    expect(result).toBe('up');
    expect(fn).toHaveBeenCalledTimes(12);
  });

  it('invokes onRetry with attempt number and chosen delay', async () => {
    const { sleep } = fakeSleep();
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(codeError('ENOTFOUND')).mockResolvedValue('ok');
    await withRetry(fn, { sleep, baseDelayMs: 1000, random: () => 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 1000);
  });
});

describe('BybitApiError', () => {
  it('carries retCode and formats a useful message', () => {
    const err = new BybitApiError('rate limit exceeded', 10006);
    expect(err.retCode).toBe(10006);
    expect(err.message).toContain('rate limit exceeded');
    expect(err.message).toContain('10006');
  });
});
