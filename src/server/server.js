/**
 * Admin server: REST API + web UI + OAuth callback + SSE.
 *
 * Mo hinh giong Buffer:
 *  - Ket noi kenh bang OAuth (Google/Facebook/TikTok) hoac bot token (Telegram)
 *  - Soan 1 noi dung -> chon nhieu kenh -> xem truoc theo tung kenh
 *  - Dang ngay hoac dua vao QUEUE theo khung gio
 *
 * Chay: `npx wam serve` hoac `node bin/cli.js serve`
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlink } from 'node:fs/promises';

import {
  HttpError,
  Router,
  readJsonBody,
  pipeBodyToFile,
  sendJson,
  sendText,
  sendFile,
  safeJoin,
  safeEqual,
  generateToken,
  parseIntParam,
} from './http-util.js';
import { EventBus, createEventLogger } from './events.js';
import { Workspace, publicChannel, DEFAULT_SETTINGS } from '../core/store/workspace.js';
import { PublishService } from '../core/publishservice.js';
import { PostScheduler, nextSlots } from '../core/scheduler.js';
import { OAuthManager, OAUTH_PROVIDERS, connectTelegram } from '../auth/oauth.js';
import { capabilitiesTable, PLATFORM_REGISTRY } from '../platforms/index.js';
import { createLogger } from '../core/logger.js';
import { toSocialPostError } from '../core/errors.js';
import { toMedia } from '../core/media.js';
import { normalizeHashtags, buildCaption } from '../core/text.js';
import { newId } from '../core/store/jsonstore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MAX_UPLOAD_BYTES = Number(process.env.WAM_MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024; // 2GB

/**
 * Cac mime duoc phep tra ve nguyen ban khi xem lai media da upload.
 * Ngoai danh sach nay -> application/octet-stream, de file do nguoi dung tai len
 * khong the chay nhu HTML/SVG tren origin cua admin.
 */
const SAFE_MEDIA_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

/**
 * @param {object} [opts]
 * @param {number} [opts.port=4000]
 * @param {string} [opts.host='127.0.0.1']
 * @param {string} [opts.dataDir='./data']
 * @param {string} [opts.token] Token dang nhap admin. Bo trong = mo tu do (chi khi chay localhost).
 * @param {string} [opts.publicUrl] URL cong khai cua admin (dung dung cho OAuth redirect).
 * @param {boolean} [opts.startScheduler=true]
 * @param {'silent'|'error'|'warn'|'info'|'debug'|'trace'} [opts.logLevel='info']
 */
export async function createAdminServer(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 4000);
  const host = opts.host ?? process.env.WAM_HOST ?? '127.0.0.1';
  const isLocalOnly = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  let token = opts.token ?? process.env.WAM_ADMIN_TOKEN ?? '';
  let generatedToken = false;
  if (!token && !isLocalOnly) {
    // Mo ra ngoai mang ma khong co token la rat nguy hiem -> tu sinh token.
    token = generateToken();
    generatedToken = true;
  }

  const baseLogger = createLogger({ level: opts.logLevel ?? process.env.WAM_LOG_LEVEL ?? 'info' });
  const events = new EventBus();
  const { logger, lines: logLines } = createEventLogger({ events, base: baseLogger });

  const workspace = await new Workspace({ dir: opts.dataDir }).init();

  // Process tat giua luc dang bai se de lai trang thai 'publishing' vinh vien.
  // Khoi dong lai thi dua ve 'failed' de nguoi dung thay va tu quyet dinh dang lai.
  const stuck = await workspace.posts.find((p) => p.status === 'publishing');
  for (const p of stuck) {
    await workspace.updatePost(p.id, {
      status: 'failed',
      note: 'Bi ngat giua luc dang (server khoi dong lai). Kiem tra tren nen tang truoc khi dang lai de tranh trung.',
    });
  }
  const publisher = new PublishService({ workspace, logger, events });
  const scheduler = new PostScheduler({ workspace, publisher, logger, events });
  const oauth = new OAuthManager({
    getCredentials: async () => (await workspace.settings.read()).credentials,
    logger,
  });

  const router = buildRouter({ workspace, publisher, scheduler, oauth, events, logger, logLines, opts: { publicUrl: opts.publicUrl } });

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
    } catch {
      sendText(res, 400, 'URL khong hop le');
      return;
    }

    try {
      // CORS chi mo cho cung origin; admin khong can cross-origin.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { allow: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
        res.end();
        return;
      }

      // ---- chong CSRF ----
      // Trinh duyet TU DONG gui cookie, nen mot website bat ky co the goi API nay
      // (nhat la che do localhost khong token). Chan bang cach kiem tra Origin.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && !isSameOrigin(origin, req, url)) {
          sendJson(res, 403, {
            error: 'Request bi chan vi khac Origin (chong CSRF)',
            code: 'E_CSRF',
            hint: 'Goi API tu chinh trang admin, hoac dung Authorization: Bearer thay vi cookie.',
          });
          return;
        }
      }

      // ---- xac thuc ----
      const needsAuth = Boolean(token);
      const authed = !needsAuth || isAuthorized(req, url, token);
      const isPublicPath = url.pathname === '/api/session' || url.pathname === '/login' || url.pathname.startsWith('/assets/') || url.pathname === '/';

      if (needsAuth && !authed && !isPublicPath) {
        if (url.pathname.startsWith('/api/')) {
          sendJson(res, 401, { error: 'Can dang nhap', code: 'E_UNAUTHORIZED' });
        } else {
          res.writeHead(302, { location: '/' });
          res.end();
        }
        return;
      }

      // ---- API ----
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (matched) {
        const out = await matched.handler({
          req,
          res,
          url,
          params: matched.params,
          query: url.searchParams,
          authed,
          needsAuth,
          token,
        });
        if (out !== undefined && !res.writableEnded) {
          sendJson(res, out?.__status ?? 200, out?.__body ?? out);
        }
        return;
      }

      // ---- file tinh ----
      if (req.method === 'GET' || req.method === 'HEAD') {
        const rel = url.pathname === '/' ? '/index.html' : url.pathname;
        const filePath = safeJoin(PUBLIC_DIR, rel);
        if (filePath) {
          try {
            await sendFile(req, res, filePath, { cacheControl: 'no-cache' });
            return;
          } catch (err) {
            if (/** @type {any} */ (err)?.status !== 404) throw err;
          }
        }
        // SPA fallback
        const index = safeJoin(PUBLIC_DIR, '/index.html');
        if (index) {
          await sendFile(req, res, index, { cacheControl: 'no-cache' });
          return;
        }
      }

      sendJson(res, 404, { error: 'Khong tim thay', path: url.pathname });
    } catch (rawErr) {
      const err = /** @type {any} */ (rawErr);
      const status = err?.status ?? (err?.code === 'E_VALIDATION' || err?.code === 'E_CONFIG' ? 400 : 500);
      const wrapped = toSocialPostError(err);
      if (status >= 500) {
        logger.error('loi server', { path: url?.pathname, error: wrapped.message });
      } else {
        logger.warn('request loi', { path: url?.pathname, status, error: wrapped.message });
      }
      // headersSent moi cho biet da gui header chua (writableEnded thi khong).
      if (res.headersSent) {
        res.destroy();
      } else if (!res.writableEnded) {
        try {
          sendJson(res, status, {
            error: wrapped.message,
            code: wrapped.code,
            hint: /** @type {any} */ (wrapped).hint,
            details: /** @type {any} */ (wrapped).issues ?? undefined,
          });
        } catch {
          res.destroy();
        }
      }
    } finally {
      if (!url?.pathname?.startsWith('/api/events')) {
        logger.debug('http', { method: req.method, path: url?.pathname, ms: Date.now() - started });
      }
    }
  });

  // Upload video lon can thoi gian dai.
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;

  /** @type {{server: http.Server, workspace: Workspace, publisher: PublishService, scheduler: PostScheduler, events: EventBus, url: string, token: string, start: () => Promise<any>, close: () => Promise<void>}} */
  const handle = {
    server,
    workspace,
    publisher,
    scheduler,
    events,
    token,
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(undefined));
      });
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      handle.url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;

      logger.info('admin server dang chay', { url: handle.url, auth: token ? 'co token' : 'khong (chi localhost)' });
      if (generatedToken) {
        logger.warn('server mo ra ngoai localhost nen da tu sinh token dang nhap', { token });
      }
      if (opts.startScheduler !== false) scheduler.start();
      return handle;
    },
    async close() {
      scheduler.stop();
      events.closeAll();
      await publisher.close();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
  return handle;
}

/**
 * Kiem tra token trong header Bearer, cookie, hoac query (cho link OAuth).
 * @param {http.IncomingMessage} req
 * @param {URL} url
 * @param {string} token
 */
function isAuthorized(req, url, token) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), token)) return true;
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.wam_token && safeEqual(cookies.wam_token, token)) return true;
  // KHONG nhan token qua query string: no lot vao access log, header Referer va
  // lich su trinh duyet.
  return false;
}

/**
 * Request co dung origin voi server khong (chong CSRF).
 * @param {string} origin
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 */
function isSameOrigin(origin, req, url) {
  try {
    const o = new URL(origin);
    const hostHeader = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? url.host);
    return o.host === hostHeader;
  } catch {
    return false;
  }
}

/** @param {import('node:http').IncomingMessage} req */
function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return proto === 'https' || Boolean(/** @type {any} */ (req.socket)?.encrypted);
}

/** @param {string|undefined} header */
function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Dung toan bo route.
 */
function buildRouter(deps) {
  const { workspace, publisher, scheduler, oauth, events, logger, logLines, opts } = deps;
  const router = new Router();

  /** URL goc dung de dung redirect_uri cho OAuth. */
  const originOf = (ctx) => {
    if (opts.publicUrl) return String(opts.publicUrl).replace(/\/+$/, '');
    const proto = String(ctx.req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
    const hostHeader = String(ctx.req.headers['x-forwarded-host'] ?? ctx.req.headers.host ?? 'localhost');
    return `${proto}://${hostHeader}`;
  };
  /** URL callback mac dinh, suy ra tu dia chi dang mo web admin. */
  const defaultRedirectUri = (ctx, provider) => `${originOf(ctx)}/oauth/${provider}/callback`;

  /**
   * redirect_uri thuc su gui len nen tang.
   *
   * Cho phep ghi de trong Cai dat vi co nen tang khong nhan callback loopback:
   * TikTok tu choi moi URI khong bat dau bang https, ke ca http://127.0.0.1.
   * Khi do dat redirectUri tro toi mot trang https cau noi, trang do chuyen
   * tiep code/state ve `/oauth/<provider>/callback` cua may nay.
   */
  const redirectUriFor = async (ctx, provider) => {
    const settings = await workspace.settings.read();
    const custom = String(settings.credentials?.[provider]?.redirectUri ?? '').trim();
    return custom ? custom.replace(/\/+$/, '') : defaultRedirectUri(ctx, provider);
  };

  // ------------------------------------------------------------------ session

  router.get('/api/session', async (ctx) => ({
    authRequired: ctx.needsAuth,
    authed: ctx.authed,
    version: '1.0.0',
  }));

  router.post('/api/session', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!ctx.needsAuth) return { ok: true, authed: true };
    if (!safeEqual(String(body.token ?? ''), ctx.token)) {
      throw new HttpError(401, 'Token khong dung');
    }
    ctx.res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `wam_token=${encodeURIComponent(ctx.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`
        + (isHttps(ctx.req) ? '; Secure' : ''),
    });
    ctx.res.end(JSON.stringify({ ok: true, authed: true }));
  });

  router.delete('/api/session', async (ctx) => {
    ctx.res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': 'wam_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    });
    ctx.res.end(JSON.stringify({ ok: true }));
  });

  // ------------------------------------------------------------------- state

  router.get('/api/state', async (ctx) => {
    const [channels, settings, posts] = await Promise.all([
      workspace.listChannels(),
      workspace.settings.read(),
      workspace.listPosts({ limit: 50 }),
    ]);
    return {
      channels: channels.map(publicChannel),
      platforms: capabilitiesTable().map((p) => ({
        ...p,
        limits: p.limits,
        maxImageBytes: p.maxImageBytes,
        maxVideoBytes: p.maxVideoBytes,
      })),
      providers: await Promise.all(Object.values(OAUTH_PROVIDERS).map(async (p) => ({
        id: p.id,
        label: p.label,
        platforms: p.platforms,
        scopes: p.scopes,
        setupHint: p.setupHint,
        credentialFields: p.credentialFields.map((f) => ({ ...f })),
        configured: p.credentialFields
          .filter((f) => f.required)
          .every((f) => Boolean(settings.credentials?.[p.id]?.[f.key])),
        redirectUri: await redirectUriFor(ctx, p.id),
        // Bao cho UI biet URL nay la tu dat hay tu suy ra.
        redirectUriCustom: Boolean(String(settings.credentials?.[p.id]?.redirectUri ?? '').trim()),
      }))),
      settings: redactSettings(settings),
      posts,
      scheduler: scheduler.status(),
      queueCount: posts.filter((p) => p.status === 'queued').length,
    };
  });

  router.get('/api/platforms', async () => ({ platforms: capabilitiesTable() }));

  // ----------------------------------------------------------------- channels

  router.get('/api/channels', async () => ({
    channels: (await workspace.listChannels()).map(publicChannel),
  }));

  router.patch('/api/channels/:id', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const channel = await workspace.channels.get(ctx.params.id);
    if (!channel) throw new HttpError(404, 'Khong tim thay kenh');

    /** @type {Record<string, any>} */
    const patch = {};
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 120);
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.defaults !== undefined && typeof body.defaults === 'object') {
      patch.defaults = { ...(channel.defaults ?? {}), ...body.defaults };
    }
    // Cho phep sua mot so field cau hinh an toan (khong phai token).
    if (body.config && typeof body.config === 'object') {
      const allowed = ['chatId', 'parseMode', 'pageId', 'igUserId', 'privacyLevel', 'postMode', 'categoryId'];
      /** @type {Record<string, any>} */
      const cfg = {};
      for (const k of allowed) if (body.config[k] !== undefined) cfg[k] = body.config[k];
      if (Object.keys(cfg).length > 0) patch.config = { ...channel.config, ...cfg };
    }
    const updated = await workspace.channels.update(ctx.params.id, patch);
    logger.info('cap nhat kenh', { channelId: ctx.params.id, fields: Object.keys(patch) });
    return { channel: publicChannel(/** @type {any} */ (updated)) };
  });

  router.delete('/api/channels/:id', async (ctx) => {
    const ok = await workspace.channels.remove(ctx.params.id);
    if (!ok) throw new HttpError(404, 'Khong tim thay kenh');
    logger.info('da ngat ket noi kenh', { channelId: ctx.params.id });
    events.emit('channels:changed', { removed: ctx.params.id });
    return { ok: true };
  });

  router.post('/api/channels/verify', async () => ({ results: await publisher.verifyChannels() }));

  router.post('/api/channels/:id/verify', async (ctx) => {
    const results = await publisher.verifyChannels(ctx.params.id);
    return { result: results[ctx.params.id] ?? { ok: false, error: 'Khong tim thay kenh' } };
  });

  /**
   * creator_info cua kenh TikTok — web admin dung de dung form dang cho dung
   * yeu cau UX cua TikTok (privacy_level_options, comment/duet/stitch bi khoa).
   */
  router.get('/api/channels/:id/creator-info', async (ctx) => {
    try {
      return { creatorInfo: await publisher.getCreatorInfo(ctx.params.id) };
    } catch (err) {
      const e = /** @type {any} */ (err);
      throw new HttpError(400, e?.message ?? 'Khong lay duoc creator_info', { code: e?.code, hint: e?.hint });
    }
  });

  /** Telegram khong co OAuth -> ket noi bang bot token. */
  router.post('/api/channels/telegram', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const draft = await connectTelegram({ botToken: body.botToken, chatId: body.chatId });
    const channel = await workspace.saveChannel(draft);
    logger.info('da ket noi kenh Telegram', { name: channel.name });
    events.emit('channels:changed', { added: channel.id });
    return { channel: publicChannel(channel) };
  });

  // -------------------------------------------------------------------- oauth

  router.post('/api/oauth/:provider/start', async (ctx) => {
    const provider = ctx.params.provider;
    const { url } = await oauth.createAuthUrl(provider, {
      redirectUri: await redirectUriFor(ctx, provider),
      returnTo: '/#channels',
    });
    logger.info('bat dau ket noi OAuth', { provider });
    return { url };
  });

  router.get('/oauth/:provider/callback', async (ctx) => {
    const code = ctx.query.get('code');
    const state = ctx.query.get('state');
    const error = ctx.query.get('error') ?? ctx.query.get('error_description');

    if (error) {
      return redirectWithMessage(ctx.res, 'error', `Nen tang tu choi: ${error}`);
    }
    if (!code || !state) {
      return redirectWithMessage(ctx.res, 'error', 'Callback thieu code hoac state');
    }

    try {
      const result = await oauth.handleCallback({ code, state });
      /** @type {string[]} */
      const names = [];
      for (const draft of result.channels) {
        const channel = await workspace.saveChannel(draft);
        names.push(`${channel.platform}: ${channel.name}`);
      }
      logger.info('da ket noi kenh qua OAuth', { provider: result.provider, channels: names });
      events.emit('channels:changed', { provider: result.provider, count: names.length });
      return redirectWithMessage(ctx.res, 'success', `Da ket noi ${names.length} kenh: ${names.join(', ')}`);
    } catch (rawErr) {
      const err = toSocialPostError(rawErr);
      logger.error('ket noi OAuth that bai', { error: err.message });
      return redirectWithMessage(ctx.res, 'error', `${err.message}${err.hint ? ` - ${err.hint}` : ''}`);
    }
  });

  // -------------------------------------------------------------------- media

  router.get('/api/media', async () => {
    const items = await workspace.media.all();
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { media: items.map(publicMedia) };
  });

  /**
   * Upload: body la BYTE THO, ten file nam o header `x-filename`.
   * Lam vay de khong phai parse multipart va khong nap file vao RAM.
   */
  router.post('/api/media', async (ctx) => {
    // Client encodeURIComponent ten file de header luon la ASCII -> server phai decode,
    // neu khong ten tieng Viet se bi luu thanh 'H%C3%ACnh...'.
    const rawName = String(ctx.req.headers['x-filename'] ?? ctx.query.get('filename') ?? 'upload.bin');
    let decodedName = rawName;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      // Ten khong phai percent-encoding hop le -> dung nguyen ban.
    }
    const filename = sanitizeFilename(decodedName);
    const id = newId('m');
    const ext = path.extname(filename) || '';
    const storedPath = path.join(workspace.uploadsDir, `${id}${ext}`);

    const size = await pipeBodyToFile(ctx.req, storedPath, MAX_UPLOAD_BYTES);
    if (size === 0) {
      await unlink(storedPath).catch(() => {});
      throw new HttpError(400, 'File rong');
    }

    // Nhan dang mime bang magic bytes + lay duration/kich thuoc neu co ffprobe.
    const media = toMedia({ path: storedPath, filename });
    try {
      await media.load();
    } catch (err) {
      await unlink(storedPath).catch(() => {});
      throw new HttpError(400, `Khong doc duoc file: ${/** @type {Error} */ (err).message}`);
    }
    if (media.kind !== 'image' && media.kind !== 'video') {
      await unlink(storedPath).catch(() => {});
      throw new HttpError(400, `Chi ho tro anh va video (file nay la ${media.mime})`);
    }
    await media.probeWithFfprobe().catch(() => null);

    const rec = await workspace.addMedia({
      filename,
      mime: /** @type {string} */ (media.mime),
      kind: /** @type {string} */ (media.kind),
      size,
      storedPath,
      width: media.width,
      height: media.height,
      durationSec: media.durationSec,
    });
    logger.info('da upload media', { filename, size, mime: media.mime, kind: media.kind });
    return { media: publicMedia(rec) };
  });

  router.get('/api/media/:id/file', async (ctx) => {
    const rec = await workspace.media.get(ctx.params.id);
    if (!rec) throw new HttpError(404, 'Khong tim thay media');
    // Content-Type lay tu mime DA SNIFF bang magic bytes (khong phai tu client),
    // kem CSP + nosniff de mot file do nguoi dung tai len khong the chay script
    // tren origin cua admin.
    await sendFile(ctx.req, ctx.res, rec.storedPath, {
      cacheControl: 'private, max-age=3600',
      contentType: SAFE_MEDIA_MIME.has(rec.mime) ? rec.mime : 'application/octet-stream',
      extraHeaders: {
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
      },
    });
  });

  router.delete('/api/media/:id', async (ctx) => {
    const ok = await workspace.removeMedia(ctx.params.id);
    if (!ok) throw new HttpError(404, 'Khong tim thay media');
    return { ok: true };
  });

  // -------------------------------------------------------------------- posts

  router.get('/api/posts', async (ctx) => {
    const status = ctx.query.get('status')?.split(',').filter(Boolean);
    const limit = parseIntParam(ctx.query.get('limit'), 100, { min: 1, max: 1000 });
    const posts = await workspace.listPosts({ status, limit });
    return { posts };
  });

  router.post('/api/posts', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const draft = await validatePostBody(body, workspace);
    const post = await workspace.createPost(draft);
    logger.info('da tao bai dang', { postId: post.id, status: post.status, channels: post.channelIds.length });
    events.emit('posts:changed', { added: post.id });
    return { post };
  });

  router.get('/api/posts/:id', async (ctx) => {
    const post = await workspace.posts.get(ctx.params.id);
    if (!post) throw new HttpError(404, 'Khong tim thay bai dang');
    return { post };
  });

  router.patch('/api/posts/:id', async (ctx) => {
    const existing = await workspace.posts.get(ctx.params.id);
    if (!existing) throw new HttpError(404, 'Khong tim thay bai dang');
    if (existing.status === 'publishing') throw new HttpError(409, 'Bai dang dang duoc gui, khong sua duoc');

    const body = await readJsonBody(ctx.req);
    const draft = await validatePostBody({ ...toBody(existing), ...body }, workspace);
    const post = await workspace.updatePost(ctx.params.id, {
      content: draft.content,
      mediaIds: draft.mediaIds,
      channelIds: draft.channelIds,
      perChannel: draft.perChannel,
      scheduledAt: draft.scheduledAt,
      status: body.status ?? draft.status,
      note: body.note ?? existing.note,
    });
    events.emit('posts:changed', { updated: ctx.params.id });
    return { post };
  });

  router.delete('/api/posts/:id', async (ctx) => {
    const ok = await workspace.posts.remove(ctx.params.id);
    if (!ok) throw new HttpError(404, 'Khong tim thay bai dang');
    events.emit('posts:changed', { removed: ctx.params.id });
    return { ok: true };
  });

  router.post('/api/posts/:id/publish', async (ctx) => {
    const body = await readJsonBody(ctx.req).catch(() => ({}));
    const existing = await workspace.posts.get(ctx.params.id);
    if (!existing) throw new HttpError(404, 'Khong tim thay bai dang');
    if (existing.status === 'publishing') {
      throw new HttpError(409, 'Bai dang nay dang duoc gui, cho xong da');
    }
    // Chong dang TRUNG: bai da dang thanh cong thi phai nhan ban roi dang lai.
    if (existing.status === 'posted' && !body.dryRun && !body.force) {
      throw new HttpError(409, 'Bai nay da dang thanh cong roi. Dung "Nhan ban" neu muon dang lai.');
    }
    const { post, report } = await publisher.publishPost(ctx.params.id, { dryRun: Boolean(body.dryRun) });
    events.emit('posts:changed', { updated: ctx.params.id });
    return { post, report };
  });

  router.post('/api/posts/:id/duplicate', async (ctx) => {
    const src = await workspace.posts.get(ctx.params.id);
    if (!src) throw new HttpError(404, 'Khong tim thay bai dang');
    const post = await workspace.createPost({
      content: { ...src.content },
      mediaIds: [...src.mediaIds],
      channelIds: [...src.channelIds],
      perChannel: structuredClone(src.perChannel ?? {}),
      scheduledAt: null,
      status: 'draft',
    });
    return { post };
  });

  /** Xem truoc caption tung kenh (khong goi API nen tang). */
  router.post('/api/preview', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const channelIds = Array.isArray(body.channelIds) ? body.channelIds.map(String) : [];
    const mediaIds = Array.isArray(body.mediaIds) ? body.mediaIds.map(String) : [];
    const channels = await workspace.getChannels(channelIds);
    const hashtags = normalizeHashtags(body.hashtags);
    const mediaRecords = await workspace.getMediaList(mediaIds);

    const previews = channels.map((ch) => {
      const Klass = PLATFORM_REGISTRY[ch.platform];
      const caps = Klass?.capabilities;
      const per = body.perChannel?.[ch.id] ?? {};
      const content = {
        title: per.title ?? body.title ?? '',
        description: per.description ?? body.description ?? '',
        hashtags: per.hashtags ? normalizeHashtags(per.hashtags) : hashtags,
        link: body.link,
      };
      const cap = buildCaption(content, {
        maxLength: caps?.limits?.caption ?? Infinity,
        maxHashtags: caps?.limits?.hashtags ?? Infinity,
      });
      const issues = checkMediaAgainstPlatform(ch.platform, caps, mediaRecords, content);
      return {
        channelId: ch.id,
        platform: ch.platform,
        name: ch.name,
        caption: cap.text,
        captionLength: cap.length,
        captionLimit: caps?.limits?.caption ?? null,
        truncated: cap.truncated,
        droppedHashtags: cap.droppedHashtags,
        hashtagLimit: caps?.limits?.hashtags ?? null,
        issues,
      };
    });
    return { previews };
  });

  // ----------------------------------------------------------------- schedule

  router.get('/api/schedule/slots', async (ctx) => {
    const settings = await workspace.settings.read();
    const queued = await workspace.listPosts({ status: ['queued'], limit: 500 });
    const slots = nextSlots(settings.postingTimes, {
      count: parseIntParam(ctx.query.get('count'), 12, { min: 1, max: 60 }),
      timezone: settings.timezone,
      taken: queued.map((p) => /** @type {string} */ (p.scheduledAt)).filter(Boolean),
    });
    return { slots, timezone: settings.timezone, postingTimes: settings.postingTimes };
  });

  router.get('/api/scheduler', async () => ({ scheduler: scheduler.status() }));

  router.post('/api/scheduler/tick', async () => ({ result: await scheduler.tick() }));

  router.post('/api/scheduler/start', async () => {
    scheduler.start();
    return { scheduler: scheduler.status() };
  });

  router.post('/api/scheduler/stop', async () => {
    scheduler.stop();
    return { scheduler: scheduler.status() };
  });

  // ----------------------------------------------------------------- settings

  router.get('/api/settings', async () => ({ settings: redactSettings(await workspace.settings.read()) }));

  router.put('/api/settings', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    /** @type {Record<string, any>} */
    const patch = {};
    if (body.timezone) patch.timezone = String(body.timezone);
    if (Array.isArray(body.postingTimes)) {
      patch.postingTimes = body.postingTimes
        .map((t) => String(t).trim())
        .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
        .slice(0, 24);
    }
    if (body.defaultHashtags !== undefined) patch.defaultHashtags = normalizeHashtags(body.defaultHashtags);
    if (body.publishing) patch.publishing = body.publishing;

    // Credentials: chi ghi khi co gia tri moi (de khong xoa secret bang gia tri che).
    if (body.credentials) {
      patch.credentials = {};
      for (const [provider, fields] of Object.entries(body.credentials)) {
        if (!DEFAULT_SETTINGS.credentials[provider]) continue;
        const isSecret = new Set(
          (OAUTH_PROVIDERS[provider]?.credentialFields ?? []).filter((f) => f.secret).map((f) => f.key),
        );
        patch.credentials[provider] = {};
        for (const [k, v] of Object.entries(/** @type {any} */ (fields))) {
          if (v === undefined || v === null || String(v).includes('•')) continue;
          // Field bi mat: bo trong = "khong doi". Field thuong (vd redirectUri):
          // bo trong = "xoa di, quay ve gia tri mac dinh".
          if (v === '' && isSecret.has(k)) continue;
          patch.credentials[provider][k] = String(v);
        }
      }
    }
    if (body.mediaHost) {
      patch.mediaHost = { ...body.mediaHost };
      // Khong ghi de secret bang gia tri che.
      if (patch.mediaHost.s3?.secretAccessKey && String(patch.mediaHost.s3.secretAccessKey).includes('•')) {
        delete patch.mediaHost.s3.secretAccessKey;
      }
    }

    const settings = await workspace.settings.merge(patch);
    logger.info('da cap nhat cai dat', { fields: Object.keys(patch) });
    return { settings: redactSettings(settings) };
  });

  // --------------------------------------------------------------- logs/events

  router.get('/api/logs', async () => ({ logs: logLines() }));

  router.get('/api/events', async (ctx) => {
    const lastId = Number(ctx.req.headers['last-event-id'] ?? ctx.query.get('lastEventId') ?? 0);
    events.subscribe(ctx.req, ctx.res, Number.isFinite(lastId) ? lastId : 0);
  });

  router.get('/api/health', async () => ({
    ok: true,
    at: new Date().toISOString(),
    scheduler: scheduler.status(),
  }));

  return router;
}

// -------------------------------------------------------------------- helpers

/**
 * Kiem tra + chuan hoa body tao/sua bai dang.
 * @param {any} body
 * @param {Workspace} workspace
 */
async function validatePostBody(body, workspace) {
  const title = String(body.title ?? body.content?.title ?? '').slice(0, 2000);
  const description = String(body.description ?? body.content?.description ?? '').slice(0, 20_000);
  const hashtags = normalizeHashtags(body.hashtags ?? body.content?.hashtags);
  const link = body.link ?? body.content?.link;
  if (link && !/^https?:\/\//i.test(String(link))) {
    throw new HttpError(400, 'link phai bat dau bang http:// hoac https://');
  }

  const mediaIds = Array.isArray(body.mediaIds) ? body.mediaIds.map(String) : [];
  if (mediaIds.length > 0) {
    const found = await workspace.getMediaList(mediaIds);
    if (found.length !== mediaIds.length) throw new HttpError(400, 'Co media khong ton tai');
  }

  const channelIds = Array.isArray(body.channelIds) ? body.channelIds.map(String) : [];
  if (channelIds.length > 0) {
    const found = await workspace.getChannels(channelIds);
    if (found.length !== channelIds.length) throw new HttpError(400, 'Co kenh khong ton tai');
  }

  if (!title && !description && mediaIds.length === 0) {
    throw new HttpError(400, 'Bai dang rong: can it nhat tieu de, noi dung hoac media');
  }

  /** @type {string | null} */
  let scheduledAt = null;
  if (body.scheduledAt) {
    const d = new Date(body.scheduledAt);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'scheduledAt khong hop le');
    scheduledAt = d.toISOString();
  }

  const ALLOWED_STATUS = ['draft', 'queued', 'posted', 'partial', 'failed', 'cancelled'];
  if (body.status !== undefined && !ALLOWED_STATUS.includes(body.status)) {
    throw new HttpError(400, `status khong hop le. Cho phep: ${ALLOWED_STATUS.join(', ')}`);
  }
  const status = body.status ?? (scheduledAt ? 'queued' : 'draft');
  if (status === 'queued' && channelIds.length === 0) {
    throw new HttpError(400, 'Can chon it nhat mot kenh truoc khi len lich');
  }

  /** @type {Record<string, any>} */
  const perChannel = {};
  if (body.perChannel && typeof body.perChannel === 'object') {
    for (const [chId, val] of Object.entries(body.perChannel)) {
      if (!val || typeof val !== 'object') continue;
      const clean = {};
      for (const [k, v] of Object.entries(/** @type {any} */ (val))) {
        if (v === undefined || v === null || v === '') continue;
        clean[k] = k === 'hashtags' ? normalizeHashtags(v) : v;
      }
      if (Object.keys(clean).length > 0) perChannel[chId] = clean;
    }
  }

  return {
    content: { title, description, hashtags, link: link || undefined },
    mediaIds,
    channelIds,
    perChannel,
    scheduledAt,
    status,
  };
}

function toBody(post) {
  return {
    title: post.content?.title,
    description: post.content?.description,
    hashtags: post.content?.hashtags,
    link: post.content?.link,
    mediaIds: post.mediaIds,
    channelIds: post.channelIds,
    perChannel: post.perChannel,
    scheduledAt: post.scheduledAt,
    status: post.status,
  };
}

/** Bao truoc cac van de media se gap o tung nen tang (giup tranh loi khi dang). */
function checkMediaAgainstPlatform(platform, caps, mediaRecords, content) {
  /** @type {Array<{level: 'error'|'warn', message: string}>} */
  const issues = [];
  if (!caps) return issues;

  const images = mediaRecords.filter((m) => m.kind === 'image');
  const videos = mediaRecords.filter((m) => m.kind === 'video');

  if (mediaRecords.length === 0 && !caps.text) {
    issues.push({ level: 'error', message: `${platform} khong dang duoc bai chi co chu` });
  }
  if (videos.length > 0 && !caps.video) {
    issues.push({ level: 'error', message: `${platform} khong ho tro video` });
  }
  if (videos.length === 0 && images.length > 0 && !caps.image) {
    issues.push({ level: 'error', message: `${platform} khong ho tro anh` });
  }
  if (mediaRecords.length > caps.maxMediaCount && !caps.album) {
    issues.push({ level: 'error', message: `${platform} chi nhan ${caps.maxMediaCount} media/bai` });
  }
  if (mediaRecords.length > caps.maxMediaCount && caps.album) {
    issues.push({ level: 'warn', message: `${platform} toi da ${caps.maxMediaCount} media - phan du se bi bo qua hoac chia bai` });
  }

  for (const m of mediaRecords) {
    const allowed = m.kind === 'image' ? caps.imageMime : caps.videoMime;
    if (allowed && !allowed.includes(m.mime)) {
      issues.push({ level: 'error', message: `${m.filename}: ${platform} khong nhan ${m.mime} (can ${allowed.join(', ')})` });
    }
    const maxBytes = m.kind === 'image' ? caps.maxImageBytes : caps.maxVideoBytes;
    if (maxBytes && m.size > maxBytes) {
      issues.push({ level: 'error', message: `${m.filename}: ${Math.round(m.size / 1e6)}MB vuot gioi han ${Math.round(maxBytes / 1e6)}MB cua ${platform}` });
    }
    if (m.kind === 'video' && caps.maxVideoSec && m.durationSec && m.durationSec > caps.maxVideoSec) {
      issues.push({ level: 'error', message: `${m.filename}: ${Math.round(m.durationSec)}s vuot gioi han ${caps.maxVideoSec}s` });
    }
    // Canh bao rieng cho anh feed Instagram.
    if (platform === 'instagram' && m.kind === 'image' && m.width && m.height) {
      const ratio = m.width / m.height;
      if (ratio < 0.8 - 1e-3 || ratio > 1.91 + 1e-3) {
        issues.push({
          level: 'error',
          message: `${m.filename}: ty le ${ratio.toFixed(2)} ngoai khoang 4:5 - 1.91:1 cua Instagram feed (crop ve 1080x1350)`,
        });
      }
    }
  }

  if (platform === 'youtube' && !content.title) {
    issues.push({ level: 'error', message: 'YouTube bat buoc co tieu de' });
  }
  return issues;
}

function publicMedia(rec) {
  return {
    id: rec.id,
    filename: rec.filename,
    mime: rec.mime,
    kind: rec.kind,
    size: rec.size,
    width: rec.width,
    height: rec.height,
    durationSec: rec.durationSec,
    createdAt: rec.createdAt,
    url: `/api/media/${rec.id}/file`,
  };
}

/** Che secret truoc khi tra ve trinh duyet. */
function redactSettings(settings) {
  const mask = (v) => (v ? '••••••••' : '');
  return {
    ...settings,
    credentials: {
      google: {
        clientId: settings.credentials?.google?.clientId ?? '',
        clientSecret: mask(settings.credentials?.google?.clientSecret),
        redirectUri: settings.credentials?.google?.redirectUri ?? '',
      },
      facebook: {
        appId: settings.credentials?.facebook?.appId ?? '',
        appSecret: mask(settings.credentials?.facebook?.appSecret),
        graphVersion: settings.credentials?.facebook?.graphVersion ?? 'v26.0',
        redirectUri: settings.credentials?.facebook?.redirectUri ?? '',
      },
      tiktok: {
        clientKey: settings.credentials?.tiktok?.clientKey ?? '',
        clientSecret: mask(settings.credentials?.tiktok?.clientSecret),
        redirectUri: settings.credentials?.tiktok?.redirectUri ?? '',
      },
    },
    mediaHost: {
      ...settings.mediaHost,
      s3: {
        ...settings.mediaHost?.s3,
        secretAccessKey: mask(settings.mediaHost?.s3?.secretAccessKey),
      },
    },
  };
}

/** Redirect ve UI kem thong bao. */
function redirectWithMessage(res, level, message) {
  const params = new URLSearchParams({ [level === 'error' ? 'error' : 'ok']: message });
  res.writeHead(302, { location: `/?${params.toString()}#channels` });
  res.end();
}

/** Chan ky tu nguy hiem trong ten file. */
function sanitizeFilename(name) {
  return String(name)
    .replace(/[/\\]/g, '_')
    // Bo ky tu dieu khien va ky tu Windows khong cho phep trong ten file.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .slice(0, 180) || 'upload.bin';
}
