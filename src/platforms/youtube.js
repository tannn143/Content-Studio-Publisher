/**
 * YouTube Data API v3 adapter - upload video (long-form / Shorts) bang resumable upload.
 *
 * Diem quan trong (theo docs 2026):
 *  - Upload di vao HOST RIENG: https://www.googleapis.com/upload/youtube/v3/videos
 *    (thieu '/upload' se bi 400 mediaBodyRequired)
 *  - `part` phai liet ke dung cac object top-level trong body, neu thieu 'status'
 *    thi privacyStatus bi BO AM THAM -> video thanh public ngoai y muon.
 *  - X-Upload-Content-Length = dung luong VIDEO; Content-Length = dung luong JSON.
 *  - Chunk khong phai chunk cuoi: phai la boi so 256KB (262144) va CUNG kich thuoc.
 *  - Quota tinh o buoc KHOI TAO (100 upload/ngay/project) -> khong retry buoc 1 bua bai.
 *  - Access token co the het han giua lan upload dai -> lay token moi truoc moi chunk.
 *  - Shorts KHONG co field API: quyet dinh boi ty le khung hinh (doc/vuong) + <= 3 phut.
 *
 * Docs: https://developers.google.com/youtube/v3/docs/videos/insert
 *       https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 */

import { BasePlatform } from './base.js';
import {
  AuthError,
  PlatformError,
  ProcessingError,
  QuotaError,
  RateLimitError,
  UnsupportedError,
  ValidationError,
} from '../core/errors.js';
import { AccessTokenManager, tokenStoreKey } from '../core/tokenstore.js';
import { formatHashtags, normalizeHashtags } from '../core/text.js';
import { toMedia } from '../core/media.js';
import { sleep } from '../core/retry.js';

const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Chunk phai la boi so 256KB. */
const CHUNK_GRANULARITY = 262_144;
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8MB = 32 x 256KB

const LIMITS = {
  titleChars: 100,
  descriptionBytes: 5000,
  tagsTotalChars: 500,
  maxHashtagsUsable: 60, // >60 hashtag -> YouTube bo het
  thumbnailBytes: 2 * 1024 * 1024,
  videoBytes: 256 * 1024 * 1024 * 1024, // 256GB
};

export class YouTubePlatform extends BasePlatform {
  static id = 'youtube';

  static displayName = 'YouTube';

  /** @type {import('./base.js').PlatformCapabilities} */
  static capabilities = {
    text: false,
    image: false, // API khong dang duoc anh/community post
    video: true,
    album: false,
    requiresPublicUrl: false,
    maxMediaCount: 1,
    supportsSchedule: true, // privacyStatus=private + publishAt
    limits: { title: LIMITS.titleChars, caption: LIMITS.descriptionBytes, hashtags: LIMITS.maxHashtagsUsable },
    videoMime: undefined, // YouTube nhan video/* va application/octet-stream
    maxVideoBytes: LIMITS.videoBytes,
  };

  /**
   * @param {Record<string, any>} config
   * @param {object} ctx
   */
  constructor(config, ctx) {
    super(config, ctx);
    this.tokens = new AccessTokenManager({
      key: this.config.tokenKey ?? tokenStoreKey('youtube', this.config.clientId, this.config.refreshToken),
      store: this.store,
      logger: this.logger,
      // Co refreshToken thi KHONG tin access token trong config (khong ro con han khong).
      initialAccessToken: this.config.refreshToken ? undefined : this.config.accessToken,
      refresh: () => this._refreshAccessToken(),
    });
  }

  validateConfig() {
    this.requireConfig(['clientId', 'clientSecret', 'refreshToken'], {
      hint: 'Tao OAuth Client (Desktop/Web) trong Google Cloud, bat YouTube Data API v3, '
        + 'roi ket noi o tab "Kenh" cua web admin (`npm run serve`). LUU Y: app o che do Testing thi refresh token het han sau 7 ngay.',
    });
    return true;
  }

  async verifyCredentials() {
    try {
      const token = await this.tokens.getAccessToken();
      const data = await this._apiGet('/channels', { part: 'snippet,contentDetails', mine: 'true' }, token);
      const ch = data?.items?.[0];
      if (!ch) {
        return {
          ok: false,
          error: new AuthError('Tai khoan Google nay chua co channel YouTube', {
            platform: this.id,
            hint: 'Tao channel tai youtube.com truoc khi upload.',
          }),
        };
      }
      return {
        ok: true,
        account: { id: ch.id, title: ch.snippet?.title, customUrl: ch.snippet?.customUrl },
      };
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
    const media = post.videos[0];
    if (!media) {
      throw new UnsupportedError(
        'YouTube Data API chi dang duoc VIDEO. Muon dang anh: encode anh thanh video doc ngan (Shorts) roi dang.',
        { platform: this.id },
      );
    }
    this.assertMediaLimits(media);
    // Buoc khoi tao resumable TRU QUOTA (100 upload/ngay) nen phai kiem tra truoc,
    // khong de den luc upload chunk moi phat hien khong biet dung luong.
    if (!media.size) {
      throw new UnsupportedError(
        'Khong xac dinh duoc dung luong video - YouTube yeu cau X-Upload-Content-Length chinh xac.',
        { platform: this.id, hint: 'Dung file local hoac URL co tra ve Content-Length.' },
      );
    }

    // Bo sung duration/kich thuoc de canh bao Shorts (khong bat buoc, can ffprobe).
    if (options.probeMedia !== false && (!media.durationSec || !media.width)) {
      await media.probeWithFfprobe();
    }

    const snippet = this._buildSnippet(post, options);
    const status = this._buildStatus(post, options);
    const body = { snippet, status };
    if (options.recordingDate) body.recordingDetails = { recordingDate: toIso(options.recordingDate) };

    this._warnShortsMismatch(media, options);

    const sessionUrl = await this._initResumable(body, media, options);
    const video = await this._uploadChunks(sessionUrl, media, options);

    const videoId = video?.id;
    if (!videoId) {
      throw new PlatformError('YouTube khong tra ve video id sau khi upload', {
        platform: this.id,
        details: video,
      });
    }

    /** @type {Record<string, any>} */
    const meta = {
      uploadStatus: video?.status?.uploadStatus,
      privacyStatus: video?.status?.privacyStatus,
    };

    // Cho YouTube xu ly xong truoc khi dat thumbnail / them playlist.
    let processing;
    if (options.waitForProcessing ?? this.config.waitForProcessing ?? true) {
      processing = await this._waitForProcessing(videoId, options);
      meta.processing = processing;
    }

    const thumb = options.thumbnail ?? media.thumbnailPath;
    const processingOk = !processing || processing.processingStatus === 'succeeded';
    if (thumb && !processingOk) {
      this.logger.warn('bo qua thumbnail: YouTube chua xu ly xong video', {
        videoId,
        processing: processing?.processingStatus ?? 'timeout',
        hint: 'Dat thumbnail sau bang youtube.setThumbnail(videoId, file).',
      });
      meta.thumbnail = { ok: false, skipped: 'video chua xu ly xong' };
    } else if (thumb) {
      meta.thumbnail = await this._setThumbnail(videoId, thumb).catch((err) => {
        // Thumbnail loi khong nen lam that bai ca bai dang.
        this.logger.warn('dat thumbnail that bai', { error: /** @type {Error} */ (err).message });
        return { ok: false, error: /** @type {Error} */ (err).message };
      });
    }

    const playlistId = options.playlistId ?? this.config.playlistId;
    if (playlistId) {
      meta.playlist = await this._addToPlaylist(videoId, playlistId).catch((err) => {
        this.logger.warn('them vao playlist that bai', { error: /** @type {Error} */ (err).message });
        return { ok: false, error: /** @type {Error} */ (err).message };
      });
    }

    const isShort = isLikelyShort(media);
    return {
      platform: this.id,
      ok: true,
      id: videoId,
      url: isShort ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
      status: post.scheduleAt ? 'scheduled' : (processing?.failed ? 'processing-failed' : 'published'),
      raw: video,
      meta: { ...meta, isShort, watchUrl: `https://www.youtube.com/watch?v=${videoId}` },
    };
  }

  // ------------------------------------------------------------- metadata

  /**
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   */
  _buildSnippet(post, options) {
    const title = buildTitle(post, options);
    if (!title) {
      throw new ValidationError('YouTube bat buoc co title khong rong', {
        platform: this.id,
        issues: [{ path: 'title', message: 'required' }],
      });
    }

    const description = buildDescription(post, options);
    const tags = buildTags(post.hashtags, options);

    /** @type {Record<string, any>} */
    const snippet = {
      title,
      description,
      categoryId: String(options.categoryId ?? this.config.categoryId ?? '22'),
    };
    if (tags.length > 0) snippet.tags = tags;
    const lang = options.defaultLanguage ?? this.config.defaultLanguage;
    if (lang) snippet.defaultLanguage = lang;
    return snippet;
  }

  /**
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   */
  _buildStatus(post, options) {
    let privacyStatus = String(options.privacyStatus ?? this.config.privacyStatus ?? 'private').toLowerCase();
    if (!['private', 'public', 'unlisted'].includes(privacyStatus)) {
      throw new ValidationError(`privacyStatus phai la private|public|unlisted (nhan '${privacyStatus}')`, {
        platform: this.id,
      });
    }

    /** @type {Record<string, any>} */
    const status = {
      privacyStatus,
      // Field GHI duoc la selfDeclaredMadeForKids; madeForKids la READ-ONLY.
      selfDeclaredMadeForKids: Boolean(options.madeForKids ?? this.config.madeForKids ?? false),
    };

    if (post.scheduleAt) {
      // publishAt chi co hieu luc khi privacyStatus = 'private'.
      if (privacyStatus !== 'private') {
        this.logger.warn('publishAt chi hoat dong voi privacyStatus=private -> tu dong doi sang private');
        status.privacyStatus = 'private';
      }
      if (post.scheduleAt.getTime() <= Date.now()) {
        throw new ValidationError('scheduleAt phai o tuong lai (YouTube tra 400 invalidPublishAt)', {
          platform: this.id,
        });
      }
      status.publishAt = post.scheduleAt.toISOString();
    }

    if (options.license) status.license = options.license;
    if (options.embeddable !== undefined) status.embeddable = Boolean(options.embeddable);
    if (options.publicStatsViewable !== undefined) status.publicStatsViewable = Boolean(options.publicStatsViewable);
    if (options.containsSyntheticMedia !== undefined) {
      status.containsSyntheticMedia = Boolean(options.containsSyntheticMedia);
    }
    return status;
  }

  /** Canh bao khi nguoi dung mong muon Shorts nhung media khong dat dieu kien. */
  _warnShortsMismatch(media, options) {
    const wantShort = options.asShort ?? this.config.asShort;
    if (!wantShort) return;
    const reasons = [];
    if (media.width && media.height && media.width > media.height) reasons.push('video ngang (can doc hoac vuong)');
    if (media.durationSec && media.durationSec > 180) reasons.push(`dai ${Math.round(media.durationSec)}s (toi da 180s)`);
    if (reasons.length > 0) {
      this.logger.warn('video co the KHONG duoc xem la Shorts', {
        reasons,
        hint: 'Shorts duoc xac dinh boi ty le khung hinh (width <= height) va thoi luong <= 3 phut, khong phai boi #Shorts.',
      });
    }
  }

  // --------------------------------------------------------- resumable upload

  /**
   * Buoc 1: khoi tao session resumable. Tra ve session URI.
   * @param {Record<string, any>} body
   * @param {import('../core/media.js').Media} media
   * @param {Record<string, any>} options
   * @returns {Promise<string>}
   */
  async _initResumable(body, media, options) {
    const token = await this.tokens.getAccessToken();
    // `part` PHAI khop cac key top-level cua body.
    const part = Object.keys(body).join(',');
    const notifySubscribers = options.notifySubscribers ?? this.config.notifySubscribers ?? false;

    const res = await this.http.request(`${UPLOAD_BASE}/videos`, {
      method: 'POST',
      query: {
        uploadType: 'resumable',
        part,
        notifySubscribers: notifySubscribers ? 'true' : 'false',
        onBehalfOfContentOwner: options.onBehalfOfContentOwner,
        onBehalfOfContentOwnerChannel: options.onBehalfOfContentOwnerChannel,
      },
      headers: {
        authorization: `Bearer ${token}`,
        'x-upload-content-length': String(media.size ?? 0),
        'x-upload-content-type': media.mime ?? 'video/mp4',
      },
      json: body,
      parse: 'text',
      platform: this.id,
      signal: this.signal,
      // Quota bi tinh o buoc nay -> KHONG retry nhieu lan.
      retry: { retries: options.initRetries ?? 0 },
      mapError: (ctx) => mapYouTubeError(ctx, 'videos.insert:init'),
    });

    const location = res.headers.get('location');
    if (!location) {
      throw new PlatformError('YouTube khong tra ve header Location cho session resumable', {
        platform: this.id,
        details: { status: res.status, body: res.text?.slice(0, 400) },
      });
    }
    this.logger.debug('da mo session resumable', { part, size: media.size });
    return location;
  }

  /**
   * Buoc 2: day tung chunk len. Tu resume khi bi ngat.
   * @param {string} sessionUrl
   * @param {import('../core/media.js').Media} media
   * @param {Record<string, any>} options
   * @returns {Promise<any>} video resource
   */
  async _uploadChunks(sessionUrl, media, options) {
    const total = media.size ?? 0;
    if (!total) throw new UnsupportedError('Khong xac dinh duoc dung luong video', { platform: this.id });

    const chunkSize = normalizeChunkSize(options.chunkSizeBytes ?? this.config.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE);
    const contentType = media.mime ?? 'video/mp4';
    const maxAttempts = options.uploadRetries ?? this.config.uploadRetries ?? 8;

    let offset = 0;
    let attempt = 0;

    while (offset < total) {
      const end = Math.min(offset + chunkSize, total) - 1;
      const chunk = await media.readRange(offset, end);
      // Token co the het han giua lan upload dai -> lay lai truoc MOI chunk.
      const token = await this.tokens.getAccessToken();

      let res;
      try {
        res = await this.http.putChunk(sessionUrl, chunk, {
          start: offset,
          total,
          contentType,
          headers: { authorization: `Bearer ${token}` },
          signal: this.signal,
          platform: this.id,
          acceptStatus: [200, 201, 308],
          mapError: (ctx) => mapYouTubeError(ctx, 'videos.insert:put'),
        });
      } catch (err) {
        attempt += 1;
        const e = /** @type {any} */ (err);
        if (e.httpStatus === 404) {
          throw new PlatformError(
            'Session resumable da het han (404). Phai khoi tao lai upload (ton them 1 slot quota/ngay).',
            { platform: this.id, cause: err, retryable: false, hint: 'Giam thoi gian giua cac chunk, hoac upload lai.' },
          );
        }
        if (attempt > maxAttempts || e.retryable === false) throw err;

        // Backoff truoc khi thu lai: khong co no, mot loi 503 keo dai se quay
        // vong lap hang nghin lan trong vai giay.
        const delayMs = Math.min(64_000, 1000 * 2 ** (attempt - 1));
        this.logger.warn('chunk loi, cho roi do lai vi tri tu server', {
          attempt,
          offset,
          delayMs,
          error: e.message,
        });
        await sleep(e.retryAfterMs ? Math.max(delayMs, e.retryAfterMs) : delayMs, this.signal);

        // KHONG tin con tro local: hoi server dang giu bao nhieu byte.
        const probe = await this._probeOffset(sessionUrl, total);
        if (probe.completed) return probe.video;
        offset = probe.nextOffset;
        continue;
      }

      if (res.status === 200 || res.status === 201) {
        const video = typeof res.data === 'string' ? tryJson(res.data) : res.data;
        this.logger.info('upload video xong', { videoId: video?.id, bytes: total });
        return video;
      }

      // 308 Resume Incomplete: doc header Range de biet server da nhan den dau.
      const range = res.headers.get('range');
      const lastByte = parseRangeEnd(range);
      const nextOffset = lastByte === null ? 0 : lastByte + 1;

      // Khong tien them byte nao -> co the lap vo han. Dem so lan de con duong ra.
      if (nextOffset <= offset) {
        attempt += 1;
        if (attempt > maxAttempts) {
          throw new PlatformError(
            `YouTube khong nhan thêm byte nao sau ${attempt} lan thu (offset ${offset}/${total})`,
            { platform: this.id, retryable: false, details: { offset, total, range } },
          );
        }
        const delayMs = Math.min(64_000, 1000 * 2 ** (attempt - 1));
        this.logger.warn('308 khong tien trien - cho roi thu lai', { offset, attempt, delayMs, range });
        await sleep(delayMs, this.signal);
      } else {
        attempt = 0;
      }
      offset = nextOffset;
      this.logger.debug('chunk da nhan', { progress: `${Math.round((offset / total) * 100)}%`, offset, total });
    }

    // Da day het byte ma chua thay 200/201 -> hoi lai server.
    const probe = await this._probeOffset(sessionUrl, total);
    if (probe.completed) return probe.video;
    throw new PlatformError('Da gui het byte nhung YouTube chua xac nhan hoan tat', {
      platform: this.id,
      details: { total, nextOffset: probe.nextOffset },
    });
  }

  /**
   * Buoc 3: hoi server da nhan den byte nao (PUT rong voi Content-Range: bytes *\/TOTAL).
   * @param {string} sessionUrl
   * @param {number} total
   * @returns {Promise<{completed: boolean, video?: any, nextOffset: number}>}
   */
  async _probeOffset(sessionUrl, total) {
    const token = await this.tokens.getAccessToken();
    const res = await this.http.request(sessionUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-range': `bytes */${total}`,
        'content-length': '0',
      },
      parse: 'text',
      platform: this.id,
      signal: this.signal,
      throwOnError: false,
      retry: { retries: 2 },
    });

    if (res.status === 200 || res.status === 201) {
      return { completed: true, video: tryJson(res.text), nextOffset: total };
    }
    if (res.status === 308) {
      const lastByte = parseRangeEnd(res.headers.get('range'));
      return { completed: false, nextOffset: lastByte === null ? 0 : lastByte + 1 };
    }
    throw mapYouTubeError(
      { status: res.status, data: res.data, text: res.text, res: res.res, url: 'resume-probe' },
      'videos.insert:probe',
    ) ?? new PlatformError(`Probe resumable that bai (HTTP ${res.status})`, { platform: this.id });
  }

  // ------------------------------------------------------------- sau upload

  /**
   * Cho YouTube xu ly xong (transcode). Khong nen dat thumbnail truoc khi xong.
   * @param {string} videoId
   * @param {Record<string, any>} options
   */
  async _waitForProcessing(videoId, options) {
    const timeoutMs = options.processingTimeoutMs ?? this.config.processingTimeoutMs ?? 20 * 60_000;
    this.logger.debug('cho YouTube xu ly video', { videoId, timeoutMs });

    const result = await this.poll(
      async () => {
        const token = await this.tokens.getAccessToken();
        const data = await this._apiGet('/videos', { part: 'status,processingDetails', id: videoId }, token);
        const item = data?.items?.[0];
        const uploadStatus = item?.status?.uploadStatus;
        const processingStatus = item?.processingDetails?.processingStatus;

        if (uploadStatus === 'failed') {
          return { done: false, failed: true, reason: `uploadStatus=failed (${item?.status?.failureReason ?? 'unknown'})` };
        }
        if (uploadStatus === 'rejected') {
          return { done: false, failed: true, reason: `uploadStatus=rejected (${item?.status?.rejectionReason ?? 'unknown'})` };
        }
        if (processingStatus === 'failed' || processingStatus === 'terminated') {
          return {
            done: false,
            failed: true,
            reason: `processingStatus=${processingStatus} (${item?.processingDetails?.processingFailureReason ?? 'unknown'})`,
          };
        }
        if (processingStatus === 'succeeded') {
          return { done: true, value: { uploadStatus, processingStatus, progress: item?.processingDetails?.processingProgress } };
        }
        return { done: false, value: { uploadStatus, processingStatus } };
      },
      { timeoutMs, intervalMs: 5000, maxIntervalMs: 60_000, backoffFactor: 1.5 },
    );

    if (result.failed) {
      throw new ProcessingError(`YouTube xu ly video that bai: ${result.reason}`, {
        platform: this.id,
        details: { videoId, reason: result.reason },
        hint: 'Xem lai codec/do dai video. Channel chua xac minh chi duoc upload video <= 15 phut.',
      });
    }
    if (result.timedOut) {
      this.logger.warn('het thoi gian cho xu ly - video van dang duoc YouTube xu ly', { videoId });
      return { timedOut: true, attempts: result.attempts };
    }
    return { ...result.value, attempts: result.attempts, elapsedMs: result.elapsedMs };
  }

  /**
   * Dat thumbnail tuy chinh (can channel DA XAC MINH).
   * Body la RAW BINARY, videoId nam o query string.
   * @param {string} videoId
   * @param {any} thumbnailInput
   */
  async setThumbnail(videoId, thumbnailInput) {
    return this._setThumbnail(videoId, thumbnailInput);
  }

  /**
   * @param {string} videoId
   * @param {any} thumbnailInput
   */
  async _setThumbnail(videoId, thumbnailInput) {
    const media = toMedia(thumbnailInput);
    await media.load();
    if (media.size && media.size > LIMITS.thumbnailBytes) {
      throw new UnsupportedError(
        `Thumbnail ${Math.round(media.size / 1024)}KB vuot gioi han 2MB cua YouTube`,
        { platform: this.id },
      );
    }
    const mime = media.mime === 'image/png' ? 'image/png' : 'image/jpeg';
    const token = await this.tokens.getAccessToken();
    const buf = await media.toBuffer({ maxBytes: LIMITS.thumbnailBytes });

    const res = await this.http.request(`${UPLOAD_BASE}/thumbnails/set`, {
      method: 'POST',
      query: { videoId, uploadType: 'media' },
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': mime,
        'content-length': String(buf.byteLength),
      },
      body: buf,
      platform: this.id,
      signal: this.signal,
      retry: { retries: 2 },
      mapError: (ctx) => mapYouTubeError(ctx, 'thumbnails.set'),
    });
    this.logger.info('da dat thumbnail', { videoId });
    return { ok: true, items: res.data?.items };
  }

  /**
   * Them video vao playlist (ton 50 unit quota chung).
   * @param {string} videoId
   * @param {string} playlistId
   */
  async _addToPlaylist(videoId, playlistId) {
    const token = await this.tokens.getAccessToken();
    const data = await this.http.request(`${API_BASE}/playlistItems`, {
      method: 'POST',
      query: { part: 'snippet' },
      headers: { authorization: `Bearer ${token}` },
      json: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
      platform: this.id,
      signal: this.signal,
      retry: { retries: 2 },
      mapError: (ctx) => mapYouTubeError(ctx, 'playlistItems.insert'),
    }).then((r) => r.data);
    this.logger.info('da them vao playlist', { videoId, playlistId });
    return { ok: true, id: data?.id };
  }

  // ---------------------------------------------------------------- HTTP/auth

  /**
   * @param {string} path
   * @param {Record<string, any>} query
   * @param {string} token
   */
  async _apiGet(path, query, token) {
    const res = await this.http.request(`${API_BASE}${path}`, {
      method: 'GET',
      query,
      headers: { authorization: `Bearer ${token}` },
      platform: this.id,
      signal: this.signal,
      mapError: (ctx) => mapYouTubeError(ctx, `GET ${path}`),
    });
    return res.data;
  }

  /** Doi refresh_token thanh access_token moi. */
  async _refreshAccessToken() {
    const res = await this.http.request(TOKEN_URL, {
      method: 'POST',
      // PHAI la form-urlencoded; gui JSON se bi 400 invalid_request.
      form: {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
      },
      platform: this.id,
      signal: this.signal,
      throwOnError: false,
      retry: { retries: 2 },
    });

    const data = res.data;
    if (!res.ok || !data?.access_token) {
      const code = data?.error;
      if (code === 'invalid_grant') {
        throw new AuthError(
          'YouTube refresh_token het han hoac bi thu hoi (invalid_grant). Phai xin lai quyen.',
          {
            platform: this.id,
            httpStatus: res.status,
            details: data,
            retryable: false,
            hint: 'Ket noi lai YouTube o tab "Kenh" cua web admin. Neu OAuth consent screen dang o che do Testing thi token het han sau 7 ngay '
              + '- hay dua app sang "In production".',
          },
        );
      }
      throw new AuthError(`Khong lay duoc access token YouTube: ${code ?? res.status} ${data?.error_description ?? ''}`, {
        platform: this.id,
        httpStatus: res.status,
        details: data,
        retryable: res.status >= 500,
      });
    }
    // Luu y: grant refresh_token KHONG tra ve refresh_token moi.
    return { accessToken: data.access_token, expiresInSec: Number(data.expires_in) || 3600 };
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Title: toi da 100 KY TU, khong duoc chua '<' hoac '>'.
 * @param {import('../core/post.js').Post} post
 * @param {Record<string, any>} options
 */
export function buildTitle(post, options = {}) {
  let title = String(options.title ?? post.title ?? '').trim();
  if (!title && post.description) {
    // Lay dong dau cua description lam title.
    title = post.description.split('\n')[0].trim();
  }
  title = stripAngles(title);
  if (title.length > LIMITS.titleChars) {
    let cut = title.slice(0, LIMITS.titleChars - 1);
    // Khong de dut doi surrogate pair (emoji) o cuoi -> YouTube tu choi ky tu khong hop le.
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    title = `${cut.trimEnd()}…`;
  }
  return title;
}

/**
 * Description: toi da 5000 BYTE (khong phai ky tu), khong duoc chua '<' '>'.
 * Hashtag duoc gan vao cuoi description (YouTube khong co field hashtag rieng).
 * @param {import('../core/post.js').Post} post
 * @param {Record<string, any>} options
 */
export function buildDescription(post, options = {}) {
  const parts = [];
  const desc = stripAngles(String(options.description ?? post.description ?? '').trim());
  if (desc) parts.push(desc);
  if (post.link) parts.push(stripAngles(post.link));

  if (options.includeHashtags !== false && post.hashtags.length > 0) {
    const tags = normalizeHashtags(post.hashtags, { max: options.maxHashtags ?? LIMITS.maxHashtagsUsable });
    if (tags.length > 0) parts.push(formatHashtags(tags));
  }
  if (options.descriptionFooter ?? options.footer) {
    parts.push(stripAngles(String(options.descriptionFooter ?? options.footer)));
  }
  return truncateBytes(parts.join('\n\n'), LIMITS.descriptionBytes);
}

/**
 * snippet.tags: TONG do dai 500 ky tu, tinh CA dau phay noi va dau ngoac kep
 * ma server tu them quanh tag co khoang trang.
 * @param {string[]} hashtags
 * @param {Record<string, any>} [options]
 * @returns {string[]}
 */
export function buildTags(hashtags, options = {}) {
  const extra = options.tags ? normalizeHashtags(options.tags) : [];
  const source = options.tags && options.replaceTags ? extra : [...extra, ...(hashtags ?? [])];
  /** @type {string[]} */
  const out = [];
  let used = 0;
  for (const raw of source) {
    const tag = String(raw).replace(/^#+/, '').trim();
    if (!tag) continue;
    // Tag co khoang trang -> server boc trong dau ngoac kep, cong them 2 ky tu.
    const cost = tag.length + (/\s/.test(tag) ? 2 : 0) + (out.length > 0 ? 1 : 0);
    if (used + cost > LIMITS.tagsTotalChars) break;
    used += cost;
    out.push(tag);
  }
  return out;
}

/** Cat chuoi theo so BYTE UTF-8, khong lam vo ky tu nhieu byte. */
export function truncateBytes(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.byteLength <= maxBytes) return str;
  // Cat roi dung TextDecoder bo qua byte le cuoi.
  const sliced = buf.subarray(0, maxBytes);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sliced).replace(/�+$/, '');
  return decoded;
}

/** YouTube tu choi '<' va '>' -> phai BO, escape HTML khong giup gi. */
export function stripAngles(str) {
  return String(str ?? '').replace(/[<>]/g, '');
}

/** Lam tron chunk size ve boi so 256KB (toi thieu 1 don vi). */
export function normalizeChunkSize(bytes) {
  const n = Number(bytes) || DEFAULT_CHUNK_SIZE;
  const units = Math.max(1, Math.floor(n / CHUNK_GRANULARITY));
  return units * CHUNK_GRANULARITY;
}

/**
 * Doc header `Range: bytes=0-262143` -> 262143.
 * @param {string | null} range
 * @returns {number | null}
 */
export function parseRangeEnd(range) {
  if (!range) return null;
  const m = /bytes=(\d+)-(\d+)/.exec(range);
  if (!m) return null;
  return Number(m[2]);
}

/** Doan xem video co duoc YouTube xep la Shorts hay khong. */
export function isLikelyShort(media) {
  if (!media) return false;
  const vertical = media.width && media.height ? media.width <= media.height : undefined;
  const shortEnough = media.durationSec != null ? media.durationSec <= 180 : undefined;
  return Boolean(vertical && shortEnough);
}

/**
 * Chuyen loi Google API thanh loi cua module.
 * Shape: {error: {code, message, errors: [{reason, domain, message}]}}
 * Luon branch theo `error.errors[0].reason`, KHONG theo message.
 * @param {{status: number, data: any, text: string, res: Response, url: string}} ctx
 * @param {string} [op]
 * @returns {Error | undefined}
 */
export function mapYouTubeError(ctx, op = '') {
  const { status, text } = ctx;
  // Mot so request dung parse:'text' (vi response thanh cong co body rong),
  // nen body loi van con la chuoi -> phai parse lai o day.
  const data = typeof ctx.data === 'string' || ctx.data === undefined
    ? (tryJson(typeof ctx.data === 'string' ? ctx.data : text) ?? ctx.data)
    : ctx.data;
  const err = data?.error;
  const reason = err?.errors?.[0]?.reason ?? data?.error;
  const message = err?.message ?? data?.error_description ?? String(text ?? '').slice(0, 300);
  const base = {
    platform: 'youtube',
    httpStatus: status,
    platformCode: reason,
    details: { op, reason, message, domain: err?.errors?.[0]?.domain },
  };

  // Het quota ngay -> retry trong ngay la vo nghia.
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return new QuotaError(`[youtube] het quota (${reason}): ${message}`, {
      ...base,
      retryable: false,
      hint: 'Quota reset 0h Pacific. Mac dinh chi 100 upload/ngay/project. Xin tang quota can qua Compliance Audit.',
    });
  }
  if (reason === 'uploadLimitExceeded') {
    return new QuotaError(`[youtube] channel da upload qua nhieu hom nay: ${message}`, {
      ...base,
      retryable: false,
      hint: 'Gioi han so video/ngay cua chinh channel. Doi sang ngay hom sau.',
    });
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'uploadRateLimitExceeded') {
    return new RateLimitError(`[youtube] bi throttle (${reason}): ${message}`, {
      ...base,
      retryable: true,
      retryAfterMs: reason === 'uploadRateLimitExceeded' ? 60_000 : undefined,
    });
  }
  if (reason === 'youtubeSignupRequired') {
    return new AuthError(`[youtube] tai khoan chua co channel YouTube: ${message}`, {
      ...base,
      retryable: false,
      hint: 'Tao channel YouTube cho tai khoan Google nay. Service account khong dung duoc cho upload thong thuong.',
    });
  }
  if (reason === 'insufficientPermissions') {
    return new AuthError(`[youtube] thieu scope: ${message}`, {
      ...base,
      retryable: false,
      hint: 'Xin lai quyen voi scope https://www.googleapis.com/auth/youtube.upload',
    });
  }
  if (reason === 'accessNotConfigured') {
    return new AuthError(`[youtube] chua bat YouTube Data API v3 tren project: ${message}`, {
      ...base,
      retryable: false,
      hint: 'Vao Google Cloud Console > APIs & Services > bat "YouTube Data API v3".',
    });
  }
  if (status === 401) {
    return new AuthError(`[youtube] 401 (${reason ?? 'unauthorized'}): ${message}`, {
      ...base,
      retryable: false,
      hint: 'Access token sai/het han. Kiem tra refresh_token.',
    });
  }
  if (status === 403) {
    const hint = op === 'thumbnails.set'
      ? 'Thumbnail tuy chinh yeu cau channel DA XAC MINH (verified).'
      : 'Kiem tra quyen cua channel va scope cua token.';
    return new AuthError(`[youtube] 403 (${reason ?? 'forbidden'}): ${message}`, { ...base, retryable: false, hint });
  }
  if (status === 400) {
    const hints = {
      invalidTitle: 'Title rong, qua 100 ky tu, hoac chua ky tu < >.',
      invalidDescription: 'Description qua 5000 BYTE hoac chua ky tu < >.',
      invalidTags: 'Tong do dai tags qua 500 ky tu (tinh ca dau phay va dau ngoac kep).',
      invalidCategoryId: 'categoryId khong hop le o khu vuc nay. Tra videoCategories.list?part=snippet&regionCode=XX.',
      invalidPublishAt: 'publishAt phai o tuong lai VA privacyStatus phai la private.',
      mediaBodyRequired: 'Thieu du lieu video, hoac goi sai host (phai la .../upload/youtube/v3/videos).',
      invalidVideoMetadata: 'Body va tham so `part` khong khop.',
      invalidPart: 'Tham so `part` chua phan khong the ghi cung luc.',
    };
    return new PlatformError(`[youtube] 400 (${reason ?? 'badRequest'}): ${message}`, {
      ...base,
      retryable: false,
      hint: hints[reason],
    });
  }
  if (status === 404) {
    return new PlatformError(`[youtube] 404 (${reason ?? 'notFound'}): ${message}`, { ...base, retryable: false });
  }
  if (status >= 500) {
    return new PlatformError(`[youtube] ${status} (${reason ?? 'backendError'}): ${message}`, {
      ...base,
      retryable: true,
    });
  }
  return undefined;
}

function tryJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toIso(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

