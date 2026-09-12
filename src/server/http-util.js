/**
 * Tien ich HTTP cho admin server: router nho, doc body, tra JSON, phuc vu file tinh.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Kieu MIME cho file tinh. */
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Loi co ma HTTP, de handler nem ra va server tra dung status. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {object} [extra]
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * Router rat nho: khop method + pattern dang '/api/posts/:id'.
 */
export class Router {
  constructor() {
    /** @type {Array<{method: string, parts: string[], handler: Function, raw: string}>} */
    this.routes = [];
  }

  /**
   * @param {string} method
   * @param {string} pattern
   * @param {(ctx: any) => any} handler
   */
  add(method, pattern, handler) {
    this.routes.push({
      method: method.toUpperCase(),
      parts: pattern.split('/').filter(Boolean),
      handler,
      raw: `${method.toUpperCase()} ${pattern}`,
    });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }

  post(p, h) { return this.add('POST', p, h); }

  put(p, h) { return this.add('PUT', p, h); }

  patch(p, h) { return this.add('PATCH', p, h); }

  delete(p, h) { return this.add('DELETE', p, h); }

  /**
   * @param {string} method
   * @param {string} pathname
   * @returns {{handler: Function, params: Record<string, string>} | null}
   */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.parts.length !== parts.length) continue;
      /** @type {Record<string, string>} */
      const params = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i += 1) {
        const rp = route.parts[i];
        if (rp.startsWith(':')) {
          // URL co escape sai (vd '%zz') se lam decodeURIComponent nem loi -> tra 400.
          try {
            params[rp.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            throw new HttpError(400, 'The URL contains an invalid escape sequence');
          }
        } else if (rp !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

/**
 * Doc body JSON (co gioi han dung luong).
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes=2000000]
 * @returns {Promise<any>}
 */
export async function readJsonBody(req, maxBytes = 2_000_000) {
  const raw = await readRawBody(req, maxBytes);
  if (raw.byteLength === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not valid JSON');
  }
}

/**
 * Doc body tho vao Buffer.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new HttpError(413, `The data is over the ${Math.round(maxBytes / 1e6)}MB limit`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Ghi body tho truc tiep ra file (upload file lon khong nap het vao RAM).
 * @param {import('node:http').IncomingMessage} req
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<number>} so byte da ghi
 */
export async function pipeBodyToFile(req, filePath, maxBytes) {
  const { createWriteStream } = await import('node:fs');
  const { unlink } = await import('node:fs/promises');
  return new Promise((resolve, reject) => {
    const out = createWriteStream(filePath, { mode: 0o600 });
    let total = 0;
    let failed = false;

    const fail = async (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      await unlink(filePath).catch(() => {});
      reject(err);
    };

    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        void fail(new HttpError(413, `The file is over the ${Math.round(maxBytes / 1e6)}MB limit`));
        req.destroy();
      }
    });
    req.on('error', (err) => void fail(err));
    out.on('error', (err) => void fail(err));
    out.on('finish', () => {
      if (!failed) resolve(total);
    });
    req.pipe(out);
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} data
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {Record<string, string>} [headers]
 */
export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

/**
 * Phuc vu mot file tinh (ho tro Range cho video preview).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 * @param {object} [opts]
 * @param {string} [opts.cacheControl='no-cache']
 * @param {string} [opts.downloadName]
 */
export async function sendFile(req, res, filePath, opts = {}) {
  let st;
  try {
    st = await stat(filePath);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (!st.isFile()) throw new HttpError(404, 'File not found');

  const type = opts.contentType
    ?? STATIC_MIME[path.extname(filePath).toLowerCase()]
    ?? 'application/octet-stream';
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': type,
    etag,
    'accept-ranges': 'bytes',
    'cache-control': opts.cacheControl ?? 'no-cache',
    'last-modified': st.mtime.toUTCString(),
    ...(opts.extraHeaders ?? {}),
  };
  if (opts.downloadName) {
    headers['content-disposition'] = `attachment; filename="${encodeURIComponent(opts.downloadName)}"`;
  }

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const range = parseRangeHeader(req.headers.range, st.size);
  // Phong tuyen thu 2: khong bao gio gui header 206 ma khong the thoa man.
  if (range && range.start >= 0 && range.end >= range.start && range.end < st.size) {
    res.writeHead(206, {
      ...headers,
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${st.size}`,
    });
    pipeSafely(createReadStream(filePath, { start: range.start, end: range.end }), res);
    return;
  }

  res.writeHead(200, { ...headers, 'content-length': String(st.size) });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeSafely(createReadStream(filePath), res);
}

/**
 * @param {string|undefined} header
 * @param {number} size
 */
export function parseRangeHeader(header, size) {
  if (!header || !size) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const len = Number(b);
    // 'bytes=-0' khong the thoa man -> bo qua Range (tra ve ca file), theo RFC cho phep.
    if (!Number.isFinite(len) || len <= 0) return null;
    return { start: Math.max(0, size - len), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size || start < 0) return null;
  return { start, end };
}

/**
 * Chan path traversal: chi cho phep duong dan nam trong `root`.
 * @param {string} root
 * @param {string} requestPath
 * @returns {string | null}
 */
export function safeJoin(root, requestPath) {
  /** @type {string} */
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null; // escape sai -> tu choi
  }
  const clean = decoded.replace(/\\/g, '/').replace(/\0/g, '');
  const resolved = path.resolve(root, `.${clean.startsWith('/') ? clean : `/${clean}`}`);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) return null;
  return resolved;
}

/**
 * So sanh chuoi chong timing attack.
 * @param {string} a
 * @param {string} b
 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Sinh token admin. */
export function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * pipe() KHONG chuyen tiep loi cua nguon -> loi doc file se thanh unhandled
 * va lam sap process. Ham nay bat loi va dong ket noi tu te.
 * @param {import('node:stream').Readable} source
 * @param {import('node:http').ServerResponse} res
 */
export function pipeSafely(source, res) {
  source.on('error', () => {
    // Header da gui roi nen khong the doi status -> chi dong ket noi.
    res.destroy();
    source.destroy();
  });
  res.on('close', () => source.destroy());
  source.pipe(res);
}

/**
 * Doc so nguyen tu query, tra ve mac dinh khi khong hop le.
 * @param {string | null | undefined} raw
 * @param {number} fallback
 * @param {object} [opts]
 * @param {number} [opts.min=1]
 * @param {number} [opts.max=Number.MAX_SAFE_INTEGER]
 * @returns {number}
 */
export function parseIntParam(raw, fallback, opts = {}) {
  const { min = 1, max = Number.MAX_SAFE_INTEGER } = opts;
  // Number(null) === 0 va Number('') === 0 -> phai loai ra truoc, neu khong
  // tham so thieu se bi clamp ve "min" thay vi dung gia tri mac dinh.
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
