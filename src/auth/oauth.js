/**
 * OAuth "connect channel" - giong cach Buffer ket noi kenh:
 * nguoi dung bam "Ket noi", duoc chuyen sang trang cap quyen cua nen tang,
 * quay lai callback, server doi code -> token va luu thanh CHANNEL.
 *
 * Ho tro:
 *  - google   -> YouTube channel
 *  - facebook -> Facebook Page(s) + Instagram Business account(s) lien ket
 *  - tiktok   -> TikTok account
 *  - telegram -> khong co OAuth, ket noi bang bot token (xem connectTelegram)
 */

import crypto from 'node:crypto';
import { AuthError, ConfigError, PlatformError } from '../core/errors.js';
import { HttpClient } from '../core/http.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const FB_GRAPH = 'https://graph.facebook.com';
const FB_DIALOG = 'https://www.facebook.com';
const TIKTOK_AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';

/** Scope toi thieu de dang bai. */
export const OAUTH_SCOPES = {
  google: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],
  facebook: [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'instagram_basic',
    'instagram_content_publish',
  ],
  tiktok: ['user.info.basic', 'video.publish', 'video.upload'],
};

/** Mo ta tung provider cho UI. */
export const OAUTH_PROVIDERS = {
  google: {
    id: 'google',
    label: 'YouTube (Google)',
    platforms: ['youtube'],
    credentialFields: [
      { key: 'clientId', label: 'Client ID', required: true },
      { key: 'clientSecret', label: 'Client Secret', required: true, secret: true },
      { key: 'redirectUri', label: 'Redirect URI (để trống = tự suy ra từ địa chỉ web admin)', hint: true },
    ],
    scopes: OAUTH_SCOPES.google,
    setupHint: 'Google Cloud Console > APIs & Services: bat "YouTube Data API v3", tao OAuth Client ID (Web application), '
      + 'them Authorized redirect URI dung bang URL callback ben duoi. LUU Y: app o che do Testing thi refresh token het han sau 7 ngay.',
  },
  facebook: {
    id: 'facebook',
    label: 'Facebook Page + Instagram',
    platforms: ['facebook', 'instagram'],
    credentialFields: [
      { key: 'appId', label: 'App ID', required: true },
      { key: 'appSecret', label: 'App Secret', required: true, secret: true },
      { key: 'redirectUri', label: 'Redirect URI (để trống = tự suy ra từ địa chỉ web admin)', hint: true },
    ],
    scopes: OAUTH_SCOPES.facebook,
    setupHint: 'developers.facebook.com > App > Facebook Login: them Valid OAuth Redirect URI dung bang URL callback. '
      + 'Instagram phai la tai khoan Business/Creator va da lien ket voi Page. Cac quyen nay can App Review khi dung cho nguoi ngoai.',
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    platforms: ['tiktok'],
    credentialFields: [
      { key: 'clientKey', label: 'Client Key', required: true },
      { key: 'clientSecret', label: 'Client Secret', required: true, secret: true },
      { key: 'redirectUri', label: 'Redirect URI (de trong = dung dia chi web admin)', hint: true },
      // App chua audit chi dang duoc SELF_ONLY -> UI dua vao co nay de khoi
      // moi nguoi dung chon che do chac chan bi tu choi.
      { key: 'audited', label: 'App da qua audit cua TikTok (cho dang cong khai)', type: 'boolean' },
    ],
    scopes: OAUTH_SCOPES.tiktok,
    // Sandbox nhan http/localhost; app production thi TikTok doi https -> luc do
    // dat redirectUri tro toi trang cau noi https (docs/oauth-bridge).
    setupHint: 'developers.tiktok.com > App: bat san pham "Content Posting API", them Redirect URI dung bang URL callback. '
      + 'App o che do Sandbox nhan ca http://127.0.0.1; khi chuyen sang production TikTok doi https - '
      + 'luc do dung trang cau noi https (xem docs/setup-tiktok-telegram.md). '
      + 'App CHUA duoc audit chi dang duoc che do SELF_ONLY (rieng tu).',
  },
};

/**
 * Quan ly luong OAuth: tao URL cap quyen, giu `state`, doi code -> channel.
 */
export class OAuthManager {
  /**
   * @param {object} opts
   * @param {() => Promise<Record<string, any>>} opts.getCredentials Doc credentials tu settings.
   * @param {HttpClient} [opts.http]
   * @param {import('../core/logger.js').Logger} [opts.logger]
   * @param {number} [opts.stateTtlMs=600000]
   */
  constructor(opts) {
    this.getCredentials = opts.getCredentials;
    this.http = opts.http ?? new HttpClient({ logger: opts.logger });
    this.logger = opts.logger;
    this.stateTtlMs = opts.stateTtlMs ?? 10 * 60_000;
    /** @type {Map<string, {provider: string, redirectUri: string, codeVerifier?: string, createdAt: number, returnTo?: string}>} */
    this.pending = new Map();
  }

  /** Xoa state qua han. */
  _gc() {
    const cutoff = Date.now() - this.stateTtlMs;
    for (const [k, v] of this.pending) {
      if (v.createdAt < cutoff) this.pending.delete(k);
    }
  }

  /**
   * Tao URL cap quyen.
   * @param {string} provider
   * @param {object} opts
   * @param {string} opts.redirectUri Phai khop chinh xac voi cai dang ky tren nen tang.
   * @param {string} [opts.returnTo]
   * @param {{id: string, username: string}} [opts.actor] Nguoi bam "Ket noi" -
   *   giu lai de callback ghi dung actor vao audit log.
   * @returns {Promise<{url: string, state: string}>}
   */
  async createAuthUrl(provider, opts) {
    this._gc();
    const p = OAUTH_PROVIDERS[provider];
    if (!p) throw new ConfigError(`Khong ho tro OAuth provider '${provider}'`);

    const creds = (await this.getCredentials())?.[provider] ?? {};
    const missing = p.credentialFields.filter((f) => f.required && !creds[f.key]).map((f) => f.label);
    if (missing.length > 0) {
      throw new ConfigError(
        `Chua cau hinh ${p.label}: thieu ${missing.join(', ')}`,
        { hint: 'Vao tab "Cai dat" de nhap thong tin app OAuth.' },
      );
    }

    // Khong chan redirect_uri theo scheme o day.
    //
    // Tai lieu Login Kit ghi "URIs must be absolute and begin with https", nhung
    // app o che do SANDBOX cua TikTok nhan ca http va localhost - da kiem chung
    // thuc te. Chan cung se lam sandbox khong dung duoc.
    //
    // Nen tang tu quyet dinh: sai scheme thi TikTok tra ve loi redirect_uri ngay
    // o man hinh cap quyen.

    const state = crypto.randomBytes(24).toString('base64url');
    /** @type {string} */
    let url;
    /** @type {string | undefined} */
    let codeVerifier;

    if (provider === 'google') {
      url = buildUrl(GOOGLE_AUTH, {
        client_id: creds.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope: p.scopes.join(' '),
        // BAT BUOC de nhan refresh_token.
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      });
    } else if (provider === 'facebook') {
      const version = creds.graphVersion ?? 'v26.0';
      url = buildUrl(`${FB_DIALOG}/${version}/dialog/oauth`, {
        client_id: creds.appId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope: p.scopes.join(','),
        state,
      });
    } else {
      // TikTok: scope phan cach bang DAU PHAY, ho tro PKCE.
      codeVerifier = crypto.randomBytes(48).toString('base64url');
      const challenge = crypto.createHash('sha256').update(codeVerifier).digest('hex');
      url = buildUrl(TIKTOK_AUTH, {
        client_key: creds.clientKey,
        scope: p.scopes.join(','),
        response_type: 'code',
        redirect_uri: opts.redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    }

    this.pending.set(state, {
      provider,
      redirectUri: opts.redirectUri,
      actor: opts.actor,
      codeVerifier,
      createdAt: Date.now(),
      returnTo: opts.returnTo,
    });
    return { url, state };
  }

  /**
   * Xu ly callback: doi code -> token -> danh sach kenh de luu.
   * @param {object} opts
   * @param {string} opts.state
   * @param {string} opts.code
   * @returns {Promise<{provider: string, channels: Array<{platform: string, name: string, username?: string, avatar?: string, externalId?: string, config: Record<string, any>, authProvider: string}>, returnTo?: string}>}
   */
  async handleCallback(opts) {
    this._gc();
    const entry = this.pending.get(opts.state);
    if (!entry) {
      throw new AuthError('State khong hop le hoac da het han. Hay bam "Ket noi" lai.', {
        hint: 'State song 10 phut. Cung khong duoc mo lai link callback cu.',
      });
    }
    this.pending.delete(opts.state);

    const creds = (await this.getCredentials())?.[entry.provider] ?? {};
    const channels = entry.provider === 'google'
      ? await this._connectGoogle(creds, opts.code, entry)
      : entry.provider === 'facebook'
        ? await this._connectFacebook(creds, opts.code, entry)
        : await this._connectTikTok(creds, opts.code, entry);

    return { provider: entry.provider, channels, returnTo: entry.returnTo, actor: entry.actor };
  }

  // ------------------------------------------------------------------ google

  async _connectGoogle(creds, code, entry) {
    const token = await this.http.request(GOOGLE_TOKEN, {
      method: 'POST',
      form: {
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: entry.redirectUri,
        grant_type: 'authorization_code',
      },
      throwOnError: false,
    });
    if (!token.ok || !token.data?.access_token) {
      throw new AuthError(
        `Google tu choi doi code: ${token.data?.error ?? token.status} ${token.data?.error_description ?? ''}`,
        { details: token.data, hint: 'Kiem tra redirect URI da khai bao trong Google Cloud Console co khop chinh xac.' },
      );
    }
    if (!token.data.refresh_token) {
      throw new AuthError(
        'Google khong tra ve refresh_token nen khong the dang bai tu dong lau dai.',
        {
          hint: 'Can access_type=offline va prompt=consent. Neu ban da cap quyen truoc do, '
            + 'hay vao myaccount.google.com/permissions xoa quyen cua app roi ket noi lai.',
        },
      );
    }

    // Lay thong tin channel YouTube de hien thi.
    const info = await this.http.request('https://www.googleapis.com/youtube/v3/channels', {
      method: 'GET',
      query: { part: 'snippet,contentDetails', mine: 'true' },
      headers: { authorization: `Bearer ${token.data.access_token}` },
      throwOnError: false,
    });
    const ch = info.data?.items?.[0];
    if (!ch) {
      throw new PlatformError('Tai khoan Google nay chua co channel YouTube', {
        platform: 'youtube',
        hint: 'Tao channel tai youtube.com roi ket noi lai.',
      });
    }

    return [{
      platform: 'youtube',
      name: ch.snippet?.title ?? 'YouTube channel',
      username: ch.snippet?.customUrl,
      avatar: ch.snippet?.thumbnails?.default?.url,
      externalId: ch.id,
      authProvider: 'google',
      config: {
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: token.data.refresh_token,
        accessToken: token.data.access_token,
      },
    }];
  }

  // ---------------------------------------------------------------- facebook

  async _connectFacebook(creds, code, entry) {
    const version = creds.graphVersion ?? 'v26.0';

    // B1: code -> user token ngan han
    const short = await this.http.request(`${FB_GRAPH}/${version}/oauth/access_token`, {
      method: 'GET',
      query: {
        client_id: creds.appId,
        client_secret: creds.appSecret,
        redirect_uri: entry.redirectUri,
        code,
      },
      throwOnError: false,
    });
    if (!short.ok || !short.data?.access_token) {
      throw new AuthError(
        `Facebook tu choi doi code: ${short.data?.error?.message ?? short.status}`,
        { details: short.data, hint: 'Kiem tra Valid OAuth Redirect URI trong cai dat Facebook Login.' },
      );
    }

    // B2: doi sang user token DAI HAN -> day la buoc quyet dinh de Page token khong het han.
    const long = await this.http.request(`${FB_GRAPH}/${version}/oauth/access_token`, {
      method: 'GET',
      query: {
        grant_type: 'fb_exchange_token',
        client_id: creds.appId,
        client_secret: creds.appSecret,
        fb_exchange_token: short.data.access_token,
      },
      throwOnError: false,
    });
    const userToken = long.data?.access_token ?? short.data.access_token;
    if (!long.data?.access_token) {
      this.logger?.warn('khong doi duoc user token dai han - Page token co the het han sau 1-2 gio');
    }

    // B3: liet ke Page + IG account lien ket
    const pages = await this.http.request(`${FB_GRAPH}/${version}/me/accounts`, {
      method: 'GET',
      query: {
        access_token: userToken,
        fields: 'id,name,username,access_token,tasks,picture{url},instagram_business_account{id,username,profile_picture_url,name}',
        limit: 100,
      },
      throwOnError: false,
    });
    if (!pages.ok || !Array.isArray(pages.data?.data)) {
      throw new AuthError(
        `Khong lay duoc danh sach Page: ${pages.data?.error?.message ?? pages.status}`,
        { details: pages.data, hint: 'Can quyen pages_show_list va user phai co role tren Page.' },
      );
    }
    if (pages.data.data.length === 0) {
      throw new AuthError('Tai khoan nay khong quan ly Page nao', {
        hint: 'Tao Facebook Page hoac yeu cau duoc cap role tren Page.',
      });
    }

    /** @type {any[]} */
    const channels = [];
    for (const page of pages.data.data) {
      const canPost = !Array.isArray(page.tasks) || page.tasks.includes('CREATE_CONTENT');
      channels.push({
        platform: 'facebook',
        name: page.name,
        username: page.username,
        avatar: page.picture?.data?.url,
        externalId: page.id,
        authProvider: 'facebook',
        warning: canPost ? undefined : 'Thieu quyen CREATE_CONTENT tren Page nay',
        config: {
          pageId: page.id,
          pageAccessToken: page.access_token,
          appSecret: creds.appSecret,
          graphVersion: version,
          userAccessToken: userToken,
          appId: creds.appId,
        },
      });

      const ig = page.instagram_business_account;
      if (ig?.id) {
        channels.push({
          platform: 'instagram',
          name: ig.name ?? ig.username ?? `IG cua ${page.name}`,
          username: ig.username,
          avatar: ig.profile_picture_url,
          externalId: ig.id,
          authProvider: 'facebook',
          config: {
            igUserId: ig.id,
            // IG publishing nen dung PAGE token.
            accessToken: page.access_token,
            graphVersion: version,
            useInstagramLogin: false,
          },
        });
      }
    }
    return channels;
  }

  // ------------------------------------------------------------------ tiktok

  async _connectTikTok(creds, code, entry) {
    // Credentials copy tay rat hay dinh khoang trang/xuong dong o dau-cuoi.
    // TikTok tra ve 'invalid_request: The request parameters are malformed.'
    // chu khong noi field nao sai -> trim o day de khoi phai doan.
    const clientKey = String(creds.clientKey ?? '').trim();
    const clientSecret = String(creds.clientSecret ?? '').trim();
    // `code` da duoc URLSearchParams decode san (docs yeu cau gui ban da decode).
    const authCode = String(code ?? '').trim();

    const token = await this.http.request(TIKTOK_TOKEN, {
      method: 'POST',
      headers: {
        'cache-control': 'no-cache',
        // Dung CHINH XAC nhu docs: endpoint nay tu choi khi co them '; charset=utf-8'.
        'content-type': 'application/x-www-form-urlencoded',
      },
      form: {
        client_key: clientKey,
        client_secret: clientSecret,
        code: authCode,
        grant_type: 'authorization_code',
        redirect_uri: entry.redirectUri,
        ...(entry.codeVerifier ? { code_verifier: entry.codeVerifier } : {}),
      },
      throwOnError: false,
    });
    if (!token.ok || !token.data?.access_token) {
      throw new AuthError(
        `TikTok tu choi doi code: ${token.data?.error ?? token.status} ${token.data?.error_description ?? ''}`,
        {
          details: token.data,
          // TikTok khong noi field nao sai -> in ra du lieu doi chieu duoc.
          hint: 'Doi chieu: redirect_uri vua gui la '
            + `'${entry.redirectUri}' - phai TRUNG TUNG KY TU voi Redirect URI khai bao `
            + `trong app TikTok. client_key dang dung: '${clientKey}'. `
            + `PKCE: ${entry.codeVerifier ? 'co gui code_verifier' : 'KHONG gui code_verifier'}. `
            + `${token.data?.log_id ? `log_id=${token.data.log_id} (dua ma nay cho TikTok support). ` : ''}`
            + 'Neu client_key/secret vua copy lai thi luu lai trong tab Cai dat roi thu lai.',
        },
      );
    }

    const granted = String(token.data.scope ?? '').split(',').map((s) => s.trim());
    if (!granted.includes('video.publish') && !granted.includes('video.upload')) {
      throw new AuthError(
        `Nguoi dung chua cap quyen dang bai (scope duoc cap: ${granted.join(', ') || 'khong co'})`,
        { hint: 'Can video.publish (dang truc tiep) hoac video.upload (dang draft).' },
      );
    }

    // Lay ten/avatar de hien thi (can scope user.info.basic).
    let profile = {};
    const info = await this.http.request('https://open.tiktokapis.com/v2/user/info/', {
      method: 'GET',
      query: { fields: 'open_id,union_id,display_name,avatar_url,username' },
      headers: { authorization: `Bearer ${token.data.access_token}` },
      throwOnError: false,
    });
    if (info.ok && info.data?.data?.user) profile = info.data.data.user;

    return [{
      platform: 'tiktok',
      name: profile.display_name ?? profile.username ?? 'TikTok account',
      username: profile.username,
      avatar: profile.avatar_url,
      externalId: token.data.open_id ?? profile.open_id,
      authProvider: 'tiktok',
      config: {
        clientKey: creds.clientKey,
        clientSecret: creds.clientSecret,
        refreshToken: token.data.refresh_token,
        accessToken: token.data.access_token,
        // App chua audit chi dang duoc SELF_ONLY.
        privacyLevel: granted.includes('video.publish') ? 'SELF_ONLY' : undefined,
        postMode: granted.includes('video.publish') ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
      },
    }];
  }
}

/**
 * Telegram khong co OAuth: ket noi bang bot token + chat id, va kiem tra quyen admin.
 *
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {string} opts.chatId
 * @param {HttpClient} [opts.http]
 * @returns {Promise<{platform: string, name: string, username?: string, externalId?: string, config: Record<string, any>, authProvider: string}>}
 */
export async function connectTelegram(opts) {
  const http = opts.http ?? new HttpClient();
  const botToken = String(opts.botToken ?? '').trim();
  const chatId = String(opts.chatId ?? '').trim();
  if (!botToken || !chatId) {
    throw new ConfigError('Can nhap ca bot token va chat id');
  }
  const base = `https://api.telegram.org/bot${botToken}`;

  const me = await http.request(`${base}/getMe`, { method: 'GET', throwOnError: false });
  if (!me.ok || me.data?.ok !== true) {
    throw new AuthError(`Bot token khong hop le: ${me.data?.description ?? me.status}`, {
      platform: 'telegram',
      hint: 'Lay token tu @BotFather.',
    });
  }

  const chat = await http.request(`${base}/getChat`, {
    method: 'GET',
    query: { chat_id: chatId },
    throwOnError: false,
  });
  if (!chat.ok || chat.data?.ok !== true) {
    throw new AuthError(`Khong tim thay chat: ${chat.data?.description ?? chat.status}`, {
      platform: 'telegram',
      hint: 'Channel public dung @tenchannel; channel private dung id dang -100xxxxxxxxxx. '
        + 'Bot phai da duoc them vao channel.',
    });
  }

  const member = await http.request(`${base}/getChatMember`, {
    method: 'GET',
    query: { chat_id: chatId, user_id: me.data.result.id },
    throwOnError: false,
  });
  const status = member.data?.result?.status;
  const isChannel = chat.data.result?.type === 'channel';
  const canPost = status === 'creator'
    || (status === 'administrator' && (!isChannel || member.data?.result?.can_post_messages === true));
  if (!canPost) {
    throw new AuthError(
      `Bot chua co quyen dang bai (trang thai: ${status ?? 'khong ro'})`,
      {
        platform: 'telegram',
        hint: isChannel
          ? 'Them bot lam ADMIN cua channel va bat quyen "Post Messages".'
          : 'Cap quyen gui tin nhan cho bot trong group.',
      },
    );
  }

  const result = chat.data.result;
  return {
    platform: 'telegram',
    // Luu id dang so de khong bi vo khi chu channel doi username.
    name: result.title ?? result.username ?? chatId,
    username: result.username,
    externalId: String(result.id),
    authProvider: 'manual',
    config: {
      botToken,
      chatId: String(result.id),
      parseMode: 'HTML',
    },
  };
}

/**
 * @param {string} base
 * @param {Record<string, any>} params
 */
function buildUrl(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}
