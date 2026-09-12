/**
 * Retry voi exponential backoff + jitter, ton trong `retryAfterMs` cua RateLimitError.
 */

import { AbortError, RateLimitError, toSocialPostError } from './errors.js';

/**
 * @typedef {object} RetryOptions
 * @property {number} [retries=3]           So lan thu lai (khong tinh lan dau).
 * @property {number} [minDelayMs=1000]
 * @property {number} [maxDelayMs=30000]
 * @property {number} [factor=2]
 * @property {'full'|'equal'|'none'} [jitter='full']
 * @property {AbortSignal} [signal]
 * @property {(err: Error, attempt: number) => boolean} [isRetryable]
 * @property {(info: {error: Error, attempt: number, delayMs: number}) => void} [onRetry]
 * @property {() => number} [random] Inject de test deterministic.
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleepFn]
 */

/** Mac dinh: dua vao co retryable cua loi da chuan hoa. */
function defaultIsRetryable(err) {
  return Boolean(/** @type {any} */ (err)?.retryable);
}

/**
 * Sleep co the huy bang AbortSignal.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError('Aborted before sleep'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // Khong giu process song chi vi timer nay.
    if (typeof t.unref === 'function') t.unref();
    function onAbort() {
      clearTimeout(t);
      reject(new AbortError('Aborted during backoff'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Tinh do tre cho lan thu thu `attempt` (attempt bat dau tu 1).
 * @param {number} attempt
 * @param {Required<Pick<RetryOptions,'minDelayMs'|'maxDelayMs'|'factor'|'jitter'>> & {random?: () => number}} o
 * @returns {number}
 */
export function computeBackoff(attempt, o) {
  const rand = o.random ?? Math.random;
  const raw = Math.min(o.maxDelayMs, o.minDelayMs * o.factor ** (attempt - 1));
  if (o.jitter === 'none') return Math.round(raw);
  if (o.jitter === 'equal') return Math.round(raw / 2 + rand() * (raw / 2));
  return Math.round(rand() * raw); // full jitter
}

/**
 * Chay `fn` va thu lai khi loi co the retry.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
export async function retry(fn, options = {}) {
  const {
    retries = 3,
    minDelayMs = 1000,
    maxDelayMs = 30_000,
    factor = 2,
    jitter = 'full',
    signal,
    isRetryable = defaultIsRetryable,
    onRetry,
    random,
    sleepFn = sleep,
  } = options;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    if (signal?.aborted) throw new AbortError('Aborted before attempt');
    try {
      return await fn(attempt);
    } catch (rawErr) {
      const err = toSocialPostError(rawErr);
      const exhausted = attempt > retries;
      if (exhausted || !isRetryable(err, attempt)) {
        // Ghi lai so lan da thu de caller bao cao.
        /** @type {any} */ (err).attempts = attempt;
        throw err;
      }
      let delayMs = computeBackoff(attempt, { minDelayMs, maxDelayMs, factor, jitter, random });
      if (err instanceof RateLimitError && Number.isFinite(err.retryAfterMs)) {
        // Nen tang da noi ro phai cho bao lau -> ton trong, khong nho hon.
        delayMs = Math.min(Math.max(delayMs, /** @type {number} */ (err.retryAfterMs)), 15 * 60_000);
      }
      onRetry?.({ error: err, attempt, delayMs });
      await sleepFn(delayMs, signal);
    }
  }
}

/**
 * Poll cho den khi `check` tra ve `{done: true, value}` hoac het thoi gian.
 *
 * @template T
 * @param {(attempt: number) => Promise<{done: boolean, value?: T, failed?: boolean, reason?: string}>} check
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=300000]
 * @param {number} [opts.intervalMs=3000]
 * @param {number} [opts.maxIntervalMs=15000]
 * @param {number} [opts.backoffFactor=1.3]
 * @param {AbortSignal} [opts.signal]
 * @param {(info: {attempt: number, elapsedMs: number}) => void} [opts.onTick]
 * @param {() => number} [opts.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [opts.sleepFn]
 * @returns {Promise<{value?: T, timedOut: boolean, attempts: number, elapsedMs: number, failed?: boolean, reason?: string}>}
 */
export async function pollUntil(check, opts = {}) {
  const {
    timeoutMs = 300_000,
    intervalMs = 3000,
    maxIntervalMs = 15_000,
    backoffFactor = 1.3,
    signal,
    onTick,
    now = () => Date.now(),
    sleepFn = sleep,
  } = opts;

  const start = now();
  let attempt = 0;
  let wait = intervalMs;

  for (;;) {
    attempt += 1;
    if (signal?.aborted) throw new AbortError('Aborted while polling');
    const res = await check(attempt);
    const elapsedMs = now() - start;
    if (res.done || res.failed) {
      return { value: res.value, timedOut: false, attempts: attempt, elapsedMs, failed: res.failed, reason: res.reason };
    }
    onTick?.({ attempt, elapsedMs });
    if (elapsedMs + wait >= timeoutMs) {
      return { timedOut: true, attempts: attempt, elapsedMs };
    }
    await sleepFn(wait, signal);
    wait = Math.min(maxIntervalMs, Math.round(wait * backoffFactor));
  }
}
