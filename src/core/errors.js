/**
 * He thong loi chuan hoa cho toan bo module.
 *
 * Moi loi deu mang theo:
 *  - `code`      : ma loi noi bo on dinh, dung de switch/case
 *  - `platform`  : nen tang phat sinh loi (neu co)
 *  - `retryable` : co nen thu lai hay khong
 *  - `details`   : du lieu tho tu API de debug
 */

/** Ma loi noi bo on dinh. */
export const ErrorCode = {
  VALIDATION: 'E_VALIDATION',
  CONFIG: 'E_CONFIG',
  AUTH: 'E_AUTH',
  PERMISSION: 'E_PERMISSION',
  RATE_LIMIT: 'E_RATE_LIMIT',
  QUOTA: 'E_QUOTA',
  MEDIA: 'E_MEDIA',
  UNSUPPORTED: 'E_UNSUPPORTED',
  NETWORK: 'E_NETWORK',
  TIMEOUT: 'E_TIMEOUT',
  ABORTED: 'E_ABORTED',
  PROCESSING: 'E_PROCESSING',
  PLATFORM: 'E_PLATFORM',
  INTERNAL: 'E_INTERNAL',
};

/** Loi goc cua module. */
export class SocialPostError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.code]
   * @param {string} [opts.platform]
   * @param {boolean} [opts.retryable]
   * @param {number} [opts.httpStatus]
   * @param {unknown} [opts.details]
   * @param {unknown} [opts.cause]
   * @param {string} [opts.hint] Goi y cach xu ly cho nguoi dung.
   */
  constructor(message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code ?? ErrorCode.INTERNAL;
    this.platform = opts.platform;
    this.retryable = opts.retryable ?? false;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
    this.hint = opts.hint;
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }

  /** Serialize an toan de ghi log. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      platform: this.platform,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
      hint: this.hint,
      details: safeDetails(this.details),
      cause: this.cause instanceof Error
        ? { name: this.cause.name, message: this.cause.message }
        : undefined,
    };
  }
}

/** Input cua nguoi dung khong hop le (title rong, media sai kieu...). */
export class ValidationError extends SocialPostError {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {Array<{path: string, message: string}>} [opts.issues]
   */
  constructor(message, opts = {}) {
    super(message, { ...opts, code: ErrorCode.VALIDATION, retryable: false });
    this.issues = opts.issues ?? [];
  }
}

/** Cau hinh nen tang thieu hoac sai (thieu token, thieu pageId...). */
export class ConfigError extends SocialPostError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: ErrorCode.CONFIG, retryable: false });
  }
}

/** Token het han / khong hop le / bi thu hoi. */
export class AuthError extends SocialPostError {
  constructor(message, opts = {}) {
    super(message, {
      ...opts,
      code: opts.code ?? ErrorCode.AUTH,
      retryable: opts.retryable ?? false,
    });
  }
}

/** Bi gioi han tan suat. `retryAfterMs` cho biet thoi gian cho. */
export class RateLimitError extends SocialPostError {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.retryAfterMs]
   */
  constructor(message, opts = {}) {
    super(message, {
      ...opts,
      code: opts.code ?? ErrorCode.RATE_LIMIT,
      retryable: opts.retryable ?? true,
    });
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Het quota (thuong KHONG nen retry trong ngay, vd YouTube quota). */
export class QuotaError extends RateLimitError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: ErrorCode.QUOTA, retryable: opts.retryable ?? false });
  }
}

/** Loi lien quan media: khong doc duoc file, dinh dang sai, qua dung luong. */
export class MediaError extends SocialPostError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: opts.code ?? ErrorCode.MEDIA, retryable: false });
  }
}

/** Nen tang khong ho tro loai bai dang nay (vd Instagram khong dang text-only). */
export class UnsupportedError extends SocialPostError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: ErrorCode.UNSUPPORTED, retryable: false });
  }
}

/** Loi mang / DNS / socket. */
export class NetworkError extends SocialPostError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: ErrorCode.NETWORK, retryable: opts.retryable ?? true });
  }
}

/** Qua thoi gian cho. */
export class TimeoutError extends SocialPostError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: ErrorCode.TIMEOUT, retryable: opts.retryable ?? true });
  }
}

/** Bi huy boi AbortSignal. */
export class AbortError extends SocialPostError {
  constructor(message = 'Operation aborted', opts = {}) {
    super(message, { ...opts, code: ErrorCode.ABORTED, retryable: false });
  }
}

/** Nen tang xu ly media that bai hoac qua lau (IG container, TikTok publish status). */
export class ProcessingError extends SocialPostError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: ErrorCode.PROCESSING, retryable: opts.retryable ?? false });
  }
}

/** Loi tra ve tu API nen tang, khong khop cac nhom tren. */
export class PlatformError extends SocialPostError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: opts.code ?? ErrorCode.PLATFORM });
    /** Ma loi goc cua nen tang (vd FB code 190, TikTok 'spam_risk_too_many_posts'). */
    this.platformCode = opts.platformCode;
    this.platformSubcode = opts.platformSubcode;
  }
}

/** Gop loi cua nhieu nen tang thanh mot. */
export class AggregatePostError extends SocialPostError {
  /**
   * @param {string} message
   * @param {Record<string, Error>} errors platform -> error
   * @param {object} [opts]
   */
  constructor(message, errors, opts = {}) {
    super(message, { ...opts, code: ErrorCode.PLATFORM });
    this.errors = errors;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      errors: Object.fromEntries(
        Object.entries(this.errors).map(([k, v]) => [
          k,
          v instanceof SocialPostError ? v.toJSON() : { message: String(v?.message ?? v) },
        ]),
      ),
    };
  }
}

const RETRYABLE_SYS_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETRESET',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Chuyen mot gia tri bat ky thanh SocialPostError.
 * @param {unknown} err
 * @param {{platform?: string, details?: unknown}} [ctx]
 * @returns {SocialPostError}
 */
export function toSocialPostError(err, ctx = {}) {
  if (err instanceof SocialPostError) {
    if (ctx.platform && !err.platform) err.platform = ctx.platform;
    return err;
  }
  if (err instanceof Error) {
    const cause = /** @type {any} */ (err).cause;
    const sysCode = cause?.code ?? /** @type {any} */ (err).code;
    if (err.name === 'AbortError') {
      return new AbortError(err.message, { ...ctx, cause: err });
    }
    if (err.name === 'TimeoutError' || sysCode === 'UND_ERR_HEADERS_TIMEOUT' || sysCode === 'UND_ERR_BODY_TIMEOUT') {
      return new TimeoutError(err.message, { ...ctx, cause: err });
    }
    if (RETRYABLE_SYS_CODES.has(sysCode) || (err.name === 'TypeError' && /fetch failed/i.test(err.message))) {
      return new NetworkError(err.message, { ...ctx, cause: err, details: { sysCode } });
    }
    // Giu lai cac co ma code ben ngoai da danh dau (vd err.retryable, err.hint).
    return new SocialPostError(err.message, {
      ...ctx,
      cause: err,
      retryable: /** @type {any} */ (err).retryable === true,
      hint: /** @type {any} */ (err).hint,
      httpStatus: /** @type {any} */ (err).status ?? /** @type {any} */ (err).httpStatus,
    });
  }
  return new SocialPostError(String(err), ctx);
}

/** Cat bot details qua lon de log khong phinh. */
function safeDetails(details, maxLen = 4000) {
  if (details == null) return undefined;
  if (typeof details === 'string') {
    return details.length > maxLen ? `${details.slice(0, maxLen)}...[+${details.length - maxLen}]` : details;
  }
  try {
    const s = JSON.stringify(details);
    if (s == null) return String(details);
    if (s.length <= maxLen) return JSON.parse(s);
    return `${s.slice(0, maxLen)}...[+${s.length - maxLen}]`;
  } catch {
    return String(details);
  }
}
