# Cấu hình TikTok và Telegram

---

# TikTok

> Nguồn: [Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started), [Media Transfer Guide](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide), [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines). Kiểm chứng tháng 9/2026.

## 1. Tạo app

1. [developers.tiktok.com](https://developers.tiktok.com) → **Manage apps** → tạo app.
2. Thêm sản phẩm **Content Posting API**.
3. **Login Kit** → Redirect URI: với app Sandbox dán thẳng
   `http://127.0.0.1:4000/oauth/tiktok/callback`; app production phải là https —
   xem [mục 2](#2-redirect-uri-sandbox-nhận-http-production-đòi-https).
4. Xin scope: `video.publish` (đăng trực tiếp) và/hoặc `video.upload` (gửi nháp), thêm `user.info.basic` để lấy tên/avatar.
5. Copy **Client Key** / **Client Secret** vào tab Cài đặt → **Kết nối TikTok**.

> Nộp app cho TikTok duyệt: [tiktok-app-review.md](./tiktok-app-review.md) có sẵn bản mô tả
> tiếng Anh, giải trình từng scope, kịch bản video demo và checklist trước khi nộp.
> Form cần 4 URL công khai — trang giới thiệu, [Terms of Service](./terms.html),
> [Privacy Policy](./privacy.html) và Redirect URI. Bật GitHub Pages cho thư mục
> `/docs` là có đủ cả bốn.

## 2. Redirect URI: Sandbox nhận http, production đòi https

**Đang phát triển (app ở chế độ Sandbox):** dán thẳng URL web admin hiển thị,
ví dụ `http://127.0.0.1:4000/oauth/tiktok/callback`, vào cả hai chỗ:

1. **Login Kit → Redirect URI** trong app TikTok
2. Web admin: tab **Cài đặt** → TikTok → ô **Redirect URI** (hoặc để trống, app
   tự suy ra từ địa chỉ bạn đang mở)

Sandbox nhận `http` và loopback, nên không cần gì thêm. App cũng không tự chặn
theo scheme — nền tảng tự quyết định.

**Khi chuyển sang production:** TikTok áp lại quy định của Login Kit —
*"URIs must be absolute and begin with `https`"*, **không có ngoại lệ cho
loopback** (khác Google, vốn cho phép `http://127.0.0.1` với ứng dụng desktop).
Lúc đó dùng trang cầu nối ở phần dưới.

### Triệu chứng khi scheme không được chấp nhận

> *We couldn't log in with TikTok. This may be due to specific app settings.*
> *If you're a developer, correct the following and try again:* **redirect_uri**

Gặp lỗi này thì kiểm tra hai thứ, theo thứ tự:

1. **Hai chỗ có khớp nhau từng ký tự không** — kể cả cổng và dấu `/` cuối. Đây
   là nguyên nhân phổ biến nhất, kể cả trong Sandbox.
2. **App còn ở Sandbox không** — nếu đã chuyển sang production thì `http` không
   còn dùng được, phải đổi sang trang cầu nối https.

### Trang cầu nối https (cho production)

TikTok không hỗ trợ device code flow, nên với app production cách duy nhất là
cho TikTok redirect tới một **trang https**, rồi trang đó chuyển tiếp về máy bạn.

Repo có sẵn trang này: [`oauth-bridge/tiktok-callback.html`](./oauth-bridge/tiktok-callback.html).
Nó nhận `code`/`state` từ TikTok rồi chuyển hướng về `http://127.0.0.1:4000/oauth/tiktok/callback`.
Trang không đọc, không lưu và không gửi `code` đi đâu khác — chỉ ghép lại query
string và redirect.

Đưa nó lên bất kỳ host tĩnh https nào. Nhanh nhất là **GitHub Pages**, vốn cũng
là nơi bạn cần để đặt trang giới thiệu / Terms of Service / Privacy Policy:

1. Đẩy repo lên GitHub → **Settings → Pages** → Source: nhánh chính, thư mục `/docs`.
2. Đợi vài phút, trang sẽ có ở
   `https://<user>.github.io/<repo>/oauth-bridge/tiktok-callback.html`
3. Dán đúng URL đó vào **Redirect URI** trong app TikTok.
4. Dán lại đúng URL đó vào web admin: tab **Cài đặt** → mục TikTok → ô
   **Redirect URI**. Hai chỗ phải **giống hệt nhau từng ký tự**, kể cả dấu `/` cuối.

Nếu web admin chạy cổng khác 4000, sửa hằng `PORT` ở đầu phần `<script>` trong
file html rồi đẩy lại. (Trang cũng nhận `?port=`, nhưng TikTok **không cho đăng ký**
Redirect URI có query string, nên cách đó chỉ dùng được khi mở tay để thử.)

> Chưa dùng GitHub Pages cũng được: Cloudflare Pages, Netlify, hay bất kỳ domain
> https nào bạn có đều dùng được, miễn là URL tĩnh và không có query string.

### Vì sao không dùng ngrok/cloudflared

Được, nhưng tunnel miễn phí đổi URL mỗi lần chạy, mà Redirect URI phải khớp
tuyệt đối → phải vào TikTok Developer sửa lại sau mỗi lần khởi động. Trang tĩnh
có URL cố định vĩnh viễn.

Nếu vẫn muốn dùng tunnel: chạy `node bin/cli.js serve --public-url https://xxx.trycloudflare.com`
rồi đăng ký `https://xxx.trycloudflare.com/oauth/tiktok/callback`. Lúc này không
cần trang cầu nối, nhưng phải cập nhật lại mỗi lần URL đổi.

### Kiểm tra nhanh

App sẽ chặn trước và báo rõ nếu redirect URI chưa phải https — bạn sẽ thấy thông
báo *"TikTok chi chap nhan redirect_uri bat dau bang https"* ngay trong web admin
thay vì bị đá sang màn hình lỗi khó hiểu của TikTok.

## 3. Rào cản lớn nhất: app chưa audit chỉ đăng được riêng tư

> *"Unaudited API Clients can only post contents in SELF_ONLY viewership"* — và tài khoản của creator cũng **phải đang ở chế độ private** khi đăng.

Gửi `PUBLIC_TO_EVERYONE` từ app chưa audit → `403 unaudited_client_can_only_post_to_private_accounts`.

Ba lựa chọn:

| Cách | Kết quả |
|---|---|
| `privacyLevel: 'SELF_ONLY'` (mặc định của module) | Bài đăng thành công nhưng **chỉ bạn thấy**. Muốn public phải vào app đổi tài khoản sang public rồi đổi từng bài — thủ công |
| `postMode: 'MEDIA_UPLOAD'` | Video vào **nháp trong inbox TikTok**, creator mở app và tự đăng công khai. **Thường là lựa chọn tốt hơn** |
| Nộp audit cho TikTok | Mới đăng công khai tự động được |

```js
// Cách khuyến nghị khi chưa audit:
overrides: { tiktok: { postMode: 'MEDIA_UPLOAD' } }
// → status 'draft', module nhắc: creator phải mở thông báo inbox để hoàn tất
```

TikTok còn yêu cầu UX mà API không kiểm tra được nhưng **audit sẽ kiểm**: người dùng phải tự chọn privacy từ dropdown (không có giá trị mặc định), tự bật các toggle tương tác, và UI phải hiện *Music Usage Confirmation*. Một bot đăng hoàn toàn tự động về bản chất xung đột với các quy định này — hãy tính đến một bước xác nhận của con người nếu định nộp audit.

## 4. `creator_info/query` là bắt buộc

Module luôn gọi trước mỗi lần đăng trực tiếp, vì:

1. `privacy_level` gửi lên **phải** nằm trong `privacy_level_options` trả về, nếu không → `403 privacy_level_option_mismatch`. Danh sách này **thay đổi theo loại tài khoản**:
   - Tài khoản **public**: `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `SELF_ONLY`
   - Tài khoản **private**: `FOLLOWER_OF_CREATOR`, `MUTUAL_FOLLOW_FRIENDS`, `SELF_ONLY`
   → Hardcode `PUBLIC_TO_EVERYONE` sẽ vỡ ngay khi creator chuyển tài khoản sang private. Module tự hạ về `SELF_ONLY` và ghi cảnh báo.
2. `comment_disabled` / `duet_disabled` / `stitch_disabled` cho biết creator đã tắt gì ở cấp tài khoản — module tôn trọng các giá trị này.
3. `max_video_post_duration_sec` là hạn mức riêng của từng creator (3/5/10 phút). Module kiểm tra **trước khi upload** để không tốn băng thông vô ích.

## 5. Ảnh chỉ dùng PULL_FROM_URL từ domain đã xác minh

- Video: dùng `FILE_UPLOAD` (upload trực tiếp) → **không cần** xác minh domain. Module ưu tiên cách này.
- Ảnh: **chỉ có** `PULL_FROM_URL`. Bạn phải thêm Domain hoặc URL Prefix vào phần *URL properties* của app và xác minh. Không xác minh → `403 url_ownership_unverified`.
- URL phải là **https**, **không redirect**, và sống được **ít nhất 1 giờ** (task download timeout sau 1h).

## 6. Byte math của chunk upload (chỗ dễ sai nhất)

```
chunk_size          : 5MB ≤ chunk ≤ 64MB
total_chunk_count   : floor(video_size / chunk_size)     ← FLOOR, không phải ceil
chunk CUỐI          : gom hết phần dư → LỚN HƠN chunk_size (tối đa 128MB)
video < 5MB         : 1 chunk = cả file (chunk_size = video_size)
video > 64MB        : bắt buộc chia nhiều chunk
số chunk            : 1 – 1000, gửi TUẦN TỰ
Content-Range       : bytes {start}-{end}/{total}, end INCLUSIVE
```

Ví dụ đúng cho 50.000.123 byte với chunk 10.000.000:

```
chunk 0: bytes 0-9999999/50000123          (10.000.000 byte)
chunk 1: bytes 10000000-19999999/50000123
chunk 2: bytes 20000000-29999999/50000123
chunk 3: bytes 30000000-39999999/50000123
chunk 4: bytes 40000000-50000122/50000123  (10.000.123 byte ← LỚN HƠN chunk_size)
```

Lỗi kinh điển là dùng `ceil()` rồi tạo chunk thứ 6 chỉ 123 byte — TikTok từ chối. Module xử lý đúng và có test kiểm chứng chính con số này.

Phản hồi của PUT: `206` = nhận rồi, gửi tiếp · `201` = xong hết · `400`/`416` = sai byte math · `403` = upload_url hết hạn (chỉ sống **1 giờ**) · `404` = task không còn · `5xx` = thử lại.

`201` **không** nghĩa là đã đăng — phải poll `status/fetch` đến `PUBLISH_COMPLETE`.

## 7. Caption nằm ở field khác nhau tuỳ loại media

| Loại | Field caption | Giới hạn |
|---|---|---|
| Video | `post_info.title` | 2200 UTF-16 rune |
| Ảnh | `post_info.description` | 4000 rune |
| Ảnh | `post_info.title` (tiêu đề ngắn) | **90 rune** |

Nhét caption 500 ký tự vào `title` của bài ảnh là vượt hạn mức 90. Module tự đặt đúng field cho từng loại.

Hashtag viết thẳng trong text, **phân cách bằng khoảng trắng**. `funny#cat` không được parse thành hashtag.

## 8. Refresh token xoay mỗi lần refresh

> *"The returned refresh_token may be different than the one passed in the payload. You must use the newly-returned token."*

Access token sống 24h, refresh token 365 ngày. Module lưu refresh token mới vào token store — **bắt buộc dùng `FileTokenStore`** (web admin đã tự dùng), nếu chạy với `MemoryTokenStore` thì sau khi process tắt là mất quyền.

## 9. Hạn mức

| Hạn mức | Giá trị |
|---|---|
| `creator_info/query` | 20 req/phút |
| `video/init`, `content/init`, `inbox/video/init` | **6 req/phút** ← nút cổ chai thực sự |
| `status/fetch` | 30 req/phút |
| Bài/ngày/creator | ~15, **tính chung mọi ứng dụng** (creator dùng tool khác cũng ăn vào hạn mức của bạn) |
| Người dùng/24h khi chưa audit | 5 (`reached_active_user_cap`) |
| Nháp đang chờ | 5/24h |

## 10. Giới hạn media

| | Giá trị |
|---|---|
| Video | MP4 (khuyến nghị) / WebM / MOV, H.264 / H.265 / VP8 / VP9 |
| FPS | 23 – 60 |
| Kích thước | 360 – 4096px mỗi chiều |
| Dung lượng | ≤ 4GB |
| Ảnh | **JPEG / WebP** (PNG và GIF không được) |
| Ảnh | ≤ 1080p, ≤ 20MB mỗi ảnh, tối đa **35 ảnh** |

## 11. Lỗi thường gặp

| `error.code` / `fail_reason` | Cách sửa |
|---|---|
| `unaudited_client_can_only_post_to_private_accounts` | Cần **cả hai**: `privacy_level=SELF_ONLY` và tài khoản TikTok đang ở chế độ private. Vào TikTok → Settings → Privacy → bật *Private account*. Hoặc dùng `MEDIA_UPLOAD` (gửi nháp) để tự đăng công khai |
| `privacy_level_option_mismatch` | Giá trị không có trong `privacy_level_options` |
| `url_ownership_unverified` | Xác minh domain trong app (bắt buộc cho ảnh) |
| `spam_risk_too_many_posts` | Creator vượt ~15 bài/24h |
| `reached_active_user_cap` | App chưa audit: 5 người dùng/24h |
| `scope_not_authorized` | Token thiếu `video.publish` / `video.upload` |
| `file_format_check_failed` | Transcode lại MP4 H.264 |
| `frame_rate_check_failed` | FPS phải trong 23-60 |
| `picture_size_check_failed` | Ảnh vượt 1080p |
| `spam_risk_text` | Caption bị coi là spam — bớt hashtag/link |
| `video_pull_failed` | URL không https / redirect / đã hết hiệu lực |
| `redirect_uri` (ở màn hình cấp quyền) | Hai chỗ đăng ký không khớp, hoặc app production dùng http — xem [mục 2](#2-redirect-uri-sandbox-nhận-http-production-đòi-https) |
| `invalid_request` *The request parameters are malformed* (lúc đổi code lấy token) | Client Key/Secret dính khoảng trắng khi copy → lưu lại trong tab Cài đặt; hoặc `redirect_uri` lúc đổi token khác lúc authorize. Thông báo lỗi in ra cả hai giá trị để đối chiếu |

---

# Telegram

> Nguồn: [Bot API](https://core.telegram.org/bots/api) **10.3**. Kiểm chứng tháng 9/2026.

## 1. Kết nối (không cần OAuth)

1. Chat với [@BotFather](https://t.me/BotFather) → `/newbot` → đặt tên → nhận token dạng `123456789:AAH...`
2. Thêm bot vào channel: **Channel info → Administrators → Add Admin** → chọn bot → bật quyền **Post Messages**
3. Tab **Kênh** → form *Kết nối Telegram* → nhập token + chat id

**Chat id lấy thế nào:**

| Loại chat | Giá trị |
|---|---|
| Channel/supergroup **public** có username | `@tenchannel` |
| Channel **private** | `-1001234567890` — forward một tin từ channel tới [@userinfobot](https://t.me/userinfobot), hoặc gọi `getChat` |
| Group thường | id âm không có tiền tố `-100` |

Module gọi `getChat` và lưu lại **id dạng số** thay vì `@username`, vì chủ channel đổi username là config `@` hỏng ngay.

Web admin kiểm tra luôn `getChatMember` để chắc bot là admin có `can_post_messages` — sai thì báo ngay lúc kết nối thay vì lúc đăng bài.

## 2. Giới hạn dung lượng — khác nhau giữa upload và URL

| Cách gửi | Ảnh | File khác |
|---|---|---|
| **Upload multipart** (file local) | 10MB | 50MB |
| **Telegram tự tải từ URL** | **5MB** | 20MB |
| `file_id` (đã gửi trước đó) | không giới hạn | không giới hạn |

Module tự chọn: media là URL công khai thì để Telegram tự tải (nhanh, không tốn băng thông của bạn); file local thì upload. Nếu file local vượt giới hạn URL thì nó tự chuyển sang upload trực tiếp.

Vượt cả 50MB → phải chạy [Local Bot API Server](https://core.telegram.org/bots/api#using-a-local-bot-api-server).

## 3. Caption 1024 ký tự

Tin nhắn text được 4096 nhưng **caption kèm media chỉ 1024**. Module dựng caption theo đúng giới hạn; muốn giữ trọn nội dung dài:

```js
overrides: { telegram: { longCaptionMode: 'split' } }
// → media + (title & hashtag) trong caption
//   description gửi thành tin nhắn riêng, reply vào bài đầu
```

## 4. Album 2-10 media

- `sendMediaGroup` chỉ nhận **2-10** item. Module tự chia nhiều album nếu bạn đưa 12 ảnh, và **caption chỉ đặt ở item đầu của album đầu** (đặt caption ở nhiều item thì Telegram không hiện caption chung — đây là bug "caption biến mất" kinh điển).
- GIF trong album gửi dạng `document` (`InputMediaAnimation` không hợp lệ trong album).
- Album **không** gắn được inline keyboard.

## 5. Định dạng text: dùng HTML

Mặc định module dùng `parse_mode: 'HTML'` vì MarkdownV2 bắt escape **18 ký tự**: ``_ * [ ] ( ) ~ ` > # + - = | { } . !`` — một caption sinh tự động gần như luôn có dấu `.` hoặc `-` → `400 can't parse entities`.

HTML chỉ cần 3 phép thay thế, và phải theo đúng thứ tự: `&` → `&amp;` **trước**, rồi `<` → `&lt;`, `>` → `&gt;`. Module escape nội dung người dùng **trước** khi bọc thẻ `<b>`.

Thẻ HTML được phép: `b i u s span(tg-spoiler) a code pre blockquote tg-emoji`. Thẻ khác → 400.

Không muốn định dạng gì: `parseMode: 'none'`.

## 6. Kênh hình nền: giữ chất lượng gốc

`sendPhoto` **nén lại ảnh** và giới hạn 10MB / 10000px tổng / tỉ lệ 20:1. Với kênh mà chất lượng ảnh chính là sản phẩm:

```js
overrides: { telegram: { sendAsDocument: true } }
// → gửi qua sendDocument, Telegram giao file NGUYÊN BẢN
```

Cách hay dùng: đăng bản preview bằng `sendPhoto` (để xem nhanh trong app) và bản gốc bằng `sendDocument`.

## 7. Nhiều chat trong một lần đăng

```js
telegram: { botToken: 'T', chatId: ['@kenh_vi', '@kenh_en', '-1001234567890'] }
```

Module gửi lần lượt (không song song, để không đụng rate limit).

## 8. Rate limit

- ~30 tin/giây toàn bot
- **20 tin/phút** cho mỗi group/channel
- `429` trả kèm `parameters.retry_after` (giây) — module tôn trọng đúng giá trị này. Vi phạm `retry_after` sẽ bị kéo dài hình phạt.
- `retry_after` có thể lên tới hàng giờ sau khi lạm dụng.

## 9. Tuỳ chọn hay dùng

```js
overrides: {
  telegram: {
    parseMode: 'HTML',                 // HTML | MarkdownV2 | none
    longCaptionMode: 'split',
    disableNotification: true,         // gửi im lặng — nên bật cho bot đăng đều
    protectContent: false,             // true sẽ chặn forward/save → giảm reach
    sendAsDocument: false,
    showCaptionAboveMedia: false,
    hasSpoiler: false,
    supportsStreaming: true,
    boldTitle: true,                   // in đậm tiêu đề
    thumbnail: './thumb.jpg',          // JPEG < 200KB, ≤ 320x320, chỉ khi upload multipart
    messageThreadId: 123,              // chỉ cho forum supergroup
    forceUpload: false,                // buộc upload thay vì để Telegram tải từ URL
  },
}
```

## 10. Lỗi thường gặp

| Lỗi | Cách sửa |
|---|---|
| `chat not found` | Channel public dùng `@ten`; private dùng `-100...`. Bot đã được thêm vào channel chưa? |
| `not enough rights to send photos` | Bot chưa là admin, hoặc thiếu quyền Post Messages |
| `bot is not a member of the channel chat` | Chưa thêm bot vào channel |
| `file is too big` | Vượt 10MB ảnh / 50MB file. Dùng URL hoặc Local Bot API Server |
| `failed to get HTTP URL content` | Telegram không tải được URL (cần public, đúng MIME, không bị WAF chặn) |
| `can't parse entities` | Lỗi escape — chuyển `parseMode: 'HTML'` hoặc `'none'` |
| `429` | Giảm tần suất, module tự chờ theo `retry_after` |
| `409 Conflict` | Hai instance cùng gọi `getUpdates`, hoặc polling khi đã set webhook (không ảnh hưởng việc đăng bài) |
