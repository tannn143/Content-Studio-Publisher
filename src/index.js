/**
 * wallpaper-auto-marketing
 * Module Node.js tu dong dang bai len YouTube, Facebook, Instagram, TikTok, Telegram.
 *
 * Cach dung nhanh:
 *
 *   import { SocialPoster } from 'wallpaper-auto-marketing';
 *
 *   const poster = new SocialPoster({
 *     platforms: {
 *       telegram: { botToken: '...', chatId: '@mychannel' },
 *       youtube: { clientId: '...', clientSecret: '...', refreshToken: '...' },
 *     },
 *   });
 *
 *   const report = await poster.post({
 *     title: 'Hinh nen 4K - Bo suu tap thang 9',
 *     description: 'Tai mien phi tai website cua chung toi.',
 *     media: ['./wallpapers/preview.jpg'],
 *     hashtags: ['wallpaper', '4k', 'hinhnen'],
 *   });
 *
 *   console.log(report.succeeded, report.failed);
 */

// --------------------------------------------------------------------- core
export { SocialPoster } from './core/poster.js';
export { Post, normalizePost } from './core/post.js';
export { Media, toMedia, normalizeMediaList, sniffMime, kindFromMime, formatBytes } from './core/media.js';
export { HttpClient, defaultMapError, appendQuery, encodeForm, parseRetryAfter } from './core/http.js';
export { createLogger, noopLogger, redact, LOG_LEVELS } from './core/logger.js';
export { retry, pollUntil, sleep, computeBackoff } from './core/retry.js';
export { createLimiter, mapSettledLimit } from './core/limit.js';
export {
  MemoryTokenStore,
  FileTokenStore,
  AccessTokenManager,
} from './core/tokenstore.js';
export {
  buildCaption,
  normalizeHashtags,
  formatHashtags,
  extractHashtags,
  stripHashtags,
  truncate,
  graphemeLength,
  escapeHtml,
  escapeMarkdownV2,
  sanitizeText,
  slugify,
} from './core/text.js';
export {
  configFromEnv,
  platformsFromEnv,
  mediaHostFromEnv,
  loadEnvFile,
} from './core/config.js';

// ------------------------------------------------------------------- errors
export {
  ErrorCode,
  SocialPostError,
  ValidationError,
  ConfigError,
  AuthError,
  RateLimitError,
  QuotaError,
  MediaError,
  UnsupportedError,
  NetworkError,
  TimeoutError,
  AbortError,
  ProcessingError,
  PlatformError,
  AggregatePostError,
  toSocialPostError,
} from './core/errors.js';

// ---------------------------------------------------------------- mediahost
export {
  FunctionMediaHost,
  NoopMediaHost,
  S3MediaHost,
  LocalTunnelMediaHost,
  ensurePublicUrl,
} from './core/mediahost/index.js';

// ---------------------------------------------------------------- platforms
export {
  BasePlatform,
  YouTubePlatform,
  FacebookPlatform,
  InstagramPlatform,
  TikTokPlatform,
  TelegramPlatform,
  PLATFORM_REGISTRY,
  SUPPORTED_PLATFORMS,
  capabilitiesTable,
} from './platforms/index.js';

// ------------------------------------------------------------------ tien ich

import { SocialPoster } from './core/poster.js';
import { configFromEnv } from './core/config.js';

/**
 * Tao SocialPoster tu bien moi truong (.env). Tien cho script/cron.
 *
 * @param {object} [opts]
 * @param {string | false} [opts.envFile='.env']
 * @param {Record<string, any>} [opts.override] Ghi de cau hinh sau khi doc env.
 * @returns {SocialPoster}
 *
 * @example
 * const poster = createPosterFromEnv();
 * await poster.post({ title: 'Hi', media: './a.jpg' });
 */
export function createPosterFromEnv(opts = {}) {
  const cfg = configFromEnv({ envFile: opts.envFile });
  return new SocialPoster({ ...cfg, ...(opts.override ?? {}) });
}

/**
 * Dang mot bai len nhieu nen tang trong mot lan goi (khong can tu tao SocialPoster).
 *
 * @param {import('./core/post.js').PostInput} post
 * @param {object} [opts] Cac option cua SocialPoster.
 * @returns {Promise<import('./core/poster.js').PostReport>}
 *
 * @example
 * await postToAll(
 *   { title: 'Hinh nen moi', media: './a.jpg', hashtags: ['wallpaper'] },
 *   { platforms: { telegram: { botToken: '...', chatId: '@ch' } } },
 * );
 */
export async function postToAll(post, opts = {}) {
  const poster = new SocialPoster(opts);
  try {
    return await poster.post(post);
  } finally {
    await poster.close();
  }
}

export default SocialPoster;
