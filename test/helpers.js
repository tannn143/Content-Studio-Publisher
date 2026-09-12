/**
 * Tien ich cho test: fetch gia lap, ghi lai moi request de kiem tra shape.
 */

import { HttpClient } from '../src/core/http.js';
import { noopLogger } from '../src/core/logger.js';

/**
 * @typedef {object} RecordedRequest
 * @property {string} url
 * @property {string} method
 * @property {Record<string, string>} headers
 * @property {any} body        Da parse neu la JSON/form, nguyen ban neu la binary.
 * @property {number} [bodyBytes]
 * @property {URLSearchParams} query
 * @property {string} path
 */

/**
 * Tao fetch gia lap.
 *
 * @param {Array<{
 *   match: string | RegExp | ((req: RecordedRequest) => boolean),
 *   method?: string,
 *   status?: number,
 *   json?: any,
 *   text?: string,
 *   headers?: Record<string, string>,
 *   times?: number,
 *   handler?: (req: RecordedRequest, hit: number) => {status?: number, json?: any, text?: string, headers?: Record<string,string>},
 * }>} routes
 * @returns {{fetchImpl: typeof fetch, requests: RecordedRequest[], http: HttpClient, findRequest: (m: string|RegExp) => RecordedRequest|undefined, countRequests: (m: string|RegExp) => number}}
 */
export function createMockFetch(routes) {
  /** @type {RecordedRequest[]} */
  const requests = [];
  const hits = new Map();

  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const parsed = safeUrl(u);
    const req = /** @type {RecordedRequest} */ ({
      url: u,
      path: parsed?.pathname ?? u,
      query: parsed?.searchParams ?? new URLSearchParams(),
      method: (init.method ?? 'GET').toUpperCase(),
      headers: normalizeHeaders(init.headers),
      body: parseBody(init.body),
      bodyBytes: bodyLength(init.body),
    });
    requests.push(req);

    const route = routes.find((r, i) => {
      if (r.method && r.method.toUpperCase() !== req.method) return false;
      const key = i;
      if (r.times != null && (hits.get(key) ?? 0) >= r.times) return false;
      if (typeof r.match === 'function') return r.match(req);
      if (r.match instanceof RegExp) return r.match.test(u);
      return u.includes(r.match);
    });

    if (!route) {
      return makeResponse(404, { error: { message: `mock: khong co route cho ${req.method} ${u}` } }, {});
    }
    const idx = routes.indexOf(route);
    const hit = (hits.get(idx) ?? 0) + 1;
    hits.set(idx, hit);

    const out = route.handler ? route.handler(req, hit) : route;
    if (out.text !== undefined) {
      return makeTextResponse(out.status ?? 200, out.text, out.headers ?? {});
    }
    return makeResponse(out.status ?? 200, out.json ?? {}, out.headers ?? {});
  };

  return {
    fetchImpl: /** @type {any} */ (fetchImpl),
    requests,
    http: new HttpClient({
      fetchImpl: /** @type {any} */ (fetchImpl),
      logger: noopLogger,
      // Test khong cho doi backoff.
      retry: { retries: 2, minDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
    }),
    findRequest: (m) => requests.find((r) => (m instanceof RegExp ? m.test(r.url) : r.url.includes(m))),
    countRequests: (m) => requests.filter((r) => (m instanceof RegExp ? m.test(r.url) : r.url.includes(m))).length,
  };
}

function makeResponse(status, json, headers) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeTextResponse(status, text, headers) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

function normalizeHeaders(h) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

function parseBody(body) {
  if (body == null) return undefined;
  if (typeof body === 'string') {
    const t = body.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }
    if (t.includes('=')) return Object.fromEntries(new URLSearchParams(body));
    return body;
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of body.entries()) {
      out[k] = typeof v === 'string' ? v : { __file: true, size: v.size, type: v.type, name: v.name };
    }
    return out;
  }
  if (Buffer.isBuffer(body)) return { __binary: true, size: body.byteLength };
  if (body instanceof Uint8Array) return { __binary: true, size: body.byteLength };
  return body;
}

function bodyLength(body) {
  if (body == null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.byteLength;
  return undefined;
}

function safeUrl(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/** Tao buffer JPEG hop le (magic bytes) de test khong can file that. */
export function fakeJpeg(sizeBytes = 1024) {
  const buf = Buffer.alloc(Math.max(16, sizeBytes), 0x20);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  return buf;
}

/** Tao buffer MP4 hop le (ftyp box) de test. */
export function fakeMp4(sizeBytes = 2048) {
  const buf = Buffer.alloc(Math.max(32, sizeBytes), 0x00);
  buf.write('ftyp', 4, 'latin1');
  buf.write('isom', 8, 'latin1');
  return buf;
}

/** Tao buffer PNG hop le de test. */
export function fakePng(sizeBytes = 1024) {
  const buf = Buffer.alloc(Math.max(16, sizeBytes), 0x20);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  return buf;
}
