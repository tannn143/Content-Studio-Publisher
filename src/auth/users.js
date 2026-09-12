/**
 * Nguoi dung, phan quyen va audit log.
 *
 * Vi sao can: chinh sach bao mat khong cho phat mat khau tai khoan TikTok cho
 * nhan vien. Thay vao do admin ket noi kenh mot lan (OAuth), token nam lai o he
 * thong, con nhan vien dang nhap bang tai khoan RIENG cua minh va chi dang duoc
 * len nhung kenh da duoc cap.
 *
 * Nguyen tac: quyen duoc kiem tra o SERVER. Giao dien an bot chi la tien nghi,
 * khong bao gio la rao chan.
 *
 * Hai vai tro:
 *  - admin  : quan ly nguoi dung, ket noi/ngat kenh, sua cai dat, xem audit log,
 *             dang duoc len moi kenh.
 *  - member : chi dang duoc len kenh da duoc cap, va chi khi canPublish = true.
 *             Khong co canPublish thi chi soan/luu nhap, de admin dang.
 */

import crypto from 'node:crypto';
import { AuthError, ValidationError } from '../core/errors.js';
import { newId } from '../core/store/jsonstore.js';

/** Vai tro hop le. */
export const ROLES = ['admin', 'member'];

/** Phien dang nhap song 12 gio. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/**
 * Bam mat khau bang scrypt (co san trong Node, khong can dependency).
 * @param {string} password
 * @param {string} [salt]
 * @returns {{salt: string, hash: string}}
 */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString('hex');
  return { salt, hash };
}

/**
 * So sanh mat khau theo thoi gian hang so.
 * @param {string} password
 * @param {{salt?: string, hash?: string}} user
 */
export function verifyPassword(password, user) {
  if (!user?.salt || !user?.hash) return false;
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Mat khau tam sinh tu dong - de doc de admin doc cho nhan vien. */
export function generatePassword() {
  // Bo cac ky tu de doc sai (0/O, 1/l/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(14)) out += alphabet[b % alphabet.length];
  return out;
}

/**
 * Chuan hoa username: khong phan biet hoa thuong, khong khoang trang.
 * @param {string} raw
 */
export function normalizeUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/** Ban public cua user - KHONG bao gio chua salt/hash. */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    channelIds: user.channelIds ?? [],
    canPublish: Boolean(user.canPublish),
    enabled: user.enabled !== false,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}

export class UserService {
  /**
   * @param {object} opts
   * @param {import('../core/store/jsonstore.js').JsonCollection<any>} opts.users
   * @param {import('../core/store/jsonstore.js').JsonCollection<any>} opts.sessions
   * @param {import('../core/store/jsonstore.js').JsonCollection<any>} opts.audit
   * @param {import('../core/logger.js').Logger} [opts.logger]
   */
  constructor(opts) {
    this.users = opts.users;
    this.sessions = opts.sessions;
    this.audit = opts.audit;
    this.logger = opts.logger;
  }

  // ------------------------------------------------------------------- users

  /**
   * Tao admin dau tien neu chua co nguoi dung nao.
   * @returns {Promise<{user: any, password: string} | null>} null neu da co user
   */
  async ensureFirstAdmin() {
    if ((await this.users.all()).length > 0) return null;
    const password = generatePassword();
    const user = await this.createUser({
      username: 'admin',
      displayName: 'Administrator',
      role: 'admin',
      password,
      canPublish: true,
      // Mat khau in ra console -> bat doi ngay lan dang nhap dau.
      mustChangePassword: true,
    });
    return { user, password };
  }

  /**
   * @param {object} draft
   * @returns {Promise<any>}
   */
  async createUser(draft) {
    const username = normalizeUsername(draft.username);
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      throw new ValidationError(
        'Username must be 3-32 characters: lowercase letters, digits, and . _ - only',
      );
    }
    if (await this.findByUsername(username)) {
      throw new ValidationError(`Username '${username}' is already taken`);
    }
    const role = ROLES.includes(draft.role) ? draft.role : 'member';
    const password = String(draft.password ?? '');
    if (password.length < 10) {
      throw new ValidationError('Password must be at least 10 characters');
    }
    const { salt, hash } = hashPassword(password);

    const user = {
      id: newId('u'),
      username,
      displayName: String(draft.displayName ?? username).slice(0, 120),
      role,
      salt,
      hash,
      // Admin luon dang duoc moi kenh -> khong can danh sach.
      channelIds: role === 'admin' ? [] : [...new Set(draft.channelIds ?? [])],
      canPublish: role === 'admin' ? true : Boolean(draft.canPublish),
      enabled: draft.enabled !== false,
      mustChangePassword: Boolean(draft.mustChangePassword),
      createdAt: new Date().toISOString(),
    };
    await this.users.insert(user);
    return user;
  }

  /** @param {string} username */
  async findByUsername(username) {
    const found = await this.users.find((u) => u.username === normalizeUsername(username));
    return found[0];
  }

  async listUsers() {
    const all = await this.users.all();
    return all.sort((a, b) => a.username.localeCompare(b.username));
  }

  /**
   * Sua user. Chi nhan cac field an toan; doi mat khau di qua setPassword.
   * @param {string} id
   * @param {object} patch
   */
  async updateUser(id, patch) {
    const user = await this.users.get(id);
    if (!user) throw new ValidationError(`User '${id}' not found`);

    /** @type {Record<string, any>} */
    const next = {};
    if (patch.displayName !== undefined) next.displayName = String(patch.displayName).slice(0, 120);
    if (patch.role !== undefined && ROLES.includes(patch.role)) next.role = patch.role;
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.canPublish !== undefined) next.canPublish = Boolean(patch.canPublish);
    if (patch.channelIds !== undefined) {
      next.channelIds = [...new Set((patch.channelIds ?? []).map(String))];
    }

    const role = next.role ?? user.role;
    if (role === 'admin') {
      // Admin dang duoc moi kenh -> danh sach kenh vo nghia, xoa de khong gay hieu nham.
      next.channelIds = [];
      next.canPublish = true;
    }

    // Khong de tu tay ha het admin -> he thong khong con ai quan ly duoc.
    if ((next.role && next.role !== 'admin') || next.enabled === false) {
      await this._assertNotLastAdmin(user, next);
    }

    const updated = await this.users.update(id, next);
    // Ha quyen hoac tat tai khoan -> huy moi phien dang mo cua nguoi do NGAY.
    if (next.enabled === false || (next.role && next.role !== user.role)) {
      await this.revokeSessionsFor(id);
    }
    return updated;
  }

  /** Khong cho phep khong con admin nao dang bat. */
  async _assertNotLastAdmin(user, next) {
    if (user.role !== 'admin') return;
    const admins = (await this.users.all()).filter(
      (u) => u.role === 'admin' && u.enabled !== false && u.id !== user.id,
    );
    if (admins.length === 0) {
      throw new ValidationError(
        'This is the only active administrator - you cannot change their role or disable them',
        { hint: 'Create or enable another administrator first.' },
      );
    }
  }

  /**
   * @param {string} id
   * @param {string} password
   * @param {object} [opts]
   * @param {boolean} [opts.mustChangePassword]
   */
  async setPassword(id, password, opts = {}) {
    if (String(password).length < 10) {
      throw new ValidationError('Password must be at least 10 characters');
    }
    const { salt, hash } = hashPassword(String(password));
    const updated = await this.users.update(id, {
      salt,
      hash,
      mustChangePassword: Boolean(opts.mustChangePassword),
    });
    // Doi mat khau -> dang xuat moi thiet bi khac.
    await this.revokeSessionsFor(id);
    return updated;
  }

  /** @param {string} id */
  async removeUser(id) {
    const user = await this.users.get(id);
    if (!user) return false;
    await this._assertNotLastAdmin(user, { role: 'member' });
    await this.revokeSessionsFor(id);
    return this.users.remove(id);
  }

  /**
   * Xoa mot kenh khoi quyen cua moi nguoi (dung khi ngat ket noi kenh).
   * @param {string} channelId
   */
  async dropChannelFromAllUsers(channelId) {
    const affected = await this.users.find((u) => (u.channelIds ?? []).includes(channelId));
    for (const u of affected) {
      await this.users.update(u.id, {
        channelIds: (u.channelIds ?? []).filter((c) => c !== channelId),
      });
    }
    return affected.length;
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Dang nhap. Tra ve token phien de dat vao cookie.
   * @param {string} username
   * @param {string} password
   * @returns {Promise<{token: string, user: any}>}
   */
  async login(username, password) {
    const user = await this.findByUsername(username);
    // Loi chung cho ca hai truong hop: khong tiet lo username nao ton tai.
    const fail = () => new AuthError('Incorrect username or password');

    if (!user || user.enabled === false) {
      // Van bam mot lan de thoi gian tra loi khong to ra user co ton tai hay khong.
      hashPassword(String(password ?? ''), 'dummy-salt-for-timing');
      throw fail();
    }
    if (!verifyPassword(String(password ?? ''), user)) throw fail();

    await this._gcSessions();
    const token = crypto.randomBytes(32).toString('base64url');
    await this.sessions.insert({
      id: crypto.createHash('sha256').update(token).digest('hex'),
      userId: user.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });
    await this.users.update(user.id, { lastLoginAt: new Date().toISOString() });
    return { token, user };
  }

  /**
   * Doi token phien -> nguoi dung. Tra ve null neu khong hop le/het han.
   * @param {string} token
   */
  async userForSession(token) {
    if (!token) return null;
    const id = crypto.createHash('sha256').update(token).digest('hex');
    const session = await this.sessions.get(id);
    if (!session) return null;
    if (Date.parse(session.expiresAt) < Date.now()) {
      await this.sessions.remove(id);
      return null;
    }
    const user = await this.users.get(session.userId);
    if (!user || user.enabled === false) return null;
    return user;
  }

  /** @param {string} token */
  async logout(token) {
    if (!token) return false;
    const id = crypto.createHash('sha256').update(token).digest('hex');
    return this.sessions.remove(id);
  }

  /** @param {string} userId */
  async revokeSessionsFor(userId) {
    const mine = await this.sessions.find((s) => s.userId === userId);
    for (const s of mine) await this.sessions.remove(s.id);
    return mine.length;
  }

  async _gcSessions() {
    const now = Date.now();
    const dead = await this.sessions.find((s) => Date.parse(s.expiresAt) < now);
    for (const s of dead) await this.sessions.remove(s.id);
  }

  // ------------------------------------------------------------------- audit

  /**
   * Ghi mot dong audit log. Khong bao gio nem loi: khong duoc de viec ghi log
   * lam that bai hanh dong chinh.
   *
   * @param {object} entry
   * @param {any} [entry.actor]      user thuc hien (hoac null neu he thong)
   * @param {string} entry.action    vd 'post.publish', 'channel.connect'
   * @param {string} [entry.channelId]
   * @param {string} [entry.postId]
   * @param {string} [entry.targetUserId]
   * @param {'ok'|'fail'} [entry.result]
   * @param {string} [entry.detail]
   * @param {string} [entry.ip]
   */
  async log(entry) {
    try {
      await this.audit.insert({
        id: newId('a'),
        at: new Date().toISOString(),
        userId: entry.actor?.id ?? null,
        username: entry.actor?.username ?? 'system',
        action: String(entry.action),
        channelId: entry.channelId,
        postId: entry.postId,
        targetUserId: entry.targetUserId,
        result: entry.result ?? 'ok',
        detail: entry.detail ? String(entry.detail).slice(0, 500) : undefined,
        ip: entry.ip,
      });
      // Giu log khong phinh vo han.
      await this.audit.trim(5000);
    } catch (err) {
      this.logger?.warn('could not write to the audit log', { error: /** @type {any} */ (err)?.message });
    }
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.limit=200]
   * @param {string} [opts.userId]
   * @param {string} [opts.action]
   */
  async listAudit(opts = {}) {
    let rows = await this.audit.all();
    if (opts.userId) rows = rows.filter((r) => r.userId === opts.userId);
    if (opts.action) rows = rows.filter((r) => r.action.startsWith(opts.action));
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return rows.slice(0, Math.min(1000, Math.max(1, opts.limit ?? 200)));
  }
}

// ------------------------------------------------------------- phan quyen

/** @param {any} user */
export function isAdmin(user) {
  return user?.role === 'admin';
}

/**
 * User co duoc dung kenh nay khong (soan bai, xem truoc).
 * @param {any} user
 * @param {string} channelId
 */
export function canUseChannel(user, channelId) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  return (user.channelIds ?? []).includes(channelId);
}

/**
 * User co duoc DANG len kenh nay khong.
 * Can ca quyen dung kenh va co canPublish - nguoi chi soan nhap thi khong dang.
 * @param {any} user
 * @param {string} channelId
 */
export function canPublishTo(user, channelId) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  return Boolean(user.canPublish) && canUseChannel(user, channelId);
}

/**
 * Kiem tra truoc khi dang mot bai len nhieu kenh.
 * @param {any} user
 * @param {string[]} channelIds
 * @returns {{ok: true} | {ok: false, denied: string[], reason: string}}
 */
export function assertCanPublishPost(user, channelIds) {
  if (isAdmin(user)) return { ok: true };
  if (!user?.canPublish) {
    return {
      ok: false,
      denied: [...channelIds],
      reason: 'This account may only draft posts, not publish them. Ask an administrator for publishing rights.',
    };
  }
  const denied = channelIds.filter((id) => !canUseChannel(user, id));
  if (denied.length > 0) {
    return { ok: false, denied, reason: 'This account has not been granted access to some of the selected accounts.' };
  }
  return { ok: true };
}
