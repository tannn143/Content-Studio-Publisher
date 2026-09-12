/**
 * Test TINH cho web admin.
 *
 * Vi sao can: `node --check` chi kiem tra cu phap, nen mot loi nhu `$('.nav-item').forEach`
 * (dung $ thay vi $$) chi no khi mo trinh duyet. Cac test o day quet ma nguon de bat
 * dung nhung lop loi do ma khong can browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const html = await readFile(path.join(ROOT, 'public/index.html'), 'utf8');
const app = await readFile(path.join(ROOT, 'public/assets/app.js'), 'utf8');
const css = await readFile(path.join(ROOT, 'public/assets/styles.css'), 'utf8');
const server = await readFile(path.join(ROOT, 'src/server/server.js'), 'utf8');

/** Bo cac dong comment de khong quet phai vi du trong chu thich. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

const appCode = stripComments(app);

// ============================================================ $ vs $$

test('frontend: $() (mot element) khong duoc dung kem phuong thuc cua mang', () => {
  // Day chinh la loi da tung xay ra: $('.nav-item').forEach(...) -> TypeError khi mo UI.
  const bad = [...appCode.matchAll(/(?<!\$)\$\((['"`][^'"`]*['"`])\)\s*\.\s*(forEach|map|filter|some|every|reduce|slice|flatMap)\b/g)];
  assert.deepEqual(
    bad.map((m) => m[0]),
    [],
    'Dung $$() khi can nhieu element',
  );
});

test('frontend: $$() (danh sach) khong duoc dung kem thuoc tinh cua mot element', () => {
  const bad = [...appCode.matchAll(/\$\$\((['"`][^'"`]*['"`])\)\s*\.\s*(classList|value|textContent|innerHTML|addEventListener|onclick|onsubmit|disabled|checked|append|contains|files)\b/g)];
  assert.deepEqual(bad.map((m) => m[0]), [], 'Dung $() khi chi can mot element');
});

test('frontend: $() luon duoc goi voi selector dang chuoi', () => {
  // Bat loi $(undefined) / $() do refactor.
  const calls = [...appCode.matchAll(/(?<!\$)\$\(([^)]*)\)/g)].map((m) => m[1].trim());
  const suspicious = calls.filter((arg) => arg === '' || arg === 'undefined' || arg === 'null');
  assert.deepEqual(suspicious, []);
});

// ============================================================ id trong HTML

test('frontend: moi id ma app.js truy cap deu ton tai trong index.html', () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...appCode.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `id khong co trong HTML: ${missing.join(', ')}`);
});

test('frontend: cac id tao dong (credentials) khop voi provider id cua server', () => {
  // fillSettings tao input id `cred-<provider>-<field>` roi saveSettings doc lai cung khuon.
  assert.ok(appCode.includes('`#cred-${p.id}-${f.key}`'), 'saveSettings phai doc dung khuon id');
  assert.ok(appCode.includes('id: `cred-${p.id}-${f.key}`'), 'fillSettings phai tao dung khuon id');
});

// ============================================================ view / nav

test('frontend: moi data-view trong HTML deu nam trong danh sach VIEWS', () => {
  const viewsMatch = /const VIEWS = \[([^\]]+)\]/.exec(appCode);
  assert.ok(viewsMatch, 'khong tim thay hang so VIEWS');
  const views = viewsMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);

  const navViews = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  for (const v of navViews) {
    assert.ok(views.includes(v), `data-view="${v}" khong co trong VIEWS`);
  }
  // Va moi view phai co section tuong ung
  for (const v of views) {
    assert.ok(html.includes(`id="view-${v}"`), `thieu section #view-${v} trong HTML`);
  }
});

test('frontend: moi data-view-link tro den mot view hop le', () => {
  const viewsMatch = /const VIEWS = \[([^\]]+)\]/.exec(appCode);
  const views = viewsMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const links = [...html.matchAll(/data-view-link="([^"]+)"/g)].map((m) => m[1]);
  for (const l of links) assert.ok(views.includes(l), `data-view-link="${l}" khong hop le`);
});

// ============================================================ hop dong API

test('frontend: moi duong dan /api ma app.js goi deu co route tren server', () => {
  // Lay cac chuoi '/api/...' trong app.js (ke ca template literal co ${...}).
  // Phai thay phan dong ${...} TRUOC khi trich duong dan: trong bieu thuc co the co
  // dau nhay (vd `/api/scheduler/${x ? 'stop' : 'start'}`) lam viec trich bi cat giua.
  const normalized = appCode.replace(/\$\{[^{}]*\}/g, ':p');
  const paths = new Set(
    [...normalized.matchAll(/['"`](\/api\/[^'"`?\s]*)/g)]
      .map((m) => m[1])
      .map((p) => p.replace(/\/$/, '')),
  );

  // Lay route da dang ky tren server: router.get('/api/...')
  const routes = [...server.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)]
    .map((m) => m[2].split('/').filter(Boolean));

  /**
   * Mot doan duoc coi la khop khi: giong nhau, hoac mot ben la doan dong.
   * Client co the sinh ca doan cuoi (vd `/api/scheduler/${x ? 'stop' : 'start'}`)
   * trong khi server dang ky hai route tinh - van tinh la khop.
   */
  const segMatches = (clientSeg, routeSeg) =>
    clientSeg === routeSeg || clientSeg === ':p' || routeSeg.startsWith(':');

  const missing = [...paths].filter((p) => {
    if (!p.startsWith('/api/')) return false;
    const segs = p.split('/').filter(Boolean);
    return !routes.some((r) => r.length === segs.length && r.every((rs, i) => segMatches(segs[i], rs)));
  });
  assert.deepEqual(missing, [], `duong dan khong co route: ${missing.join(', ')}`);
});

test('frontend: doc dung field ma server tra ve', () => {
  // Cac cap (duong dan, field) quan trong - sai field la UI im lang khong hien gi.
  const contracts = [
    ["api('/api/state')", 'channels'],
    ["api('/api/media')", 'media'],
    ['/api/preview', 'previews'],
    ['/api/schedule/slots', 'slots'],
    ['/api/settings', 'settings'],
  ];
  for (const [needle] of contracts) {
    assert.ok(appCode.includes(needle.replace(/\(|\)/g, (c) => c)), `khong tim thay goi ${needle}`);
  }
  // Server phai tra ve dung cac field do
  assert.ok(server.includes('channels: '), 'server phai tra ve field channels');
  assert.ok(server.includes('return { previews }'), 'server phai tra ve field previews');
  assert.ok(server.includes('slots,'), 'server phai tra ve field slots');
});

// ============================================================ CSS

test('frontend: cac class CSS quan trong deu duoc dinh nghia', () => {
  const important = [
    'nav-item', 'channel-chip', 'preview-card', 'post-card', 'toast', 'modal',
    'dropzone', 'media-item', 'per-channel-tab', 'status-tag', 'avatar', 'spinner',
    'empty-state', 'activity-line', 'slot-btn', 'provider-card', 'channel-card',
  ];
  const missing = important.filter((c) => !css.includes(`.${c}`));
  assert.deepEqual(missing, [], `class chua co CSS: ${missing.join(', ')}`);
});

test('frontend: CSS can bang ngoac va co dark/light mode', () => {
  const open = (css.match(/\{/g) ?? []).length;
  const close = (css.match(/\}/g) ?? []).length;
  assert.equal(open, close, 'so ngoac { } khong khop');
  assert.ok(css.includes('prefers-color-scheme: light'), 'phai co bien the sang');
});

// ============================================================ an toan XSS

test('frontend: khong dung innerHTML voi du lieu tu server', () => {
  // el() co ho tro attr `html`, nhung khong duoc dung voi du lieu dong.
  const htmlAttrUses = [...appCode.matchAll(/\bhtml:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
  for (const use of htmlAttrUses) {
    assert.ok(
      use.startsWith("'") || use.startsWith('"'),
      `attr html chi duoc dung voi chuoi tinh, gap: ${use}`,
    );
  }
  // Chi duoc co 2 cho: el() cho attr `html` (da kiem tra chi nhan chuoi tinh o tren)
  // va boot() in thong bao loi khoi dong.
  const innerHtml = [...appCode.matchAll(/\.innerHTML\s*=/g)];
  assert.ok(
    innerHtml.length <= 2,
    `chi cho phep 2 cho dung innerHTML, tim thay ${innerHtml.length}`,
  );
});

// ============================================================ ham ton tai

test('frontend: moi ham duoc goi trong bindUI deu duoc dinh nghia', () => {
  const bindUiStart = appCode.indexOf('function bindUI()');
  assert.ok(bindUiStart > 0);
  const bindUiEnd = appCode.indexOf('\n}', bindUiStart);
  const body = appCode.slice(bindUiStart, bindUiEnd);

  // Cac ten ham duoc gan lam handler: onclick = ten; hoac () => ten(...)
  const names = new Set([
    // onclick = tenHam;
    ...[...body.matchAll(/=\s*([a-zA-Z_][a-zA-Z0-9_]*);/g)].map((m) => m[1]),
    // tenHam() - KHONG tinh loi goi phuong thuc (vd location.reload()).
    ...[...body.matchAll(/(?<![.\w])([a-zA-Z_][a-zA-Z0-9_]*)\(\)/g)].map((m) => m[1]),
  ]);
  const builtins = new Set(['clear', 'preventDefault', 'toast', 'setView', 'api', 'el', 'commitHashtagInput']);
  for (const name of names) {
    if (builtins.has(name)) continue;
    const defined = new RegExp(`(function ${name}\\b|const ${name}\\s*=|let ${name}\\s*=)`).test(appCode);
    assert.ok(defined, `handler '${name}' duoc dung trong bindUI nhung khong duoc dinh nghia`);
  }
});

test('frontend: cac ham render duoc goi deu ton tai', () => {
  const called = new Set(
    [...appCode.matchAll(/\b(render[A-Z][a-zA-Z0-9_]*)\s*\(/g)].map((m) => m[1]),
  );
  for (const name of called) {
    assert.ok(
      new RegExp(`function ${name}\\b`).test(appCode),
      `goi ${name}() nhung khong co dinh nghia`,
    );
  }
  assert.ok(called.size >= 8, 'phai co nhieu ham render');
});

// ============================================ chay thu voi DOM gia lap

/**
 * Tao mot element gia du dung cho app.js khoi dong.
 * Day la test QUAN TRONG NHAT cua file: no thuc su CHAY app.js, nen bat duoc
 * loi runtime (nhu $ vs $$) ma kiem tra tinh co the bo sot.
 */
function stubElement() {
  const el = {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    style: {},
    children: [],
    value: '',
    textContent: '',
    checked: false,
    disabled: false,
    files: [],
    firstChild: null,
    scrollTop: 0,
    scrollHeight: 0,
    addEventListener() {},
    removeEventListener() {},
    append() {},
    appendChild() {},
    removeChild() {},
    remove() {},
    setAttribute() {},
    click() {},
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
  return el;
}

test('frontend: app.js khoi dong duoc (chay thuc voi DOM gia lap)', async () => {
  const cache = new Map();
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    history: globalThis.history,
    EventSource: globalThis.EventSource,
    fetch: globalThis.fetch,
    XMLHttpRequest: globalThis.XMLHttpRequest,
    Node: globalThis.Node,
    Blob: globalThis.Blob,
  };

  /** @type {string[]} */
  const fetched = [];
  globalThis.document = {
    querySelector: (sel) => {
      if (!cache.has(sel)) cache.set(sel, stubElement());
      return cache.get(sel);
    },
    // Tra ve NHIEU element de $$ phai la mang -> $ dung sai se nem TypeError.
    querySelectorAll: () => [stubElement(), stubElement()],
    createElement: () => stubElement(),
    createTextNode: (t) => ({ nodeValue: String(t) }),
    addEventListener() {},
    body: stubElement(),
    activeElement: null,
  };
  globalThis.window = { addEventListener() {} };
  // Trinh duyet co san class Node (el() dung 'child instanceof Node').
  globalThis.Node = class Node {};
  globalThis.location = { hash: '', search: '', pathname: '/', reload() {} };
  globalThis.history = { replaceState() {} };
  globalThis.EventSource = class { constructor() { this.onmessage = null; this.onerror = null; } };
  globalThis.XMLHttpRequest = class {
    open() {} setRequestHeader() {} send() {}
  };
  // Khong ghi de globalThis.navigator: Node 24 chi cho doc.
  // app.js dung navigator.clipboard?.writeText nen khong loi.
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    const body = String(url).includes('/api/session')
      ? { authRequired: false, authed: true }
      : {
        channels: [], platforms: [], providers: [], posts: [], media: [],
        settings: { credentials: {}, mediaHost: { type: 'none' }, postingTimes: [], publishing: {} },
        scheduler: { running: false }, slots: [], previews: [],
      };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  try {
    // Cache-bust de moi lan chay la mot module moi.
    await import(`../public/assets/app.js?t=${Date.now()}`);
    // Cho boot() chay xong, VA qua ca debounce 400ms cua schedulePreview:
    // neu go global som thi timer se chay khi khong con document -> unhandledRejection.
    await new Promise((r) => setTimeout(r, 900));

    assert.ok(fetched.some((u) => u.includes('/api/session')), 'phai goi /api/session');
    assert.ok(fetched.some((u) => u.includes('/api/state')), 'phai goi /api/state');
    // boot() bat loi va ghi vao document.body.innerHTML -> neu co loi thi field nay bi set.
    assert.equal(
      globalThis.document.body.innerHTML,
      undefined,
      'app.js nem loi khi khoi dong (xem thong bao trong body.innerHTML)',
    );
  } finally {
    // Chi hoan nguyen nhung thu co the anh huong test khac. Giu lai document/window/Node
    // de timer nao con sot khong lam vo process.
    for (const k of ['location', 'history', 'EventSource', 'fetch', 'XMLHttpRequest']) {
      if (saved[k] === undefined) delete globalThis[k];
      else globalThis[k] = saved[k];
    }
  }
});

// ================================================ TikTok: tuan thu UX audit

/**
 * Nhung thu duoi day la YEU CAU BAT BUOC cua TikTok de qua audit Direct Post.
 * Xoa nhung dong nay di la app bi tu choi, nen khoa lai bang test.
 * Xem docs/tiktok-app-review.md.
 */

test('tiktok UX: danh sach privacy chi dung tu creator_info, khong hard-code', () => {
  // Neu ai do hard-code lai 4 gia tri privacy vao mot mang option thi test nay do.
  const hardcoded = /value:\s*'(PUBLIC_TO_EVERYONE|MUTUAL_FOLLOW_FRIENDS|FOLLOWER_OF_CREATOR)'/.test(appCode);
  assert.equal(hardcoded, false, 'privacy_level phai lay tu creator_info.privacyLevelOptions');
  assert.ok(appCode.includes('data.privacyLevelOptions'), 'phai doc privacyLevelOptions tu creator_info');
  assert.ok(appCode.includes('/creator-info'), 'phai goi endpoint creator-info truoc khi dung form');
});

test('tiktok UX: khong duoc chon san che do hien thi', () => {
  assert.ok(
    appCode.includes('— Select who can view this —'),
    'phai co option rong bat creator tu chon privacy level',
  );
  assert.ok(
    appCode.includes('Select who can view your TikTok post before publishing.'),
    'chua chon privacy level thi phai chan dang',
  );
});

test('tiktok UX: co cong tac khai bao noi dung thuong mai', () => {
  assert.ok(appCode.includes('brandOrganicToggle'), 'thieu "Thuong hieu cua toi" (brand_organic_toggle)');
  assert.ok(appCode.includes('brandContentToggle'), 'thieu "Noi dung co tai tro" (brand_content_toggle)');
  assert.ok(
    appCode.includes('tiktokDisclosureField'),
    'thieu khoi khai bao noi dung thuong mai',
  );
});

test('tiktok UX: branded content khong duoc o che do rieng tu', () => {
  assert.ok(
    appCode.includes("filter((v) => v !== 'SELF_ONLY')"),
    'bat branded content thi phai bo SELF_ONLY khoi danh sach privacy',
  );
  assert.ok(
    appCode.includes("per.brandContentToggle && per.privacyLevel === 'SELF_ONLY'"),
    'phai chan branded content + SELF_ONLY',
  );
});

test('tiktok UX: co tuyen bo dong y Music Usage Confirmation', () => {
  assert.ok(
    appCode.includes('music-usage-confirmation'),
    'phai link toi Music Usage Confirmation cua TikTok',
  );
  assert.ok(
    appCode.includes('bc-policy'),
    'bat branded content thi phai link toi Branded Content Policy',
  );
  assert.ok(appCode.includes('tiktokConsentText'), 'thieu khoi tuyen bo dong y');
});

test('tiktok UX: comment/duet/stitch khoa theo cai dat tai khoan', () => {
  for (const f of ['commentDisabled', 'duetDisabled', 'stitchDisabled']) {
    assert.ok(appCode.includes(`data.${f}`), `phai ton trong creator_info.${f}`);
  }
  assert.ok(appCode.includes('disabled: accountOff'), 'o bi tat o cap tai khoan phai khoa lai');
});

test('tiktok UX: validate chan dang truoc khi goi API', () => {
  assert.ok(
    appCode.includes('tiktokComplianceError(ch, per,'),
    'validateComposer phai chay kiem tra rang buoc TikTok',
  );
});

test('tiktok UX: class CSS cua khoi TikTok deu co dinh nghia', () => {
  const classes = ['tiktok-opts', 'tiktok-creator', 'tiktok-field', 'tiktok-disclose',
    'tiktok-consent', 'tiktok-problem', 'tiktok-checks', 'opt-full', 'needs-pick'];
  const missing = classes.filter((c) => !css.includes(`.${c}`));
  assert.deepEqual(missing, [], `class chua co CSS: ${missing.join(', ')}`);
});
