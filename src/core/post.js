/**
 * Chuan hoa & kiem tra input cua nguoi dung thanh doi tuong `Post` dung chung
 * cho tat ca nen tang.
 */

import { ValidationError } from './errors.js';
import { normalizeMediaList } from './media.js';
import { normalizeHashtags, sanitizeText } from './text.js';

/**
 * @typedef {object} PostInput
 * @property {string} [title]                 Tieu de bai dang.
 * @property {string} [description]           Noi dung/mo ta.
 * @property {any} [media]                    1 hoac nhieu media: path | url | {path}|{url}|{buffer} | mang cac thu do.
 * @property {string[] | string} [hashtags]   Hashtag (co hoac khong dau '#').
 * @property {string} [link]                  Link kem theo (Facebook/Telegram dung duoc).
 * @property {string[]} [platforms]           Chi dang len nhung nen tang nay.
 * @property {Date | string | number} [scheduleAt] Hen gio dang (nen tang nao ho tro thi dung).
 * @property {Record<string, object>} [overrides]  Ghi de tham so rieng theo nen tang.
 * @property {string} [idempotencyKey]        Khoa chong dang trung.
 * @property {object} [meta]                  Du lieu tu do, khong gui len nen tang.
 */

export class Post {
  /**
   * @param {object} init
   * @param {string} init.title
   * @param {string} init.description
   * @param {string[]} init.hashtags
   * @param {import('./media.js').Media[]} init.media
   * @param {string} [init.link]
   * @param {string[] | null} [init.platforms]
   * @param {Date | null} [init.scheduleAt]
   * @param {Record<string, object>} [init.overrides]
   * @param {string} [init.idempotencyKey]
   * @param {object} [init.meta]
   */
  constructor(init) {
    this.title = init.title;
    this.description = init.description;
    this.hashtags = init.hashtags;
    this.media = init.media;
    this.link = init.link;
    this.platforms = init.platforms ?? null;
    this.scheduleAt = init.scheduleAt ?? null;
    this.overrides = init.overrides ?? {};
    this.idempotencyKey = init.idempotencyKey;
    this.meta = init.meta ?? {};
  }

  get images() {
    return this.media.filter((m) => m.kind === 'image');
  }

  get videos() {
    return this.media.filter((m) => m.kind === 'video');
  }

  get hasMedia() {
    return this.media.length > 0;
  }

  get isVideoPost() {
    return this.videos.length > 0;
  }

  get isImagePost() {
    return this.videos.length === 0 && this.images.length > 0;
  }

  get isTextOnly() {
    return this.media.length === 0;
  }

  /** Media chinh (video uu tien hon anh). */
  get primaryMedia() {
    return this.videos[0] ?? this.images[0] ?? this.media[0];
  }

  /**
   * Lay tham so ghi de cho mot nen tang.
   * @param {string} platformId
   * @returns {Record<string, any>}
   */
  optionsFor(platformId) {
    return { ...(this.overrides?.[platformId] ?? {}) };
  }

  /** Tao ban sao voi mot vai field bi ghi de. */
  with(patch) {
    return new Post({
      title: this.title,
      description: this.description,
      hashtags: this.hashtags,
      media: this.media,
      link: this.link,
      platforms: this.platforms,
      scheduleAt: this.scheduleAt,
      overrides: this.overrides,
      idempotencyKey: this.idempotencyKey,
      meta: this.meta,
      ...patch,
    });
  }

  toJSON() {
    return {
      title: this.title,
      description: this.description,
      hashtags: this.hashtags,
      link: this.link,
      media: this.media.map((m) => m.toJSON()),
      platforms: this.platforms,
      scheduleAt: this.scheduleAt?.toISOString(),
      idempotencyKey: this.idempotencyKey,
    };
  }
}

/**
 * Chuan hoa + validate input.
 *
 * @param {PostInput} input
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.requireMedia=false]
 * @returns {Promise<Post>}
 */
export async function normalizePost(input, opts = {}) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('Post input must be an object', {
      issues: [{ path: '', message: 'expected object' }],
    });
  }

  /** @type {Array<{path: string, message: string}>} */
  const issues = [];

  const title = sanitizeText(input.title ?? '');
  const description = sanitizeText(input.description ?? '');

  if (input.title != null && typeof input.title !== 'string') {
    issues.push({ path: 'title', message: 'title must be a string' });
  }
  if (input.description != null && typeof input.description !== 'string') {
    issues.push({ path: 'description', message: 'description must be a string' });
  }
  if (input.link != null && typeof input.link !== 'string') {
    issues.push({ path: 'link', message: 'link must be a string' });
  }
  if (input.link && !/^https?:\/\//i.test(input.link)) {
    issues.push({ path: 'link', message: 'link must start with http:// or https://' });
  }
  if (input.platforms != null && !Array.isArray(input.platforms)) {
    issues.push({ path: 'platforms', message: 'platforms must be an array of strings' });
  }
  if (input.overrides != null && (typeof input.overrides !== 'object' || Array.isArray(input.overrides))) {
    issues.push({ path: 'overrides', message: 'overrides must be an object { platformId: {...} }' });
  }

  let scheduleAt = null;
  if (input.scheduleAt != null) {
    const d = input.scheduleAt instanceof Date ? input.scheduleAt : new Date(input.scheduleAt);
    if (Number.isNaN(d.getTime())) {
      issues.push({ path: 'scheduleAt', message: 'scheduleAt is not a valid date' });
    } else {
      scheduleAt = d;
    }
  }

  const hashtags = normalizeHashtags(input.hashtags);

  if (issues.length > 0) {
    throw new ValidationError(`Invalid post input: ${issues.map((i) => `${i.path} - ${i.message}`).join('; ')}`, { issues });
  }

  let media = [];
  try {
    media = await normalizeMediaList(input.media, { signal: opts.signal });
  } catch (err) {
    throw new ValidationError(`Invalid media: ${/** @type {Error} */ (err).message}`, {
      cause: err,
      issues: [{ path: 'media', message: /** @type {Error} */ (err).message }],
    });
  }

  if (!title && !description && media.length === 0) {
    throw new ValidationError('The post is empty: it needs at least a title, a description or media', {
      issues: [{ path: '', message: 'empty post' }],
    });
  }
  if (opts.requireMedia && media.length === 0) {
    throw new ValidationError('This post requires media', {
      issues: [{ path: 'media', message: 'required' }],
    });
  }

  return new Post({
    title,
    description,
    hashtags,
    media,
    link: input.link,
    platforms: Array.isArray(input.platforms) ? input.platforms.map(String) : null,
    scheduleAt,
    overrides: input.overrides ?? {},
    idempotencyKey: input.idempotencyKey,
    meta: input.meta,
  });
}
