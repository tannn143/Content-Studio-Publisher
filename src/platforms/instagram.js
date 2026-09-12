/**
 * Instagram adapter (Instagram Platform Content Publishing API).
 *
 * Ho tro: 1 anh (feed), Reels (video feed), Stories, Carousel (2-10 media).
 *
 * Diem quan trong (docs 2026, Graph v26.0):
 *  - ANH BAT BUOC la URL CONG KHAI, dinh dang JPEG. KHONG co duong upload file anh.
 *    => file anh local phai duoc dua len URL cong khai truoc (dung `mediaHost`).
 *  - VIDEO thi CO the upload byte local qua `upload_type=resumable` + rupload.facebook.com
 *    (header `Authorization: OAuth`, `offset`, `file_size`).
 *  - Dang bai la 2 buoc: tao container (/media) -> cho status_code=FINISHED -> /media_publish.
 *  - Container het han sau 24 gio.
 *  - Loi bat dong bo tra ve HTTP 200 voi status_code=ERROR, ma loi nam trong field `status`.
 *  - Anh feed phai co ty le 4:5 den 1.91:1 (anh doc 9:16 KHONG dang duoc len feed, chi Reels/Stories).
 *
 * Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
 *       https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads/
 */

import { BasePlatform } from './base.js';
import {
  AuthError,
  PlatformError,
  ProcessingError,
  RateLimitError,
  UnsupportedError,
  ValidationError,
} from '../core/errors.js';
import { AccessTokenManager } from '../core/tokenstore.js';

const FB_HOST = 'https://graph.facebook.com';
const IG_HOST = 'https://graph.instagram.com';
const RUPLOAD_HOST = 'https://rupload.facebook.com';
const DEFAULT_VERSION = 'v26.0';

const LIMITS = {
  caption: 2200,
  hashtags: 30,
  mentions: 20,
  altText: 1000,
  userTags: 20,
  collaborators: 3,
  imageBytes: 8 * 1024 * 1024,
  imageMinWidth: 320,
  imageMaxWidth: 1440,
  feedAspectMin: 4 / 5,      // 0.8
  feedAspectMax: 1.91,
  reelBytes: 300 * 1024 * 1024,
  reelMinSec: 3,
  reelMaxSec: 15 * 60,
  storyBytes: 100 * 1024 * 1024,
  storyMaxSec: 60,
  carouselMin: 2,
  carouselMax: 10,
  publishPer24h: 50,         // docs mau thuan (50 vs 100) -> lay so an toan
};

/** Subcode nen thu lai. */
const RETRYABLE_SUBCODES = new Set([2207001, 2207003, 2207008, 2207027, 2207032, 2207053]);

export class InstagramPlatform extends BasePlatform {
  static id = 'instagram';

  static displayName = 'Instagram';

  /** @type {import('./base.js').PlatformCapabilities} */
  static capabilities = {
    text: false, // Instagram khong co bai text-only
    image: true,
    video: true,
    album: true,
    requiresPublicUrl: true, // dung cho ANH; video local co the upload resumable
    maxMediaCount: LIMITS.carouselMax,
    supportsSchedule: false, // API khong ho tro hen gio
    limits: { title: Infinity, caption: LIMITS.caption, hashtags: LIMITS.hashtags },
    imageMime: ['image/jpeg'],
    maxImageBytes: LIMITS.imageBytes,
    maxVideoBytes: LIMITS.reelBytes,
    maxVideoSec: LIMITS.reelMaxSec,
  };

  constructor(config, ctx) {
    super(config, ctx);
    // Chi Instagram Login moi co co che refresh token (60 ngay).
    this.tokens = this.config.useInstagramLogin
      ? new AccessTokenManager({
        key: `instagram:${String(this.config.igUserId)}`,
        store: this.store,
        logger: this.logger,
        initialAccessToken: this.config.accessToken,
        refresh: () => this._refreshLongLivedToken(),
      })
      : null;
  }

  validateConfig() {
    this.requireConfig(['igUserId', 'accessToken'], {
      hint: 'Get igUserId from GET /{page-id}?fields=instagram_business_account. '
        + 'accessToken should be a PAGE access token (Facebook Login) or an Instagram User token (Instagram Login).',
    });
    return true;
  }

  get version() {
    return this.config.graphVersion ?? DEFAULT_VERSION;
  }

  get host() {
    return this.config.useInstagramLogin ? IG_HOST : FB_HOST;
  }

  get api() {
    return `${this.host}/${this.version}`;
  }

  async token() {
    if (this.tokens) return this.tokens.getAccessToken();
    return this.config.accessToken;
  }

  async verifyCredentials() {
    try {
      const token = await this.token();
      const data = await this._get(`/${this.config.igUserId}`, {
        fields: 'id,username,account_type,media_count',
      }, token);
      const quota = await this.getPublishingLimit().catch(() => undefined);
      return {
        ok: true,
        account: {
          id: data?.id,
          username: data?.username,
          accountType: data?.account_type,
          mediaCount: data?.media_count,
          quota,
        },
      };
    } catch (err) {
      return { ok: false, error: /** @type {Error} */ (err) };
    }
  }

  /**
   * Kiem tra quota dang bai trong 24h.
   * @returns {Promise<{used: number, total: number, durationSec: number} | undefined>}
   */
  async getPublishingLimit() {
    const token = await this.token();
    const data = await this._get(`/${this.config.igUserId}/content_publishing_limit`, {
      fields: 'quota_usage,config',
    }, token);
    const row = data?.data?.[0];
    if (!row) return undefined;
    return {
      used: Number(row.quota_usage ?? 0),
      total: Number(row.config?.quota_total ?? LIMITS.publishPer24h),
      durationSec: Number(row.config?.quota_duration ?? 86_400),
    };
  }

  /**
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   * @returns {Promise<import('./base.js').PublishResult>}
   */
  async doPublish(post, options) {
    if (post.media.length === 0) {
      throw new UnsupportedError(
        'Instagram cannot post text only. At least one image or video is required.',
        { platform: this.id, hint: 'For text posts, use the Threads API instead - it is a separate product.' },
      );
    }

    if (options.checkQuota ?? this.config.checkQuota ?? false) {
      const quota = await this.getPublishingLimit().catch(() => undefined);
      if (quota && quota.used >= quota.total) {
        throw new RateLimitError(
          `Instagram's limit of ${quota.total} posts/24h has been reached (${quota.used} posted)`,
          { platform: this.id, retryable: false, details: quota },
        );
      }
      if (quota) this.logger.debug('quota Instagram', quota);
    }

    const target = String(options.target ?? this.config.target ?? 'auto').toLowerCase();
    const caption = this._buildIgCaption(post, options);

    if (target === 'story' || target === 'stories') {
      return this._publishStory(post, options);
    }
    if (post.media.length > 1) {
      return this._publishCarousel(post, options, caption);
    }
    const media = post.media[0];
    return media.kind === 'video'
      ? this._publishReel(post, media, options, caption)
      : this._publishImage(post, media, options, caption);
  }

  // ------------------------------------------------------------------- image

  async _publishImage(post, media, options, caption) {
    await this._assertFeedImage(media);
    const imageUrl = await this.ensurePublicUrl(media, { keyHint: post.title });

    /** @type {Record<string, any>} */
    const params = {
      image_url: imageUrl,
      caption: caption.text || undefined,
      alt_text: truncateOrUndefined(media.altText ?? options.altText, LIMITS.altText),
      location_id: options.locationId,
      user_tags: normalizeUserTags(options.userTags, 'image'),
      collaborators: limitArray(options.collaborators, LIMITS.collaborators),
      is_ai_generated: options.isAiGenerated,
    };

    const containerId = await this._createContainer(params);
    await this._waitContainerReady(containerId, options);
    return this._publishContainer(containerId, { kind: 'image', caption });
  }

  // -------------------------------------------------------------------- reel

  async _publishReel(post, media, options, caption) {
    this.assertMediaLimits(media);
    if (options.probeMedia !== false && !media.durationSec) await media.probeWithFfprobe();
    this._warnReelSpec(media);

    const useResumable = this._shouldUseResumable(media, options);

    /** @type {Record<string, any>} */
    const params = {
      media_type: 'REELS',
      caption: caption.text || undefined,
      share_to_feed: options.shareToFeed ?? this.config.shareToFeed ?? true,
      cover_url: options.coverUrl,
      thumb_offset: validateThumbOffset(options.thumbOffset, media),
      audio_name: options.audioName,
      location_id: options.locationId,
      user_tags: normalizeUserTags(options.userTags, 'video'),
      collaborators: limitArray(options.collaborators, LIMITS.collaborators),
      is_ai_generated: options.isAiGenerated,
    };

    let containerId;
    if (useResumable) {
      params.upload_type = 'resumable';
      const created = await this._createContainer(params, { withUri: true });
      containerId = created.id;
      await this._ruploadVideo(created.uri ?? `${RUPLOAD_HOST}/ig-api-upload/${this.version}/${containerId}`, media, options);
    } else {
      params.video_url = await this.ensurePublicUrl(media, { keyHint: post.title });
      containerId = await this._createContainer(params);
    }

    await this._waitContainerReady(containerId, options);
    return this._publishContainer(containerId, { kind: 'reel', caption, resumable: useResumable });
  }

  // ------------------------------------------------------------------- story

  async _publishStory(post, options) {
    const media = post.media[0];
    if (!media) throw new ValidationError('A Story needs one media item', { platform: this.id });
    if (post.media.length > 1) {
      this.logger.warn('Instagram Stories take one media item at a time - the rest were skipped', {
        skipped: post.media.length - 1,
        hint: 'To post several stories, call post() once per media item.',
      });
    }

    /** @type {Record<string, any>} */
    const params = { media_type: 'STORIES' };
    let containerId;

    if (media.kind === 'video') {
      if (options.probeMedia !== false && !media.durationSec) await media.probeWithFfprobe();
      if (media.size && media.size > LIMITS.storyBytes) {
        throw new UnsupportedError(
          `[instagram] a story video may be at most 100MB (this file: ${Math.round(media.size / 1e6)}MB)`,
          { platform: this.id },
        );
      }
      if (media.durationSec && media.durationSec > LIMITS.storyMaxSec) {
        throw new UnsupportedError(
          `[instagram] a story video may be at most 60s (this video: ${Math.round(media.durationSec)}s)`,
          { platform: this.id },
        );
      }
      if (this._shouldUseResumable(media, options)) {
        params.upload_type = 'resumable';
        const created = await this._createContainer(params, { withUri: true });
        containerId = created.id;
        await this._ruploadVideo(created.uri ?? `${RUPLOAD_HOST}/ig-api-upload/${this.version}/${containerId}`, media, options);
      } else {
        params.video_url = await this.ensurePublicUrl(media, { keyHint: post.title });
        containerId = await this._createContainer(params);
      }
    } else {
      await this._assertStoryImage(media);
      params.image_url = await this.ensurePublicUrl(media, { keyHint: post.title });
      containerId = await this._createContainer(params);
    }

    await this._waitContainerReady(containerId, options);
    // Story khong co caption -> bao cho nguoi dung biet neu ho co nhap.
    if (post.title || post.description || post.hashtags.length > 0) {
      this.logger.warn('Instagram Stories take no caption through the API - title, description and hashtags were dropped');
    }
    return this._publishContainer(containerId, { kind: 'story' });
  }

  // ---------------------------------------------------------------- carousel

  async _publishCarousel(post, options, caption) {
    const items = post.media.slice(0, LIMITS.carouselMax);
    if (post.media.length > LIMITS.carouselMax) {
      this.logger.warn('a carousel takes at most 10 media items - the rest were skipped', {
        skipped: post.media.length - LIMITS.carouselMax,
      });
    }
    if (items.length < LIMITS.carouselMin) {
      throw new ValidationError('A carousel needs between 2 and 10 media items', { platform: this.id });
    }

    /** @type {string[]} */
    const childIds = [];
    for (const [i, media] of items.entries()) {
      /** @type {Record<string, any>} */
      const params = { is_carousel_item: true };

      if (media.kind === 'video') {
        if (options.probeMedia !== false && !media.durationSec) await media.probeWithFfprobe();
        if (this._shouldUseResumable(media, options)) {
          // Video con trong carousel dung media_type=VIDEO (khong phai REELS).
          params.media_type = 'VIDEO';
          params.upload_type = 'resumable';
          const created = await this._createContainer(params, { withUri: true });
          childIds.push(created.id);
          await this._ruploadVideo(created.uri ?? `${RUPLOAD_HOST}/ig-api-upload/${this.version}/${created.id}`, media, options);
          this.logger.debug('da tao child video carousel', { index: i + 1, id: created.id });
          continue;
        }
        params.video_url = await this.ensurePublicUrl(media, { keyHint: post.title });
        params.user_tags = normalizeUserTags(media.userTags ?? options.userTags, 'video');
      } else {
        await this._assertFeedImage(media, { first: items[0] });
        params.image_url = await this.ensurePublicUrl(media, { keyHint: post.title });
        params.alt_text = truncateOrUndefined(media.altText, LIMITS.altText);
        params.user_tags = normalizeUserTags(media.userTags, 'image');
      }

      const id = await this._createContainer(params);
      childIds.push(id);
      this.logger.debug('da tao child carousel', { index: i + 1, total: items.length, id });
    }

    // Cho moi child (nhat la video) xong truoc khi tao parent.
    for (const id of childIds) await this._waitContainerReady(id, options, { quiet: true });

    const parentId = await this._createContainer({
      media_type: 'CAROUSEL',
      // Docs dung chuoi noi bang dau phay -> an toan nhat.
      children: childIds.join(','),
      caption: caption.text || undefined,
      location_id: options.locationId,
      collaborators: limitArray(options.collaborators, LIMITS.collaborators),
      is_ai_generated: options.isAiGenerated,
    });

    await this._waitContainerReady(parentId, options);
    return this._publishContainer(parentId, { kind: 'carousel', caption, children: childIds });
  }

  // ----------------------------------------------------------- container API

  /**
   * Tao container. Tra ve id (hoac {id, uri} khi resumable).
   * @param {Record<string, any>} params
   * @param {{withUri?: boolean}} [opts]
   * @returns {Promise<any>}
   */
  async _createContainer(params, opts = {}) {
    const token = await this.token();
    const body = clean(params);
    const data = await this._post(`/${this.config.igUserId}/media`, body, token);
    if (!data?.id) {
      throw new PlatformError('Instagram returned no container id', { platform: this.id, details: data });
    }
    this.logger.debug('da tao container', { id: data.id, mediaType: params.media_type ?? 'IMAGE' });
    return opts.withUri ? { id: String(data.id), uri: data.uri } : String(data.id);
  }

  /**
   * Upload byte video len rupload. Header Authorization dung scheme 'OAuth'.
   * Neu loi, doc bytes_transferred tu status de tiep tuc tu offset do.
   * @param {string} uploadUri
   * @param {import('../core/media.js').Media} media
   * @param {Record<string, any>} options
   */
  async _ruploadVideo(uploadUri, media, options) {
    const token = await this.token();
    const total = media.size ?? 0;
    if (!total) throw new UnsupportedError('Could not determine the video size', { platform: this.id });

    const containerId = uploadUri.split('/').pop();
    const maxAttempts = options.uploadRetries ?? this.config.uploadRetries ?? 3;
    let offset = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const buf = await media.readRange(offset, total - 1);
      const res = await this.http.request(uploadUri, {
        method: 'POST',
        headers: {
          authorization: `OAuth ${token}`,
          offset: String(offset),
          file_size: String(total),
          'content-type': 'application/octet-stream',
          'content-length': String(buf.byteLength),
        },
        body: buf,
        platform: this.id,
        signal: this.signal,
        timeoutMs: options.uploadTimeoutMs ?? this.config.uploadTimeoutMs ?? 30 * 60_000,
        throwOnError: false,
        retry: { retries: 0 },
      });

      if (res.ok && res.data?.success !== false) {
        this.logger.info('video uploaded to Instagram', { bytes: total, offset, attempt });
        return res.data;
      }

      const err = mapInstagramError(
        { status: res.status, data: res.data, text: res.text, res: res.res, url: 'rupload' },
        'rupload',
      );
      if (attempt === maxAttempts) {
        throw err ?? new PlatformError(`Uploading the video to Instagram failed (HTTP ${res.status})`, {
          platform: this.id,
          details: res.data,
        });
      }

      // Doc offset ma server da nhan de tiep tuc (khong upload lai tu dau).
      const transferred = await this._readUploadedBytes(containerId).catch(() => undefined);
      if (transferred != null && transferred > offset && transferred < total) {
        this.logger.warn('upload interrupted, resuming from the offset the server reported', { offset: transferred, total });
        offset = transferred;
      } else {
        this.logger.warn('upload failed, retrying from the start', { attempt, error: err?.message });
        offset = 0;
      }
    }
    throw new PlatformError('Uploading the video to Instagram failed', { platform: this.id });
  }

  /** So byte server da nhan (video_status.uploading_phase.bytes_transferred). */
  async _readUploadedBytes(containerId) {
    const token = await this.token();
    const data = await this._get(`/${containerId}`, {
      fields: 'id,status,status_code,video_status',
    }, token);
    const n = Number(data?.video_status?.uploading_phase?.bytes_transferred);
    return Number.isFinite(n) ? n : undefined;
  }

  /**
   * Cho container chuyen sang FINISHED. ERROR tra ve subcode trong field `status`.
   * @param {string} containerId
   * @param {Record<string, any>} options
   * @param {{quiet?: boolean}} [opts]
   */
  async _waitContainerReady(containerId, options, opts = {}) {
    const timeoutMs = options.processingTimeoutMs ?? this.config.processingTimeoutMs ?? 10 * 60_000;
    const result = await this.poll(
      async () => {
        const token = await this.token();
        const data = await this._get(`/${containerId}`, {
          fields: 'status_code,status,video_status,copyright_check_status',
        }, token);
        const code = String(data?.status_code ?? '').toUpperCase();

        if (code === 'FINISHED') return { done: true, value: data };
        if (code === 'ERROR') {
          return { done: false, failed: true, reason: `status=${data?.status ?? 'unknown'}` };
        }
        if (code === 'EXPIRED') {
          return { done: false, failed: true, reason: 'the container expired (over 24h)' };
        }
        if (code === 'PUBLISHED') return { done: true, value: data };

        const copyright = data?.copyright_check_status;
        if (copyright?.matches_found === true) {
          this.logger.warn('Instagram flagged possible copyrighted content', { copyright });
        }
        return { done: false, value: data };
      },
      { timeoutMs, intervalMs: 5000, maxIntervalMs: 30_000, backoffFactor: 1.4 },
    );

    if (result.failed) {
      // Mot so subcode la loi TAM THOI (loi server IG, tai media that bai) -> danh dau
      // retryable de scheduler lui lich thu lai thay vi bo han bai dang.
      const subcode = Number(/(\d{7})/.exec(String(result.reason ?? ''))?.[1]);
      throw new ProcessingError(`Instagram failed to process the media: ${result.reason}`, {
        platform: this.id,
        details: { containerId, reason: result.reason, subcode },
        retryable: RETRYABLE_SUBCODES.has(subcode),
        hint: describeIgSubcode(result.reason),
      });
    }
    if (result.timedOut) {
      throw new ProcessingError(
        `Timed out waiting for Instagram to process the media (container ${containerId})`,
        {
          platform: this.id,
          details: { containerId, elapsedMs: result.elapsedMs },
          retryable: false,
          hint: 'The container stays valid for 24h. Check again and call media_publish later rather than creating a new container, to avoid double posting.',
        },
      );
    }
    if (!opts.quiet) this.logger.debug('container san sang', { containerId });
    return result.value;
  }

  /**
   * Buoc cuoi: publish container.
   * @param {string} containerId
   * @param {object} meta
   * @returns {Promise<import('./base.js').PublishResult>}
   */
  async _publishContainer(containerId, meta = {}) {
    const token = await this.token();
    const data = await this._post(
      `/${this.config.igUserId}/media_publish`,
      { creation_id: containerId },
      token,
      // Khong retry: publish thanh cong ma phan hoi bi mat se thanh BAI TRUNG.
      { retry: { retries: 0 } },
    );
    const mediaId = data?.id;
    if (!mediaId) {
      throw new PlatformError('Instagram returned no media id after publishing', {
        platform: this.id,
        details: data,
      });
    }

    // Lay permalink de tra ve link xem duoc.
    let permalink;
    try {
      const info = await this._get(`/${mediaId}`, { fields: 'permalink,media_product_type' }, token);
      permalink = info?.permalink;
      meta.mediaProductType = info?.media_product_type;
    } catch {
      // Khong bat buoc.
    }

    return {
      platform: this.id,
      ok: true,
      id: String(mediaId),
      url: permalink,
      status: 'published',
      raw: data,
      meta: { ...meta, containerId, captionLength: meta.caption?.length },
    };
  }

  // ----------------------------------------------------------------- kiem tra

  /** Caption: toi da 2200 ky tu, 30 hashtag, 20 @mention. */
  _buildIgCaption(post, options) {
    const caption = this.buildCaption(post, options);
    const mentions = (caption.text.match(/@[A-Za-z0-9._]+/g) ?? []).length;
    if (mentions > LIMITS.mentions) {
      this.logger.warn('the caption has too many @mentions', { mentions, max: LIMITS.mentions });
    }
    return caption;
  }

  /** Kiem tra anh feed: JPEG, <= 8MB, ty le 4:5 - 1.91:1, rong 320-1440. */
  async _assertFeedImage(media, ctx = {}) {
    // Kiem tra mime TRUOC assertMediaLimits de thong bao co huong dan cu the hon.
    if (media.mime !== 'image/jpeg') {
      throw new UnsupportedError(
        `[instagram] only JPEG images are accepted (got ${media.mime}). Convert PNG/WebP to JPEG first.`,
        { platform: this.id, details: { mime: media.mime } },
      );
    }
    this.assertMediaLimits(media);
    if (media.size && media.size > LIMITS.imageBytes) {
      throw new UnsupportedError(
        `[instagram] an image may be at most 8MB (this file: ${Math.round(media.size / 1e6)}MB)`,
        { platform: this.id, details: { size: media.size } },
      );
    }
    // Ty le khung hinh chi kiem tra duoc khi biet width/height.
    if (!media.width || !media.height) {
      this.logger.warn('image dimensions unknown - skipping the Instagram 4:5-1.91:1 aspect ratio check', {
        filename: media.filename,
        hint: 'Instagram rejects out-of-range images (subcode 2207009). Install ffprobe, or pass width/height.',
      });
    }
    if (media.width && media.height) {
      const ratio = media.width / media.height;
      if (ratio < LIMITS.feedAspectMin - 1e-3 || ratio > LIMITS.feedAspectMax + 1e-3) {
        throw new UnsupportedError(
          `[instagram] anh feed phai co ty le tu 4:5 (0.8) den 1.91:1 - anh nay ${media.width}x${media.height} (${ratio.toFixed(3)}).`,
          {
            platform: this.id,
            details: { width: media.width, height: media.height, ratio },
            hint: 'A 9:16 vertical image can only go to Reels/Stories. For the feed, crop to 1080x1350 (4:5) or 1080x1080.',
          },
        );
      }
      if (media.width < LIMITS.imageMinWidth) {
        throw new UnsupportedError(
          `[instagram] an image must be at least ${LIMITS.imageMinWidth}px wide (this one is ${media.width}px)`,
          { platform: this.id },
        );
      }
    }
    if (ctx.first && ctx.first !== media && ctx.first.width && media.width) {
      const r1 = ctx.first.width / ctx.first.height;
      const r2 = media.width / media.height;
      if (Math.abs(r1 - r2) > 0.02) {
        this.logger.warn('the carousel media have different aspect ratios - Instagram crops them all to match the first', {
          firstRatio: Number(r1.toFixed(3)),
          thisRatio: Number(r2.toFixed(3)),
        });
      }
    }
    return true;
  }

  async _assertStoryImage(media) {
    if (media.mime !== 'image/jpeg') {
      throw new UnsupportedError(
        `[instagram] Stories chi nhan anh JPEG (nhan ${media.mime})`,
        { platform: this.id },
      );
    }
    if (media.size && media.size > LIMITS.imageBytes) {
      throw new UnsupportedError(`[instagram] anh story toi da 8MB`, { platform: this.id });
    }
    return true;
  }

  _warnReelSpec(media) {
    const issues = [];
    if (media.size && media.size > LIMITS.reelBytes) {
      issues.push(`size ${Math.round(media.size / 1e6)}MB (300MB maximum)`);
    }
    if (media.durationSec != null) {
      if (media.durationSec < LIMITS.reelMinSec) issues.push(`${Math.round(media.durationSec)}s (toi thieu 3s)`);
      if (media.durationSec > LIMITS.reelMaxSec) issues.push(`${Math.round(media.durationSec)}s (toi da 15 phut)`);
    }
    if (media.width && media.width > 1920) issues.push(`width ${media.width}px (1920 maximum)`);
    if (issues.length > 0) {
      this.logger.warn('video co the bi Instagram tu choi', {
        issues,
        hint: 'Reels can MP4/MOV H264 hoac HEVC + AAC 48kHz, faststart (ffmpeg -movflags +faststart).',
      });
    }
  }

  /** Video local -> uu tien resumable upload de khong can mediaHost. */
  _shouldUseResumable(media, options) {
    if (options.resumable !== undefined) return Boolean(options.resumable);
    if (this.config.resumable !== undefined) return Boolean(this.config.resumable);
    return media.isLocal;
  }

  // -------------------------------------------------------------------- HTTP

  async _get(path, query, token) {
    const res = await this.http.request(`${this.api}${path}`, {
      method: 'GET',
      query: { ...query, access_token: token ?? await this.token() },
      platform: this.id,
      signal: this.signal,
      mapError: (ctx) => mapInstagramError(ctx, `GET ${path}`),
    });
    return this._unwrap(res, `GET ${path}`);
  }

  async _post(path, body, token, opts = {}) {
    const res = await this.http.request(`${this.api}${path}`, {
      method: 'POST',
      form: { ...body, access_token: token ?? await this.token() },
      platform: this.id,
      signal: this.signal,
      throwOnError: false,
      // media_publish KHONG idempotent: retry sau timeout co the tao BAI TRUNG.
      retry: opts.retry,
      mapError: (ctx) => mapInstagramError(ctx, `POST ${path}`),
    });
    return this._unwrap(res, `POST ${path}`);
  }

  _unwrap(res, op) {
    const data = res.data;
    if (data && typeof data === 'object' && data.error) {
      throw mapInstagramError({ status: res.status, data, text: res.text, res: res.res, url: op }, op)
        ?? new PlatformError(`[instagram] ${op} that bai`, { platform: this.id, details: data });
    }
    if (!res.ok) {
      throw mapInstagramError({ status: res.status, data, text: res.text, res: res.res, url: op }, op)
        ?? new PlatformError(`[instagram] ${op} HTTP ${res.status}`, {
          platform: this.id,
          httpStatus: res.status,
          details: res.data,
        });
    }
    return data;
  }

  /** Gia han token dai han cua Instagram Login (60 ngay). */
  async _refreshLongLivedToken() {
    const current = (await this.store.get(`instagram:${this.config.igUserId}`))?.accessToken
      ?? this.config.accessToken;
    const res = await this.http.request(`${IG_HOST}/refresh_access_token`, {
      method: 'GET',
      query: { grant_type: 'ig_refresh_token', access_token: current },
      platform: this.id,
      signal: this.signal,
      throwOnError: false,
      retry: { retries: 2 },
    });
    if (!res.ok || !res.data?.access_token) {
      throw new AuthError('Could not renew the Instagram access token', {
        platform: this.id,
        httpStatus: res.status,
        details: res.data,
        retryable: false,
        hint: 'An Instagram Login long-lived token lives 60 days and must be refreshed (the token must be at least 24h old). '
          + 'Once expired, the user has to sign in and authorize again.',
      });
    }
    return {
      accessToken: res.data.access_token,
      expiresInSec: Number(res.data.expires_in) || 60 * 24 * 3600,
    };
  }
}

// ------------------------------------------------------------------ helpers

/** Bo field undefined/null de khong gui rac len API. */
function clean(obj) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

function limitArray(arr, max) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  return arr.slice(0, max);
}

function truncateOrUndefined(str, max) {
  if (!str) return undefined;
  const s = String(str);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * user_tags: anh CAN x/y (0.0-1.0), video/reel PHAI BO x/y.
 * @param {any} tags
 * @param {'image'|'video'} kind
 */
export function normalizeUserTags(tags, kind) {
  if (!Array.isArray(tags) || tags.length === 0) return undefined;
  const out = tags.slice(0, LIMITS.userTags).map((t) => {
    const username = String(t?.username ?? t).replace(/^@/, '');
    if (kind === 'video') return { username };
    return {
      username,
      x: clamp01(t?.x ?? 0.5),
      y: clamp01(t?.y ?? 0.5),
    };
  });
  return out;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** thumb_offset phai thoa 0 <= offset < duration(ms). */
export function validateThumbOffset(offset, media) {
  if (offset === undefined || offset === null) return undefined;
  const n = Number(offset);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError('thumbOffset phai >= 0 (don vi milliseconds)', { platform: 'instagram' });
  }
  if (media?.durationSec && n >= media.durationSec * 1000) {
    throw new ValidationError(
      `thumbOffset (${n}ms) phai nho hon do dai video (${Math.round(media.durationSec * 1000)}ms)`,
      { platform: 'instagram' },
    );
  }
  return Math.floor(n);
}

/** Giai thich subcode thuong gap de nguoi dung biet phai sua gi. */
export function describeIgSubcode(reason) {
  const m = /(\d{7})/.exec(String(reason ?? ''));
  if (!m) return undefined;
  return IG_SUBCODE_HINTS[m[1]];
}

const IG_SUBCODE_HINTS = {
  2207003: 'Meta took too long to fetch the media from the URL. Use a faster CDN or a smaller file.',
  2207004: 'Anh vuot 8MB.',
  2207005: 'Unsupported image format - it must be baseline JPEG.',
  2207009: 'Ty le anh ngoai khoang 4:5 - 1.91:1.',
  2207010: 'Caption vuot 2200 ky tu.',
  2207020: 'The container has expired (over 24h) - create a new one.',
  2207023: 'Invalid media_type.',
  2207026: 'Unsupported video format - transcode to MP4/MOV with H264+AAC and faststart.',
  2207027: 'The media is still processing - wait for status_code=FINISHED before publishing.',
  2207028: 'Carousel can 2-10 media.',
  2207040: 'Qua nhieu user_tags (toi da 20).',
  2207042: 'The 24h posting quota is used up.',
  2207050: 'This Instagram account is restricted - check inside the app.',
  2207051: 'Bi coi la spam - giam tan suat dang.',
  2207052: 'Meta could not fetch the media from the URL: it must be public, HTTPS, need no sign-in, and not redirect repeatedly.',
  2207053: 'Unknown upload error - create a new container and upload again.',
  2207057: 'thumb_offset phai >= 0 va nho hon do dai video.',
};

/**
 * Chuyen loi Instagram/Graph thanh loi cua module.
 * Luon xet (code, error_subcode) cung nhau; ton trong `is_transient`.
 * @param {{status: number, data: any, text: string, res: Response, url: string}} ctx
 * @param {string} [op]
 * @returns {Error | undefined}
 */
export function mapInstagramError(ctx, op = '') {
  const { status, data, text } = ctx;
  const err = data?.error;
  if (!err && status < 400) return undefined;

  const code = Number(err?.code ?? 0);
  const subcode = Number(err?.error_subcode ?? 0);
  const message = err?.error_user_msg ?? err?.message ?? String(text ?? '').slice(0, 300);
  const transient = err?.is_transient === true;
  const hint = IG_SUBCODE_HINTS[String(subcode)];
  const base = {
    platform: 'instagram',
    httpStatus: status,
    platformCode: code,
    platformSubcode: subcode,
    details: { op, code, subcode, fbtrace_id: err?.fbtrace_id, is_transient: transient },
    hint,
  };

  if (code === 190) {
    return new AuthError(`[instagram] invalid token (190/${subcode}): ${message}`, {
      ...base,
      retryable: false,
      hint: 'Token het han/bi thu hoi. Facebook Login: tao lai Page token. Instagram Login: refresh token (60 ngay).',
    });
  }
  if (code === 9 && subcode === 2207042) {
    return new RateLimitError(`[instagram] het quota dang bai 24h: ${message}`, {
      ...base,
      retryable: false,
      retryAfterMs: 60 * 60_000,
    });
  }
  if (code === 4 && subcode === 2207051) {
    return new PlatformError(`[instagram] bi han che vi nghi la spam: ${message}`, {
      ...base,
      retryable: false,
      hint: 'Post less often. Do not retry in a tight loop.',
    });
  }
  if (code === 4 || code === 17 || code === 32 || code === 80002 || status === 429) {
    return new RateLimitError(`[instagram] rate limit exceeded (${code}): ${message}`, {
      ...base,
      retryable: true,
    });
  }
  if (code === 25 && subcode === 2207050) {
    return new AuthError(`[instagram] tai khoan bi han che: ${message}`, { ...base, retryable: false });
  }
  if (code === 200 || code === 10 || status === 403) {
    return new AuthError(`[instagram] missing permission (${code}): ${message}`, {
      ...base,
      retryable: false,
      hint: 'Can instagram_content_publish (Facebook Login) hoac instagram_business_content_publish (Instagram Login), '
        + 'and the account must be Business/Creator.',
    });
  }
  if (RETRYABLE_SUBCODES.has(subcode) || transient) {
    return new PlatformError(`[instagram] loi tam thoi (${code}/${subcode}): ${message}`, {
      ...base,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new PlatformError(`[instagram] ${status}: ${message}`, { ...base, retryable: true });
  }
  if (status >= 400 || err) {
    return new PlatformError(`[instagram] loi ${code || status}${subcode ? `/${subcode}` : ''}: ${message}`, {
      ...base,
      retryable: false,
    });
  }
  return undefined;
}
