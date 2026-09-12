/**
 * Xu ly text: hashtag, caption, cat chuoi an toan, escape cho Telegram.
 */

/** Ky tu KHONG hop le trong hashtag (giu chu, so, gach duoi). */
const HASHTAG_STRIP_RE = /[^\p{L}\p{N}_]+/gu;

/**
 * Chuan hoa danh sach hashtag.
 *
 * Quy tac tach:
 *  - Co dau `, ; |`      -> tach theo cac dau do:  `'4k, hd'`     -> `['4k','hd']`
 *  - Co nhieu dau `#`    -> tach theo khoang trang: `'#a #b'`      -> `['a','b']`
 *  - Con lai             -> gop thanh MOT tag:      `'anime art'`  -> `['animeart']`
 *
 * Nhan vao: `['#Wallpaper', 'anime art', '4k, hd', '#4K', 'wallpaper']`
 * Tra ve  : `['Wallpaper', 'animeart', '4k', 'hd', '4K']` (bo trung theo lowercase, giu thu tu)
 *
 * @param {string | string[] | undefined | null} input
 * @param {object} [opts]
 * @param {number} [opts.max=Infinity] So hashtag toi da.
 * @param {boolean} [opts.lowercase=false]
 * @param {number} [opts.maxLength=100] Do dai toi da moi tag.
 * @returns {string[]} Danh sach tag KHONG co dau '#'.
 */
export function normalizeHashtags(input, opts = {}) {
  const { max = Infinity, lowercase = false, maxLength = 100 } = opts;
  if (input == null) return [];
  // Chuoi don le: luon tach theo khoang trang va dau phay ("a, b" hoac "#a #b").
  const raw = Array.isArray(input) ? input : String(input).split(/[\s,;|]+/);

  /** @type {string[]} */
  const out = [];
  const seen = new Set();

  for (const item of raw) {
    if (item == null) continue;
    for (const piece of splitTagItem(String(item))) {
      let tag = piece.replace(/^#+/, '').replace(HASHTAG_STRIP_RE, '');
      if (!tag) continue;
      if (tag.length > maxLength) tag = tag.slice(0, maxLength);
      if (lowercase) tag = tag.toLowerCase();
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Tach mot phan tu trong mang hashtag thanh cac tag rieng le.
 * @param {string} item
 * @returns {string[]}
 */
function splitTagItem(item) {
  const s = item.trim();
  if (!s) return [];
  if (/[,;|]/.test(s)) return s.split(/[,;|]+/).flatMap(splitTagItem);
  // '#a #b' -> nhieu tag; 'anime art' -> mot tag ghep lien
  if ((s.match(/#/g) ?? []).length > 1) return s.split(/\s+/);
  return [s];
}

/**
 * Ghep hashtag thanh chuoi "#a #b #c".
 * @param {string[]} tags
 * @param {string} [separator=' ']
 * @returns {string}
 */
export function formatHashtags(tags, separator = ' ') {
  return (tags ?? []).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`)).join(separator);
}

/**
 * Lay hashtag co san trong mot doan text.
 * @param {string} text
 * @returns {string[]}
 */
export function extractHashtags(text) {
  if (!text) return [];
  const matches = String(text).match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return normalizeHashtags(matches);
}

/**
 * Bo toan bo hashtag khoi text.
 * @param {string} text
 * @returns {string}
 */
export function stripHashtags(text) {
  if (!text) return '';
  return String(text).replace(/#[\p{L}\p{N}_]+/gu, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Dem so "ky tu" theo cach nguoi dung thay (grapheme), de emoji khong bi cat doi.
 * @param {string} str
 * @returns {number}
 */
export function graphemeLength(str) {
  if (!str) return 0;
  return segment(str).length;
}

/**
 * Cat chuoi theo grapheme, giu nguyen emoji va dau tieng Viet.
 * @param {string} str
 * @param {number} maxLen
 * @param {object} [opts]
 * @param {string} [opts.ellipsis='...']
 * @param {boolean} [opts.breakOnWord=true] Uu tien cat o khoang trang gan nhat.
 * @returns {string}
 */
export function truncate(str, maxLen, opts = {}) {
  const { ellipsis = '...', breakOnWord = true } = opts;
  if (!str) return '';
  // maxLen khong hop le (undefined/NaN/Infinity) -> coi nhu "khong gioi han",
  // KHONG duoc tra ve chuoi rong vi se lam mat toan bo noi dung.
  if (!Number.isFinite(maxLen)) return str;
  if (maxLen <= 0) return '';
  const parts = segment(str);
  if (parts.length <= maxLen) return str;

  const ellipsisLen = segment(ellipsis).length;
  // maxLen nho hon ca ellipsis -> chi cat cung, khong them ellipsis.
  if (maxLen <= ellipsisLen) return parts.slice(0, maxLen).join('');
  const keep = Math.max(0, maxLen - ellipsisLen);
  let cut = parts.slice(0, keep).join('');
  if (breakOnWord) {
    const lastSpace = cut.lastIndexOf(' ');
    // Chi lui ve khoang trang neu khong mat qua ~30% noi dung.
    if (lastSpace > cut.length * 0.7) cut = cut.slice(0, lastSpace);
  }
  return `${cut.trimEnd()}${ellipsis}`;
}

/**
 * Dung caption cho tung nen tang, ton trong gioi han do dai va so hashtag.
 *
 * Uu tien giu: title > description > hashtag.
 * Neu thieu cho: cat bot hashtag truoc, sau do moi cat noi dung.
 *
 * @param {object} post
 * @param {string} [post.title]
 * @param {string} [post.description]
 * @param {string[]} [post.hashtags]
 * @param {string} [post.link]
 * @param {object} [opts]
 * @param {number} [opts.maxLength=Infinity]
 * @param {number} [opts.maxHashtags=Infinity]
 * @param {boolean} [opts.includeTitle=true]
 * @param {boolean} [opts.includeHashtags=true]
 * @param {boolean} [opts.includeLink=true]
 * @param {string} [opts.titleSeparator]
 * @param {string} [opts.hashtagSeparator]
 * @param {(ctx: {title: string, description: string, hashtags: string, link: string}) => string} [opts.template]
 *        Ghi de hoan toan cach ghep. Ket qua van bi cat theo maxLength.
 * @returns {{text: string, truncated: boolean, droppedHashtags: number, length: number}}
 */
export function buildCaption(post = {}, opts = {}) {
  const {
    maxLength = Infinity,
    maxHashtags = Infinity,
    includeTitle = true,
    includeHashtags = true,
    includeLink = true,
    titleSeparator = '\n\n',
    hashtagSeparator = '\n\n',
    template,
  } = opts;

  const title = includeTitle ? String(post.title ?? '').trim() : '';
  const description = String(post.description ?? '').trim();
  const link = includeLink && post.link ? String(post.link).trim() : '';
  const allTags = includeHashtags ? normalizeHashtags(post.hashtags) : [];
  const tagCap = Number.isFinite(maxHashtags) ? maxHashtags : allTags.length;

  if (typeof template === 'function') {
    const text = String(
      template({
        title,
        description,
        hashtags: formatHashtags(allTags.slice(0, tagCap)),
        link,
      }) ?? '',
    );
    const finalText = truncate(text, maxLength);
    return {
      text: finalText,
      truncated: finalText !== text,
      droppedHashtags: Math.max(0, allTags.length - tagCap),
      length: graphemeLength(finalText),
    };
  }

  const tags = allTags.slice(0, tagCap);
  let dropped = allTags.length - tags.length;

  const head = [title, description].filter(Boolean).join(titleSeparator);
  const headWithLink = [head, link].filter(Boolean).join('\n\n');
  const assemble = (tagList) => [headWithLink, formatHashtags(tagList)].filter(Boolean).join(hashtagSeparator);

  let text = assemble(tags);
  if (graphemeLength(text) <= maxLength) {
    return { text, truncated: false, droppedHashtags: dropped, length: graphemeLength(text) };
  }

  // B1: bo dan hashtag tu cuoi len.
  while (tags.length > 0 && graphemeLength(assemble(tags)) > maxLength) {
    tags.pop();
    dropped += 1;
  }
  text = assemble(tags);
  if (graphemeLength(text) <= maxLength) {
    return { text, truncated: false, droppedHashtags: dropped, length: graphemeLength(text) };
  }

  // B2: cat noi dung cho vua.
  const cut = truncate(text, maxLength);
  return { text: cut, truncated: true, droppedHashtags: dropped, length: graphemeLength(cut) };
}

/**
 * Escape cho Telegram parse_mode=HTML (an toan hon MarkdownV2 nhieu).
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Escape day du cho Telegram parse_mode=MarkdownV2.
 * Bot API bat buoc escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * @param {string} str
 * @returns {string}
 */
export function escapeMarkdownV2(str) {
  return String(str ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Bo BOM + ky tu dieu khien, chuan hoa newline.
 * @param {string} str
 * @returns {string}
 */
export function sanitizeText(str) {
  return String(str ?? '')
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

/**
 * Tao slug an toan cho ten file.
 * @param {string} str
 * @param {number} [maxLen=60]
 * @returns {string}
 */
export function slugify(str, maxLen = 60) {
  const s = String(str ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (s || 'post').slice(0, maxLen);
}

/** @type {Intl.Segmenter | false | null} */
let segmenter = null;

/**
 * @param {string} str
 * @returns {string[]}
 */
function segment(str) {
  if (segmenter === null) {
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      segmenter = false;
    }
  }
  if (segmenter) return Array.from(segmenter.segment(str), (s) => s.segment);
  return Array.from(str); // fallback: theo code point
}
