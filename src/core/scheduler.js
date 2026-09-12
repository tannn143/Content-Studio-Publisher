/**
 * Scheduler: dang cac bai da den gio trong queue.
 *
 * Vi sao can: Instagram, TikTok va Telegram KHONG ho tro hen gio qua API.
 * Muon co tinh nang "len lich" giong Buffer thi phai tu giu queue va tu dang dung gio.
 * (Facebook/YouTube co hen gio native, nhung de dong nhat thi queue nay quan ly het.)
 */

import { toSocialPostError } from './errors.js';

export class PostScheduler {
  /**
   * @param {object} opts
   * @param {import('./store/workspace.js').Workspace} opts.workspace
   * @param {import('./publishservice.js').PublishService} opts.publisher
   * @param {import('./logger.js').Logger} opts.logger
   * @param {number} [opts.intervalMs=30000]
   * @param {number} [opts.maxAttempts=3]
   * @param {{emit: (type: string, data: any) => void}} [opts.events]
   */
  constructor(opts) {
    this.workspace = opts.workspace;
    this.publisher = opts.publisher;
    this.logger = opts.logger;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.events = opts.events ?? { emit: () => {} };
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.running = false;
    this.lastTickAt = null;
  }

  start() {
    if (this.timer) return this;
    this.logger.info('scheduler started', { intervalMs: this.intervalMs });
    // Chay ngay mot lan roi lap.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('scheduler stopped');
    }
    return this;
  }

  /**
   * Mot vong kiem tra: lay cac bai den gio va dang lan luot.
   * Dang TUAN TU de khong lam qua tai rate limit cua nen tang.
   * @returns {Promise<{published: number, failed: number}>}
   */
  async tick() {
    if (this.running) return { published: 0, failed: 0 };
    this.running = true;
    this.lastTickAt = new Date().toISOString();
    let published = 0;
    let failed = 0;

    try {
      const due = await this.workspace.duePosts();
      if (due.length > 0) {
        this.logger.info('co bai den gio dang', { count: due.length });
      }
      for (const post of due) {
        try {
          const res = await this.publisher.publishPost(post.id);
          if (res.post?.status === 'posted') published += 1;
          else failed += 1;
        } catch (rawErr) {
          const err = toSocialPostError(rawErr);
          failed += 1;
          const attempts = (post.attempts ?? 0) + 1;
          // Loi tam thoi -> lui lich de thu lai; loi vinh vien -> danh dau that bai.
          if (err.retryable && attempts < this.maxAttempts) {
            const delayMin = 5 * attempts;
            const next = new Date(Date.now() + delayMin * 60_000).toISOString();
            await this.workspace.updatePost(post.id, {
              status: 'queued',
              scheduledAt: next,
              note: `Thu lai lan ${attempts} sau ${delayMin} phut: ${err.message}`,
            });
            this.logger.warn('temporary failure - the post was rescheduled', {
              postId: post.id,
              next,
              error: err.message,
            });
            this.events.emit('post:retry', { postId: post.id, nextAt: next, message: err.message });
          } else {
            await this.workspace.updatePost(post.id, { status: 'failed', note: err.message });
            this.logger.error('post failed', { postId: post.id, error: err.message });
          }
        }
      }
    } catch (err) {
      this.logger.error('scheduler tick loi', { error: String(err) });
    } finally {
      this.running = false;
    }
    return { published, failed };
  }

  /** Trang thai de hien thi tren UI. */
  status() {
    return {
      running: Boolean(this.timer),
      busy: this.running,
      intervalMs: this.intervalMs,
      lastTickAt: this.lastTickAt,
    };
  }
}

/**
 * Goi y khung gio dang tiep theo (kieu "posting schedule" cua Buffer).
 *
 * @param {string[]} times Danh sach gio dang dang 'HH:mm' theo mui gio `timezone`.
 * @param {object} [opts]
 * @param {Date} [opts.from]
 * @param {number} [opts.count=10]
 * @param {string} [opts.timezone='Asia/Ho_Chi_Minh']
 * @param {string[]} [opts.taken] Cac thoi diem da co bai (ISO) - se bi bo qua.
 * @returns {string[]} Danh sach ISO string.
 */
export function nextSlots(times, opts = {}) {
  const {
    from = new Date(),
    count = 10,
    timezone = 'Asia/Ho_Chi_Minh',
    taken = [],
  } = opts;

  const clean = (times ?? [])
    .map((t) => /^(\d{1,2}):(\d{2})$/.exec(String(t).trim()))
    .filter(Boolean)
    .map((m) => ({ h: Number(m[1]), m: Number(m[2]) }))
    .filter((t) => t.h >= 0 && t.h < 24 && t.m >= 0 && t.m < 60)
    .sort((a, b) => a.h - b.h || a.m - b.m);
  if (clean.length === 0) return [];

  const takenSet = new Set(taken.map((t) => new Date(t).toISOString().slice(0, 16)));
  /** @type {string[]} */
  const out = [];

  for (let dayOffset = 0; dayOffset < 60 && out.length < count; dayOffset += 1) {
    const day = new Date(from.getTime() + dayOffset * 86_400_000);
    for (const t of clean) {
      const iso = zonedTimeToIso(day, t.h, t.m, timezone);
      if (!iso) continue;
      const when = new Date(iso);
      if (when.getTime() <= from.getTime() + 60_000) continue;
      if (takenSet.has(when.toISOString().slice(0, 16))) continue;
      out.push(iso);
      if (out.length >= count) break;
    }
  }
  return out;
}

/**
 * Doi "ngay + gio local theo timezone" thanh ISO UTC.
 * Dung Intl de khong phai cai thu vien timezone.
 *
 * @param {Date} day
 * @param {number} hour
 * @param {number} minute
 * @param {string} timezone
 * @returns {string | null}
 */
export function zonedTimeToIso(day, hour, minute, timezone) {
  try {
    // Lay ngay (y-m-d) cua `day` theo timezone dich.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(day);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const y = get('year');
    const mo = get('month');
    const d = get('day');
    if (!y || !mo || !d) return null;

    // Doan UTC roi hieu chinh theo do lech mui gio thuc te (xu ly ca DST).
    const guess = Date.UTC(y, mo - 1, d, hour, minute, 0);
    const offset = timezoneOffsetMs(new Date(guess), timezone);
    return new Date(guess - offset).toISOString();
  } catch {
    return null;
  }
}

/**
 * Do lech mui gio (ms) tai mot thoi diem.
 * @param {Date} date
 * @param {string} timezone
 * @returns {number}
 */
export function timezoneOffsetMs(date, timezone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - date.getTime();
}
