/**
 * LocalTunnelMediaHost: mo mot HTTP server tam trong process, phuc vu file local
 * de Instagram/TikTok co the "keo" (pull) media ve.
 *
 * Ban CAN mot duong vao cong khai tro den server nay, vi du:
 *   cloudflared tunnel --url http://localhost:8787
 *   ngrok http 8787
 * roi truyen `publicBaseUrl` = URL cong khai do.
 *
 * Neu server chay tren VPS co IP/domain cong khai thi chi can publicBaseUrl = 'http://your-domain:8787'.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { ConfigError } from '../errors.js';

export class LocalTunnelMediaHost {
  /**
   * @param {object} opts
   * @param {string} opts.publicBaseUrl URL cong khai tro den server nay (vd https://abc.trycloudflare.com).
   * @param {number} [opts.port=8787] 0 = cong ngau nhien (chi dung khi publicBaseUrl tro dung cong do).
   * @param {string} [opts.hostname='0.0.0.0']
   * @param {number} [opts.ttlMs=1800000] Tu huy dang ky file sau bao lau.
   * @param {boolean} [opts.stopWhenIdle=true] Tat server khi khong con file nao.
   * @param {import('../logger.js').Logger} [opts.logger]
   */
  constructor(opts) {
    if (!opts?.publicBaseUrl) {
      throw new ConfigError(
        'LocalTunnelMediaHost: `publicBaseUrl` is missing. Run cloudflared/ngrok and pass the public URL in.',
      );
    }
    this.name = 'local-tunnel';
    this.publicBaseUrl = String(opts.publicBaseUrl).replace(/\/+$/, '');
    this.port = opts.port ?? 8787;
    this.hostname = opts.hostname ?? '0.0.0.0';
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.stopWhenIdle = opts.stopWhenIdle ?? true;
    this.logger = opts.logger;

    /** @type {Map<string, {media: import('../media.js').Media, timer: NodeJS.Timeout}>} */
    this.entries = new Map();
    /** @type {http.Server | null} */
    this.server = null;
    /** @type {Promise<void> | null} */
    this.starting = null;
  }

  /**
   * @param {import('../media.js').Media} media
   * @returns {Promise<import('./index.js').HostedMedia>}
   */
  async host(media) {
    await media.load();
    await this._ensureServer();

    const token = crypto.randomBytes(16).toString('hex');
    const ext = media.extension || '';
    const timer = setTimeout(() => this._release(token), this.ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.entries.set(token, { media, timer });

    const url = `${this.publicBaseUrl}/m/${token}${ext}`;
    this.logger?.debug('media duoc phuc vu qua local server', { url, size: media.size });

    return {
      url,
      expiresInSec: Math.floor(this.ttlMs / 1000),
      cleanup: async () => this._release(token),
    };
  }

  /** Dong server (goi khi ket thuc chuong trinh). */
  async close() {
    for (const [token] of this.entries) this._release(token);
    await this._stopServer();
  }

  _release(token) {
    const entry = this.entries.get(token);
    if (entry) {
      clearTimeout(entry.timer);
      this.entries.delete(token);
    }
    if (this.stopWhenIdle && this.entries.size === 0) {
      void this._stopServer();
    }
  }

  async _stopServer() {
    const srv = this.server;
    if (!srv) return;
    this.server = null;
    await new Promise((resolve) => srv.close(() => resolve(undefined)));
    this.logger?.debug('da dong local media server');
  }

  async _ensureServer() {
    if (this.server) return;
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.on('error', (err) => {
        this.starting = null;
        reject(err);
      });
      server.listen(this.port, this.hostname, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        this.server = server;
        this.starting = null;
        this.logger?.info('local media server dang chay', {
          listen: `${this.hostname}:${this.port}`,
          publicBaseUrl: this.publicBaseUrl,
        });
        resolve(undefined);
      });
      server.unref?.();
    });
    return this.starting;
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async _handle(req, res) {
    const match = /^\/m\/([0-9a-f]{32})/.exec(req.url ?? '');
    if (!match) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const entry = this.entries.get(match[1]);
    if (!entry) {
      res.writeHead(410, { 'content-type': 'text/plain' });
      res.end('gone');
      return;
    }

    const { media } = entry;
    const total = media.size ?? 0;
    const headers = {
      'content-type': media.mime ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=600',
    };

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'content-length': String(total) });
      res.end();
      return;
    }

    try {
      const range = parseRange(req.headers.range, total);
      if (range) {
        const chunk = await media.readRange(range.start, range.end);
        res.writeHead(206, {
          ...headers,
          'content-length': String(chunk.byteLength),
          'content-range': `bytes ${range.start}-${range.end}/${total}`,
        });
        res.end(chunk);
        return;
      }
      res.writeHead(200, { ...headers, 'content-length': String(total) });
      const stream = await media.toStream();
      if (typeof (/** @type {any} */ (stream).pipe) === 'function') {
        /** @type {any} */ (stream).pipe(res);
      } else {
        const { Readable } = await import('node:stream');
        Readable.fromWeb(/** @type {any} */ (stream)).pipe(res);
      }
    } catch (err) {
      this.logger?.warn('loi phuc vu media', { error: String(err) });
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    }
  }
}

/**
 * @param {string | undefined} header
 * @param {number} total
 * @returns {{start: number, end: number} | null}
 */
function parseRange(header, total) {
  if (!header || !total) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const len = Number(b);
    return { start: Math.max(0, total - len), end: total - 1 };
  }
  const start = Number(a);
  const end = b === '' ? total - 1 : Math.min(Number(b), total - 1);
  if (start > end) return null;
  return { start, end };
}
