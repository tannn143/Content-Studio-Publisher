# TikTok App Review — submission copy

Bản tiếng Anh để dán thẳng vào form đăng ký app (Desktop) trên
developers.tiktok.com. Mỗi mục ghi rõ dán vào ô nào.

Trạng thái: UI đã đáp ứng đủ yêu cầu UX bắt buộc cho Direct Post, đã có Terms of
Service và Privacy Policy. Xem [checklist trước khi nộp](#8-checklist-trước-khi-nộp).

---

## 1. App name

> **Wallpaper Studio Publisher**

Đừng nộp dưới tên `wallpaper-auto-marketing`. Cụm "auto marketing" là cờ đỏ với
reviewer chống spam: "auto" + "marketing" đọc như công cụ đăng hàng loạt. Tên
trên TikTok Developer không cần trùng tên repo.

Tên hiển thị trong web admin (tiêu đề tab, màn hình đăng nhập, sidebar) đã đổi
sang **Wallpaper Studio Publisher** — reviewer xem video demo sẽ thấy đúng tên
đã đăng ký. Tên package npm giữ nguyên `wallpaper-auto-marketing` vì đổi sẽ phá
mọi câu `import` trong tài liệu; reviewer không nhìn tới đó.

---

## 2. App description (ô "Description", ~500–1000 ký tự)

Wallpaper Studio Publisher is a desktop publishing tool for independent
wallpaper artists and small design studios. It runs locally on the creator's
own computer — there is no hosted backend and no shared account pool.

The creator writes one post by hand (title, caption, hashtags) and attaches
their own original artwork or a video they produced. The app then publishes
that single post to the creator's own connected channels — TikTok, YouTube,
Instagram, Facebook and Telegram — so the creator does not have to retype and
re-upload the same piece of work five times.

Each installation is used by one creator, who connects only their own TikTok
account through OAuth. Access tokens are stored in a file on that creator's
machine and are never sent to us or to any third party. The app has no
follow, like, comment, view or DM automation, and no way to post to an account
the operator does not personally own.

Typical use: an artist finishes a 4K wallpaper set, records a short
walkthrough video, writes a caption, and publishes it once to their own
channels — a few posts per week.

---

## 3. Scope justifications (ô "Reason for requesting" từng scope)

### `user.info.basic`

We call `/v2/user/info/` once, immediately after the creator authorizes, to
read their display name, username and avatar. These are shown in the app's
"Channels" screen so the creator can confirm which TikTok account is
connected, and again on the TikTok publishing form before publishing. This
prevents the most common user error — publishing to the wrong account. We do
not store this data anywhere except the local config file on the creator's own
computer, and we do not use it for analytics or profiling.

### `video.upload`

This is our default and recommended mode. The video is uploaded to the
creator's TikTok inbox as a draft; the creator then opens the TikTok mobile
app, reviews the draft, adds sounds/effects, and decides whether and when to
publish. Nothing becomes visible on TikTok without an explicit action by the
creator inside TikTok's own app. For creators who prefer to keep final
editorial control in TikTok, this is the only mode they ever need.

### `video.publish`

For creators who have already finished their edit and want to publish without
switching devices. Before every Direct Post we call
`/v2/post/publish/creator_info/query/` and build the publishing form entirely
from the response — see section 4 for exactly what the form does. Every Direct
Post is triggered by the creator pressing "Publish" on content they composed
themselves in the app.

We request both `video.upload` and `video.publish` because the mode is a
per-post choice in our UI, not an app-wide setting.

---

## 4. UX compliance — how the publishing form is built

Dán vào phần mô tả chi tiết hoặc ô ghi chú cho reviewer. Đây là phần TikTok
kiểm tra kỹ nhất trong audit Direct Post, nên nói rõ từng điểm:

Our TikTok publishing form is built from the live `creator_info` response,
never from hard-coded assumptions:

- **Account confirmation.** The creator's avatar and nickname from
  `creator_info` are shown at the top of the form, with a refresh control.

- **Privacy level.** The selector lists only the values returned in
  `privacy_level_options`. Nothing is pre-selected: the form opens on
  "— Select who can view this —" and the Publish action is blocked with a
  clear message until the creator chooses. If the creator's available options
  change between composing and publishing, the stale selection is rejected.

- **Interaction settings.** The "disable comment", "disable Duet" and
  "disable Stitch" controls are rendered as disabled and forced on whenever
  `creator_info` reports `comment_disabled`, `duet_disabled` or
  `stitch_disabled` — the app cannot re-enable something the creator turned
  off at the account level.

- **Content disclosure.** A "Disclose commercial content" switch reveals two
  options: "Your brand" (`brand_organic_toggle`) and "Branded content"
  (`brand_content_toggle`). Turning the switch on without choosing at least
  one blocks publishing.

- **Branded content cannot be private.** When "Branded content" is on,
  `SELF_ONLY` is removed from the privacy list, and a previously selected
  `SELF_ONLY` is cleared so the creator must choose again. The API adapter
  enforces the same rule a second time, for both video and photo posts.

- **Consent declaration.** The form shows, next to the publish controls: "By
  posting, you agree to TikTok's Music Usage Confirmation" — and, when Branded
  content is on, "...to TikTok's Branded Content Policy and Music Usage
  Confirmation", each linking to the official policy page.

- **Draft mode.** When the creator chooses "Send to drafts"
  (`MEDIA_UPLOAD`), none of these settings are shown or sent: the creator
  completes everything inside the TikTok app. This is the default when the app
  does not hold the `video.publish` scope.

An automated test suite locks each of the requirements above so they cannot be
removed by a later change.

---

## 5. Anti-spam statement (dán vào "Notes to reviewer")

We have designed this app so it cannot be used as a bulk-posting or
spam tool, and we would like to make that explicit for the review:

**One creator, one account, their own content.**
The app is distributed as source that the creator runs on their own desktop.
There is no multi-tenant server, no account marketplace, no proxy pool and no
credential sharing. A single installation holds one TikTok connection,
authorized interactively through TikTok's OAuth screen by the person sitting
at that computer. The media uploaded is the creator's own artwork, selected
file-by-file from their local disk — the app has no scraper, no content feed,
no "repost trending video" feature and no bulk import.

**Every post is composed by a human.**
Title, caption and hashtags are typed into a form. There is no spinner, no
template rotation, no AI caption mass-generation and no way to enqueue
variations of the same post. A "Dry run" button lets the creator see exactly
what will be sent before anything reaches TikTok. Realistic usage is a handful
of posts per week — one per finished wallpaper set.

**Scheduling reduces volume, it does not increase it.**
The optional queue exists so a creator can publish at a sensible hour instead
of at 2 a.m. It posts strictly sequentially, one item per scheduler tick, and
has no "post every N minutes" or "repeat" mode.

**We respect TikTok's rate and safety limits by design.**
- `creator_info/query` is called before every Direct Post; a mismatched
  `privacy_level` is treated as a bug in our code, not something to retry.
- `rate_limit_exceeded`, `spam_risk_too_many_posts`,
  `spam_risk_too_many_pending_share` and `reached_active_user_cap` are handled
  with exponential backoff — never a tight retry loop.
- We document TikTok's ~15 posts/day/creator limit and the 6 init/min limit in
  our own setup guide so creators do not design workflows that fight them.
- Unaudited installations are hard-defaulted to `SELF_ONLY`.

**No engagement automation of any kind.**
The app requests the minimum scopes needed to publish. It never follows,
unfollows, likes, comments, views, messages, or reads other users' content.
There is no analytics scraping and no interaction with anyone else's account.

---

## 6. Demo video script (TikTok bắt buộc có video cho Content Posting API)

Quay một lần, ~2 phút, màn hình desktop, nói hoặc phụ đề tiếng Anh:

1. Mở terminal, chạy `npm run serve`, cho thấy app khởi động ở
   `http://127.0.0.1:4000` — nói rõ: *"this runs entirely on my own machine"*.
2. Tab **Kênh** → **Kết nối TikTok** → hiện màn hình OAuth thật của TikTok →
   chấp thuận → quay lại app, thấy avatar + tên tài khoản.
3. Tab **Soạn bài** → gõ tiêu đề, mô tả, vài hashtag → kéo một file wallpaper
   hoặc video **của chính bạn** vào. Nói rõ đây là tác phẩm gốc của bạn.
4. Mở **Tuỳ biến theo từng kênh** → tab TikTok. Quay chậm và dừng lại ở từng
   thứ — đây là phần reviewer tua đi tua lại:
   - avatar + nickname lấy từ `creator_info`;
   - dropdown chế độ hiển thị đang ở *— Chọn chế độ hiển thị —*, mở ra cho thấy
     chỉ có đúng những giá trị tài khoản này được phép;
   - ô Duet/Stitch bị khoá nếu tài khoản đã tắt (nếu tài khoản test không tắt,
     vào app TikTok tắt trước khi quay, để có cái mà cho xem);
   - bật **Khai báo nội dung thương mại** → hiện hai ô, bật *Nội dung có tài trợ*
     → cho thấy *Chỉ mình tôi* biến mất khỏi danh sách;
   - dòng tuyên bố đồng ý đổi thành có thêm *Chính sách nội dung có thương hiệu*.
5. Thử bấm **Đăng ngay** khi chưa chọn chế độ hiển thị → cho thấy app chặn lại
   kèm thông báo. Đây là cảnh có sức thuyết phục nhất trong cả video.
6. Chọn chế độ hiển thị → bấm **Chạy thử** → cho thấy app hiển thị chính xác
   payload sẽ gửi.
7. Bấm **Đăng ngay** → trạng thái upload → mở app TikTok trên điện thoại →
   thấy video đã lên đúng tài khoản, đúng chế độ hiển thị.
8. Kết: quay lại tab Kênh, bấm **Ngắt kết nối** để cho thấy creator thu hồi
   quyền được bất cứ lúc nào.

Đừng quay cảnh đăng nhiều bài liên tiếp — đó là hình ảnh reviewer đang tìm để
từ chối.

---

## 7. Website, Redirect URI, Terms of Service, Privacy Policy

Cả bốn ô này nằm trên cùng một nền tảng: bật **GitHub Pages** một lần là có đủ.

### Bật GitHub Pages

Repo → **Settings → Pages** → Source: nhánh chính, thư mục `/docs`. Sau vài
phút bạn có bốn URL:

| Ô trong form TikTok | URL |
|---|---|
| Website URL (platform Desktop) | `https://<user>.github.io/<repo>/` |
| Terms of Service URL | `https://<user>.github.io/<repo>/terms.html` |
| Privacy Policy URL | `https://<user>.github.io/<repo>/privacy.html` |
| Redirect URI (Login Kit) — chỉ khi production | `https://<user>.github.io/<repo>/oauth-bridge/tiktok-callback.html` |

Các trang tương ứng đã có sẵn trong repo:

- [`docs/index.html`](./index.html) — trang giới thiệu, dùng cho ô *"the URL of
  your official website"* mà platform Desktop yêu cầu
- [`docs/terms.html`](./terms.html) — Terms of Service
- [`docs/privacy.html`](./privacy.html) — Privacy Policy
- [`docs/oauth-bridge/tiktok-callback.html`](./oauth-bridge/tiktok-callback.html)
  — trang cầu nối OAuth (xem [setup-tiktok-telegram.md](./setup-tiktok-telegram.md#2-redirect-uri-tiktok-bắt-buộc-https))

> **Phải sửa trước khi bật Pages:** cả ba trang đang để placeholder
> `https://github.com/your-username/wallpaper-auto-marketing`. Thay bằng địa chỉ
> repo thật, và điền địa chỉ liên hệ vào README — mục Contact của Terms và
> Privacy đều trỏ về đó.

### Redirect URI

**Trong lúc phát triển (app Sandbox):** `http://127.0.0.1:4000/oauth/tiktok/callback`
dùng được — Sandbox nhận http và loopback. Không cần trang cầu nối ở giai đoạn này.

**Khi nộp review / chuyển production:** TikTok áp lại quy định *"URIs must be
absolute and begin with `https`"*, không có ngoại lệ cho loopback. Lúc đó đăng ký
URL trang cầu nối ở bảng trên, rồi dán đúng URL đó vào web admin: tab
**Cài đặt** → TikTok → ô **Redirect URI**.

Ghi chú kèm theo cho reviewer: *"The OAuth callback is a static page that only
forwards the authorization code to the loopback interface on the creator's own
machine; no traffic reaches any server of ours."*

### Privacy policy nói gì

Privacy policy đã nói rõ ba thứ TikTok soi: token lưu cục bộ và không gửi về
server nào, từng scope dùng làm gì, và cách creator thu hồi quyền.

### Ảnh (PULL_FROM_URL)

Nếu đăng ảnh, domain host ảnh phải được verify trong mục **URL properties** của
app. Không verify thì ảnh luôn fail — việc này không liên quan đến review nhưng
hay bị quên.

---

## 8. Checklist trước khi nộp

- [x] Tên app hiển thị là "Wallpaper Studio Publisher", không còn "auto marketing"
- [x] Form đăng dựng từ `creator_info`, không hard-code privacy level
- [x] Không chọn sẵn chế độ hiển thị, chặn đăng khi chưa chọn
- [x] Khoá ô comment/Duet/Stitch theo cài đặt tài khoản
- [x] Có công tắc khai báo nội dung thương mại (cả hai loại)
- [x] Chặn branded content + `SELF_ONLY` ở cả UI và adapter
- [x] Có tuyên bố đồng ý Music Usage Confirmation / Branded Content Policy
- [x] Đã có trang giới thiệu, Terms of Service và Privacy Policy trong `docs/`
- [x] Đã có trang cầu nối OAuth https, sẵn cho lúc chuyển production
- [x] Redirect URI cấu hình được trong Cài đặt (Sandbox dùng http, production dùng https)
- [ ] **Thay placeholder `your-username` trong `docs/index.html`, `terms.html`, `privacy.html`**
- [ ] **Điền địa chỉ liên hệ thật vào README** (Terms và Privacy đều trỏ về đó)
- [ ] **Bật GitHub Pages** (Settings → Pages → nhánh chính, thư mục `/docs`)
- [ ] **Điền 3 URL vào form TikTok**: Website, ToS, Privacy (bảng mục 7)
- [ ] **Đổi Redirect URI sang trang cầu nối https** khi rời Sandbox, và dán lại vào
      web admin: Cài đặt → TikTok → ô Redirect URI
- [ ] **Quay video demo** theo kịch bản mục 6
- [ ] Verify domain host ảnh trong URL properties (chỉ cần nếu đăng ảnh)

> **Cân nhắc chiến lược:** nếu muốn qua vòng đầu cho chắc, lần nộp đầu chỉ xin
> `user.info.basic` + `video.upload` (chế độ gửi vào nháp). Không phải qua audit
> UX của Direct Post, duyệt nhanh hơn nhiều. Xin `video.publish` ở lần sau, khi
> app đã có lịch sử sạch — lúc đó phần UI ở mục 4 đã sẵn sàng để đưa ra.
