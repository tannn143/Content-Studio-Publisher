/**
 * Test cho cac loi DA TUNG co, do dot review da tim ra.
 * Moi test o day tuong ung mot loi that -> khong duoc de tai xuat hien.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAdminServer } from '../src/server/server.js';
import { parseRangeHeader, safeJoin, parseIntParam } from '../src/server/http-util.js';
import { createEventLogger, EventBus } from '../src/server/events.js';
import { HttpClient, isServerRejection } from '../src/core/http.js';
import { truncate, buildCaption } from '../src/core/text.js';
import { AccessTokenManager, MemoryTokenStore, tokenStoreKey } from '../src/core/tokenstore.js';
import { toMedia } from '../src/core/media.js';
import { JsonCollection } from '../src/core/store/jsonstore.js';
import { SocialPoster } from '../src/core/poster.js';
import { TikTokPlatform } from '../src/platforms/tiktok.js';
import { TelegramPlatform, splitAlbumGroups } from '../src/platforms/telegram.js';
import { buildTitle } from '../src/platforms/youtube.js';
import { noopLogger } from '../src/core/logger.js';
import { createMockFetch, fakeJpeg, fakeMp4 } from './helpers.js';

// =============================================== server: DoS qua header Range

test('regression: Range "bytes=-0" khong lam sap server', () => {
  // Truoc day tra ve {start: size, end: size-1} -> writeHead 206 roi crash.
  assert.equal(parseRangeHeader('bytes=-0', 1000), null);
  assert.equal(parseRangeHeader('bytes=-abc', 1000), null);
  assert.equal(parseRangeHeader('bytes=5000-', 1000), null, 'start vuot size');
  assert.equal(parseRangeHeader('bytes=abc-def', 1000), null);
  // Cac truong hop hop le van dung
  assert.deepEqual(parseRangeHeader('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRangeHeader('bytes=500-', 1000), { start: 500, end: 999 });
});

test('regression: Range "bytes=-0" tra ve 200 chu khong lam chet ket noi', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-range-'));
  const handle = await createAdminServer({ port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', startScheduler: false });
  await handle.start();
  try {
    const res = await fetch(`${handle.url}/assets/app.js`, { headers: { Range: 'bytes=-0' } });
    assert.equal(res.status, 200, 'phai tra ve ca file thay vi 206 khong hop le');
    await res.arrayBuffer();
    // Server phai con song
    const health = await fetch(`${handle.url}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: safeJoin chiu duoc percent-escape sai', () => {
  assert.equal(safeJoin('/root', '/%zz'), null);
  assert.equal(safeJoin('/root', '/../etc/passwd'), null);
});

test('regression: URL escape sai tra ve 400 chu khong phai 500', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-esc-'));
  const handle = await createAdminServer({ port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', startScheduler: false });
  await handle.start();
  try {
    const res = await fetch(`${handle.url}/api/media/100%/file`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /escape/);
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: parseIntParam khong tra ve NaN', () => {
  assert.equal(parseIntParam('abc', 100), 100);
  assert.equal(parseIntParam(null, 100), 100);
  assert.equal(parseIntParam('-5', 100, { min: 1 }), 1);
  assert.equal(parseIntParam('99999', 100, { max: 1000 }), 1000);
  assert.equal(parseIntParam('50', 100), 50);
});

test('regression: limit khong hop le khong lam danh sach bai rong', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-lim-'));
  const handle = await createAdminServer({ port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', startScheduler: false });
  await handle.start();
  try {
    await handle.workspace.createPost({ content: { title: 'a' } });
    const res = await fetch(`${handle.url}/api/posts?limit=abc`);
    const body = await res.json();
    assert.equal(body.posts.length, 1, 'limit sai phai dung mac dinh, khong tra ve rong');
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ==================================================== server: bao mat

test('regression: media tai len khong duoc chay nhu HTML tren origin admin', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-xss-'));
  const handle = await createAdminServer({ port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', startScheduler: false });
  await handle.start();
  try {
    // Upload anh JPEG that (magic bytes) nhung khai content-type la text/html
    const up = await fetch(`${handle.url}/api/media`, {
      method: 'POST',
      headers: { 'x-filename': 'evil.html', 'content-type': 'text/html' },
      body: fakeJpeg(512),
    });
    const { media } = await up.json();
    assert.equal(media.mime, 'image/jpeg', 'mime phai lay tu magic bytes, khong tin client');

    const file = await fetch(`${handle.url}${media.url}`);
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.match(file.headers.get('content-security-policy') ?? '', /sandbox/);
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: log day ra trinh duyet phai che token', () => {
  const events = new EventBus();
  const { logger, lines } = createEventLogger({ events, base: noopLogger });
  logger.warn('server mo ra ngoai localhost nen da tu sinh token dang nhap', {
    token: 'SUPER_SECRET_ADMIN_TOKEN_VALUE',
  });
  logger.info('goi API', { url: 'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendPhoto' });

  const dump = JSON.stringify(lines());
  assert.ok(!dump.includes('SUPER_SECRET_ADMIN_TOKEN_VALUE'), 'token khong duoc lot ra log UI');
  assert.ok(!dump.includes('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'), 'bot token khong duoc lot ra log UI');
});

test('regression: chan CSRF tu origin khac', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-csrf-'));
  const handle = await createAdminServer({ port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', startScheduler: false });
  await handle.start();
  try {
    const res = await fetch(`${handle.url}/api/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: JSON.stringify({ title: 'hack' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'E_CSRF');

    // Cung origin thi van chay
    const ok = await fetch(`${handle.url}/api/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: handle.url },
      body: JSON.stringify({ title: 'hop le' }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: khong nhan token qua query string', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-qtok-'));
  const handle = await createAdminServer({
    port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', startScheduler: false, token: 'T0KEN',
  });
  await handle.start();
  try {
    const viaQuery = await fetch(`${handle.url}/api/state?token=T0KEN`);
    assert.equal(viaQuery.status, 401, 'token trong query khong duoc chap nhan');
    const viaHeader = await fetch(`${handle.url}/api/state`, { headers: { authorization: 'Bearer T0KEN' } });
    assert.equal(viaHeader.status, 200);
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: khong cho dang lai bai da dang thanh cong', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-dup-'));
  const handle = await createAdminServer({ port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', startScheduler: false });
  await handle.start();
  try {
    const ch = await handle.workspace.saveChannel({
      platform: 'telegram', name: 'CH', externalId: '-1', config: { botToken: '1:a', chatId: '-1' },
    });
    const post = await handle.workspace.createPost({
      content: { title: 'x' }, channelIds: [ch.id], status: 'posted',
    });
    const res = await fetch(`${handle.url}/api/posts/${post.id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /da dang thanh cong/);
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: bai bi ket o "publishing" duoc khoi phuc khi khoi dong lai', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-stuck-'));
  try {
    // Lan 1: tao bai va de o trang thai publishing (gia lap bi kill giua duong)
    const h1 = await createAdminServer({ port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', startScheduler: false });
    await h1.start();
    const post = await h1.workspace.createPost({ content: { title: 'x' }, channelIds: ['c'] });
    await h1.workspace.updatePost(post.id, { status: 'publishing' });
    await h1.close();

    // Lan 2: khoi dong lai -> phai duoc dua ve failed
    const h2 = await createAdminServer({ port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', startScheduler: false });
    await h2.start();
    const after = await h2.workspace.posts.get(post.id);
    assert.equal(after.status, 'failed');
    assert.match(after.note, /ngat giua luc dang/);
    await h2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ================================================== core: HTTP va retry

test('regression: POST khong retry khi loi mang (tranh dang trung)', async () => {
  let calls = 0;
  const http = new HttpClient({
    logger: noopLogger,
    retry: { retries: 3, minDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    fetchImpl: async () => {
      calls += 1;
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNRESET' };
      throw err;
    },
  });
  await assert.rejects(() => http.request('https://x.test/post', { method: 'POST', json: {} }));
  assert.equal(calls, 1, 'POST bi loi mang KHONG duoc retry: co the da dang thanh cong');
});

test('regression: POST VAN retry khi server tra 429/5xx (chac chan bi tu choi)', async () => {
  let calls = 0;
  const http = new HttpClient({
    logger: noopLogger,
    retry: { retries: 3, minDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return new Response('{}', { status: 503 });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const res = await http.request('https://x.test/post', { method: 'POST', json: {} });
  assert.equal(res.data.ok, true);
  assert.equal(calls, 3);
});

test('regression: GET van retry loi mang binh thuong', async () => {
  let calls = 0;
  const http = new HttpClient({
    logger: noopLogger,
    retry: { retries: 2, minDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 2) {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'ECONNRESET' };
        throw err;
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await http.request('https://x.test/get');
  assert.equal(calls, 2);
});

test('regression: huy boi caller -> AbortError (khong retry), khac voi timeout', async () => {
  const controller = new AbortController();
  const http = new HttpClient({
    logger: noopLogger,
    retry: { retries: 3, minDelayMs: 1, jitter: 'none' },
    fetchImpl: async (_url, init) => {
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  });
  await assert.rejects(
    () => http.request('https://x.test/a', { signal: controller.signal }),
    (err) => {
      assert.equal(err.code, 'E_ABORTED');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('regression: isServerRejection chi dung cho loi CO response', () => {
  assert.equal(isServerRejection({ retryable: true, httpStatus: 429 }), true);
  assert.equal(isServerRejection({ retryable: true, httpStatus: 503 }), true);
  assert.equal(isServerRejection({ retryable: true }), false, 'loi mang: khong biet server da nhan chua');
  assert.equal(isServerRejection({ retryable: true, httpStatus: 400 }), false);
  assert.equal(isServerRejection({ retryable: false, httpStatus: 500 }), false);
});

// ============================================== core: media, text, token

test('regression: readRange tren URL phai bat loi khi server bo qua Range', async () => {
  const media = toMedia({ url: 'https://cdn.test/v.mp4', mime: 'video/mp4', size: 1000 });
  await media.load({ probeRemote: false });

  const original = globalThis.fetch;
  // Server tra 200 (bo qua Range) thay vi 206 -> phai bao loi, khong duoc dung byte sai.
  globalThis.fetch = async () => new Response(Buffer.alloc(1000), { status: 200 });
  try {
    await assert.rejects(() => media.readRange(0, 99), /khong ho tro HTTP Range/);
  } finally {
    globalThis.fetch = original;
  }
});

test('regression: truncate khong lam mat noi dung khi maxLen khong hop le', () => {
  assert.equal(truncate('hello world'), 'hello world', 'maxLen undefined -> giu nguyen');
  assert.equal(truncate('hello world', NaN), 'hello world');
  assert.equal(truncate('hello world', Infinity), 'hello world');
  // maxLen nho hon ellipsis -> khong duoc dai hon maxLen
  assert.equal(truncate('hello world', 2).length, 2);
  assert.equal(truncate('hello world', 1).length, 1);
});

test('regression: buildCaption voi template khong tra ve chuoi rong', () => {
  const r = buildCaption(
    { title: 'T', description: 'D', hashtags: ['a'] },
    { template: ({ title, description, hashtags }) => `${title}|${description}|${hashtags}` },
  );
  assert.equal(r.text, 'T|D|#a');
});

test('regression: token trong config khong duoc coi la song mai mai', async () => {
  const store = new MemoryTokenStore();
  let refreshes = 0;
  const mgr = new AccessTokenManager({
    key: 'k',
    store,
    initialAccessToken: 'TOKEN_CU_TU_ENV',
    refresh: async () => {
      refreshes += 1;
      return { accessToken: 'TOKEN_MOI', expiresInSec: 3600 };
    },
  });
  // Lan dau: dung token nguoi dung truyen (chua co gi trong store)
  assert.equal(await mgr.getAccessToken(), 'TOKEN_CU_TU_ENV');

  // Sau khi da co ban ghi CO HAN trong store -> ban ghi do thang token provisional
  await store.set('k', { accessToken: 'TOKEN_DA_REFRESH', expiresAt: Date.now() + 3600_000 });
  assert.equal(await mgr.getAccessToken(), 'TOKEN_DA_REFRESH', 'token da refresh phai thang token .env cu');

  // forceRefresh luon goi refresh
  assert.equal(await mgr.getAccessToken({ forceRefresh: true }), 'TOKEN_MOI');
  assert.equal(refreshes, 1);
});

test('regression: tokenStoreKey phan biet tung tai khoan cua cung mot app', () => {
  const a = tokenStoreKey('tiktok', 'SAME_CLIENT_KEY', 'refresh_token_cua_A');
  const b = tokenStoreKey('tiktok', 'SAME_CLIENT_KEY', 'refresh_token_cua_B');
  assert.notEqual(a, b, 'hai creator cung app khong duoc dung chung ban ghi token');
  assert.ok(!a.includes('refresh_token_cua_A'), 'khoa khong duoc chua secret');
  assert.equal(a, tokenStoreKey('tiktok', 'SAME_CLIENT_KEY', 'refresh_token_cua_A'), 'phai on dinh');
});

test('regression: hai kenh TikTok cung app dung khoa token khac nhau', () => {
  const mock = createMockFetch([]);
  const ctx = { http: mock.http, logger: noopLogger, store: new MemoryTokenStore() };
  const a = new TikTokPlatform({ clientKey: 'CK', clientSecret: 'CS', refreshToken: 'RT_A' }, ctx);
  const b = new TikTokPlatform({ clientKey: 'CK', clientSecret: 'CS', refreshToken: 'RT_B' }, ctx);
  assert.notEqual(a.tokens.key, b.tokens.key);
});

test('regression: JsonCollection khong coi loi doc file la "rong"', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-js-'));
  try {
    const file = path.join(dir, 'x.json');
    // JSON hong -> doi ten va bat dau lai (khong nem loi)
    await writeFile(file, '{khong-phai-json');
    const col = new JsonCollection(file);
    assert.deepEqual(await col.all(), []);

    // Thu muc thay vi file -> phai NEM loi (khong duoc am tham ghi de)
    const dirAsFile = path.join(dir, 'la-thu-muc.json');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirAsFile);
    const col2 = new JsonCollection(dirAsFile);
    await assert.rejects(() => col2.all());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================ platforms: cac loi da sua

test('regression: chunk plan TikTok - file > 64MB phai chia nhieu chunk', () => {
  const tk = new TikTokPlatform(
    { clientKey: 'k', clientSecret: 's', refreshToken: 'r' },
    { http: createMockFetch([]).http, logger: noopLogger, store: new MemoryTokenStore() },
  );
  // Truoc day: chunk 64MB + file 70MB -> 1 chunk 70MB (vi pham "phai chia nhieu chunk")
  const plan = tk.buildChunkPlan(70 * 1024 * 1024, 64 * 1024 * 1024);
  assert.ok(plan.total_chunk_count >= 2, `phai >= 2 chunk, nhan ${plan.total_chunk_count}`);
  assert.ok(plan.chunk_size <= 64 * 1024 * 1024);

  // Kiem tra moi ke hoach deu phu kin [0, size-1] va chunk giua dung chunk_size
  for (const [size, pref] of [
    [1_000_000, undefined],
    [5 * 1024 * 1024, undefined],
    [12 * 1024 * 1024, 5 * 1024 * 1024],
    [50_000_123, 10_000_000],
    [300 * 1024 * 1024, undefined],
    [70 * 1024 * 1024, 64 * 1024 * 1024],
    [4 * 1024 * 1024 * 1024, 5 * 1024 * 1024],
  ]) {
    const pl = tk.buildChunkPlan(size, pref);
    assert.ok(pl.chunk_size >= Math.min(size, 5 * 1024 * 1024) || pl.total_chunk_count === 1);
    assert.ok(pl.chunk_size <= 64 * 1024 * 1024 || pl.total_chunk_count === 1, `chunk_size qua lon cho size=${size}`);
    assert.ok(pl.total_chunk_count >= 1 && pl.total_chunk_count <= 1000);
    // Chunk cuoi gom phan du
    const finalChunk = size - (pl.total_chunk_count - 1) * pl.chunk_size;
    assert.ok(finalChunk > 0, `chunk cuoi phai > 0 cho size=${size}`);
    assert.ok(finalChunk <= 128 * 1024 * 1024, `chunk cuoi ${finalChunk} vuot 128MB cho size=${size}`);
    if (size > 64 * 1024 * 1024) {
      assert.ok(pl.total_chunk_count >= 2, `size=${size} phai chia nhieu chunk`);
    }
  }
});

test('regression: TikTok tu refresh token roi goi lai khi 401 access_token_invalid', async () => {
  let tokenCalls = 0;
  const mock = createMockFetch([
    {
      match: '/oauth/token/',
      handler: () => {
        tokenCalls += 1;
        return { json: { access_token: `AT${tokenCalls}`, expires_in: 86400, refresh_token: 'RT' } };
      },
    },
    {
      match: '/creator_info/query/',
      handler: (req, hit) => (hit === 1
        ? { status: 401, json: { data: {}, error: { code: 'access_token_invalid', message: 'expired', log_id: 'L' } } }
        : { json: { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } } }),
    },
  ]);
  const tk = new TikTokPlatform(
    { clientKey: 'k', clientSecret: 's', refreshToken: 'r' },
    { http: mock.http, logger: noopLogger, store: new MemoryTokenStore() },
  );
  const info = await tk.getCreatorInfo();
  assert.deepEqual(info.privacy_level_options, ['SELF_ONLY']);
  assert.equal(mock.countRequests('/creator_info/query/'), 2, 'phai goi lai sau khi refresh');
  assert.ok(tokenCalls >= 2, 'phai refresh token');
});

test('regression: TikTok poll status phai phat hien loi thay vi bao thanh cong', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    { match: '/creator_info/query/', json: { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } } },
    { match: '/video/init/', json: { data: { publish_id: 'p1' }, error: { code: 'ok' } } },
    {
      match: '/status/fetch/',
      status: 400,
      json: { data: {}, error: { code: 'invalid_publish_id', message: 'khong ton tai', log_id: 'L' } },
    },
  ]);
  const tk = new TikTokPlatform(
    { clientKey: 'k', clientSecret: 's', refreshToken: 'r' },
    { http: mock.http, logger: noopLogger, store: new MemoryTokenStore() },
  );
  const { normalizePost } = await import('../src/core/post.js');
  const post = await normalizePost({
    title: 'x',
    media: { url: 'https://verified.test/v.mp4', mime: 'video/mp4' },
    overrides: { tiktok: { probeMedia: false } },
  });
  await assert.rejects(() => tk.publish(post), (err) => {
    assert.equal(err.platformCode, 'invalid_publish_id', 'phai bao dung ma loi tu status/fetch');
    assert.equal(err.retryable, false);
    return true;
  });
});

test('regression: Telegram khong tron document voi photo trong cung album', () => {
  const mk = (mime, kind = 'image') => ({ mime, kind });
  const groups = splitAlbumGroups([
    mk('image/jpeg'), mk('image/jpeg'), mk('image/gif'), mk('image/jpeg'),
  ]);
  assert.equal(groups.length, 3, 'phai tach thanh 3 nhom: 2 anh, 1 gif, 1 anh');
  assert.equal(groups[0].length, 2);
  assert.equal(groups[1][0].mime, 'image/gif');
  assert.equal(groups[2].length, 1);
});

test('regression: Telegram giu lai tin da gui khi mot chat loi', async () => {
  const mock = createMockFetch([
    {
      match: '/sendPhoto',
      handler: (req) => (String(req.body?.chat_id) === '@bad'
        ? { status: 400, json: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } }
        : { json: { ok: true, result: { message_id: 1, chat: { id: 1, username: 'good' } } } }),
    },
  ]);
  const tg = new TelegramPlatform(
    { botToken: '1:a', chatId: ['@good', '@bad'] },
    { http: mock.http, logger: noopLogger, store: new MemoryTokenStore() },
  );
  const { normalizePost } = await import('../src/core/post.js');
  const post = await normalizePost({ title: 'x', media: 'https://cdn.test/a.jpg' });
  const res = await tg.publish(post);
  assert.equal(res.ok, true, 'chat gui duoc van phai duoc ghi nhan');
  assert.equal(res.meta.messages.length, 1);
});

test('regression: buildTitle khong cat doi emoji (surrogate pair)', () => {
  const emoji = '😀';
  const title = 'a'.repeat(98) + emoji; // 98 + 2 code unit = 100
  const out = buildTitle({ title: title + 'xxx', description: '' });
  assert.ok(out.length <= 100);
  // Khong duoc con lone surrogate
  for (let i = 0; i < out.length; i += 1) {
    const c = out.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = out.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'con lone high surrogate');
      i += 1;
    } else {
      assert.ok(!(c >= 0xdc00 && c <= 0xdfff), 'con lone low surrogate');
    }
  }
});

test('regression: poster khong dang khi signal da bi huy tu truoc', async () => {
  const controller = new AbortController();
  controller.abort();
  const poster = new SocialPoster({
    logger: { level: 'silent' },
    platforms: { telegram: { botToken: '1:a', chatId: '@x' } },
  });
  const report = await poster.post({ title: 'x', description: 'y' }, { signal: controller.signal });
  assert.equal(report.skipped.includes('telegram'), true);
  assert.equal(report.byChannel.telegram.reason, 'da huy');
});

test('regression: upload ten file tieng Viet khong bi mangle', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-name-'));
  const handle = await createAdminServer({ port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', startScheduler: false });
  await handle.start();
  try {
    const name = 'Hình nền 4K.jpg';
    const res = await fetch(`${handle.url}/api/media`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(name), 'content-type': 'image/jpeg' },
      body: fakeJpeg(256),
    });
    const { media } = await res.json();
    assert.equal(media.filename, name, `ten file phai duoc decode, nhan: ${media.filename}`);
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: refresh token duoc dedup giua CAC INSTANCE (khong chi trong 1 instance)', async () => {
  // SocialPoster tao instance moi cho moi lan dang -> dedup theo instance la khong du.
  // Voi TikTok (refresh token xoay) hai lan refresh song song se lam mat quyen.
  const store = new MemoryTokenStore();
  let refreshes = 0;
  const makeMgr = () => new AccessTokenManager({
    key: 'tiktok:shared-key',
    store,
    refresh: async () => {
      refreshes += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: `AT${refreshes}`, expiresInSec: 3600, refreshToken: `RT${refreshes}` };
    },
  });

  const [a, b, c] = await Promise.all([
    makeMgr().getAccessToken(),
    makeMgr().getAccessToken(),
    makeMgr().getAccessToken(),
  ]);
  assert.equal(refreshes, 1, `chi duoc refresh 1 lan, thuc te ${refreshes}`);
  assert.equal(a, 'AT1');
  assert.equal(b, 'AT1');
  assert.equal(c, 'AT1');
  assert.equal((await store.get('tiktok:shared-key')).refreshToken, 'RT1');
});
