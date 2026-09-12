/**
 * PublishService: bien mot PostRecord trong workspace thanh mot lan dang thuc te.
 *
 * Dung chung cho ca "Dang ngay" (tu web admin) va scheduler (dang theo lich).
 */

import { SocialPoster } from './poster.js';
import { Workspace, publicChannel } from './store/workspace.js';
import { FileTokenStore } from './tokenstore.js';
import { S3MediaHost } from './mediahost/s3.js';
import { LocalTunnelMediaHost } from './mediahost/localserver.js';
import { toSocialPostError } from './errors.js';
import { normalizeHashtags } from './text.js';

export class PublishService {
  /**
   * @param {object} opts
   * @param {Workspace} opts.workspace
   * @param {import('./logger.js').Logger} opts.logger
   * @param {{emit: (type: string, data: any) => void}} [opts.events]
   */
  constructor(opts) {
    this.workspace = opts.workspace;
    this.logger = opts.logger;
    this.events = opts.events ?? { emit: () => {} };
    this.tokenStore = new FileTokenStore(this.workspace.tokensPath);
    /** @type {any} */
    this._mediaHost = undefined;
    this._mediaHostKey = '';
  }

  /** Tao mediaHost tu settings (Instagram/TikTok anh can URL cong khai). */
  async _getMediaHost() {
    const settings = await this.workspace.settings.read();
    const cfg = settings.mediaHost ?? { type: 'none' };
    const key = JSON.stringify(cfg);
    if (this._mediaHostKey === key) return this._mediaHost;

    // Cau hinh doi -> dong cai cu neu no co tai nguyen (local server).
    if (this._mediaHost?.close) await this._mediaHost.close().catch(() => {});
    this._mediaHostKey = key;
    this._mediaHost = undefined;

    if (cfg.type === 's3' && cfg.s3?.bucket && cfg.s3?.accessKeyId && cfg.s3?.secretAccessKey) {
      this._mediaHost = new S3MediaHost({ ...cfg.s3, logger: this.logger });
    } else if (cfg.type === 'tunnel' && cfg.tunnel?.publicBaseUrl) {
      this._mediaHost = new LocalTunnelMediaHost({ ...cfg.tunnel, logger: this.logger });
    }
    return this._mediaHost;
  }

  async close() {
    if (this._mediaHost?.close) await this._mediaHost.close().catch(() => {});
  }

  /**
   * Dung input cho SocialPoster tu PostRecord.
   * @param {import('./store/workspace.js').PostRecord} record
   * @param {import('./store/workspace.js').Channel[]} channels
   */
  async buildPostInput(record, channels) {
    const mediaRecords = await this.workspace.getMediaList(record.mediaIds ?? []);
    const missing = [];
    for (const m of mediaRecords) {
      if (!(await this.workspace.mediaExists(m))) missing.push(m.filename);
    }
    if (missing.length > 0) {
      throw new Error(`Media files missing from disk: ${missing.join(', ')}`);
    }

    const media = mediaRecords.map((m) => ({
      path: m.storedPath,
      filename: m.filename,
      mime: m.mime,
      type: m.kind,
      width: m.width,
      height: m.height,
      duration: m.durationSec,
    }));

    // perChannel: ghi de theo KENH -> quy doi thanh overrides theo key kenh.
    /** @type {Record<string, any>} */
    const overrides = {};
    for (const ch of channels) {
      const per = record.perChannel?.[ch.id] ?? {};
      const { title, description, hashtags, ...rest } = per;
      overrides[ch.id] = { ...rest };
      if (title !== undefined) overrides[ch.id].title = title;
      if (description !== undefined) overrides[ch.id].description = description;
      if (hashtags !== undefined) overrides[ch.id].hashtags = normalizeHashtags(hashtags);
    }

    return {
      title: record.content?.title ?? '',
      description: record.content?.description ?? '',
      hashtags: record.content?.hashtags ?? [],
      link: record.content?.link,
      media,
      platforms: channels.map((c) => c.id),
      overrides,
    };
  }

  /**
   * Dang mot PostRecord.
   *
   * @param {string} postId
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun=false]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{post: import('./store/workspace.js').PostRecord, report: any}>}
   */
  async publishPost(postId, opts = {}) {
    const record = await this.workspace.posts.get(postId);
    if (!record) throw new Error(`Post '${postId}' not found`);

    const channels = await this.workspace.getChannels(record.channelIds);
    const usable = channels.filter((c) => c.enabled);
    if (usable.length === 0) {
      const err = 'This post has no enabled account';
      await this.workspace.updatePost(postId, { status: 'failed', note: err });
      throw new Error(err);
    }

    await this.workspace.updatePost(postId, {
      status: opts.dryRun ? record.status : 'publishing',
      attempts: (record.attempts ?? 0) + 1,
    });
    this.events.emit('post:start', { postId, channels: usable.map((c) => c.id), dryRun: Boolean(opts.dryRun) });

    const settings = await this.workspace.settings.read();
    const mediaHost = await this._getMediaHost();

    const poster = new SocialPoster({
      platforms: Workspace.toPosterPlatforms(usable),
      logger: this.logger,
      store: this.tokenStore,
      mediaHost,
      dryRun: Boolean(opts.dryRun),
      concurrency: settings.publishing?.concurrency ?? 3,
      retry: { retries: settings.publishing?.retries ?? 3, minDelayMs: 1500, maxDelayMs: 30_000 },
      hooks: {
        onPlatformStart: ({ platform }) => this.events.emit('channel:start', { postId, channelId: platform }),
        onPlatformSuccess: ({ platform, result }) => this.events.emit('channel:done', {
          postId,
          channelId: platform,
          url: result.url,
          id: result.id,
          status: result.status,
        }),
        onPlatformError: ({ platform, error }) => this.events.emit('channel:error', {
          postId,
          channelId: platform,
          message: error.message,
          code: error.code,
          hint: error.hint,
        }),
      },
    });

    /** @type {any} */
    let report;
    try {
      const input = await this.buildPostInput(record, usable);
      report = await poster.post(input, { signal: opts.signal, dryRun: opts.dryRun });
    } catch (rawErr) {
      const err = toSocialPostError(rawErr);
      await this.workspace.updatePost(postId, {
        status: 'failed',
        note: err.message,
        report: { ok: false, error: err.toJSON() },
      });
      this.events.emit('post:error', { postId, message: err.message, code: err.code, hint: err.hint });
      throw err;
    } finally {
      // Khong dong mediaHost o day: no duoc dung lai cho cac lan dang sau.
    }

    // Cap nhat trang thai tung kenh.
    for (const r of report.results) {
      const channelId = r.channel ?? r.platform;
      if (r.ok && !r.skipped) {
        await this.workspace.touchChannel(channelId);
        await this.workspace.setChannelError(channelId, null);
      } else if (!r.skipped) {
        await this.workspace.setChannelError(channelId, {
          message: r.error?.message ?? 'unknown error',
          code: r.error?.code,
        });
      }
    }

    const okCount = report.succeeded.length;
    const failCount = report.failed.length;
    const status = opts.dryRun
      ? record.status
      : failCount === 0
        ? 'posted'
        : okCount > 0 ? 'partial' : 'failed';

    const updated = await this.workspace.updatePost(postId, {
      status,
      report: slimReport(report),
      publishedAt: opts.dryRun ? record.publishedAt : new Date().toISOString(),
      note: failCount > 0 ? `Failed on: ${report.failed.join(', ')}` : undefined,
    });

    this.events.emit('post:done', {
      postId,
      status,
      succeeded: report.succeeded,
      failed: report.failed,
      skipped: report.skipped,
      dryRun: Boolean(opts.dryRun),
    });

    return { post: /** @type {any} */ (updated), report: slimReport(report) };
  }

  /**
   * Lay creator_info cua mot kenh TikTok.
   *
   * Web admin goi truoc khi soan bai de dung form dang dung theo yeu cau UX cua
   * TikTok: privacy_level chi duoc liet ke tu privacy_level_options, va cac o
   * comment/duet/stitch phai khoa lai neu creator da tat o cap tai khoan.
   * KHONG cache: creator co the doi tai khoan sang private bat cu luc nao.
   *
   * @param {string} channelId
   * @returns {Promise<Record<string, any>>}
   */
  async getCreatorInfo(channelId) {
    const all = await this.workspace.listChannels();
    const channel = all.find((c) => c.id === channelId);
    if (!channel) throw new Error(`Channel '${channelId}' not found`);
    if (channel.platform !== 'tiktok') {
      throw new Error(`Channel '${channelId}' is not a TikTok account, so it has no creator_info`);
    }

    const poster = new SocialPoster({
      platforms: Workspace.toPosterPlatforms([channel]),
      logger: this.logger,
      store: this.tokenStore,
      concurrency: 1,
    });
    const info = await poster.platform(channelId).getCreatorInfo();

    return {
      nickname: info.creator_nickname,
      username: info.creator_username,
      avatarUrl: info.creator_avatar_url,
      privacyLevelOptions: Array.isArray(info.privacy_level_options) ? info.privacy_level_options : [],
      commentDisabled: Boolean(info.comment_disabled),
      duetDisabled: Boolean(info.duet_disabled),
      stitchDisabled: Boolean(info.stitch_disabled),
      maxVideoPostDurationSec: info.max_video_post_duration_sec,
    };
  }

  /**
   * Kiem tra token cua tat ca kenh (hoac mot kenh).
   * @param {string} [channelId]
   */
  async verifyChannels(channelId) {
    const all = await this.workspace.listChannels();
    const channels = channelId ? all.filter((c) => c.id === channelId) : all;
    if (channels.length === 0) return {};

    const poster = new SocialPoster({
      platforms: Workspace.toPosterPlatforms(channels),
      logger: this.logger,
      store: this.tokenStore,
      mediaHost: await this._getMediaHost(),
      concurrency: 4,
    });
    const results = await poster.verifyAll();

    for (const [id, res] of Object.entries(results)) {
      if (res.ok) {
        await this.workspace.setChannelError(id, null);
        // Cap nhat ten/avatar neu nen tang tra ve.
        const acc = /** @type {any} */ (res).account;
        if (acc?.username || acc?.name || acc?.title) {
          await this.workspace.channels.update(id, {
            username: acc.username ?? acc.customUrl ?? undefined,
            name: acc.title ?? acc.name ?? acc.nickname ?? undefined,
          });
        }
      } else {
        await this.workspace.setChannelError(id, {
          message: String(/** @type {any} */ (res).error?.message ?? /** @type {any} */ (res).error ?? 'error'),
          code: /** @type {any} */ (res).code,
        });
      }
    }

    const channelMap = new Map((await this.workspace.listChannels()).map((c) => [c.id, c]));
    /** @type {Record<string, any>} */
    const out = {};
    for (const [id, res] of Object.entries(results)) {
      out[id] = {
        ok: res.ok,
        account: /** @type {any} */ (res).account,
        error: res.ok ? undefined : String(/** @type {any} */ (res).error?.message ?? /** @type {any} */ (res).error),
        hint: /** @type {any} */ (res).error?.hint,
        channel: channelMap.get(id) ? publicChannel(/** @type {any} */ (channelMap.get(id))) : undefined,
      };
    }
    return out;
  }
}

/** Bo bot du lieu tho de file posts.json khong phinh. */
function slimReport(report) {
  return {
    ok: report.ok,
    dryRun: report.dryRun,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    durationMs: report.durationMs,
    succeeded: report.succeeded,
    failed: report.failed,
    skipped: report.skipped,
    results: report.results.map((r) => ({
      channel: r.channel ?? r.platform,
      platform: r.platformType ?? r.platform,
      ok: r.ok,
      skipped: r.skipped,
      reason: r.reason,
      id: r.id,
      url: r.url,
      status: r.status,
      durationMs: r.durationMs,
      meta: r.meta,
      error: r.error
        ? {
          code: r.error.code,
          message: r.error.message,
          hint: r.error.hint,
          retryable: r.error.retryable,
          httpStatus: r.error.httpStatus,
        }
        : undefined,
      // Preview caption khi dry-run.
      preview: r.raw?.caption ?? undefined,
    })),
  };
}
