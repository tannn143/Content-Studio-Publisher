# Cấu hình YouTube

> Nguồn: [YouTube Data API v3 — videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert), [resumable upload protocol](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol). Kiểm chứng lại tháng 9/2026.

## 1. Tạo OAuth client

1. Vào [Google Cloud Console](https://console.cloud.google.com) → tạo project mới (hoặc chọn project có sẵn).
2. **APIs & Services → Library** → tìm **YouTube Data API v3** → **Enable**.
   Không bật bước này thì mọi request trả `403 accessNotConfigured`.
3. **APIs & Services → OAuth consent screen**:
   - User type: *External*
   - Thêm scope `https://www.googleapis.com/auth/youtube.upload`
   - Thêm email của bạn vào *Test users*
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs: dán chính xác chuỗi mà web admin hiển thị ở tab **Cài đặt**, ví dụ
     `http://127.0.0.1:4000/oauth/google/callback`
5. Copy **Client ID** và **Client secret** vào tab Cài đặt của web admin → tab **Kênh** → **Kết nối YouTube (Google)**.

## 2. Cái bẫy lớn nhất: chế độ Testing làm token chết sau 7 ngày

Nếu OAuth consent screen ở trạng thái **Testing** với user type *External*, refresh token **hết hạn sau 7 ngày** (vì `youtube.upload` là sensitive scope). Cứ mỗi tuần bạn sẽ nhận:

```
AuthError: YouTube refresh_token het han hoac bi thu hoi (invalid_grant)
```

Cách xử lý:

| Lựa chọn | Ưu / nhược |
|---|---|
| **Publish app** sang *In production* | Bền vững. Nhưng scope sensitive cần Google verify (mất vài ngày–vài tuần) |
| Chấp nhận kết nối lại mỗi tuần | Được nếu chỉ dùng nội bộ. Đặt nhắc lịch |
| Dùng **Internal** user type | Chỉ khả dụng nếu bạn có Google Workspace — khi đó token không hết hạn |

Lưu ý thêm: mỗi Google Account chỉ giữ **~100 refresh token đang sống cho mỗi OAuth client**. Chạy lại luồng cấp quyền ở mỗi lần deploy sẽ âm thầm vô hiệu hoá token cũ nhất.

## 3. Quota

Từ 2026, `videos.insert` dùng **bucket quota riêng**:

```
100 videos.insert / ngày / PROJECT   (không phải per channel)
100 search.list  / ngày / project
10.000 unit / ngày cho các endpoint còn lại (thumbnails.set = 50, videos.list = 1)
```

- Reset 0h **giờ Pacific**.
- Tính theo **project Google Cloud**, nên nhiều môi trường/nhiều channel dùng chung project sẽ dùng chung hạn mức.
- Quota bị trừ ở **bước khởi tạo** upload, không phải khi hoàn tất → module cố ý **không retry** bước init (`initRetries: 0`).
- Tăng quota phải qua *YouTube API Services Compliance Audit*.

## 4. Những gì API không làm được

- **Không** đăng community post / ảnh / poll. Chỉ có video, thumbnail, caption, playlist, live.
- **Không** dùng service account cho channel thường (`401 youtubeSignupRequired`).
- Muốn "đăng ảnh lên YouTube" thì cách duy nhất hợp lệ là encode ảnh thành video dọc ngắn (Shorts).

## 5. Shorts

Không có field API nào cho Shorts. YouTube tự xếp loại dựa trên **media**:

- Tỉ lệ **dọc hoặc vuông** (width ≤ height) — 1080×1920 là chuẩn
- Thời lượng **≤ 3 phút**

`#Shorts` trong title/description **không còn là điều kiện** từ 2026 (chỉ còn tác dụng hashtag thông thường) và nó ăn vào hạn mức 100 ký tự title.

Đặt `asShort: true` để module cảnh báo khi media không đạt điều kiện:

```js
overrides: { youtube: { asShort: true } }
// → WARN: video co the KHONG duoc xem la Shorts
//         reasons: ["video ngang (can doc hoac vuong)"]
```

## 6. Giới hạn metadata

| Field | Giới hạn | Ghi chú |
|---|---|---|
| `title` | **100 ký tự** | Ký tự `<` `>` bị từ chối thẳng (module tự bỏ) |
| `description` | **5000 BYTE** | Không phải ký tự. Emoji ăn 4 byte, tiếng Việt có dấu 3 byte |
| `tags` | **tổng 500 ký tự** | Tính cả dấu phẩy nối **và** dấu ngoặc kép mà server tự thêm quanh tag có khoảng trắng |
| hashtag trong mô tả | > 60 thì YouTube bỏ hết | Chỉ ~3 tag "hấp dẫn nhất" hiện trên tiêu đề |
| video | 256GB | Channel **chưa xác minh** chỉ được video ≤ 15 phút |
| thumbnail | 2MB, JPEG/PNG | Cần channel **đã xác minh** |

## 7. Hẹn giờ

```js
await poster.post({
  title: '...', media: './v.mp4',
  scheduleAt: '2026-09-20T19:00:00+07:00',
});
```

Module tự đặt `privacyStatus: 'private'` + `publishAt` (YouTube chỉ chấp nhận `publishAt` khi privacy là `private`) và dùng ISO UTC — thời gian local không có offset là nguyên nhân phổ biến nhất của `400 invalidPublishAt`.

## 8. Tuỳ chọn hay dùng

```js
overrides: {
  youtube: {
    privacyStatus: 'unlisted',        // private | unlisted | public
    categoryId: '22',                 // chuỗi, không phải số
    madeForKids: false,               // → status.selfDeclaredMadeForKids
    notifySubscribers: false,         // mặc định false để không spam
    playlistId: 'PLxxxx',             // tự thêm vào playlist sau khi xử lý xong
    thumbnail: './thumb.jpg',
    containsSyntheticMedia: true,     // khai báo nội dung AI
    chunkSizeBytes: 8 * 1024 * 1024,  // bội số 256KB
    waitForProcessing: true,          // chờ transcode xong mới đặt thumbnail
    processingTimeoutMs: 20 * 60_000,
  },
}
```

## 9. Lỗi thường gặp

| Lỗi | Nguyên nhân & cách sửa |
|---|---|
| `400 mediaBodyRequired` | Gọi sai host — phải là `.../upload/youtube/v3/videos` (module đã đúng; lỗi này thường do proxy chặn) |
| `400 invalidPublishAt` | `publishAt` ở quá khứ, hoặc `privacyStatus` không phải `private` |
| `400 invalidTags` | Tổng tags > 500 ký tự |
| `403 quotaExceeded` | Hết 100 upload/ngày. Chờ 0h Pacific — retry là vô nghĩa |
| `403 rateLimitExceeded` | Throttle ngắn hạn, module tự retry với backoff |
| `400 uploadLimitExceeded` | Hạn mức video/ngày của **chính channel**. Đợi sang ngày |
| `403 forbidden` khi đặt thumbnail | Channel chưa xác minh |
| `uploadStatus: rejected`, `rejectionReason: length` | Channel chưa xác minh mà video > 15 phút |
| `401 youtubeSignupRequired` | Tài khoản Google chưa có channel YouTube |
| `404` giữa lúc upload | Session resumable hết hạn → phải upload lại (mất thêm 1 slot quota) |
