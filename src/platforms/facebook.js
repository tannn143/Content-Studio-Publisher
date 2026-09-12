/**
 * Facebook Page adapter (Meta Graph API).
 *
 * Ho tro: text-only, 1 anh, nhieu anh (album qua attached_media), video, Reels.
 *
 * Diem quan trong (docs 2026, Graph API v26.0):
 *  - Host `graph-video.facebook.com` DA DEPRECATED -> dung `graph.facebook.com` cho moi request.
 *  - Reels: 3 pha, va `offset` / `file_size` / `file_url` la HTTP HEADER (khong phai body),
 *    Authorization dung scheme `OAuth` (khong phai `Bearer`).
 *  - /photos dung field `caption` (field `message` da deprecated).
 *  - Album nhieu anh: upload tung anh voi published=false&temporary=true -> lay media_fbid
 *    -> POST /feed voi attached_media[i]={"media_fbid":"..."}.
 *  - Video/Reels dang BAT DONG BO: HTTP 200 chi la "da nhan", phai poll GET /{video-id}?fields=status.
 *  - Page token phai duoc tao tu USER token DAI HAN moi khong het han.
 *
 * Docs: https://developers.facebook.com/docs/pages-api/posts
 *       https://developers.facebook.com/docs/video-api/guides/reels-publishing
 */

import crypto from 'node:crypto';
import { BasePlatform } from './base.js';
import {
  AuthError,
  PlatformError,
  ProcessingError,
  RateLimitError,
  UnsupportedError,
  ValidationError,
} from '../core/errors.js';
import { toMedia } from '../core/media.js';

const GRAPH_HOST = 'https://graph.facebook.com';
const RUPLOAD_HOST = 'https://rupload.facebook.com';
const DEFAULT_VERSION = 'v26.0';

const LIMITS = {
  photoBytes: 4 * 1024 * 1024,
  pngBytes: 1 * 1024 * 1024,
  photoMime: ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff'],
  simpleVideoBytes: 1024 * 1024 * 1024,     // 1GB cho multipart/file_url
  simpleVideoSec: 20 * 60,                  // 20 phut
  resumableVideoBytes: 1.75 * 1024 * 1024 * 1024,
  resumableVideoSec: 45 * 60,
  reelMinSec: 3,
  reelMaxSec: 90,
  scheduleMinMs: 10 * 60_000,               // >= 10 phut
  scheduleMaxMs: 29 * 24 * 3600_000,        // <= 29 ngay
  captionSoftLimit: 60_000,
};

/** Ma loi Graph nen retry. */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613, 6000, 6001, 80001]);

export class FacebookPlatform extends BasePlatform {
  static id = 'facebook';

  static displayName = 'Facebook Page';

  /** @type {import('./base.js').PlatformCapabilities} */
  static capabilities = {
    text: true,
    image: true,
    video: true,
    album: true,
    requiresPublicUrl: false,
    maxMediaCount: 30,
    supportsSchedule: true,
    limits: { title: 255, caption: LIMITS.captionSoftLimit, hashtags: Infinity },
    imageMime: LIMITS.photoMime,
    maxVideoBytes: LIMITS.resumableVideoBytes,
  };

  validateConfig() {
    this.requireConfig(['pageId', 'pageAccessToken'], {
      hint: 'pageAccessToken phai la PAGE token sinh tu USER token DAI HAN (60 ngay) qua GET /me/accounts, '
        + 'neu khong token se het han sau 1-2 gio. Cach de nhat: chay `npm run serve` roi ket noi o tab "Kenh" (module tu doi token dai han).',
    });
    return true;
  }

  get version() {
    return this.config.graphVersion ?? DEFAULT_VERSION;
  }

  get graph() {
    return `${GRAPH_HOST}/${this.version}`;
  }

  get token() {
    return this.config.pageAccessToken;
  }

  async verifyCredentials() {
    try {
      const data = await this._get(`/${this.config.pageId}`, { fields: 'id,name,username,tasks,fan_count' });
      const tasks = data?.tasks;
      if (Array.isArray(tasks) && !tasks.includes('CREATE_CONTENT')) {
        return {
          ok: false,
          error: new AuthError(
            'Nguoi dung cua token nay khong co quyen CREATE_CONTENT tren Page',
            { platform: this.id, details: { tasks }, hint: 'Cap role co quyen dang bai cho user tren Page.' },
          ),
        };
      }
      return { ok: true, account: { id: data?.id, name: data?.name, username: data?.username, tasks } };
    } catch (err) {
      return { ok: false, error: /** @type {Error} */ (err) };
    }
  }

  /**
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   * @returns {Promise<import('./base.js').PublishResult>}
   */
  async doPublish(post, options) {
    const scheduledTs = this._resolveSchedule(post, options);

    if (post.videos.length > 0) {
      const media = post.videos[0];
      if (post.videos.length > 1) {
        this.logger.warn('Facebook chi dang duoc 1 video moi bai - cac video sau bi bo qua', {
          skipped: post.videos.length - 1,
        });
      }
      // Tu nhan biet Reel can biet ty le khung hinh + thoi luong -> phai probe TRUOC khi quyet dinh.
      const needsProbe = options.asReel === undefined && this.config.asReel === undefined
        && options.probeMedia !== false
        && (!media.durationSec || !media.width);
      if (needsProbe) await media.probeWithFfprobe();

      const asReel = this._shouldPostAsReel(media, options);
      return asReel
        ? this._publishReel(post, media, options, scheduledTs)
        : this._publishVideo(post, media, options, scheduledTs);
    }

    if (post.images.length > 1) return this._publishAlbum(post, options, scheduledTs);
    if (post.images.length === 1) return this._publishPhoto(post, post.images[0], options, scheduledTs);
    return this._publishText(post, options, scheduledTs);
  }

  // ------------------------------------------------------------------- text

  async _publishText(post, options, scheduledTs) {
    const caption = this.buildCaption(post, options);
    if (!caption.text && !post.link) {
      throw new ValidationError('Bai text-only can `message` hoac `link`', { platform: this.id });
    }

    /** @type {Record<string, any>} */
    const body = { message: caption.text || undefined, link: post.link };
    this._applyPublishState(body, options, scheduledTs);

    const data = await this._post(`/${this.config.pageId}/feed`, body);
    return this._feedResult(data, options, scheduledTs, { kind: 'text', caption });
  }

  // ------------------------------------------------------------------ photo

  async _publishPhoto(post, media, options, scheduledTs) {
    this._assertPhoto(media);
    const caption = this.buildCaption(post, options);

    /** @type {Record<string, any>} */
    const body = {
      caption: caption.text || undefined, // `message` da deprecated tren /photos
      alt_text_custom: media.altText ?? options.altText,
      no_story: options.noStory,
    };
    this._applyPublishState(body, options, scheduledTs);
    // `temporary` khong duoc di kem scheduled_publish_time.
    if (!scheduledTs && options.temporary) body.temporary = true;

    let data;
    if (media.publicUrl && !options.forceUpload) {
      data = await this._post(`/${this.config.pageId}/photos`, { ...body, url: media.publicUrl });
    } else {
      const form = await this._photoForm(media, body);
      data = await this._postMultipart(`/${this.config.pageId}/photos`, form);
    }

    const postId = data?.post_id;
    return {
      platform: this.id,
      ok: true,
      id: postId ?? data?.id,
      url: postId ? this._permalink(postId) : undefined,
      status: scheduledTs ? 'scheduled' : (options.published === false ? 'draft' : 'published'),
      raw: data,
      meta: { kind: 'photo', photoId: data?.id, postId, captionLength: caption.length },
    };
  }

  /**
   * Album: upload tung anh khong publish -> gom media_fbid -> dang 1 bai /feed.
   */
  async _publishAlbum(post, options, scheduledTs) {
    const images = post.images;
    for (const m of images) this._assertPhoto(m);

    this.logger.info('upload anh cho album', { count: images.length });
    /** @type {string[]} */
    const fbids = [];
    for (const [i, media] of images.entries()) {
      /** @type {Record<string, any>} */
      const staging = { published: false, temporary: true };
      let data;
      if (media.publicUrl && !options.forceUpload) {
        data = await this._post(`/${this.config.pageId}/photos`, { ...staging, url: media.publicUrl });
      } else {
        const form = await this._photoForm(media, staging);
        data = await this._postMultipart(`/${this.config.pageId}/photos`, form);
      }
      if (!data?.id) {
        throw new PlatformError(`Khong lay duoc media_fbid cho anh #${i + 1}`, { platform: this.id, details: data });
      }
      fbids.push(String(data.id));
      this.logger.debug('da upload anh album', { index: i + 1, total: images.length, mediaFbid: data.id });
    }

    const caption = this.buildCaption(post, options);
    /** @type {Record<string, any>} */
    const body = {
      message: caption.text || undefined,
      link: post.link,
      attached_media: fbids.map((id) => ({ media_fbid: id })),
    };
    this._applyPublishState(body, options, scheduledTs);
    if (scheduledTs) {
      // Bai album hen gio BAT BUOC co unpublished_content_type.
      body.unpublished_content_type = options.unpublishedContentType ?? 'SCHEDULED';
    }

    const data = await this._post(`/${this.config.pageId}/feed`, body);
    return {
      ...this._feedResult(data, options, scheduledTs, { kind: 'album', caption }),
      meta: { kind: 'album', mediaFbids: fbids, count: fbids.length, captionLength: caption.length },
    };
  }

  /**
   * @param {import('../core/media.js').Media} media
   * @param {Record<string, any>} fields
   */
  async _photoForm(media, fields) {
    const form = new FormData();
    appendFields(form, fields);
    const maxBytes = media.mime === 'image/png' ? LIMITS.pngBytes : LIMITS.photoBytes;
    form.append('source', await media.toBlob({ maxBytes }), media.filename ?? `photo${media.extension}`);
    return form;
  }

  _assertPhoto(media) {
    this.assertMediaLimits(media);
    if (media.mime === 'image/png' && media.size && media.size > LIMITS.pngBytes) {
      throw new UnsupportedError(
        `[facebook] anh PNG chi duoc toi da 1MB (file: ${Math.round(media.size / 1024)}KB). `
        + 'Chuyen sang JPEG truoc khi dang.',
        { platform: this.id, details: { size: media.size, mime: media.mime } },
      );
    }
    if (media.size && media.size > LIMITS.photoBytes) {
      throw new UnsupportedError(
        `[facebook] anh toi da 4MB (file: ${Math.round(media.size / 1e6)}MB)`,
        { platform: this.id, details: { size: media.size } },
      );
    }
  }

  // ------------------------------------------------------------------ video

  /**
   * Video thuong (khong phai Reel).
   */
  async _publishVideo(post, media, options, scheduledTs) {
    this.assertMediaLimits(media);
    if (options.probeMedia !== false && !media.durationSec) await media.probeWithFfprobe();

    const title = String(options.title ?? post.title ?? '').trim() || undefined;
    const caption = this.buildCaption(post, options, { includeTitle: false });
    const description = caption.text || undefined;

    /** @type {Record<string, any>} */
    const fields = {
      title,
      description,
      no_story: options.noStory,
      content_category: options.contentCategory,
    };
    this._applyPublishState(fields, options, scheduledTs);

    const useResumable = this._shouldUseResumable(media, options);
    let data;

    if (useResumable) {
      this._assertResumableVideoLimits(media);
      const handle = await this._resumableUpload(media);
      const form = new FormData();
      appendFields(form, { ...fields, fbuploader_video_file_chunk: handle });
      data = await this._postMultipart(`/${this.config.pageId}/videos`, form);
    } else if (media.publicUrl && !options.forceUpload) {
      data = await this._post(`/${this.config.pageId}/videos`, { ...fields, file_url: media.publicUrl });
    } else {
      this._assertSimpleVideoLimits(media);
      const form = new FormData();
      appendFields(form, fields);
      form.append('source', await media.toBlob({ maxBytes: LIMITS.simpleVideoBytes }), media.filename ?? `video${media.extension}`);
      if (options.thumbnail ?? media.thumbnailPath) {
        const thumb = toMedia(options.thumbnail ?? media.thumbnailPath);
        await thumb.load();
        form.append('thumb', await thumb.toBlob(), thumb.filename ?? 'thumb.jpg');
      }
      data = await this._postMultipart(`/${this.config.pageId}/videos`, form);
    }

    const videoId = data?.id ?? data?.video_id;
    if (!videoId) {
      throw new PlatformError('Facebook khong tra ve video id', { platform: this.id, details: data });
    }

    const status = (options.waitForProcessing ?? this.config.waitForProcessing ?? true)
      ? await this._waitForVideoReady(videoId, options)
      : undefined;

    // /videos chi tra ve VIDEO id, muon post id phai hoi rieng.
    const postId = await this._resolveVideoPostId(videoId);
    return {
      platform: this.id,
      ok: true,
      id: postId ?? videoId,
      url: postId ? this._permalink(postId) : `https://www.facebook.com/watch/?v=${videoId}`,
      status: scheduledTs ? 'scheduled' : (status?.timedOut ? 'processing' : 'published'),
      raw: data,
      meta: { kind: 'video', videoId, postId, status, resumable: useResumable },
    };
  }

  /**
   * Reels: 3 pha (start -> upload binary len rupload -> finish).
   */
  async _publishReel(post, media, options, scheduledTs) {
    this.assertMediaLimits(media);
    if (options.probeMedia !== false && !media.durationSec) await media.probeWithFfprobe();
    this._warnReelSpec(media);

    // Pha 1: xin video_id + upload_url
    const start = await this._post(`/${this.config.pageId}/video_reels`, { upload_phase: 'start' }, { json: true });
    const videoId = start?.video_id;
    const uploadUrl = start?.upload_url ?? `${RUPLOAD_HOST}/video-upload/${this.version}/${videoId}`;
    if (!videoId) {
      throw new PlatformError('Reels: khong nhan duoc video_id o pha start', { platform: this.id, details: start });
    }

    // Pha 2: day binary (hoac de Meta tu keo tu file_url). offset/file_size/file_url la HEADER.
    await this._uploadReelBinary(uploadUrl, media, options);

    // Cho pha upload hoan tat truoc khi finish.
    await this._waitForUploadPhase(videoId, options);

    // Pha 3: finish + publish
    const caption = this.buildCaption(post, options, { includeTitle: false });
    const title = String(options.title ?? post.title ?? '').trim();
    /** @type {Record<string, any>} */
    const finish = {
      video_id: videoId,
      upload_phase: 'finish',
      video_state: scheduledTs ? 'SCHEDULED' : (options.videoState ?? (options.published === false ? 'DRAFT' : 'PUBLISHED')),
      description: caption.text || undefined,
      title: title || undefined,
      place: options.place,
    };
    if (scheduledTs) finish.scheduled_publish_time = scheduledTs;
    if (options.isAiGenerated !== undefined) finish.is_ai_generated = Boolean(options.isAiGenerated);

    const done = await this._post(`/${this.config.pageId}/video_reels`, finish);
    if (done?.success === false) {
      throw new PlatformError(`Reels finish that bai: ${done?.message ?? 'unknown'}`, {
        platform: this.id,
        details: done,
      });
    }

    const status = (options.waitForProcessing ?? this.config.waitForProcessing ?? true)
      ? await this._waitForVideoReady(videoId, options)
      : undefined;
    const postId = done?.post_id ?? await this._resolveVideoPostId(videoId);

    return {
      platform: this.id,
      ok: true,
      id: postId ?? videoId,
      url: postId ? this._permalink(postId) : `https://www.facebook.com/reel/${videoId}`,
      status: scheduledTs ? 'scheduled' : (status?.timedOut ? 'processing' : 'published'),
      raw: { start, finish: done },
      meta: { kind: 'reel', videoId, postId, status, captionLength: caption.length },
    };
  }

  /**
   * Pha 2 cua Reels. Luu y: Authorization dung 'OAuth', khong phai 'Bearer'.
   * @param {string} uploadUrl
   * @param {import('../core/media.js').Media} media
   * @param {Record<string, any>} options
   */
  async _uploadReelBinary(uploadUrl, media, options) {
    // File da nam tren internet -> de Meta tu keo (header file_url, body rong).
    if (media.publicUrl && !options.forceUpload) {
      const res = await this.http.request(uploadUrl, {
        method: 'POST',
        headers: {
          authorization: `OAuth ${this.token}`,
          file_url: media.publicUrl,
        },
        platform: this.id,
        signal: this.signal,
        timeoutMs: options.uploadTimeoutMs ?? 10 * 60_000,
        mapError: (ctx) => mapFacebookError(ctx, 'rupload:file_url'),
      });
      this.logger.debug('Reels: Meta se tu tai video tu URL', { url: media.publicUrl });
      return res.data;
    }

    const total = media.size ?? 0;
    if (!total) throw new UnsupportedError('Khong xac dinh duoc dung luong video', { platform: this.id });

    const buf = await media.toBuffer({ maxBytes: LIMITS.resumableVideoBytes });
    const res = await this.http.request(uploadUrl, {
      method: 'POST',
      headers: {
        authorization: `OAuth ${this.token}`,
        offset: '0',
        // file_size phai khop dung so byte GUI DI (media.size co the da cu).
        file_size: String(buf.byteLength),
        'content-type': 'application/octet-stream',
        'content-length': String(buf.byteLength),
      },
      body: buf,
      platform: this.id,
      signal: this.signal,
      timeoutMs: options.uploadTimeoutMs ?? 30 * 60_000,
      retry: { retries: 1 },
      mapError: (ctx) => mapFacebookError(ctx, 'rupload:binary'),
    });
    this.logger.debug('Reels: da day binary len rupload', { bytes: total });
    return res.data;
  }

  /**
   * Resumable Upload API (cho video > 1GB): /{app-id}/uploads -> handle `h`.
   * Can appId + userAccessToken.
   * @param {import('../core/media.js').Media} media
   * @returns {Promise<string>}
   */
  async _resumableUpload(media) {
    const appId = this.config.appId;
    const userToken = this.config.userAccessToken ?? this.config.appAccessToken;
    if (!appId || !userToken) {
      throw new UnsupportedError(
        `[facebook] video ${Math.round((media.size ?? 0) / 1e6)}MB vuot 1GB nen phai dung Resumable Upload API, `
        + 'can cau hinh them `appId` va `userAccessToken`.',
        { platform: this.id, hint: 'Hoac nen giam dung luong video xuong duoi 1GB.' },
      );
    }

    if (!media.size) {
      throw new UnsupportedError(
        'Resumable Upload API can biet dung luong file (file_length) nhung media nay khong xac dinh duoc.',
        { platform: this.id, hint: 'Dung file local, hoac URL co tra ve Content-Length.' },
      );
    }

    const session = await this.http.request(`${this.graph}/${appId}/uploads`, {
      method: 'POST',
      query: {
        file_name: media.filename ?? `video${media.extension}`,
        file_length: String(media.size),
        file_type: media.mime ?? 'video/mp4',
        // App bat "Require App Secret" thi moi request deu can appsecret_proof.
        ...(this.config.appSecret
          ? {
            appsecret_proof: crypto.createHmac('sha256', this.config.appSecret)
              .update(String(userToken)).digest('hex'),
          }
          : {}),
        access_token: userToken,
      },
      platform: this.id,
      signal: this.signal,
      mapError: (ctx) => mapFacebookError(ctx, 'uploads:start'),
    }).then((r) => r.data);

    const sessionId = session?.id; // dang 'upload:<SESSION_ID>'
    if (!sessionId) {
      throw new PlatformError('Resumable Upload: khong nhan duoc upload session id', {
        platform: this.id,
        details: session,
      });
    }

    let offset = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const buf = await media.readRange(offset, (media.size ?? 0) - 1);
      const res = await this.http.request(`${this.graph}/${sessionId}`, {
        method: 'POST',
        headers: {
          authorization: `OAuth ${userToken}`,
          file_offset: String(offset),
          'content-type': 'application/octet-stream',
          'content-length': String(buf.byteLength),
        },
        body: buf,
        platform: this.id,
        signal: this.signal,
        timeoutMs: 60 * 60_000,
        throwOnError: false,
        retry: { retries: 0 },
      });

      if (res.ok && res.data?.h) {
        this.logger.info('Resumable Upload xong', { bytes: media.size });
        return res.data.h;
      }
      // Hoi server xem da nhan den byte nao roi tiep tuc.
      const probe = await this.http.request(`${this.graph}/${sessionId}`, {
        method: 'GET',
        headers: { authorization: `OAuth ${userToken}` },
        platform: this.id,
        signal: this.signal,
        throwOnError: false,
      });
      const next = Number(probe.data?.file_offset);
      if (!Number.isFinite(next) || next <= offset) {
        throw mapFacebookError(
          { status: res.status, data: res.data, text: res.text, res: res.res, url: 'uploads:transfer' },
          'uploads:transfer',
        ) ?? new PlatformError('Resumable Upload that bai', { platform: this.id, details: res.data });
      }
      offset = next;
      this.logger.warn('Resumable Upload tiep tuc tu offset', { offset });
    }
    throw new PlatformError('Resumable Upload: vuot so lan thu lai', { platform: this.id });
  }

  _shouldUseResumable(media, options) {
    if (options.resumable !== undefined) return Boolean(options.resumable);
    if (this.config.resumable !== undefined) return Boolean(this.config.resumable);
    return Boolean(media.size && media.size > LIMITS.simpleVideoBytes);
  }

  /** Gioi han cua duong resumable: 1.75GB / 45 phut. */
  _assertResumableVideoLimits(media) {
    if (media.durationSec && media.durationSec > LIMITS.resumableVideoSec) {
      throw new UnsupportedError(
        `[facebook] video ${Math.round(media.durationSec / 60)} phut vuot gioi han 45 phut cua Facebook`,
        { platform: this.id, details: { durationSec: media.durationSec } },
      );
    }
    return true;
  }

  _assertSimpleVideoLimits(media) {
    if (media.size && media.size > LIMITS.simpleVideoBytes) {
      throw new UnsupportedError(
        `[facebook] upload 1 lan chi toi da 1GB (file: ${Math.round(media.size / 1e6)}MB). `
        + 'Bat `resumable: true` va cau hinh appId + userAccessToken.',
        { platform: this.id },
      );
    }
    if (media.durationSec && media.durationSec > LIMITS.simpleVideoSec) {
      throw new UnsupportedError(
        `[facebook] upload 1 lan chi toi da 20 phut (video: ${Math.round(media.durationSec / 60)} phut)`,
        { platform: this.id },
      );
    }
  }

  /** Co nen dang duoi dang Reel? */
  _shouldPostAsReel(media, options) {
    const explicit = options.asReel ?? this.config.asReel;
    if (explicit !== undefined) return Boolean(explicit);
    // Tu dong: video doc va dai 3-90s -> Reel.
    const vertical = media.width && media.height ? media.height > media.width : false;
    const inRange = media.durationSec != null
      && media.durationSec >= LIMITS.reelMinSec
      && media.durationSec <= LIMITS.reelMaxSec;
    return Boolean(vertical && inRange);
  }

  _warnReelSpec(media) {
    const issues = [];
    if (media.durationSec != null && (media.durationSec < LIMITS.reelMinSec || media.durationSec > LIMITS.reelMaxSec)) {
      issues.push(`thoi luong ${Math.round(media.durationSec)}s (Reels yeu cau 3-90s)`);
    }
    if (media.width && media.height && media.height <= media.width) {
      issues.push(`ty le ${media.width}x${media.height} (Reels yeu cau 9:16 doc)`);
    }
    if (media.width && media.width < 540) issues.push(`do rong ${media.width}px (toi thieu 540x960)`);
    if (issues.length > 0) {
      this.logger.warn('video khong dat chuan Reels, Facebook co the tu choi', { issues });
    }
  }

  // ---------------------------------------------------------- trang thai video

  /**
   * Cho pha UPLOAD xong (truoc khi goi finish cua Reels).
   * @param {string} videoId
   * @param {Record<string, any>} options
   */
  async _waitForUploadPhase(videoId, options) {
    const result = await this.poll(
      async () => {
        const data = await this._get(`/${videoId}`, { fields: 'status' });
        const st = data?.status ?? {};
        const up = normalizePhase(st.uploading_phase?.status);
        if (up === 'complete') return { done: true, value: st };
        if (up === 'error' || normalizeVideoStatus(st.video_status) === 'upload_failed') {
          return { done: false, failed: true, reason: `uploading_phase=${st.uploading_phase?.status}` };
        }
        return { done: false, value: st };
      },
      { timeoutMs: options.uploadStatusTimeoutMs ?? 10 * 60_000, intervalMs: 2000, maxIntervalMs: 10_000 },
    );
    if (result.failed) {
      throw new ProcessingError(`Facebook nhan video that bai: ${result.reason}`, {
        platform: this.id,
        details: { videoId },
      });
    }
    if (result.timedOut) {
      this.logger.warn('het thoi gian cho pha upload, van tiep tuc finish', { videoId });
    }
    return result.value;
  }

  /**
   * Cho video xu ly xong (video_status = ready).
   * Enum day du: ready | processing | error | expired | uploading | upload_failed | upload_complete
   * @param {string} videoId
   * @param {Record<string, any>} options
   */
  async _waitForVideoReady(videoId, options) {
    const timeoutMs = options.processingTimeoutMs ?? this.config.processingTimeoutMs ?? 15 * 60_000;
    const result = await this.poll(
      async () => {
        // processing_progress KHONG la field cua Video node -> chi xin 'status'.
        const data = await this._get(`/${videoId}`, { fields: 'status' });
        const st = data?.status ?? {};
        const vs = normalizeVideoStatus(st.video_status);
        if (vs === 'ready') return { done: true, value: st };
        if (vs === 'error' || vs === 'expired' || vs === 'upload_failed') {
          return { done: false, failed: true, reason: `video_status=${st.video_status}` };
        }
        if (normalizePhase(st.processing_phase?.status) === 'error') {
          return { done: false, failed: true, reason: 'processing_phase=error' };
        }
        return { done: false, value: st };
      },
      { timeoutMs, intervalMs: 3000, maxIntervalMs: 20_000, backoffFactor: 1.4 },
    );

    if (result.failed) {
      throw new ProcessingError(`Facebook xu ly video that bai: ${result.reason}`, {
        platform: this.id,
        details: { videoId, reason: result.reason },
        hint: 'Kiem tra codec (H.264/AAC), ty le khung hinh trong khoang 9:16 - 16:9, va do dai video.',
      });
    }
    if (result.timedOut) {
      this.logger.warn('het thoi gian cho xu ly video', { videoId });
      return { timedOut: true, attempts: result.attempts };
    }
    return { ...result.value, attempts: result.attempts };
  }

  /** /videos chi tra ve video id -> hoi post_id de dung lam link. */
  async _resolveVideoPostId(videoId) {
    try {
      const data = await this._get(`/${videoId}`, { fields: 'post_id,permalink_url' });
      return data?.post_id;
    } catch (err) {
      this.logger.debug('khong lay duoc post_id cua video', { videoId, error: String(err) });
      return undefined;
    }
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Chuyen scheduleAt thanh UNIX seconds, kiem tra cua so cho phep (10 phut - 29 ngay).
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   * @returns {number | undefined}
   */
  _resolveSchedule(post, options) {
    const when = post.scheduleAt ?? (options.scheduleAt ? new Date(options.scheduleAt) : null);
    if (!when) return undefined;
    const delta = when.getTime() - Date.now();
    if (delta < LIMITS.scheduleMinMs) {
      throw new ValidationError(
        'Facebook yeu cau thoi diem hen gio cach hien tai it nhat 10 phut',
        { platform: this.id, details: { scheduleAt: when.toISOString() } },
      );
    }
    if (delta > LIMITS.scheduleMaxMs) {
      throw new ValidationError(
        'Facebook chi cho hen gio toi da 29 ngay (an toan cho moi loai bai)',
        { platform: this.id, details: { scheduleAt: when.toISOString() } },
      );
    }
    return Math.floor(when.getTime() / 1000);
  }

  /** Gan published / scheduled_publish_time vao body. */
  _applyPublishState(body, options, scheduledTs) {
    if (scheduledTs) {
      body.published = false;
      body.scheduled_publish_time = scheduledTs;
      return;
    }
    const published = options.published ?? this.config.published;
    if (published !== undefined) body.published = Boolean(published);
  }

  _feedResult(data, options, scheduledTs, extra = {}) {
    const id = data?.id;
    return {
      platform: this.id,
      ok: true,
      id,
      url: id ? this._permalink(id) : undefined,
      status: scheduledTs ? 'scheduled' : (options.published === false ? 'draft' : 'published'),
      raw: data,
      meta: { ...extra, captionLength: extra.caption?.length },
    };
  }

  /** Link xem bai: {page-id}_{post-id} -> facebook.com/{page-id}/posts/{post-id} */
  _permalink(compositeId) {
    const s = String(compositeId);
    const [pageId, postId] = s.split('_');
    if (pageId && postId) return `https://www.facebook.com/${pageId}/posts/${postId}`;
    return `https://www.facebook.com/${s}`;
  }

  /**
   * Ghi de buildCaption: Facebook khong co gioi han ky tu chinh thuc,
   * nhung van cho phep bo title khi da dat vao field `title` rieng.
   */
  buildCaption(post, options = {}, extra = {}) {
    return super.buildCaption(post, { ...options, ...extra });
  }

  // -------------------------------------------------------------------- HTTP

  /**
   * @param {string} path
   * @param {Record<string, any>} [query]
   */
  async _get(path, query = {}) {
    const res = await this.http.request(`${this.graph}${path}`, {
      method: 'GET',
      query: { ...query, ...this._authQuery() },
      platform: this.id,
      signal: this.signal,
      mapError: (ctx) => mapFacebookError(ctx, `GET ${path}`),
    });
    this._checkUsageHeaders(res);
    return this._unwrap(res, `GET ${path}`);
  }

  /**
   * @param {string} path
   * @param {Record<string, any>} body
   * @param {{json?: boolean}} [opts]
   */
  async _post(path, body, opts = {}) {
    const payload = { ...body, ...this._authQuery() };
    const res = await this.http.request(`${this.graph}${path}`, {
      method: 'POST',
      ...(opts.json ? { json: payload } : { form: payload }),
      platform: this.id,
      signal: this.signal,
      throwOnError: false,
      mapError: (ctx) => mapFacebookError(ctx, `POST ${path}`),
    });
    this._checkUsageHeaders(res);
    return this._unwrap(res, `POST ${path}`);
  }

  /**
   * @param {string} path
   * @param {FormData} form
   */
  async _postMultipart(path, form) {
    for (const [k, v] of Object.entries(this._authQuery())) form.append(k, String(v));
    const res = await this.http.request(`${this.graph}${path}`, {
      method: 'POST',
      formData: form,
      platform: this.id,
      signal: this.signal,
      throwOnError: false,
      timeoutMs: this.config.uploadTimeoutMs ?? 30 * 60_000,
      retry: { retries: this.config.uploadRetries ?? 1 },
      mapError: (ctx) => mapFacebookError(ctx, `POST ${path} (multipart)`),
    });
    this._checkUsageHeaders(res);
    return this._unwrap(res, `POST ${path}`);
  }

  /** access_token (+ appsecret_proof neu app bat "Require App Secret"). */
  _authQuery() {
    /** @type {Record<string, string>} */
    const q = { access_token: this.token };
    if (this.config.appSecret) {
      q.appsecret_proof = crypto.createHmac('sha256', this.config.appSecret).update(String(this.token)).digest('hex');
    }
    return q;
  }

  /**
   * Graph co the tra HTTP 200 nhung body van chua {error}.
   * @param {import('../core/http.js').HttpResponse} res
   * @param {string} op
   */
  _unwrap(res, op) {
    const data = res.data;
    if (data && typeof data === 'object' && data.error) {
      throw mapFacebookError({ status: res.status, data, text: res.text, res: res.res, url: op }, op)
        ?? new PlatformError(`[facebook] ${op} that bai`, { platform: this.id, details: data });
    }
    if (!res.ok) {
      throw mapFacebookError({ status: res.status, data, text: res.text, res: res.res, url: op }, op)
        ?? new PlatformError(`[facebook] ${op} HTTP ${res.status}`, { platform: this.id, details: data });
    }
    return data;
  }

  /** Canh bao khi gan het quota (X-App-Usage / X-Business-Use-Case-Usage). */
  _checkUsageHeaders(res) {
    try {
      const app = res.headers.get('x-app-usage');
      if (app) {
        const u = JSON.parse(app);
        const peak = Math.max(Number(u.call_count) || 0, Number(u.total_time) || 0, Number(u.total_cputime) || 0);
        if (peak >= 80) this.logger.warn('sap het quota app cua Facebook', { usage: u });
      }
      const buc = res.headers.get('x-business-use-case-usage');
      if (buc) {
        const parsed = JSON.parse(buc);
        for (const entries of Object.values(parsed)) {
          for (const e of /** @type {any[]} */ (entries)) {
            const peak = Math.max(Number(e.call_count) || 0, Number(e.total_time) || 0, Number(e.total_cputime) || 0);
            if (peak >= 80) {
              this.logger.warn('sap het quota Page cua Facebook', {
                type: e.type,
                usage: peak,
                regainInMinutes: e.estimated_time_to_regain_access,
              });
            }
          }
        }
      }
    } catch {
      // Header sai dinh dang -> bo qua.
    }
  }
}

// ------------------------------------------------------------------ helpers

/** Them cac field vao FormData (object -> JSON string, bo undefined). */
function appendFields(form, fields) {
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined || v === null) continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return form;
}

/** Docs dung ca 'complete' va 'completed' -> chuan hoa ve 'complete'. */
export function normalizePhase(status) {
  const s = String(status ?? '').toLowerCase();
  return s === 'completed' ? 'complete' : s;
}

export function normalizeVideoStatus(status) {
  return String(status ?? '').toLowerCase();
}

/**
 * Chuyen loi Graph API thanh loi cua module.
 * Shape: {error: {message, type, code, error_subcode, fbtrace_id}}
 * @param {{status: number, data: any, text: string, res: Response, url: string}} ctx
 * @param {string} [op]
 * @returns {Error | undefined}
 */
export function mapFacebookError(ctx, op = '') {
  const { status, data, text, res } = ctx;
  const err = data?.error;
  if (!err && status < 400) return undefined;

  const code = Number(err?.code ?? 0);
  const subcode = Number(err?.error_subcode ?? 0);
  const message = err?.message ?? String(text ?? '').slice(0, 300);
  const base = {
    platform: 'facebook',
    httpStatus: status,
    platformCode: code,
    platformSubcode: subcode,
    details: {
      op,
      code,
      subcode,
      type: err?.type,
      fbtrace_id: err?.fbtrace_id,
      user_title: err?.error_user_title,
      user_msg: err?.error_user_msg,
    },
  };

  // Token chet -> dung han, dung retry.
  if (code === 190) {
    const subHints = {
      458: 'User da xoa app -> phai xin quyen lai.',
      459: 'User can dang nhap lai tai facebook.com (checkpoint).',
      460: 'User doi mat khau -> token bi huy.',
      463: 'Token het han.',
      464: 'User chua xac thuc.',
      467: 'Token khong hop le hoac bi thu hoi.',
      492: 'User khong con role tren Page nay.',
    };
    return new AuthError(`[facebook] token khong hop le (190/${subcode}): ${message}`, {
      ...base,
      retryable: false,
      hint: subHints[subcode] ?? 'Tao lai Page access token tu USER token dai han (GET /me/accounts).',
    });
  }
  if (code === 200 || (code >= 200 && code <= 299) || code === 10 || code === 283) {
    return new AuthError(`[facebook] thieu quyen (${code}): ${message}`, {
      ...base,
      retryable: false,
      hint: 'Can pages_manage_posts + pages_read_engagement + pages_show_list, va user phai co task CREATE_CONTENT tren Page.',
    });
  }
  if (code === 104) {
    return new AuthError(`[facebook] sai appsecret_proof (104): ${message}`, {
      ...base,
      retryable: false,
      hint: 'App dang bat "Require App Secret" -> cau hinh `appSecret` de module tu tinh appsecret_proof.',
    });
  }
  if (code === 368) {
    return new RateLimitError(`[facebook] bi chan vi bi coi la spam (368): ${message}`, {
      ...base,
      retryable: true,
      retryAfterMs: 30 * 60_000,
      hint: 'Lop chong spam cua Meta. Giam tan suat dang, doi vai gio. Retry lien tuc co the bi chan Page.',
    });
  }
  if (code === 80001 || code === 4 || code === 17 || code === 32 || code === 613 || code === 341) {
    const regainMin = extractRegainMinutes(res);
    return new RateLimitError(`[facebook] vuot gioi han tan suat (${code}): ${message}`, {
      ...base,
      retryable: true,
      retryAfterMs: regainMin ? regainMin * 60_000 : undefined,
      hint: 'Quota Page = 4800 x so nguoi tuong tac 24h. Page moi/it tuong tac se bi gioi han rat som.',
    });
  }
  if (code === 506) {
    return new PlatformError(`[facebook] noi dung trung lap (506): ${message}`, {
      ...base,
      retryable: false,
      hint: 'Facebook tu choi bai co noi dung y het bai truoc. Them timestamp/emoji/hashtag khac nhau.',
    });
  }
  if (code === 324) {
    return new PlatformError(`[facebook] anh khong hop le (324): ${message}`, {
      ...base,
      retryable: false,
      hint: 'Anh sai dinh dang hoac vuot 4MB (PNG: 1MB). Chuyen sang JPEG.',
    });
  }
  if (code === 382) {
    return new PlatformError(`[facebook] video qua nho (382): ${message}`, { ...base, retryable: false });
  }
  if (code === 389) {
    return new PlatformError(`[facebook] khong tai duoc video tu URL (389): ${message}`, {
      ...base,
      retryable: false,
      hint: 'URL phai cong khai, khong can dang nhap, va tra ve Content-Type dung.',
    });
  }
  if (code === 6000 || code === 6001) {
    return new PlatformError(`[facebook] loi upload video (${code}): ${message}`, { ...base, retryable: true });
  }
  if (code === 1 || code === 2) {
    return new PlatformError(`[facebook] loi tam thoi cua Graph (${code}): ${message}`, { ...base, retryable: true });
  }
  if (code === 100) {
    return new PlatformError(`[facebook] tham so khong hop le (100): ${message}`, {
      ...base,
      retryable: false,
      hint: 'Kiem tra ten field va encoding (vi du attached_media phai la mang {media_fbid}).',
    });
  }
  if (status === 429) {
    return new RateLimitError(`[facebook] 429: ${message}`, { ...base, retryable: true });
  }
  if (status >= 500) {
    return new PlatformError(`[facebook] ${status}: ${message}`, { ...base, retryable: true });
  }
  if (status >= 400 || err) {
    return new PlatformError(`[facebook] loi ${code || status}: ${message}`, {
      ...base,
      retryable: RETRYABLE_CODES.has(code),
    });
  }
  return undefined;
}

/** Doc estimated_time_to_regain_access (phut) tu header BUC. */
function extractRegainMinutes(res) {
  try {
    const buc = res?.headers?.get?.('x-business-use-case-usage');
    if (!buc) return undefined;
    const parsed = JSON.parse(buc);
    for (const entries of Object.values(parsed)) {
      for (const e of /** @type {any[]} */ (entries)) {
        const m = Number(e.estimated_time_to_regain_access);
        if (Number.isFinite(m) && m > 0) return m;
      }
    }
  } catch {
    // bo qua
  }
  return undefined;
}
