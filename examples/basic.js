/**
 * Vi du 1 — dang bai co ban tu code.
 *
 * Chay:  node examples/basic.js
 *
 * Vi du nay dung `dryRun: true` nen KHONG goi API that — an toan de thu.
 * Bo `dryRun` di (hoac dat false) khi ban da cau hinh token thuc.
 */

import { SocialPoster } from '../src/index.js';

const poster = new SocialPoster({
  dryRun: true,                // <- doi thanh false de dang that
  logger: { level: 'info' },
  concurrency: 3,

  platforms: {
    // Telegram: don gian nhat, chi can bot token + chat id.
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '123456:FAKE_TOKEN_FOR_DRY_RUN',
      chatId: process.env.TELEGRAM_CHAT_ID ?? '@my_wallpaper_channel',
      parseMode: 'HTML',
    },

    // Facebook Page.
    facebook: {
      pageId: process.env.FACEBOOK_PAGE_ID ?? '1234567890',
      pageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? 'FAKE',
    },

    // YouTube: chi dang duoc VIDEO.
    youtube: {
      clientId: process.env.YOUTUBE_CLIENT_ID ?? 'FAKE',
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET ?? 'FAKE',
      refreshToken: process.env.YOUTUBE_REFRESH_TOKEN ?? 'FAKE',
      privacyStatus: 'private',
    },
  },
});

const report = await poster.post({
  title: 'Bộ hình nền 4K tháng 9 — Anime Art',
  description: 'Tuyển chọn 20 hình nền 4K chủ đề anime. Tải miễn phí tại website của chúng tôi.',
  hashtags: ['wallpaper', '4k', 'anime', 'hinhnen'],
  link: 'https://example.com/wallpapers/september',

  // media: 1 hoac nhieu; nhan duong dan file, URL, hoac Buffer.
  media: [
    // './assets/preview-1.jpg',
    // 'https://cdn.example.com/preview-2.jpg',
  ],

  // Ghi de rieng cho tung nen tang.
  overrides: {
    youtube: { privacyStatus: 'unlisted', categoryId: '22' },
    telegram: { longCaptionMode: 'split', disableNotification: true },
    facebook: { noStory: false },
  },
});

console.log('\n================ KET QUA ================');
console.log('Tong the OK:', report.ok);
for (const r of report.results) {
  const mark = r.skipped ? '○ bỏ qua' : r.ok ? '✓ thành công' : '✕ lỗi';
  console.log(`${mark}  ${r.platform}${r.url ? `  ${r.url}` : ''}`);
  if (r.reason) console.log(`         lý do: ${r.reason}`);
  if (r.error && !r.skipped) {
    console.log(`         lỗi: ${r.error.message}`);
    if (r.error.hint) console.log(`         → ${r.error.hint}`);
  }
}

await poster.close();
