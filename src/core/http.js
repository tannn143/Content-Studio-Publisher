/**
 * HTTP client dung chung: timeout, retry, parse body, chuan hoa loi.
 * Khong dung axios/node-fetch - dung `fetch` co san cua Node >= 18.
 */

import {
  AbortError,
  AuthError,
  NetworkError,
  PlatformError,
  RateLimitError,
  TimeoutError,
  toSocialPostError,
} from './errors.js';
import { retry as retryFn } from './retry.js';
import { noopLogger } from './logger.js';

export const DEFAULT_USER_AGENT = 'wallpaper-auto-marketing/1.0 (+https://github.com/)';

/**
 * @typedef {object} HttpResponse
 * @property {number} status
 * @property {boolean} ok
 * @property {Headers} headers
 * @property {any} data     Body da parse (JSON neu content-type la json).
 * @property {string} text  Body dang text (rong neu la binary/da consume).
 * @property {Response} res Response goc.
 */

export class HttpClient {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {import('./logger.js').Logger} [opts.logger]
   * @param {number} [opts.timeoutMs=120000]
   * @param {import('./retry.js').RetryOptions} [opts.retry]
   * @param {string} [opts.userAgent]
   * @param {Record<string,string>} [opts.defaultHeaders]
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.logger = opts.logger ?? noopLogger;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.retryOptions = opts.retry ?? {};
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = opts.defaultHeaders ?? {};
  }

  /** Tao client con thua huong cau hinh (de gan logger theo platform). */
  child(opts = {}) {
    return new HttpClient({
      fetchImpl: this.fetchImpl,
      logger: opts.logger ?? this.logger,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      retry: { ...this.retryOptions, ...(opts.retry ?? {}) },
      userAgent: opts.userAgent ?? this.userAgent,
      defaultHeaders: { ...this.defaultHeaders, ...(opts.defaultHeaders ?? {}) },
    });
  }

  /**
   * Goi HTTP mot lan (khong retry).
   *
   * @param {string} url
   * @param {object} [options]
   * @param {string} [options.method='GET']
   * @param {Record<string, any>} [options.headers]
   * @param {Record<string, any>} [options.query] Query string (bo qua undefined/null).
   * @param {any} [options.json] Body JSON.
   * @param {Record<string, any>} [options.form] Body application/x-www-form-urlencoded.
   * @param {FormData} [options.formData] Body multipart/form-data.
   * @param {BodyInit} [options.body] Body tho (Buffer/stream/string).
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @param {'json'|'text'|'buffer'|'none'} [options.parse='json']
   * @param {(ctx: {status: number, data: any, text: string, res: Response, url: string}) => Error | undefined} [options.mapError]
   *        Hook chuyen loi API thanh loi cua module. Tra ve undefined de dung mapping mac dinh.
   * @param {boolean} [options.throwOnError=true]
   * @param {string} [options.platform] Dung de gan vao loi.
   * @param {boolean} [options.redirect] 'follow' | 'manual'
   * @returns {Promise<HttpResponse>}
   */
  async requestOnce(url, options = {}) {
    const {
      method = 'GET',
      headers = {},
      query,
      json,
      form,
      formData,
      body,
      timeoutMs = this.timeoutMs,
      signal,
      parse = 'json',
      mapError,
      throwOnError = true,
      platform,
      redirect = 'follow',
      duplex,
    } = options;

    const finalUrl = query ? appendQuery(url, query) : url;
    /** @type {Record<string,string>} */
    const hdrs = {
      'user-agent': this.userAgent,
      ...lowerKeys(this.defaultHeaders),
      ...lowerKeys(headers),
    };

    /** @type {BodyInit | undefined} */
    let finalBody;
    if (json !== undefined) {
      finalBody = JSON.stringify(json);
      hdrs['content-type'] ??= 'application/json; charset=utf-8';
    } else if (form !== undefined) {
      finalBody = encodeForm(form);
      hdrs['content-type'] ??= 'application/x-www-form-urlencoded; charset=utf-8';
    } else if (formData !== undefined) {
      finalBody = formData; // fetch tu set boundary
    } else if (body !== undefined) {
      finalBody = body;
    }

    const { signal: mergedSignal, cleanup } = withTimeout(timeoutMs, signal);
    const started = Date.now();
    this.logger.trace('http request', { method, url: finalUrl, platform });

    /** @type {Response} */
    let res;
    try {
      res = await this.fetchImpl(finalUrl, {
        method,
        headers: hdrs,
        body: finalBody,
        redirect,
        signal: mergedSignal,
        ...(duplex ? { duplex } : {}),
      });
    } catch (err) {
      cleanup();
      // Caller huy -> AbortError (KHONG retry). Timeout cua ta -> TimeoutError (retry duoc).
      if (signal?.aborted) {
        throw new AbortError(`Da huy: ${method} ${stripSecrets(finalUrl)}`, { platform, cause: err });
      }
      if (mergedSignal.aborted) {
        throw new TimeoutError(`Request qua ${timeoutMs}ms: ${method} ${stripSecrets(finalUrl)}`, {
          platform,
          cause: err,
        });
      }
      const e = toSocialPostError(err, { platform });
      if (e instanceof NetworkError || e.retryable) throw e;
      throw new NetworkError(`Loi mang khi goi ${method} ${stripSecrets(finalUrl)}: ${e.message}`, {
        platform,
        cause: err,
      });
    }
    // Doc body TRUOC khi huy timeout: neu khong, mot server treo giua luc stream body
    // se lam request treo vo han (timeout da bi clear).
    let text = '';
    let data;
    try {
      if (parse !== 'none') {
        if (parse === 'buffer') {
          data = Buffer.from(await res.arrayBuffer());
        } else {
          text = await res.text().catch(() => '');
          data = parse === 'json' ? tryParseJson(text) : text;
        }
      }
    } finally {
      cleanup();
    }

    const out = /** @type {HttpResponse} */ ({
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      data,
      text,
      res,
    });

    this.logger.trace('http response', {
      method,
      url: finalUrl,
      status: res.status,
      ms: Date.now() - started,
      platform,
    });

    if (!res.ok && throwOnError) {
      const mapped = mapError?.({ status: res.status, data, text, res, url: finalUrl });
      throw mapped ?? defaultMapError({ status: res.status, data, text, res, url: finalUrl, platform });
    }
    return out;
  }

  /**
   * Goi HTTP co retry (mac dinh retry cac loi tam thoi: 429/5xx/mang).
   * @param {string} url
   * @param {Parameters<HttpClient['requestOnce']>[1] & {retry?: import('./retry.js').RetryOptions}} [options]
   * @returns {Promise<HttpResponse>}
   */
  async request(url, options = {}) {
    const { retry: retryOverride, ...rest } = options;
    const method = String(rest.method ?? 'GET').toUpperCase();
    const safeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

    // POST/PUT/PATCH KHONG idempotent. Phan biet hai tinh huong:
    //  - Server DA tra loi 429/5xx  -> chac chan request bi tu choi, retry AN TOAN.
    //  - Loi mang / timeout         -> khong biet server da nhan chua, retry co the
    //                                  tao BAI TRUNG -> khong retry.
    // Caller biet ro request cua minh idempotent (vd chunk PUT co Content-Range)
    // thi truyen `retry` de tu quyet dinh.
    const baseRetry = safeMethod || retryOverride
      ? this.retryOptions
      : { ...this.retryOptions, isRetryable: isServerRejection };
    const retryOpts = { ...baseRetry, ...(retryOverride ?? {}) };
    return retryFn(
      () => this.requestOnce(url, rest),
      {
        ...retryOpts,
        signal: rest.signal ?? retryOpts.signal,
        onRetry: ({ error, attempt, delayMs }) => {
          this.logger.warn('http retry', {
            platform: rest.platform,
            url: stripSecrets(url),
            attempt,
            delayMs,
            code: /** @type {any} */ (error).code,
            status: /** @type {any} */ (error).httpStatus,
            message: error.message,
          });
          retryOpts.onRetry?.({ error, attempt, delayMs });
        },
      },
    );
  }

  /** Tien ich: GET JSON. */
  getJson(url, options = {}) {
    return this.request(url, { ...options, method: 'GET' }).then((r) => r.data);
  }

  /** Tien ich: POST JSON, tra ve body da parse. */
  postJson(url, json, options = {}) {
    return this.request(url, { ...options, method: 'POST', json }).then((r) => r.data);
  }

  /** Tien ich: POST form-urlencoded, tra ve body da parse. */
  postForm(url, form, options = {}) {
    return this.request(url, { ...options, method: 'POST', form }).then((r) => r.data);
  }

  /**
   * PUT mot doan byte kem Content-Range (dung cho resumable upload).
   * @param {string} url
   * @param {Buffer} chunk
   * @param {object} opts
   * @param {number} opts.start
   * @param {number} opts.total Tong so byte cua file.
   * @param {string} [opts.contentType]
   * @param {Record<string,string>} [opts.headers]
   * @param {'bytes-range'|'offset'|'none'} [opts.rangeStyle='bytes-range'] Cach dien ta vi tri.
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.timeoutMs]
   * @param {string} [opts.method='PUT']
   * @param {string} [opts.platform]
   * @param {(ctx: any) => Error | undefined} [opts.mapError]
   * @param {number[]} [opts.acceptStatus] Status coi la thanh cong (vd [200,201,308]).
   * @returns {Promise<HttpResponse>}
   */
  async putChunk(url, chunk, opts) {
    const {
      start,
      total,
      contentType = 'application/octet-stream',
      headers = {},
      rangeStyle = 'bytes-range',
      signal,
      timeoutMs,
      method = 'PUT',
      platform,
      mapError,
      acceptStatus,
    } = opts;
    const end = start + chunk.byteLength - 1;

    /** @type {Record<string,string>} */
    const h = {
      'content-type': contentType,
      'content-length': String(chunk.byteLength),
      ...lowerKeys(headers),
    };
    if (rangeStyle === 'bytes-range') {
      h['content-range'] = `bytes ${start}-${end}/${total}`;
    } else if (rangeStyle === 'offset') {
      h.offset = String(start);
      h.file_size = String(total);
    }

    const res = await this.request(url, {
      method,
      headers: h,
      body: chunk,
      parse: 'text',
      timeoutMs: timeoutMs ?? Math.max(this.timeoutMs, 300_000),
      signal,
      platform,
      mapError,
      throwOnError: false,
    });

    const ok = acceptStatus ? acceptStatus.includes(res.status) : res.ok || res.status === 308;
    if (!ok) {
      const mapped = mapError?.({ status: res.status, data: res.data, text: res.text, res: res.res, url });
      throw mapped ?? defaultMapError({
        status: res.status,
        data: res.data,
        text: res.text,
        res: res.res,
        url,
        platform,
      });
    }
    return res;
  }
}

/**
 * Loi nay co chac chan la "server da nhan va TU CHOI request" khong?
 *
 * Chi khi do moi duoc retry mot request khong idempotent: da co response nghia la
 * bai dang chac chan CHUA duoc tao. Loi mang/timeout thi khong biet, nen khong retry.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isServerRejection(err) {
  const e = /** @type {any} */ (err);
  if (!e?.retryable) return false;
  const status = Number(e.httpStatus);
  return Number.isFinite(status) && (status === 429 || status >= 500);
}

/**
 * Mapping loi mac dinh theo HTTP status.
 * @param {{status: number, data: any, text: string, res: Response, url: string, platform?: string}} ctx
 * @returns {Error}
 */
export function defaultMapError(ctx) {
  const { status, data, text, res, url, platform } = ctx;
  const snippet = (text || JSON.stringify(data ?? '') || '').slice(0, 500);
  const base = {
    platform,
    httpStatus: status,
    details: { url: stripSecrets(url), body: data ?? snippet },
  };

  if (status === 401) {
    return new AuthError(`HTTP 401 Unauthorized: ${snippet}`, {
      ...base,
      hint: 'Access token het han hoac sai. Kiem tra refresh token / quyen truy cap.',
    });
  }
  if (status === 403) {
    return new AuthError(`HTTP 403 Forbidden: ${snippet}`, {
      ...base,
      hint: 'Thieu scope/permission, hoac tai khoan chua duoc phep dang bai.',
    });
  }
  if (status === 429) {
    return new RateLimitError(`HTTP 429 Too Many Requests: ${snippet}`, {
      ...base,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    });
  }
  if (status === 408) {
    return new TimeoutError(`HTTP 408 Request Timeout: ${snippet}`, base);
  }
  if (status >= 500) {
    return new PlatformError(`HTTP ${status} tu nen tang: ${snippet}`, { ...base, retryable: true });
  }
  return new PlatformError(`HTTP ${status}: ${snippet}`, { ...base, retryable: false });
}

/**
 * Doc header Retry-After (giay hoac HTTP-date) thanh ms.
 * @param {string | null} value
 * @returns {number | undefined}
 */
export function parseRetryAfter(value) {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/**
 * Ghep query vao URL, bo qua undefined/null.
 * @param {string} url
 * @param {Record<string, any>} query
 * @returns {string}
 */
export function appendQuery(url, query) {
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of entries) {
    if (Array.isArray(v)) {
      for (const item of v) qs.append(k, stringifyParam(item));
    } else {
      qs.append(k, stringifyParam(v));
    }
  }
  return url + (url.includes('?') ? '&' : '?') + qs.toString();
}

/**
 * Encode body form-urlencoded, object/array duoc JSON hoa (Graph API yeu cau vay).
 * @param {Record<string, any>} form
 * @returns {string}
 */
export function encodeForm(form) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (v === undefined || v === null) continue;
    qs.append(k, stringifyParam(v));
  }
  return qs.toString();
}

function stringifyParam(v) {
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/**
 * Gop timeout vao AbortSignal cua caller.
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {{signal: AbortSignal, cleanup: () => void}}
 */
export function withTimeout(timeoutMs, signal) {
  const controller = new AbortController();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const onAbort = () => controller.abort(signal?.reason);

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function tryParseJson(text) {
  if (!text) return undefined;
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function lowerKeys(obj) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

/** Xoa token khoi URL truoc khi ghi log / nem loi. */
export function stripSecrets(url) {
  return String(url)
    .replace(/(access_token|refresh_token|client_secret|key)=[^&]+/gi, '$1=***')
    .replace(/\/bot\d+:[\w-]+/gi, '/bot***');
}
