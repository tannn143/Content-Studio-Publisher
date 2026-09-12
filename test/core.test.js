import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
} from '../src/core/text.js';
import { toMedia, sniffMime, kindFromMime, Media, formatBytes } from '../src/core/media.js';
import { normalizePost } from '../src/core/post.js';
import { computeBackoff, retry, pollUntil } from '../src/core/retry.js';
import { createLimiter, mapSettledLimit } from '../src/core/limit.js';
import { redact, maskSecretString } from '../src/core/logger.js';
import { RateLimitError, ValidationError, toSocialPostError, NetworkError } from '../src/core/errors.js';
import { MemoryTokenStore, AccessTokenManager } from '../src/core/tokenstore.js';
import { appendQuery, encodeForm, parseRetryAfter, stripSecrets } from '../src/core/http.js';
import { fakeJpeg, fakeMp4, fakePng } from './helpers.js';

// ------------------------------------------------------------------- hashtag

test('normalizeHashtags: bo dau #, bo trung, tach theo dau phay', () => {
  assert.deepEqual(
    normalizeHashtags(['#Wallpaper', '4k, hd', '#Wallpaper', '  ']),
    ['Wallpaper', '4k', 'hd'],
  );
});

test('normalizeHashtags: gop cum tu thanh mot tag, tach chuoi nhieu #', () => {
  assert.deepEqual(normalizeHashtags(['anime art']), ['animeart']);
  assert.deepEqual(normalizeHashtags(['#a #b']), ['a', 'b']);
});

test('normalizeHashtags: giu ky tu tieng Viet, bo dau cach', () => {
  assert.deepEqual(normalizeHashtags(['Hình nền 4K']), ['Hìnhnền4K']);
});

test('normalizeHashtags: gioi han so luong va do dai', () => {
  assert.deepEqual(normalizeHashtags(['a', 'b', 'c'], { max: 2 }), ['a', 'b']);
  assert.deepEqual(normalizeHashtags(['abcdef'], { maxLength: 3 }), ['abc']);
  assert.deepEqual(normalizeHashtags(['ABC'], { lowercase: true }), ['abc']);
});

test('normalizeHashtags: input rong / null', () => {
  assert.deepEqual(normalizeHashtags(null), []);
  assert.deepEqual(normalizeHashtags(undefined), []);
  assert.deepEqual(normalizeHashtags(''), []);
  assert.deepEqual(normalizeHashtags([]), []);
});

test('formatHashtags / extractHashtags / stripHashtags', () => {
  assert.equal(formatHashtags(['a', '#b']), '#a #b');
  assert.deepEqual(extractHashtags('hello #world va #4k'), ['world', '4k']);
  assert.equal(stripHashtags('hello #world'), 'hello');
});

// ------------------------------------------------------------------- caption

test('buildCaption: ghep title + description + hashtag', () => {
  const r = buildCaption({
    title: 'Tieu de',
    description: 'Noi dung',
    hashtags: ['a', 'b'],
  });
  assert.equal(r.text, 'Tieu de\n\nNoi dung\n\n#a #b');
  assert.equal(r.truncated, false);
  assert.equal(r.droppedHashtags, 0);
});

test('buildCaption: cat bot hashtag truoc khi cat noi dung', () => {
  const r = buildCaption(
    { title: 'T', description: 'D', hashtags: ['aaa', 'bbb', 'ccc'] },
    { maxLength: 12 },
  );
  assert.ok(graphemeLength(r.text) <= 12, `do dai ${graphemeLength(r.text)}`);
  assert.ok(r.droppedHashtags > 0);
});

test('buildCaption: ton trong maxHashtags', () => {
  const r = buildCaption({ description: 'x', hashtags: ['a', 'b', 'c'] }, { maxHashtags: 1 });
  assert.equal(r.text, 'x\n\n#a');
  assert.equal(r.droppedHashtags, 2);
});

test('buildCaption: template tuy chinh', () => {
  const r = buildCaption(
    { title: 'T', description: 'D', hashtags: ['a'] },
    { template: ({ title, description, hashtags }) => `${title} | ${description} | ${hashtags}` },
  );
  assert.equal(r.text, 'T | D | #a');
});

test('buildCaption: bo title/hashtag/link khi duoc yeu cau', () => {
  const r = buildCaption(
    { title: 'T', description: 'D', hashtags: ['a'], link: 'https://x.com' },
    { includeTitle: false, includeHashtags: false, includeLink: false },
  );
  assert.equal(r.text, 'D');
});

test('buildCaption: bai rong', () => {
  assert.equal(buildCaption({}).text, '');
});

// ------------------------------------------------------------------ truncate

test('truncate: khong lam vo emoji', () => {
  const s = 'ab👨‍👩‍👧‍👦cd';
  const out = truncate(s, 3, { ellipsis: '' });
  assert.ok(!out.includes('�'));
  assert.equal(graphemeLength(out), 3);
});

test('truncate: them ellipsis va khong vuot gioi han', () => {
  const out = truncate('abcdefghij', 5);
  assert.ok(graphemeLength(out) <= 5, out);
  assert.ok(out.endsWith('...'));
});

test('truncate: gioi han khong hop le', () => {
  assert.equal(truncate('abc', 0), '');
  assert.equal(truncate('', 10), '');
});

// -------------------------------------------------------------------- escape

test('escapeHtml: escape & truoc < >', () => {
  assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('escapeMarkdownV2: escape du 18 ky tu bat buoc', () => {
  const specials = '_*[]()~`>#+-=|{}.!';
  const out = escapeMarkdownV2(specials);
  for (const ch of specials) {
    assert.ok(out.includes(`\\${ch}`), `thieu escape cho ${ch}`);
  }
});

test('sanitizeText / slugify', () => {
  assert.equal(sanitizeText('  a \r\n b  '), 'a \n b');
  assert.equal(slugify('Hình nền 4K — Anime!'), 'hinh-nen-4k-anime');
  assert.equal(slugify(''), 'post');
});

// --------------------------------------------------------------------- media

test('sniffMime: nhan dang dinh dang qua magic bytes', () => {
  assert.equal(sniffMime(fakeJpeg()), 'image/jpeg');
  assert.equal(sniffMime(fakePng()), 'image/png');
  assert.equal(sniffMime(fakeMp4()), 'video/mp4');
  assert.equal(sniffMime(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffMime(Buffer.from([1, 2, 3, 4, 5])), undefined);
});

test('kindFromMime', () => {
  assert.equal(kindFromMime('image/jpeg'), 'image');
  assert.equal(kindFromMime('video/mp4'), 'video');
  assert.equal(kindFromMime('application/pdf'), 'unknown');
});

test('toMedia: nhan dien URL vs duong dan', () => {
  assert.equal(toMedia('https://x.com/a.jpg').source, 'url');
  assert.equal(toMedia('./a.jpg').source, 'file');
  assert.equal(toMedia({ buffer: fakeJpeg() }).source, 'buffer');
  assert.equal(toMedia({ url: 'https://x.com/a.mp4', type: 'video' }).kind, 'video');
});

test('toMedia: input sai thi nem MediaError', () => {
  assert.throws(() => toMedia(42), /Invalid media/);
  assert.throws(() => toMedia(''), /media is empty/);
});

test('Media.load + readRange tu buffer', async () => {
  const media = toMedia({ buffer: fakeJpeg(100), filename: 'a.jpg' });
  await media.load();
  assert.equal(media.mime, 'image/jpeg');
  assert.equal(media.kind, 'image');
  assert.equal(media.size, 100);
  const chunk = await media.readRange(0, 3);
  assert.equal(chunk.byteLength, 4);
  assert.equal(chunk[0], 0xff);
});

test('Media.toBuffer ton trong maxBytes', async () => {
  const media = toMedia({ buffer: fakeJpeg(100) });
  await media.load();
  await assert.rejects(() => media.toBuffer({ maxBytes: 50 }), /over the .* limit/);
});

test('Media: aspectRatio va isVertical', () => {
  const m = new Media({ source: 'buffer', buffer: fakeMp4(), width: 1080, height: 1920, mime: 'video/mp4' });
  assert.equal(m.isVertical, true);
  assert.ok(Math.abs(m.aspectRatio - 0.5625) < 1e-6);
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(1536), '1.5KB');
});

// ---------------------------------------------------------------------- post

test('normalizePost: chuan hoa day du', async () => {
  const post = await normalizePost({
    title: '  Tieu de  ',
    description: 'Mo ta',
    hashtags: '#a, b',
    media: [{ buffer: fakeJpeg(), filename: 'x.jpg' }],
    link: 'https://example.com',
  });
  assert.equal(post.title, 'Tieu de');
  assert.deepEqual(post.hashtags, ['a', 'b']);
  assert.equal(post.media.length, 1);
  assert.equal(post.isImagePost, true);
  assert.equal(post.isTextOnly, false);
});

test('normalizePost: tu choi bai rong', async () => {
  await assert.rejects(() => normalizePost({}), ValidationError);
});

test('normalizePost: tu choi link sai', async () => {
  await assert.rejects(() => normalizePost({ title: 'x', link: 'ftp://a' }), /link must start with/);
});

test('normalizePost: tu choi scheduleAt sai', async () => {
  await assert.rejects(() => normalizePost({ title: 'x', scheduleAt: 'khong-phai-ngay' }), /scheduleAt/);
});

test('normalizePost: phan biet video va anh', async () => {
  const post = await normalizePost({
    title: 'x',
    media: [{ buffer: fakeMp4(), filename: 'v.mp4' }, { buffer: fakeJpeg(), filename: 'i.jpg' }],
  });
  assert.equal(post.videos.length, 1);
  assert.equal(post.images.length, 1);
  assert.equal(post.isVideoPost, true);
  assert.equal(post.primaryMedia.kind, 'video');
});

test('normalizePost: overrides theo nen tang', async () => {
  const post = await normalizePost({
    title: 'x',
    overrides: { youtube: { privacyStatus: 'public' } },
  });
  assert.deepEqual(post.optionsFor('youtube'), { privacyStatus: 'public' });
  assert.deepEqual(post.optionsFor('tiktok'), {});
});

// --------------------------------------------------------------------- retry

test('computeBackoff: tang theo luy thua, ton trong max', () => {
  const o = { minDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 'none' };
  assert.equal(computeBackoff(1, o), 100);
  assert.equal(computeBackoff(2, o), 200);
  assert.equal(computeBackoff(5, o), 1000);
});

test('retry: thu lai loi retryable roi thanh cong', async () => {
  let calls = 0;
  const out = await retry(async () => {
    calls += 1;
    if (calls < 3) throw new RateLimitError('cho', { retryAfterMs: 1 });
    return 'ok';
  }, { retries: 5, minDelayMs: 1, maxDelayMs: 1, jitter: 'none', sleepFn: async () => {} });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('retry: khong thu lai loi khong retryable', async () => {
  let calls = 0;
  await assert.rejects(
    () => retry(async () => {
      calls += 1;
      throw new ValidationError('sai');
    }, { retries: 3, sleepFn: async () => {} }),
    ValidationError,
  );
  assert.equal(calls, 1);
});

test('retry: het luot thi nem loi kem so lan thu', async () => {
  let calls = 0;
  try {
    await retry(async () => {
      calls += 1;
      throw new RateLimitError('x');
    }, { retries: 2, sleepFn: async () => {} });
    assert.fail('phai nem loi');
  } catch (err) {
    assert.equal(calls, 3);
    assert.equal(err.attempts, 3);
  }
});

test('pollUntil: dung khi done, bao timeout khi qua han', async () => {
  let n = 0;
  const ok = await pollUntil(async () => {
    n += 1;
    return n >= 3 ? { done: true, value: n } : { done: false };
  }, { intervalMs: 1, timeoutMs: 1000, sleepFn: async () => {} });
  assert.equal(ok.value, 3);
  assert.equal(ok.timedOut, false);

  let t = 0;
  const to = await pollUntil(async () => ({ done: false }), {
    intervalMs: 10,
    timeoutMs: 25,
    sleepFn: async () => {},
    now: () => (t += 10),
  });
  assert.equal(to.timedOut, true);
});

test('pollUntil: tra ve failed khi check bao failed', async () => {
  const r = await pollUntil(async () => ({ done: false, failed: true, reason: 'xx' }), {
    sleepFn: async () => {},
  });
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'xx');
});

// --------------------------------------------------------------------- limit

test('createLimiter: khong vuot so luong song song', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 8 }, () => limit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  }));
  await Promise.all(tasks);
  assert.ok(peak <= 2, `peak=${peak}`);
});

test('mapSettledLimit: gom ca loi va ket qua', async () => {
  const res = await mapSettledLimit([
    async () => 1,
    async () => { throw new Error('no'); },
  ], 2);
  assert.equal(res[0].status, 'fulfilled');
  assert.equal(res[1].status, 'rejected');
});

// -------------------------------------------------------------------- logger

test('redact: che token trong object', () => {
  const out = redact({ accessToken: 'abcdefghijklmnop', nested: { client_secret: 'supersecretvalue' } });
  assert.ok(!JSON.stringify(out).includes('abcdefghijklmnop'));
  assert.ok(!JSON.stringify(out).includes('supersecretvalue'));
});

test('maskSecretString: che token telegram trong URL', () => {
  const out = maskSecretString('https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendPhoto');
  assert.ok(!out.includes('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'));
});

test('stripSecrets: che access_token trong URL', () => {
  assert.ok(!stripSecrets('https://x.com?access_token=SECRETVALUE&a=1').includes('SECRETVALUE'));
});

// -------------------------------------------------------------------- errors

test('toSocialPostError: loi mang duoc danh dau retryable', () => {
  const e = new TypeError('fetch failed');
  /** @type {any} */ (e).cause = { code: 'ECONNRESET' };
  const out = toSocialPostError(e);
  assert.ok(out instanceof NetworkError);
  assert.equal(out.retryable, true);
});

test('SocialPostError.toJSON khong lam vo khi details lon', () => {
  const e = new ValidationError('x', { details: { big: 'y'.repeat(10_000) } });
  const json = e.toJSON();
  assert.ok(JSON.stringify(json).length < 9000);
});

// ----------------------------------------------------------------- http util

test('appendQuery: bo undefined/null, ho tro mang', () => {
  const u = appendQuery('https://x.com/a', { a: 1, b: undefined, c: null, d: ['x', 'y'] });
  assert.ok(u.includes('a=1'));
  assert.ok(!u.includes('b='));
  assert.ok(u.includes('d=x&d=y'));
});

test('encodeForm: object -> JSON string', () => {
  const s = encodeForm({ a: { b: 1 }, c: true, d: undefined });
  const parsed = Object.fromEntries(new URLSearchParams(s));
  assert.equal(parsed.a, '{"b":1}');
  assert.equal(parsed.c, 'true');
  assert.equal(parsed.d, undefined);
});

test('parseRetryAfter: giay va HTTP-date', () => {
  assert.equal(parseRetryAfter('30'), 30_000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.ok(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 0);
});

// ---------------------------------------------------------------- tokenstore

test('AccessTokenManager: cache token, chi refresh 1 lan khi goi song song', async () => {
  let refreshes = 0;
  const mgr = new AccessTokenManager({
    key: 'k',
    store: new MemoryTokenStore(),
    refresh: async () => {
      refreshes += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { accessToken: `tok${refreshes}`, expiresInSec: 3600 };
    },
  });
  const [a, b] = await Promise.all([mgr.getAccessToken(), mgr.getAccessToken()]);
  assert.equal(a, 'tok1');
  assert.equal(b, 'tok1');
  assert.equal(refreshes, 1);
  assert.equal(await mgr.getAccessToken(), 'tok1');
});

test('AccessTokenManager: refresh lai khi token het han', async () => {
  let n = 0;
  const mgr = new AccessTokenManager({
    key: 'k',
    store: new MemoryTokenStore(),
    skewSec: 0,
    refresh: async () => ({ accessToken: `t${++n}`, expiresInSec: -1 }),
  });
  assert.equal(await mgr.getAccessToken(), 't1');
  assert.equal(await mgr.getAccessToken(), 't2');
});

test('AccessTokenManager: luu refresh token moi (TikTok xoay token)', async () => {
  const store = new MemoryTokenStore();
  const mgr = new AccessTokenManager({
    key: 'tiktok:x',
    store,
    refresh: async () => ({ accessToken: 'a', expiresInSec: 3600, refreshToken: 'NEW_REFRESH' }),
  });
  await mgr.getAccessToken();
  assert.equal(await mgr.getStoredRefreshToken(), 'NEW_REFRESH');
});
