/**
 * Vi du 2 — cac tinh huong nang cao.
 *
 * Chay:  node examples/advanced.js
 *
 * Bao gom:
 *  1. Doc cau hinh tu .env
 *  2. Dung mediaHost (S3) cho Instagram/TikTok anh
 *  3. Luu token vao file de tu refresh
 *  4. Hook theo doi tien trinh
 *  5. Caption rieng theo template
 *  6. Huy giua duong bang AbortSignal
 *  7. Xu ly loi theo tung loai
 *  8. Tu viet adapter cho nen tang khac
 */

import {
  SocialPoster,
  BasePlatform,
  FileTokenStore,
  S3MediaHost,
  FunctionMediaHost,
  configFromEnv,
  RateLimitError,
  AuthError,
  UnsupportedError,
  QuotaError,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// 1 + 2 + 3: cau hinh tu .env, S3 media host, token store
// ---------------------------------------------------------------------------

const envConfig = configFromEnv({ requireAtLeastOne: false });

// Neu .env chua co gi thi dung cau hinh gia de vi du van chay duoc (dryRun).
if (Object.keys(envConfig.platforms).length === 0) {
  console.log('(.env trong - dung cau hinh gia de chay thu)\n');
  envConfig.platforms = {
    telegram: { botToken: '1:DEMO', chatId: '@demo_channel' },
    instagram: { igUserId: 'DEMO', accessToken: 'DEMO' },
    tiktok: { clientKey: 'DEMO', clientSecret: 'DEMO', refreshToken: 'DEMO' },
  };
}

const mediaHost = process.env.WAM_S3_BUCKET
  ? new S3MediaHost({
    bucket: process.env.WAM_S3_BUCKET,
    accessKeyId: process.env.WAM_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.WAM_S3_SECRET_ACCESS_KEY,
    region: process.env.WAM_S3_REGION ?? 'auto',
    endpoint: process.env.WAM_S3_ENDPOINT,
    publicBaseUrl: process.env.WAM_S3_PUBLIC_BASE_URL,
    deleteAfterPost: true,  // xoa file tam sau khi dang xong
  })
  // Hoac tu viet ham upload cua rieng ban:
  : new FunctionMediaHost(async (media) => {
    // const buf = await media.toBuffer();
    // const url = await myCdn.upload(buf, media.filename);
    // return { url, cleanup: async () => myCdn.delete(url) };
    throw new Error('Chua cau hinh mediaHost — Instagram/TikTok anh se khong dang duoc');
  });

// ---------------------------------------------------------------------------
// 8: adapter tu viet (vi du: webhook noi bo / Discord / Zalo...)
// ---------------------------------------------------------------------------

class WebhookPlatform extends BasePlatform {
  static id = 'webhook';

  static displayName = 'Webhook noi bo';

  static capabilities = {
    text: true,
    image: true,
    video: true,
    album: true,
    requiresPublicUrl: false,
    maxMediaCount: 50,
    supportsSchedule: false,
    limits: { title: Infinity, caption: Infinity, hashtags: Infinity },
  };

  validateConfig() {
    this.requireConfig(['url']);
    return true;
  }

  async doPublish(post, options) {
    const caption = this.buildCaption(post, options);
    const res = await this.http.request(this.config.url, {
      method: 'POST',
      json: {
        text: caption.text,
        media: post.media.map((m) => m.publicUrl ?? m.filename),
        hashtags: post.hashtags,
      },
      platform: this.id,
      signal: this.signal,
    });
    return {
      platform: this.id,
      ok: true,
      id: res.data?.id,
      status: 'published',
      raw: res.data,
    };
  }
}

// ---------------------------------------------------------------------------
// 4 + 5: hooks + caption template
// ---------------------------------------------------------------------------

const poster = new SocialPoster({
  ...envConfig,
  dryRun: true,
  mediaHost,
  store: new FileTokenStore('./data/tokens.json'),
  concurrency: 2,
  timeoutMsPerPlatform: 20 * 60_000,
  retry: { retries: 4, minDelayMs: 2000, maxDelayMs: 60_000 },

  hooks: {
    onStart: ({ platforms }) => console.log(`[hook] bat dau dang len: ${platforms.join(', ')}`),
    onPlatformStart: ({ platform }) => console.log(`[hook] ${platform}: dang gui...`),
    onPlatformSuccess: ({ platform, result }) => console.log(`[hook] ${platform}: xong (${result.url ?? result.id})`),
    onPlatformError: ({ platform, error }) => console.log(`[hook] ${platform}: LOI ${error.code} — ${error.message}`),
    onFinish: (report) => console.log(`[hook] ket thuc sau ${report.durationMs}ms`),
  },
});

// Dang ky adapter tu viet.
if (process.env.MY_WEBHOOK_URL) {
  poster.use(WebhookPlatform, { url: process.env.MY_WEBHOOK_URL });
}

// ---------------------------------------------------------------------------
// 6: huy giua duong
// ---------------------------------------------------------------------------

const controller = new AbortController();
// Vi du: tu huy sau 15 phut
const cancelTimer = setTimeout(() => controller.abort(new Error('qua 15 phut')), 15 * 60_000);
cancelTimer.unref?.();

// ---------------------------------------------------------------------------
// Dang bai
// ---------------------------------------------------------------------------

try {
  const report = await poster.post(
    {
      title: 'Hình nền 4K — Vũ trụ',
      description: 'Bộ sưu tập 30 hình nền thiên hà, độ phân giải 3840x2160.',
      hashtags: ['wallpaper', '4k', 'space', 'galaxy'],
      media: [],

      overrides: {
        // Caption rieng cho Telegram: dung template.
        telegram: {
          captionTemplate: ({ title, description, hashtags }) =>
            `🖼 <b>${title}</b>\n\n${description}\n\n${hashtags}\n\n👉 Tải tại: example.com`,
        },
        // Instagram: chi lay 10 hashtag dau, bo link (IG khong click duoc link trong caption).
        instagram: { maxHashtags: 10, includeLink: false },
        // TikTok: dang che do rieng tu vi app chua audit.
        tiktok: { privacyLevel: 'SELF_ONLY', disableComment: false },
        // YouTube: len lich thay vi dang ngay.
        youtube: { privacyStatus: 'private', notifySubscribers: false },
      },
    },
    { signal: controller.signal },
  );

  // -------------------------------------------------------------------------
  // 7: xu ly loi theo loai
  // -------------------------------------------------------------------------
  for (const r of report.results) {
    if (r.ok || r.skipped) continue;
    const err = r.errorObject;

    if (err instanceof QuotaError) {
      console.log(`${r.platform}: het quota hom nay — dua vao queue ngay mai`);
    } else if (err instanceof RateLimitError) {
      console.log(`${r.platform}: bi gioi han, thu lai sau ${Math.round((err.retryAfterMs ?? 60_000) / 1000)}s`);
    } else if (err instanceof AuthError) {
      console.log(`${r.platform}: token chet — CAN xin quyen lai, khong retry`);
    } else if (err instanceof UnsupportedError) {
      console.log(`${r.platform}: noi dung khong phu hop — ${err.message}`);
    } else {
      console.log(`${r.platform}: loi khac — ${err?.message}`);
    }
  }

  console.log('\nTom tat:', {
    ok: report.ok,
    thanhCong: report.succeeded,
    thatBai: report.failed,
    boQua: report.skipped,
  });
} finally {
  clearTimeout(cancelTimer);
  await poster.close();
}
