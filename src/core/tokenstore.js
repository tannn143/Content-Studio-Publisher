/**
 * Luu tru token (access token ngan han, refresh token) giua cac lan chay.
 *
 * Vi sao can: YouTube va TikTok dung refresh_token de doi access_token moi.
 * TikTok con XOAY refresh token (rotating) - neu khong luu lai, lan sau se mat quyen.
 */

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

/**
 * Tao khoa luu token, on dinh va KHONG chua secret.
 *
 * Vi sao can: mot app (cung clientId/clientKey) co the ket noi NHIEU tai khoan.
 * Neu khoa chi lay tu clientKey thi hai kenh se dung chung mot ban ghi token
 * -> co the dang bai len SAI tai khoan.
 *
 * @param {string} prefix      Vi du 'tiktok', 'youtube'.
 * @param {string} [publicPart] Phan cong khai (clientId/clientKey) - chi lay 12 ky tu.
 * @param {...(string|undefined)} secrets Cac gia tri dinh danh tai khoan (refresh/access token).
 * @returns {string}
 */
export function tokenStoreKey(prefix, publicPart, ...secrets) {
  const pub = String(publicPart ?? '').slice(0, 12);
  const joined = secrets.filter(Boolean).map(String).join('|');
  // Hash 32-bit khong the dao nguoc: du de phan biet tai khoan, khong lo ro ri secret.
  let h = 0;
  for (let i = 0; i < joined.length; i += 1) h = (h * 31 + joined.charCodeAt(i)) | 0;
  return `${prefix}:${pub}.${(h >>> 0).toString(36)}`;
}

/**
 * @typedef {object} TokenStore
 * @property {(key: string) => Promise<any | undefined>} get
 * @property {(key: string, value: any) => Promise<void>} set
 * @property {(key: string) => Promise<void>} delete
 */

/** Luu trong RAM - mat khi process tat. Dung cho test hoac chay 1 lan. */
export class MemoryTokenStore {
  constructor(initial = {}) {
    /** @type {Map<string, any>} */
    this.map = new Map(Object.entries(initial));
  }

  async get(key) {
    return this.map.get(key);
  }

  async set(key, value) {
    this.map.set(key, value);
  }

  async delete(key) {
    this.map.delete(key);
  }

  toJSON() {
    return Object.fromEntries(this.map);
  }
}

/**
 * Luu vao mot file JSON. Ghi kieu atomic (ghi file tam roi rename)
 * de khong lam hong file khi process bi kill giua luc ghi.
 */
export class FileTokenStore {
  /**
   * @param {string} filePath
   * @param {object} [opts]
   * @param {boolean} [opts.pretty=true]
   */
  constructor(filePath, opts = {}) {
    this.filePath = path.resolve(filePath);
    this.pretty = opts.pretty ?? true;
    /** @type {Record<string, any> | null} */
    this.cache = null;
    /** @type {Promise<void>} */
    this.writeLock = Promise.resolve();
  }

  async _read() {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = JSON.parse(raw);
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'ENOENT') {
        // File hong -> khong lam sap ung dung, coi nhu rong nhung giu lai ban loi.
        this.cache = {};
        this.corrupted = true;
      } else {
        this.cache = {};
      }
    }
    return this.cache;
  }

  async _flush() {
    const data = this.cache ?? {};
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(tmp, JSON.stringify(data, null, this.pretty ? 2 : 0), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.filePath);
    // Tren Windows chmod gan nhu vo nghia, nhung tren Linux/macOS thi quan trong.
    await chmod(this.filePath, 0o600).catch(() => {});
  }

  async get(key) {
    const data = await this._read();
    return data[key];
  }

  async set(key, value) {
    const data = await this._read();
    data[key] = value;
    // Serialize cac lan ghi de tranh race.
    this.writeLock = this.writeLock.then(() => this._flush(), () => this._flush());
    await this.writeLock;
  }

  async delete(key) {
    const data = await this._read();
    delete data[key];
    this.writeLock = this.writeLock.then(() => this._flush(), () => this._flush());
    await this.writeLock;
  }
}

/**
 * Cac lan refresh DANG CHAY, dung chung cho moi instance (khoa theo store key).
 *
 * Vi sao can: SocialPoster tao instance adapter MOI cho moi lan dang, nen bien
 * `inflight` cua rieng instance khong chan duoc hai lan refresh song song.
 * Voi TikTok (refresh token XOAY moi lan) thi hai lan refresh dong thoi se lam
 * mat quyen truy cap vinh vien.
 * @type {Map<string, Promise<string>>}
 */
const GLOBAL_INFLIGHT = new Map();

/**
 * Cache access token trong bo nho + store, tu refresh khi gan het han.
 * Dung chung cho YouTube va TikTok.
 */
export class AccessTokenManager {
  /**
   * @param {object} opts
   * @param {string} opts.key Khoa luu trong store, vd 'youtube:default'.
   * @param {TokenStore} opts.store
   * @param {() => Promise<{accessToken: string, expiresInSec?: number, refreshToken?: string, raw?: any}>} opts.refresh
   * @param {number} [opts.skewSec=120] Refresh som truoc khi het han bao nhieu giay.
   * @param {import('./logger.js').Logger} [opts.logger]
   * @param {string} [opts.initialAccessToken] Token nguoi dung truyen san (co the khong biet han).
   * @param {number} [opts.initialExpiresAt]
   */
  constructor(opts) {
    this.key = opts.key;
    this.store = opts.store;
    this.refreshFn = opts.refresh;
    this.skewSec = opts.skewSec ?? 120;
    this.logger = opts.logger;
    /** Thoi han tin tuong token khong biet han (Infinity = tin mai). */
    this.provisionalTtlMs = opts.provisionalTtlMs ?? Infinity;
    this.createdAt = Date.now();
    /**
     * Token dang dung.
     * `provisional` = token nguoi dung truyen vao ma KHONG biet han su dung.
     * Token provisional chi duoc dung khi trong store chua co gi tot hon, va
     * khong bao gio duoc coi la "con han vinh vien".
     * @type {{accessToken: string, expiresAt?: number, provisional?: boolean} | undefined}
     */
    this.current = opts.initialAccessToken
      ? {
        accessToken: opts.initialAccessToken,
        expiresAt: opts.initialExpiresAt,
        provisional: !opts.initialExpiresAt,
      }
      : undefined;
    /** @type {Promise<string> | null} Chong refresh dong thoi nhieu lan. */
    this.inflight = null;
  }

  /**
   * Lay access token con hieu luc.
   * @param {object} [opts]
   * @param {boolean} [opts.forceRefresh=false]
   * @returns {Promise<string>}
   */
  async getAccessToken(opts = {}) {
    if (!opts.forceRefresh) {
      // Token co han su dung ro rang va con han -> dung luon.
      if (this.current && !this.current.provisional && !this._isExpired(this.current)) {
        return this.current.accessToken;
      }
      // Ban ghi trong store (co han ro rang) LUON thang token provisional.
      const saved = await this.store.get(this.key);
      if (saved?.accessToken && !this._isExpired(saved)) {
        this.current = saved;
        return saved.accessToken;
      }
      // Chua co gi trong store -> token nguoi dung truyen vao van la lua chon tot nhat
      // (lan chay dau tien; rieng Instagram khong refresh duoc token moi hon 24h).
      if (this.current?.provisional && this.current.accessToken && !this._provisionalStale()) {
        return this.current.accessToken;
      }
    }
    // Dedup theo KHOA (khong theo instance) de hai lan dang song song khong
    // cung refresh mot token.
    const shared = GLOBAL_INFLIGHT.get(this.key);
    if (shared) return shared;

    this.inflight = (async () => {
      this.logger?.debug('refreshing access token', { key: this.key });
      const res = await this.refreshFn();
      const expiresAt = res.expiresInSec
        ? Date.now() + Math.max(0, (res.expiresInSec - this.skewSec)) * 1000
        : undefined;
      const record = {
        accessToken: res.accessToken,
        expiresAt,
        refreshToken: res.refreshToken,
        updatedAt: new Date().toISOString(),
      };
      this.current = record;
      await this.store.set(this.key, record);
      return res.accessToken;
    })();

    GLOBAL_INFLIGHT.set(this.key, this.inflight);
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
      GLOBAL_INFLIGHT.delete(this.key);
    }
  }

  /** Lay refresh token moi nhat (TikTok xoay refresh token moi lan doi). */
  async getStoredRefreshToken() {
    const saved = await this.store.get(this.key);
    return saved?.refreshToken;
  }

  /** Bo token hien tai (khi API tra 401) de lan sau refresh lai. */
  async invalidate() {
    this.current = undefined;
    const saved = await this.store.get(this.key);
    if (saved) {
      await this.store.set(this.key, { ...saved, accessToken: undefined, expiresAt: 0 });
    }
  }

  _isExpired(rec) {
    if (!rec?.accessToken) return true;
    if (!rec.expiresAt) return false; // khong biet han -> tin la con dung
    return Date.now() >= rec.expiresAt;
  }

  /**
   * Token provisional (khong biet han) da qua "thoi han tin tuong" chua.
   * Mac dinh khong gioi han: dung cho truong hop token dai han la thu duy nhat ta co
   * (vi du Instagram Login - refresh som se bi tu choi).
   * Dat `provisionalTtlMs` de token .env cu tu dong nhuong cho refresh.
   */
  _provisionalStale() {
    if (!Number.isFinite(this.provisionalTtlMs)) return false;
    return Date.now() - this.createdAt >= this.provisionalTtlMs;
  }
}
