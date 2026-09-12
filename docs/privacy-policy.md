# Privacy Policy — Wallpaper Studio Publisher

**Last updated: 12 September 2026**

Wallpaper Studio Publisher ("the app") is a self-hosted desktop application. You
download it, you run it on your own computer, and it stores everything on that
computer. There is no account to create with us, no server of ours that your
data passes through, and no analytics.

This policy explains exactly what the app touches, because "we don't collect
anything" is a claim that deserves specifics.

---

## 1. Who is responsible for your data

You are. The app runs entirely on hardware you control. We — the authors of the
app — operate no servers, receive no telemetry, and have no ability to access
your installation, your accounts, or your content.

If you distribute a modified copy of the app to other people, you become
responsible for whatever your modified copy does.

---

## 2. What the app stores, and where

Everything lives in a single `data/` directory next to the app on your computer
(overridable with the `WAM_DATA_DIR` environment variable):

| File | Contents |
|---|---|
| `data/tokens.json` | OAuth access tokens and refresh tokens for the accounts you connected |
| `data/channels.json` | Connected account names, usernames, avatar URLs, platform IDs |
| `data/posts.json` | Posts you composed: titles, captions, hashtags, publishing options and results |
| `data/media/` | Image and video files you added to posts |
| `data/settings.json` | Your app credentials (client keys/secrets) and preferences |

None of these files is transmitted anywhere. They are read and written by the
app process running on your machine. Deleting the `data/` directory erases
everything the app knows.

---

## 3. TikTok data specifically

When you connect a TikTok account, the app uses TikTok's official OAuth flow.
You authorize on tiktok.com; the app never sees your TikTok password.

**Scopes the app requests and what it does with each:**

- **`user.info.basic`** — the app reads your display name, username and avatar
  once after you authorize, and shows them in the Channels screen so you can
  confirm which account is connected. Stored in `data/channels.json` on your
  machine. Not used for analytics, advertising, profiling, or training any
  model.

- **`video.upload`** — used to send a video to your TikTok inbox as a draft.
  You complete and publish it yourself inside the TikTok app.

- **`video.publish`** — used to publish a post you composed, when you choose
  "Publish directly" and press Publish. Before each direct post the app calls
  TikTok's `creator_info` endpoint to read your current posting settings
  (available privacy levels, whether you have comments/Duet/Stitch disabled,
  your maximum video duration). This response is used only to build the
  publishing form correctly and is not stored after the post completes.

**What the app sends to TikTok:** only the post you composed — your media file,
your caption, your hashtags, and the publishing settings you selected in the
form.

**What the app never does:** it does not read your videos, your followers, your
comments, your messages, your analytics, or any other user's content. It does
not follow, like, comment, view or message on your behalf. It has no access to
anyone's account but the one you connected.

**Revoking access:** disconnect the channel in the app's Channels screen, or
remove the app under Settings → Security & permissions → Apps in TikTok.
Disconnecting in the app deletes that account's tokens from `data/tokens.json`.

**Retention:** tokens live on your disk until you disconnect the channel or
delete the file. Posts and media stay until you delete them in the app. Because
we never receive this data, we cannot retain it and cannot delete it for you.

---

## 4. Other connected platforms

The same model applies to YouTube, Facebook, Instagram and Telegram: the app
holds the credentials you give it locally and talks to each platform's official
API directly from your machine. Each platform's own privacy policy governs what
that platform does with what you publish.

---

## 5. Media hosting (optional)

Instagram and TikTok cannot accept a photo as a file upload — their APIs only
accept a publicly reachable URL. If you publish photos to those platforms, you
must configure a media host (your own S3-compatible bucket, or a local tunnel).
In that case the app uploads the photo to **your** storage, gives the platform
that URL, and deletes the temporary file afterwards. We do not operate or see
that storage. If you do not configure a media host, the app refuses the post
with an explanatory error rather than sending your files anywhere unexpected.

---

## 6. Network connections the app makes

The app connects only to:

- the official API endpoints of the platforms you connected
  (`open.tiktokapis.com`, `graph.facebook.com`, `googleapis.com`,
  `api.telegram.org`), and
- your own media host, if you configured one.

It contacts no analytics service, no error-reporting service, and no server
belonging to us. It does not check for updates. Its web interface binds to
`127.0.0.1` — the loopback interface — so it is not reachable from your network
unless you deliberately reconfigure it.

---

## 7. Children

The app is a professional publishing tool and is not directed at children. It
is not intended for anyone under the minimum age required by the platforms it
connects to.

---

## 8. Changes to this policy

Material changes will be published in this file in the app's repository, with
the "Last updated" date above revised. Since the app does not phone home, we
cannot notify you directly — check the repository.

---

## 9. Contact

Questions about this policy: open an issue in the app's public repository, or
write to the contact address listed in the repository's README.
