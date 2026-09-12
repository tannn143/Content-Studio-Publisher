import test from 'node:test';
import assert from 'node:assert/strict';

import { TelegramPlatform } from '../src/platforms/telegram.js';
import { YouTubePlatform } from '../src/platforms/youtube.js';
import { FacebookPlatform } from '../src/platforms/facebook.js';
import { InstagramPlatform } from '../src/platforms/instagram.js';
import { TikTokPlatform, clipRunes, extractBigIntList } from '../src/platforms/tiktok.js';
import { buildTags, buildTitle, buildDescription, truncateBytes, normalizeChunkSize, parseRangeEnd } from '../src/platforms/youtube.js';
import { normalizeUserTags } from '../src/platforms/instagram.js';
import { normalizePost } from '../src/core/post.js';
import { MemoryTokenStore } from '../src/core/tokenstore.js';
import { noopLogger } from '../src/core/logger.js';
import { FunctionMediaHost } from '../src/core/mediahost/index.js';
import { createMockFetch, fakeJpeg, fakeMp4, fakePng } from './helpers.js';

/** Tao ctx cho platform voi http gia lap. */
function ctxWith(mock, extra = {}) {
  return {
    http: mock.http,
    logger: noopLogger,
    store: new MemoryTokenStore(),
    ...extra,
  };
}

const publicHost = new FunctionMediaHost(async (media) => ({
  url: `https://cdn.test/${media.filename ?? 'file'}`,
  cleanup: async () => {},
}));

// =========================================================== TELEGRAM

test('telegram: anh URL -> sendPhoto voi caption va parse_mode HTML', async () => {
  const mock = createMockFetch([
    { match: '/sendPhoto', json: { ok: true, result: { message_id: 11, chat: { id: -1001234567890, username: 'ch' } } } },
  ]);
  const tg = new TelegramPlatform({ botToken: '123:abc', chatId: '@ch' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'Tieu de',
    description: 'Noi dung',
    hashtags: ['wallpaper'],
    media: 'https://cdn.test/a.jpg',
  });

  const res = await tg.publish(post);
  const req = mock.findRequest('/sendPhoto');

  assert.equal(res.ok, true);
  assert.equal(res.id, '11');
  assert.equal(res.url, 'https://t.me/ch/11');
  assert.equal(req.body.chat_id, '@ch');
  assert.equal(req.body.photo, 'https://cdn.test/a.jpg');
  assert.equal(req.body.parse_mode, 'HTML');
  assert.ok(req.body.caption.includes('<b>Tieu de</b>'), req.body.caption);
  assert.ok(req.body.caption.includes('#wallpaper'));
});

test('telegram: file local -> upload multipart sendPhoto', async () => {
  const mock = createMockFetch([
    { match: '/sendPhoto', json: { ok: true, result: { message_id: 5, chat: { id: 1 } } } },
  ]);
  const tg = new TelegramPlatform({ botToken: '123:abc', chatId: '111' }, ctxWith(mock));
  const post = await normalizePost({ title: 'x', media: { buffer: fakeJpeg(2048), filename: 'w.jpg' } });

  await tg.publish(post);
  const req = mock.findRequest('/sendPhoto');
  assert.ok(req.body.photo?.__file, 'phai gui file multipart');
  assert.equal(req.body.photo.type, 'image/jpeg');
});

test('telegram: 12 anh -> chia thanh 2 album, caption chi o item dau tien cua album dau', async () => {
  const mock = createMockFetch([
    { match: '/sendMediaGroup', json: { ok: true, result: [{ message_id: 1, chat: { id: 1 } }] } },
  ]);
  const tg = new TelegramPlatform({ botToken: '123:abc', chatId: '111' }, ctxWith(mock));
  const media = Array.from({ length: 12 }, (_, i) => ({ url: `https://cdn.test/${i}.jpg`, type: 'image' }));
  const post = await normalizePost({ title: 'Album', description: 'mo ta', media, hashtags: ['a'] });

  await tg.publish(post);
  assert.equal(mock.countRequests('/sendMediaGroup'), 2, 'phai chia 2 album');

  const first = JSON.parse(mock.requests.filter((r) => r.url.includes('sendMediaGroup'))[0].body.media);
  const second = JSON.parse(mock.requests.filter((r) => r.url.includes('sendMediaGroup'))[1].body.media);
  assert.equal(first.length, 10);
  assert.equal(second.length, 2);
  assert.ok(first[0].caption, 'item dau album dau phai co caption');
  assert.equal(first[1].caption, undefined, 'cac item sau khong duoc co caption');
  assert.equal(second[0].caption, undefined, 'album thu 2 khong co caption');
});

test('telegram: GIF khong tron vao album cung anh (Telegram khong cho document + photo)', async () => {
  const mock = createMockFetch([
    { match: '/sendMediaGroup', json: { ok: true, result: [{ message_id: 1, chat: { id: 1 } }] } },
    { match: '/sendAnimation', json: { ok: true, result: { message_id: 2, chat: { id: 1 } } } },
    { match: '/sendPhoto', json: { ok: true, result: { message_id: 3, chat: { id: 1 } } } },
  ]);
  const tg = new TelegramPlatform({ botToken: '123:abc', chatId: '1' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'x',
    media: [
      { url: 'https://cdn.test/a.gif', mime: 'image/gif' },
      { url: 'https://cdn.test/b.jpg', mime: 'image/jpeg' },
    ],
  });
  await tg.publish(post);
  // GIF va anh phai duoc gui rieng, khong duoc gop thanh mot album.
  assert.equal(mock.countRequests('/sendMediaGroup'), 0);
  assert.equal(mock.countRequests('/sendAnimation'), 1);
  assert.equal(mock.countRequests('/sendPhoto'), 1);
});

test('telegram: album 3 anh + 1 GIF -> album 3 anh roi GIF rieng', async () => {
  const mock = createMockFetch([
    { match: '/sendMediaGroup', json: { ok: true, result: [{ message_id: 1, chat: { id: 1 } }] } },
    { match: '/sendAnimation', json: { ok: true, result: { message_id: 9, chat: { id: 1 } } } },
  ]);
  const tg = new TelegramPlatform({ botToken: '123:abc', chatId: '1' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'Bo anh',
    media: [
      { url: 'https://cdn.test/1.jpg', mime: 'image/jpeg' },
      { url: 'https://cdn.test/2.jpg', mime: 'image/jpeg' },
      { url: 'https://cdn.test/3.jpg', mime: 'image/jpeg' },
      { url: 'https://cdn.test/a.gif', mime: 'image/gif' },
    ],
  });
  await tg.publish(post);
  assert.equal(mock.countRequests('/sendMediaGroup'), 1);
  const items = JSON.parse(mock.findRequest('/sendMediaGroup').body.media);
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.type === 'photo'));
  assert.ok(items[0].caption, 'caption o item dau tien cua album dau');
  assert.equal(mock.countRequests('/sendAnimation'), 1);
});

test('telegram: MarkdownV2 escape ca hashtag (# la ky tu bat buoc escape)', async () => {
  const mock = createMockFetch([
    { match: '/sendPhoto', json: { ok: true, result: { message_id: 1, chat: { id: 1 } } } },
  ]);
  const tg = new TelegramPlatform(
    { botToken: '123:abc', chatId: '1', parseMode: 'MarkdownV2' },
    ctxWith(mock),
  );
  const post = await normalizePost({
    title: 'Tieu de',
    description: 'Noi dung co dau. Va dau gach-ngang!',
    hashtags: ['wallpaper', '4k'],
    media: 'https://cdn.test/a.jpg',
  });
  await tg.publish(post);
  const caption = mock.findRequest('/sendPhoto').body.caption;
  assert.ok(caption.includes('\\#wallpaper'), `hashtag phai duoc escape: ${caption}`);
  assert.ok(caption.includes('\\.'), 'dau cham phai duoc escape');
  assert.ok(caption.includes('\\-'), 'dau gach ngang phai duoc escape');
  assert.ok(caption.includes('*Tieu de*'), 'title in dam');
});

test('telegram: bai text-only -> sendMessage', async () => {
  const mock = createMockFetch([
    { match: '/sendMessage', json: { ok: true, result: { message_id: 9, chat: { id: 1 } } } },
  ]);
  const tg = new TelegramPlatform({ botToken: '123:abc', chatId: '1' }, ctxWith(mock));
  const post = await normalizePost({ title: 'Chi co chu', description: 'noi dung' });
  await tg.publish(post);
  assert.ok(mock.findRequest('/sendMessage').body.text.includes('Chi co chu'));
});

test('telegram: caption qua dai + longCaptionMode=split -> gui tin nhan phu', async () => {
  const mock = createMockFetch([
    { match: '/sendPhoto', json: { ok: true, result: { message_id: 1, chat: { id: 1 } } } },
    { match: '/sendMessage', json: { ok: true, result: { message_id: 2, chat: { id: 1 } } } },
  ]);
  const tg = new TelegramPlatform(
    { botToken: '123:abc', chatId: '1', longCaptionMode: 'split' },
    ctxWith(mock),
  );
  const post = await normalizePost({
    title: 'Tieu de',
    description: 'x'.repeat(2000),
    hashtags: ['a'],
    media: 'https://cdn.test/a.jpg',
  });
  const res = await tg.publish(post);
  assert.equal(mock.countRequests('/sendMessage'), 1, 'phai gui phan con lai');
  assert.equal(res.meta.messages.length, 2);
  const extra = mock.findRequest('/sendMessage');
  assert.deepEqual(extra.body.reply_parameters, { message_id: 1 });
});

test('telegram: 429 -> doc retry_after va thu lai', async () => {
  const mock = createMockFetch([
    {
      match: '/sendPhoto',
      handler: (_req, hit) => (hit === 1
        ? { status: 429, json: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } } }
        : { status: 200, json: { ok: true, result: { message_id: 7, chat: { id: 1 } } } }),
    },
  ]);
  const tg = new TelegramPlatform({ botToken: '123:abc', chatId: '1' }, ctxWith(mock));
  const post = await normalizePost({ title: 'x', media: 'https://cdn.test/a.jpg' });
  const res = await tg.publish(post);
  assert.equal(res.id, '7');
  assert.equal(mock.countRequests('/sendPhoto'), 2);
});

test('telegram: 400 chat not found -> loi co goi y, khong retry', async () => {
  const mock = createMockFetch([
    { match: '/sendPhoto', status: 400, json: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } },
  ]);
  const tg = new TelegramPlatform({ botToken: '123:abc', chatId: 'sai' }, ctxWith(mock));
  const post = await normalizePost({ title: 'x', media: 'https://cdn.test/a.jpg' });
  await assert.rejects(() => tg.publish(post), (err) => {
    assert.match(err.message, /chat not found/);
    assert.match(err.hint, /Wrong chat_id/);
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(mock.countRequests('/sendPhoto'), 1, 'khong duoc retry loi 400');
});

test('telegram: verifyCredentials phat hien bot khong phai admin', async () => {
  const mock = createMockFetch([
    { match: '/getMe', json: { ok: true, result: { id: 42, username: 'bot' } } },
    { match: '/getChat', json: { ok: true, result: { id: -100123, title: 'CH', type: 'channel' } } },
    { match: '/getChatMember', json: { ok: true, result: { status: 'member' } } },
  ]);
  const tg = new TelegramPlatform({ botToken: '123:abc', chatId: '@ch' }, ctxWith(mock));
  const res = await tg.verifyCredentials();
  assert.equal(res.ok, false);
  assert.match(res.error.message, /cannot post in chat/);
});

test('telegram: nhieu chat -> gui lan luot tung chat', async () => {
  const mock = createMockFetch([
    { match: '/sendPhoto', json: { ok: true, result: { message_id: 1, chat: { id: 1 } } } },
  ]);
  const tg = new TelegramPlatform({ botToken: '123:abc', chatId: ['@a', '@b'] }, ctxWith(mock));
  const post = await normalizePost({ title: 'x', media: 'https://cdn.test/a.jpg' });
  const res = await tg.publish(post);
  assert.equal(mock.countRequests('/sendPhoto'), 2);
  assert.equal(res.meta.chats, 2);
});

// ============================================================ YOUTUBE

test('youtube: resumable upload - header va part dung, chunk Content-Range chinh xac', async () => {
  const videoSize = 3 * 262_144; // 768KB
  const mock = createMockFetch([
    { match: 'oauth2.googleapis.com/token', json: { access_token: 'AT', expires_in: 3600 } },
    {
      match: 'upload/youtube/v3/videos',
      method: 'POST',
      status: 200,
      text: '',
      headers: { location: 'https://upload.example/session-123' },
    },
    {
      match: 'upload.example/session-123',
      method: 'PUT',
      handler: (req) => {
        const cr = req.headers['content-range'];
        if (cr === `bytes 0-262143/${videoSize}`) {
          return { status: 308, text: '', headers: { range: 'bytes=0-262143' } };
        }
        if (cr === `bytes 262144-524287/${videoSize}`) {
          return { status: 308, text: '', headers: { range: 'bytes=0-524287' } };
        }
        return { status: 200, json: { id: 'VID123', status: { uploadStatus: 'uploaded', privacyStatus: 'private' } } };
      },
    },
    {
      match: 'youtube/v3/videos?',
      method: 'GET',
      json: { items: [{ status: { uploadStatus: 'processed' }, processingDetails: { processingStatus: 'succeeded' } }] },
    },
  ]);

  const yt = new YouTubePlatform(
    { clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt', chunkSizeBytes: 262_144 },
    ctxWith(mock),
  );
  const post = await normalizePost({
    title: 'Video 4K',
    description: 'mo ta',
    hashtags: ['wallpaper', '4k'],
    media: { buffer: fakeMp4(videoSize), filename: 'v.mp4' },
    overrides: { youtube: { probeMedia: false, privacyStatus: 'private' } },
  });

  const res = await yt.publish(post);
  assert.equal(res.id, 'VID123');
  assert.equal(res.url, 'https://www.youtube.com/watch?v=VID123');

  const init = mock.findRequest('upload/youtube/v3/videos');
  assert.equal(init.query.get('uploadType'), 'resumable');
  assert.equal(init.query.get('part'), 'snippet,status', 'part phai khop key cua body');
  assert.equal(init.headers['x-upload-content-length'], String(videoSize), 'X-Upload-Content-Length = size video');
  assert.equal(init.headers['x-upload-content-type'], 'video/mp4');
  assert.equal(init.query.get('notifySubscribers'), 'false', 'mac dinh khong spam subscriber');
  assert.equal(init.body.snippet.title, 'Video 4K');
  assert.equal(init.body.status.privacyStatus, 'private');
  assert.equal(init.body.status.selfDeclaredMadeForKids, false);
  assert.equal(init.body.status.madeForKids, undefined, 'madeForKids la read-only, khong duoc gui');
  assert.ok(init.body.snippet.description.includes('#wallpaper'));

  const puts = mock.requests.filter((r) => r.url.includes('session-123'));
  assert.equal(puts.length, 3);
  assert.equal(puts[0].headers['content-range'], `bytes 0-262143/${videoSize}`);
  assert.equal(puts[2].headers['content-range'], `bytes 524288-786431/${videoSize}`);
});

test('youtube: probe lai offset tu server sau khi chunk loi', async () => {
  const videoSize = 2 * 262_144;
  let putCount = 0;
  const mock = createMockFetch([
    { match: 'oauth2.googleapis.com/token', json: { access_token: 'AT', expires_in: 3600 } },
    { match: 'upload/youtube/v3/videos', method: 'POST', text: '', headers: { location: 'https://up.test/s1' } },
    {
      match: 'up.test/s1',
      method: 'PUT',
      handler: (req) => {
        // Lan dau chunk 1 loi 503; probe (content-range: bytes *\/N) tra ve da nhan chunk 1.
        if (req.headers['content-range'] === `bytes */${videoSize}`) {
          return { status: 308, text: '', headers: { range: 'bytes=0-262143' } };
        }
        putCount += 1;
        if (putCount === 1) return { status: 503, text: 'backend error' };
        return { status: 200, json: { id: 'VID9' } };
      },
    },
    { match: 'youtube/v3/videos?', method: 'GET', json: { items: [{ status: { uploadStatus: 'processed' }, processingDetails: { processingStatus: 'succeeded' } }] } },
  ]);

  const yt = new YouTubePlatform(
    { clientId: 'c', clientSecret: 's', refreshToken: 'r', chunkSizeBytes: 262_144, uploadRetries: 3 },
    ctxWith(mock),
  );
  const post = await normalizePost({
    title: 't',
    media: { buffer: fakeMp4(videoSize), filename: 'v.mp4' },
    overrides: { youtube: { probeMedia: false } },
  });
  const res = await yt.publish(post);
  assert.equal(res.id, 'VID9');
  const probe = mock.requests.find((r) => r.headers['content-range'] === `bytes */${videoSize}`);
  assert.ok(probe, 'phai co request probe offset');
  assert.equal(probe.headers['content-length'], '0');
});

test('youtube: video xu ly that bai -> ProcessingError', async () => {
  const mock = createMockFetch([
    { match: 'oauth2.googleapis.com/token', json: { access_token: 'AT', expires_in: 3600 } },
    { match: 'upload/youtube/v3/videos', method: 'POST', text: '', headers: { location: 'https://up.test/s' } },
    { match: 'up.test/s', method: 'PUT', json: { id: 'V1' } },
    {
      match: 'youtube/v3/videos?',
      method: 'GET',
      json: { items: [{ status: { uploadStatus: 'rejected', rejectionReason: 'copyright' } }] },
    },
  ]);
  const yt = new YouTubePlatform({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 't',
    media: { buffer: fakeMp4(1000), filename: 'v.mp4' },
    overrides: { youtube: { probeMedia: false } },
  });
  await assert.rejects(() => yt.publish(post), /copyright/);
});

test('youtube: refresh token het han -> AuthError khong retry', async () => {
  const mock = createMockFetch([
    {
      match: 'oauth2.googleapis.com/token',
      status: 400,
      json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    },
  ]);
  const yt = new YouTubePlatform({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 't',
    media: { buffer: fakeMp4(1000), filename: 'v.mp4' },
    overrides: { youtube: { probeMedia: false } },
  });
  await assert.rejects(() => yt.publish(post), (err) => {
    assert.match(err.message, /invalid_grant/);
    assert.equal(err.retryable, false);
    assert.match(err.hint, /Testing/);
    return true;
  });
});

test('youtube: quota het -> QuotaError khong retry', async () => {
  const mock = createMockFetch([
    { match: 'oauth2.googleapis.com/token', json: { access_token: 'AT', expires_in: 3600 } },
    {
      match: 'upload/youtube/v3/videos',
      status: 403,
      json: { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } },
    },
  ]);
  const yt = new YouTubePlatform({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 't',
    media: { buffer: fakeMp4(1000), filename: 'v.mp4' },
    overrides: { youtube: { probeMedia: false } },
  });
  await assert.rejects(() => yt.publish(post), (err) => {
    assert.equal(err.code, 'E_QUOTA');
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(mock.countRequests('upload/youtube/v3/videos'), 1, 'khong retry buoc init (ton quota)');
});

test('youtube: anh -> bao loi ro rang (API khong dang anh)', async () => {
  const mock = createMockFetch([]);
  const yt = new YouTubePlatform({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({ title: 't', media: { buffer: fakeJpeg(), filename: 'a.jpg' } });
  await assert.rejects(() => yt.publish(post), /does not support images|can only post VIDEO/);
});

test('youtube helpers: title/description/tags theo dung gioi han', () => {
  assert.equal(buildTitle({ title: 'a<b>c', description: '' }).length, 3);
  assert.equal(buildTitle({ title: 'x'.repeat(200), description: '' }).length, 100);

  const desc = buildDescription({ description: 'd', hashtags: ['a', 'b'], link: 'https://x.io' });
  assert.ok(desc.includes('#a #b'));
  assert.ok(desc.includes('https://x.io'));

  // Tong tags <= 500 ky tu, tinh ca dau phay va dau ngoac kep quanh tag co khoang trang.
  const many = Array.from({ length: 100 }, (_, i) => `tag${i}`);
  const tags = buildTags(many);
  const cost = tags.reduce((sum, t, i) => sum + t.length + (/\s/.test(t) ? 2 : 0) + (i > 0 ? 1 : 0), 0);
  assert.ok(cost <= 500, `cost=${cost}`);

  assert.equal(truncateBytes('aaaa', 2), 'aa');
  assert.ok(Buffer.byteLength(truncateBytes('é'.repeat(10), 5)) <= 5);
  assert.equal(normalizeChunkSize(300_000), 262_144);
  assert.equal(normalizeChunkSize(8 * 1024 * 1024), 8 * 1024 * 1024);
  assert.equal(parseRangeEnd('bytes=0-999'), 999);
  assert.equal(parseRangeEnd(null), null);
});

// =========================================================== FACEBOOK

test('facebook: album nhieu anh -> upload published=false roi /feed voi attached_media', async () => {
  const mock = createMockFetch([
    {
      match: '/photos',
      method: 'POST',
      handler: (_r, hit) => ({ json: { id: `PH${hit}` } }),
    },
    { match: '/feed', method: 'POST', json: { id: '123_456' } },
  ]);
  const fb = new FacebookPlatform({ pageId: '123', pageAccessToken: 'PAT' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'Album',
    description: 'mo ta',
    hashtags: ['wallpaper'],
    media: [
      { url: 'https://cdn.test/1.jpg', mime: 'image/jpeg' },
      { url: 'https://cdn.test/2.jpg', mime: 'image/jpeg' },
    ],
  });

  const res = await fb.publish(post);
  assert.equal(res.id, '123_456');
  assert.equal(res.url, 'https://www.facebook.com/123/posts/456');

  const photos = mock.requests.filter((r) => r.url.includes('/photos'));
  assert.equal(photos.length, 2);
  assert.equal(photos[0].body.published, 'false');
  assert.equal(photos[0].body.temporary, 'true');

  const feed = mock.findRequest('/feed');
  assert.equal(feed.body.attached_media, '[{"media_fbid":"PH1"},{"media_fbid":"PH2"}]');
  assert.ok(feed.body.message.includes('#wallpaper'));
});

test('facebook: 1 anh -> /photos voi field caption (khong dung message da deprecated)', async () => {
  const mock = createMockFetch([
    { match: '/photos', json: { id: 'PH', post_id: '1_2' } },
  ]);
  const fb = new FacebookPlatform({ pageId: '1', pageAccessToken: 'PAT' }, ctxWith(mock));
  const post = await normalizePost({ title: 'T', media: { url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' } });
  await fb.publish(post);
  const req = mock.findRequest('/photos');
  assert.ok(req.body.caption, 'phai dung field caption');
  assert.equal(req.body.message, undefined, 'khong duoc dung field message');
  assert.equal(req.body.url, 'https://cdn.test/a.jpg');
});

test('facebook: anh PNG > 1MB bi tu choi som voi goi y', async () => {
  const mock = createMockFetch([]);
  const fb = new FacebookPlatform({ pageId: '1', pageAccessToken: 'PAT' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'T',
    media: { buffer: fakePng(1_200_000), filename: 'a.png' },
  });
  await assert.rejects(() => fb.publish(post), /PNG image may be at most 1MB/);
});

test('facebook: Reels 3 pha - offset/file_size la HEADER, Authorization dung OAuth', async () => {
  const mock = createMockFetch([
    {
      match: '/video_reels',
      method: 'POST',
      handler: (req) => (req.body?.upload_phase === 'start'
        ? { json: { video_id: 'V1', upload_url: 'https://rupload.facebook.com/video-upload/v26.0/V1' } }
        : { json: { success: true, post_id: '1_9' } }),
    },
    { match: 'rupload.facebook.com', method: 'POST', json: { success: true } },
    {
      match: /graph\.facebook\.com\/v26\.0\/V1\?/,
      method: 'GET',
      handler: () => ({
        json: {
          status: {
            video_status: 'ready',
            uploading_phase: { status: 'complete' },
            processing_phase: { status: 'complete' },
          },
          post_id: '1_9',
        },
      }),
    },
  ]);
  const fb = new FacebookPlatform({ pageId: '1', pageAccessToken: 'PAT' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'Reel',
    description: 'mo ta',
    media: { buffer: fakeMp4(5000), filename: 'r.mp4', width: 1080, height: 1920, duration: 20 },
    overrides: { facebook: { asReel: true, probeMedia: false } },
  });

  const res = await fb.publish(post);
  assert.equal(res.meta.kind, 'reel');
  assert.equal(res.id, '1_9');

  const rup = mock.findRequest('rupload.facebook.com');
  assert.equal(rup.headers.authorization, 'OAuth PAT', 'rupload phai dung scheme OAuth');
  assert.equal(rup.headers.offset, '0');
  assert.equal(rup.headers.file_size, '5000');
  assert.ok(rup.body.__binary, 'body phai la binary tho');

  const finish = mock.requests.filter((r) => r.url.includes('/video_reels'))[1];
  assert.equal(finish.body.upload_phase, 'finish');
  assert.equal(finish.body.video_state, 'PUBLISHED');
  assert.equal(finish.body.video_id, 'V1');
});

test('facebook: video doc 3-90s tu dong thanh Reel', async () => {
  const mock = createMockFetch([
    {
      match: '/video_reels',
      handler: (req) => (req.body?.upload_phase === 'start'
        ? { json: { video_id: 'V2', upload_url: 'https://rupload.facebook.com/x/V2' } }
        : { json: { success: true, post_id: '1_2' } }),
    },
    { match: 'rupload.facebook.com', json: { success: true } },
    { match: /v26\.0\/V2\?/, json: { status: { video_status: 'ready', uploading_phase: { status: 'completed' }, processing_phase: { status: 'completed' } } } },
  ]);
  const fb = new FacebookPlatform({ pageId: '1', pageAccessToken: 'PAT' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'x',
    media: { buffer: fakeMp4(1000), filename: 'v.mp4', width: 1080, height: 1920, duration: 30 },
    overrides: { facebook: { probeMedia: false } },
  });
  const res = await fb.publish(post);
  assert.equal(res.meta.kind, 'reel');
});

test('facebook: video ngang -> /videos thuong, cho video_status=ready', async () => {
  const mock = createMockFetch([
    { match: '/videos', method: 'POST', json: { id: 'V3' } },
    {
      match: /v26\.0\/V3\?/,
      method: 'GET',
      handler: (_r, hit) => ({
        json: hit === 1
          ? { status: { video_status: 'processing', processing_phase: { status: 'in_progress' } } }
          : { status: { video_status: 'ready' }, post_id: '1_77' },
      }),
    },
  ]);
  const fb = new FacebookPlatform({ pageId: '1', pageAccessToken: 'PAT' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'Video',
    description: 'mo ta',
    media: { url: 'https://cdn.test/a.mp4', mime: 'video/mp4', width: 1920, height: 1080, duration: 120 },
    overrides: { facebook: { probeMedia: false } },
  });
  const res = await fb.publish(post);
  assert.equal(res.meta.kind, 'video');
  assert.equal(res.meta.videoId, 'V3');
  const req = mock.findRequest('/videos');
  assert.equal(req.body.file_url, 'https://cdn.test/a.mp4');
  assert.equal(req.body.title, 'Video');
  assert.ok(mock.countRequests(/v26\.0\/V3\?/) >= 2, 'phai poll den khi ready');
});

test('facebook: token 190 -> AuthError voi goi y theo subcode', async () => {
  const mock = createMockFetch([
    {
      match: '/feed',
      status: 400,
      json: { error: { message: 'Error validating access token', code: 190, error_subcode: 460, type: 'OAuthException', fbtrace_id: 'X' } },
    },
  ]);
  const fb = new FacebookPlatform({ pageId: '1', pageAccessToken: 'PAT' }, ctxWith(mock));
  const post = await normalizePost({ title: 'chi chu', description: 'x' });
  await assert.rejects(() => fb.publish(post), (err) => {
    assert.equal(err.code, 'E_AUTH');
    assert.match(err.hint, /changed their password/);
    return true;
  });
});

test('facebook: loi trong body voi HTTP 200 van duoc phat hien', async () => {
  const mock = createMockFetch([
    { match: '/feed', status: 200, json: { error: { message: 'oops', code: 100 } } },
  ]);
  const fb = new FacebookPlatform({ pageId: '1', pageAccessToken: 'PAT' }, ctxWith(mock));
  const post = await normalizePost({ title: 'x', description: 'y' });
  await assert.rejects(() => fb.publish(post), /invalid parameter/);
});

test('facebook: hen gio phai cach it nhat 10 phut', async () => {
  const mock = createMockFetch([{ match: '/feed', json: { id: '1_2' } }]);
  const fb = new FacebookPlatform({ pageId: '1', pageAccessToken: 'PAT' }, ctxWith(mock));
  const soon = await normalizePost({ title: 'x', description: 'y', scheduleAt: new Date(Date.now() + 60_000) });
  await assert.rejects(() => fb.publish(soon), /at least 10 minutes/);

  const ok = await normalizePost({ title: 'x', description: 'y', scheduleAt: new Date(Date.now() + 3600_000) });
  await fb.publish(ok);
  const req = mock.findRequest('/feed');
  assert.equal(req.body.published, 'false');
  assert.ok(Number(req.body.scheduled_publish_time) > 0);
});

test('facebook: album hen gio phai co unpublished_content_type', async () => {
  const mock = createMockFetch([
    { match: '/photos', handler: (_r, hit) => ({ json: { id: `P${hit}` } }) },
    { match: '/feed', json: { id: '1_2' } },
  ]);
  const fb = new FacebookPlatform({ pageId: '1', pageAccessToken: 'PAT' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'x',
    media: [
      { url: 'https://cdn.test/1.jpg', mime: 'image/jpeg' },
      { url: 'https://cdn.test/2.jpg', mime: 'image/jpeg' },
    ],
    scheduleAt: new Date(Date.now() + 3600_000),
  });
  await fb.publish(post);
  assert.equal(mock.findRequest('/feed').body.unpublished_content_type, 'SCHEDULED');
});

test('facebook: appSecret -> tu them appsecret_proof', async () => {
  const mock = createMockFetch([{ match: '/feed', json: { id: '1_2' } }]);
  const fb = new FacebookPlatform({ pageId: '1', pageAccessToken: 'PAT', appSecret: 'SECRET' }, ctxWith(mock));
  const post = await normalizePost({ title: 'x', description: 'y' });
  await fb.publish(post);
  assert.match(mock.findRequest('/feed').body.appsecret_proof, /^[0-9a-f]{64}$/);
});

// ========================================================== INSTAGRAM

test('instagram: anh -> tao container, poll FINISHED, media_publish', async () => {
  const mock = createMockFetch([
    { match: '/media', method: 'POST', match2: true, handler: (req) => (req.url.includes('media_publish')
      ? { json: { id: 'MEDIA1' } }
      : { json: { id: 'CONT1' } }) },
    { match: /\/CONT1\?/, method: 'GET', json: { status_code: 'FINISHED' } },
    { match: /\/MEDIA1\?/, method: 'GET', json: { permalink: 'https://instagram.com/p/abc', media_product_type: 'FEED' } },
  ]);
  const ig = new InstagramPlatform({ igUserId: 'IGID', accessToken: 'PAT' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'Anh dep',
    description: 'mo ta',
    hashtags: ['wallpaper'],
    media: { url: 'https://cdn.test/a.jpg', mime: 'image/jpeg', width: 1080, height: 1350 },
  });

  const res = await ig.publish(post);
  assert.equal(res.id, 'MEDIA1');
  assert.equal(res.url, 'https://instagram.com/p/abc');

  const create = mock.requests.find((r) => r.url.includes('/media') && !r.url.includes('media_publish') && r.method === 'POST');
  assert.equal(create.body.image_url, 'https://cdn.test/a.jpg');
  assert.ok(create.body.caption.includes('#wallpaper'));

  const publish = mock.findRequest('media_publish');
  assert.equal(publish.body.creation_id, 'CONT1');
});

test('instagram: anh PNG bi tu choi (chi nhan JPEG)', async () => {
  const ig = new InstagramPlatform({ igUserId: 'X', accessToken: 'T' }, ctxWith(createMockFetch([])));
  const post = await normalizePost({ title: 'x', media: { buffer: fakePng(1000), filename: 'a.png' } });
  await assert.rejects(() => ig.publish(post), /only JPEG images/);
});

test('instagram: anh doc 9:16 bi tu choi voi huong dan crop', async () => {
  const ig = new InstagramPlatform(
    { igUserId: 'X', accessToken: 'T' },
    ctxWith(createMockFetch([]), { mediaHost: publicHost }),
  );
  const post = await normalizePost({
    title: 'x',
    media: { buffer: fakeJpeg(1000), filename: 'a.jpg', width: 1080, height: 1920 },
  });
  await assert.rejects(() => ig.publish(post), (err) => {
    assert.match(err.message, /ty le tu 4:5/);
    assert.match(err.hint, /1080x1350/);
    return true;
  });
});

test('instagram: anh local khong co mediaHost -> loi cau hinh ro rang', async () => {
  const ig = new InstagramPlatform({ igUserId: 'X', accessToken: 'T' }, ctxWith(createMockFetch([])));
  const post = await normalizePost({
    title: 'x',
    media: { buffer: fakeJpeg(1000), filename: 'a.jpg', width: 1080, height: 1080 },
  });
  await assert.rejects(() => ig.publish(post), /mediaHost/);
});

test('instagram: video local -> resumable upload voi Authorization OAuth', async () => {
  const mock = createMockFetch([
    {
      match: '/media',
      method: 'POST',
      handler: (req) => (req.url.includes('media_publish')
        ? { json: { id: 'M2' } }
        : { json: { id: 'C2', uri: 'https://rupload.facebook.com/ig-api-upload/v26.0/C2' } }),
    },
    { match: 'rupload.facebook.com', method: 'POST', json: { success: true, message: 'Upload successful.' } },
    { match: /\/C2\?/, method: 'GET', json: { status_code: 'FINISHED' } },
    { match: /\/M2\?/, method: 'GET', json: { permalink: 'https://instagram.com/reel/x' } },
  ]);
  const ig = new InstagramPlatform({ igUserId: 'IG', accessToken: 'TOK' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'Reel',
    media: { buffer: fakeMp4(9000), filename: 'v.mp4', duration: 20, width: 1080, height: 1920 },
    overrides: { instagram: { probeMedia: false } },
  });

  const res = await ig.publish(post);
  assert.equal(res.id, 'M2');
  const create = mock.requests.find((r) => r.method === 'POST' && r.url.includes('/media') && !r.url.includes('publish'));
  assert.equal(create.body.media_type, 'REELS');
  assert.equal(create.body.upload_type, 'resumable');
  assert.equal(create.body.video_url, undefined, 'resumable khong gui video_url');

  const rup = mock.findRequest('rupload.facebook.com');
  assert.equal(rup.headers.authorization, 'OAuth TOK');
  assert.equal(rup.headers.offset, '0');
  assert.equal(rup.headers.file_size, '9000');
});

test('instagram: container ERROR -> bao loi kem giai thich subcode', async () => {
  const mock = createMockFetch([
    { match: '/media', method: 'POST', json: { id: 'C3' } },
    { match: /\/C3\?/, method: 'GET', json: { status_code: 'ERROR', status: '2207052' } },
  ]);
  const ig = new InstagramPlatform({ igUserId: 'IG', accessToken: 'T' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'x',
    media: { url: 'https://cdn.test/a.jpg', mime: 'image/jpeg', width: 1080, height: 1080 },
  });
  await assert.rejects(() => ig.publish(post), (err) => {
    assert.match(err.message, /2207052/);
    assert.match(err.hint, /must be public/);
    return true;
  });
});

test('instagram: carousel 3 anh -> children noi bang dau phay', async () => {
  const mock = createMockFetch([
    {
      match: '/media',
      method: 'POST',
      handler: (req, hit) => {
        if (req.url.includes('media_publish')) return { json: { id: 'MC' } };
        if (req.body.media_type === 'CAROUSEL') return { json: { id: 'PARENT' } };
        return { json: { id: `CH${hit}` } };
      },
    },
    { match: /\/(CH\d|PARENT)\?/, method: 'GET', json: { status_code: 'FINISHED' } },
    { match: /\/MC\?/, method: 'GET', json: { permalink: 'https://instagram.com/p/c' } },
  ]);
  const ig = new InstagramPlatform({ igUserId: 'IG', accessToken: 'T' }, ctxWith(mock));
  const media = [1, 2, 3].map((i) => ({ url: `https://cdn.test/${i}.jpg`, mime: 'image/jpeg', width: 1080, height: 1080 }));
  const post = await normalizePost({ title: 'Bo anh', media, hashtags: ['a'] });

  const res = await ig.publish(post);
  assert.equal(res.meta.kind, 'carousel');
  const parent = mock.requests.find((r) => r.body?.media_type === 'CAROUSEL');
  assert.equal(parent.body.children.split(',').length, 3);
  assert.ok(parent.body.caption.includes('#a'));

  const children = mock.requests.filter((r) => r.body?.is_carousel_item === 'true');
  assert.equal(children.length, 3);
});

test('instagram: bai text-only bi tu choi', async () => {
  const ig = new InstagramPlatform({ igUserId: 'X', accessToken: 'T' }, ctxWith(createMockFetch([])));
  const post = await normalizePost({ title: 'chi chu', description: 'x' });
  await assert.rejects(() => ig.publish(post), /cannot post text only|does not support/);
});

test('instagram: user_tags bo x/y voi video, giu x/y voi anh', () => {
  assert.deepEqual(normalizeUserTags([{ username: '@a', x: 0.2, y: 0.3 }], 'video'), [{ username: 'a' }]);
  assert.deepEqual(normalizeUserTags([{ username: 'a', x: 2, y: -1 }], 'image'), [{ username: 'a', x: 1, y: 0 }]);
});

// ============================================================= TIKTOK

test('tiktok: chunk plan - chunk cuoi PHAI to hon chunk_size (floor)', () => {
  const tk = new TikTokPlatform({ clientKey: 'k', clientSecret: 's', refreshToken: 'r' }, ctxWith(createMockFetch([])));

  // Vi du trong docs: 50,000,123 bytes / 10,000,000
  const plan = tk.buildChunkPlan(50_000_123, 10_000_000);
  assert.equal(plan.chunk_size, 10_000_000);
  assert.equal(plan.total_chunk_count, 5, 'floor(50000123/10000000) = 5');
  const finalChunk = plan.video_size - (plan.total_chunk_count - 1) * plan.chunk_size;
  assert.equal(finalChunk, 10_000_123, 'chunk cuoi phai gom phan du');

  // File < 5MB -> 1 chunk nguyen file
  const small = tk.buildChunkPlan(1_000_000);
  assert.equal(small.total_chunk_count, 1);
  assert.equal(small.chunk_size, 1_000_000);

  // File <= 64MB -> co the 1 chunk
  const mid = tk.buildChunkPlan(30_000_000);
  assert.equal(mid.total_chunk_count, 1);
  assert.equal(mid.chunk_size, 30_000_000);

  // chunk_size bi ep vao khoang 5MB - 64MB
  const clamped = tk.buildChunkPlan(200 * 1024 * 1024, 1024);
  assert.ok(clamped.chunk_size >= 5 * 1024 * 1024);
  assert.ok(clamped.chunk_size <= 64 * 1024 * 1024);
});

test('tiktok: direct post video - creator_info truoc, chunk Content-Range dung', async () => {
  const size = 12 * 1024 * 1024;
  const chunk = 5 * 1024 * 1024;
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400, refresh_token: 'RT2' } },
    {
      match: '/creator_info/query/',
      json: {
        data: {
          creator_username: 'wallguy',
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
          max_video_post_duration_sec: 600,
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
        },
        error: { code: 'ok' },
      },
    },
    {
      match: '/video/init/',
      json: { data: { publish_id: 'v_pub_file~v2-1.1', upload_url: 'https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=t' }, error: { code: 'ok' } },
    },
    {
      match: 'open-upload.tiktokapis.com',
      method: 'PUT',
      handler: (req) => {
        const cr = req.headers['content-range'];
        const isLast = cr.startsWith(`bytes ${2 * chunk}-`);
        return { status: isLast ? 201 : 206, text: '' };
      },
    },
    {
      match: '/status/fetch/',
      // Tra ve TEXT tho: id 64-bit se mat do chinh xac neu di qua literal so cua JS.
      text: '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7248342634382371112]},"error":{"code":"ok"}}',
    },
  ]);

  const tk = new TikTokPlatform(
    { clientKey: 'k', clientSecret: 's', refreshToken: 'r', chunkSizeBytes: chunk },
    ctxWith(mock),
  );
  const post = await normalizePost({
    title: 'Hinh nen dep',
    hashtags: ['wallpaper', 'fyp'],
    media: { buffer: fakeMp4(size), filename: 'v.mp4', duration: 30 },
    overrides: { tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE', probeMedia: false } },
  });

  const res = await tk.publish(post);
  assert.equal(res.ok, true);
  assert.equal(res.meta.privacyLevel, 'PUBLIC_TO_EVERYONE');
  assert.equal(res.id, '7248342634382371112', 'post id phai giu nguyen do chinh xac 64-bit');
  assert.equal(res.url, 'https://www.tiktok.com/@wallguy/video/7248342634382371112');

  assert.equal(mock.countRequests('/creator_info/query/'), 1, 'phai goi creator_info truoc');

  const init = mock.findRequest('/video/init/');
  assert.equal(init.body.source_info.source, 'FILE_UPLOAD');
  assert.equal(init.body.source_info.video_size, size);
  assert.equal(init.body.source_info.total_chunk_count, 2, 'floor(12MB/5MB) = 2');
  assert.ok(init.body.post_info.title.includes('#wallpaper'));
  assert.equal(init.body.post_info.privacy_level, 'PUBLIC_TO_EVERYONE');

  const puts = mock.requests.filter((r) => r.url.includes('open-upload'));
  assert.equal(puts.length, 2);
  assert.equal(puts[0].headers['content-range'], `bytes 0-${chunk - 1}/${size}`);
  assert.equal(puts[1].headers['content-range'], `bytes ${chunk}-${size - 1}/${size}`, 'chunk cuoi gom het phan con lai');
  assert.equal(puts[1].bodyBytes, size - chunk);
  assert.equal(puts[0].headers.authorization, undefined, 'upload_url da pre-signed, khong gui Authorization');
});

test('tiktok: privacy_level khong kha dung -> tu dong ha ve SELF_ONLY', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    {
      match: '/creator_info/query/',
      json: { data: { privacy_level_options: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'], max_video_post_duration_sec: 600 }, error: { code: 'ok' } },
    },
    { match: '/video/init/', json: { data: { publish_id: 'p1' }, error: { code: 'ok' } } },
    { match: '/status/fetch/', json: { data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } } },
  ]);
  const tk = new TikTokPlatform({ clientKey: 'k', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'x',
    media: { url: 'https://verified.test/v.mp4', mime: 'video/mp4', duration: 10 },
    overrides: { tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE', probeMedia: false } },
  });
  const res = await tk.publish(post);
  assert.equal(res.meta.privacyLevel, 'SELF_ONLY');
  assert.equal(mock.findRequest('/video/init/').body.source_info.source, 'PULL_FROM_URL');
});

test('tiktok: video dai hon gioi han creator -> tu choi truoc khi upload', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    {
      match: '/creator_info/query/',
      json: { data: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 60 }, error: { code: 'ok' } },
    },
  ]);
  const tk = new TikTokPlatform({ clientKey: 'k', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'x',
    media: { buffer: fakeMp4(1000), filename: 'v.mp4', duration: 300 },
    overrides: { tiktok: { probeMedia: false } },
  });
  await assert.rejects(() => tk.publish(post), /only post videos up to/);
  assert.equal(mock.countRequests('/video/init/'), 0, 'khong duoc goi init');
});

test('tiktok: app chua audit -> loi co huong dan xu ly', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    { match: '/creator_info/query/', json: { data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'] }, error: { code: 'ok' } } },
    {
      match: '/video/init/',
      status: 403,
      json: { data: {}, error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'x', log_id: 'L' } },
    },
  ]);
  const tk = new TikTokPlatform({ clientKey: 'k', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'x',
    media: { url: 'https://verified.test/v.mp4', mime: 'video/mp4' },
    overrides: { tiktok: { probeMedia: false } },
  });
  await assert.rejects(() => tk.publish(post), (err) => {
    assert.match(err.hint, /SELF_ONLY/);
    assert.equal(err.retryable, false);
    return true;
  });
});

test('tiktok: status FAILED -> ProcessingError kem goi y theo fail_reason', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    { match: '/creator_info/query/', json: { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } } },
    { match: '/video/init/', json: { data: { publish_id: 'p1' }, error: { code: 'ok' } } },
    { match: '/status/fetch/', json: { data: { status: 'FAILED', fail_reason: 'file_format_check_failed' }, error: { code: 'ok' } } },
  ]);
  const tk = new TikTokPlatform({ clientKey: 'k', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'x',
    media: { url: 'https://verified.test/v.mp4', mime: 'video/mp4' },
    overrides: { tiktok: { probeMedia: false } },
  });
  await assert.rejects(() => tk.publish(post), (err) => {
    assert.match(err.message, /file_format_check_failed/);
    assert.match(err.hint, /MP4/);
    return true;
  });
});

test('tiktok: anh -> content/init voi post_mode & media_type o top-level', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    { match: '/creator_info/query/', json: { data: { privacy_level_options: ['SELF_ONLY'], comment_disabled: false }, error: { code: 'ok' } } },
    { match: '/content/init/', json: { data: { publish_id: 'p_pub_url~v2.1' }, error: { code: 'ok' } } },
    { match: '/status/fetch/', json: { data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } } },
  ]);
  const tk = new TikTokPlatform({ clientKey: 'k', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'Bo anh',
    description: 'mo ta dai',
    hashtags: ['wallpaper'],
    media: [
      { url: 'https://verified.test/1.jpg', mime: 'image/jpeg' },
      { url: 'https://verified.test/2.jpg', mime: 'image/jpeg' },
    ],
  });
  const res = await tk.publish(post);
  assert.equal(res.meta.kind, 'photo');

  const init = mock.findRequest('/content/init/');
  assert.equal(init.body.post_mode, 'DIRECT_POST');
  assert.equal(init.body.media_type, 'PHOTO');
  assert.equal(init.body.source_info.source, 'PULL_FROM_URL');
  assert.equal(init.body.source_info.photo_images.length, 2);
  assert.equal(init.body.source_info.photo_cover_index, 0, 'photo_cover_index la field bat buoc');
  assert.equal(init.body.post_info.brand_content_toggle, false, 'brand toggles la Required -> luon gui');
  assert.equal(init.body.post_info.brand_organic_toggle, false);
  assert.ok(init.body.post_info.description.includes('#wallpaper'));
});

test('tiktok: che do draft (MEDIA_UPLOAD) khong gui post_info', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    { match: '/inbox/video/init/', json: { data: { publish_id: 'v_inbox_file~v2.1' }, error: { code: 'ok' } } },
    { match: '/status/fetch/', json: { data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } } },
  ]);
  const tk = new TikTokPlatform(
    { clientKey: 'k', clientSecret: 's', refreshToken: 'r', postMode: 'MEDIA_UPLOAD' },
    ctxWith(mock),
  );
  const post = await normalizePost({
    title: 'x',
    media: { url: 'https://verified.test/v.mp4', mime: 'video/mp4' },
    overrides: { tiktok: { probeMedia: false } },
  });
  const res = await tk.publish(post);
  assert.equal(res.status, 'draft');
  assert.equal(mock.countRequests('/creator_info/query/'), 0, 'draft khong can creator_info');
  const init = mock.findRequest('/inbox/video/init/');
  assert.equal(init.body.post_info, undefined, 'endpoint inbox khong nhan post_info');
});

test('tiktok: anh local khong co mediaHost -> loi cau hinh', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
  ]);
  const tk = new TikTokPlatform({ clientKey: 'k', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({ title: 'x', media: { buffer: fakeJpeg(1000), filename: 'a.jpg' } });
  await assert.rejects(() => tk.publish(post), /mediaHost|URL cong khai/);
});

test('tiktok: chunk PUT 416 -> loi ve byte math, khong retry', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    { match: '/creator_info/query/', json: { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } } },
    { match: '/video/init/', json: { data: { publish_id: 'p', upload_url: 'https://open-upload.tiktokapis.com/video/?x=1' }, error: { code: 'ok' } } },
    { match: 'open-upload', method: 'PUT', status: 416, text: 'range' },
  ]);
  const tk = new TikTokPlatform({ clientKey: 'k', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'x',
    media: { buffer: fakeMp4(1000), filename: 'v.mp4' },
    overrides: { tiktok: { probeMedia: false } },
  });
  await assert.rejects(() => tk.publish(post), (err) => {
    assert.match(err.message, /416/);
    assert.match(err.hint, /floor/);
    return true;
  });
});

test('tiktok helpers: clipRunes va extractBigIntList', () => {
  assert.equal(clipRunes('abcdef', 3), 'abc');
  // Khong lam vo surrogate pair
  const emoji = '😀😀😀';
  assert.equal(clipRunes(emoji, 3).length, 2);
  assert.deepEqual(
    extractBigIntList('{"publicaly_available_post_id":[7248342634382371112]}', 'publicaly_available_post_id'),
    ['7248342634382371112'],
  );
  assert.deepEqual(extractBigIntList('{}', 'x'), []);
});

test('tiktok: anh co tai tro + SELF_ONLY -> tu choi truoc khi goi API', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    { match: '/creator_info/query/', json: { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } } },
    { match: '/content/init/', json: { data: { publish_id: 'p1' }, error: { code: 'ok' } } },
  ]);
  const tk = new TikTokPlatform({ clientKey: 'k', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'Bo anh',
    media: [{ url: 'https://verified.test/1.jpg', mime: 'image/jpeg' }],
    overrides: { tiktok: { brandContentToggle: true, privacyLevel: 'SELF_ONLY' } },
  });

  await assert.rejects(() => tk.publish(post), /SELF_ONLY/);
  assert.equal(mock.countRequests('/content/init/'), 0, 'khong duoc goi API khi da biet se bi tu choi');
});

test('tiktok: anh co khai bao thuong mai -> gui dung 2 brand toggle', async () => {
  const mock = createMockFetch([
    { match: '/oauth/token/', json: { access_token: 'AT', expires_in: 86400 } },
    {
      match: '/creator_info/query/',
      json: { data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }, error: { code: 'ok' } },
    },
    { match: '/content/init/', json: { data: { publish_id: 'p_pub_url~v2.1' }, error: { code: 'ok' } } },
    { match: '/status/fetch/', json: { data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } } },
  ]);
  const tk = new TikTokPlatform({ clientKey: 'k', clientSecret: 's', refreshToken: 'r' }, ctxWith(mock));
  const post = await normalizePost({
    title: 'Bo anh',
    media: [{ url: 'https://verified.test/1.jpg', mime: 'image/jpeg' }],
    overrides: {
      tiktok: { brandContentToggle: true, brandOrganicToggle: true, privacyLevel: 'PUBLIC_TO_EVERYONE' },
    },
  });

  await tk.publish(post);
  const init = mock.findRequest('/content/init/');
  assert.equal(init.body.post_info.brand_content_toggle, true);
  assert.equal(init.body.post_info.brand_organic_toggle, true);
  assert.equal(init.body.post_info.privacy_level, 'PUBLIC_TO_EVERYONE');
});
