/**
 * S3MediaHost: upload file len S3 / R2 / MinIO / DigitalOcean Spaces bang AWS SigV4.
 * Tu ky bang `node:crypto`, KHONG can @aws-sdk (giu module zero-dependency).
 */

import crypto from 'node:crypto';
import { ConfigError, MediaError, PlatformError } from '../errors.js';
import { slugify } from '../text.js';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

export class S3MediaHost {
  /**
   * @param {object} opts
   * @param {string} opts.bucket
   * @param {string} opts.accessKeyId
   * @param {string} opts.secretAccessKey
   * @param {string} [opts.region='auto']
   * @param {string} [opts.endpoint] Vd 'https://<account>.r2.cloudflarestorage.com' hoac 'http://127.0.0.1:9000'.
   *   Bo trong -> dung AWS S3 (`https://<bucket>.s3.<region>.amazonaws.com`).
   * @param {boolean} [opts.forcePathStyle] MinIO/R2 thuong can true.
   * @param {string} [opts.publicBaseUrl] Domain cong khai de doc file (CDN). Bo trong -> dung chinh endpoint.
   * @param {string} [opts.prefix='wam/'] Tien to key.
   * @param {string} [opts.acl='public-read'] Dat '' de khong gui header ACL (R2 khong ho tro ACL).
   * @param {boolean} [opts.deleteAfterPost=true] Xoa object sau khi dang xong.
   * @param {number} [opts.streamThresholdBytes=100*1024*1024]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {import('../logger.js').Logger} [opts.logger]
   */
  constructor(opts) {
    const { bucket, accessKeyId, secretAccessKey } = opts ?? {};
    if (!bucket) throw new ConfigError('S3MediaHost: thieu `bucket`');
    if (!accessKeyId || !secretAccessKey) throw new ConfigError('S3MediaHost: thieu `accessKeyId`/`secretAccessKey`');

    this.name = 's3';
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = opts.region ?? 'auto';
    this.endpoint = opts.endpoint?.replace(/\/+$/, '');
    this.forcePathStyle = opts.forcePathStyle ?? Boolean(opts.endpoint);
    this.publicBaseUrl = opts.publicBaseUrl?.replace(/\/+$/, '');
    this.prefix = opts.prefix ?? 'wam/';
    this.acl = opts.acl === undefined ? 'public-read' : opts.acl;
    this.deleteAfterPost = opts.deleteAfterPost ?? true;
    this.streamThresholdBytes = opts.streamThresholdBytes ?? 100 * 1024 * 1024;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.logger = opts.logger;
  }

  /**
   * @param {import('../media.js').Media} media
   * @param {object} [ctx]
   * @param {string} [ctx.keyHint] Goi y ten file (vd title cua bai dang).
   * @param {AbortSignal} [ctx.signal]
   * @returns {Promise<import('./index.js').HostedMedia>}
   */
  async host(media, ctx = {}) {
    await media.load();
    const key = this._buildKey(media, ctx.keyHint);
    const { url: signedUrl, headers } = this._signPut(key, media);

    const size = media.size ?? 0;
    /** @type {BodyInit} */
    let body;
    if (size > 0 && size <= this.streamThresholdBytes) {
      body = await media.toBuffer();
    } else {
      // File lon: stream de khong nap het vao RAM.
      const stream = await media.toStream();
      const { Readable } = await import('node:stream');
      body = stream instanceof Readable ? Readable.toWeb(stream) : stream;
    }

    const res = await this.fetchImpl(signedUrl, {
      method: 'PUT',
      headers: { ...headers, 'content-length': String(size) },
      body,
      signal: ctx.signal,
      ...(typeof body === 'object' && body !== null && 'getReader' in body ? { duplex: 'half' } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PlatformError(`S3 upload that bai (HTTP ${res.status}): ${text.slice(0, 400)}`, {
        httpStatus: res.status,
        retryable: res.status >= 500 || res.status === 429,
        details: { key, bucket: this.bucket },
      });
    }

    const publicUrl = this._publicUrl(key);
    this.logger?.debug('media uploaded to s3', { key, size, publicUrl });

    return {
      url: publicUrl,
      cleanup: this.deleteAfterPost ? () => this._delete(key) : undefined,
    };
  }

  /** @param {string} key */
  async _delete(key) {
    try {
      const { url, headers } = this._sign('DELETE', key, { payloadHash: EMPTY_SHA256 });
      const res = await this.fetchImpl(url, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) {
        this.logger?.warn('could not delete the temporary object on S3', { key, status: res.status });
      } else {
        this.logger?.debug('temporary object deleted from S3', { key });
      }
      await res.arrayBuffer().catch(() => {});
    } catch (err) {
      this.logger?.warn('error deleting the temporary object on S3', { key, error: String(err) });
    }
  }

  /**
   * @param {import('../media.js').Media} media
   * @param {string} [hint]
   */
  _buildKey(media, hint) {
    const ext = media.extension || '.bin';
    const rand = crypto.randomBytes(6).toString('hex');
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const base = slugify(hint ?? media.filename?.replace(/\.[^.]+$/, '') ?? 'media', 40);
    return `${this.prefix}${stamp}/${base}-${rand}${ext}`;
  }

  /** @param {string} key */
  _publicUrl(key) {
    const encoded = encodeKey(key);
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/${encoded}`;
    const { host, basePath } = this._hostAndPath();
    return `https://${host}${basePath}/${encoded}`;
  }

  _hostAndPath() {
    if (this.endpoint) {
      const u = new URL(this.endpoint);
      return {
        protocol: u.protocol,
        host: u.host,
        basePath: this.forcePathStyle ? `/${this.bucket}` : '',
        hostPrefixed: this.forcePathStyle ? u.host : `${this.bucket}.${u.host}`,
      };
    }
    const host = this.region === 'us-east-1' || this.region === 'auto'
      ? `${this.bucket}.s3.amazonaws.com`
      : `${this.bucket}.s3.${this.region}.amazonaws.com`;
    return { protocol: 'https:', host, basePath: '', hostPrefixed: host };
  }

  /**
   * @param {string} key
   * @param {import('../media.js').Media} media
   */
  _signPut(key, media) {
    /** @type {Record<string,string>} */
    const extra = { 'content-type': media.mime ?? 'application/octet-stream' };
    if (this.acl) extra['x-amz-acl'] = this.acl;
    return this._sign('PUT', key, { extraHeaders: extra, payloadHash: 'UNSIGNED-PAYLOAD' });
  }

  /**
   * Ky request SigV4.
   * @param {string} method
   * @param {string} key
   * @param {object} [opts]
   * @param {Record<string,string>} [opts.extraHeaders]
   * @param {string} [opts.payloadHash]
   * @returns {{url: string, headers: Record<string,string>}}
   */
  _sign(method, key, opts = {}) {
    const { extraHeaders = {}, payloadHash = 'UNSIGNED-PAYLOAD' } = opts;
    const ep = this._hostAndPath();
    const hostHeader = this.endpoint
      ? (this.forcePathStyle ? ep.host : `${this.bucket}.${ep.host}`)
      : ep.host;
    const canonicalUri = this.endpoint && this.forcePathStyle
      ? `/${this.bucket}/${encodeKey(key)}`
      : `/${encodeKey(key)}`;

    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20240101T000000Z
    const dateStamp = amzDate.slice(0, 8);

    /** @type {Record<string,string>} */
    const headers = {
      host: hostHeader,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...lower(extraHeaders),
    };

    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
    const signedHeaders = sortedKeys.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      '', // khong dung query
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/${SERVICE}/aws4_request`;
    const stringToSign = [
      ALGORITHM,
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = getSignatureKey(this.secretAccessKey, dateStamp, this.region, SERVICE);
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    headers.authorization = `${ALGORITHM} Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete headers.host; // fetch tu set Host

    const protocol = this.endpoint ? new URL(this.endpoint).protocol : 'https:';
    return { url: `${protocol}//${hostHeader}${canonicalUri}`, headers };
  }
}

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** Encode key theo chuan S3: giu '/', encode phan con lai. */
function encodeKey(key) {
  return String(key)
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

function lower(obj) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v == null) continue;
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

export { MediaError };
