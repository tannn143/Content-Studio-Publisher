/**
 * Lop co so cho moi nen tang.
 *
 * Mot adapter nen tang chi can:
 *  1. Khai bao `static id`, `static capabilities`
 *  2. Cai `validateConfig()` (neu can), `verifyCredentials()`, `doPublish(post, options)`
 *
 * Cac viec dung chung (build caption, xin URL cong khai, poll trang thai, dry-run,
 * bat loi va chuan hoa) da co san o day.
 */

import { ConfigError, UnsupportedError } from '../core/errors.js';
import { buildCaption } from '../core/text.js';
import { ensurePublicUrl } from '../core/mediahost/index.js';
import { pollUntil } from '../core/retry.js';
import { noopLogger } from '../core/logger.js';
import { HttpClient } from '../core/http.js';
import { MemoryTokenStore } from '../core/tokenstore.js';

/**
 * @typedef {object} PlatformCapabilities
 * @property {boolean} text            Dang duoc bai chi co chu (khong media).
 * @property {boolean} image
 * @property {boolean} video
 * @property {boolean} album           Nhieu media trong 1 bai.
 * @property {boolean} requiresPublicUrl  Bat buoc media phai la URL cong khai.
 * @property {number} maxMediaCount
 * @property {boolean} supportsSchedule
 * @property {{title: number, caption: number, hashtags: number}} limits
 * @property {string[]} [imageMime]
 * @property {string[]} [videoMime]
 * @property {number} [maxImageBytes]
 * @property {number} [maxVideoBytes]
 * @property {number} [maxVideoSec]
 */

/**
 * @typedef {object} PublishResult
 * @property {string} platform
 * @property {boolean} ok
 * @property {string} [id]          Id bai dang tren nen tang.
 * @property {string} [url]         Link xem bai dang.
 * @property {string} [status]      'published' | 'scheduled' | 'processing' | 'draft'
 * @property {any} [raw]            Response tho de debug.
 * @property {object} [meta]
 */

export class BasePlatform {
  /** Ma nen tang, dung lam key trong config va ket qua. */
  static id = 'base';

  static displayName = 'Base';

  /** @type {PlatformCapabilities} */
  static capabilities = {
    text: false,
    image: false,
    video: false,
    album: false,
    requiresPublicUrl: false,
    maxMediaCount: 1,
    supportsSchedule: false,
    limits: { title: Infinity, caption: Infinity, hashtags: Infinity },
  };

  /**
   * @param {Record<string, any>} [config] Cau hinh rieng cua nen tang.
   * @param {object} [ctx]
   * @param {HttpClient} [ctx.http]
   * @param {import('../core/logger.js').Logger} [ctx.logger]
   * @param {import('../core/tokenstore.js').TokenStore} [ctx.store]
   * @param {import('../core/mediahost/index.js').MediaHost} [ctx.mediaHost]
   * @param {boolean} [ctx.dryRun]
   * @param {AbortSignal} [ctx.signal]
   */
  constructor(config = {}, ctx = {}) {
    /** @type {Record<string, any>} */
    this.config = config ?? {};
    this.logger = (ctx.logger ?? noopLogger).child({ platform: this.id });
    this.http = (ctx.http ?? new HttpClient({ logger: this.logger })).child({ logger: this.logger });
    this.store = ctx.store ?? new MemoryTokenStore();
    this.mediaHost = ctx.mediaHost;
    this.dryRun = ctx.dryRun ?? false;
    this.signal = ctx.signal;
    /** @type {Array<() => Promise<void>>} Cac viec don dep sau khi dang xong. */
    this._cleanups = [];
  }

  /** @returns {string} */
  get id() {
    return /** @type {typeof BasePlatform} */ (this.constructor).id;
  }

  /** @returns {string} */
  get displayName() {
    return /** @type {typeof BasePlatform} */ (this.constructor).displayName;
  }

  /** @returns {PlatformCapabilities} */
  get capabilities() {
    return /** @type {typeof BasePlatform} */ (this.constructor).capabilities;
  }

  // ---------------------------------------------------------------- cau hinh

  /**
   * Bao dam cac key cau hinh bat buoc da co.
   * @param {string[]} keys
   * @param {object} [opts]
   * @param {string} [opts.hint]
   */
  requireConfig(keys, opts = {}) {
    const missing = keys.filter((k) => {
      const v = this.config[k];
      return v === undefined || v === null || v === '';
    });
    if (missing.length > 0) {
      throw new ConfigError(
        `[${this.id}] thieu cau hinh: ${missing.join(', ')}`,
        { platform: this.id, hint: opts.hint, details: { missing } },
      );
    }
  }

  /** Ghi de neu can kiem tra cau hinh sau hon. */
  validateConfig() {
    return true;
  }

  /**
   * Kiem tra token/quyen truy cap con dung khong (khong dang bai).
   * @returns {Promise<{ok: boolean, account?: object, error?: Error}>}
   */
  async verifyCredentials() {
    return { ok: true };
  }

  // ------------------------------------------------------------ kha nang dang

  /**
   * Nen tang co dang duoc bai nay khong.
   * @param {import('../core/post.js').Post} post
   * @returns {{ok: boolean, reason?: string}}
   */
  supports(post) {
    const cap = this.capabilities;
    if (post.isTextOnly && !cap.text) {
      return { ok: false, reason: `${this.displayName} khong dang duoc bai chi co chu (can it nhat 1 anh/video)` };
    }
    if (post.videos.length > 0 && !cap.video) {
      return { ok: false, reason: `${this.displayName} khong ho tro video` };
    }
    if (post.videos.length === 0 && post.images.length > 0 && !cap.image) {
      return { ok: false, reason: `${this.displayName} khong ho tro anh` };
    }
    if (post.media.length > cap.maxMediaCount && !cap.album) {
      return { ok: false, reason: `${this.displayName} chi nhan toi da ${cap.maxMediaCount} media moi bai` };
    }
    if (post.scheduleAt && !cap.supportsSchedule) {
      return { ok: false, reason: `${this.displayName} khong ho tro hen gio qua API` };
    }
    return { ok: true };
  }

  /**
   * Dang bai. Khong ghi de ham nay - ghi de `doPublish`.
   * @param {import('../core/post.js').Post} post
   * @returns {Promise<PublishResult>}
   */
  async publish(post) {
    this.validateConfig();
    const check = this.supports(post);
    if (!check.ok) {
      throw new UnsupportedError(/** @type {string} */ (check.reason), { platform: this.id });
    }

    const options = { ...this.config.defaults, ...post.optionsFor(this.id) };

    if (this.dryRun) {
      const preview = await this.dryRunPreview(post, options);
      this.logger.info('dry-run: khong goi API', { preview: preview.summary });
      return {
        platform: this.id,
        ok: true,
        status: 'dry-run',
        id: undefined,
        url: undefined,
        raw: preview,
        meta: { dryRun: true },
      };
    }

    try {
      return await this.doPublish(post, options);
    } finally {
      await this.runCleanups();
    }
  }

  /**
   * Cai dat thuc te cua tung nen tang.
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   * @returns {Promise<PublishResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async doPublish(post, options) {
    throw new Error(`${this.id}: chua cai dat doPublish()`);
  }

  /**
   * Xem truoc noi dung se gui (dung cho dryRun).
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   */
  async dryRunPreview(post, options) {
    const caption = this.buildCaption(post, options);
    return {
      platform: this.id,
      caption: caption.text,
      captionLength: caption.length,
      droppedHashtags: caption.droppedHashtags,
      truncated: caption.truncated,
      media: post.media.map((m) => m.toJSON()),
      options,
      summary: `${this.displayName}: ${post.media.length} media, caption ${caption.length} ky tu`,
    };
  }

  // ------------------------------------------------------------------ helper

  /**
   * Dung caption theo gioi han cua nen tang.
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} [options]
   * @returns {{text: string, truncated: boolean, droppedHashtags: number, length: number}}
   */
  buildCaption(post, options = {}) {
    const cap = this.capabilities;
    return buildCaption(
      {
        title: post.title,
        description: post.description,
        hashtags: post.hashtags,
        link: post.link,
      },
      {
        maxLength: options.maxCaptionLength ?? cap.limits.caption,
        maxHashtags: options.maxHashtags ?? cap.limits.hashtags,
        includeTitle: options.includeTitle ?? true,
        includeHashtags: options.includeHashtags ?? true,
        includeLink: options.includeLink ?? true,
        template: options.captionTemplate ?? this.config.captionTemplate,
        titleSeparator: options.titleSeparator,
        hashtagSeparator: options.hashtagSeparator,
      },
    );
  }

  /**
   * Bao dam media co URL cong khai (dung MediaHost neu la file local).
   * Tu dong don dep file tam sau khi dang xong.
   * @param {import('../core/media.js').Media} media
   * @param {object} [ctx]
   * @returns {Promise<string>}
   */
  async ensurePublicUrl(media, ctx = {}) {
    const res = await ensurePublicUrl(media, this.mediaHost, {
      platform: this.id,
      signal: this.signal,
      ...ctx,
    });
    if (res.cleanup) this._cleanups.push(res.cleanup);
    return res.url;
  }

  /** Chay cac ham don dep da dang ky (khong nem loi ra ngoai). */
  async runCleanups() {
    const tasks = this._cleanups.splice(0);
    for (const fn of tasks) {
      try {
        await fn();
      } catch (err) {
        this.logger.warn('cleanup that bai', { error: String(err) });
      }
    }
  }

  /**
   * Poll trang thai xu ly cua nen tang (IG container, TikTok publish...).
   * @template T
   * @param {(attempt: number) => Promise<{done: boolean, value?: T, failed?: boolean, reason?: string}>} check
   * @param {object} [opts]
   */
  poll(check, opts = {}) {
    return pollUntil(check, { signal: this.signal, ...opts });
  }

  /** Kiem tra dinh dang/dung luong media theo gioi han nen tang. */
  assertMediaLimits(media) {
    const cap = this.capabilities;
    const isImage = media.kind === 'image';
    const allowed = isImage ? cap.imageMime : cap.videoMime;
    if (allowed && media.mime && !allowed.includes(media.mime)) {
      throw new UnsupportedError(
        `[${this.id}] khong ho tro dinh dang ${media.mime}. Cho phep: ${allowed.join(', ')}`,
        { platform: this.id, details: { mime: media.mime, allowed } },
      );
    }
    const maxBytes = isImage ? cap.maxImageBytes : cap.maxVideoBytes;
    if (maxBytes && media.size && media.size > maxBytes) {
      throw new UnsupportedError(
        `[${this.id}] media ${Math.round(media.size / 1e6)}MB vuot gioi han ${Math.round(maxBytes / 1e6)}MB`,
        { platform: this.id, details: { size: media.size, maxBytes } },
      );
    }
    if (!isImage && cap.maxVideoSec && media.durationSec && media.durationSec > cap.maxVideoSec) {
      throw new UnsupportedError(
        `[${this.id}] video ${Math.round(media.durationSec)}s vuot gioi han ${cap.maxVideoSec}s`,
        { platform: this.id, details: { durationSec: media.durationSec, maxVideoSec: cap.maxVideoSec } },
      );
    }
    return true;
  }
}
