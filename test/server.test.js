import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAdminServer } from '../src/server/server.js';
import { Workspace } from '../src/core/store/workspace.js';
import { nextSlots, zonedTimeToIso } from '../src/core/scheduler.js';
import { JsonCollection, JsonDocument, deepMerge, newId } from '../src/core/store/jsonstore.js';
import { fakeJpeg, fakeMp4, createMockFetch } from './helpers.js';
import { connectTelegram } from '../src/auth/oauth.js';

/**
 * Moi request gio deu can mot nguoi dung dang sau (xem src/auth/users.js).
 * Cac test o day kiem tra hanh vi API chu khong phai dang nhap, nen dung
 * bearer token cua admin cho gon.
 */
const ADMIN_TOKEN = 'test-admin-token';

/** Them header Authorization vao init cua fetch. */
function authed(init = {}) {
  return { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(init.headers ?? {}) } };
}

/** Khoi dong server tren cong tu do trong thu muc tam. */
async function withServer(fn, opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-test-'));
  const handle = await createAdminServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    logLevel: 'silent',
    startScheduler: false,
    // Moi request gio deu can mot nguoi dung. Test kiem tra hanh vi API chu
    // khong phai dang nhap, nen dung bearer token cua admin cho gon.
    token: ADMIN_TOKEN,
    ...opts,
  });
  await handle.start();
  const base = handle.url;
  /** Goi API ngan gon. */
  const call = async (p, init = {}) => {
    const res = await fetch(`${base}${p}`, {
      ...init,
      headers: {
        ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...(handle.token ? { authorization: `Bearer ${handle.token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, res };
  };
  try {
    await fn({ handle, base, call, dir });
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================ jsonstore

test('JsonCollection: insert/get/update/remove + ghi atomic', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-store-'));
  try {
    const col = new JsonCollection(path.join(dir, 'items.json'));
    await col.insert({ id: 'a', n: 1, createdAt: '2026-01-01' });
    await col.insert({ id: 'b', n: 2, createdAt: '2026-01-02' });
    assert.equal((await col.all()).length, 2);
    await col.update('a', { n: 9 });
    assert.equal((await col.get('a')).n, 9);
    assert.equal(await col.remove('a'), true);
    assert.equal(await col.remove('zzz'), false);

    // Doc lai tu dia bang instance khac -> du lieu phai con.
    const again = new JsonCollection(path.join(dir, 'items.json'));
    const items = await again.all();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'b');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JsonCollection: ghi song song khong lam mat du lieu', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-store-'));
  try {
    const col = new JsonCollection(path.join(dir, 'p.json'));
    await Promise.all(Array.from({ length: 25 }, (_, i) => col.insert({ id: `x${i}`, i })));
    const reread = new JsonCollection(path.join(dir, 'p.json'));
    assert.equal((await reread.all()).length, 25);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JsonDocument: merge sau va giu default', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-doc-'));
  try {
    const doc = new JsonDocument(path.join(dir, 'settings.json'), { a: 1, nested: { x: 1, y: 2 } });
    await doc.merge({ nested: { y: 99 } });
    const out = await doc.read();
    assert.deepEqual(out, { a: 1, nested: { x: 1, y: 99 } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deepMerge: mang bi ghi de, object duoc tron', () => {
  assert.deepEqual(deepMerge({ a: [1, 2], b: { c: 1 } }, { a: [3], b: { d: 2 } }), { a: [3], b: { c: 1, d: 2 } });
});

test('newId: duy nhat va co tien to', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newId('ch')));
  assert.equal(ids.size, 200);
  assert.ok([...ids][0].startsWith('ch_'));
});

// ============================================================ workspace

test('Workspace: luu kenh, tao config cho poster theo channel id', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-ws-'));
  try {
    const ws = await new Workspace({ dir }).init();
    const a = await ws.saveChannel({
      platform: 'telegram', name: 'CH VI', externalId: '-100111',
      config: { botToken: 'T', chatId: '-100111' },
    });
    const b = await ws.saveChannel({
      platform: 'telegram', name: 'CH EN', externalId: '-100222',
      config: { botToken: 'T', chatId: '-100222' },
    });
    assert.notEqual(a.id, b.id, 'hai kenh khac nhau phai co id khac nhau');

    // Ket noi lai cung externalId -> cap nhat, khong tao trung.
    const again = await ws.saveChannel({
      platform: 'telegram', name: 'CH VI (moi)', externalId: '-100111',
      config: { botToken: 'T2' },
    });
    assert.equal(again.id, a.id);
    assert.equal(again.config.chatId, '-100111', 'config cu phai duoc giu lai');
    assert.equal(again.config.botToken, 'T2');
    assert.equal((await ws.listChannels()).length, 2);

    const platforms = Workspace.toPosterPlatforms(await ws.listChannels());
    assert.equal(Object.keys(platforms).length, 2);
    assert.equal(platforms[a.id].platform, 'telegram');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Workspace: duePosts chi lay bai qua gio', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-ws2-'));
  try {
    const ws = await new Workspace({ dir }).init();
    await ws.createPost({ content: { title: 'qua gio' }, scheduledAt: new Date(Date.now() - 60_000).toISOString(), status: 'queued', channelIds: ['x'] });
    await ws.createPost({ content: { title: 'tuong lai' }, scheduledAt: new Date(Date.now() + 3600_000).toISOString(), status: 'queued', channelIds: ['x'] });
    await ws.createPost({ content: { title: 'nhap' }, status: 'draft' });
    const due = await ws.duePosts();
    assert.equal(due.length, 1);
    assert.equal(due[0].content.title, 'qua gio');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================ scheduler slots

test('nextSlots: sinh cac moc tuong lai theo khung gio, bo moc da co bai', () => {
  const from = new Date('2026-09-12T02:00:00Z'); // 09:00 gio VN
  const slots = nextSlots(['09:00', '12:30', '19:00'], {
    from,
    count: 4,
    timezone: 'Asia/Ho_Chi_Minh',
  });
  assert.equal(slots.length, 4);
  for (const s of slots) assert.ok(new Date(s).getTime() > from.getTime());
  // Moc dau tien phai la 12:30 gio VN cung ngay (09:00 da qua).
  assert.equal(new Date(slots[0]).toISOString(), '2026-09-12T05:30:00.000Z');

  const withTaken = nextSlots(['09:00', '12:30', '19:00'], {
    from,
    count: 2,
    timezone: 'Asia/Ho_Chi_Minh',
    taken: ['2026-09-12T05:30:00.000Z'],
  });
  assert.equal(new Date(withTaken[0]).toISOString(), '2026-09-12T12:00:00.000Z');
});

test('nextSlots: khung gio rong -> mang rong', () => {
  assert.deepEqual(nextSlots([]), []);
  assert.deepEqual(nextSlots(['sai', '99:99']), []);
});

test('zonedTimeToIso: doi gio dia phuong sang UTC dung', () => {
  const iso = zonedTimeToIso(new Date('2026-09-12T00:00:00Z'), 19, 0, 'Asia/Ho_Chi_Minh');
  assert.equal(new Date(iso).toISOString(), '2026-09-12T12:00:00.000Z');
});

// ============================================================ oauth telegram

test('connectTelegram: tra ve channel khi bot la admin co quyen dang', async () => {
  const mock = createMockFetch([
    { match: '/getMe', json: { ok: true, result: { id: 77, username: 'wambot' } } },
    // Luu y: '/getChat' la tien to cua '/getChatMember' -> route cu the hon phai dung truoc.
    { match: '/getChatMember', json: { ok: true, result: { status: 'administrator', can_post_messages: true } } },
    { match: '/getChat', json: { ok: true, result: { id: -1001234567890, title: 'Wallpapers', type: 'channel', username: 'wallch' } } },
  ]);
  const ch = await connectTelegram({ botToken: '123:abc', chatId: '@wallch', http: mock.http });
  assert.equal(ch.platform, 'telegram');
  assert.equal(ch.name, 'Wallpapers');
  assert.equal(ch.config.chatId, '-1001234567890', 'phai luu id dang so');
  assert.equal(ch.externalId, '-1001234567890');
});

test('connectTelegram: bao loi khi bot chua la admin', async () => {
  const mock = createMockFetch([
    { match: '/getMe', json: { ok: true, result: { id: 77 } } },
    { match: '/getChatMember', json: { ok: true, result: { status: 'member' } } },
    { match: '/getChat', json: { ok: true, result: { id: -100, type: 'channel' } } },
  ]);
  await assert.rejects(
    () => connectTelegram({ botToken: '1:a', chatId: '@x', http: mock.http }),
    /cannot post yet/,
  );
});

// ============================================================ HTTP API

test('API: /api/health va /api/state tra ve du thong tin cho UI', async () => {
  await withServer(async ({ call }) => {
    const health = await call('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);

    const state = await call('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.data.platforms.length, 5);
    assert.equal(state.data.providers.length, 3);
    assert.deepEqual(state.data.channels, []);
    // Redirect URI phai tro dung ve server nay.
    assert.match(state.data.providers[0].redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/google\/callback$/);
  });
});

test('API: bat buoc token khi co cau hinh token', async () => {
  await withServer(async ({ base, call }) => {
    // Khong co header -> 401
    const noAuth = await fetch(`${base}/api/state`);
    assert.equal(noAuth.status, 401);
    // Co header -> 200
    const ok = await call('/api/state');
    assert.equal(ok.status, 200);
  }, { token: 'secret-token-123' });
});

test('API: upload media nhan dang mime, tu choi file khong phai anh/video', async () => {
  await withServer(async ({ call, base }) => {
    const jpeg = fakeJpeg(4096);
    const up = await fetch(`${base}/api/media`, authed({
      method: 'POST',
      headers: { 'x-filename': 'wallpaper.jpg', 'content-type': 'image/jpeg' },
      body: jpeg,
    }));
    const { media } = await up.json();
    assert.equal(up.status, 200);
    assert.equal(media.mime, 'image/jpeg');
    assert.equal(media.kind, 'image');
    assert.equal(media.size, 4096);
    assert.match(media.url, /^\/api\/media\/m_[a-z0-9]+\/file$/);

    // Tai lai file da upload
    const file = await fetch(`${base}${media.url}`, authed());
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/jpeg');

    // File khong phai media -> tu choi
    const bad = await fetch(`${base}/api/media`, authed({
      method: 'POST',
      headers: { 'x-filename': 'a.txt' },
      body: Buffer.from('day khong phai anh'),
    }));
    assert.equal(bad.status, 400);

    const list = await call('/api/media');
    assert.equal(list.data.media.length, 1);
  });
});

test('API: tao bai, kiem tra input, xem truoc, dang thu (dry-run)', async () => {
  await withServer(async ({ call, base, handle }) => {
    // Tao 2 kenh Telegram truc tiep trong workspace (khong can OAuth).
    const chA = await handle.workspace.saveChannel({
      platform: 'telegram', name: 'Kenh VI', externalId: '-1001',
      config: { botToken: '1:a', chatId: '-1001' },
    });
    const chB = await handle.workspace.saveChannel({
      platform: 'instagram', name: 'IG Wall', externalId: 'ig1',
      config: { igUserId: 'ig1', accessToken: 'T' },
    });

    // Bai rong -> 400
    const empty = await call('/api/posts', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(empty.status, 400);

    // Upload 1 anh doc 9:16 (IG feed se bao loi ty le)
    const up = await fetch(`${base}/api/media`, authed({
      method: 'POST',
      headers: { 'x-filename': 'tall.jpg', 'content-type': 'image/jpeg' },
      body: fakeJpeg(2048),
    }));
    const { media } = await up.json();
    // Gan kich thuoc doc de kiem tra canh bao ty le.
    await handle.workspace.media.update(media.id, { width: 1080, height: 1920 });

    // Xem truoc
    const preview = await call('/api/preview', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Hinh nen 4K',
        description: 'Bo suu tap moi',
        hashtags: ['wallpaper', '4k'],
        channelIds: [chA.id, chB.id],
        mediaIds: [media.id],
      }),
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.previews.length, 2);
    const igPreview = preview.data.previews.find((p) => p.platform === 'instagram');
    assert.ok(igPreview.issues.some((i) => /ty le/.test(i.message)), 'phai canh bao ty le anh IG');
    const tgPreview = preview.data.previews.find((p) => p.platform === 'telegram');
    assert.equal(tgPreview.captionLimit, 1024);
    assert.ok(tgPreview.caption.includes('#wallpaper'));

    // Tao bai
    const created = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Hinh nen 4K',
        description: 'Bo suu tap moi',
        hashtags: ['wallpaper'],
        channelIds: [chA.id],
        mediaIds: [media.id],
        perChannel: { [chA.id]: { parseMode: 'HTML' } },
      }),
    });
    assert.equal(created.status, 200);
    const post = created.data.post;
    assert.equal(post.status, 'draft');
    assert.equal(post.channelIds.length, 1);

    // Dang thu -> khong goi API that
    const dry = await call(`/api/posts/${post.id}/publish`, {
      method: 'POST',
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(dry.status, 200);
    assert.equal(dry.data.report.ok, true);
    assert.equal(dry.data.report.dryRun, true);
    assert.ok(dry.data.report.results[0].preview.includes('Hinh nen 4K'));
  });
});

test('API: len lich -> vao hang doi, tu choi thoi diem sai', async () => {
  await withServer(async ({ call, handle }) => {
    const ch = await handle.workspace.saveChannel({
      platform: 'telegram', name: 'CH', externalId: '-1', config: { botToken: '1:a', chatId: '-1' },
    });
    const bad = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'x', channelIds: [ch.id], scheduledAt: 'khong-phai-ngay' }),
    });
    assert.equal(bad.status, 400);

    const at = new Date(Date.now() + 3600_000).toISOString();
    const ok = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bai hen gio', channelIds: [ch.id], scheduledAt: at }),
    });
    assert.equal(ok.data.post.status, 'queued');
    assert.equal(ok.data.post.scheduledAt, at);

    const queued = await call('/api/posts?status=queued');
    assert.equal(queued.data.posts.length, 1);

    // Len lich ma khong chon kenh -> 400
    const noCh = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'x', scheduledAt: at, status: 'queued' }),
    });
    assert.equal(noCh.status, 400);
  });
});

test('API: sua va xoa bai dang', async () => {
  await withServer(async ({ call, handle }) => {
    const ch = await handle.workspace.saveChannel({
      platform: 'telegram', name: 'CH', externalId: '-1', config: { botToken: '1:a', chatId: '-1' },
    });
    const { data } = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'v1', channelIds: [ch.id] }),
    });
    const id = data.post.id;

    const patched = await call(`/api/posts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'v2', hashtags: ['a', 'a', 'b'] }),
    });
    assert.equal(patched.data.post.content.title, 'v2');
    assert.deepEqual(patched.data.post.content.hashtags, ['a', 'b']);

    const dup = await call(`/api/posts/${id}/duplicate`, { method: 'POST' });
    assert.equal(dup.data.post.content.title, 'v2');
    assert.notEqual(dup.data.post.id, id);

    const del = await call(`/api/posts/${id}`, { method: 'DELETE' });
    assert.equal(del.data.ok, true);
    const gone = await call(`/api/posts/${id}`);
    assert.equal(gone.status, 404);
  });
});

test('API: bat/tat va ngat ket noi kenh', async () => {
  await withServer(async ({ call, handle }) => {
    const ch = await handle.workspace.saveChannel({
      platform: 'telegram', name: 'CH', externalId: '-1', config: { botToken: '1:a', chatId: '-1' },
    });
    const off = await call(`/api/channels/${ch.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    assert.equal(off.data.channel.enabled, false);
    // Khong bao gio tra token ve client.
    assert.equal(JSON.stringify(off.data.channel).includes('1:a'), false);
    assert.equal(off.data.channel.credentials.hasAccessToken, true);

    const del = await call(`/api/channels/${ch.id}`, { method: 'DELETE' });
    assert.equal(del.data.ok, true);
    assert.equal((await call('/api/channels')).data.channels.length, 0);
  });
});

test('API: settings che secret va khong ghi de bang gia tri che', async () => {
  await withServer(async ({ call, handle }) => {
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        credentials: { google: { clientId: 'CID', clientSecret: 'REAL_SECRET' } },
        postingTimes: ['08:00', 'sai', '20:30'],
        timezone: 'Asia/Ho_Chi_Minh',
      }),
    });
    const got = await call('/api/settings');
    assert.equal(got.data.settings.credentials.google.clientId, 'CID');
    assert.ok(got.data.settings.credentials.google.clientSecret.includes('•'), 'secret phai bi che');
    assert.deepEqual(got.data.settings.postingTimes, ['08:00', '20:30'], 'gio sai bi loai');

    // Gui lai gia tri da che -> khong duoc ghi de secret that.
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ credentials: { google: { clientSecret: '••••••••' } } }),
    });
    const raw = await handle.workspace.settings.read();
    assert.equal(raw.credentials.google.clientSecret, 'REAL_SECRET');
  });
});

test('API: OAuth start bao loi ro khi chua cau hinh app', async () => {
  await withServer(async ({ call }) => {
    const res = await call('/api/oauth/google/start', { method: 'POST', body: '{}' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /is not configured yet/);
    assert.match(res.data.hint, /Settings tab/);
  });
});

test('API: OAuth start tra ve URL dung sau khi cau hinh', async () => {
  await withServer(async ({ call }) => {
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ credentials: { google: { clientId: 'CID', clientSecret: 'CS' } } }),
    });
    const res = await call('/api/oauth/google/start', { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    const u = new URL(res.data.url);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('client_id'), 'CID');
    assert.equal(u.searchParams.get('access_type'), 'offline', 'phai xin offline de co refresh_token');
    assert.equal(u.searchParams.get('prompt'), 'consent');
    assert.match(u.searchParams.get('scope'), /youtube\.upload/);
    assert.ok(u.searchParams.get('state'));
  });
});

test('API: OAuth start cho TikTok dung scope phan cach dau phay + PKCE', async () => {
  await withServer(async ({ call }) => {
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        credentials: {
          // TikTok chi nhan redirect_uri https -> phai tro toi trang cau noi.
          tiktok: { clientKey: 'CK', clientSecret: 'CS', redirectUri: 'https://example.test/tiktok-callback' },
        },
      }),
    });
    const res = await call('/api/oauth/tiktok/start', { method: 'POST', body: '{}' });
    const u = new URL(res.data.url);
    assert.equal(u.origin + u.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
    assert.equal(u.searchParams.get('client_key'), 'CK');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://example.test/tiktok-callback');
    assert.ok(u.searchParams.get('scope').includes(','), 'scope TikTok phan cach bang dau phay');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  });
});

test('API: OAuth callback voi state sai -> redirect kem thong bao loi', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/oauth/google/callback?code=abc&state=khong-ton-tai`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const loc = res.headers.get('location');
    assert.match(loc, /error=/);
    const msg = new URLSearchParams(loc.split('?')[1].split('#')[0]).get('error');
    assert.match(msg, /state is invalid/);
  });
});

test('API: schedule slots tra ve theo cai dat', async () => {
  await withServer(async ({ call }) => {
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ postingTimes: ['07:00', '21:00'], timezone: 'Asia/Ho_Chi_Minh' }),
    });
    const res = await call('/api/schedule/slots?count=4');
    assert.equal(res.data.slots.length, 4);
    assert.deepEqual(res.data.postingTimes, ['07:00', '21:00']);
    for (const s of res.data.slots) assert.ok(new Date(s).getTime() > Date.now());
  });
});

test('API: chan path traversal khi phuc vu file tinh', async () => {
  await withServer(async ({ base }) => {
    for (const attack of ['/../package.json', '/..%2fpackage.json', '/assets/../../package.json']) {
      const res = await fetch(`${base}${attack}`);
      const text = await res.text();
      assert.ok(!text.includes('"dependencies"'), `ro ri file qua ${attack}`);
    }
  });
});

test('API: phuc vu UI tinh', async () => {
  await withServer(async ({ base }) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /Content Studio Publisher/);

    const css = await fetch(`${base}/assets/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const js = await fetch(`${base}/assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });
});

test('API: SSE gui su kien ve client', async () => {
  await withServer(async ({ base, handle }) => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, authed({ signal: controller.signal }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    handle.events.emit('test:ping', { hello: 'world' });

    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !buf.includes('test:ping')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    controller.abort();
    assert.match(buf, /test:ping/);
    assert.match(buf, /world/);
  });
});

test('API: scheduler tick chay duoc va khong sap khi queue rong', async () => {
  await withServer(async ({ call }) => {
    const res = await call('/api/scheduler/tick', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.result, { published: 0, failed: 0 });
  });
});

test('scheduler: bai den gio duoc dang, loi vinh vien -> failed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-sch-'));
  try {
    const { PostScheduler } = await import('../src/core/scheduler.js');
    const ws = await new Workspace({ dir }).init();
    const post = await ws.createPost({
      content: { title: 'x' },
      channelIds: ['ch_1'],
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      status: 'queued',
    });

    // Publisher gia: nem loi khong retryable.
    const publisher = {
      publishPost: async () => {
        const err = new Error('token chet');
        err.retryable = false;
        throw err;
      },
    };
    const scheduler = new PostScheduler({
      workspace: ws,
      publisher: /** @type {any} */ (publisher),
      logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this; }, level: 'silent' },
    });
    const res = await scheduler.tick();
    assert.equal(res.failed, 1);
    const after = await ws.posts.get(post.id);
    assert.equal(after.status, 'failed');
    assert.match(after.note, /token chet/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduler: loi tam thoi -> lui lich thay vi that bai', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-sch2-'));
  try {
    const { PostScheduler } = await import('../src/core/scheduler.js');
    const ws = await new Workspace({ dir }).init();
    const post = await ws.createPost({
      content: { title: 'x' },
      channelIds: ['ch_1'],
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      status: 'queued',
    });
    const publisher = {
      publishPost: async () => {
        const err = new Error('mang loi');
        err.retryable = true;
        throw err;
      },
    };
    const scheduler = new PostScheduler({
      workspace: ws,
      publisher: /** @type {any} */ (publisher),
      logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this; }, level: 'silent' },
    });
    await scheduler.tick();
    const after = await ws.posts.get(post.id);
    assert.equal(after.status, 'queued', 'phai giu trong queue de thu lai');
    assert.ok(new Date(after.scheduledAt).getTime() > Date.now(), 'phai lui lich ve tuong lai');
    assert.match(after.note, /Thu lai lan 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PublishService: bao loi ro khi file media bi xoa khoi dia', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wam-pub-'));
  try {
    const { PublishService } = await import('../src/core/publishservice.js');
    const ws = await new Workspace({ dir }).init();
    const ch = await ws.saveChannel({
      platform: 'telegram', name: 'CH', externalId: '-1', config: { botToken: '1:a', chatId: '-1' },
    });
    const rec = await ws.addMedia({
      filename: 'mat.jpg', mime: 'image/jpeg', kind: 'image', size: 10,
      storedPath: path.join(dir, 'khong-ton-tai.jpg'),
    });
    const post = await ws.createPost({ content: { title: 'x' }, mediaIds: [rec.id], channelIds: [ch.id] });

    const publisher = new PublishService({
      workspace: ws,
      logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this; }, level: 'silent' },
    });
    await assert.rejects(() => publisher.publishPost(post.id), /Media files missing/);
    const after = await ws.posts.get(post.id);
    assert.equal(after.status, 'failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ==================================================== TikTok creator_info

test('API: creator-info tra ve dung field web admin can de dung form TikTok', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    {
      match: '/creator_info/query/',
      json: {
        data: {
          creator_nickname: 'Wall Guy',
          creator_username: 'wallguy',
          creator_avatar_url: 'https://cdn.test/a.jpg',
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
          comment_disabled: false,
          duet_disabled: true,
          stitch_disabled: true,
          max_video_post_duration_sec: 600,
        },
        error: { code: 'ok' },
      },
    },
  ]);

  // Chi chan request di TikTok: `call()` cua test cung dung fetch de goi server.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).includes('tiktokapis.com')
    ? mock.fetchImpl(url, init)
    : realFetch(url, init));
  try {
    await withServer(async ({ call, handle }) => {
      await handle.workspace.saveChannel({
        platform: 'tiktok',
        name: 'Wall Guy',
        externalId: 'open_id_1',
        config: { clientKey: 'k', clientSecret: 's', refreshToken: 'r', postMode: 'DIRECT_POST' },
      });
      const channels = await handle.workspace.listChannels();
      const id = channels[0].id;

      const { status, data } = await call(`/api/channels/${id}/creator-info`);
      assert.equal(status, 200);
      assert.deepEqual(data.creatorInfo.privacyLevelOptions,
        ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY']);
      assert.equal(data.creatorInfo.nickname, 'Wall Guy');
      assert.equal(data.creatorInfo.username, 'wallguy');
      // Cac o comment/duet/stitch trong UI phai khoa theo dung cai creator da tat.
      assert.equal(data.creatorInfo.commentDisabled, false);
      assert.equal(data.creatorInfo.duetDisabled, true);
      assert.equal(data.creatorInfo.stitchDisabled, true);
      assert.equal(data.creatorInfo.maxVideoPostDurationSec, 600);
      // KHONG duoc lo token ra frontend.
      assert.equal(JSON.stringify(data).includes('refreshToken'), false);
      assert.equal(JSON.stringify(data).includes('AT'), false);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('API: creator-info tu choi kenh khong phai TikTok', async () => {
  await withServer(async ({ call, handle }) => {
    await handle.workspace.saveChannel({
      platform: 'telegram',
      name: 'Kenh Telegram',
      externalId: 'tg_1',
      config: { botToken: '123:ABC', chatId: '@kenh' },
    });
    const channels = await handle.workspace.listChannels();
    const { status, data } = await call(`/api/channels/${channels[0].id}/creator-info`);
    assert.equal(status, 400);
    assert.match(String(data.error), /not a TikTok account/i);
  });
});

test('API: channels khong lo token nhung van tra postMode cho form TikTok', async () => {
  await withServer(async ({ call, handle }) => {
    await handle.workspace.saveChannel({
      platform: 'tiktok',
      name: 'Wall Guy',
      externalId: 'open_id_2',
      config: { clientKey: 'k', clientSecret: 's', refreshToken: 'r', accessToken: 'SECRET', postMode: 'MEDIA_UPLOAD' },
    });
    const { status, data } = await call('/api/channels');
    assert.equal(status, 200);
    const ch = data.channels.find((c) => c.platform === 'tiktok');
    assert.equal(ch.options.postMode, 'MEDIA_UPLOAD', 'UI can biet kieu dang mac dinh cua kenh');
    assert.equal(JSON.stringify(data).includes('SECRET'), false, 'khong duoc tra token ve client');
  });
});

// ============================================== redirect_uri (TikTok cần https)

test('API: TikTok chap nhan redirect_uri http (app o che do Sandbox)', async () => {
  await withServer(async ({ call }) => {
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ credentials: { tiktok: { clientKey: 'CK', clientSecret: 'CS' } } }),
    });
    // Khong dat redirectUri -> mac dinh la http://127.0.0.1:<port>/oauth/tiktok/callback.
    // Sandbox nhan URL nay, nen app KHONG duoc tu chan theo scheme.
    const res = await call('/api/oauth/tiktok/start', { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    const redirect = new URL(res.data.url).searchParams.get('redirect_uri');
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/tiktok\/callback$/);
  });
});

test('API: redirectUri tu dat duoc dung cho ca authorize lan doi token', async () => {
  await withServer(async ({ call }) => {
    const bridge = 'https://example.test/tiktok-callback';
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ credentials: { tiktok: { clientKey: 'CK', clientSecret: 'CS', redirectUri: bridge } } }),
    });

    const state = await call('/api/state');
    const tiktok = state.data.providers.find((p) => p.id === 'tiktok');
    assert.equal(tiktok.redirectUri, bridge, 'UI phai hien URL that de dan vao app TikTok');
    assert.equal(tiktok.redirectUriCustom, true);

    const res = await call('/api/oauth/tiktok/start', { method: 'POST', body: '{}' });
    assert.equal(new URL(res.data.url).searchParams.get('redirect_uri'), bridge);
  });
});

test('API: xoa redirectUri -> quay ve URL suy ra tu dia chi web admin', async () => {
  await withServer(async ({ call }) => {
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ credentials: { google: { clientId: 'ID', clientSecret: 'SEC', redirectUri: 'https://example.test/cb' } } }),
    });
    let state = await call('/api/state');
    assert.equal(state.data.providers.find((p) => p.id === 'google').redirectUri, 'https://example.test/cb');

    // Gui chuoi rong = xoa. Client secret de trong = giu nguyen.
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ credentials: { google: { redirectUri: '' } } }),
    });
    state = await call('/api/state');
    const google = state.data.providers.find((p) => p.id === 'google');
    assert.match(google.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/google\/callback$/);
    assert.equal(google.redirectUriCustom, false);
    assert.equal(google.configured, true, 'xoa redirectUri khong duoc lam mat client secret');
  });
});

test('API: settings tra ve redirectUri nhung van che secret', async () => {
  await withServer(async ({ call }) => {
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ credentials: { tiktok: { clientKey: 'CK', clientSecret: 'SUPERSECRET', redirectUri: 'https://example.test/cb' } } }),
    });
    const { data } = await call('/api/settings');
    assert.equal(data.settings.credentials.tiktok.redirectUri, 'https://example.test/cb');
    assert.equal(data.settings.credentials.tiktok.clientKey, 'CK');
    assert.equal(JSON.stringify(data).includes('SUPERSECRET'), false, 'secret khong duoc lo');
  });
});

// ====================================== TikTok: doi code lay token (v2/oauth/token)

/** Chay tron mot vong OAuth TikTok voi fetch gia lap, tra ve request da ghi. */
async function runTikTokOAuth(call, mock, creds = {}) {
  await call('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      credentials: { tiktok: { clientKey: 'CK', clientSecret: 'CS', ...creds } },
    }),
  });
  const start = await call('/api/oauth/tiktok/start', { method: 'POST', body: '{}' });
  const state = new URL(start.data.url).searchParams.get('state');
  return { state, start };
}

test('API: doi code TikTok gui dung content-type va tham so bat buoc', async () => {
  const mock = createMockFetch([
    {
      match: '/v2/oauth/token/',
      json: {
        access_token: 'AT', refresh_token: 'RT', expires_in: 86400,
        open_id: 'open1', scope: 'user.info.basic,video.publish',
      },
    },
    { match: '/v2/user/info/', json: { data: { user: { open_id: 'open1', display_name: 'Wall Guy', username: 'wallguy' } } } },
  ]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).includes('tiktokapis.com')
    ? mock.fetchImpl(url, init)
    : realFetch(url, init));
  try {
    await withServer(async ({ call, base }) => {
      const { state } = await runTikTokOAuth(call, mock);
      const res = await fetch(`${base}/oauth/tiktok/callback?code=act.abc123&state=${state}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location'), /[?&]ok=/, 'phai ket noi thanh cong');

      const req = mock.findRequest('/v2/oauth/token/');
      // Endpoint nay tu choi khi content-type co them '; charset=utf-8'.
      assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(req.body.grant_type, 'authorization_code');
      assert.equal(req.body.client_key, 'CK');
      assert.equal(req.body.client_secret, 'CS');
      assert.equal(req.body.code, 'act.abc123');
      assert.ok(req.body.code_verifier, 'PKCE: phai gui code_verifier');
      assert.match(req.body.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/tiktok\/callback$/);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('API: client key/secret dinh khoang trang van doi duoc token', async () => {
  const mock = createMockFetch([
    {
      match: '/v2/oauth/token/',
      handler: (req) => (req.body.client_key === 'CK' && req.body.client_secret === 'CS'
        ? { json: { access_token: 'AT', refresh_token: 'RT', expires_in: 86400, open_id: 'o1', scope: 'video.publish' } }
        : { status: 400, json: { error: 'invalid_request', error_description: 'The request parameters are malformed.' } }),
    },
    { match: '/v2/user/info/', json: { data: { user: { open_id: 'o1', display_name: 'X' } } } },
  ]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).includes('tiktokapis.com')
    ? mock.fetchImpl(url, init)
    : realFetch(url, init));
  try {
    await withServer(async ({ call, base }) => {
      // Nguoi dung dan key/secret kem khoang trang va xuong dong.
      const { state } = await runTikTokOAuth(call, mock, { clientKey: '  CK\n', clientSecret: ' CS  ' });
      const res = await fetch(`${base}/oauth/tiktok/callback?code=act.x&state=${state}`, { redirect: 'manual' });
      assert.match(res.headers.get('location'), /[?&]ok=/, 'khoang trang khong duoc lam hong request');
      assert.equal(mock.findRequest('/v2/oauth/token/').body.client_key, 'CK');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('API: TikTok tu choi doi code -> loi neu ro redirect_uri va client_key da dung', async () => {
  const mock = createMockFetch([
    {
      match: '/v2/oauth/token/',
      status: 400,
      json: { error: 'invalid_request', error_description: 'The request parameters are malformed.', log_id: 'LOG123' },
    },
  ]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).includes('tiktokapis.com')
    ? mock.fetchImpl(url, init)
    : realFetch(url, init));
  try {
    await withServer(async ({ call, base }) => {
      const { state } = await runTikTokOAuth(call, mock);
      const res = await fetch(`${base}/oauth/tiktok/callback?code=act.x&state=${state}`, { redirect: 'manual' });
      const loc = res.headers.get('location');
      const msg = decodeURIComponent(loc.split('error=')[1] ?? '');
      // Loi phai in ra du lieu doi chieu duoc, khong bat nguoi dung tu doan.
      assert.match(msg, /malformed/i);
      assert.match(msg, /127\.0\.0\.1/, 'phai in redirect_uri vua gui');
      assert.match(msg, /CK/, 'phai in client_key dang dung');
      assert.match(msg, /LOG123/, 'phai in log_id de bao TikTok support');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ============================================ TikTok: co "app da qua audit"

test('API: co audited luu duoc dang boolean, khong bi bien thanh chuoi', async () => {
  await withServer(async ({ call }) => {
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ credentials: { tiktok: { clientKey: 'CK', clientSecret: 'CS', audited: true } } }),
    });
    let { data } = await call('/api/settings');
    assert.equal(data.settings.credentials.tiktok.audited, true);

    // Tat lai: false phai ghi de duoc (khong bi coi la "bo trong = khong doi").
    await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ credentials: { tiktok: { audited: false } } }),
    });
    ({ data } = await call('/api/settings'));
    assert.equal(data.settings.credentials.tiktok.audited, false);
    assert.equal(data.settings.credentials.tiktok.clientKey, 'CK', 'khong duoc lam mat client key');
  });
});

test('API: mac dinh audited = false (app moi luon chua audit)', async () => {
  await withServer(async ({ call }) => {
    const { data } = await call('/api/settings');
    assert.equal(data.settings.credentials.tiktok.audited, false);
  });
});

// ====================================== nguoi dung, phan quyen va audit log

/** Dang nhap, tra ve ham goi API mang theo cookie phien cua nguoi do. */
async function loginAs(base, username, password) {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  const body = await res.json().catch(() => ({}));
  const call = async (p, init = {}) => {
    const r = await fetch(`${base}${p}`, {
      ...init,
      headers: {
        ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        cookie,
        ...(init.headers ?? {}),
      },
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: r.status, data };
  };
  return { status: res.status, cookie, user: body.user, call };
}

/** Tao admin + mot nhan vien, tra ve ca hai kem mot kenh de cap quyen. */
async function seedTeam(handle, call) {
  const channel = await handle.workspace.saveChannel({
    platform: 'tiktok', name: 'Brand VN', externalId: 'open_a',
    config: { clientKey: 'k', clientSecret: 's', refreshToken: 'r' },
  });
  const other = await handle.workspace.saveChannel({
    platform: 'tiktok', name: 'Brand EN', externalId: 'open_b',
    config: { clientKey: 'k', clientSecret: 's', refreshToken: 'r' },
  });
  const created = await call('/api/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'nhanvien', displayName: 'Nhan Vien', role: 'member', canPublish: true }),
  });
  return { channel, other, member: created.data.user, password: created.data.password };
}

test('users: lan dau chay tu tao admin va in mat khau mot lan', async () => {
  await withServer(async ({ handle, base }) => {
    assert.ok(handle.firstAdmin, 'phai tao admin dau tien');
    assert.equal(handle.firstAdmin.user.username, 'admin');
    assert.ok(handle.firstAdmin.password.length >= 10);

    const ok = await loginAs(base, 'admin', handle.firstAdmin.password);
    assert.equal(ok.status, 200);
    assert.equal(ok.user.role, 'admin');

    const bad = await loginAs(base, 'admin', 'sai-mat-khau');
    assert.equal(bad.status, 401);
  });
});

test('users: mat khau khong bao gio ra khoi server', async () => {
  await withServer(async ({ call, handle }) => {
    await seedTeam(handle, call);
    const { data } = await call('/api/users');
    const raw = JSON.stringify(data);
    assert.equal(raw.includes('hash'), false, 'khong duoc lo hash');
    assert.equal(raw.includes('salt'), false, 'khong duoc lo salt');
  });
});

test('phan quyen: member chi THAY kenh duoc cap', async () => {
  await withServer(async ({ call, handle, base }) => {
    const { channel, member, password } = await seedTeam(handle, call);
    await call(`/api/users/${member.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ channelIds: [channel.id] }),
    });

    const nv = await loginAs(base, 'nhanvien', password);
    const state = await nv.call('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.data.channels.length, 1, 'chi thay 1 trong 2 kenh');
    assert.equal(state.data.channels[0].id, channel.id);
    assert.equal(state.data.me.role, 'member');
  });
});

test('phan quyen: tai khoan moi duoc cap san cac kenh admin da connect', async () => {
  await withServer(async ({ call, handle, base }) => {
    // seedTeam tao nguoi dung ma KHONG gui channelIds -> phai duoc cap ca 2 kenh.
    const { channel, other, member, password } = await seedTeam(handle, call);
    assert.deepEqual([...member.channelIds].sort(), [channel.id, other.id].sort());

    const nv = await loginAs(base, 'nhanvien', password);
    const state = await nv.call('/api/state');
    assert.equal(state.data.channels.length, 2, 'nhan vien phai thay ngay ca 2 kenh');

    // Gui channelIds tuong minh thi ton trong dung nhu vay - ke ca mang rong.
    const strict = await call('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'nhanvien2', role: 'member', channelIds: [] }),
    });
    assert.deepEqual(strict.data.user.channelIds, []);
  });
});

test('phan quyen: kenh connect SAU khong tu cap cho nguoi cu', async () => {
  await withServer(async ({ call, handle, base }) => {
    const { password } = await seedTeam(handle, call);
    const late = await handle.workspace.saveChannel({
      platform: 'tiktok', name: 'Brand moi', externalId: 'open_c',
      config: { clientKey: 'k', clientSecret: 's', refreshToken: 'r' },
    });

    const nv = await loginAs(base, 'nhanvien', password);
    const ids = (await nv.call('/api/state')).data.channels.map((c) => c.id);
    assert.equal(ids.includes(late.id), false, 'kenh them sau phai do admin tick tay');
    assert.equal(ids.length, 2);
  });
});

test('phan quyen: member KHONG dang duoc len kenh chua duoc cap', async () => {
  await withServer(async ({ call, handle, base }) => {
    const { channel, other, member, password } = await seedTeam(handle, call);
    await call(`/api/users/${member.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ channelIds: [channel.id] }),
    });

    // Bai nham vao kenh KHONG duoc cap - tao bang admin de chac chan bai ton tai.
    const post = await handle.workspace.createPost({
      content: { title: 'x', description: 'y', hashtags: [] },
      channelIds: [other.id],
      status: 'draft',
    });

    const nv = await loginAs(base, 'nhanvien', password);
    const res = await nv.call(`/api/posts/${post.id}/publish`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 403, 'server phai chan, khong chi an tren UI');
    assert.match(String(res.data.error), /not been granted access/i);
  });
});

test('phan quyen: khong co canPublish thi soan duoc nhung khong dang duoc', async () => {
  await withServer(async ({ call, handle, base }) => {
    const { channel, member, password } = await seedTeam(handle, call);
    await call(`/api/users/${member.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ channelIds: [channel.id], canPublish: false }),
    });

    const nv = await loginAs(base, 'nhanvien', password);
    // Van soan va luu nhap duoc.
    const draft = await nv.call('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'nhap', description: 'd', channelIds: [channel.id] }),
    });
    assert.equal(draft.status, 200);

    const res = await nv.call(`/api/posts/${draft.data.post.id}/publish`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 403);
    assert.match(String(res.data.error), /only draft posts/i);
  });
});

test('phan quyen: member khong dung duoc route cua admin', async () => {
  await withServer(async ({ call, handle, base }) => {
    const { member, password } = await seedTeam(handle, call);
    const nv = await loginAs(base, 'nhanvien', password);

    for (const [p, init] of [
      ['/api/users', {}],
      ['/api/audit', {}],
      ['/api/oauth/tiktok/start', { method: 'POST', body: '{}' }],
      ['/api/settings', { method: 'PUT', body: '{}' }],
    ]) {
      const res = await nv.call(p, init);
      assert.equal(res.status, 403, `${p} phai tra 403 voi member`);
    }
    // Tu sua quyen cua chinh minh cung khong duoc.
    const self = await nv.call(`/api/users/${member.id}`, {
      method: 'PATCH', body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(self.status, 403);
  });
});

test('phan quyen: tat tai khoan la dang xuat ngay lap tuc', async () => {
  await withServer(async ({ call, handle, base }) => {
    const { member, password } = await seedTeam(handle, call);
    const nv = await loginAs(base, 'nhanvien', password);
    assert.equal((await nv.call('/api/state')).status, 200);

    await call(`/api/users/${member.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });

    assert.equal((await nv.call('/api/state')).status, 401, 'phien cu phai chet ngay');
  });
});

test('phan quyen: khong the ha quyen admin cuoi cung', async () => {
  await withServer(async ({ call, handle }) => {
    const admins = (await handle.workspace.users.all()).filter((u) => u.role === 'admin');
    assert.equal(admins.length, 1);
    const res = await call(`/api/users/${admins[0].id}`, {
      method: 'PATCH', body: JSON.stringify({ role: 'member' }),
    });
    assert.notEqual(res.status, 200, 'phai tu choi');
  });
});

test('phan quyen: ngat kenh thi go luon khoi quyen cua moi nguoi', async () => {
  await withServer(async ({ call, handle }) => {
    const { channel, member } = await seedTeam(handle, call);
    await call(`/api/users/${member.id}`, {
      method: 'PATCH', body: JSON.stringify({ channelIds: [channel.id] }),
    });

    await call(`/api/channels/${channel.id}`, { method: 'DELETE' });

    const after = await handle.workspace.users.get(member.id);
    assert.deepEqual(after.channelIds, [], 'khong de lai quyen treo tren kenh da xoa');
  });
});

test('audit log: ghi lai dang nhap, tao nguoi dung va doi quyen', async () => {
  await withServer(async ({ call, handle, base }) => {
    const { channel, member, password } = await seedTeam(handle, call);
    await call(`/api/users/${member.id}`, {
      method: 'PATCH', body: JSON.stringify({ channelIds: [channel.id] }),
    });
    await loginAs(base, 'nhanvien', password);

    const { data } = await call('/api/audit');
    const actions = data.entries.map((e) => e.action);
    assert.ok(actions.includes('user.create'), 'phai ghi viec tao nguoi dung');
    assert.ok(actions.includes('user.update'), 'phai ghi viec doi quyen');
    assert.ok(actions.includes('auth.login'), 'phai ghi viec dang nhap');

    const login = data.entries.find((e) => e.action === 'auth.login' && e.username === 'nhanvien');
    assert.ok(login, 'phai biet AI dang nhap');
    assert.ok(login.at, 'phai biet LUC NAO');
  });
});

test('audit log: ghi ca lan dang bi tu choi vi thieu quyen', async () => {
  await withServer(async ({ call, handle, base }) => {
    const { other, member, password } = await seedTeam(handle, call);
    const post = await handle.workspace.createPost({
      content: { title: 'x' }, channelIds: [other.id], status: 'draft',
    });
    const nv = await loginAs(base, 'nhanvien', password);
    await nv.call(`/api/posts/${post.id}/publish`, { method: 'POST', body: '{}' });

    const { data } = await call('/api/audit?action=post.publish');
    const denied = data.entries.find((e) => e.result === 'fail');
    assert.ok(denied, 'lan bi tu choi cung phai vao log');
    assert.equal(denied.username, 'nhanvien');
  });
});
