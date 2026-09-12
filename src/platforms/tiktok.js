/**
 * TikTok Content Posting API v2 adapter.
 *
 * Ho tro:
 *  - Video Direct Post: FILE_UPLOAD (chunk PUT) hoac PULL_FROM_URL
 *  - Video Draft (inbox): nguoi dung tu hoan tat trong app TikTok
 *  - Photo/Album (1-35 anh): CHI ho tro PULL_FROM_URL
 *
 * Diem quan trong (docs 2026):
 *  - PHAI goi creator_info/query truoc moi Direct Post: privacy_level gui len BAT BUOC
 *    nam trong `privacy_level_options` tra ve, neu khong se 403 privacy_level_option_mismatch.
 *  - App CHUA duoc audit chi dang duoc SELF_ONLY (rieng tu). Muon public phai qua audit.
 *  - Chunk cuoi cung TO HON chunk_size (total_chunk_count = floor(size/chunk_size)),
 *    day la loi cai dat pho bien nhat.
 *  - Thanh cong duoc xet bang `error.code === 'ok'`, KHONG phai HTTP status
 *    (cung 1 ma loi tra ve HTTP 200 o endpoint nay va 403 o endpoint khac).
 *  - refresh_token XOAY moi lan refresh -> phai luu lai token moi.
 *  - Anh BAT BUOC dung PULL_FROM_URL tu domain DA XAC MINH tren app.
 *
 * Docs: https://developers.tiktok.com/doc/content-posting-api-get-started
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
import { AccessTokenManager, tokenStoreKey } from '../core/tokenstore.js';
import { sleep } from '../core/retry.js';

const API = 'https://open.tiktokapis.com/v2';
const TOKEN_URL = `${API}/oauth/token/`;

const LIMITS = {
  videoTitleRunes: 2200,
  photoTitleRunes: 90,
  photoDescriptionRunes: 4000,
  minChunkBytes: 5 * 1024 * 1024,        // 5MB
  maxChunkBytes: 64 * 1024 * 1024,       // 64MB
  maxFinalChunkBytes: 128 * 1024 * 1024, // 128MB
  maxChunks: 1000,
  maxVideoBytes: 4 * 1024 * 1024 * 1024, // 4GB
  maxPhotos: 35,
  maxPhotoBytes: 20 * 1024 * 1024,
  minDimension: 360,
  maxDimension: 4096,
  minFps: 23,
  maxFps: 60,
};

/** Trang thai tra ve tu status/fetch. */
export const PublishStatus = {
  PROCESSING_UPLOAD: 'PROCESSING_UPLOAD',
  PROCESSING_DOWNLOAD: 'PROCESSING_DOWNLOAD',
  SEND_TO_USER_INBOX: 'SEND_TO_USER_INBOX',
  PUBLISH_COMPLETE: 'PUBLISH_COMPLETE',
  FAILED: 'FAILED',
};

/** fail_reason co the thu lai. */
const RETRYABLE_FAIL_REASONS = new Set([
  'video_pull_failed', 'photo_pull_failed', 'internal', 'spam_risk_too_many_posts',
]);

/** error.code co the thu lai. */
const RETRYABLE_ERROR_CODES = new Set([
  'rate_limit_exceeded', 'internal_error', 'spam_risk_too_many_posts',
  'reached_active_user_cap', 'spam_risk_too_many_pending_share',
]);

export class TikTokPlatform extends BasePlatform {
  static id = 'tiktok';

  static displayName = 'TikTok';

  /** @type {import('./base.js').PlatformCapabilities} */
  static capabilities = {
    text: false,
    image: true,
    video: true,
    album: true,
    requiresPublicUrl: false, // video co FILE_UPLOAD; anh thi bat buoc URL
    maxMediaCount: LIMITS.maxPhotos,
    supportsSchedule: false,
    limits: { title: LIMITS.videoTitleRunes, caption: LIMITS.videoTitleRunes, hashtags: Infinity },
    maxVideoBytes: LIMITS.maxVideoBytes,
    maxImageBytes: LIMITS.maxPhotoBytes,
    imageMime: ['image/jpeg', 'image/webp'],
    videoMime: ['video/mp4', 'video/quicktime', 'video/webm'],
  };

  constructor(config, ctx) {
    super(config, ctx);
    this.tokens = new AccessTokenManager({
      // Khoa phai dinh danh TUNG TAI KHOAN: mot app co the ket noi nhieu creator,
      // dung chung khoa se dang bai len SAI tai khoan.
      key: this.config.tokenKey
        ?? tokenStoreKey('tiktok', this.config.clientKey, this.config.refreshToken, this.config.accessToken),
      store: this.store,
      logger: this.logger,
      // Co refreshToken thi KHONG tin access token trong config (khong biet con han hay khong).
      initialAccessToken: this.config.refreshToken ? undefined : this.config.accessToken,
      refresh: () => this._refreshAccessToken(),
    });
  }

  validateConfig() {
    this.requireConfig(['clientKey', 'clientSecret'], {
      hint: 'Tao app tren developers.tiktok.com, bat san pham "Content Posting API", '
        + 'xin scope video.publish (dang truc tiep) va/hoac video.upload (dang nhap).',
    });
    if (!this.config.refreshToken && !this.config.accessToken) {
      throw new ValidationError(
        '[tiktok] can `refreshToken` (khuyen nghi) hoac `accessToken`',
        { platform: this.id, hint: 'Chay `npm run serve` roi ket noi TikTok o tab "Kenh" de lay token.' },
      );
    }
    return true;
  }

  async verifyCredentials() {
    try {
      const info = await this.getCreatorInfo();
      return {
        ok: true,
        account: {
          username: info.creator_username,
          nickname: info.creator_nickname,
          privacyOptions: info.privacy_level_options,
          maxVideoSec: info.max_video_post_duration_sec,
          commentDisabled: info.comment_disabled,
        },
      };
    } catch (err) {
      return { ok: false, error: /** @type {Error} */ (err) };
    }
  }

  /**
   * Lay thong tin creator. BAT BUOC goi truoc moi Direct Post.
   * Khong duoc cache: nguoi dung co the doi tai khoan sang private bat cu luc nao.
   */
  async getCreatorInfo() {
    const data = await this._call('/post/publish/creator_info/query/', {}, 'creator_info');
    return data ?? {};
  }

  /**
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   * @returns {Promise<import('./base.js').PublishResult>}
   */
  async doPublish(post, options) {
    if (post.media.length === 0) {
      throw new UnsupportedError('TikTok khong co bai chi co chu - can video hoac anh', { platform: this.id });
    }

    const postMode = String(options.postMode ?? this.config.postMode ?? 'DIRECT_POST').toUpperCase();
    const isDraft = postMode === 'MEDIA_UPLOAD' || postMode === 'INBOX' || postMode === 'DRAFT';

    if (post.videos.length > 0) {
      const media = post.videos[0];
      if (post.videos.length > 1) {
        this.logger.warn('TikTok chi dang 1 video moi bai - cac video sau bi bo qua', {
          skipped: post.videos.length - 1,
        });
      }
      return isDraft
        ? this._publishVideoDraft(post, media, options)
        : this._publishVideoDirect(post, media, options);
    }
    return this._publishPhotos(post, options, { draft: isDraft });
  }

  // --------------------------------------------------------- video direct post

  async _publishVideoDirect(post, media, options) {
    this.assertMediaLimits(media);
    if (options.probeMedia !== false && (!media.durationSec || !media.width)) {
      await media.probeWithFfprobe();
    }

    // B1: lay thong tin creator de biet privacy_level nao hop le.
    const creator = await this.getCreatorInfo();
    const privacyLevel = this._resolvePrivacyLevel(creator, options);
    this._assertVideoAgainstCreator(media, creator);

    const postInfo = this._buildVideoPostInfo(post, options, privacyLevel, creator);

    // B2: init (chon FILE_UPLOAD hoac PULL_FROM_URL)
    const useUrl = this._shouldPullFromUrl(media, options);
    const sourceInfo = useUrl
      ? { source: 'PULL_FROM_URL', video_url: media.publicUrl }
      : this.buildChunkPlan(media.size ?? 0, options.chunkSizeBytes ?? this.config.chunkSizeBytes);

    const init = await this._call('/post/publish/video/init/', {
      post_info: postInfo,
      source_info: sourceInfo,
    }, 'video/init');

    const publishId = init?.publish_id;
    if (!publishId) {
      throw new PlatformError('TikTok khong tra ve publish_id', { platform: this.id, details: init });
    }
    this.logger.info('da khoi tao bai TikTok', { publishId, source: useUrl ? 'PULL_FROM_URL' : 'FILE_UPLOAD' });

    // B3: upload chunk (chi voi FILE_UPLOAD)
    if (!useUrl) {
      await this._uploadChunks(init.upload_url, media, /** @type {any} */ (sourceInfo), options);
    }

    // B4: cho publish xong
    const status = await this._waitForStatus(publishId, options, {
      terminal: [PublishStatus.PUBLISH_COMPLETE],
    });

    const postId = status?.postId;
    return {
      platform: this.id,
      ok: true,
      id: postId ?? publishId,
      url: postId && creator.creator_username
        ? `https://www.tiktok.com/@${creator.creator_username}/video/${postId}`
        : undefined,
      status: status?.timedOut ? 'processing' : 'published',
      raw: { init, status: status?.raw },
      meta: {
        kind: 'video',
        publishId,
        privacyLevel,
        source: useUrl ? 'PULL_FROM_URL' : 'FILE_UPLOAD',
        postId,
        creator: creator.creator_username,
        note: privacyLevel === 'SELF_ONLY'
          ? 'Bai dang o che do SELF_ONLY (rieng tu). App chua audit chi dang duoc che do nay.'
          : undefined,
      },
    };
  }

  // -------------------------------------------------------------- video draft

  async _publishVideoDraft(post, media, options) {
    this.assertMediaLimits(media);
    const useUrl = this._shouldPullFromUrl(media, options);
    const sourceInfo = useUrl
      ? { source: 'PULL_FROM_URL', video_url: media.publicUrl }
      : this.buildChunkPlan(media.size ?? 0, options.chunkSizeBytes ?? this.config.chunkSizeBytes);

    // Endpoint nay KHONG nhan post_info: title/privacy do nguoi dung tu dien trong app.
    const init = await this._call('/post/publish/inbox/video/init/', { source_info: sourceInfo }, 'inbox/video/init');
    const publishId = init?.publish_id;
    if (!publishId) {
      throw new PlatformError('TikTok khong tra ve publish_id (inbox)', { platform: this.id, details: init });
    }

    if (!useUrl) {
      await this._uploadChunks(init.upload_url, media, /** @type {any} */ (sourceInfo), options);
    }

    const status = await this._waitForStatus(publishId, options, {
      terminal: [PublishStatus.SEND_TO_USER_INBOX, PublishStatus.PUBLISH_COMPLETE],
    });

    if (post.title || post.description || post.hashtags.length > 0) {
      this.logger.warn(
        'Che do draft/inbox khong nhan title/caption - nguoi dung phai tu nhap trong app TikTok',
      );
    }

    return {
      platform: this.id,
      ok: true,
      id: publishId,
      url: undefined,
      status: 'draft',
      raw: { init, status: status?.raw },
      meta: {
        kind: 'video-draft',
        publishId,
        note: 'Video da vao inbox TikTok cua creator. Creator phai mo thong bao trong app TikTok de hoan tat dang bai.',
      },
    };
  }

  // -------------------------------------------------------------------- photo

  async _publishPhotos(post, options, { draft }) {
    const images = post.images.slice(0, LIMITS.maxPhotos);
    if (images.length === 0) {
      throw new UnsupportedError('Khong co anh hop le de dang len TikTok', { platform: this.id });
    }
    if (post.images.length > LIMITS.maxPhotos) {
      this.logger.warn(`TikTok toi da ${LIMITS.maxPhotos} anh moi bai`, {
        skipped: post.images.length - LIMITS.maxPhotos,
      });
    }
    for (const m of images) this._assertPhoto(m);

    // Anh CHI ho tro PULL_FROM_URL -> file local phai duoc dua len URL cong khai truoc.
    const urls = [];
    for (const media of images) {
      urls.push(await this.ensurePublicUrl(media, { keyHint: post.title }));
    }

    // Anh dung post_info.description (4000 rune), khac video dung title (2200 rune).
    const caption = this.buildCaption(post, {
      maxCaptionLength: LIMITS.photoDescriptionRunes,
      ...options,
      includeTitle: false,
    });
    const title = clipRunes(String(options.title ?? post.title ?? '').trim(), LIMITS.photoTitleRunes);
    const description = clipRunes(caption.text, LIMITS.photoDescriptionRunes);

    /** @type {Record<string, any>} */
    const postInfo = { title: title || undefined, description: description || undefined };

    let privacyLevel;
    if (!draft) {
      const creator = await this.getCreatorInfo();
      privacyLevel = this._resolvePrivacyLevel(creator, options);
      postInfo.privacy_level = privacyLevel;
      postInfo.disable_comment = Boolean(options.disableComment ?? this.config.disableComment ?? creator.comment_disabled ?? false);
      postInfo.auto_add_music = Boolean(options.autoAddMusic ?? this.config.autoAddMusic ?? false);
    }
    // Docs danh dau 2 field nay la Required -> luon gui (false neu khong dung).
    const brandContent = Boolean(options.brandContentToggle ?? this.config.brandContentToggle ?? false);
    const brandOrganic = Boolean(options.brandOrganicToggle ?? this.config.brandOrganicToggle ?? false);
    // Giong video: noi dung co tai tro khong duoc o che do rieng tu.
    if (brandContent && privacyLevel === 'SELF_ONLY') {
      throw new ValidationError(
        '[tiktok] brand_content_toggle khong dung duoc voi privacy_level=SELF_ONLY '
        + '(noi dung thuong mai phai o che do public hoac friends)',
        { platform: this.id },
      );
    }
    postInfo.brand_content_toggle = brandContent;
    postInfo.brand_organic_toggle = brandOrganic;

    const coverIndex = clampInt(options.photoCoverIndex ?? 0, 0, urls.length - 1);
    const body = {
      post_info: postInfo,
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: coverIndex, // Required theo docs
        photo_images: urls,
      },
      post_mode: draft ? 'MEDIA_UPLOAD' : 'DIRECT_POST',
      media_type: 'PHOTO',
    };
    if (options.isAigc !== undefined || this.config.isAigc !== undefined) {
      body.is_aigc = Boolean(options.isAigc ?? this.config.isAigc);
    }

    const init = await this._call('/post/publish/content/init/', body, 'content/init');
    const publishId = init?.publish_id;
    if (!publishId) {
      throw new PlatformError('TikTok khong tra ve publish_id (photo)', { platform: this.id, details: init });
    }

    const status = await this._waitForStatus(publishId, options, {
      terminal: draft
        ? [PublishStatus.SEND_TO_USER_INBOX, PublishStatus.PUBLISH_COMPLETE]
        : [PublishStatus.PUBLISH_COMPLETE],
    });

    return {
      platform: this.id,
      ok: true,
      id: status?.postId ?? publishId,
      url: undefined,
      status: draft ? 'draft' : (status?.timedOut ? 'processing' : 'published'),
      raw: { init, status: status?.raw },
      meta: {
        kind: 'photo',
        publishId,
        photos: urls.length,
        coverIndex,
        privacyLevel,
        postId: status?.postId,
      },
    };
  }

  _assertPhoto(media) {
    this.assertMediaLimits(media);
    if (media.mime && !['image/jpeg', 'image/webp'].includes(media.mime)) {
      throw new UnsupportedError(
        `[tiktok] chi nhan anh JPEG hoac WebP (nhan ${media.mime}). PNG/GIF phai chuyen doi truoc.`,
        { platform: this.id, details: { mime: media.mime } },
      );
    }
    if (media.size && media.size > LIMITS.maxPhotoBytes) {
      throw new UnsupportedError(
        `[tiktok] moi anh toi da 20MB (file: ${Math.round(media.size / 1e6)}MB)`,
        { platform: this.id },
      );
    }
  }

  // --------------------------------------------------------------- chunk upload

  /**
   * Tinh ke hoach chia chunk theo dung quy tac cua TikTok.
   *
   * - video < 5MB  -> 1 chunk = ca file
   * - video > 64MB -> phai chia nhieu chunk
   * - total_chunk_count = floor(size / chunk_size) -> chunk CUOI TO HON chunk_size
   *
   * @param {number} size
   * @param {number} [preferredChunkSize]
   * @returns {{source: 'FILE_UPLOAD', video_size: number, chunk_size: number, total_chunk_count: number}}
   */
  buildChunkPlan(size, preferredChunkSize) {
    if (!size || size <= 0) {
      throw new UnsupportedError('Khong xac dinh duoc dung luong video', { platform: this.id });
    }
    if (size > LIMITS.maxVideoBytes) {
      throw new UnsupportedError(
        `[tiktok] video toi da 4GB (file: ${Math.round(size / 1e6)}MB)`,
        { platform: this.id },
      );
    }

    // File nho hon chunk toi thieu -> upload nguyen file.
    if (size < LIMITS.minChunkBytes) {
      return { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 };
    }

    let chunkSize = Number(preferredChunkSize) || 10 * 1024 * 1024;
    chunkSize = Math.min(LIMITS.maxChunkBytes, Math.max(LIMITS.minChunkBytes, Math.floor(chunkSize)));

    // File <= 64MB co the gui 1 lan (chunk_size = size van hop le vi <= 64MB).
    if (size <= LIMITS.maxChunkBytes && (preferredChunkSize === undefined || chunkSize >= size)) {
      return { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 };
    }

    // Docs: "Videos with a total size greater than 64 MB must be uploaded in multiple chunks"
    // -> voi file > 64MB, chunk_size phai <= size/2 de floor(size/chunk_size) >= 2.
    if (size > LIMITS.maxChunkBytes) {
      chunkSize = Math.min(chunkSize, Math.floor(size / 2));
      chunkSize = Math.max(LIMITS.minChunkBytes, chunkSize);
    }

    let count = Math.floor(size / chunkSize);
    // Toi da 1000 chunk -> tang chunk_size neu can.
    if (count > LIMITS.maxChunks) {
      chunkSize = Math.min(LIMITS.maxChunkBytes, Math.ceil(size / LIMITS.maxChunks));
      count = Math.floor(size / chunkSize);
    }
    count = Math.max(1, count);

    // Chunk cuoi = chunk_size + (size mod chunk_size) < 2 * chunk_size <= 128MB,
    // nen voi chunk_size <= 64MB thi khong bao gio vuot tran 128MB cua chunk cuoi.
    return { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count };
  }

  /**
   * Day tung chunk len upload_url (tuan tu). Khong gui Authorization o day.
   * @param {string} uploadUrl
   * @param {import('../core/media.js').Media} media
   * @param {{video_size: number, chunk_size: number, total_chunk_count: number}} plan
   * @param {Record<string, any>} options
   */
  async _uploadChunks(uploadUrl, media, plan, options) {
    if (!uploadUrl) {
      throw new PlatformError('TikTok khong tra ve upload_url cho FILE_UPLOAD', { platform: this.id });
    }
    const { video_size: total, chunk_size: chunkSize, total_chunk_count: count } = plan;
    const contentType = media.mime && ['video/mp4', 'video/quicktime', 'video/webm'].includes(media.mime)
      ? media.mime
      : 'video/mp4';

    const maxRetries = options.uploadRetries ?? this.config.uploadRetries ?? 3;

    for (let i = 0; i < count; i += 1) {
      const start = i * chunkSize;
      // Chunk cuoi cung nhan HET phan con lai (co the lon hon chunk_size).
      const end = i === count - 1 ? total - 1 : start + chunkSize - 1;
      const chunk = await media.readRange(start, end);

      // Phai tu retry o day: response dung HTTP STATUS de bao trang thai (201/206)
      // nen khong the de tang HTTP tu nem loi (throwOnError: false).
      let attempt = 0;
      for (;;) {
        attempt += 1;
        /** @type {import('../core/http.js').HttpResponse | undefined} */
        let res;
        /** @type {Error | undefined} */
        let netErr;
        try {
          res = await this.http.requestOnce(uploadUrl, {
            method: 'PUT',
            headers: {
              'content-type': contentType,
              'content-length': String(chunk.byteLength),
              'content-range': `bytes ${start}-${end}/${total}`,
            },
            body: chunk,
            parse: 'text',
            platform: this.id,
            signal: this.signal,
            timeoutMs: options.uploadTimeoutMs ?? this.config.uploadTimeoutMs ?? 20 * 60_000,
            throwOnError: false,
          });
        } catch (err) {
          netErr = /** @type {Error} */ (err);
        }

        if (res && (res.status === 201 || res.status === 206)) {
          this.logger.debug('chunk da len', {
            chunk: `${i + 1}/${count}`,
            bytes: chunk.byteLength,
            progress: `${Math.round(((end + 1) / total) * 100)}%`,
          });
          break;
        }

        const err = netErr ?? mapChunkUploadError(res.status, res.text, {
          chunkIndex: i, count, start, end, total,
        });
        const retryable = /** @type {any} */ (err).retryable === true;
        if (!retryable || attempt > maxRetries) throw err;

        const delayMs = Math.min(30_000, 1000 * 2 ** (attempt - 1));
        this.logger.warn('chunk loi tam thoi, thu lai', {
          chunk: `${i + 1}/${count}`,
          attempt,
          delayMs,
          error: err.message,
        });
        await sleep(delayMs, this.signal);
      }
    }
    this.logger.info('da upload xong toan bo chunk', { chunks: count, bytes: total });
  }

  // ------------------------------------------------------------ trang thai bai

  /**
   * Poll status/fetch cho den khi den trang thai ket thuc.
   * @param {string} publishId
   * @param {Record<string, any>} options
   * @param {{terminal: string[]}} cfg
   */
  async _waitForStatus(publishId, options, cfg) {
    if (options.waitForProcessing === false || this.config.waitForProcessing === false) {
      return undefined;
    }
    const timeoutMs = options.processingTimeoutMs ?? this.config.processingTimeoutMs ?? 10 * 60_000;

    const result = await this.poll(
      async () => {
        const { data, postIds } = await this._callStatus(publishId);
        const status = String(data?.status ?? '');
        if (cfg.terminal.includes(status)) {
          return { done: true, value: { status, raw: data, postId: postIds[0] } };
        }
        if (status === PublishStatus.FAILED) {
          return { done: false, failed: true, reason: data?.fail_reason ?? 'unknown' };
        }
        return { done: false, value: { status, raw: data } };
      },
      // status/fetch gioi han 30 req/phut -> giu nhip >= 2s.
      { timeoutMs, intervalMs: 3000, maxIntervalMs: 20_000, backoffFactor: 1.3 },
    );

    if (result.failed) {
      const reason = String(result.reason ?? '');
      throw new ProcessingError(`TikTok dang bai that bai: ${reason}`, {
        platform: this.id,
        retryable: RETRYABLE_FAIL_REASONS.has(reason),
        details: { publishId, failReason: reason },
        hint: FAIL_REASON_HINTS[reason],
      });
    }
    if (result.timedOut) {
      this.logger.warn('het thoi gian cho TikTok xu ly - bai co the van dang duoc xu ly', { publishId });
      return { timedOut: true, raw: result.value?.raw };
    }
    return result.value;
  }

  /**
   * Goi status/fetch va lay postId duoi dang STRING
   * (publicaly_available_post_id la list<int64> -> JSON.parse lam mat do chinh xac).
   * @param {string} publishId
   */
  async _callStatus(publishId) {
    const res = await this._rawCall('/post/publish/status/fetch/', { publish_id: publishId }, 'status/fetch');
    // Thanh cong duoc xet bang error.code === 'ok', KHONG phai HTTP status.
    const err = res.data?.error;
    if (err?.code && err.code !== 'ok') {
      throw mapTikTokError({
        status: res.status,
        code: err.code,
        message: err.message,
        logId: err.log_id ?? err.logid,
        op: 'status/fetch',
      });
    }
    const postIds = extractBigIntList(res.text, 'publicaly_available_post_id');
    return { data: res.data?.data, postIds };
  }

  // -------------------------------------------------------------- post_info

  /**
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   * @param {string} privacyLevel
   * @param {Record<string, any>} creator
   */
  _buildVideoPostInfo(post, options, privacyLevel, creator) {
    // Video: caption CHINH LA post_info.title (2200 UTF-16 runes).
    const caption = this.buildCaption(post, options);
    const title = clipRunes(caption.text, LIMITS.videoTitleRunes);

    /** @type {Record<string, any>} */
    const info = {
      title: title || undefined,
      privacy_level: privacyLevel,
      // Neu creator da tat san o cap tai khoan thi phai ton trong.
      disable_comment: Boolean(options.disableComment ?? this.config.disableComment ?? creator.comment_disabled ?? false),
      disable_duet: Boolean(options.disableDuet ?? this.config.disableDuet ?? creator.duet_disabled ?? false),
      disable_stitch: Boolean(options.disableStitch ?? this.config.disableStitch ?? creator.stitch_disabled ?? false),
    };

    const coverMs = options.videoCoverTimestampMs ?? this.config.videoCoverTimestampMs;
    if (coverMs !== undefined) info.video_cover_timestamp_ms = Math.max(0, Math.floor(Number(coverMs) || 0));

    const brandContent = Boolean(options.brandContentToggle ?? this.config.brandContentToggle ?? false);
    const brandOrganic = Boolean(options.brandOrganicToggle ?? this.config.brandOrganicToggle ?? false);
    if (brandContent && privacyLevel === 'SELF_ONLY') {
      throw new ValidationError(
        '[tiktok] brand_content_toggle khong dung duoc voi privacy_level=SELF_ONLY '
        + '(noi dung thuong mai phai o che do public hoac friends)',
        { platform: this.id },
      );
    }
    info.brand_content_toggle = brandContent;
    info.brand_organic_toggle = brandOrganic;
    if (options.isAigc !== undefined || this.config.isAigc !== undefined) {
      info.is_aigc = Boolean(options.isAigc ?? this.config.isAigc);
    }
    return info;
  }

  /**
   * Chon privacy_level hop le voi tai khoan (bat buoc nam trong privacy_level_options).
   * @param {Record<string, any>} creator
   * @param {Record<string, any>} options
   * @returns {string}
   */
  _resolvePrivacyLevel(creator, options) {
    const allowed = Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options : [];
    const wanted = String(options.privacyLevel ?? this.config.privacyLevel ?? 'SELF_ONLY').toUpperCase();

    if (allowed.length === 0) {
      this.logger.warn('creator_info khong tra ve privacy_level_options - dung gia tri cau hinh', { wanted });
      return wanted;
    }
    if (allowed.includes(wanted)) return wanted;

    // Fallback an toan: SELF_ONLY luon co trong danh sach.
    const fallback = allowed.includes('SELF_ONLY') ? 'SELF_ONLY' : allowed[0];
    this.logger.warn('privacy_level yeu cau khong kha dung cho tai khoan nay - dung gia tri khac', {
      wanted,
      allowed,
      used: fallback,
    });
    return fallback;
  }

  /** Kiem tra video so voi gioi han rieng cua creator. */
  _assertVideoAgainstCreator(media, creator) {
    const maxSec = Number(creator.max_video_post_duration_sec);
    if (Number.isFinite(maxSec) && maxSec > 0 && media.durationSec && media.durationSec > maxSec) {
      throw new UnsupportedError(
        `[tiktok] tai khoan nay chi dang duoc video toi da ${maxSec}s (video: ${Math.round(media.durationSec)}s)`,
        { platform: this.id, details: { maxSec, durationSec: media.durationSec } },
      );
    }
    if (media.width && media.height) {
      const min = Math.min(media.width, media.height);
      const max = Math.max(media.width, media.height);
      if (min < LIMITS.minDimension || max > LIMITS.maxDimension) {
        this.logger.warn('kich thuoc video ngoai khoang TikTok ho tro (360-4096px)', {
          width: media.width,
          height: media.height,
        });
      }
    }
    return true;
  }

  /** Video: uu tien FILE_UPLOAD (khong can xac minh domain). */
  _shouldPullFromUrl(media, options) {
    const explicit = options.pullFromUrl ?? this.config.pullFromUrl;
    if (explicit !== undefined) {
      const use = Boolean(explicit) && Boolean(media.publicUrl);
      if (!use && media.isRemote) {
        // FILE_UPLOAD tren media tu xa phai doc theo HTTP Range; server nao khong
        // ho tro Range se lam chunk sai (Media.readRange se bao loi ro rang).
        this.logger.warn('dang doc video tu URL theo tung chunk (HTTP Range)', {
          hint: 'Neu server khong ho tro Range, hay tai file ve dia truoc hoac bat pullFromUrl.',
        });
      }
      return use;
    }
    // Media da la URL cong khai san -> dung luon (nhanh hon), voi dieu kien domain da xac minh.
    return media.isRemote && Boolean(media.url);
  }

  // -------------------------------------------------------------------- HTTP

  /**
   * Goi API va kiem tra `error.code === 'ok'`.
   * @param {string} path
   * @param {Record<string, any>} body
   * @param {string} op
   */
  async _call(path, body, op) {
    const res = await this._rawCall(path, body, op);
    const err = res.data?.error;
    const code = err?.code;
    if (code && code !== 'ok') {
      throw mapTikTokError({
        status: res.status,
        code,
        message: err?.message,
        logId: err?.log_id ?? err?.logid,
        op,
      });
    }
    if (!res.ok) {
      throw mapTikTokError({ status: res.status, code: 'http_error', message: res.text?.slice(0, 300), op });
    }
    return res.data?.data;
  }

  /**
   * @param {string} path
   * @param {Record<string, any>} body
   * @param {string} op
   */
  async _rawCall(path, body, op, opts = {}) {
    const token = await this.tokens.getAccessToken({ forceRefresh: Boolean(opts.forceRefresh) });
    const res = await this.http.request(`${API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body ?? {}),
      platform: this.id,
      signal: this.signal,
      throwOnError: false,
      retry: {
        retries: 2,
        isRetryable: (e) => /** @type {any} */ (e).retryable === true,
      },
      mapError: (ctx) => {
        const err = ctx.data?.error;
        return mapTikTokError({
          status: ctx.status,
          code: err?.code ?? 'http_error',
          message: err?.message ?? String(ctx.text ?? '').slice(0, 300),
          logId: err?.log_id ?? err?.logid,
          op,
        });
      },
    });

    // access_token_invalid: refresh MOT lan roi goi lai (docs cho phep dung 1 lan).
    // Access token cua TikTok chi song 24h nen truong hop nay rat thuong gap.
    if (res.data?.error?.code === 'access_token_invalid' && !opts.forceRefresh && this.config.refreshToken) {
      this.logger.warn('access token het han - refresh roi goi lai', { op });
      return this._rawCall(path, body, op, { forceRefresh: true });
    }
    return res;
  }

  /** Doi refresh_token thanh access_token (refresh_token CO THE doi -> phai luu lai). */
  async _refreshAccessToken() {
    // Uu tien refresh token moi nhat da luu (vi TikTok xoay token).
    const stored = await this.tokens?.getStoredRefreshToken?.();
    const refreshToken = stored ?? this.config.refreshToken;

    if (!refreshToken) {
      if (this.config.accessToken) {
        // Khong co refresh token -> dung access token nguoi dung truyen vao (song 24h).
        return { accessToken: this.config.accessToken, expiresInSec: 86_400 };
      }
      throw new AuthError('[tiktok] thieu refreshToken', { platform: this.id, retryable: false });
    }

    const res = await this.http.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'cache-control': 'no-cache' },
      form: {
        client_key: this.config.clientKey,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
      platform: this.id,
      signal: this.signal,
      throwOnError: false,
      retry: { retries: 2 },
    });

    const data = res.data;
    // Endpoint OAuth co shape KHAC: {error: 'string', error_description, log_id}
    if (!res.ok || !data?.access_token) {
      throw new AuthError(
        `[tiktok] khong lay duoc access token: ${data?.error ?? res.status} ${data?.error_description ?? ''}`,
        {
          platform: this.id,
          httpStatus: res.status,
          details: data,
          retryable: res.status >= 500,
          hint: 'refresh_token song 365 ngay va XOAY moi lan refresh. '
            + 'Neu module khong luu duoc token moi (dung MemoryTokenStore) thi lan sau se mat quyen - '
            + 'hay cau hinh FileTokenStore (WAM_TOKEN_STORE).',
        },
      );
    }

    if (data.refresh_token && data.refresh_token !== refreshToken) {
      this.logger.info('TikTok da xoay refresh_token - da luu token moi');
    }
    return {
      accessToken: data.access_token,
      expiresInSec: Number(data.expires_in) || 86_400,
      // Luu refresh token MOI de lan sau dung.
      refreshToken: data.refresh_token ?? refreshToken,
    };
  }
}

// ------------------------------------------------------------------ helpers

const FAIL_REASON_HINTS = {
  file_format_check_failed: 'Dinh dang khong ho tro. Video: MP4/WebM/MOV + H.264. Anh: JPEG/WebP.',
  duration_check_failed: 'Do dai video vuot gioi han cua creator (xem max_video_post_duration_sec).',
  frame_rate_check_failed: 'FPS phai trong khoang 23-60.',
  picture_size_check_failed: 'Kich thuoc anh khong hop le (toi da 1080p).',
  video_pull_failed: 'TikTok khong tai duoc video tu URL. URL phai https, khong redirect, song it nhat 1 gio.',
  photo_pull_failed: 'TikTok khong tai duoc anh tu URL. URL phai https, khong redirect.',
  spam_risk_text: 'Caption bi coi la spam - giam hashtag/link, viet lai noi dung.',
  spam_risk_too_many_posts: 'Creator da dang qua nhieu trong 24h (~15 bai/ngay, tinh chung moi ung dung).',
  spam_risk_user_banned_from_posting: 'Tai khoan dang bi cam dang bai.',
  auth_removed: 'Creator da thu hoi quyen truy cap - phai xin quyen lai.',
  internal: 'Loi tam thoi cua TikTok - thu lai sau.',
};

/** Dem do dai theo UTF-16 code unit (dung nhu TikTok tinh "runes"). */
export function runeLength(str) {
  return String(str ?? '').length;
}

/** Cat chuoi theo UTF-16 code unit, khong lam vo surrogate pair. */
export function clipRunes(str, max) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  // Khong de dut doi surrogate pair o cuoi.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v) || 0);
  return Math.min(max, Math.max(min, n));
}

/**
 * Lay list<int64> tu JSON THO de khong mat do chinh xac (JS Number chi an toan den 2^53).
 * @param {string} text
 * @param {string} field
 * @returns {string[]}
 */
export function extractBigIntList(text, field) {
  if (!text) return [];
  const re = new RegExp(`"${field}"\\s*:\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(text);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => /^\d+$/.test(s));
}

/**
 * Loi khi PUT chunk. Docs: 201 ok, 206 tiep tuc, 400 sai header/byte,
 * 403 upload_url het han, 404 task khong ton tai, 416 sai Content-Range, 5xx thu lai.
 * @param {number} status
 * @param {string} text
 * @param {object} ctx
 */
export function mapChunkUploadError(status, text, ctx) {
  const base = {
    platform: 'tiktok',
    httpStatus: status,
    details: { ...ctx, body: String(text ?? '').slice(0, 300) },
  };
  if (status === 400) {
    return new PlatformError(`[tiktok] chunk bi tu choi (400): header hoac so byte khong dung`, {
      ...base,
      retryable: false,
      hint: 'Kiem tra Content-Range/Content-Length. Chunk cuoi phai chua HET phan con lai (lon hon chunk_size).',
    });
  }
  if (status === 416) {
    return new PlatformError(`[tiktok] Content-Range khong khop (416)`, {
      ...base,
      retryable: false,
      hint: 'Byte offset sai. total_chunk_count = floor(video_size / chunk_size), offset ket thuc la INCLUSIVE.',
    });
  }
  if (status === 403) {
    return new PlatformError(`[tiktok] upload_url het han hoac khong hop le (403)`, {
      ...base,
      retryable: false,
      hint: 'upload_url chi song 1 gio. Phai goi init lai de lay URL moi.',
    });
  }
  if (status === 404) {
    return new PlatformError(`[tiktok] upload task khong ton tai (404)`, {
      ...base,
      retryable: false,
      hint: 'Phai goi init lai.',
    });
  }
  if (status >= 500) {
    return new PlatformError(`[tiktok] loi server khi upload chunk (${status})`, { ...base, retryable: true });
  }
  return new PlatformError(`[tiktok] upload chunk that bai (HTTP ${status})`, { ...base, retryable: false });
}

/**
 * Chuyen error.code cua TikTok thanh loi cua module.
 * @param {{status: number, code: string, message?: string, logId?: string, op?: string}} ctx
 * @returns {Error}
 */
export function mapTikTokError(ctx) {
  const { status, code, message = '', logId, op = '' } = ctx;
  const base = {
    platform: 'tiktok',
    httpStatus: status,
    platformCode: code,
    details: { op, code, log_id: logId, message },
  };

  switch (code) {
    case 'access_token_invalid':
      return new AuthError(`[tiktok] access token khong hop le: ${message}`, {
        ...base,
        retryable: false,
        hint: 'Module se tu refresh mot lan roi goi lai. Neu van loi thi refresh_token da het hieu luc -> xin quyen lai.',
      });
    case 'scope_not_authorized':
      return new AuthError(`[tiktok] token thieu scope: ${message}`, {
        ...base,
        retryable: false,
        hint: 'Direct post can scope video.publish; dang draft can video.upload. Xin lai quyen voi scope dung.',
      });
    case 'unaudited_client_can_only_post_to_private_accounts':
      return new PlatformError(`[tiktok] app chua duoc audit: ${message}`, {
        ...base,
        retryable: false,
        hint: 'App chua audit chi dang duoc privacy_level=SELF_ONLY (va tai khoan phai o che do private). '
          + 'Dat privacyLevel: "SELF_ONLY", hoac dung postMode: "MEDIA_UPLOAD" (draft) de creator tu dang public.',
      });
    case 'privacy_level_option_mismatch':
      return new PlatformError(`[tiktok] privacy_level khong hop le voi tai khoan: ${message}`, {
        ...base,
        retryable: false,
        hint: 'Gia tri phai nam trong privacy_level_options tra ve tu creator_info/query.',
      });
    case 'url_ownership_unverified':
      return new PlatformError(`[tiktok] domain cua URL chua duoc xac minh: ${message}`, {
        ...base,
        retryable: false,
        hint: 'PULL_FROM_URL yeu cau domain/URL prefix da xac minh trong phan URL properties cua app. '
          + 'Voi VIDEO co the dung FILE_UPLOAD de khong can xac minh; voi ANH thi buoc phai xac minh domain.',
      });
    case 'spam_risk_too_many_posts':
      return new RateLimitError(`[tiktok] creator da dang qua nhieu bai trong 24h: ${message}`, {
        ...base,
        retryable: false,
        retryAfterMs: 60 * 60_000,
        hint: 'Gioi han ~15 bai/ngay/creator, tinh CHUNG cho moi ung dung.',
      });
    case 'spam_risk_too_many_pending_share':
      return new RateLimitError(`[tiktok] qua nhieu draft dang cho (toi da 5/24h): ${message}`, {
        ...base,
        retryable: false,
        retryAfterMs: 60 * 60_000,
      });
    case 'spam_risk_user_banned_from_posting':
      return new PlatformError(`[tiktok] tai khoan bi cam dang bai: ${message}`, {
        ...base,
        retryable: false,
        hint: 'Ngung dang cho tai khoan nay va thong bao cho nguoi dung.',
      });
    case 'reached_active_user_cap':
      return new RateLimitError(`[tiktok] het quota so nguoi dung dang bai trong 24h: ${message}`, {
        ...base,
        retryable: false,
        retryAfterMs: 60 * 60_000,
        hint: 'App chua audit chi cho 5 nguoi dung dang trong 24h.',
      });
    case 'rate_limit_exceeded':
      return new RateLimitError(`[tiktok] vuot gioi han tan suat: ${message}`, {
        ...base,
        retryable: true,
        hint: 'init: 6 req/phut, creator_info: 20 req/phut, status: 30 req/phut (tinh theo access_token).',
      });
    case 'invalid_param':
      return new PlatformError(`[tiktok] tham so khong hop le: ${message}`, { ...base, retryable: false });
    case 'invalid_publish_id':
      return new PlatformError(`[tiktok] publish_id khong ton tai: ${message}`, { ...base, retryable: false });
    case 'token_not_authorized_for_specified_publish_id':
      return new PlatformError(`[tiktok] token khong khop voi publish_id: ${message}`, {
        ...base,
        retryable: false,
        hint: 'Dang poll bang token cua tai khoan khac voi tai khoan da tao bai.',
      });
    case 'app_version_check_failed':
      return new PlatformError(`[tiktok] app TikTok cua creator qua cu: ${message}`, {
        ...base,
        retryable: false,
        hint: 'Che do MEDIA_UPLOAD cho anh yeu cau app TikTok >= 31.8.',
      });
    default:
      break;
  }

  if (status === 429) {
    return new RateLimitError(`[tiktok] 429 ${code}: ${message}`, { ...base, retryable: true });
  }
  if (status >= 500 || code === 'internal_error') {
    return new PlatformError(`[tiktok] loi server (${code}): ${message}`, { ...base, retryable: true });
  }
  return new PlatformError(`[tiktok] loi ${code}: ${message}`, {
    ...base,
    retryable: RETRYABLE_ERROR_CODES.has(code),
  });
}
