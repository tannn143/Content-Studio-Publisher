# Cấu hình Facebook Page + Instagram

> Nguồn: [Pages API](https://developers.facebook.com/docs/pages-api/posts), [Video API — Reels](https://developers.facebook.com/docs/video-api/guides/reels-publishing), [Instagram Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing). Graph API **v26.0**, kiểm chứng tháng 9/2026.

Một lần kết nối tạo ra **nhiều kênh**: mỗi Facebook Page một kênh, và mỗi Page có Instagram Business liên kết thì thêm một kênh Instagram.

## 1. Tạo app

1. [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create App** → loại **Business**.
2. Thêm sản phẩm **Facebook Login** → **Settings**:
   - *Valid OAuth Redirect URIs*: dán chính xác chuỗi web admin hiển thị, ví dụ
     `http://127.0.0.1:4000/oauth/facebook/callback`
   - Bật *Client OAuth Login* và *Web OAuth Login*
3. **App settings → Basic**: copy **App ID** và **App Secret** vào tab Cài đặt.
4. Tab **Kênh** → **Kết nối Facebook Page + Instagram**.

## 2. Chuỗi token — lỗi #1 của mọi tích hợp Facebook

Page access token **chỉ không hết hạn** nếu nó được sinh ra từ một **user token dài hạn**:

```
user token ngắn hạn (1-2h)
      │  GET /oauth/access_token?grant_type=fb_exchange_token
      ▼
user token DÀI HẠN (~60 ngày)          ← bước bắt buộc
      │  GET /me/accounts
      ▼
PAGE token (không hết hạn)
```

Gọi `/me/accounts` bằng token ngắn hạn cho ra Page token **chết sau 1-2 giờ**, và không có lỗi nào báo cho bạn biết. Module tự làm đúng thứ tự này trong `src/auth/oauth.js`.

Page token vẫn có thể bị vô hiệu khi: user đổi mật khẩu, thu hồi app, mất role trên Page, app bị chuyển về development mode, hoặc quá 90 ngày không reauth (`data_access_expires_at`). Khi đó module trả `AuthError` code 190 kèm giải thích theo `error_subcode` → kết nối lại qua web admin.

## 3. Quyền (permissions)

| Quyền | Dùng để |
|---|---|
`pages_show_list` | liệt kê Page, lấy Page token
`pages_read_engagement` | bắt buộc kèm `pages_manage_posts`
`pages_manage_posts` | đăng/sửa/xoá bài, ảnh, video trên Page
`instagram_basic` | đọc thông tin IG account
`instagram_content_publish` | đăng bài IG

- Tất cả đều **cần App Review** (kèm screencast luồng login và tạo/sửa/xoá bài) nếu dùng cho người không phải Admin/Developer/Tester của app. Chưa review thì chỉ hoạt động với chính bạn — dev thấy chạy tốt, production fail toàn bộ.
- `publish_video` là cho **live stream**, không cần cho video/Reel thường.
- User phải có task **CREATE_CONTENT** trên Page. Module kiểm tra và cảnh báo trong `verifyCredentials()`.
- Nếu Page được cấp quyền qua Business Manager thì cần thêm `ads_management` hoặc `ads_read` cho Instagram.

## 4. Facebook Page — loại bài

| Loại | Endpoint module dùng | Ghi chú |
|---|---|---|
| Text / link | `POST /{page-id}/feed` | `message` + `link` |
| 1 ảnh | `POST /{page-id}/photos` | dùng field **`caption`** (`message` đã deprecated) |
| Nhiều ảnh | `/photos` với `published=false&temporary=true` → `/feed` với `attached_media` | không trộn được ảnh và video trong một bài |
| Video | `POST /{page-id}/videos` | 1 lần: ≤ 1GB / 20 phút |
| Video lớn | Resumable Upload API | ≤ 1.75GB / 45 phút, cần `appId` + `userAccessToken` |
| Reel | `/{page-id}/video_reels` 3 pha | 9:16, 3-90s, tối đa **30 bài/Page/24h** |

Module **tự chọn Reel** khi video dọc và dài 3-90s. Ép thủ công:

```js
overrides: { facebook: { asReel: true } }   // hoặc false để buộc thành video thường
```

Video/Reel là **bất đồng bộ**: HTTP 200 chỉ nghĩa là "đã nhận". Module poll `GET /{video-id}?fields=status` đến khi `video_status === 'ready'` rồi mới báo thành công — nên một video lỗi transcode không bị báo nhầm là thành công.

### Giới hạn media Facebook

| | Giới hạn |
|---|---|
| Ảnh JPEG/BMP/GIF/TIFF | **4MB** |
| Ảnh **PNG** | **1MB** ← hình nền PNG hầu như luôn vượt, hãy convert sang JPEG |
| Video 1 lần | 1GB / 20 phút |
| Video resumable | 1.75GB / 45 phút |
| Tỉ lệ video | từ 9:16 đến 16:9 |
| Reels | 9:16, ≥ 540×960, 3-90s, 24-60fps, H.264/H.265 + AAC |

### Quota

Quota Page = **`4800 × số người tương tác với Page trong 24h`**. Page mới hoặc ít tương tác có hạn mức rất nhỏ. Module đọc header `X-App-Usage` / `X-Business-Use-Case-Usage` và cảnh báo khi vượt 80%.

Không có "giới hạn 4 giờ" nào trong tài liệu chính thức — con số đó là tin truyền miệng. Thực tế bạn sẽ gặp `error 368` ("deemed abusive") từ lớp chống spam; module đánh dấu retryable nhưng đặt `retryAfterMs = 30 phút` vì retry dồn dập có thể khiến Page bị chặn đăng.

`error 506` = Facebook từ chối nội dung **y hệt** bài trước. Bot đăng theo template phải đổi text (thêm timestamp/emoji/hashtag khác nhau).

## 5. Instagram — khác biệt quan trọng

### Ảnh bắt buộc là URL công khai

Không có đường upload file ảnh nào. Tài liệu ghi rõ: *"We will cURL the image using the URL that you specify so the image must be on a public server."*

→ Cấu hình `mediaHost` (S3/R2/tunnel). Module tự đưa file lên, đăng, rồi xoá. Không cấu hình mà đăng ảnh local thì module báo lỗi **trước khi** gọi API:

```
ConfigError: Nen tang nay yeu cau URL cong khai nhung media la file local
             va chua cau hinh `mediaHost`.
```

### Ảnh: JPEG và tỉ lệ 4:5 → 1.91:1

| Yêu cầu | Giá trị |
|---|---|
| Định dạng | **JPEG duy nhất** (PNG/WebP/HEIC bị từ chối) |
| Dung lượng | ≤ 8MB |
| Chiều rộng | 320 – 1440px (rộng hơn bị hạ xuống 1440) |
| Tỉ lệ | **0.8 (4:5) → 1.91:1** |
| Màu | sRGB |

**Hình nền dọc 9:16 (0.5625) KHÔNG đăng được lên feed** — chỉ Reels hoặc Stories. Với feed hãy crop về 1080×1350 (4:5) hoặc 1080×1080. Module kiểm tra và báo lỗi kèm hướng dẫn cụ thể thay vì để Meta trả `36003/2207009`.

### Video thì upload file được

Video dùng `upload_type=resumable` + `rupload.facebook.com` → **không cần** `mediaHost`. Module tự chọn đường này cho video local, và khi upload bị ngắt thì đọc `video_status.uploading_phase.bytes_transferred` để tiếp tục từ đúng offset thay vì upload lại từ đầu.

### Luồng đăng 2 bước

```
POST /{ig-user-id}/media          → creation_id (container)
GET  /{container-id}?fields=status_code,status   → chờ FINISHED
POST /{ig-user-id}/media_publish  → media id
```

- Container **hết hạn sau 24 giờ**.
- Publish sớm → `9007/2207027`. Module luôn poll trước.
- Lỗi bất đồng bộ trả về **HTTP 200** với `status_code=ERROR`, nguyên nhân nằm trong field `status` (là một subcode). Module dịch subcode sang tiếng Việt kèm cách sửa.

### Các loại bài IG

```js
// Ảnh feed (mặc định)
media: './anh-1080x1350.jpg'

// Reel (video)
media: './video-9-16.mp4'
overrides: { instagram: { shareToFeed: true, thumbOffset: 1000 } }

// Stories
overrides: { instagram: { target: 'story' } }   // Stories KHÔNG có caption

// Carousel: 2-10 media, mọi item bị crop theo tỉ lệ của item ĐẦU TIÊN
media: ['./1.jpg', './2.jpg', './3.jpg']
```

| Giới hạn IG | Giá trị |
|---|---|
| Caption | 2200 ký tự |
| Hashtag | **30** |
| @mention | 20 |
| Carousel | 2-10 item |
| Reel | ≤ 300MB, 3s-15 phút, MP4/MOV H.264/H.265 + AAC, **faststart** (`ffmpeg -movflags +faststart`) |
| Story video | ≤ 100MB, 3-60s |
| Bài/24h | 50 (module đọc `content_publishing_limit` để biết số thực) |

## 6. Tuỳ chọn hay dùng

```js
overrides: {
  facebook: {
    asReel: true,
    published: true,
    noStory: false,
    contentCategory: 'LIFESTYLE',
    thumbnail: './cover.jpg',
    resumable: true,          // video > 1GB (cần appId + userAccessToken)
    waitForProcessing: true,
  },
  instagram: {
    target: 'story',          // hoặc bỏ để tự chọn feed/reel
    shareToFeed: true,
    coverUrl: 'https://cdn.example.com/cover.jpg',
    thumbOffset: 1500,
    collaborators: ['user1', 'user2'],
    userTags: [{ username: 'brand', x: 0.5, y: 0.5 }],
    isAiGenerated: false,
    checkQuota: true,         // kiểm tra hạn mức 24h trước khi đăng
  },
}
```

## 7. Lỗi thường gặp

| Lỗi | Cách sửa |
|---|---|
| code 190 / subcode 460 | User đổi mật khẩu → kết nối lại |
| code 190 / subcode 492 | User mất role trên Page |
| code 200 | Thiếu quyền, hoặc thiếu task CREATE_CONTENT |
| code 104 | App bật "Require App Secret" → cấu hình `appSecret` |
| code 324 | Ảnh sai định dạng hoặc vượt dung lượng (PNG > 1MB) |
| code 368 | Lớp chống spam — giảm tần suất, chờ vài giờ |
| code 389 | Meta không tải được video từ URL |
| code 506 | Nội dung trùng bài trước |
| IG `2207052` | URL không công khai / cần đăng nhập / redirect nhiều lần / HTTPS sai |
| IG `2207009` | Tỉ lệ ảnh ngoài 4:5–1.91:1 |
| IG `2207026` | Video sai định dạng — transcode lại MP4 H.264 + AAC faststart |
| IG `2207042` | Hết hạn mức bài/24h |
| IG `status_code: EXPIRED` | Container quá 24h → tạo lại |
