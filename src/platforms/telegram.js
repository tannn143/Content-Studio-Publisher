/**
 * Telegram Bot API adapter.
 *
 * Ho tro: text-only, 1 anh, 1 video, album (2-10 media), gui nhieu chat cung luc.
 *
 * Yeu cau: bot phai la ADMIN cua channel/group moi dang duoc.
 * Lay bot token tu @BotFather; chat_id co the la '@tenchannel' hoac so (-100...).
 *
 * Docs: https://core.telegram.org/bots/api
 */

import { BasePlatform } from './base.js';
import {
  AuthError,
  PlatformError,
  RateLimitError,
  UnsupportedError,
} from '../core/errors.js';
import { escapeHtml, escapeMarkdownV2, formatHashtags, truncate } from '../core/text.js';

/** Gioi han cua Bot API. */
const LIMITS = {
  caption: 1024,
  text: 4096,
  albumMin: 2,
  albumMax: 10,
  uploadPhotoBytes: 10 * 1024 * 1024,   // multipart
  uploadFileBytes: 50 * 1024 * 1024,    // multipart (video/document)
  urlPhotoBytes: 5 * 1024 * 1024,       // Telegram tu tai tu URL
  urlFileBytes: 20 * 1024 * 1024,
};

export class TelegramPlatform extends BasePlatform {
  static id = 'telegram';

  static displayName = 'Telegram';

  /** @type {import('./base.js').PlatformCapabilities} */
  static capabilities = {
    text: true,
    image: true,
    video: true,
    album: true,
    requiresPublicUrl: false,
    maxMediaCount: LIMITS.albumMax,
    supportsSchedule: false,
    limits: { title: Infinity, caption: LIMITS.caption, hashtags: Infinity },
    maxImageBytes: LIMITS.uploadPhotoBytes,
    maxVideoBytes: LIMITS.uploadFileBytes,
  };

  validateConfig() {
    this.requireConfig(['botToken', 'chatId'], {
      hint: 'botToken lay tu @BotFather; chatId la @tenchannel hoac so id (-100...).',
    });
    return true;
  }

  get apiBase() {
    const base = this.config.apiBaseUrl ?? 'https://api.telegram.org';
    return `${base.replace(/\/+$/, '')}/bot${this.config.botToken}`;
  }

  /** Danh sach chat can gui. */
  get chatIds() {
    const raw = this.config.chatId ?? this.config.chatIds;
    return (Array.isArray(raw) ? raw : [raw]).filter((x) => x !== undefined && x !== null && x !== '').map(String);
  }

  /**
   * Kiem tra: bot ton tai + la ADMIN co quyen dang bai o TUNG chat.
   * Bot khong phai admin la nguyen nhan loi 403 pho bien nhat.
   */
  async verifyCredentials() {
    try {
      const me = await this._call('getMe', {});
      /** @type {Record<string, any>} */
      const chats = {};
      for (const chatId of this.chatIds) {
        try {
          const chat = await this._call('getChat', { chat_id: chatId });
          const member = await this._call('getChatMember', { chat_id: chatId, user_id: me.id });
          const isChannel = chat?.type === 'channel';
          const canPost = member?.status === 'creator'
            || (member?.status === 'administrator' && (!isChannel || member?.can_post_messages === true));
          chats[chatId] = {
            id: chat?.id,
            title: chat?.title,
            type: chat?.type,
            botStatus: member?.status,
            canPost,
          };
          if (!canPost) {
            return {
              ok: false,
              account: { bot: me.username, chats },
              error: new AuthError(
                `Bot chua co quyen dang bai o chat ${chatId} (status: ${member?.status ?? 'unknown'})`,
                {
                  platform: this.id,
                  hint: isChannel
                    ? 'Them bot vao channel lam ADMIN va bat quyen "Post Messages".'
                    : 'Them bot vao group va cap quyen gui tin nhan.',
                },
              ),
            };
          }
        } catch (err) {
          return { ok: false, account: { bot: me.username, chats }, error: /** @type {Error} */ (err) };
        }
      }
      return {
        ok: true,
        account: { id: me.id, username: me.username, name: me.first_name, chats },
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
    const parseMode = options.parseMode ?? this.config.parseMode ?? 'HTML';
    const { caption, overflow } = this._composeCaption(post, options, parseMode);

    /** @type {Array<{chatId: string, messageId: number, url?: string}>} */
    const sent = [];
    /** @type {any[]} */
    const raws = [];

    /** @type {Array<{chatId: string, error: string}>} */
    const failures = [];
    for (const chatId of this.chatIds) {
      try {
        const res = await this._publishToChat(chatId, post, options, { caption, overflow, parseMode });
        sent.push(...res.messages);
        raws.push(res.raw);
      } catch (err) {
        // Da gui thanh cong o chat khac -> khong duoc quen, ghi lai roi bao o cuoi.
        failures.push({ chatId, error: /** @type {Error} */ (err).message });
        this.logger.error('gui that bai o mot chat', { chatId, error: /** @type {Error} */ (err).message });
        if (sent.length === 0 && chatId === this.chatIds[this.chatIds.length - 1]) throw err;
      }
    }
    if (sent.length === 0 && failures.length > 0) {
      throw new PlatformError(
        `[telegram] khong gui duoc tin nao: ${failures.map((f) => `${f.chatId}: ${f.error}`).join('; ')}`,
        { platform: this.id, details: { failures } },
      );
    }

    const first = sent[0];
    return {
      platform: this.id,
      ok: true,
      status: 'published',
      id: first ? String(first.messageId) : undefined,
      url: first?.url,
      raw: raws.length === 1 ? raws[0] : raws,
      meta: { messages: sent, chats: this.chatIds.length },
    };
  }

  /**
   * @param {string} chatId
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   * @param {{caption: string, overflow: string, parseMode: string}} text
   */
  async _publishToChat(chatId, post, options, text) {
    const { caption, overflow, parseMode } = text;
    const common = {
      chat_id: chatId,
      message_thread_id: options.messageThreadId ?? this.config.messageThreadId,
      disable_notification: options.disableNotification ?? this.config.disableNotification,
      protect_content: options.protectContent ?? this.config.protectContent,
    };

    /** @type {Array<{chatId: string, messageId: number, url?: string}>} */
    const messages = [];
    /** @type {any} */
    let raw;

    if (post.media.length === 0) {
      // Bai chi co chu.
      raw = await this._call('sendMessage', {
        ...common,
        text: truncate(caption, LIMITS.text),
        parse_mode: parseMode === 'none' ? undefined : parseMode,
        link_preview_options: options.disableLinkPreview ? { is_disabled: true } : undefined,
      });
      messages.push(this._toMessageRef(chatId, raw));

      // Bai text-only cung co the co phan du (longCaptionMode='split').
      if (overflow) {
        const extra = await this._call('sendMessage', {
          ...common,
          text: truncate(overflow, LIMITS.text),
          parse_mode: parseMode === 'none' ? undefined : parseMode,
          reply_parameters: { message_id: raw?.message_id },
          link_preview_options: { is_disabled: true },
        });
        messages.push(this._toMessageRef(chatId, extra));
      }
      return { messages, raw };
    }

    if (post.media.length === 1) {
      const media = post.media[0];
      raw = await this._sendSingle(chatId, media, { ...common, caption, parseMode, options });
      messages.push(this._toMessageRef(chatId, raw));
    } else {
      // Hai buoc chia: (1) tach document/visual vi Telegram khong cho tron,
      // (2) moi album toi da 10 media.
      const groups = splitAlbumGroups(post.media, options)
        .flatMap((g) => chunkArray(g, LIMITS.albumMax));
      /** @type {any[]} */
      const allRaw = [];
      for (const [gi, group] of groups.entries()) {
        // Caption chi dat o album dau tien.
        const groupCaption = gi === 0 ? caption : '';
        if (group.length === 1) {
          const one = await this._sendSingle(chatId, group[0], {
            ...common,
            caption: groupCaption,
            parseMode,
            options,
          });
          allRaw.push(one);
          messages.push(this._toMessageRef(chatId, one));
          continue;
        }
        const res = await this._sendAlbum(chatId, group, {
          ...common,
          caption: groupCaption,
          parseMode,
          options,
        });
        allRaw.push(res);
        for (const m of Array.isArray(res) ? res : [res]) messages.push(this._toMessageRef(chatId, m));
      }
      raw = allRaw.length === 1 ? allRaw[0] : allRaw;
      if (groups.length > 1) {
        this.logger.info('media duoc chia thanh nhieu album', { groups: groups.length });
      }
    }

    // Caption qua dai -> gui phan con lai thanh tin nhan rieng.
    if (overflow) {
      const extra = await this._call('sendMessage', {
        ...common,
        text: truncate(overflow, LIMITS.text),
        parse_mode: parseMode === 'none' ? undefined : parseMode,
        // reply_to_message_id da deprecated tu Bot API 7.0 -> dung reply_parameters.
        reply_parameters: messages[0]?.messageId ? { message_id: messages[0].messageId } : undefined,
        link_preview_options: { is_disabled: true },
      });
      messages.push(this._toMessageRef(chatId, extra));
    }

    return { messages, raw };
  }

  /**
   * Gui 1 media.
   * @param {string} chatId
   * @param {import('../core/media.js').Media} media
   */
  async _sendSingle(chatId, media, ctx) {
    const { caption, parseMode, options, ...common } = ctx;
    this.assertMediaLimits(media);

    const asDocument = Boolean(options.sendAsDocument ?? this.config.sendAsDocument);
    const isVideo = media.kind === 'video';
    const isAudio = media.kind === 'audio';
    const method = asDocument
      ? 'sendDocument'
      : isVideo
        ? 'sendVideo'
        : isAudio
          ? 'sendAudio'
          : (media.mime === 'image/gif' ? 'sendAnimation' : 'sendPhoto');
    const field = asDocument
      ? 'document'
      : isVideo
        ? 'video'
        : isAudio
          ? 'audio'
          : (method === 'sendAnimation' ? 'animation' : 'photo');

    /** @type {Record<string, any>} */
    const params = {
      ...common,
      caption: caption || undefined,
      parse_mode: caption && parseMode !== 'none' ? parseMode : undefined,
    };
    // sendDocument khong co show_caption_above_media / has_spoiler.
    if (!asDocument) {
      params.show_caption_above_media = options.showCaptionAboveMedia;
      params.has_spoiler = options.hasSpoiler;
    }
    if (asDocument && options.disableContentTypeDetection !== undefined) {
      params.disable_content_type_detection = options.disableContentTypeDetection;
    }
    // sendAnimation khong ho tro supports_streaming.
    if (isVideo && method === 'sendVideo') {
      params.supports_streaming = options.supportsStreaming ?? true;
      if (media.durationSec) params.duration = Math.round(media.durationSec);
      if (media.width) params.width = media.width;
      if (media.height) params.height = media.height;
      if (options.startTimestamp !== undefined) params.start_timestamp = options.startTimestamp;
    }

    // sendDocument qua URL chi ho tro .PDF/.ZIP -> cac dinh dang khac phai upload truc tiep.
    const urlAllowed = method !== 'sendDocument' || /\.(pdf|zip)(\?|$)/i.test(String(media.publicUrl ?? ''));

    // Neu media la URL cong khai -> de Telegram tu tai (nhanh, khong ton bang thong cua ta).
    if (media.publicUrl && !options.forceUpload && urlAllowed) {
      // Gioi han khi Telegram tu tai tu URL chat hon nhieu so voi upload truc tiep.
      const urlMax = method === 'sendPhoto' ? LIMITS.urlPhotoBytes : LIMITS.urlFileBytes;
      if (media.size && media.size > urlMax) {
        if (media.isRemote) {
          this.logger.warn('file co the vuot gioi han khi Telegram tu tai tu URL', {
            size: media.size,
            urlMax,
            hint: 'Anh qua URL toi da 5MB, file khac 20MB. Neu loi, hay tai file ve roi upload truc tiep.',
          });
        } else {
          // File local ma vuot gioi han URL -> upload truc tiep se tot hon.
          this.logger.debug('bo qua duong URL, upload truc tiep vi file lon');
          return this._sendSingleMultipart(media, method, field, params, options);
        }
      }
      return this._call(method, { ...params, [field]: media.publicUrl });
    }

    return this._sendSingleMultipart(media, method, field, params, options);
  }

  /**
   * Upload file local bang multipart.
   * @param {import('../core/media.js').Media} media
   */
  async _sendSingleMultipart(media, method, field, params, options) {
    const maxBytes = method === 'sendPhoto' ? LIMITS.uploadPhotoBytes : LIMITS.uploadFileBytes;
    if (media.size && media.size > maxBytes) {
      throw new UnsupportedError(
        `[telegram] Bot API chi cho upload toi da ${Math.round(maxBytes / 1e6)}MB (file: ${Math.round(media.size / 1e6)}MB). `
        + 'Cach xu ly: dung URL cong khai, hoac chay Local Bot API Server.',
        { platform: this.id, details: { size: media.size, maxBytes } },
      );
    }

    const form = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    form.append(field, await media.toBlob({ maxBytes }), media.filename ?? `media${media.extension}`);

    // Thumbnail CHI hoat dong khi file duoc upload bang multipart (khong dung voi URL/file_id).
    // Ho tro o sendVideo / sendAnimation / sendDocument. Yeu cau: JPEG < 200KB, <= 320x320.
    const thumbInput = options.thumbnail ?? media.thumbnailPath;
    if (thumbInput && method !== 'sendPhoto') {
      const { toMedia } = await import('../core/media.js');
      const thumb = toMedia(thumbInput);
      await thumb.load();
      if (thumb.size && thumb.size > 200 * 1024) {
        this.logger.warn('thumbnail vuot 200KB - Telegram co the tu choi', { size: thumb.size });
      }
      form.append('thumbnail', await thumb.toBlob(), thumb.filename ?? 'thumb.jpg');
    }
    return this._callMultipart(method, form);
  }

  /**
   * Gui album 2-10 media. Caption dat o media dau tien.
   * @param {string} chatId
   * @param {import('../core/media.js').Media[]} medias
   */
  async _sendAlbum(chatId, medias, ctx) {
    const { caption, parseMode, options, ...common } = ctx;
    if (medias.length > LIMITS.albumMax) {
      throw new UnsupportedError(
        `[telegram] sendMediaGroup toi da ${LIMITS.albumMax} media (nhan ${medias.length})`,
        { platform: this.id },
      );
    }
    if (medias.length < LIMITS.albumMin) {
      throw new UnsupportedError(
        `[telegram] sendMediaGroup can toi thieu ${LIMITS.albumMin} media`,
        { platform: this.id },
      );
    }
    for (const m of medias) this.assertMediaLimits(m);

    const form = new FormData();
    /** @type {any[]} */
    const items = [];
    let attachIndex = 0;

    for (const [i, media] of medias.entries()) {
      /** @type {Record<string, any>} */
      const item = {
        // sendMediaGroup KHONG nhan InputMediaAnimation -> GIF phai gui dang document.
        type: albumItemType(media, options),
      };
      // Caption chi dat o phan tu dau tien -> Telegram hien duoi ca album.
      if (i === 0 && caption) {
        item.caption = caption;
        if (parseMode !== 'none') item.parse_mode = parseMode;
        if (options.showCaptionAboveMedia) item.show_caption_above_media = true;
      } else if (media.caption) {
        item.caption = media.caption;
      }
      if (item.type === 'video') {
        item.supports_streaming = options.supportsStreaming ?? true;
        if (media.durationSec) item.duration = Math.round(media.durationSec);
        if (media.width) item.width = media.width;
        if (media.height) item.height = media.height;
      }

      if (media.publicUrl && !options.forceUpload) {
        item.media = media.publicUrl;
      } else {
        // attach:// tro theo TEN PART trong multipart, khong phai theo ten file.
        const name = `file${attachIndex++}`;
        item.media = `attach://${name}`;
        const maxBytes = item.type === 'photo' ? LIMITS.uploadPhotoBytes : LIMITS.uploadFileBytes;
        form.append(name, await media.toBlob({ maxBytes }), media.filename ?? `${name}${media.extension}`);

        // Thumbnail trong album cung phai di kem dang attach:// (chi hoat dong khi upload).
        const thumbInput = media.thumbnailPath ?? (i === 0 ? options.thumbnail : undefined);
        if (thumbInput && item.type !== 'photo') {
          const { toMedia } = await import('../core/media.js');
          const thumb = toMedia(thumbInput);
          await thumb.load();
          const thumbName = `thumb${attachIndex++}`;
          form.append(thumbName, await thumb.toBlob(), thumb.filename ?? 'thumb.jpg');
          item.thumbnail = `attach://${thumbName}`;
        }
      }
      items.push(item);
    }

    for (const [k, v] of Object.entries(common)) {
      if (v === undefined || v === null) continue;
      form.append(k, String(v));
    }
    form.append('media', JSON.stringify(items));
    return this._callMultipart('sendMediaGroup', form);
  }

  /**
   * Dung caption. Neu vuot 1024 ky tu:
   *  - 'truncate' (mac dinh): cat bot
   *  - 'split'   : cat va gui phan con lai thanh tin nhan rieng
   * @param {import('../core/post.js').Post} post
   * @param {Record<string, any>} options
   * @param {string} parseMode
   */
  _composeCaption(post, options, parseMode) {
    const escape = parseMode === 'MarkdownV2'
      ? escapeMarkdownV2
      : parseMode === 'HTML'
        ? escapeHtml
        : (/** @type {string} */ s) => s;

    const boldTitle = options.boldTitle ?? this.config.boldTitle ?? true;
    // Luon escape noi dung nguoi dung TRUOC khi boc the.
    const titleRaw = String(post.title ?? '');
    const title = titleRaw ? (boldTitle
      ? (parseMode === 'HTML' ? `<b>${escapeHtml(titleRaw)}</b>`
        : parseMode === 'MarkdownV2' ? `*${escapeMarkdownV2(titleRaw)}*`
          : titleRaw)
      : escape(titleRaw)) : '';

    const description = post.description ? escape(post.description) : '';
    const link = post.link ? escape(post.link) : '';
    // '#' la ky tu BAT BUOC escape trong MarkdownV2 -> phai escape ca hashtag.
    const tags = parseMode === 'MarkdownV2'
      ? escapeMarkdownV2(formatHashtags(post.hashtags))
      : formatHashtags(post.hashtags);

    const maxLen = post.media.length > 0
      ? (options.maxCaptionLength ?? LIMITS.caption)
      : (options.maxCaptionLength ?? LIMITS.text);

    const full = [title, description, link, tags].filter(Boolean).join('\n\n');
    if (full.length <= maxLen) return { caption: full, overflow: '' };

    const mode = options.longCaptionMode ?? this.config.longCaptionMode ?? 'truncate';
    if (mode === 'split') {
      // Uu tien giu title + hashtag trong caption, day description sang tin nhan sau.
      const head = [title, tags].filter(Boolean).join('\n\n');
      if (head.length <= maxLen) {
        return { caption: head, overflow: [description, link].filter(Boolean).join('\n\n') };
      }
    }

    // Cat chuoi DA CO MARKUP se lam vo the (vd '<b>abc' khong dong the) ->
    // cat phan noi dung tho roi moi boc lai.
    const overhead = full.length - (description.length || 0);
    const room = Math.max(0, maxLen - overhead);
    if (description && room > 12) {
      const shortDesc = truncate(description, room);
      const rebuilt = [title, shortDesc, link, tags].filter(Boolean).join('\n\n');
      if (rebuilt.length <= maxLen) return { caption: rebuilt, overflow: '' };
    }
    // Khong du cho ca title + hashtag -> bo markup de cat an toan.
    const plain = [titleRaw, post.description, post.link, formatHashtags(post.hashtags)]
      .filter(Boolean).join('\n\n');
    return { caption: truncate(escape(plain), maxLen), overflow: '' };
  }

  /** @param {string} chatId @param {any} msg */
  _toMessageRef(chatId, msg) {
    const messageId = msg?.message_id;
    return {
      chatId,
      messageId,
      url: buildMessageUrl(chatId, msg),
    };
  }

  // ------------------------------------------------------------------ HTTP

  /**
   * Goi mot method cua Bot API voi body JSON.
   * @param {string} method
   * @param {Record<string, any>} params
   */
  async _call(method, params) {
    const body = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
    );
    const res = await this.http.request(`${this.apiBase}/${method}`, {
      method: 'POST',
      json: body,
      platform: this.id,
      signal: this.signal,
      // Phai de HTTP layer nem loi de vong retry cua nó xu ly 429/5xx.
      throwOnError: true,
      mapError: (ctx) => mapTelegramError(ctx, method),
    });
    return this._unwrap(res, method);
  }

  /**
   * Goi method voi multipart (upload file).
   * @param {string} method
   * @param {FormData} form
   */
  async _callMultipart(method, form) {
    const res = await this.http.request(`${this.apiBase}/${method}`, {
      method: 'POST',
      formData: form,
      platform: this.id,
      signal: this.signal,
      throwOnError: true,
      timeoutMs: this.config.uploadTimeoutMs ?? 10 * 60_000,
      // Upload lai tu dau rat ton kem -> giam so lan retry.
      retry: { retries: this.config.uploadRetries ?? 1 },
      mapError: (ctx) => mapTelegramError(ctx, method),
    });
    return this._unwrap(res, method);
  }

  /**
   * @param {import('../core/http.js').HttpResponse} res
   * @param {string} method
   */
  _unwrap(res, method) {
    const data = res.data;
    if (!res.ok || data?.ok !== true) {
      throw mapTelegramError(
        { status: res.status, data, text: res.text, res: res.res, url: `${method}` },
        method,
      ) ?? new PlatformError(`[telegram] ${method} that bai`, { platform: 'telegram', details: data });
    }
    return data.result;
  }
}

/**
 * Chuyen loi cua Bot API thanh loi cua module.
 * Shape: {ok: false, error_code: 429, description: '...', parameters: {retry_after: 30}}
 * @param {{status: number, data: any, text: string, res: Response, url: string}} ctx
 * @param {string} [method]
 * @returns {Error | undefined}
 */
export function mapTelegramError(ctx, method = '') {
  const { status, data, text } = ctx;
  const desc = String(data?.description ?? text ?? '').slice(0, 400);
  const code = data?.error_code ?? status;
  const retryAfterSec = data?.parameters?.retry_after;
  const base = {
    platform: 'telegram',
    httpStatus: status,
    platformCode: code,
    details: { method, description: desc, parameters: data?.parameters },
  };

  if (code === 429 || retryAfterSec != null) {
    return new RateLimitError(`[telegram] 429: ${desc}`, {
      ...base,
      retryAfterMs: retryAfterSec != null ? Number(retryAfterSec) * 1000 : undefined,
      hint: 'Telegram gioi han ~30 tin/giay va ~20 tin/phut moi group. Giam tan suat gui.',
    });
  }
  if (code === 401 || /unauthorized/i.test(desc)) {
    return new AuthError(`[telegram] bot token khong hop le: ${desc}`, {
      ...base,
      hint: 'Kiem tra TELEGRAM_BOT_TOKEN.',
    });
  }
  if (code === 403) {
    return new AuthError(`[telegram] bi tu choi: ${desc}`, {
      ...base,
      hint: 'Bot chua duoc them vao channel/group, hoac chua co quyen dang bai (phai la admin).',
    });
  }
  if (code === 400 && data?.parameters?.migrate_to_chat_id) {
    return new PlatformError(
      `[telegram] group da chuyen thanh supergroup, chat_id moi: ${data.parameters.migrate_to_chat_id}`,
      {
        ...base,
        retryable: false,
        hint: `Cap nhat chatId thanh ${data.parameters.migrate_to_chat_id}`,
      },
    );
  }
  if (code === 400) {
    const hint = /chat not found/i.test(desc)
      ? 'chat_id sai. Voi channel public dung @tenchannel; voi channel private dung id dang -100xxxxxxxxxx.'
      : /file is too big|too large/i.test(desc)
        ? 'File vuot gioi han cua Bot API (10MB anh / 50MB file). Dung URL cong khai hoac Local Bot API Server.'
        : /can.t parse entities/i.test(desc)
          ? 'Loi escape parse_mode. Dung parseMode HTML (an toan hon MarkdownV2) hoac parseMode "none".'
          : undefined;
    return new PlatformError(`[telegram] 400: ${desc}`, { ...base, retryable: false, hint });
  }
  if (status >= 500 || code >= 500) {
    return new PlatformError(`[telegram] ${code}: ${desc}`, { ...base, retryable: true });
  }
  if (data?.ok === false) {
    return new PlatformError(`[telegram] ${code}: ${desc}`, { ...base, retryable: false });
  }
  return undefined;
}

/**
 * Chon `type` cho phan tu trong sendMediaGroup.
 * Luu y: InputMediaAnimation KHONG hop le trong album -> GIF gui dang 'document'.
 * @param {import('../core/media.js').Media} media
 * @param {Record<string, any>} [options]
 * @returns {'photo'|'video'|'document'}
 */
export function albumItemType(media, options = {}) {
  if (options.sendAsDocument) return 'document';
  if (media.kind === 'video') return 'video';
  // GIF khong the nam trong album cung anh/video (InputMediaAnimation khong hop le,
  // va document khong tron duoc voi photo/video) -> caller phai tach ra gui rieng.
  if (media.mime === 'image/gif') return 'document';
  return 'photo';
}

/**
 * Telegram khong cho tron 'document' voi 'photo'/'video' trong mot album.
 * Chia danh sach media thanh cac nhom cung "ho" de gui duoc.
 * @param {import('../core/media.js').Media[]} medias
 * @param {Record<string, any>} [options]
 * @returns {import('../core/media.js').Media[][]}
 */
export function splitAlbumGroups(medias, options = {}) {
  /** @type {import('../core/media.js').Media[][]} */
  const groups = [];
  /** @type {string | null} */
  let currentFamily = null;
  for (const media of medias) {
    const type = albumItemType(media, options);
    // photo va video di chung duoc; document phai rieng.
    const family = type === 'document' ? 'document' : 'visual';
    if (family !== currentFamily || groups.length === 0) {
      groups.push([media]);
      currentFamily = family;
    } else {
      groups[groups.length - 1].push(media);
    }
  }
  return groups;
}

/**
 * Chia mang thanh cac nhom co toi da `size` phan tu.
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
export function chunkArray(arr, size) {
  /** @type {T[][]} */
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Tao link xem tin nhan (chi co voi channel/group co username hoac id -100...).
 * @param {string} chatId
 * @param {any} msg
 */
function buildMessageUrl(chatId, msg) {
  const messageId = msg?.message_id;
  if (!messageId) return undefined;
  const username = msg?.chat?.username ?? (chatId.startsWith('@') ? chatId.slice(1) : undefined);
  if (username) return `https://t.me/${username}/${messageId}`;
  const id = String(msg?.chat?.id ?? chatId);
  if (id.startsWith('-100')) return `https://t.me/c/${id.slice(4)}/${messageId}`;
  return undefined;
}
