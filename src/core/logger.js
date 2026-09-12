/**
 * Logger toi gian, khong phu thuoc thu vien ngoai.
 * Tu dong che (redact) token/secret truoc khi in ra.
 */

export const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

/** Cac key duoc coi la bi mat va se bi che. */
const SECRET_KEY_RE = /(token|secret|password|passwd|apikey|api_key|client_secret|refresh_token|access_token|authorization|cookie|signature|credential)/i;

/** Cac chuoi dai giong token trong URL / text. */
const SECRET_VALUE_PATTERNS = [
  /(bot)(\d{6,}:[\w-]{20,})/gi,                 // Telegram bot token trong URL
  /(access_token=)([^&\s"']+)/gi,
  /(refresh_token=)([^&\s"']+)/gi,
  /(client_secret=)([^&\s"']+)/gi,
  /(Bearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/gi,
  /(OAuth\s+)([A-Za-z0-9._~+/-]{12,}=*)/gi,
];

/**
 * Che bot gia tri bi mat.
 * @param {string} value
 * @returns {string}
 */
export function maskSecretString(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let out = value;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, (_m, p1, p2) => `${p1}${maskValue(p2)}`);
  }
  return out;
}

/** Giu 4 ky tu dau + 2 cuoi, phan giua thay bang ***. */
export function maskValue(v) {
  const s = String(v);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-2)}(len:${s.length})`;
}

/**
 * Duyet sau object va che cac field bi mat.
 * @param {unknown} input
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(input, depth = 0) {
  if (depth > 6) return '[deep]';
  if (input == null) return input;
  if (typeof input === 'string') return maskSecretString(input);
  if (typeof input !== 'object') return input;
  if (input instanceof Error) {
    return {
      name: input.name,
      message: maskSecretString(input.message),
      ...(typeof (/** @type {any} */ (input).toJSON) === 'function'
        ? redact(/** @type {any} */ (input).toJSON(), depth + 1)
        : {}),
    };
  }
  if (Array.isArray(input)) return input.slice(0, 50).map((v) => redact(v, depth + 1));
  if (input instanceof Map) return redact(Object.fromEntries(input), depth + 1);
  if (Buffer.isBuffer(input)) return `[Buffer ${input.byteLength} bytes]`;
  if (input instanceof Uint8Array) return `[Bytes ${input.byteLength}]`;

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = typeof v === 'string' || typeof v === 'number' ? maskValue(v) : '***';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

/**
 * @typedef {object} Logger
 * @property {(msg: string, meta?: object) => void} error
 * @property {(msg: string, meta?: object) => void} warn
 * @property {(msg: string, meta?: object) => void} info
 * @property {(msg: string, meta?: object) => void} debug
 * @property {(msg: string, meta?: object) => void} trace
 * @property {(bindings: object) => Logger} child
 * @property {string} level
 */

/**
 * Tao logger.
 * @param {object} [opts]
 * @param {keyof typeof LOG_LEVELS} [opts.level='info']
 * @param {'pretty'|'json'} [opts.format='pretty']
 * @param {(line: string) => void} [opts.sink] Mac dinh ghi ra stderr.
 * @param {object} [opts.bindings] Context mac dinh gan vao moi dong log.
 * @param {boolean} [opts.redactSecrets=true]
 * @returns {Logger}
 */
export function createLogger(opts = {}) {
  const {
    level = process.env.WAM_LOG_LEVEL || 'info',
    format = process.env.WAM_LOG_FORMAT === 'json' ? 'json' : 'pretty',
    sink = (line) => process.stderr.write(`${line}\n`),
    bindings = {},
    redactSecrets = true,
  } = opts;

  const threshold = LOG_LEVELS[/** @type {keyof typeof LOG_LEVELS} */ (level)] ?? LOG_LEVELS.info;

  /**
   * @param {keyof typeof LOG_LEVELS} lvl
   * @param {string} msg
   * @param {object} [meta]
   */
  function emit(lvl, msg, meta) {
    if (LOG_LEVELS[lvl] > threshold) return;
    const payload = { ...bindings, ...(meta ?? {}) };
    const clean = redactSecrets ? /** @type {object} */ (redact(payload)) : payload;
    const text = redactSecrets ? maskSecretString(msg) : msg;
    const ts = new Date().toISOString();

    if (format === 'json') {
      sink(JSON.stringify({ ts, level: lvl, msg: text, ...clean }));
      return;
    }
    const tag = clean.platform ? ` [${clean.platform}]` : '';
    const rest = { ...clean };
    delete rest.platform;
    const extra = Object.keys(rest).length ? ` ${inlineMeta(rest)}` : '';
    sink(`${ts} ${lvl.toUpperCase().padEnd(5)}${tag} ${text}${extra}`);
  }

  /** @type {Logger} */
  const logger = {
    level,
    error: (m, x) => emit('error', m, x),
    warn: (m, x) => emit('warn', m, x),
    info: (m, x) => emit('info', m, x),
    debug: (m, x) => emit('debug', m, x),
    trace: (m, x) => emit('trace', m, x),
    child: (extra) => createLogger({ ...opts, level, format, sink, bindings: { ...bindings, ...extra }, redactSecrets }),
  };
  return logger;
}

/** Logger khong lam gi ca - dung trong test. */
export const noopLogger = /** @type {Logger} */ ({
  level: 'silent',
  error() {}, warn() {}, info() {}, debug() {}, trace() {},
  child() { return noopLogger; },
});

function inlineMeta(obj) {
  try {
    return Object.entries(obj)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ');
  } catch {
    return '';
  }
}
