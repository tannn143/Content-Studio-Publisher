/**
 * Event bus + Server-Sent Events: day tien trinh dang bai va log ve trinh duyet.
 */

import { maskSecretString, redact } from '../core/logger.js';

export class EventBus {
  /**
   * @param {object} [opts]
   * @param {number} [opts.bufferSize=200] So su kien giu lai cho client vao sau.
   */
  constructor(opts = {}) {
    this.bufferSize = opts.bufferSize ?? 200;
    /** @type {Array<{id: number, type: string, data: any, at: string}>} */
    this.buffer = [];
    /** @type {Set<import('node:http').ServerResponse>} */
    this.clients = new Set();
    this.seq = 0;
  }

  /**
   * @param {string} type
   * @param {any} data
   */
  emit(type, data) {
    this.seq += 1;
    const evt = { id: this.seq, type, data, at: new Date().toISOString() };
    this.buffer.push(evt);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();

    const payload = `id: ${evt.id}\nevent: message\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /**
   * Gan mot ket noi SSE.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {number} [lastEventId]
   */
  subscribe(req, res, lastEventId) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    // Gui lai cac su kien client con thieu.
    if (lastEventId) {
      for (const evt of this.buffer.filter((e) => e.id > lastEventId)) {
        res.write(`id: ${evt.id}\nevent: message\ndata: ${JSON.stringify(evt)}\n\n`);
      }
    }

    this.clients.add(res);
    // Ping de proxy khong dong ket noi.
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 25_000);
    if (typeof ping.unref === 'function') ping.unref();

    const cleanup = () => {
      clearInterval(ping);
      this.clients.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  /** Dong toan bo ket noi (khi tat server). */
  closeAll() {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // bo qua
      }
    }
    this.clients.clear();
  }
}

/**
 * Logger ghi vao vong dem + phat SSE, de web admin xem log truc tiep.
 *
 * @param {object} opts
 * @param {EventBus} opts.events
 * @param {import('../core/logger.js').Logger} [opts.base] Logger goc (van ghi ra stderr).
 * @param {number} [opts.size=500]
 * @returns {{logger: import('../core/logger.js').Logger, lines: () => Array<any>}}
 */
export function createEventLogger(opts) {
  const { events, base, size = 500 } = opts;
  /** @type {Array<{level: string, msg: string, meta: any, at: string}>} */
  const lines = [];

  const wrap = (logger, bindings = {}) => {
    /** @type {any} */
    const out = {
      level: logger.level,
      child: (extra) => wrap(logger.child(extra), { ...bindings, ...extra }),
    };
    for (const level of ['error', 'warn', 'info', 'debug', 'trace']) {
      out[level] = (msg, meta) => {
        logger[level](msg, meta);
        if (level === 'trace' || level === 'debug') return; // khong day log qua chi tiet ve UI
        // BAT BUOC che secret: log nay di ra trinh duyet qua SSE va GET /api/logs.
        const entry = {
          level,
          msg: maskSecretString(msg),
          meta: /** @type {object} */ (redact({ ...bindings, ...(meta ?? {}) })),
          at: new Date().toISOString(),
        };
        lines.push(entry);
        if (lines.length > size) lines.shift();
        events.emit('log', entry);
      };
    }
    return out;
  };

  return { logger: wrap(base ?? createSilentLogger()), lines: () => [...lines] };
}

function createSilentLogger() {
  /** @type {any} */
  const noop = {
    level: 'silent',
    child: () => noop,
    error() {}, warn() {}, info() {}, debug() {}, trace() {},
  };
  return noop;
}
