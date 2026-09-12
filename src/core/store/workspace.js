/**
 * Workspace: toan bo trang thai cua admin (kenh da ket noi, bai dang, media, cau hinh).
 *
 * Mo hinh giong Buffer:
 *  - CHANNEL  = mot tai khoan da ket noi (1 YouTube channel, 1 Facebook Page, 1 IG account,
 *               1 TikTok account, 1 Telegram chat). Mot nen tang co the co NHIEU kenh.
 *  - POST     = mot noi dung + danh sach kenh se dang + thoi diem dang (queue).
 *  - MEDIA    = file da upload len server, dung lai duoc cho nhieu bai.
 */

import path from 'node:path';
import { mkdir, unlink, stat } from 'node:fs/promises';
import { JsonCollection, JsonDocument, newId } from './jsonstore.js';

/**
 * @typedef {object} Channel
 * @property {string} id
 * @property {string} platform      'youtube' | 'facebook' | 'instagram' | 'tiktok' | 'telegram'
 * @property {string} name          Ten hien thi (ten channel/page/account).
 * @property {string} [username]
 * @property {string} [avatar]
 * @property {string} [externalId]  Id tren nen tang.
 * @property {Record<string, any>} config  Cau hinh truyen cho adapter (co chua token).
 * @property {Record<string, any>} [defaults] Tuy chon mac dinh khi dang len kenh nay.
 * @property {boolean} enabled
 * @property {string} connectedAt
 * @property {string} [lastUsedAt]
 * @property {{at: string, message: string, code?: string} | null} [lastError]
 * @property {string} [authProvider] 'google' | 'facebook' | 'tiktok' | 'manual'
 */

/**
 * @typedef {object} PostRecord
 * @property {string} id
 * @property {'draft'|'queued'|'publishing'|'posted'|'partial'|'failed'|'cancelled'} status
 * @property {{title: string, description: string, hashtags: string[], link?: string}} content
 * @property {string[]} mediaIds
 * @property {string[]} channelIds
 * @property {Record<string, Record<string, any>>} [perChannel] Ghi de noi dung/tuy chon theo kenh.
 * @property {string | null} scheduledAt  ISO; null = dang ngay.
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} [publishedAt]
 * @property {number} attempts
 * @property {any} [report]   Ket qua tra ve tu SocialPoster.
 * @property {string} [note]
 */

/**
 * @typedef {object} MediaRecord
 * @property {string} id
 * @property {string} filename
 * @property {string} mime
 * @property {string} kind   'image' | 'video'
 * @property {number} size
 * @property {string} storedPath
 * @property {string} createdAt
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [durationSec]
 */

export const DEFAULT_SETTINGS = {
  timezone: 'Asia/Ho_Chi_Minh',
  /** Khung gio dang mac dinh (kieu Buffer "posting schedule"). */
  postingTimes: ['09:00', '12:30', '19:00'],
  defaultHashtags: [],
  /** Thong tin app OAuth - dung de ket noi kenh. */
  credentials: {
    google: { clientId: '', clientSecret: '', redirectUri: '' },
    facebook: { appId: '', appSecret: '', graphVersion: 'v26.0', redirectUri: '' },
    // TikTok tu choi redirect_uri khong phai https -> hau het setup phai tu dat.
    // audited=false: app moi tao luon chua audit -> chi dang duoc SELF_ONLY.
    tiktok: { clientKey: '', clientSecret: '', redirectUri: '', audited: false },
  },
  /** Cau hinh noi luu media cong khai (Instagram/TikTok anh can URL cong khai). */
  mediaHost: {
    type: 'none', // 'none' | 's3' | 'tunnel'
    s3: { bucket: '', region: 'auto', endpoint: '', accessKeyId: '', secretAccessKey: '', publicBaseUrl: '', forcePathStyle: false, prefix: 'wam/' },
    tunnel: { publicBaseUrl: '', port: 8787 },
  },
  publishing: {
    concurrency: 3,
    retries: 3,
    waitForProcessing: true,
  },
};

export class Workspace {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir='./data'] Thu muc luu du lieu.
   */
  constructor(opts = {}) {
    this.dir = path.resolve(opts.dir ?? process.env.WAM_DATA_DIR ?? './data');
    this.uploadsDir = path.join(this.dir, 'uploads');

    /** @type {JsonCollection<Channel>} */
    this.channels = new JsonCollection(path.join(this.dir, 'channels.json'));
    /** @type {JsonCollection<PostRecord>} */
    this.posts = new JsonCollection(path.join(this.dir, 'posts.json'));
    /** @type {JsonCollection<MediaRecord>} */
    this.media = new JsonCollection(path.join(this.dir, 'media.json'));
    /** @type {JsonDocument<typeof DEFAULT_SETTINGS>} */
    this.settings = new JsonDocument(path.join(this.dir, 'settings.json'), DEFAULT_SETTINGS);
    /** @type {JsonCollection<any>} Nhan vien duoc cap quyen dung he thong. */
    this.users = new JsonCollection(path.join(this.dir, 'users.json'));
    /** @type {JsonCollection<any>} Phien dang nhap (luu hash cua token). */
    this.sessions = new JsonCollection(path.join(this.dir, 'sessions.json'));
    /** @type {JsonCollection<any>} Audit log: ai lam gi, luc nao. */
    this.audit = new JsonCollection(path.join(this.dir, 'audit.json'));
    /** Token store cho access token (dung chung voi adapter). */
    this.tokensPath = path.join(this.dir, 'tokens.json');
  }

  async init() {
    await mkdir(this.uploadsDir, { recursive: true });
    await this.settings.read();
    return this;
  }

  // ------------------------------------------------------------------ channel

  /**
   * Tao/cap nhat mot kenh. Neu da co kenh cung platform + externalId thi cap nhat.
   * @param {Partial<Channel> & {platform: string, name: string, config: Record<string, any>}} draft
   * @returns {Promise<Channel>}
   */
  async saveChannel(draft) {
    const existing = draft.id
      ? await this.channels.get(draft.id)
      : (draft.externalId
        ? (await this.channels.find((c) => c.platform === draft.platform && c.externalId === draft.externalId))[0]
        : undefined);

    const now = new Date().toISOString();
    /** @type {Channel} */
    const channel = {
      id: existing?.id ?? newId('ch'),
      platform: draft.platform,
      name: draft.name,
      username: draft.username ?? existing?.username,
      avatar: draft.avatar ?? existing?.avatar,
      externalId: draft.externalId ?? existing?.externalId,
      // Tron config de khong mat field cu (vd refreshToken khi lan nay khong tra ve).
      config: { ...(existing?.config ?? {}), ...draft.config },
      defaults: { ...(existing?.defaults ?? {}), ...(draft.defaults ?? {}) },
      enabled: draft.enabled ?? existing?.enabled ?? true,
      connectedAt: existing?.connectedAt ?? now,
      lastUsedAt: existing?.lastUsedAt,
      lastError: null,
      authProvider: draft.authProvider ?? existing?.authProvider ?? 'manual',
    };
    await this.channels.upsert(channel);
    return channel;
  }

  /** @returns {Promise<Channel[]>} */
  async listChannels() {
    const items = await this.channels.all();
    return items.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
  }

  /**
   * @param {string[]} [ids]
   * @returns {Promise<Channel[]>}
   */
  async getChannels(ids) {
    const all = await this.channels.all();
    if (!ids || ids.length === 0) return all.filter((c) => c.enabled);
    const map = new Map(all.map((c) => [c.id, c]));
    return ids.map((id) => map.get(id)).filter(Boolean);
  }

  /**
   * Chuyen danh sach kenh thanh `platforms` config cho SocialPoster.
   * Key = channel id -> dang duoc nhieu kenh cung nen tang.
   * @param {Channel[]} channels
   * @returns {Record<string, any>}
   */
  static toPosterPlatforms(channels) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const ch of channels) {
      out[ch.id] = {
        platform: ch.platform,
        ...ch.config,
        defaults: ch.defaults,
      };
    }
    return out;
  }

  /**
   * @param {string} id
   * @param {{message: string, code?: string} | null} error
   */
  async setChannelError(id, error) {
    return this.channels.update(id, {
      lastError: error ? { at: new Date().toISOString(), ...error } : null,
    });
  }

  /** @param {string} id */
  async touchChannel(id) {
    return this.channels.update(id, { lastUsedAt: new Date().toISOString() });
  }

  // --------------------------------------------------------------------- post

  /**
   * @param {Partial<PostRecord>} draft
   * @returns {Promise<PostRecord>}
   */
  async createPost(draft) {
    const now = new Date().toISOString();
    /** @type {PostRecord} */
    const post = {
      id: newId('post'),
      status: draft.status ?? (draft.scheduledAt ? 'queued' : 'draft'),
      content: {
        title: draft.content?.title ?? '',
        description: draft.content?.description ?? '',
        hashtags: draft.content?.hashtags ?? [],
        link: draft.content?.link,
      },
      mediaIds: draft.mediaIds ?? [],
      channelIds: draft.channelIds ?? [],
      perChannel: draft.perChannel ?? {},
      scheduledAt: draft.scheduledAt ?? null,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      note: draft.note,
    };
    await this.posts.insert(post);
    return post;
  }

  /**
   * @param {string} id
   * @param {Partial<PostRecord>} patch
   */
  async updatePost(id, patch) {
    return this.posts.update(id, { ...patch, updatedAt: new Date().toISOString() });
  }

  /**
   * Cac bai da den gio dang.
   * @param {Date} [now]
   * @returns {Promise<PostRecord[]>}
   */
  async duePosts(now = new Date()) {
    const items = await this.posts.find((p) => p.status === 'queued' && Boolean(p.scheduledAt));
    return items
      .filter((p) => new Date(/** @type {string} */ (p.scheduledAt)).getTime() <= now.getTime())
      .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  }

  /**
   * @param {object} [filter]
   * @param {string[]} [filter.status]
   * @param {number} [filter.limit=100]
   * @returns {Promise<PostRecord[]>}
   */
  async listPosts(filter = {}) {
    const { status, limit = 100 } = filter;
    let items = await this.posts.all();
    if (status?.length) items = items.filter((p) => status.includes(p.status));
    items.sort((a, b) => {
      const ka = a.scheduledAt ?? a.publishedAt ?? a.createdAt;
      const kb = b.scheduledAt ?? b.publishedAt ?? b.createdAt;
      return String(kb).localeCompare(String(ka));
    });
    return items.slice(0, limit);
  }

  // -------------------------------------------------------------------- media

  /**
   * @param {Omit<MediaRecord, 'id'|'createdAt'>} draft
   * @returns {Promise<MediaRecord>}
   */
  async addMedia(draft) {
    /** @type {MediaRecord} */
    const rec = { id: newId('m'), createdAt: new Date().toISOString(), ...draft };
    await this.media.insert(rec);
    return rec;
  }

  /**
   * @param {string[]} ids
   * @returns {Promise<MediaRecord[]>}
   */
  async getMediaList(ids) {
    if (!ids?.length) return [];
    const all = await this.media.all();
    const map = new Map(all.map((m) => [m.id, m]));
    return ids.map((id) => map.get(id)).filter(Boolean);
  }

  /** @param {string} id */
  async removeMedia(id) {
    const rec = await this.media.get(id);
    if (!rec) return false;
    await unlink(rec.storedPath).catch(() => {});
    return this.media.remove(id);
  }

  /**
   * Xoa media khong con bai nao dung den (don rac).
   * @param {number} [olderThanMs=86400000]
   */
  async pruneMedia(olderThanMs = 24 * 3600_000) {
    const [posts, media] = await Promise.all([this.posts.all(), this.media.all()]);
    const used = new Set(posts.flatMap((p) => p.mediaIds));
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const m of media) {
      if (used.has(m.id)) continue;
      if (new Date(m.createdAt).getTime() > cutoff) continue;
      await this.removeMedia(m.id);
      removed += 1;
    }
    return removed;
  }

  /** Kiem tra file media con ton tai tren dia. */
  async mediaExists(rec) {
    try {
      await stat(rec.storedPath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Bo cac field bi mat truoc khi tra ve cho trinh duyet.
 * @param {Channel} channel
 */
export function publicChannel(channel) {
  const cfg = channel.config ?? {};
  return {
    id: channel.id,
    platform: channel.platform,
    name: channel.name,
    username: channel.username,
    avatar: channel.avatar,
    externalId: channel.externalId,
    enabled: channel.enabled,
    connectedAt: channel.connectedAt,
    lastUsedAt: channel.lastUsedAt,
    lastError: channel.lastError,
    authProvider: channel.authProvider,
    defaults: channel.defaults ?? {},
    // Cau hinh KHONG bi mat, web admin can de dung form dung (vd TikTok postMode).
    options: {
      postMode: cfg.postMode,
      privacyLevel: cfg.privacyLevel,
      parseMode: cfg.parseMode,
      categoryId: cfg.categoryId,
    },
    // Chi cho biet CO token hay khong, khong bao gio tra ve gia tri.
    credentials: {
      hasAccessToken: Boolean(cfg.accessToken || cfg.pageAccessToken || cfg.botToken),
      hasRefreshToken: Boolean(cfg.refreshToken),
      target: cfg.chatId ?? cfg.pageId ?? cfg.igUserId ?? undefined,
    },
  };
}
