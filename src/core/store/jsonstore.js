/**
 * Luu tru don gian tren file JSON (khong can database).
 *
 * - Ghi ATOMIC (ghi file tam roi rename) -> khong hong du bi kill giua luc ghi.
 * - Serialize cac lan ghi -> khong bi race khi nhieu request cung luc.
 * - File mode 0600 vi co the chua token.
 */

import { mkdir, readFile, rename, writeFile, chmod, unlink } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

/** Tao id ngan, de doc, sap xep duoc theo thoi gian. */
export function newId(prefix = '') {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(5).toString('hex');
  return `${prefix}${prefix ? '_' : ''}${ts}${rand}`;
}

/**
 * Mot "bang" luu duoi dang mang JSON.
 * @template {{id: string}} T
 */
export class JsonCollection {
  /**
   * @param {string} filePath
   * @param {object} [opts]
   * @param {T[]} [opts.seed] Du lieu khoi tao khi file chua ton tai.
   */
  constructor(filePath, opts = {}) {
    this.filePath = path.resolve(filePath);
    this.seed = opts.seed ?? [];
    /** @type {T[] | null} */
    this.cache = null;
    /** @type {Promise<any>} */
    this.lock = Promise.resolve();
  }

  async _load() {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === 'ENOENT') {
        // Chua co file -> bat dau voi du lieu mac dinh.
        this.cache = [...this.seed];
        return this.cache;
      }
      if (err instanceof SyntaxError) {
        // JSON hong: doi ten de giu lai roi bat dau lai.
        await rename(this.filePath, `${this.filePath}.corrupt.${Date.now()}`).catch(() => {});
        this.cache = [...this.seed];
        return this.cache;
      }
      // EACCES/EMFILE/EIO/EBUSY...: KHONG duoc coi la rong, vi lan ghi sau se
      // xoa sach du lieu that. Nem loi ra de caller biet.
      throw err;
    }
    return this.cache;
  }

  async _flush() {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.cache ?? [], null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => {});
  }

  /** Chay mot thao tac ghi (duoc serialize). */
  async _write(fn) {
    const run = async () => {
      await this._load();
      const out = await fn(/** @type {T[]} */ (this.cache));
      await this._flush();
      return out;
    };
    this.lock = this.lock.then(run, run);
    return this.lock;
  }

  /** @returns {Promise<T[]>} */
  async all() {
    return [...(await this._load())];
  }

  /**
   * @param {(doc: T) => boolean} [filter]
   * @returns {Promise<T[]>}
   */
  async find(filter) {
    const items = await this._load();
    return filter ? items.filter(filter) : [...items];
  }

  /**
   * @param {string} id
   * @returns {Promise<T | undefined>}
   */
  async get(id) {
    const items = await this._load();
    return items.find((x) => x.id === id);
  }

  /**
   * @param {T} doc
   * @returns {Promise<T>}
   */
  async insert(doc) {
    return this._write((items) => {
      items.push(doc);
      return doc;
    });
  }

  /**
   * @param {string} id
   * @param {Partial<T> | ((doc: T) => Partial<T>)} patch
   * @returns {Promise<T | undefined>}
   */
  async update(id, patch) {
    return this._write((items) => {
      const i = items.findIndex((x) => x.id === id);
      if (i === -1) return undefined;
      const delta = typeof patch === 'function' ? patch(items[i]) : patch;
      items[i] = { ...items[i], ...delta };
      return items[i];
    });
  }

  /**
   * Chen moi hoac cap nhat theo id.
   * @param {T} doc
   */
  async upsert(doc) {
    return this._write((items) => {
      const i = items.findIndex((x) => x.id === doc.id);
      if (i === -1) items.push(doc);
      else items[i] = { ...items[i], ...doc };
      return doc;
    });
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    return this._write((items) => {
      const i = items.findIndex((x) => x.id === id);
      if (i === -1) return false;
      items.splice(i, 1);
      return true;
    });
  }

  /**
   * Giu lai toi da `max` ban ghi moi nhat (theo `createdAt` giam dan).
   * @param {number} max
   */
  async trim(max) {
    return this._write((items) => {
      if (items.length <= max) return 0;
      items.sort((a, b) => String(/** @type {any} */ (b).createdAt ?? '').localeCompare(String(/** @type {any} */ (a).createdAt ?? '')));
      const removed = items.splice(max);
      return removed.length;
    });
  }

  /** Xoa toan bo file (dung trong test). */
  async destroy() {
    this.cache = null;
    await unlink(this.filePath).catch(() => {});
  }
}

/**
 * Mot object JSON don le (dung cho settings).
 * @template {Record<string, any>} T
 */
export class JsonDocument {
  /**
   * @param {string} filePath
   * @param {T} defaults
   */
  constructor(filePath, defaults) {
    this.filePath = path.resolve(filePath);
    this.defaults = defaults;
    /** @type {T | null} */
    this.cache = null;
    /** @type {Promise<any>} */
    this.lock = Promise.resolve();
  }

  /** @returns {Promise<T>} */
  async read() {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = deepMerge(structuredClone(this.defaults), JSON.parse(raw));
    } catch {
      this.cache = structuredClone(this.defaults);
    }
    return /** @type {T} */ (this.cache);
  }

  /**
   * @param {Partial<T>} patch
   * @returns {Promise<T>}
   */
  async merge(patch) {
    const run = async () => {
      const cur = await this.read();
      this.cache = deepMerge(cur, patch);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.cache, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => {});
      return /** @type {T} */ (this.cache);
    };
    this.lock = this.lock.then(run, run);
    return this.lock;
  }
}

/**
 * Tron sau hai object (mang thi ghi de, khong noi).
 * @template T
 * @param {T} base
 * @param {any} patch
 * @returns {T}
 */
export function deepMerge(base, patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    return /** @type {any} */ (patch ?? base);
  }
  /** @type {any} */
  const out = Array.isArray(base) ? [...base] : { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
