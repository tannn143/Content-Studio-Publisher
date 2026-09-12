/**
 * MediaHost: bien file local thanh URL CONG KHAI tam thoi.
 *
 * Vi sao can:
 *  - Instagram Graph API chi nhan `image_url` / `video_url` la URL cong khai,
 *    KHONG cho upload file truc tiep.
 *  - TikTok dang anh (PHOTO) cung chi nhan PULL_FROM_URL.
 *
 * Neu media dau vao da la URL cong khai thi khong can MediaHost.
 */

import { ConfigError, MediaError } from '../errors.js';

/**
 * @typedef {object} HostedMedia
 * @property {string} url        URL cong khai, API nen tang tai duoc.
 * @property {() => Promise<void>} [cleanup] Xoa file tam sau khi dang xong.
 * @property {number} [expiresInSec]
 */

/**
 * @typedef {object} MediaHost
 * @property {string} name
 * @property {(media: import('../media.js').Media, ctx?: object) => Promise<HostedMedia>} host
 */

/**
 * Boc mot ham thanh MediaHost.
 *
 * @example
 * new FunctionMediaHost(async (media) => {
 *   const buf = await media.toBuffer();
 *   const url = await myCdn.upload(buf, media.filename);
 *   return { url };
 * })
 */
export class FunctionMediaHost {
  /**
   * @param {(media: import('../media.js').Media, ctx?: object) => Promise<string | HostedMedia>} fn
   * @param {string} [name='function']
   */
  constructor(fn, name = 'function') {
    if (typeof fn !== 'function') throw new ConfigError('FunctionMediaHost can mot ham upload');
    this.fn = fn;
    this.name = name;
  }

  /**
   * @param {import('../media.js').Media} media
   * @param {object} [ctx]
   * @returns {Promise<HostedMedia>}
   */
  async host(media, ctx) {
    const res = await this.fn(media, ctx);
    if (typeof res === 'string') return { url: res };
    if (!res?.url) throw new MediaError('The MediaHost returned no URL');
    return res;
  }
}

/**
 * MediaHost "khong lam gi": chi cho qua neu media da co URL cong khai.
 * Dung lam mac dinh de bao loi ro rang thay vi loi la tu API nen tang.
 */
export class NoopMediaHost {
  constructor() {
    this.name = 'noop';
  }

  /** @param {import('../media.js').Media} media */
  async host(media) {
    if (media.publicUrl) return { url: media.publicUrl };
    throw new ConfigError(
      'This platform requires a public URL, but the media is a local file and no `mediaHost` is configured. '
      + 'Pass the media as a URL, or configure a mediaHost (S3MediaHost / FunctionMediaHost / LocalTunnelMediaHost).',
      { hint: 'Xem README muc "Media cong khai (mediaHost)".' },
    );
  }
}

/**
 * Bao dam media co URL cong khai; tra ve ham cleanup de goi sau khi dang xong.
 *
 * @param {import('../media.js').Media} media
 * @param {MediaHost | undefined} mediaHost
 * @param {object} [ctx]
 * @returns {Promise<{url: string, cleanup?: () => Promise<void>, hosted: boolean}>}
 */
export async function ensurePublicUrl(media, mediaHost, ctx = {}) {
  if (media.publicUrl) return { url: media.publicUrl, hosted: false };
  const hostImpl = mediaHost ?? new NoopMediaHost();
  const res = await hostImpl.host(media, ctx);
  media.hostedUrl = res.url;
  media.cleanupHosted = res.cleanup;
  return { url: res.url, cleanup: res.cleanup, hosted: true };
}

export { S3MediaHost } from './s3.js';
export { LocalTunnelMediaHost } from './localserver.js';
