/**
 * Doc cau hinh tu bien moi truong (.env) va dung san SocialPoster.
 *
 * Muc dich: chay duoc ngay bang `.env` ma khong phai viet code cau hinh.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError } from './errors.js';
import { FileTokenStore, MemoryTokenStore } from './tokenstore.js';
import { S3MediaHost } from './mediahost/s3.js';
import { LocalTunnelMediaHost } from './mediahost/localserver.js';

/**
 * Nap file .env vao process.env (dung API co san cua Node >= 20.6).
 * Khong ghi de bien moi truong da ton tai.
 *
 * @param {string} [file='.env']
 * @returns {boolean} true neu da nap duoc file.
 */
export function loadEnvFile(file = '.env') {
  const p = path.resolve(file);
  if (!existsSync(p)) return false;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(p);
    return true;
  }
  // Node < 20.12 khong co process.loadEnvFile -> tu parse (don gian nhung du dung).
  try {
    const raw = readFileSync(p, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq === -1) continue;
      const key = s.slice(0, eq).trim().replace(/^export\s+/, '');
      let value = s.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Khong ghi de bien moi truong da co (giong process.loadEnvFile).
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return true;
  } catch {
    return false;
  }
}

/** @param {Record<string,string|undefined>} env @param {string} key */
function bool(env, key, fallback = undefined) {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** @param {Record<string,string|undefined>} env @param {string} key */
function num(env, key, fallback = undefined) {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** @param {string|undefined} v */
function list(v) {
  if (!v) return undefined;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Dung cau hinh `platforms` tu bien moi truong.
 * Chi nen tang nao co du bien bat buoc moi duoc bat.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {Record<string, any>}
 */
export function platformsFromEnv(env = process.env) {
  /** @type {Record<string, any>} */
  const platforms = {};

  // ---------------------------------------------------------------- YouTube
  if (env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN) {
    platforms.youtube = {
      clientId: env.YOUTUBE_CLIENT_ID,
      clientSecret: env.YOUTUBE_CLIENT_SECRET,
      refreshToken: env.YOUTUBE_REFRESH_TOKEN,
      accessToken: env.YOUTUBE_ACCESS_TOKEN,
      defaults: {
        privacyStatus: env.YOUTUBE_PRIVACY_STATUS ?? 'private',
        categoryId: env.YOUTUBE_CATEGORY_ID ?? '22',
        madeForKids: bool(env, 'YOUTUBE_MADE_FOR_KIDS', false),
        defaultLanguage: env.YOUTUBE_DEFAULT_LANGUAGE,
        notifySubscribers: bool(env, 'YOUTUBE_NOTIFY_SUBSCRIBERS', true),
        playlistId: env.YOUTUBE_PLAYLIST_ID,
      },
      chunkSizeBytes: num(env, 'YOUTUBE_CHUNK_SIZE_BYTES'),
    };
  }

  // --------------------------------------------------------------- Facebook
  if (env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_ACCESS_TOKEN) {
    platforms.facebook = {
      pageId: env.FACEBOOK_PAGE_ID,
      pageAccessToken: env.FACEBOOK_PAGE_ACCESS_TOKEN,
      graphVersion: env.FACEBOOK_GRAPH_VERSION,
      defaults: {
        published: bool(env, 'FACEBOOK_PUBLISHED'),
        // Khong dat mac dinh: de undefined thi adapter tu nhan biet Reel theo media.
        asReel: bool(env, 'FACEBOOK_AS_REEL'),
      },
    };
  }

  // -------------------------------------------------------------- Instagram
  if (env.INSTAGRAM_USER_ID && (env.INSTAGRAM_ACCESS_TOKEN || env.FACEBOOK_PAGE_ACCESS_TOKEN)) {
    platforms.instagram = {
      igUserId: env.INSTAGRAM_USER_ID,
      accessToken: env.INSTAGRAM_ACCESS_TOKEN ?? env.FACEBOOK_PAGE_ACCESS_TOKEN,
      graphVersion: env.INSTAGRAM_GRAPH_VERSION ?? env.FACEBOOK_GRAPH_VERSION,
      useInstagramLogin: bool(env, 'INSTAGRAM_USE_INSTAGRAM_LOGIN', false),
      defaults: {
        shareToFeed: bool(env, 'INSTAGRAM_SHARE_TO_FEED', true),
        mediaTypeForVideo: env.INSTAGRAM_VIDEO_MEDIA_TYPE,
      },
    };
  }

  // ----------------------------------------------------------------- TikTok
  if (env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET && (env.TIKTOK_REFRESH_TOKEN || env.TIKTOK_ACCESS_TOKEN)) {
    platforms.tiktok = {
      clientKey: env.TIKTOK_CLIENT_KEY,
      clientSecret: env.TIKTOK_CLIENT_SECRET,
      refreshToken: env.TIKTOK_REFRESH_TOKEN,
      accessToken: env.TIKTOK_ACCESS_TOKEN,
      defaults: {
        privacyLevel: env.TIKTOK_PRIVACY_LEVEL,
        postMode: env.TIKTOK_POST_MODE,
        disableComment: bool(env, 'TIKTOK_DISABLE_COMMENT'),
        disableDuet: bool(env, 'TIKTOK_DISABLE_DUET'),
        disableStitch: bool(env, 'TIKTOK_DISABLE_STITCH'),
        autoAddMusic: bool(env, 'TIKTOK_AUTO_ADD_MUSIC'),
        brandContentToggle: bool(env, 'TIKTOK_BRAND_CONTENT_TOGGLE'),
        brandOrganicToggle: bool(env, 'TIKTOK_BRAND_ORGANIC_TOGGLE'),
        isAigc: bool(env, 'TIKTOK_IS_AIGC'),
      },
    };
  }

  // --------------------------------------------------------------- Telegram
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    platforms.telegram = {
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: list(env.TELEGRAM_CHAT_ID)?.length === 1 ? env.TELEGRAM_CHAT_ID : list(env.TELEGRAM_CHAT_ID),
      apiBaseUrl: env.TELEGRAM_API_BASE_URL,
      defaults: {
        parseMode: env.TELEGRAM_PARSE_MODE ?? 'HTML',
        disableNotification: bool(env, 'TELEGRAM_DISABLE_NOTIFICATION'),
        protectContent: bool(env, 'TELEGRAM_PROTECT_CONTENT'),
        messageThreadId: num(env, 'TELEGRAM_MESSAGE_THREAD_ID'),
      },
    };
  }

  return platforms;
}

/**
 * Tao MediaHost tu bien moi truong (uu tien S3, roi den local tunnel).
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {object} [ctx]
 * @param {import('./logger.js').Logger} [ctx.logger]
 * @returns {import('./mediahost/index.js').MediaHost | undefined}
 */
export function mediaHostFromEnv(env = process.env, ctx = {}) {
  if (env.WAM_S3_BUCKET && env.WAM_S3_ACCESS_KEY_ID && env.WAM_S3_SECRET_ACCESS_KEY) {
    return new S3MediaHost({
      bucket: env.WAM_S3_BUCKET,
      accessKeyId: env.WAM_S3_ACCESS_KEY_ID,
      secretAccessKey: env.WAM_S3_SECRET_ACCESS_KEY,
      region: env.WAM_S3_REGION ?? 'auto',
      endpoint: env.WAM_S3_ENDPOINT,
      publicBaseUrl: env.WAM_S3_PUBLIC_BASE_URL,
      forcePathStyle: bool(env, 'WAM_S3_FORCE_PATH_STYLE'),
      prefix: env.WAM_S3_PREFIX,
      acl: env.WAM_S3_ACL,
      deleteAfterPost: bool(env, 'WAM_S3_DELETE_AFTER_POST', true),
      logger: ctx.logger,
    });
  }
  if (env.WAM_PUBLIC_BASE_URL) {
    return new LocalTunnelMediaHost({
      publicBaseUrl: env.WAM_PUBLIC_BASE_URL,
      port: num(env, 'WAM_PUBLIC_PORT', 8787),
      hostname: env.WAM_PUBLIC_HOSTNAME,
      logger: ctx.logger,
    });
  }
  return undefined;
}

/**
 * Tao toan bo options cho `new SocialPoster(...)` tu bien moi truong.
 *
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env=process.env]
 * @param {string | false} [opts.envFile='.env'] Dat false de khong nap file .env.
 * @param {import('./logger.js').Logger} [opts.logger]
 * @param {boolean} [opts.requireAtLeastOne=true]
 * @returns {{platforms: Record<string, any>, store: import('./tokenstore.js').TokenStore, mediaHost?: any, dryRun: boolean, concurrency: number, logger?: any}}
 */
export function configFromEnv(opts = {}) {
  const { envFile = '.env', requireAtLeastOne = true } = opts;
  if (envFile !== false) loadEnvFile(envFile);
  const env = opts.env ?? process.env;

  const platforms = platformsFromEnv(env);
  if (requireAtLeastOne && Object.keys(platforms).length === 0) {
    throw new ConfigError(
      'No platform configuration was found in the environment. See .env.example for the variables to set.',
      { hint: 'Minimal example: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID' },
    );
  }

  const storePath = env.WAM_TOKEN_STORE;
  return {
    platforms,
    store: storePath ? new FileTokenStore(storePath) : new MemoryTokenStore(),
    mediaHost: mediaHostFromEnv(env, { logger: opts.logger }),
    dryRun: bool(env, 'WAM_DRY_RUN', false) ?? false,
    concurrency: num(env, 'WAM_CONCURRENCY', 3) ?? 3,
    logger: opts.logger ?? { level: env.WAM_LOG_LEVEL ?? 'info', format: env.WAM_LOG_FORMAT === 'json' ? 'json' : 'pretty' },
  };
}
