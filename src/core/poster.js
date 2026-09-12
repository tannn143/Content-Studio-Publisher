/**
 * SocialPoster: dieu phoi dang mot bai len nhieu nen tang cung luc.
 *
 * Nguyen tac: mot nen tang loi KHONG lam chet ca lo. Ket qua tra ve day du
 * trang thai tung nen tang de caller tu quyet dinh (log, retry, canh bao).
 */

import { AbortError, AggregatePostError, ConfigError, toSocialPostError, UnsupportedError } from './errors.js';
import { createLogger, noopLogger } from './logger.js';
import { HttpClient } from './http.js';
import { MemoryTokenStore } from './tokenstore.js';
import { normalizePost } from './post.js';
import { mapSettledLimit } from './limit.js';
import { PLATFORM_REGISTRY } from '../platforms/index.js';

/**
 * @typedef {object} PlatformOutcome
 * @property {string} platform
 * @property {boolean} ok
 * @property {boolean} skipped
 * @property {string} [id]
 * @property {string} [url]
 * @property {string} [status]
 * @property {number} durationMs
 * @property {number} [attempts]
 * @property {any} [raw]
 * @property {object} [meta]
 * @property {ReturnType<import('./errors.js').SocialPostError['toJSON']>} [error]
 * @property {Error} [errorObject]
 * @property {string} [reason] Ly do bi bo qua.
 */

/**
 * @typedef {object} PostReport
 * @property {boolean} ok           True khi KHONG co nen tang nao that bai.
 * @property {boolean} dryRun
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {number} durationMs
 * @property {PlatformOutcome[]} results
 * @property {Record<string, PlatformOutcome>} byPlatform
 * @property {string[]} succeeded
 * @property {string[]} failed
 * @property {string[]} skipped
 * @property {object} post
 */

export class SocialPoster {
  /**
   * @param {object} [opts]
   * @param {Record<string, any>} [opts.platforms] Cau hinh tung nen tang: { youtube: {...}, telegram: {...} }.
   *   Dat `enabled: false` de tam tat mot nen tang.
   * @param {import('./logger.js').Logger | {level?: string, format?: 'json'|'pretty'}} [opts.logger]
   * @param {HttpClient} [opts.http]
   * @param {import('./tokenstore.js').TokenStore} [opts.store] Noi luu access/refresh token.
   * @param {import('./mediahost/index.js').MediaHost} [opts.mediaHost] Cap URL cong khai cho file local.
   * @param {number} [opts.concurrency=3] So nen tang dang song song.
   * @param {boolean} [opts.dryRun=false] Chi in ra se gui gi, khong goi API.
   * @param {number} [opts.timeoutMsPerPlatform=900000] Tran thoi gian cho MOT nen tang (15 phut).
   * @param {import('./retry.js').RetryOptions} [opts.retry]
   * @param {boolean} [opts.throwOnError=false] True: nem AggregatePostError neu co nen tang loi.
   * @param {object} [opts.hooks]
   * @param {Record<string, typeof import('../platforms/base.js').BasePlatform>} [opts.registry] Dang ky them adapter rieng.
   */
  constructor(opts = {}) {
    this.logger = isLogger(opts.logger)
      ? opts.logger
      : createLogger(/** @type {any} */ (opts.logger) ?? {});
    this.dryRun = opts.dryRun ?? false;
    this.concurrency = Math.max(1, opts.concurrency ?? 3);
    this.timeoutMsPerPlatform = opts.timeoutMsPerPlatform ?? 15 * 60_000;
    this.throwOnError = opts.throwOnError ?? false;
    this.store = opts.store ?? new MemoryTokenStore();
    this.mediaHost = opts.mediaHost;
    this.hooks = opts.hooks ?? {};
    this.retryOptions = opts.retry ?? { retries: 3, minDelayMs: 1500, maxDelayMs: 30_000 };
    this.http = opts.http ?? new HttpClient({ logger: this.logger, retry: this.retryOptions });
    this.registry = { ...PLATFORM_REGISTRY, ...(opts.registry ?? {}) };

    /** @type {Record<string, any>} */
    this.platformConfigs = {};
    /** @type {Map<string, import('../platforms/base.js').BasePlatform>} */
    this.instances = new Map();

    for (const [id, cfg] of Object.entries(opts.platforms ?? {})) {
      if (cfg == null) continue;
      this.platformConfigs[id] = cfg;
    }
    this._buildInstances();
  }

  /**
   * Lay class adapter cho mot key cau hinh.
   *
   * Key co the la chinh id nen tang (`youtube`) hoac mot id kenh tu dat
   * (`yt-main`) khi cau hinh co thêm field `platform: 'youtube'`.
   * Nho vay co the dang len NHIEU kenh cua CUNG mot nen tang.
   *
   * @param {string} key
   * @param {Record<string, any>} cfg
   */
  _resolveClass(key, cfg) {
    const platformId = cfg?.platform ?? key;
    const Klass = this.registry[platformId];
    if (!Klass) {
      throw new ConfigError(
        `Khong biet nen tang '${platformId}'${platformId === key ? '' : ` (kenh '${key}')`}. `
        + `Cac nen tang ho tro: ${Object.keys(this.registry).join(', ')}`,
        { details: { known: Object.keys(this.registry), key, platformId } },
      );
    }
    return Klass;
  }

  _buildInstances() {
    for (const [id, cfg] of Object.entries(this.platformConfigs)) {
      if (cfg.enabled === false) {
        this.logger.debug('kenh bi tat trong cau hinh', { channel: id });
        continue;
      }
      const Klass = this._resolveClass(id, cfg);
      const instance = new Klass(cfg, {
        http: this.http,
        logger: this.logger,
        store: this.store,
        mediaHost: cfg.mediaHost ?? this.mediaHost,
        dryRun: this.dryRun,
      });
      this.instances.set(id, instance);
    }
  }

  /**
   * Dang ky them mot adapter tu viet.
   * @param {typeof import('../platforms/base.js').BasePlatform} PlatformClass
   * @param {object} [config]
   */
  use(PlatformClass, config = {}) {
    const id = PlatformClass.id;
    this.registry[id] = PlatformClass;
    this.platformConfigs[id] = config;
    this.instances.set(
      id,
      new PlatformClass(config, {
        http: this.http,
        logger: this.logger,
        store: this.store,
        mediaHost: config.mediaHost ?? this.mediaHost,
        dryRun: this.dryRun,
      }),
    );
    return this;
  }

  /** Danh sach id nen tang dang bat. */
  get enabledPlatforms() {
    return [...this.instances.keys()];
  }

  /**
   * Lay instance mot nen tang (de goi ham rieng, vd youtube.setThumbnail).
   * @param {string} id
   */
  platform(id) {
    const p = this.instances.get(id);
    if (!p) throw new ConfigError(`Nen tang '${id}' chua duoc cau hinh`);
    return p;
  }

  /**
   * Kiem tra token/quyen cua tat ca nen tang dang bat.
   * @returns {Promise<Record<string, {ok: boolean, account?: object, error?: string}>>}
   */
  async verifyAll() {
    /** @type {Record<string, any>} */
    const out = {};
    const entries = [...this.instances.entries()];
    const results = await mapSettledLimit(
      entries.map(([, p]) => async () => p.verifyCredentials()),
      this.concurrency,
    );
    entries.forEach(([id], i) => {
      const r = results[i];
      if (r.status === 'fulfilled') {
        out[id] = r.value;
      } else {
        const e = toSocialPostError(r.reason, { platform: id });
        out[id] = { ok: false, error: e.message, code: e.code };
      }
    });
    return out;
  }

  /**
   * Dang bai len cac nen tang.
   *
   * @param {import('./post.js').PostInput} input
   * @param {object} [opts]
   * @param {string[]} [opts.platforms] Ghi de danh sach nen tang.
   * @param {AbortSignal} [opts.signal]
   * @param {boolean} [opts.dryRun]
   * @returns {Promise<PostReport>}
   */
  async post(input, opts = {}) {
    const startedAt = new Date();
    const dryRun = opts.dryRun ?? this.dryRun;

    const post = await normalizePost(input, { signal: opts.signal });
    const targets = this._resolveTargets(post, opts.platforms);

    this.logger.info('bat dau dang bai', {
      platforms: targets.map((t) => t.id),
      media: post.media.length,
      hashtags: post.hashtags.length,
      dryRun,
    });
    await this.hooks.onStart?.({ post, platforms: targets.map((t) => t.id), dryRun });

    const tasks = targets.map((target) => async () => this._publishOne(target, post, { ...opts, dryRun }));
    const settled = await mapSettledLimit(tasks, this.concurrency);

    /** @type {PlatformOutcome[]} */
    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      // _publishOne da bat loi, nhung phong truong hop loi ngoai du kien.
      const e = toSocialPostError(r.reason, { platform: targets[i].id });
      return {
        platform: targets[i].id,
        ok: false,
        skipped: false,
        durationMs: 0,
        error: e.toJSON(),
        errorObject: e,
      };
    });

    const finishedAt = new Date();
    /** @type {PostReport} */
    const report = {
      ok: results.every((r) => r.ok || r.skipped),
      dryRun,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      results,
      byChannel: Object.fromEntries(results.map((r) => [r.channel ?? r.platform, r])),
      byPlatform: Object.fromEntries(results.map((r) => [r.platform, r])),
      succeeded: results.filter((r) => r.ok && !r.skipped).map((r) => r.platform),
      failed: results.filter((r) => !r.ok && !r.skipped).map((r) => r.platform),
      skipped: results.filter((r) => r.skipped).map((r) => r.platform),
      post: post.toJSON(),
    };

    this.logger.info('ket thuc dang bai', {
      ok: report.ok,
      succeeded: report.succeeded,
      failed: report.failed,
      skipped: report.skipped,
      durationMs: report.durationMs,
    });
    await this.hooks.onFinish?.(report);

    if (this.throwOnError && report.failed.length > 0) {
      const errors = Object.fromEntries(
        results.filter((r) => r.errorObject).map((r) => [r.platform, /** @type {Error} */ (r.errorObject)]),
      );
      throw new AggregatePostError(
        `Dang bai that bai o: ${report.failed.join(', ')}`,
        errors,
        { details: { report: { succeeded: report.succeeded, failed: report.failed } } },
      );
    }
    return report;
  }

  /**
   * @param {{id: string, instance: import('../platforms/base.js').BasePlatform}} target
   * @param {import('./post.js').Post} post
   * @param {object} opts
   * @returns {Promise<PlatformOutcome>}
   */
  async _publishOne(target, post, opts) {
    const { id, instance } = target;
    const started = Date.now();
    const log = this.logger.child({ platform: id });

    const support = instance.supports(post);
    if (!support.ok) {
      log.warn('bo qua nen tang', { reason: support.reason });
      const err = new UnsupportedError(/** @type {string} */ (support.reason), { platform: id });
      return {
        platform: id,
        ok: false,
        skipped: true,
        reason: support.reason,
        durationMs: Date.now() - started,
        error: err.toJSON(),
        errorObject: err,
      };
    }

    // Signal da bi huy truoc khi den luot minh (dang xep hang sau concurrency cap)
    // -> khong duoc dang nua.
    if (opts.signal?.aborted) {
      const err = new AbortError('Da huy truoc khi dang len nen tang nay', { platform: id });
      return {
        platform: id,
        channel: id,
        ok: false,
        skipped: true,
        reason: 'da huy',
        durationMs: Date.now() - started,
        error: err.toJSON(),
        errorObject: err,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`timeout ${this.timeoutMsPerPlatform}ms`)),
      this.timeoutMsPerPlatform,
    );
    if (typeof timer.unref === 'function') timer.unref();
    const onOuterAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

    // Moi lan dang tao instance rieng de khong dung chung state (signal, cleanups).
    const runner = this._instanceFor(id, { signal: controller.signal, dryRun: opts.dryRun });

    try {
      await this.hooks.onPlatformStart?.({ platform: id, post });
      log.info('dang gui bai');
      const res = await runner.publish(post);
      const outcome = /** @type {PlatformOutcome} */ ({
        channel: id,
        platform: id,
        platformType: runner.id,
        ok: res.ok !== false,
        skipped: false,
        id: res.id,
        url: res.url,
        status: res.status,
        raw: res.raw,
        meta: res.meta,
        durationMs: Date.now() - started,
      });
      log.info('dang bai thanh cong', { id: res.id, url: res.url, status: res.status, ms: outcome.durationMs });
      await this.hooks.onPlatformSuccess?.({ platform: id, result: outcome, post });
      return outcome;
    } catch (rawErr) {
      const err = toSocialPostError(rawErr, { platform: id });
      log.error('dang bai that bai', { code: err.code, message: err.message, hint: err.hint });
      await this.hooks.onPlatformError?.({ platform: id, error: err, post });
      return {
        platform: id,
        ok: false,
        skipped: false,
        durationMs: Date.now() - started,
        attempts: /** @type {any} */ (err).attempts,
        error: err.toJSON(),
        errorObject: err,
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /**
   * Tao instance moi cho mot lan dang (co signal rieng).
   * @param {string} id
   * @param {{signal?: AbortSignal, dryRun?: boolean}} ctx
   */
  _instanceFor(id, ctx) {
    const cfg = this.platformConfigs[id];
    const Klass = this._resolveClass(id, cfg);
    return new Klass(cfg, {
      http: this.http,
      logger: this.logger,
      store: this.store,
      mediaHost: cfg.mediaHost ?? this.mediaHost,
      dryRun: ctx.dryRun ?? this.dryRun,
      signal: ctx.signal,
    });
  }

  /**
   * @param {import('./post.js').Post} post
   * @param {string[]} [override]
   */
  _resolveTargets(post, override) {
    const wanted = override ?? post.platforms;
    const all = [...this.instances.entries()].map(([id, instance]) => ({ id, instance }));
    if (!wanted || wanted.length === 0) {
      if (all.length === 0) {
        throw new ConfigError('Chua cau hinh nen tang nao. Truyen `platforms` khi khoi tao SocialPoster.');
      }
      return all;
    }
    const unknown = wanted.filter((id) => !this.instances.has(id));
    if (unknown.length > 0) {
      throw new ConfigError(
        `Nen tang chua duoc cau hinh hoac dang bi tat: ${unknown.join(', ')}. Dang bat: ${this.enabledPlatforms.join(', ') || '(khong co)'}`,
        { details: { unknown, enabled: this.enabledPlatforms } },
      );
    }
    return all.filter((t) => wanted.includes(t.id));
  }

  /** Don dep tai nguyen (dong local media server neu co). */
  async close() {
    const host = /** @type {any} */ (this.mediaHost);
    if (host && typeof host.close === 'function') await host.close();
    for (const cfg of Object.values(this.platformConfigs)) {
      const h = /** @type {any} */ (cfg?.mediaHost);
      if (h && typeof h.close === 'function' && h !== host) await h.close();
    }
  }
}

/** @param {unknown} x */
function isLogger(x) {
  return Boolean(x && typeof /** @type {any} */ (x).info === 'function' && typeof /** @type {any} */ (x).child === 'function');
}

export { noopLogger };
