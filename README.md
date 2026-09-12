# wallpaper-auto-marketing

Module Node.js **+ web admin** để tự động đăng bài lên **YouTube, Facebook, Instagram, TikTok, Telegram** từ một nội dung duy nhất.

Input đầu vào là 4 thông tin bạn yêu cầu: **title**, **description**, **media** (ảnh/video), **hashtag**. Module tự lo phần còn lại: dựng caption đúng giới hạn từng nền tảng, upload media theo đúng protocol của từng API (resumable/chunked), chờ xử lý xong, và trả về link bài đăng hoặc lý do lỗi kèm cách sửa.

Mô hình vận hành tham khảo [Buffer](https://buffer.com): kết nối kênh bằng **OAuth ngay trong web**, soạn một lần rồi **đăng nhiều kênh**, có **queue/lịch đăng** và **xem trước theo từng kênh**.

```
                    ┌──────────────────────────────┐
   Web admin ──────▶│  title · description         │
   hoặc code/CLI    │  media[] · hashtag[]         │
                    └──────────────┬───────────────┘
                                   │  SocialPoster (song song, cách lỗi)
        ┌──────────────┬───────────┼───────────┬──────────────┐
        ▼              ▼           ▼           ▼              ▼
    YouTube       Facebook    Instagram     TikTok       Telegram
   resumable      Page/Reels   container    chunked      Bot API
    upload         3 phase     + publish    upload       multipart
```

- **0 dependency runtime** — chỉ dùng `fetch`/`FormData`/`crypto` có sẵn của Node ≥ 20.11
- **166 test** chạy được ngay (`npm test`), mock toàn bộ HTTP nên không cần token thật — trong đó 33 test hồi quy cho các lỗi mà một đợt review đa tác nhân đã tìm ra và đã sửa
- Spec API được **kiểm chứng lại với tài liệu chính thức 2026** (Graph API v26.0, Bot API 10.3, TikTok Content Posting v2, YouTube Data v3)

---

## Mục lục

1. [Cài đặt](#1-cài-đặt)
2. [Chạy nhanh](#2-chạy-nhanh)
3. [Web admin](#3-web-admin)
4. [Dùng như module trong code](#4-dùng-như-module-trong-code)
5. [Kết nối từng nền tảng](#5-kết-nối-từng-nền-tảng)
6. [Bảng khả năng & giới hạn](#6-bảng-khả-năng--giới-hạn)
7. [Media công khai (bắt buộc cho ảnh IG/TikTok)](#7-media-công-khai-bắt-buộc-cho-ảnh-igtiktok)
8. [Hàng đợi & lịch đăng](#8-hàng-đợi--lịch-đăng)
9. [Xử lý lỗi](#9-xử-lý-lỗi)
10. [CLI](#10-cli)
11. [API reference](#11-api-reference)
12. [REST API của admin](#12-rest-api-của-admin)
13. [Kiến trúc & mở rộng](#13-kiến-trúc--mở-rộng)
14. [Bảo mật](#14-bảo-mật)
15. [Hỏi đáp & sự cố thường gặp](#15-hỏi-đáp--sự-cố-thường-gặp)

---

## 1. Cài đặt

```bash
# Yêu cầu: Node.js >= 20.11 (khuyến nghị 22/24)
node -v

git clone <repo> wallpaper-auto-marketing
cd wallpaper-auto-marketing
npm install          # không có dependency, chạy cho chắc
npm test             # 166 test, không cần token
```

Tuỳ chọn nhưng **nên có**: `ffprobe` (thuộc ffmpeg) để module đọc được thời lượng/kích thước video. Không có thì vẫn chạy, chỉ là mất phần cảnh báo sớm (ví dụ "video này dài 95s, TikTok/Reels sẽ từ chối").

```bash
# Windows:  winget install Gyan.FFmpeg
# macOS:    brew install ffmpeg
# Ubuntu:   sudo apt install ffmpeg
ffprobe -version
```

---

## 2. Chạy nhanh

### Cách A — Web admin (khuyến nghị)

```bash
npm run serve
# → Web admin: http://127.0.0.1:4000
```

Mở trình duyệt → tab **Cài đặt** nhập thông tin app OAuth → tab **Kênh** bấm *Kết nối* → tab **Soạn bài** viết nội dung, chọn kênh, bấm **Đăng ngay** hoặc **Thêm vào hàng đợi**.

### Cách B — Từ code

```js
import { SocialPoster } from 'wallpaper-auto-marketing';

const poster = new SocialPoster({
  platforms: {
    telegram: { botToken: '123456:ABC...', chatId: '@my_channel' },
    facebook: { pageId: '1234567890', pageAccessToken: 'EAA...' },
  },
});

const report = await poster.post({
  title: 'Bộ hình nền 4K tháng 9',
  description: 'Tuyển chọn 20 hình nền anime 4K.',
  media: ['./wallpapers/preview.jpg'],
  hashtags: ['wallpaper', '4k', 'anime'],
});

console.log(report.succeeded);  // ['telegram', 'facebook']
console.log(report.byChannel.telegram.url);
```

### Cách C — CLI

```bash
node bin/cli.js post \
  --title "Bộ hình nền 4K tháng 9" \
  --desc "Tuyển chọn 20 hình nền anime 4K." \
  --media ./preview.jpg,./preview2.jpg \
  --tags wallpaper,4k,anime \
  --dry-run                      # bỏ cờ này để đăng thật
```

> **`--dry-run` / `dryRun: true`** chạy toàn bộ logic (dựng caption, kiểm tra media, tính chunk) nhưng **không gọi API** nền tảng nào. Luôn dùng nó lần đầu.

---

## 3. Web admin

```bash
npm run serve                                   # localhost, không cần token
WAM_ADMIN_TOKEN=secret npm run serve -- --host 0.0.0.0 --port 8080
node bin/cli.js serve --data ./data --public-url https://admin.example.com
```

| Tab | Chức năng |
|---|---|
| **Soạn bài** | Chọn kênh (chip có avatar) · title/description/hashtag/link · kéo-thả ảnh-video · **tuỳ biến riêng theo từng kênh** · đếm ký tự theo giới hạn từng nền tảng · **xem trước caption từng kênh** kèm cảnh báo media · Đăng ngay / Chạy thử / Lưu nháp / Thêm vào hàng đợi |
| **Hàng đợi** | Bài đã lên lịch nhóm theo ngày, đăng ngay / sửa / xoá, bật-tắt scheduler, chạy scheduler thủ công |
| **Kênh** | Kết nối OAuth (YouTube / Facebook+Instagram / TikTok), kết nối Telegram bằng bot token, kiểm tra token, bật-tắt, ngắt kết nối |
| **Lịch sử** | Kết quả từng kênh: link bài đăng, lý do lỗi + **gợi ý cách sửa**, nhân bản bài |
| **Cài đặt** | Thông tin app OAuth + **Redirect URI để copy**, khung giờ đăng, múi giờ, S3/tunnel cho media công khai, số kênh song song, số lần retry |

Panel **Hoạt động** ở cột phải nhận log trực tiếp qua SSE — thấy được từng bước: `→ đang gửi tới Kênh VI`, `✓ Kênh VI — https://t.me/...`.

**Phím tắt:** `Ctrl/Cmd + Enter` = Đăng ngay.

### Dữ liệu lưu ở đâu

```
data/
├── channels.json    # kênh đã kết nối (CÓ CHỨA TOKEN, chmod 600)
├── posts.json       # bài đăng: nháp, hàng đợi, lịch sử + kết quả
├── media.json       # metadata file đã upload
├── settings.json    # app OAuth, khung giờ, media host (CÓ SECRET, chmod 600)
├── tokens.json      # access token ngắn hạn đã cache
└── uploads/         # file ảnh/video thật
```

Toàn bộ nằm trên máy bạn. Không có backend nào khác.

---

## 4. Dùng như module trong code

### Input đầu vào

```js
await poster.post({
  // --- 4 thông tin chính ---
  title: 'Tiêu đề bài đăng',
  description: 'Nội dung/mô tả.',
  media: './anh.jpg',                      // xem các dạng bên dưới
  hashtags: ['wallpaper', '4k'],           // hoặc 'wallpaper, 4k' hoặc ['#wallpaper']

  // --- tuỳ chọn ---
  link: 'https://example.com',             // FB/Telegram gắn được link
  platforms: ['telegram', 'youtube'],      // chỉ đăng lên các kênh này
  scheduleAt: '2026-09-20T19:00:00+07:00', // hẹn giờ (FB/YouTube hỗ trợ native)
  idempotencyKey: 'post-2026-09-12-a',
  overrides: {                             // ghi đè theo từng nền tảng
    youtube: { privacyStatus: 'public', categoryId: '22' },
    telegram: { longCaptionMode: 'split' },
  },
});
```

**`media` nhận mọi dạng sau:**

```js
media: './anh.jpg'                                        // đường dẫn
media: 'https://cdn.example.com/anh.jpg'                  // URL công khai
media: ['./a.jpg', './b.jpg', './c.jpg']                  // album
media: { path: './video.mp4', thumbnail: './thumb.jpg' }  // video + ảnh bìa
media: { url: 'https://...', type: 'video' }
media: { buffer: myBuffer, filename: 'a.png', mime: 'image/png' }
media: { path: './a.jpg', caption: 'Ảnh 1', altText: 'Mô tả cho screen reader' }
```

Module **tự nhận dạng định dạng bằng magic bytes**, không tin phần mở rộng file — đổi tên `.png` thành `.jpg` vẫn bị phát hiện đúng và báo lỗi sớm thay vì để Instagram từ chối.

### Kết quả trả về

```js
{
  ok: true,                      // true khi KHÔNG kênh nào thất bại
  dryRun: false,
  startedAt: '2026-09-12T10:00:00.000Z',
  finishedAt: '2026-09-12T10:01:23.000Z',
  durationMs: 83000,

  succeeded: ['telegram', 'facebook'],
  failed: ['instagram'],
  skipped: ['youtube'],          // nền tảng không hỗ trợ loại bài này

  byChannel: { telegram: {...}, facebook: {...} },
  byPlatform: { telegram: {...} },   // alias khi key = tên nền tảng

  results: [{
    channel: 'telegram',         // key cấu hình (= channel id nếu dùng web admin)
    platform: 'telegram',
    platformType: 'telegram',
    ok: true,
    skipped: false,
    id: '1234',
    url: 'https://t.me/my_channel/1234',
    status: 'published',         // published | scheduled | draft | processing | dry-run
    durationMs: 1200,
    meta: { messages: [...], captionLength: 189 },
    error: undefined,            // { code, message, hint, retryable, httpStatus }
    errorObject: undefined,      // instance Error để `instanceof`
  }],

  post: { /* input đã chuẩn hoá */ },
}
```

Mặc định **không throw** — một kênh lỗi không làm chết cả lô. Muốn throw: `new SocialPoster({ throwOnError: true })` → nhận `AggregatePostError` có `.errors` theo từng kênh.

### Nhiều kênh cùng nền tảng (như Buffer)

```js
const poster = new SocialPoster({
  platforms: {
    'tg-vi': { platform: 'telegram', botToken: 'T', chatId: '@kenh_vi' },
    'tg-en': { platform: 'telegram', botToken: 'T', chatId: '@kenh_en' },
    'yt-main': { platform: 'youtube', clientId: '...', clientSecret: '...', refreshToken: '...' },
  },
});
// report.byChannel['tg-vi'], report.byChannel['tg-en'], ...
```

Khi key khác tên nền tảng thì thêm field `platform` để chỉ rõ adapter.

### Tuỳ chọn của SocialPoster

```js
new SocialPoster({
  platforms: {...},
  concurrency: 3,                  // số kênh đăng song song
  dryRun: false,
  throwOnError: false,
  timeoutMsPerPlatform: 900000,    // 15 phút cho mỗi kênh
  retry: { retries: 3, minDelayMs: 1500, maxDelayMs: 30000, jitter: 'full' },
  store: new FileTokenStore('./data/tokens.json'),   // cache access token
  mediaHost: new S3MediaHost({...}),                 // URL công khai cho IG/TikTok
  logger: { level: 'info', format: 'pretty' },       // hoặc truyền logger riêng
  hooks: {
    onStart, onPlatformStart, onPlatformSuccess, onPlatformError, onFinish,
  },
});
```

### Kiểm tra token trước khi đăng

```js
const status = await poster.verifyAll();
// { telegram: { ok: true, account: { username: 'wambot', chats: {...} } },
//   youtube:  { ok: false, error: 'refresh_token het han...', code: 'E_AUTH' } }
```

---

## 5. Kết nối từng nền tảng

> Trong web admin, tab **Cài đặt** hiển thị sẵn **Redirect URI** cần khai báo — copy đúng chuỗi đó vào app trên nền tảng, sai một ký tự là OAuth fail.

### YouTube (Google)

1. [Google Cloud Console](https://console.cloud.google.com) → tạo project → **APIs & Services** → bật **YouTube Data API v3**
2. **Credentials** → Create OAuth client ID → *Web application* → thêm Authorized redirect URI: `http://127.0.0.1:4000/oauth/google/callback`
3. Điền Client ID/Secret vào tab Cài đặt → tab Kênh → **Kết nối YouTube**

| ⚠️ Cần biết | Chi tiết |
|---|---|
| Consent screen ở chế độ **Testing** | Refresh token **hết hạn sau 7 ngày** → phải publish app sang *In production* (scope `youtube.upload` là sensitive nên cần Google verify) |
| Quota | **100 upload/ngày/project** (mô hình quota mới từ 2026, bucket riêng). Tính theo project, không theo channel |
| Chỉ đăng được VIDEO | API không có endpoint cho community post / ảnh / poll |
| Shorts | Không có field API. Quyết định bởi **media**: dọc hoặc vuông (width ≤ height) **và** ≤ 3 phút. `#Shorts` không còn là điều kiện |
| Thumbnail tuỳ chỉnh | Cần channel **đã xác minh**, ảnh ≤ 2MB |
| Service account | **Không dùng được** cho upload channel thường |

### Facebook Page + Instagram

1. [developers.facebook.com](https://developers.facebook.com) → tạo app (loại *Business*)
2. Thêm sản phẩm **Facebook Login** → Valid OAuth Redirect URIs: `http://127.0.0.1:4000/oauth/facebook/callback`
3. Điền App ID/Secret → **Kết nối Facebook Page + Instagram**

Một lần kết nối tạo ra **nhiều kênh**: mỗi Page một kênh Facebook, và mỗi Page có IG Business liên kết thì thêm một kênh Instagram.

| ⚠️ Cần biết | Chi tiết |
|---|---|
| Chuỗi token | Module tự đổi user token ngắn hạn → **user token dài hạn (60 ngày)** → Page token. Đây là bước quyết định để Page token **không hết hạn**. Gọi `/me/accounts` bằng token ngắn hạn sẽ cho Page token chết sau 1-2 giờ |
| Quyền cần | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` — đều **cần App Review** nếu dùng cho người ngoài app |
| Task trên Page | User phải có task **CREATE_CONTENT** |
| Quota Page | `4800 × số người tương tác trong 24h` → Page mới/ít tương tác bị giới hạn rất sớm |
| Reels | Tối đa **30 bài/Page/24h**, video 9:16, 3-90s |
| Ảnh PNG | Chỉ **1MB** (JPEG được 4MB) → nên convert sang JPEG |
| Instagram ảnh | **Bắt buộc JPEG + URL công khai**, tỉ lệ 4:5 → 1.91:1. Ảnh dọc 9:16 **không đăng được lên feed** (chỉ Reels/Stories) |
| Instagram video | Có thể upload file local qua resumable upload (không cần URL công khai) |
| Instagram hạn mức | 50 bài/24h (đọc `content_publishing_limit` để biết số thực tế) |

### TikTok

1. [developers.tiktok.com](https://developers.tiktok.com) → tạo app → bật sản phẩm **Content Posting API**
2. Redirect URI: **phải là https** — TikTok từ chối `http://127.0.0.1`. Dùng trang cầu nối
   [`docs/oauth-bridge/tiktok-callback.html`](docs/oauth-bridge/tiktok-callback.html) đặt trên GitHub Pages;
   xem [hướng dẫn](docs/setup-tiktok-telegram.md#2-redirect-uri-tiktok-bắt-buộc-https)
3. Điền Client Key/Secret **và Redirect URI đó** vào tab Cài đặt → **Kết nối TikTok**

| ⚠️ Cần biết | Chi tiết |
|---|---|
| App chưa audit | **Chỉ đăng được `SELF_ONLY`** (riêng tư) và tài khoản phải ở chế độ private. Muốn công khai phải qua audit của TikTok |
| Giải pháp thay thế | Dùng `postMode: 'MEDIA_UPLOAD'` → video vào **nháp trong app TikTok**, creator tự đăng công khai |
| Ảnh | **Chỉ nhận PULL_FROM_URL** từ **domain đã xác minh** trong app. Video thì dùng FILE_UPLOAD nên không cần xác minh domain |
| Refresh token | **Xoay mỗi lần refresh** → phải dùng `FileTokenStore` để lưu token mới, nếu không lần sau mất quyền |
| Giới hạn | ~15 bài/ngày/creator (**tính chung mọi ứng dụng**), 6 lần init/phút, 5 người dùng/24h khi chưa audit |
| Bắt buộc | Module luôn gọi `creator_info/query` trước để lấy `privacy_level_options` — bỏ bước này là 403 |

#### Form đăng TikTok trong web admin

Tab **Soạn bài** → *Tuỳ biến theo từng kênh* → chọn kênh TikTok. Form này được
dựng theo đúng yêu cầu UX bắt buộc của TikTok cho Direct Post — đây là phần bị
trượt audit nhiều nhất, nên đừng gỡ bớt:

| Yêu cầu của TikTok | Web admin làm gì |
|---|---|
| Cho biết đang đăng vào tài khoản nào | Hiện avatar + nickname lấy từ `creator_info`, kèm nút *làm mới* |
| `privacy_level` chỉ được lấy từ `privacy_level_options` | Dropdown dựng từ response, không hard-code |
| Không được chọn sẵn chế độ hiển thị | Mặc định là *— Chọn chế độ hiển thị —*; chưa chọn thì **không đăng được** |
| Tôn trọng cài đặt tài khoản | Ô Tắt bình luận / Duet / Stitch bị **khoá** nếu creator đã tắt sẵn |
| Khai báo nội dung thương mại | Công tắc *Khai báo nội dung thương mại* → *Thương hiệu của tôi* (`brand_organic_toggle`) và *Nội dung có tài trợ* (`brand_content_toggle`) |
| Nội dung có tài trợ không được riêng tư | Bật *Nội dung có tài trợ* → `SELF_ONLY` bị gỡ khỏi danh sách; backend cũng chặn lần nữa |
| Tuyên bố đồng ý | Hiện *"Khi bấm đăng, bạn đồng ý với Xác nhận sử dụng âm nhạc"* — thêm *Chính sách nội dung có thương hiệu* khi bật tài trợ |

Chế độ **Gửi vào nháp** (`MEDIA_UPLOAD`) không hiện các ô này: creator tự chọn
tất cả trong app TikTok. Đây là chế độ mặc định nếu app chưa có scope
`video.publish`.

Bộ test `tiktok UX: ...` trong [test/frontend.test.js](test/frontend.test.js)
khoá các yêu cầu trên lại để không ai vô tình gỡ mất.

> Đăng ký app trên TikTok Developer: xem [docs/tiktok-app-review.md](docs/tiktok-app-review.md)
> — có sẵn bản mô tả tiếng Anh, giải trình từng scope và kịch bản video demo.
>
> Form cần 4 URL công khai (website, Terms, Privacy, Redirect URI). Thư mục
> [docs/](docs/) đã có sẵn các trang tĩnh cho cả bốn — bật GitHub Pages với
> thư mục `/docs` là dùng được ngay.

### Telegram

Không cần OAuth:

1. Chat với [@BotFather](https://t.me/BotFather) → `/newbot` → lấy token
2. Thêm bot vào channel làm **Admin** có quyền **Post Messages**
3. Tab Kênh → form *Kết nối Telegram* → nhập token + `@tenchannel` (hoặc `-1001234567890` với channel private)

| ⚠️ Cần biết | Chi tiết |
|---|---|
| Caption | **1024 ký tự** (tin nhắn text: 4096). Vượt → `longCaptionMode: 'split'` để gửi phần dư thành tin nhắn riêng |
| Dung lượng | Upload trực tiếp: ảnh 10MB / file khác 50MB. Telegram tự tải từ URL: ảnh **5MB** / file khác 20MB |
| Album | 2-10 media/album. Module tự chia nhiều album nếu nhiều hơn, caption chỉ đặt ở item đầu tiên của album đầu |
| GIF trong album | Gửi dạng `document` (`InputMediaAnimation` không hợp lệ trong album) |
| parse_mode | Mặc định **HTML** — an toàn hơn MarkdownV2 rất nhiều (MarkdownV2 bắt escape 18 ký tự, caption sinh tự động gần như luôn có dấu `.` hoặc `-` → lỗi) |
| Chất lượng ảnh | `sendPhoto` nén lại ảnh. Kênh hình nền nên dùng `sendAsDocument: true` để giữ file gốc |
| Nhiều chat | `chatId: ['@kenh_vi', '@kenh_en']` gửi lần lượt |

---

## 6. Bảng khả năng & giới hạn

| | YouTube | Facebook | Instagram | TikTok | Telegram |
|---|---|---|---|---|---|
| Bài chỉ có chữ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Ảnh đơn | ❌ | ✅ | ✅ | ✅ | ✅ |
| Album | ❌ | ✅ (attached_media) | ✅ 2-10 | ✅ 1-35 | ✅ 2-10/album |
| Video | ✅ | ✅ | ✅ (Reels) | ✅ | ✅ |
| Reels/Shorts | tự động theo media | ✅ | ✅ | ✅ (mọi video) | — |
| Stories | ❌ | ❌ | ✅ (`target: 'story'`) | ❌ | — |
| Hẹn giờ native | ✅ | ✅ | ❌ | ❌ | ❌ |
| Caption tối đa | 5000 **byte** | không công bố | 2200 | 2200 | 1024 |
| Hashtag tối đa | 60 (trong mô tả) | — | **30** | — | — |
| Ảnh tối đa | — | 4MB (PNG 1MB) | **8MB, JPEG** | 20MB, JPEG/WebP | 10MB |
| Video tối đa | 256GB | 1GB / 1.75GB resumable | 300MB, 15 phút | 4GB | 50MB |
| Cần URL công khai | ❌ | ❌ | **ảnh: có** | **ảnh: có** | ❌ |

Nền tảng không hỗ trợ loại bài nào thì bị **skip** với lý do rõ ràng, không phải lỗi:

```
○ bỏ qua youtube — YouTube khong dang duoc bai chi co chu (can it nhat 1 anh/video)
```

Xem bảng runtime: `node bin/cli.js platforms`

---

## 7. Media công khai (bắt buộc cho ảnh IG/TikTok)

Instagram (ảnh) và TikTok (ảnh) **không cho upload file** — chỉ nhận URL công khai và tự tải về. Module giải quyết bằng `mediaHost`: tự đưa file lên, đăng, rồi **xoá file tạm**.

### S3 / Cloudflare R2 / MinIO (khuyến nghị)

```js
import { S3MediaHost } from 'wallpaper-auto-marketing';

new SocialPoster({
  mediaHost: new S3MediaHost({
    bucket: 'my-bucket',
    accessKeyId: '...',
    secretAccessKey: '...',
    region: 'auto',
    endpoint: 'https://<account>.r2.cloudflarestorage.com',  // bỏ trống nếu dùng AWS
    publicBaseUrl: 'https://cdn.example.com',                // domain công khai
    acl: '',                                                  // R2 không hỗ trợ ACL
    deleteAfterPost: true,
  }),
  platforms: {...},
});
```

Ký AWS SigV4 bằng `node:crypto`, **không cần `@aws-sdk`**.

> TikTok còn yêu cầu domain đó **đã xác minh** trong phần *URL properties* của app. S3 endpoint mặc định không xác minh được → dùng domain riêng.

### Tunnel về máy mình (dev)

```bash
cloudflared tunnel --url http://localhost:8787
```

```js
import { LocalTunnelMediaHost } from 'wallpaper-auto-marketing';
mediaHost: new LocalTunnelMediaHost({ publicBaseUrl: 'https://abc.trycloudflare.com', port: 8787 })
```

### Tự viết

```js
import { FunctionMediaHost } from 'wallpaper-auto-marketing';

mediaHost: new FunctionMediaHost(async (media) => {
  const buf = await media.toBuffer();
  const url = await myCdn.upload(buf, media.filename);
  return { url, cleanup: async () => myCdn.delete(url) };
})
```

Không cấu hình `mediaHost` mà đăng ảnh local lên IG/TikTok thì module báo lỗi **trước khi** gọi API, kèm hướng dẫn — không để bạn nhận lỗi `2207052` mơ hồ từ Meta.

---

## 8. Hàng đợi & lịch đăng

Instagram, TikTok, Telegram **không có hẹn giờ qua API**. Module tự giữ queue và đăng đúng giờ.

```bash
npm run serve        # scheduler chạy kèm, kiểm tra mỗi 30s
node bin/cli.js tick # chạy một lần rồi thoát (dùng cho cron)
```

```cron
*/5 * * * * cd /opt/wam && /usr/bin/node bin/cli.js tick >> /var/log/wam.log 2>&1
```

Cơ chế: lỗi **tạm thời** (mạng, 5xx, rate limit) → lùi lịch 5/10/15 phút và thử lại tối đa 3 lần. Lỗi **vĩnh viễn** (token chết, media sai định dạng) → đánh dấu `failed` ngay, không retry vô nghĩa.

Khung giờ đăng (`postingTimes` trong Cài đặt) dùng để **gợi ý** thời điểm — bấm một cái là điền vào, đúng kiểu Buffer. Các mốc đã có bài được tự động loại khỏi gợi ý.

---

## 9. Xử lý lỗi

Mọi lỗi đều là `SocialPostError` với `code` ổn định, `retryable`, và **`hint` nói rõ phải làm gì**.

| Class | `code` | Retry? | Ví dụ |
|---|---|---|---|
| `ValidationError` | `E_VALIDATION` | không | title rỗng, link sai định dạng |
| `ConfigError` | `E_CONFIG` | không | thiếu `pageAccessToken` |
| `AuthError` | `E_AUTH` | không | token hết hạn, thiếu scope, FB code 190 |
| `RateLimitError` | `E_RATE_LIMIT` | **có** | Telegram 429, FB code 368/80001 |
| `QuotaError` | `E_QUOTA` | không | hết 100 upload YouTube/ngày |
| `MediaError` | `E_MEDIA` | không | không đọc được file |
| `UnsupportedError` | `E_UNSUPPORTED` | không | ảnh 9:16 lên IG feed |
| `ProcessingError` | `E_PROCESSING` | tuỳ | YouTube reject copyright, TikTok `file_format_check_failed` |
| `NetworkError` | `E_NETWORK` | **có** | ECONNRESET |
| `TimeoutError` | `E_TIMEOUT` | **có** | quá `timeoutMsPerPlatform` |
| `PlatformError` | `E_PLATFORM` | tuỳ | lỗi API khác |

### Chống đăng trùng

Đăng trùng là rủi ro lớn nhất của bot đăng bài, nên module xử lý ở 4 lớp:

1. **Retry có phân biệt** — một POST bị **lỗi mạng/timeout** sẽ *không* được thử lại (không biết server đã nhận chưa). Chỉ khi server trả **429/5xx**, tức đã chắc chắn từ chối, mới thử lại. Request thật sự idempotent (chunk PUT có `Content-Range`) thì adapter tự truyền `retry`.
2. **`media_publish` của Instagram không bao giờ retry** — một lần publish thành công mà mất phản hồi sẽ thành hai bài.
3. **API chặn đăng lại** bài đã `posted` (409) — muốn đăng lại thì phải "Nhân bản".
4. **Đăng lại chỉ các kênh lỗi** — khi một phần thất bại, bảng kết quả có nút *"Thử lại N kênh lỗi"*, chỉ chọn đúng những kênh chưa thành công.

Nếu server bị tắt giữa lúc đăng, bài mắc ở trạng thái `publishing` được **tự đưa về `failed`** khi khởi động lại, kèm ghi chú nhắc kiểm tra trên nền tảng trước khi đăng lại.

```js
import { RateLimitError, AuthError, QuotaError } from 'wallpaper-auto-marketing';

for (const r of report.results) {
  if (r.ok || r.skipped) continue;
  const err = r.errorObject;

  if (err instanceof QuotaError)      queueForTomorrow(r.platform);
  else if (err instanceof RateLimitError) retryAfter(err.retryAfterMs ?? 60_000);
  else if (err instanceof AuthError)  alertHuman(`${r.platform}: cần xin quyền lại`);
  else                                deadLetter(r);
}
```

Ví dụ thông báo lỗi thực tế:

```
✕ instagram: [instagram] anh feed phai co ty le tu 4:5 (0.8) den 1.91:1 - anh nay 1080x1920 (0.563).
  → Anh doc 9:16 chi dang duoc len Reels/Stories. Voi feed hay crop ve 1080x1350 (4:5) hoac 1080x1080.

✕ youtube: [youtube] refresh_token het han hoac bi thu hoi (invalid_grant).
  → Ket noi lai YouTube o tab "Kenh" cua web admin. Neu OAuth consent screen dang o che do Testing
    thi token het han sau 7 ngay - hay dua app sang "In production".
```

Log **tự động che token** (`accessToken`, `botToken` trong URL, `client_secret`, header `Authorization`...) nên dán log đi hỏi cũng an toàn.

---

## 10. CLI

```bash
node bin/cli.js serve      [--port 4000] [--host 127.0.0.1] [--data ./data]
                           [--token XXX] [--public-url https://...] [--no-scheduler]
node bin/cli.js post       --title "..." [--desc "..."] [--media a.jpg,b.mp4]
                           [--tags a,b] [--channels ch_1,ch_2] [--at "2026-09-20T19:00"]
                           [--link https://...] [--dry-run]
node bin/cli.js verify     [--channel ch_1]
node bin/cli.js channels
node bin/cli.js platforms
node bin/cli.js tick
```

Hoặc qua npm: `npm run serve`, `npm run verify`, `npm run platforms`, `npm run tick`.

---

## 11. API reference

### Export chính

```js
import {
  SocialPoster, postToAll, createPosterFromEnv,       // đăng bài
  Post, normalizePost, Media, toMedia,                // model
  BasePlatform, YouTubePlatform, FacebookPlatform,
  InstagramPlatform, TikTokPlatform, TelegramPlatform,
  PLATFORM_REGISTRY, SUPPORTED_PLATFORMS, capabilitiesTable,
  S3MediaHost, LocalTunnelMediaHost, FunctionMediaHost,
  MemoryTokenStore, FileTokenStore, AccessTokenManager,
  buildCaption, normalizeHashtags, truncate, escapeHtml, escapeMarkdownV2,
  createLogger, retry, pollUntil, HttpClient,
  configFromEnv, platformsFromEnv, mediaHostFromEnv,
  /* + toàn bộ class lỗi */
} from 'wallpaper-auto-marketing';
```

Một lần gọi cho xong:

```js
import { postToAll } from 'wallpaper-auto-marketing';

await postToAll(
  { title: 'Hình nền mới', media: './a.jpg', hashtags: ['wallpaper'] },
  { platforms: { telegram: { botToken: 'T', chatId: '@ch' } } },
);
```

Đọc cấu hình từ `.env`:

```js
import { createPosterFromEnv } from 'wallpaper-auto-marketing';
const poster = createPosterFromEnv();
```

### Tiện ích dùng riêng được

```js
import { buildCaption, normalizeHashtags } from 'wallpaper-auto-marketing';

normalizeHashtags(['#Wallpaper', 'anime art', '4k, hd']);
// → ['Wallpaper', 'animeart', '4k', 'hd']
//   cụm từ → gộp thành 1 tag; dấu phẩy → tách; bỏ trùng theo lowercase

buildCaption(
  { title: 'T', description: 'D', hashtags: ['a', 'b', 'c'] },
  { maxLength: 1024, maxHashtags: 30 },
);
// → { text, truncated, droppedHashtags, length }
//   Ưu tiên giữ: title > description > hashtag. Thiếu chỗ thì bỏ hashtag trước.
//   Cắt theo grapheme nên không làm vỡ emoji hay dấu tiếng Việt.
```

---

## 12. REST API của admin

Dùng khi muốn tự động hoá từ hệ thống khác. Có token thì gửi `Authorization: Bearer <token>`.

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/api/state` | Toàn bộ trạng thái cho UI |
| `GET` | `/api/health` | Health check |
| `GET/PATCH/DELETE` | `/api/channels[/:id]` | Danh sách / bật-tắt / ngắt kết nối |
| `POST` | `/api/channels/verify` · `/api/channels/:id/verify` | Kiểm tra token |
| `GET` | `/api/channels/:id/creator-info` | Thiết lập đăng bài hiện tại của tài khoản TikTok (dùng để dựng form) |
| `POST` | `/api/channels/telegram` | `{botToken, chatId}` |
| `POST` | `/api/oauth/:provider/start` | Trả về `{url}` để redirect |
| `GET` | `/oauth/:provider/callback` | Callback OAuth |
| `GET/POST/DELETE` | `/api/media[/:id]` | Upload = body byte thô + header `x-filename` |
| `GET/POST/PATCH/DELETE` | `/api/posts[/:id]` | CRUD bài đăng |
| `POST` | `/api/posts/:id/publish` | `{dryRun?: true}` |
| `POST` | `/api/posts/:id/duplicate` | Nhân bản |
| `POST` | `/api/preview` | Xem trước caption + cảnh báo, không gọi API |
| `GET` | `/api/schedule/slots` | Gợi ý khung giờ |
| `POST` | `/api/scheduler/tick` · `/start` · `/stop` | Điều khiển scheduler |
| `GET/PUT` | `/api/settings` | Cài đặt (secret luôn bị che khi đọc) |
| `GET` | `/api/events` | SSE: log + tiến trình đăng bài |

Ví dụ:

```bash
# Upload ảnh
curl -X POST http://127.0.0.1:4000/api/media \
  -H "x-filename: wallpaper.jpg" -H "content-type: image/jpeg" \
  --data-binary @wallpaper.jpg

# Tạo bài + lên lịch
curl -X POST http://127.0.0.1:4000/api/posts -H "content-type: application/json" -d '{
  "title": "Hình nền 4K",
  "description": "Bộ sưu tập tháng 9",
  "hashtags": ["wallpaper","4k"],
  "mediaIds": ["m_..."],
  "channelIds": ["ch_..."],
  "scheduledAt": "2026-09-20T12:00:00.000Z"
}'
```

---

## 13. Kiến trúc & mở rộng

```
src/
├── index.js                  # public API
├── core/
│   ├── poster.js             # SocialPoster: điều phối, giới hạn song song, cách lỗi
│   ├── post.js               # chuẩn hoá + validate input
│   ├── media.js              # Media: magic bytes, readRange, ffprobe
│   ├── text.js               # hashtag, caption, cắt theo grapheme, escape
│   ├── http.js               # HttpClient: timeout, retry, map lỗi, chunk PUT
│   ├── retry.js              # backoff + jitter, pollUntil
│   ├── errors.js             # 13 class lỗi có code/retryable/hint
│   ├── logger.js             # log + tự che secret
│   ├── tokenstore.js         # cache access token, tự refresh
│   ├── config.js             # đọc .env
│   ├── publishservice.js     # PostRecord → lần đăng thật
│   ├── scheduler.js          # queue theo giờ, lùi lịch khi lỗi tạm thời
│   ├── mediahost/            # S3 (SigV4 tự ký) · tunnel · function
│   └── store/                # JSON store atomic + Workspace
├── platforms/
│   ├── base.js               # BasePlatform: caption, dry-run, poll, cleanup
│   ├── youtube.js  facebook.js  instagram.js  tiktok.js  telegram.js
│   └── index.js              # registry
├── auth/oauth.js             # OAuth 3 provider + connect Telegram
└── server/                   # admin server: router, SSE, REST
public/                       # web admin (vanilla JS, không build step)
```

### Thêm nền tảng mới

```js
import { BasePlatform } from 'wallpaper-auto-marketing';

class ZaloPlatform extends BasePlatform {
  static id = 'zalo';
  static displayName = 'Zalo OA';
  static capabilities = {
    text: true, image: true, video: false, album: true,
    requiresPublicUrl: false, maxMediaCount: 9, supportsSchedule: false,
    limits: { title: 100, caption: 2000, hashtags: 10 },
  };

  validateConfig() {
    this.requireConfig(['accessToken', 'oaId']);
    return true;
  }

  async doPublish(post, options) {
    const caption = this.buildCaption(post, options);   // đã đúng giới hạn
    const res = await this.http.request('https://openapi.zalo.me/...', {
      method: 'POST',
      json: { message: caption.text },
      platform: this.id,
      signal: this.signal,          // hỗ trợ huỷ
    });
    return { platform: this.id, ok: true, id: res.data.id, url: res.data.url, status: 'published' };
  }
}

poster.use(ZaloPlatform, { accessToken: '...', oaId: '...' });
```

Lớp cơ sở đã lo: dựng caption theo giới hạn, dry-run, xin URL công khai (`this.ensurePublicUrl`), poll trạng thái (`this.poll`), dọn file tạm, kiểm tra `supports(post)`, timeout và huỷ.

---

## 14. Bảo mật

- Web admin mặc định bind `127.0.0.1`. Mở ra ngoài mà không đặt `WAM_ADMIN_TOKEN` → server **tự sinh token** và in ra console.
- `channels.json`, `settings.json`, `tokens.json` ghi với mode `0600` (Linux/macOS).
- API **không bao giờ trả token về trình duyệt** — chỉ trả `hasAccessToken: true/false`.
- Secret trong Cài đặt hiện dưới dạng `••••••••`; gửi lại giá trị che **không** ghi đè giá trị thật.
- Log tự che token, kể cả bot token nhúng trong URL Telegram — **và log đẩy qua SSE / `GET /api/logs` cũng được che** (có test).
- **Chống CSRF**: request có `Origin` khác bị chặn 403. Quan trọng vì ở chế độ localhost không token, mọi website đều có thể gọi API qua cookie của bạn.
- Cookie phiên: `HttpOnly` + `SameSite=Strict`, tự thêm `Secure` khi chạy HTTPS.
- **Không nhận token qua query string** (tránh lọt vào access log và header Referer).
- Media do người dùng tải lên được trả về với `Content-Type` lấy từ **magic bytes** (không tin client), kèm `nosniff` + CSP `sandbox` → file tải lên không thể chạy script trên origin admin.
- Chống path traversal khi phục vụ file tĩnh; URL có percent-escape sai trả 400 thay vì 500 (có test).
- Header `Range` không hợp lệ (`bytes=-0`) không làm sập process — đây từng là lỗi DoS không cần xác thực.
- So sánh token bằng `timingSafeEqual`.
- OAuth `state` có TTL 10 phút, dùng một lần; TikTok dùng thêm PKCE S256.

Đưa ra production: đặt sau reverse proxy có HTTPS, đặt `--public-url https://...` (để redirect_uri đúng), đặt token mạnh, và khai báo redirect URI HTTPS trong app OAuth.

---

## 15. Hỏi đáp & sự cố thường gặp

**"Ảnh 4K của tôi không đăng được lên Instagram"**
IG feed chỉ nhận JPEG ≤ 8MB, rộng 320-1440px, tỉ lệ 4:5 → 1.91:1. Hình nền 3840×2160 (16:9 = 1.78) thì tỉ lệ hợp lệ nhưng phải resize width xuống ≤ 1440 và convert sang JPEG. Hình nền dọc 9:16 chỉ đăng được Reels/Stories.

**"Telegram báo `chat not found`"**
Channel public dùng `@tenchannel`; channel private phải dùng id dạng `-1001234567890`. Bot phải đã được thêm vào channel. Dùng nút *Kiểm tra* trong tab Kênh để biết chính xác.

**"TikTok đăng xong mà không thấy bài"**
App chưa audit → bài ở chế độ `SELF_ONLY` (chỉ mình bạn thấy). Kiểm tra trong app TikTok mục riêng tư, hoặc chuyển sang `postMode: 'MEDIA_UPLOAD'` để tự đăng công khai từ app.

**"YouTube báo hết quota mà tôi mới đăng 5 video"**
Quota tính **theo project Google Cloud**, không theo channel, và mặc định 100 upload/ngày. Nếu nhiều môi trường dùng chung project thì dùng chung hạn mức. Reset 0h giờ Pacific.

**"Facebook đăng được vài tiếng rồi hỏng"**
Page token được tạo từ user token **ngắn hạn**. Kết nối lại qua web admin — module tự làm bước đổi sang token dài hạn.

**"Video 2GB upload lên Facebook lỗi"**
Upload một lần chỉ tối đa 1GB/20 phút. Cấu hình thêm `appId` + `userAccessToken` rồi đặt `resumable: true` (giới hạn 1.75GB/45 phút).

**"Bài đăng trùng bị Facebook từ chối"**
Lỗi 506: Facebook chặn nội dung y hệt bài trước. Thêm timestamp/emoji/hashtag khác nhau giữa các bài.

**"Chạy được trên máy tôi, deploy lên server thì OAuth fail"**
`redirect_uri` phải **khớp từng ký tự** với cái khai báo trong app. Đặt `--public-url https://admin.example.com` và copy lại Redirect URI từ tab Cài đặt vào app.

**"Muốn dùng module mà không cần web admin?"**
Được — `src/server` và `public/` hoàn toàn tách rời. `import { SocialPoster } from './src/index.js'` là đủ.

---

## Giấy phép

MIT
