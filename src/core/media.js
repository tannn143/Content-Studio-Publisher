/**
 * Truu tuong hoa media (anh/video) tu nhieu nguon: duong dan file, URL cong khai, Buffer.
 *
 * Muc tieu:
 *  - Doc duoc tung phan (chunk) ma KHONG nap ca file vao RAM (video 500MB van chay duoc).
 *  - Tu nhan biet mime bang magic bytes, khong tin tuong duoi file.
 *  - Lay duoc duration/kich thuoc neu may co ffprobe (tuy chon, khong bat buoc).
 */

import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MediaError } from './errors.js';

/** @typedef {'image'|'video'|'audio'|'unknown'} MediaKind */

/** Mime -> duoi file + loai. */
export const MIME_TABLE = {
  'image/jpeg': { ext: '.jpg', kind: 'image' },
  'image/png': { ext: '.png', kind: 'image' },
  'image/gif': { ext: '.gif', kind: 'image' },
  'image/webp': { ext: '.webp', kind: 'image' },
  'image/heic': { ext: '.heic', kind: 'image' },
  'image/avif': { ext: '.avif', kind: 'image' },
  'image/bmp': { ext: '.bmp', kind: 'image' },
  'image/tiff': { ext: '.tiff', kind: 'image' },
  'video/mp4': { ext: '.mp4', kind: 'video' },
  'video/quicktime': { ext: '.mov', kind: 'video' },
  'video/webm': { ext: '.webm', kind: 'video' },
  'video/x-matroska': { ext: '.mkv', kind: 'video' },
  'video/x-msvideo': { ext: '.avi', kind: 'video' },
  'video/mpeg': { ext: '.mpeg', kind: 'video' },
  'video/x-flv': { ext: '.flv', kind: 'video' },
  'audio/mpeg': { ext: '.mp3', kind: 'audio' },
  'audio/mp4': { ext: '.m4a', kind: 'audio' },
};

const EXT_TO_MIME = Object.fromEntries(
  Object.entries(MIME_TABLE).map(([mime, { ext }]) => [ext, mime]),
);
EXT_TO_MIME['.jpeg'] = 'image/jpeg';
EXT_TO_MIME['.jpe'] = 'image/jpeg';
EXT_TO_MIME['.m4v'] = 'video/mp4';
EXT_TO_MIME['.qt'] = 'video/quicktime';

/**
 * Nhan dang mime bang magic bytes.
 * @param {Buffer} buf 32 byte dau la du.
 * @returns {string | undefined}
 */
export function sniffMime(buf) {
  if (!buf || buf.length < 4) return undefined;
  const b = buf;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  // GIF87a / GIF89a
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  // TIFF
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00)) return 'image/tiff';
  // RIFF....WEBP / AVI
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF') {
    const form = b.subarray(8, 12).toString('latin1');
    if (form === 'WEBP') return 'image/webp';
    if (form === 'AVI ') return 'video/x-msvideo';
  }
  // ISO-BMFF: ....ftyp....
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('hevc') || brand.startsWith('mif1')) return 'image/heic';
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand.startsWith('M4A')) return 'audio/mp4';
    return 'video/mp4'; // isom, mp42, avc1, iso2, mmp4, dash...
  }
  // Matroska / WebM: 1A 45 DF A3
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const head = b.subarray(0, Math.min(b.length, 64)).toString('latin1');
    return head.includes('webm') ? 'video/webm' : 'video/x-matroska';
  }
  // FLV
  if (b.subarray(0, 3).toString('latin1') === 'FLV') return 'video/x-flv';
  // MPEG-TS/PS
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && (b[3] === 0xba || b[3] === 0xb3)) return 'video/mpeg';
  // ID3 / MP3 frame
  if (b.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  return undefined;
}

/**
 * @param {string} mime
 * @returns {MediaKind}
 */
export function kindFromMime(mime) {
  if (!mime) return 'unknown';
  if (MIME_TABLE[mime]) return /** @type {MediaKind} */ (MIME_TABLE[mime].kind);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'unknown';
}

/** Nguon media: 'file' | 'url' | 'buffer'. */
export class Media {
  /**
   * @param {object} init
   * @param {'file'|'url'|'buffer'} init.source
   * @param {string} [init.filePath]
   * @param {string} [init.url]
   * @param {Buffer} [init.buffer]
   * @param {string} [init.mime] Ghi de mime (bo qua sniff).
   * @param {MediaKind} [init.kind] Ghi de loai.
   * @param {string} [init.filename]
   * @param {number} [init.size]
   * @param {string} [init.caption] Caption rieng cho media nay (dung cho album).
   * @param {string} [init.thumbnailPath] Anh bia rieng (YouTube/Telegram).
   * @param {number} [init.durationSec]
   * @param {number} [init.width]
   * @param {number} [init.height]
   * @param {string} [init.altText]
   */
  constructor(init) {
    this.source = init.source;
    this.filePath = init.filePath;
    this.url = init.url;
    this.buffer = init.buffer;
    this.mime = init.mime;
    this.kind = init.kind ?? (init.mime ? kindFromMime(init.mime) : undefined);
    this.filename = init.filename;
    this.size = init.size;
    this.caption = init.caption;
    this.thumbnailPath = init.thumbnailPath;
    this.durationSec = init.durationSec;
    this.width = init.width;
    this.height = init.height;
    this.altText = init.altText;
    /** URL cong khai tam thoi do mediaHost cap (neu co). */
    this.hostedUrl = undefined;
    /** @type {(() => Promise<void>) | undefined} */
    this.cleanupHosted = undefined;
    this._probed = false;
  }

  get isLocal() {
    return this.source === 'file' || this.source === 'buffer';
  }

  get isRemote() {
    return this.source === 'url';
  }

  /** URL cong khai dung duoc (goc hoac do mediaHost cap). */
  get publicUrl() {
    return this.hostedUrl ?? (this.source === 'url' ? this.url : undefined);
  }

  get isImage() {
    return this.kind === 'image';
  }

  get isVideo() {
    return this.kind === 'video';
  }

  get extension() {
    if (this.mime && MIME_TABLE[this.mime]) return MIME_TABLE[this.mime].ext;
    const name = this.filename ?? this.filePath ?? this.url ?? '';
    const ext = path.extname(String(name).split('?')[0]);
    return ext || '';
  }

  /**
   * Nap metadata: size, mime, kind, filename. Goi nhieu lan cung an toan.
   * @param {object} [opts]
   * @param {(url: string, init?: object) => Promise<Response>} [opts.fetchImpl]
   * @param {AbortSignal} [opts.signal]
   * @param {boolean} [opts.probeRemote=true] Cho phep goi HEAD len URL de lay mime/size.
   * @returns {Promise<this>}
   */
  async load(opts = {}) {
    if (this._probed) return this;
    const { fetchImpl = fetch, signal, probeRemote = true } = opts;

    if (this.source === 'buffer') {
      if (!Buffer.isBuffer(this.buffer)) throw new MediaError('Media buffer khong hop le');
      this.size = this.buffer.byteLength;
      this.mime ??= sniffMime(this.buffer.subarray(0, 64)) ?? mimeFromName(this.filename);
      this.filename ??= `upload${this.extension || '.bin'}`;
    } else if (this.source === 'file') {
      const p = /** @type {string} */ (this.filePath);
      let st;
      try {
        st = await stat(p);
      } catch (err) {
        throw new MediaError(`Khong doc duoc file media: ${p}`, { cause: err, details: { filePath: p } });
      }
      if (!st.isFile()) throw new MediaError(`Duong dan media khong phai file: ${p}`);
      if (st.size === 0) throw new MediaError(`File media rong: ${p}`);
      this.size = st.size;
      this.filename ??= path.basename(p);
      if (!this.mime) {
        const head = await this.readRange(0, Math.min(63, st.size - 1));
        this.mime = sniffMime(head) ?? mimeFromName(p);
      }
    } else if (this.source === 'url') {
      this.filename ??= filenameFromUrl(/** @type {string} */ (this.url));
      this.mime ??= mimeFromName(this.filename);
      if (probeRemote && (!this.mime || this.size == null)) {
        await this._probeRemote(fetchImpl, signal);
      }
    }

    this.kind ??= this.mime ? kindFromMime(this.mime) : 'unknown';
    if (!this.mime) {
      throw new MediaError('Khong xac dinh duoc dinh dang media. Hay truyen ro `mime` hoac `type`.', {
        details: { source: this.source, filename: this.filename, url: this.url },
      });
    }
    if (this.kind === 'unknown') this.kind = kindFromMime(this.mime);
    this._probed = true;
    return this;
  }

  /** @param {typeof fetch} fetchImpl @param {AbortSignal} [signal] */
  async _probeRemote(fetchImpl, signal) {
    try {
      let res = await fetchImpl(/** @type {string} */ (this.url), { method: 'HEAD', redirect: 'follow', signal });
      // Nhieu CDN chan HEAD -> thu GET 1 byte.
      if (!res.ok || !res.headers.get('content-type')) {
        res = await fetchImpl(/** @type {string} */ (this.url), {
          method: 'GET',
          headers: { Range: 'bytes=0-63' },
          redirect: 'follow',
          signal,
        });
      }
      const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      const len = Number(res.headers.get('content-length'));
      if (ct && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') this.mime ??= ct;
      if (Number.isFinite(len) && len > 0 && !res.headers.get('content-range')) this.size ??= len;
      const cr = res.headers.get('content-range');
      if (cr) {
        const total = Number(cr.split('/')[1]);
        if (Number.isFinite(total)) this.size ??= total;
      }
      if (!this.mime && res.body && res.status === 206) {
        // Chi doc khi server TON TRONG Range (206). Neu khong, day co the la ca file
        // vai tram MB -> khong duoc nap vao RAM.
        const buf = Buffer.from(await res.arrayBuffer());
        this.mime ??= sniffMime(buf);
      } else if (res.body) {
        // Huy body de giai phong ket noi ma khong tai het du lieu.
        await res.body.cancel().catch(() => {});
      }
    } catch {
      // Khong probe duoc thi thoi, dua vao duoi file / mime nguoi dung truyen.
    }
  }

  /**
   * Doc mot doan byte [start, end] (bao gom ca end) - khong nap ca file.
   * @param {number} start
   * @param {number} end
   * @returns {Promise<Buffer>}
   */
  async readRange(start, end) {
    const length = end - start + 1;
    if (length <= 0) return Buffer.alloc(0);
    if (this.source === 'buffer') {
      return /** @type {Buffer} */ (this.buffer).subarray(start, end + 1);
    }
    if (this.source === 'file') {
      const fh = await open(/** @type {string} */ (this.filePath), 'r');
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, start);
        return bytesRead === length ? buf : buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    }
    // URL: dung HTTP Range. PHAI kiem tra 206, vi server bo qua Range se tra CA FILE
    // tu byte 0 -> chunk gui len nen tang se sai hoan toan ma khong co loi nao.
    const res = await fetch(/** @type {string} */ (this.url), {
      headers: { Range: `bytes=${start}-${end}` },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new MediaError(`Khong tai duoc range tu URL (HTTP ${res.status})`, { details: { url: this.url } });
    }
    const wantsPartial = !(start === 0 && end >= (this.size ?? Infinity) - 1);
    if (wantsPartial && res.status !== 206) {
      await res.body?.cancel?.().catch(() => {});
      throw new MediaError(
        `Server khong ho tro HTTP Range (tra ve ${res.status} thay vi 206) - khong the doc tung phan an toan`,
        {
          details: { url: this.url, status: res.status, start, end },
          hint: 'Tai file ve dia truoc (hoac dung media dang file/buffer) roi hay upload theo chunk.',
        },
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > length) {
      throw new MediaError(
        `Server tra ve ${buf.byteLength} byte thay vi ${length} byte da yeu cau`,
        { details: { url: this.url, start, end } },
      );
    }
    return buf;
  }

  /**
   * Nap toan bo media vao Buffer. Can than voi video lon.
   * @param {object} [opts]
   * @param {number} [opts.maxBytes] Nem loi neu vuot nguong.
   * @returns {Promise<Buffer>}
   */
  async toBuffer(opts = {}) {
    const { maxBytes } = opts;
    if (maxBytes != null && this.size != null && this.size > maxBytes) {
      throw new MediaError(
        `Media ${formatBytes(this.size)} vuot gioi han ${formatBytes(maxBytes)}`,
        { details: { size: this.size, maxBytes } },
      );
    }
    if (this.source === 'buffer') return /** @type {Buffer} */ (this.buffer);
    if (this.source === 'file') {
      const { readFile } = await import('node:fs/promises');
      return readFile(/** @type {string} */ (this.filePath));
    }
    const res = await fetch(/** @type {string} */ (this.url), { redirect: 'follow' });
    if (!res.ok) throw new MediaError(`Khong tai duoc media tu URL (HTTP ${res.status})`, { details: { url: this.url } });
    const buf = Buffer.from(await res.arrayBuffer());
    if (maxBytes != null && buf.byteLength > maxBytes) {
      throw new MediaError(`Media ${formatBytes(buf.byteLength)} vuot gioi han ${formatBytes(maxBytes)}`);
    }
    return buf;
  }

  /**
   * Stream doc (dung cho upload multipart lon).
   * @returns {Promise<ReadableStream<Uint8Array> | import('node:stream').Readable>}
   */
  async toStream() {
    if (this.source === 'file') return createReadStream(/** @type {string} */ (this.filePath));
    if (this.source === 'buffer') {
      const { Readable } = await import('node:stream');
      return Readable.from(/** @type {Buffer} */ (this.buffer));
    }
    const res = await fetch(/** @type {string} */ (this.url), { redirect: 'follow' });
    if (!res.ok || !res.body) throw new MediaError(`Khong stream duoc media tu URL (HTTP ${res.status})`);
    return res.body;
  }

  /**
   * Tao Blob de nhet vao FormData (multipart upload).
   * Luu y: Blob giu du lieu trong RAM -> chi dung cho file vua phai.
   * @param {object} [opts]
   * @param {number} [opts.maxBytes]
   * @returns {Promise<Blob>}
   */
  async toBlob(opts = {}) {
    const buf = await this.toBuffer(opts);
    return new Blob([buf], { type: this.mime ?? 'application/octet-stream' });
  }

  /**
   * Lay duration/width/height bang ffprobe (neu co). Khong co ffprobe thi bo qua.
   * @param {object} [opts]
   * @param {string} [opts.ffprobePath='ffprobe']
   * @param {number} [opts.timeoutMs=15000]
   * @returns {Promise<{durationSec?: number, width?: number, height?: number, fps?: number, hasAudio?: boolean} | null>}
   */
  async probeWithFfprobe(opts = {}) {
    const { ffprobePath = process.env.FFPROBE_PATH || 'ffprobe', timeoutMs = 15_000 } = opts;
    const target = this.filePath ?? this.publicUrl;
    if (!target) return null;
    try {
      const json = await runFfprobe(ffprobePath, target, timeoutMs);
      const streams = json.streams ?? [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      const durationSec = Number(json.format?.duration ?? v?.duration);
      const out = {
        durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
        width: v?.width,
        height: v?.height,
        fps: parseFps(v?.avg_frame_rate),
        hasAudio: Boolean(a),
      };
      if (out.durationSec != null) this.durationSec ??= out.durationSec;
      if (out.width) this.width ??= out.width;
      if (out.height) this.height ??= out.height;
      return out;
    } catch {
      return null; // ffprobe khong co san -> khong phai loi
    }
  }

  /** Ty le khung hinh (vd 0.5625 = 9:16). */
  get aspectRatio() {
    if (!this.width || !this.height) return undefined;
    return this.width / this.height;
  }

  /** Video doc (9:16) -> phu hop Reels/Shorts/TikTok. */
  get isVertical() {
    const r = this.aspectRatio;
    return r != null && r < 1;
  }

  toJSON() {
    return {
      source: this.source,
      filename: this.filename,
      mime: this.mime,
      kind: this.kind,
      size: this.size,
      url: this.url,
      hostedUrl: this.hostedUrl,
      width: this.width,
      height: this.height,
      durationSec: this.durationSec,
    };
  }
}

/**
 * Chuyen input linh hoat cua nguoi dung thanh `Media`.
 *
 * Chap nhan:
 *  - `'./anh.jpg'`, `'https://.../video.mp4'`
 *  - `{ path: './a.mp4', thumbnail: './t.jpg' }`
 *  - `{ url: 'https://...', type: 'image' }`
 *  - `{ buffer: <Buffer>, filename: 'a.png', mime: 'image/png' }`
 *  - `Media` (tra ve nguyen)
 *
 * @param {unknown} input
 * @returns {Media}
 */
export function toMedia(input) {
  if (input instanceof Media) return input;
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) throw new MediaError('Media rong');
    return isHttpUrl(s)
      ? new Media({ source: 'url', url: s })
      : new Media({ source: 'file', filePath: path.resolve(s) });
  }
  if (Buffer.isBuffer(input)) {
    return new Media({ source: 'buffer', buffer: input });
  }
  if (input && typeof input === 'object') {
    const o = /** @type {Record<string, any>} */ (input);
    const mime = o.mime ?? o.mimeType ?? o.contentType;
    const kind = normalizeKind(o.type ?? o.kind);
    const common = {
      mime,
      kind,
      filename: o.filename ?? o.name,
      caption: o.caption,
      thumbnailPath: o.thumbnail ?? o.thumbnailPath ?? o.cover,
      durationSec: o.duration ?? o.durationSec,
      width: o.width,
      height: o.height,
      altText: o.altText ?? o.alt,
      size: o.size,
    };
    if (o.buffer || o.data) {
      const buffer = o.buffer ?? o.data;
      if (!Buffer.isBuffer(buffer)) {
        return new Media({ ...common, source: 'buffer', buffer: Buffer.from(buffer) });
      }
      return new Media({ ...common, source: 'buffer', buffer });
    }
    if (o.url ?? o.href) {
      return new Media({ ...common, source: 'url', url: String(o.url ?? o.href) });
    }
    if (o.path ?? o.file ?? o.filePath) {
      const p = String(o.path ?? o.file ?? o.filePath);
      return isHttpUrl(p)
        ? new Media({ ...common, source: 'url', url: p })
        : new Media({ ...common, source: 'file', filePath: path.resolve(p) });
    }
  }
  throw new MediaError('Media khong hop le: can string duong dan/URL, {path}, {url} hoac {buffer}', {
    details: { received: typeof input },
  });
}

/**
 * Chuan hoa `media` dau vao (mot hoac nhieu) thanh mang Media da load metadata.
 * @param {unknown} input
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Media[]>}
 */
export async function normalizeMediaList(input, opts = {}) {
  if (input == null) return [];
  const list = Array.isArray(input) ? input : [input];
  const medias = list.filter((x) => x != null).map(toMedia);
  await Promise.all(medias.map((m) => m.load(opts)));
  return medias;
}

/** @param {string} s */
export function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s));
}

/** @param {string|undefined} name */
function mimeFromName(name) {
  if (!name) return undefined;
  const ext = path.extname(String(name).split('?')[0]).toLowerCase();
  return EXT_TO_MIME[ext];
}

/** @param {string} url */
function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    return base || 'media';
  } catch {
    return 'media';
  }
}

/** @param {unknown} k @returns {MediaKind|undefined} */
function normalizeKind(k) {
  if (!k) return undefined;
  const s = String(k).toLowerCase();
  if (s === 'image' || s === 'photo' || s === 'picture' || s === 'img') return 'image';
  if (s === 'video' || s === 'reel' || s === 'reels' || s === 'short' || s === 'shorts') return 'video';
  if (s === 'audio') return 'audio';
  return undefined;
}

/** @param {string|undefined} rate */
function parseFps(rate) {
  if (!rate || typeof rate !== 'string') return undefined;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return undefined;
  return Math.round((num / den) * 100) / 100;
}

/**
 * @param {string} bin
 * @param {string} target
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function runFfprobe(bin, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      target,
    ], { windowsHide: true });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('ffprobe timeout'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffprobe exit ${code}: ${err.slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}
