# TikTok App Review & Audit — submission copy

Kịch bản: **công cụ nội bộ của một công ty**. Trưởng bộ phận marketing kết nối
các kênh TikTok *của công ty* một lần, rồi cấp quyền cho từng nhân viên đăng bài
qua hệ thống — nhân viên không bao giờ nhận mật khẩu tài khoản TikTok.

Bản tiếng Anh để dán thẳng vào form trên developers.tiktok.com. Mỗi mục ghi rõ
dán vào ô nào.

> Mọi thứ mô tả dưới đây **đã có trong app**. Việc còn lại ở [mục 10](#10-checklist).

---

## 1. Vì sao kịch bản này thuyết phục

Hai điều TikTok muốn thấy, kịch bản này đáp ứng tự nhiên:

**Có pháp nhân chịu trách nhiệm.** Không phải cá nhân ẩn danh chạy script, mà
một công ty đăng lên kênh của chính mình, nhân viên có hợp đồng, có người quản
lý. Khi có vấn đề, TikTok biết hỏi ai.

**Tích hợp API là cách *an toàn hơn*, không phải cách *nhanh hơn*.** Lý do dùng
API ở đây là bảo mật: không phát mật khẩu tài khoản TikTok cho 5–10 nhân viên.
Đây là lập luận mạnh nhất bạn có — nó cho thấy API giúp *giảm* rủi ro thay vì
giúp tăng sản lượng bài đăng.

**Điểm cần nói rõ:** TikTok để ý các hệ thống đăng bài thay cho tài khoản của
bên thứ ba (dịch vụ đăng bài, agency bán lại quyền truy cập). Về kỹ thuật thì
app nào đã audit và được authorize đều đăng được — đây là chuyện cam kết trong
đơn, không phải rào kỹ thuật. Nên mọi nội dung dưới đây đều nói rõ: **một công
ty, kênh do công ty sở hữu, nhân viên nội bộ, không có khách hàng bên ngoài,
không bán lại.** Đừng bỏ câu nào trong số đó.

---

## 2. App name

> **Content Studio Publisher**

Đừng nộp dưới tên có chữ "auto", "marketing automation", "bot", "mass" hay
"scheduler" — với reviewer chống spam, "auto marketing" đọc như công cụ đăng
hàng loạt.

Phần **Platform** chọn **Web** (hệ thống nội bộ chạy trên hạ tầng công ty).

---

## 3. App description (ô "Description")

Content Studio Publisher is an internal publishing tool used by one company —
ours — to post to the company's own TikTok accounts.

Our marketing department manages several TikTok accounts that belong to the
company. Before this tool, the only way to let a team member publish was to give
them the account password, which our information-security policy does not allow:
shared credentials cannot be revoked individually, cannot be scoped to one
account, and leave no record of who published what.

This tool removes that problem. A department administrator connects each
company-owned TikTok account once through TikTok's official OAuth screen. The
access tokens stay with the system, and team members sign in with their own
company account. They compose a post — caption, hashtags, and the video or images
our team produced — and publish it to the accounts they have been granted. They
never see, receive, or need the TikTok account credentials, and their access can
be revoked in one click when they change role or leave the company.

Every post is written by a member of our team and published by a named person, on
content we produced ourselves. The system records who published what, to which
account, and when. It has no content generation, no bulk import, no engagement
automation, and no way to reach an account outside our company.

---

## 4. Who uses it, and who owns the accounts

**Users:** employees of a single company — our own marketing team. Content
creators who draft and publish, and a department head who administers access and
connects the TikTok accounts.

**Accounts posted to:** TikTok accounts owned and operated by that same company.
Each is connected by the department head, who has authority to administer it,
through TikTok's OAuth consent screen. Only an administrator can connect an
account; team members have no way to add one.

**Not in scope, explicitly:** we do not publish for clients, partners, agencies,
influencers, or any account the company does not own. We do not offer this tool
to anyone outside the company, do not sell or resell access, and do not operate
it as a service on behalf of third parties. It runs on our own infrastructure for
our own staff.

---

## 5. Scope justifications (ô "Reason for requesting" từng scope)

### `user.info.basic`

Called once after an administrator authorizes an account, to read the display
name, username and avatar of the connected account. These appear in the account
list and on the publishing form, so the person composing a post can confirm which
company account they are about to publish to. With several similar brand
accounts, this is what prevents publishing to the wrong one. Stored only in our
own database, shown only inside the tool, never used for analytics, advertising,
profiling, or training any model.

### `video.upload`

Our default mode. The video is sent to the connected account's TikTok inbox as a
draft; a team member then reviews it in the TikTok app, adds sounds or effects,
and posts it. Nothing becomes visible on TikTok without an explicit action taken
inside TikTok's own app. This mode fits the review step in our editorial process.

### `video.publish`

For content already reviewed and approved internally. Before every direct post
the system calls `/v2/post/publish/creator_info/query/` and builds the publishing
form entirely from that response — see section 6. Publishing is always triggered
by a named employee pressing Publish on content our team produced. Nothing is
published on a schedule the person did not set, and nothing is published without
a person composing it first.

We request both because the mode is a per-post choice made by the person
publishing, not an app-wide setting.

---

## 6. UX compliance — how the publishing form is built

Dán vào phần mô tả chi tiết hoặc ô ghi chú. Đây là phần TikTok kiểm tra kỹ nhất
trong audit Direct Post:

Our TikTok publishing form is built from the live `creator_info` response, never
from hard-coded assumptions:

- **Account confirmation.** The connected account's avatar and nickname from
  `creator_info` appear at the top of the form, with a refresh control.

- **Viewership.** The selector lists only the values returned in
  `privacy_level_options`. Nothing is pre-selected: the form opens on
  "— Select who can view this —" and publishing is blocked with a clear message
  until the person chooses. A selection that is no longer available when
  publishing starts is rejected rather than silently changed.

- **Interaction settings.** The comment, Duet and Stitch controls are rendered
  disabled and forced on whenever `creator_info` reports `comment_disabled`,
  `duet_disabled` or `stitch_disabled`. The tool cannot re-enable something
  turned off at the account level.

- **Content disclosure.** A "Disclose commercial content" switch reveals "Your
  brand" (`brand_organic_toggle`) and "Branded content"
  (`brand_content_toggle`). Turning the switch on without choosing at least one
  blocks publishing. As a company posting our own brand's content, "Your brand"
  is our normal selection; our team is instructed to use "Branded content"
  whenever a third party has paid for a post.

- **Branded content cannot be private.** When "Branded content" is on,
  `SELF_ONLY` is removed from the viewership list and any previous `SELF_ONLY`
  selection is cleared. The API layer enforces the same rule again, for both
  video and photo posts.

- **Consent declaration.** Shown next to the publish controls: "By posting, you
  agree to TikTok's Music Usage Confirmation" — and, when Branded content is on,
  "...to TikTok's Branded Content Policy and Music Usage Confirmation", each
  linking to the official policy page.

- **Draft mode.** When "Send to drafts" (`MEDIA_UPLOAD`) is chosen, none of these
  settings are shown or sent: they are chosen inside the TikTok app by the person
  finishing the post.

An automated test suite locks each requirement above so it cannot be removed by a
later change.

---

## 7. Access control and accountability

Dán vào ô mô tả hệ thống, hoặc phần notes. Đây là phần trả lời thẳng câu hỏi
"nhiều người dùng chung thì ai chịu trách nhiệm":

Access to the TikTok accounts is controlled by the system, not by sharing
credentials:

- **Separate accounts.** Every team member signs in with their own username and
  password. Passwords are hashed with scrypt and never leave the server; a new
  member's initial password is shown to the administrator once, and they are
  asked to choose their own on first sign-in.

- **Per-account permissions.** An administrator grants each person the specific
  TikTok accounts they may post to. A person can also be limited to drafting
  only, so they prepare posts but cannot publish them.

- **Only administrators connect accounts.** Team members cannot add a TikTok
  account, change app credentials, or reach an account they were not granted.
  This is what keeps the set of accounts limited to those the company owns.

- **Revocation is immediate.** Disabling a person, changing their role, or
  removing a granted account takes effect at once — any open session ends on the
  spot. Disconnecting a TikTok account also removes it from everyone's
  permissions.

- **Enforced on the server.** Permissions are checked in the API on every
  request, not merely hidden in the interface. A request for an account the
  person was not granted is refused, and the refusal is recorded.

- **Audit log.** Every publish is recorded with the person, the TikTok account,
  the time and the outcome — successes and refusals alike. Sign-ins, account
  connections and permission changes are recorded too. This is the record our
  information-security policy requires and that shared credentials could never
  provide.

---

## 8. Anti-spam statement (dán vào "Notes to reviewer")

We would like to address the spam question directly, because a tool that lets
several people publish deserves the scrutiny:

**One company, its own accounts.**
Every TikTok account this tool touches is owned by the company that runs the
tool, and is connected by an administrator through TikTok's own OAuth screen.
There is no credential entry field, no account marketplace, no proxy pool, and no
tenant separation — because there is only one tenant: us. We do not publish for
clients and do not make the tool available outside the company.

**API access replaces shared passwords — it is a security control.**
We integrate with the API because our information-security policy forbids
distributing account credentials to staff. Before this tool, a team member needed
the TikTok password to publish. Now the credentials stay with the system, access
is granted per person and revoked in one click, and every publish is attributable
to a named employee. The integration takes the number of people holding account
credentials from "everyone who posts" to "nobody".

**Every post is composed by a person.**
Caption, hashtags and media are entered by hand, and the media is video or images
our team produced. There is no content generator, no template rotation, no
caption spinner, no scraper, no "repost trending content" feature, and no bulk
import. A dry-run control shows exactly what will be sent before anything reaches
TikTok.

**Scheduling spreads posts out; it does not multiply them.**
The optional queue exists so a post goes out at a sensible hour rather than when
it happened to be finished. It publishes strictly sequentially, one item per
scheduler tick, and has no repeat, no "post every N minutes", and no way to
enqueue variations of the same post.

**We respect TikTok's rate and safety limits by design.**
- `creator_info/query` runs before every direct post; a mismatched
  `privacy_level` is treated as a bug in our code, not something to retry.
- `rate_limit_exceeded`, `spam_risk_too_many_posts`,
  `spam_risk_too_many_pending_share` and `reached_active_user_cap` are handled
  with exponential backoff, never a retry loop.
- TikTok's per-creator daily limit is documented in our internal setup guide so
  our team does not design workflows that fight it.

**No engagement automation of any kind.**
The tool requests the minimum scopes needed to publish. It never follows,
unfollows, likes, comments, views, messages, or reads any other user's content.
It performs no analytics scraping and touches no account other than the company
accounts explicitly connected to it.

---

## 9. Audit application answers

Khi xin audit để bỏ giới hạn `SELF_ONLY`, TikTok hỏi về quy mô và cách kiểm soát
nội dung. **Trả lời thật** — con số phóng đại là tự tạo cờ đỏ, và TikTok thấy
được số creator đã authorize client key của bạn:

**Expected volume.** Around [ĐIỀN SỐ THẬT, ví dụ 5–15] posts per week across
[ĐIỀN SỐ] company accounts — one per finished piece of content. We are a
marketing department publishing our own campaigns, not a high-frequency
publisher.

**Number of TikTok accounts.** [ĐIỀN SỐ] accounts, all owned by the company. This
changes only when the company launches or retires a brand account.

**Number of people using the tool.** [ĐIỀN SỐ, ví dụ 5–10] employees. Access is
granted per person by the department head and revoked when someone changes role
or leaves.

**Where the content comes from.** Produced in-house — video shot or edited by us,
images we designed, captions written by the person publishing. We do not
republish other creators' content.

**How we keep content compliant.** Posts are reviewed internally before
publishing; team members can be limited to drafting so a manager publishes. The
publishing form surfaces TikTok's own requirements at the moment of publishing —
viewership options taken from the account, the commercial-content disclosure, and
the Music Usage Confirmation declaration — so the person publishing sees and
confirms them rather than a setting sitting in a config file. Every publish is
recorded with the person, the account, the time and the result.

**Why public viewership is required.** We publish marketing content for the
company's own brand accounts. `SELF_ONLY` posts are invisible to our audience, so
the unaudited restriction makes the integration unusable for its purpose.

---

## 10. Checklist

**Đã có trong app:**
- [x] Nhân viên đăng nhập bằng tài khoản riêng (mật khẩu băm bằng scrypt)
- [x] Phân quyền theo từng kênh, có mức "chỉ được soạn, không được đăng"
- [x] Thu hồi quyền tức thì — tắt tài khoản là phiên đang mở chết ngay
- [x] Audit log: ai đăng gì, lên kênh nào, lúc nào, kết quả (kể cả lần bị từ chối)
- [x] Quyền kiểm tra ở server, không chỉ ẩn trên giao diện
- [x] Chỉ admin kết nối được kênh và sửa được cấu hình app
- [x] Form đăng dựng từ `creator_info`, không hard-code viewership
- [x] Không chọn sẵn viewership, chặn đăng khi chưa chọn
- [x] Khoá comment/Duet/Stitch theo cài đặt tài khoản
- [x] Công tắc khai báo nội dung thương mại (cả hai loại)
- [x] Chặn branded content + `SELF_ONLY` ở cả UI và API layer
- [x] Tuyên bố đồng ý Music Usage Confirmation / Branded Content Policy
- [x] Giao diện hoàn toàn tiếng Anh
- [x] Backoff đúng trên các mã lỗi rate limit và spam risk

**Còn phải làm:**
- [ ] **Deploy thành web nội bộ có domain + HTTPS.** Hiện chạy `127.0.0.1`, một
      máy. Nhân viên phải truy cập được thì kịch bản mới đúng. Kèm một lợi ích:
      có HTTPS thật là vấn đề `redirect_uri` biến mất, không cần trang cầu nối.
- [ ] **Viết lại 3 trang tĩnh trong `docs/`** — xem phần dưới
- [ ] **Điền số thật vào mục 9** (số bài/tuần, số kênh, số người dùng)
- [ ] **Quay video demo** theo [mục 11](#11-kịch-bản-video-demo)
- [ ] Verify domain host ảnh trong URL properties (chỉ cần nếu đăng ảnh)

### Website, Terms of Service, Privacy Policy phải viết lại

Ba trang tĩnh trong `docs/` đang mô tả **kịch bản cũ** — công cụ desktop cho hoạ
sĩ cá nhân, tự host, *"everything stays on your own computer, we operate no
servers"*. Với kịch bản mới những câu đó **sai**: hệ thống do công ty vận hành,
dữ liệu nằm trên hạ tầng công ty, có nhiều người dùng.

Reviewer đọc các URL này. Trang web nói "for independent wallpaper artists" mà
form nộp nói "internal tool for our marketing department" là mâu thuẫn ngay
trước mắt họ.

- [`docs/index.html`](./index.html) — đổi thành trang giới thiệu hệ thống nội bộ
  của công ty (hoặc trang giới thiệu công ty kèm mô tả hệ thống)
- [`docs/terms.html`](./terms.html) — bỏ "one creator, one installation", đổi
  thành điều khoản sử dụng nội bộ cho nhân viên
- [`docs/privacy.html`](./privacy.html) — viết lại phần lưu trữ: dữ liệu nằm ở
  đâu, ai truy cập được, giữ bao lâu, nhân viên có quyền gì với dữ liệu của mình

---

## 11. Kịch bản video demo

Quay một lần, 2–3 phút, thuyết minh hoặc phụ đề tiếng Anh. Trọng tâm là **phân
quyền** — đó là thứ chứng minh câu chuyện của bạn.

1. **Đăng nhập bằng tài khoản một nhân viên.** Nói rõ: *"this is a team member's
   own login — they do not have the TikTok account password."*
2. **Cho thấy họ chỉ thấy những kênh được cấp**, và không có tab Team/Settings.
3. **Soạn bài:** caption, hashtag, kéo video *do team sản xuất* vào.
4. **Mở phần tuỳ chọn TikTok**, quay chậm từng thứ — reviewer tua lại đoạn này:
   - avatar + nickname lấy từ `creator_info`;
   - dropdown viewership đang ở *— Select who can view this —*, mở ra cho thấy
     chỉ có đúng giá trị tài khoản đó cho phép;
   - ô Duet/Stitch bị khoá nếu tài khoản đã tắt;
   - bật **Disclose commercial content** → hiện hai lựa chọn, bật *Branded
     content* → *Only me* biến mất khỏi danh sách;
   - dòng tuyên bố đồng ý đổi thành có thêm *Branded Content Policy*.
5. **Thử Publish khi chưa chọn viewership** → bị chặn kèm thông báo. Cảnh thuyết
   phục nhất trong cả video.
6. Chọn viewership → **Dry run** → cho thấy đúng payload sẽ gửi.
7. **Publish** → mở app TikTok trên điện thoại → bài đã lên đúng tài khoản, đúng
   viewership.
8. **Đăng nhập lại bằng admin** → mở **Audit log**: ai đăng bài nào, lên kênh
   nào, lúc nào. Rồi vào **Team** bỏ quyền kênh đó của nhân viên, quay lại tài
   khoản nhân viên cho thấy kênh đã biến mất.
9. Kết: trong Channels bấm **Disconnect** — công ty thu hồi quyền của app bất cứ
   lúc nào.

Đừng quay cảnh đăng nhiều bài liên tiếp, và đừng quay cảnh nhập mật khẩu TikTok
vào hệ thống — hệ thống không có chỗ nào làm việc đó, và đó chính là điểm mạnh.

---

## 12. Các URL cần điền

| Ô trong form TikTok | Giá trị |
|---|---|
| Website URL | URL trang giới thiệu (sau khi viết lại) |
| Terms of Service URL | `.../terms.html` |
| Privacy Policy URL | `.../privacy.html` |
| Redirect URI | `https://<domain-noi-bo>/oauth/tiktok/callback` |

Sandbox nhận `http://127.0.0.1`, app production thì TikTok đòi `https` — chi
tiết trong
[setup-tiktok-telegram.md](./setup-tiktok-telegram.md#2-redirect-uri-sandbox-nhận-http-production-đòi-https).

> **Chiến lược nộp:** muốn chắc ăn thì vòng đầu chỉ xin `user.info.basic` +
> `video.upload` (gửi nháp, nhân viên hoàn tất trong app TikTok). Không phải qua
> audit UX của Direct Post, duyệt nhanh hơn nhiều. Xin `video.publish` và audit
> bỏ `SELF_ONLY` ở vòng sau, khi app đã có lịch sử sạch — lúc đó phần UI ở mục 6
> đã sẵn sàng để đưa ra.
