/**
 * Web admin cho wallpaper-auto-marketing.
 * Vanilla JS, khong build step. Giao tiep voi server qua /api/*.
 */

// ============================================================ trang thai

const state = {
  authRequired: false,
  channels: [],
  platforms: [],
  providers: [],
  settings: null,
  posts: [],
  media: [],            // media da upload cho bai dang hien tai
  scheduler: null,
  view: 'composer',
  selectedChannels: new Set(),
  hashtags: [],
  perChannel: {},        // { channelId: {title, description, hashtags, ...options} }
  creatorInfo: {},       // { channelId: {status, data, error} } - creator_info cua TikTok
  me: null,              // nguoi dang dang nhap (publicUser)
  users: [],             // danh sach nhan vien (chi admin doc duoc)
  audit: [],             // audit log (chi admin doc duoc)
  activeTab: null,
  editingPostId: null,
  previewTimer: null,
  activity: [],
  busy: false,
  sessionExpired: false,
};

/** Cac view hop le (dung cho dieu huong bang hash). */
const VIEWS = ['composer', 'queue', 'channels', 'history', 'team', 'audit', 'settings'];

/** View chi danh cho admin. Server van tu chan API - day chi la tien nghi. */
const ADMIN_VIEWS = new Set(['team', 'audit', 'settings']);

function isAdminUser() {
  return state.me?.role === 'admin';
}

const PLATFORM_ICON = {
  youtube: '▶️',
  facebook: 'f',
  instagram: '◉',
  tiktok: '♪',
  telegram: '✈️',
};

/**
 * TAM THOI: chi hien mot so nen tang trong giao dien.
 *
 * Dung de quay video demo cho TikTok app review - reviewer chi can thay
 * duy nhat luong TikTok, khong bi phan tan boi cac kenh khac.
 *
 * DE HIEN LAI TAT CA: dat VISIBLE_PLATFORMS = null.
 *
 * Chi loc o tang hien thi. Backend, adapter va du lieu da luu khong doi -
 * cac kenh khac van con nguyen, chi la khong ve ra.
 */
const VISIBLE_PLATFORMS = ['tiktok'];

/** @param {string} platform */
function isPlatformVisible(platform) {
  return !VISIBLE_PLATFORMS || VISIBLE_PLATFORMS.includes(platform);
}

const PLATFORM_LABEL = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  telegram: 'Telegram',
};

// ============================================================ tien ich DOM

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/**
 * Tao element nhanh. `children` co the la string (text), Node, hoac mang.
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)}${u[i]}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtRelative(iso) {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return diff >= 0 ? 'just now' : 'moments ago';
  if (mins < 60) return diff >= 0 ? `in ${mins} min` : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diff >= 0 ? `in ${hours} h` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  return diff >= 0 ? `in ${days} d` : `${days} d ago`;
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toast(message, { type = 'info', title, hint, timeout = 5200 } = {}) {
  const node = el('div', { class: `toast ${type}` }, [
    title ? el('strong', {}, title) : null,
    el('div', {}, message),
    hint ? el('div', { class: 'toast-hint' }, hint) : null,
  ]);
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  }, timeout);
}

// ============================================================ API client

async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (raw) {
    opts.body = raw;
  } else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.hint = data.hint;
    err.code = data.code;
    // Phien dang nhap het han -> quay ve trang dang nhap thay vi de UI chet cung.
    if (res.status === 401 && !state.sessionExpired) {
      state.sessionExpired = true;
      toast('Your session has expired.', { type: 'warn', title: 'Please sign in again' });
      setTimeout(() => location.reload(), 1200);
    }
    throw err;
  }
  return data;
}

/** Upload mot file: body la byte tho, ten file trong header. */
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name).replace(/%20/g, ' '));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.media);
      else {
        const err = new Error(data.error || `Upload failed (HTTP ${xhr.status})`);
        err.hint = data.hint;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('Connection lost during upload'));
    xhr.send(file);
  });
}

// ============================================================ khởi động

async function boot() {
  // Thông báo từ OAuth callback (?ok=... / ?error=...)
  const params = new URLSearchParams(location.search);
  if (params.get('ok')) toast(params.get('ok'), { type: 'success', title: 'Account connected' });
  if (params.get('error')) toast(params.get('error'), { type: 'error', title: 'Could not connect', timeout: 12000 });
  if (params.get('ok') || params.get('error')) {
    history.replaceState(null, '', location.pathname + location.hash);
  }

  const session = await api('/api/session').catch(() => ({ authRequired: true, authed: false }));
  state.authRequired = session.authRequired;

  if (session.authRequired && !session.authed) {
    showLogin();
    return;
  }
  await startApp();
}

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const errBox = $('#login-error');
    errBox.classList.add('hidden');
    try {
      await api('/api/session', {
        method: 'POST',
        body: {
          username: $('#login-username').value.trim(),
          password: $('#login-password').value,
        },
      });
      location.reload();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  };
}

async function startApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  bindUI();
  await refreshState();
  connectEvents();
  const hash = location.hash.replace('#', '');
  setView(VIEWS.includes(hash) ? hash : 'composer');
}

async function refreshState() {
  const data = await api('/api/state');
  // Loc theo VISIBLE_PLATFORMS: lam o day thay vi trong tung ham render de
  // khong the bo sot cho nao.
  state.channels = data.channels.filter((c) => isPlatformVisible(c.platform));
  state.platforms = data.platforms.filter((p) => isPlatformVisible(p.platform));
  state.providers = data.providers.filter((p) => p.platforms.some(isPlatformVisible));
  // Card ket noi Telegram nam san trong HTML nen phai an rieng.
  $('#card-telegram')?.classList.toggle('hidden', !isPlatformVisible('telegram'));
  state.settings = data.settings;
  state.posts = data.posts;
  state.scheduler = data.scheduler;
  state.me = data.me ?? state.me;
  renderCurrentUser();

  // Bo cac kenh da bi xoa khoi lua chon hien tai.
  const ids = new Set(state.channels.map((c) => c.id));
  for (const id of [...state.selectedChannels]) if (!ids.has(id)) state.selectedChannels.delete(id);

  renderSidebar();
  renderChannelPicker();
  renderProviders();
  renderChannelCards();
  renderQueue();
  renderHistory();
  fillSettings();
  renderPerChannelTabs();
  schedulePreview();
  loadSlots();
}

// ============================================================ điều hướng

function setView(view) {
  // Vao thang bang hash cung khong duoc: quay ve Compose.
  if (ADMIN_VIEWS.has(view) && !isAdminUser()) view = 'composer';
  state.view = view;
  location.hash = view;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`)?.classList.remove('hidden');
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'queue' || view === 'history') void reloadPosts();
  if (view === 'channels') renderChannelCards();
  if (view === 'team') void reloadUsers();
  if (view === 'audit') void reloadAudit();
}

function bindUI() {
  $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));

  // Nut Back/Forward cua trinh duyet phai doi duoc view.
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace('#', '');
    if (view && view !== state.view && VIEWS.includes(view)) setView(view);
  });
  $$('[data-view-link]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    setView(a.dataset.viewLink);
  }));

  $('#btn-change-password').onclick = changeOwnPassword;
  $('#btn-add-user').onclick = addTeamMember;
  $('#btn-refresh-audit').onclick = () => void reloadAudit();
  $('#audit-filter').onchange = () => void reloadAudit();

  $('#btn-logout').onclick = async () => {
    await api('/api/session', { method: 'DELETE' }).catch(() => {});
    location.reload();
  };

  // Composer
  $('#in-title').addEventListener('input', onContentChange);
  $('#in-description').addEventListener('input', onContentChange);
  $('#in-link').addEventListener('input', schedulePreview);
  $('#in-hashtags').addEventListener('keydown', onHashtagKey);
  $('#in-hashtags').addEventListener('blur', () => commitHashtagInput());

  $('#btn-browse').onclick = () => $('#file-input').click();
  $('#file-input').addEventListener('change', (e) => handleFiles([...e.target.files]));
  setupDropzone();

  $('#btn-reset').onclick = resetComposer;
  $('#btn-save-draft').onclick = () => savePost({ status: 'draft' });
  $('#btn-dry-run').onclick = dryRun;
  $('#btn-publish-now').onclick = publishNow;
  $('#btn-queue').onclick = queuePost;
  $('#btn-refresh-preview').onclick = () => refreshPreview();
  $('#btn-clear-activity').onclick = () => {
    state.activity = [];
    renderActivity();
  };

  // Kênh
  $('#btn-verify-all').onclick = verifyAll;
  $('#form-telegram').onsubmit = connectTelegram;

  // Hàng đợi
  $('#btn-tick').onclick = async () => {
    toast('Running the scheduler...', { type: 'info' });
    const r = await api('/api/scheduler/tick', { method: 'POST' });
    toast(`Published ${r.result.published}, failed ${r.result.failed}`, { type: r.result.failed ? 'warn' : 'success' });
    await reloadPosts();
  };
  $('#btn-toggle-scheduler').onclick = async () => {
    const running = state.scheduler?.running;
    const r = await api(`/api/scheduler/${running ? 'stop' : 'start'}`, { method: 'POST' });
    state.scheduler = r.scheduler;
    renderSidebar();
    renderSchedulerButton();
  };

  // Lịch sử
  $('#history-filter').addEventListener('change', renderHistory);

  // Cài đặt
  $('#btn-save-settings').onclick = saveSettings;
  $('#mh-type').addEventListener('change', () => {
    const t = $('#mh-type').value;
    $('#mh-s3').classList.toggle('hidden', t !== 's3');
    $('#mh-tunnel').classList.toggle('hidden', t !== 'tunnel');
  });

  // Modal
  $('#modal-close').onclick = closeModal;
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    // Ctrl/Cmd + Enter = đăng ngay
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.view === 'composer') {
      e.preventDefault();
      void publishNow();
    }
  });
}

// ============================================================ sidebar

function renderSidebar() {
  const box = clear($('#sidebar-channels'));
  $('#badge-channels').textContent = String(state.channels.length);
  $('#badge-queue').textContent = String(state.posts.filter((p) => p.status === 'queued').length);

  if (state.channels.length === 0) {
    box.append(el('p', { class: 'muted small', style: 'padding:0 6px' }, 'No accounts connected yet.'));
  }
  for (const ch of state.channels) {
    box.append(el('div', {
      class: `sidebar-channel${ch.lastError ? ' has-error' : ''}${ch.enabled ? '' : ' disabled'}`,
      title: ch.lastError ? ch.lastError.message : `${PLATFORM_LABEL[ch.platform] ?? ch.platform}${ch.username ? ` · @${ch.username}` : ''}`,
    }, [
      avatarNode(ch),
      el('span', { class: 'name' }, ch.name),
      ch.lastError ? el('span', { title: ch.lastError.message }, '⚠️') : null,
    ]));
  }
  renderSchedulerStatus();
}

function avatarNode(ch, size = '') {
  const inner = ch.avatar
    ? el('img', { src: ch.avatar, alt: '', loading: 'lazy', onerror: (e) => { e.target.remove(); } })
    : document.createTextNode((ch.name || '?').slice(0, 1).toUpperCase());
  return el('span', { class: `avatar ${size}`.trim() }, [
    inner,
    el('span', { class: 'platform-badge', title: PLATFORM_LABEL[ch.platform] }, PLATFORM_ICON[ch.platform] ?? '?'),
  ]);
}

function renderSchedulerStatus() {
  const s = state.scheduler;
  const box = clear($('#scheduler-status'));
  box.append(
    el('span', { class: `dot ${s?.running ? 'on' : 'off'}` }),
    `Scheduler ${s?.running ? 'running' : 'paused'}`,
  );
  if (s?.lastTickAt) box.append(el('div', {}, `Last check: ${fmtRelative(s.lastTickAt)}`));
  renderSchedulerButton();
}

function renderSchedulerButton() {
  const btn = $('#btn-toggle-scheduler');
  if (btn) btn.textContent = state.scheduler?.running ? 'Pause' : 'Resume';
}

// ============================================================ composer

function onContentChange() {
  updateCounters();
  schedulePreview();
}

function renderChannelPicker() {
  const box = clear($('#channel-picker'));
  $('#channel-picker-empty').classList.toggle('hidden', state.channels.length > 0);

  for (const ch of state.channels) {
    const selected = state.selectedChannels.has(ch.id);
    const chip = el('button', {
      type: 'button',
      class: `channel-chip${selected ? ' selected' : ''}${ch.enabled ? '' : ' chip-disabled'}`,
      title: ch.enabled ? '' : 'This account is disabled',
      onclick: () => {
        if (!ch.enabled) {
          toast('This account is disabled. Re-enable it on the Channels tab.', { type: 'warn' });
          return;
        }
        if (state.selectedChannels.has(ch.id)) state.selectedChannels.delete(ch.id);
        else state.selectedChannels.add(ch.id);
        renderChannelPicker();
        renderPerChannelTabs();
        updateCounters();
        schedulePreview();
      },
    }, [avatarNode(ch), ch.name]);
    box.append(chip);
  }
}

function updateCounters() {
  const selected = selectedChannelObjects();
  const title = $('#in-title').value;
  const desc = $('#in-description').value;

  const capsFor = (platform) => state.platforms.find((p) => p.platform === platform);
  const caption = composeCaptionLocal(title, desc, state.hashtags, $('#in-link').value);

  const titleBox = clear($('#counter-title'));
  titleBox.append(el('span', {}, `${title.length} characters`));
  for (const ch of selected) {
    const caps = capsFor(ch.platform);
    const limit = ch.platform === 'youtube' ? caps?.limits?.title : null;
    if (limit && Number.isFinite(limit)) {
      const over = title.length > limit;
      titleBox.append(el('span', { class: over ? 'over' : (title.length > limit * 0.9 ? 'near' : '') },
        `${PLATFORM_LABEL[ch.platform]}: ${title.length}/${limit}`));
    }
  }

  const descBox = clear($('#counter-description'));
  descBox.append(el('span', {}, `Full caption: ${caption.length} characters`));
  for (const ch of selected) {
    const caps = capsFor(ch.platform);
    // Phai tinh theo noi dung THUC SU gui cho kenh nay (co tuy bien rieng).
    const per = state.perChannel[ch.id] ?? {};
    const chCaption = composeCaptionLocal(
      per.title ?? title,
      per.description ?? desc,
      per.hashtags ?? state.hashtags,
      $('#in-link').value,
    );
    const chTags = per.hashtags ?? state.hashtags;
    const limit = caps?.limits?.caption;
    if (limit && Number.isFinite(limit)) {
      // YouTube gioi han theo BYTE (5000), cac nen tang khac theo ky tu.
      const used = ch.platform === 'youtube'
        ? new TextEncoder().encode(chCaption).length
        : chCaption.length;
      const unit = ch.platform === 'youtube' ? ' byte' : '';
      const over = used > limit;
      descBox.append(el('span', { class: over ? 'over' : (used > limit * 0.9 ? 'near' : '') },
        `${PLATFORM_LABEL[ch.platform]}: ${used}/${limit}${unit}`));
    }
    const htLimit = caps?.limits?.hashtags;
    if (htLimit && Number.isFinite(htLimit) && chTags.length > htLimit) {
      descBox.append(el('span', { class: 'over' }, `${PLATFORM_LABEL[ch.platform]}: ${chTags.length}/${htLimit} hashtag`));
    }
  }
}

/** Ghép caption giống server (chỉ để đếm nhanh, server vẫn là nguồn chính). */
function composeCaptionLocal(title, description, hashtags, link) {
  const parts = [title, description].filter(Boolean).join('\n\n');
  const withLink = [parts, link].filter(Boolean).join('\n\n');
  const tags = hashtags.map((t) => `#${t}`).join(' ');
  return [withLink, tags].filter(Boolean).join('\n\n');
}

function selectedChannelObjects() {
  return state.channels.filter((c) => state.selectedChannels.has(c.id));
}

// -------------------------------------------------------------- hashtags

function onHashtagKey(e) {
  if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
    e.preventDefault();
    commitHashtagInput();
  } else if (e.key === 'Backspace' && !e.target.value && state.hashtags.length > 0) {
    state.hashtags.pop();
    renderHashtags();
  }
}

function commitHashtagInput() {
  const input = $('#in-hashtags');
  const raw = input.value.trim();
  if (!raw) return;
  for (const piece of raw.split(/[\s,;|]+/)) {
    const tag = piece.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (tag && !state.hashtags.some((t) => t.toLowerCase() === tag.toLowerCase())) state.hashtags.push(tag);
  }
  input.value = '';
  renderHashtags();
}

function renderHashtags() {
  const box = clear($('#hashtag-chips'));
  for (const [i, tag] of state.hashtags.entries()) {
    box.append(el('span', { class: 'chip' }, [
      `#${tag}`,
      el('button', {
        type: 'button',
        title: 'Remove',
        onclick: () => {
          state.hashtags.splice(i, 1);
          renderHashtags();
        },
      }, '✕'),
    ]));
  }
  updateCounters();
  schedulePreview();
}

// ----------------------------------------------------------------- media

function setupDropzone() {
  const dz = $('#dropzone');
  dz.addEventListener('click', (e) => {
    // Nut 'chon file' ben trong cung mo hop thoai -> tranh mo hai lan.
    if (e.target.closest('#btn-browse')) return;
    $('#file-input').click();
  });
  for (const evt of ['dragenter', 'dragover']) {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      dz.classList.add('dragover');
    });
  }
  for (const evt of ['dragleave', 'drop']) {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
    });
  }
  dz.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) handleFiles(files);
  });
}

async function handleFiles(files) {
  // Dem so upload dang chay de renderMedia() khong xoa placeholder cua lan khac.
  for (const file of files) {
    const placeholder = el('div', { class: 'media-item' }, [
      el('div', { class: 'media-thumb video-thumb' }, '⏳'),
      el('div', { class: 'media-meta' }, [el('span', { class: 'fname' }, file.name), el('span', {}, 'uploading...')]),
      el('div', { class: 'media-progress', style: 'width:0%' }),
    ]);
    $('#media-list').append(placeholder);
    try {
      const media = await uploadFile(file, (p) => {
        placeholder.querySelector('.media-progress').style.width = `${Math.round(p * 100)}%`;
      });
      state.media.push(media);
      placeholder.remove();
      renderMedia();
      schedulePreview();
    } catch (err) {
      placeholder.remove();
      toast(err.message, { type: 'error', title: `Could not upload ${file.name}`, hint: err.hint });
    }
  }
  $('#file-input').value = '';
}

function renderMedia() {
  const box = $('#media-list');
  // Chi xoa cac the da hoan tat, giu lai placeholder cua upload dang chay.
  for (const node of [...box.children]) {
    if (!node.querySelector('.media-progress')) node.remove();
  }
  for (const [i, m] of state.media.entries()) {
    const thumb = m.kind === 'image'
      ? el('img', { class: 'media-thumb', src: m.url, alt: m.filename, loading: 'lazy' })
      : el('div', { class: 'media-thumb video-thumb' }, '🎬');
    box.append(el('div', { class: 'media-item' }, [
      thumb,
      el('button', {
        class: 'media-remove',
        title: 'Remove from post',
        onclick: () => {
          state.media.splice(i, 1);
          renderMedia();
          schedulePreview();
        },
      }, '✕'),
      el('div', { class: 'media-meta' }, [
        el('span', { class: 'fname', title: m.filename }, m.filename),
        el('span', {}, [
          fmtBytes(m.size),
          m.width ? ` · ${m.width}×${m.height}` : '',
          m.durationSec ? ` · ${fmtDuration(m.durationSec)}` : '',
        ].join('')),
      ]),
    ]));
  }
}

// -------------------------------------------------------- per-channel tabs

function renderPerChannelTabs() {
  const selected = renderPerChannelTabStrip();
  if (!selected) return;
  renderPerChannelBody(selected.find((c) => c.id === state.activeTab));
}

/**
 * Chi ve lai DAI TAB, khong dung tới phan body.
 * Quan trong: goi ham nay (khong phai renderPerChannelTabs) khi nguoi dung dang
 * nhap, vi ve lai body se thay the input dang focus -> chi go duoc 1 ky tu.
 * @returns {any[] | null} danh sach kenh da chon, hoac null neu khong co kenh nao
 */
function renderPerChannelTabStrip() {
  const selected = selectedChannelObjects();
  const section = $('#per-channel-section');
  section.classList.toggle('hidden', selected.length === 0);

  const tabs = clear($('#per-channel-tabs'));
  if (selected.length === 0) {
    clear($('#per-channel-body'));
    return null;
  }
  if (!selected.some((c) => c.id === state.activeTab)) state.activeTab = selected[0].id;

  for (const ch of selected) {
    const customized = Object.keys(state.perChannel[ch.id] ?? {}).length > 0;
    tabs.append(el('button', {
      type: 'button',
      class: `per-channel-tab${ch.id === state.activeTab ? ' active' : ''}${customized ? ' customized' : ''}`,
      onclick: () => {
        state.activeTab = ch.id;
        renderPerChannelTabs();
      },
    }, [PLATFORM_ICON[ch.platform] ?? '', ` ${ch.name}`]));
  }
  return selected;
}

/** Mo phan tuy chon rieng cua mot kenh (dung khi validate bao loi o kenh do). */
function openPerChannelTab(channelId) {
  state.activeTab = channelId;
  const section = $('#per-channel-section');
  if (section) section.open = true;
  renderPerChannelTabs();
  section?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderPerChannelBody(channel) {
  const box = clear($('#per-channel-body'));
  if (!channel) return;
  const per = state.perChannel[channel.id] ?? {};

  const setVal = (key, value) => {
    state.perChannel[channel.id] = { ...(state.perChannel[channel.id] ?? {}) };
    if (value === '' || value === undefined || value === null) delete state.perChannel[channel.id][key];
    else state.perChannel[channel.id][key] = value;
    if (Object.keys(state.perChannel[channel.id]).length === 0) delete state.perChannel[channel.id];
    // CHI ve lai dai tab: ve lai body se lam input dang go mat focus.
    renderPerChannelTabStrip();
    schedulePreview();
  };

  box.append(
    el('p', { class: 'muted small' }, `Leave empty to use the shared content. Applies to ${channel.name} only.`),
    el('label', { class: 'field-label' }, 'Custom title'),
    el('input', {
      type: 'text',
      value: per.title ?? '',
      placeholder: $('#in-title').value || 'Title just for this account',
      oninput: (e) => setVal('title', e.target.value),
    }),
    el('label', { class: 'field-label' }, 'Custom description'),
    el('textarea', {
      rows: 4,
      placeholder: 'Description just for this account',
      oninput: (e) => setVal('description', e.target.value),
    }, per.description ?? ''),
    el('label', { class: 'field-label' }, 'Custom hashtags (comma separated)'),
    el('input', {
      type: 'text',
      value: (per.hashtags ?? []).join(', '),
      placeholder: state.hashtags.join(', '),
      oninput: (e) => {
        const tags = e.target.value.split(/[\s,;|]+/).map((t) => t.replace(/^#/, '')).filter(Boolean);
        setVal('hashtags', tags.length ? tags : '');
      },
    }),
  );

  box.append(el('label', { class: 'field-label' }, 'Platform options'));
  box.append(el('div', { class: 'opt-grid' }, platformOptions(channel, per, setVal)));
}

// ------------------------------------------------------------------- TikTok

/**
 * Nhan hien thi cho tung privacy_level. Danh sach THUC TE luon lay tu
 * creator_info.privacy_level_options - bang nay chi de dich sang tieng Viet.
 */
const TIKTOK_PRIVACY_LABEL = {
  PUBLIC_TO_EVERYONE: 'Public — everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends — mutual followers',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me — private',
};

const TIKTOK_LEGAL = {
  music: 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en',
  branded: 'https://www.tiktok.com/legal/page/global/bc-policy/en',
};

/** creator_info coi la cu sau 5 phut -> tu nap lai khi mo lai tab. */
const CREATOR_INFO_TTL_MS = 5 * 60 * 1000;

/**
 * Nap creator_info cua mot kenh TikTok vao state.
 * TikTok BAT BUOC goi creator_info truoc moi Direct Post; adapter van goi lai
 * lan nua luc dang, ban nay chi de dung form.
 */
async function ensureCreatorInfo(channelId, { force = false } = {}) {
  const cur = state.creatorInfo[channelId];
  const fresh = cur?.status === 'ok' && Date.now() - (cur.at ?? 0) < CREATOR_INFO_TTL_MS;
  if (!force && (cur?.status === 'loading' || fresh)) return cur;

  state.creatorInfo[channelId] = { status: 'loading' };
  try {
    const { creatorInfo } = await api('/api/channels/' + channelId + '/creator-info');
    state.creatorInfo[channelId] = { status: 'ok', data: creatorInfo, at: Date.now() };
  } catch (err) {
    state.creatorInfo[channelId] = { status: 'error', error: err.message, hint: err.hint };
  }
  return state.creatorInfo[channelId];
}

/** Kieu dang hieu luc cua kenh (per-post ghi de cau hinh kenh). */
function tiktokPostMode(channel, per) {
  return String(per.postMode || channel.options?.postMode || 'DIRECT_POST').toUpperCase();
}

/** Dang o che do nhap (creator tu hoan tat trong app TikTok)? */
function isTikTokDraftMode(mode) {
  return mode === 'MEDIA_UPLOAD' || mode === 'INBOX' || mode === 'DRAFT';
}

/**
 * Khối tuỳ chọn TikTok.
 *
 * Dựng theo đúng yêu cầu UX bắt buộc của TikTok cho Direct Post — thiếu những
 * thứ này là lý do trượt audit phổ biến nhất:
 *  - privacy_level CHỈ được liệt kê từ creator_info.privacy_level_options, và
 *    KHÔNG được chọn sẵn: creator phải tự chọn trước khi đăng được.
 *  - comment / Duet / Stitch phải bị khoá nếu creator đã tắt ở cấp tài khoản.
 *  - Phải có công tắc khai báo nội dung (Your brand / Branded content).
 *  - Branded content không được để ở chế độ riêng tư.
 *  - Phải hiện tuyên bố đồng ý Music Usage Confirmation (kèm Branded Content
 *    Policy khi bật branded content) ngay cạnh nút đăng.
 */
function tiktokOptions(channel, setVal) {
  const box = el('div', { class: 'opt-full tiktok-opts' });

  // Ca khoi chi co select/checkbox nen ve lai duoc ma khong mat focus - can ve
  // lai vi cac o phu thuoc nhau (bat branded content -> bo SELF_ONLY khoi list).
  const set = (key, value) => { setVal(key, value); render(); };

  const render = () => {
    // Doc lai tu state: 'per' truyen vao da cu sau moi lan setVal.
    const per = state.perChannel[channel.id] ?? {};
    const info = state.creatorInfo[channel.id];
    const mode = tiktokPostMode(channel, per);
    const draftMode = isTikTokDraftMode(mode);

    clear(box);
    box.append(tiktokCreatorBanner(channel, info));
    box.append(tiktokPostModeField(channel, per, mode, set));

    if (draftMode) {
      box.append(el('p', { class: 'tiktok-note muted small' },
        'Your video or photos go to drafts inside the TikTok app. You choose the '
        + 'viewership, sounds and content disclosure there before posting.'));
      return;
    }

    // Tu day tro xuong la Direct Post -> can creator_info moi dung form duoc.
    if (info?.status !== 'ok') {
      box.append(el('p', { class: 'tiktok-note muted small' },
        info?.status === 'loading'
          ? 'Loading your account settings from TikTok...'
          : 'Could not load your TikTok account settings, so the direct-post form is unavailable.'));
      return;
    }

    const data = info.data;
    box.append(tiktokPrivacyField(per, data, set));
    box.append(tiktokInteractionFields(per, data, set));
    box.append(tiktokDisclosureField(per, set));
    box.append(tiktokConsentText(per));

    const problem = tiktokComplianceError(channel, per, data);
    if (problem) box.append(el('p', { class: 'tiktok-problem' }, problem));
  };

  render();
  // Nap creator_info roi dung lai form (chi khi dang truc tiep moi can).
  const per0 = state.perChannel[channel.id] ?? {};
  if (!isTikTokDraftMode(tiktokPostMode(channel, per0))) {
    ensureCreatorInfo(channel.id).then(render).catch(render);
  }
  box._render = render;
  return box;
}

/** Cho biet dang soan cho tai khoan TikTok nao - tranh dang nham tai khoan. */
function tiktokCreatorBanner(channel, info) {
  const data = info?.status === 'ok' ? info.data : null;
  const name = data?.nickname || channel.name;
  const handle = data?.username ? '@' + data.username : (channel.username ? '@' + channel.username : '');

  const right = [];
  if (info?.status === 'loading') right.push(el('span', { class: 'muted small' }, 'loading...'));
  else if (info?.status === 'error') right.push(el('span', { class: 'tiktok-problem small' }, info.error));
  right.push(el('button', {
    type: 'button', class: 'link-btn', title: 'Reload the latest settings from TikTok',
    onclick: (e) => {
      const host = e.target.closest('.tiktok-opts');
      ensureCreatorInfo(channel.id, { force: true }).then(() => host?._render?.());
      host?._render?.();
    },
  }, 'refresh'));

  return el('div', { class: 'tiktok-creator' }, [
    avatarNode(channel),
    el('div', {}, [
      el('strong', {}, name),
      handle ? el('small', { class: 'muted' }, ' ' + handle) : null,
      data?.maxVideoPostDurationSec
        ? el('div', { class: 'muted small' }, 'Videos up to ' + data.maxVideoPostDurationSec + 's on this account')
        : null,
    ]),
    el('div', { class: 'tiktok-creator-actions' }, right),
  ]);
}

function tiktokPostModeField(channel, per, mode, setVal) {
  const chanDefault = String(channel.options?.postMode || 'DIRECT_POST').toUpperCase();
  return el('div', { class: 'tiktok-field' }, [
    el('label', { class: 'field-label' }, 'How to post'),
    el('select', {
      onchange: (e) => setVal('postMode', e.target.value),
    }, [
      { value: '', label: '(account default: ' + (isTikTokDraftMode(chanDefault) ? 'send to drafts' : 'publish directly') + ')' },
      { value: 'MEDIA_UPLOAD', label: 'Send to drafts — you finish in the TikTok app' },
      { value: 'DIRECT_POST', label: 'Publish directly from here' },
    ].map((o) => el('option', { value: o.value, selected: (per.postMode ?? '') === o.value }, o.label))),
    el('p', { class: 'muted small' }, isTikTokDraftMode(mode)
      ? 'Safest option: nothing appears on TikTok until you post it yourself in the app.'
      : 'The post goes straight to your TikTok account with the settings below.'),
  ]);
}

/**
 * Chon che do hien thi.
 * TikTok yeu cau: chi liet ke gia tri trong privacy_level_options, va KHONG
 * duoc chon san - nguoi dang phai chu dong chon.
 */
function tiktokPrivacyField(per, data, setVal) {
  const allowed = (data.privacyLevelOptions ?? []).slice();
  const brandContent = Boolean(per.brandContentToggle);
  const audited = Boolean(state.settings?.credentials?.tiktok?.audited);

  // App chua audit thi TikTok CHI nhan SELF_ONLY - cac gia tri khac luon bi tu
  // choi luc dang, du creator_info co tra ve. Loc bot de khong moi nguoi dung
  // chon thu chac chan fail. (Van la tap con cua privacy_level_options nen
  // khong vi pham yeu cau UX cua TikTok.)
  const byAudit = audited ? allowed : allowed.filter((v) => v === 'SELF_ONLY');
  // Branded content khong duoc o che do rieng tu -> bo SELF_ONLY khoi danh sach.
  const usable = brandContent ? byAudit.filter((v) => v !== 'SELF_ONLY') : byAudit;
  // Gia tri dang giu co the khong con trong danh sach (vd vua bat branded content,
  // hoac nap lai bai nhap cu) -> coi nhu chua chon, dung de select hien mot dang
  // ma state giu mot neo.
  const picked = usable.includes(per.privacyLevel) ? per.privacyLevel : '';

  return el('div', { class: 'tiktok-field' }, [
    el('label', { class: 'field-label' }, 'Who can view this post?'),
    el('select', {
      class: picked ? '' : 'needs-pick',
      onchange: (e) => setVal('privacyLevel', e.target.value),
    }, [
      el('option', { value: '', selected: !picked }, '— Select who can view this —'),
      ...usable.map((v) => el('option', {
        value: v, selected: picked === v,
      }, TIKTOK_PRIVACY_LABEL[v] ?? v)),
    ]),
    brandContent && allowed.includes('SELF_ONLY')
      ? el('p', { class: 'muted small' }, '"Only me" is hidden: branded content cannot be private.')
      : null,
    !audited && usable.length > 0
      ? el('p', { class: 'muted small' },
        'This app is not audited yet, so TikTok only accepts "Only me", and your '
        + 'account must be set to private while posting. To publish publicly right '
        + 'away, set How to post to "Send to drafts" and post from the TikTok app.')
      : null,
    !audited && usable.length === 0
      ? el('p', { class: 'tiktok-problem' },
        'An unaudited app can only post "Only me", but that viewership cannot be '
        + 'combined with branded content. Switch How to post to "Send to drafts", or '
        + 'turn off the branded content disclosure.')
      : null,
  ]);
}

/** Comment/Duet/Stitch: khoa lai neu creator da tat o cap tai khoan. */
function tiktokInteractionFields(per, data, setVal) {
  const row = (key, label, accountOff) => {
    const checked = accountOff ? true : Boolean(per[key]);
    return el('label', { class: 'checkbox' + (accountOff ? ' is-locked' : '') }, [
      el('input', {
        type: 'checkbox',
        checked,
        disabled: accountOff,
        onchange: (e) => setVal(key, e.target.checked ? true : ''),
      }),
      label,
      accountOff ? el('small', { class: 'muted' }, ' — turned off in your account settings') : null,
    ]);
  };

  return el('div', { class: 'tiktok-field' }, [
    el('label', { class: 'field-label' }, 'Allow viewers to'),
    el('div', { class: 'tiktok-checks' }, [
      row('disableComment', 'Turn off comments', data.commentDisabled),
      row('disableDuet', 'Turn off Duet', data.duetDisabled),
      row('disableStitch', 'Turn off Stitch', data.stitchDisabled),
    ]),
  ]);
}

/**
 * Khai bao noi dung thuong mai (bat buoc trong UX cua TikTok).
 * brand_organic_toggle = quang ba thuong hieu cua chinh minh.
 * brand_content_toggle = noi dung duoc tra tien boi thuong hieu khac.
 */
function tiktokDisclosureField(per, setVal) {
  const on = Boolean(per.discloseContent || per.brandContentToggle || per.brandOrganicToggle);

  const children = [
    el('label', { class: 'checkbox tiktok-disclose-head' }, [
      el('input', {
        type: 'checkbox', checked: on,
        onchange: (e) => {
          setVal('discloseContent', e.target.checked ? true : '');
          if (!e.target.checked) { setVal('brandContentToggle', ''); setVal('brandOrganicToggle', ''); }
        },
      }),
      'Disclose commercial content',
    ]),
    el('p', { class: 'muted small' },
      'Turn this on if the post promotes a brand, product or service — yours or someone else\u2019s.'),
  ];

  if (on) {
    children.push(el('div', { class: 'tiktok-checks tiktok-disclose-body' }, [
      el('label', { class: 'checkbox' }, [
        el('input', {
          type: 'checkbox', checked: Boolean(per.brandOrganicToggle),
          onchange: (e) => setVal('brandOrganicToggle', e.target.checked ? true : ''),
        }),
        'Your brand',
        el('small', { class: 'muted' }, ' — the post promotes you or your own business'),
      ]),
      el('label', { class: 'checkbox' }, [
        el('input', {
          type: 'checkbox', checked: Boolean(per.brandContentToggle),
          onchange: (e) => {
            const v = e.target.checked;
            setVal('brandContentToggle', v ? true : '');
            // Branded content khong the o che do rieng tu -> bo chon de nguoi dung chon lai.
            if (v && per.privacyLevel === 'SELF_ONLY') setVal('privacyLevel', '');
          },
        }),
        'Branded content',
        el('small', { class: 'muted' }, ' — a third-party brand paid for this post; it will be labelled "Paid partnership"'),
      ]),
    ]));
  }

  return el('div', { class: 'tiktok-field tiktok-disclose' }, children);
}

/** Tuyen bo dong y - TikTok bat buoc hien ngay canh cho bam dang. */
function tiktokConsentText(per) {
  const branded = Boolean(per.brandContentToggle);
  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

  const parts = [document.createTextNode('By posting, you agree to TikTok\u2019s ')];
  if (branded) {
    parts.push(link(TIKTOK_LEGAL.branded, 'Branded Content Policy'));
    parts.push(document.createTextNode(' and '));
  }
  parts.push(link(TIKTOK_LEGAL.music, 'Music Usage Confirmation'));
  parts.push(document.createTextNode('.'));

  return el('p', { class: 'tiktok-consent small' }, parts);
}

/**
 * Kiem tra rang buoc cua TikTok truoc khi cho dang.
 * @returns {string | null} Loi dau tien, hoac null neu hop le.
 */
function tiktokComplianceError(channel, per, data) {
  if (isTikTokDraftMode(tiktokPostMode(channel, per))) return null;

  if (!per.privacyLevel) return 'Select who can view your TikTok post before publishing.';
  if (data && Array.isArray(data.privacyLevelOptions) && data.privacyLevelOptions.length > 0
    && !data.privacyLevelOptions.includes(per.privacyLevel)) {
    return 'The viewership you picked is no longer available on this account — choose again.';
  }
  // Bai nhap luu tu truoc co the con giu gia tri cong khai du app chua audit.
  const audited = Boolean(state.settings?.credentials?.tiktok?.audited);
  if (!audited && per.privacyLevel !== 'SELF_ONLY') {
    return 'This app is not audited yet, so TikTok only accepts "Only me". Choose again, '
      + 'or set How to post to "Send to drafts" and publish publicly from the TikTok app.';
  }

  const disclose = Boolean(per.discloseContent || per.brandContentToggle || per.brandOrganicToggle);
  if (disclose && !per.brandContentToggle && !per.brandOrganicToggle) {
    return 'Commercial content disclosure is on: pick "Your brand", "Branded content", or both.';
  }
  if (per.brandContentToggle && per.privacyLevel === 'SELF_ONLY') {
    return 'Branded content cannot use the "Only me" viewership.';
  }
  return null;
}

/** Tuỳ chọn riêng theo nền tảng (đúng những gì adapter hỗ trợ). */
function platformOptions(channel, per, setVal) {
  const nodes = [];
  const select = (key, label, options, current) => el('div', {}, [
    el('label', { class: 'field-label' }, label),
    el('select', { onchange: (e) => setVal(key, e.target.value) },
      options.map((o) => el('option', { value: o.value, selected: (current ?? '') === o.value }, o.label))),
  ]);
  const check = (key, label, current) => el('label', { class: 'checkbox' }, [
    el('input', { type: 'checkbox', checked: Boolean(current), onchange: (e) => setVal(key, e.target.checked ? true : '') }),
    label,
  ]);
  const number = (key, label, current, placeholder) => el('div', {}, [
    el('label', { class: 'field-label' }, label),
    el('input', {
      type: 'number', value: current ?? '', placeholder: placeholder ?? '',
      oninput: (e) => setVal(key, e.target.value === '' ? '' : Number(e.target.value)),
    }),
  ]);

  switch (channel.platform) {
    case 'youtube':
      nodes.push(select('privacyStatus', 'Visibility', [
        { value: '', label: '(default: private)' },
        { value: 'private', label: 'Private' },
        { value: 'unlisted', label: 'Unlisted' },
        { value: 'public', label: 'Public' },
      ], per.privacyStatus));
      nodes.push(select('categoryId', 'Category', [
        { value: '', label: '(22 — People & Blogs)' },
        { value: '1', label: '1 — Film & Animation' },
        { value: '10', label: '10 — Music' },
        { value: '20', label: '20 — Gaming' },
        { value: '22', label: '22 — People & Blogs' },
        { value: '24', label: '24 — Entertainment' },
        { value: '28', label: '28 — Science & Technology' },
      ], per.categoryId));
      nodes.push(check('madeForKids', 'Made for kids', per.madeForKids));
      nodes.push(check('notifySubscribers', 'Notify subscribers', per.notifySubscribers));
      nodes.push(check('asShort', 'Intended as a Short (warn if it does not qualify)', per.asShort));
      break;

    case 'facebook':
      nodes.push(check('asReel', 'Post as a Reel', per.asReel));
      nodes.push(check('noStory', 'Do not create a feed story', per.noStory));
      nodes.push(select('contentCategory', 'Content category', [
        { value: '', label: '(not set)' },
        ...['BEAUTY_FASHION', 'ENTERTAINMENT', 'LIFESTYLE', 'TECHNOLOGY', 'OTHER']
          .map((v) => ({ value: v, label: v })),
      ], per.contentCategory));
      break;

    case 'instagram':
      nodes.push(select('target', 'Post to', [
        { value: '', label: '(automatic: feed/reel)' },
        { value: 'story', label: 'Stories' },
      ], per.target));
      nodes.push(check('shareToFeed', 'Also show the Reel in the feed', per.shareToFeed));
      nodes.push(number('thumbOffset', 'Cover frame (ms)', per.thumbOffset, '0'));
      break;

    case 'tiktok':
      // Form TikTok phai dung tu creator_info -> xu ly rieng, khong dung helper chung.
      nodes.push(tiktokOptions(channel, setVal));
      break;

    case 'telegram':
      nodes.push(select('parseMode', 'Formatting', [
        { value: '', label: '(HTML — safest)' },
        { value: 'HTML', label: 'HTML' },
        { value: 'MarkdownV2', label: 'MarkdownV2' },
        { value: 'none', label: 'No formatting' },
      ], per.parseMode));
      nodes.push(select('longCaptionMode', 'When the caption exceeds 1024 characters', [
        { value: '', label: '(truncate)' },
        { value: 'split', label: 'Send the remainder as a separate message' },
      ], per.longCaptionMode));
      nodes.push(check('disableNotification', 'Send silently', per.disableNotification));
      nodes.push(check('sendAsDocument', 'Send as the original file (keeps full quality)', per.sendAsDocument));
      break;

    default:
      break;
  }
  return nodes;
}

// ---------------------------------------------------------------- preview

function schedulePreview() {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => void refreshPreview(), 400);
}

async function refreshPreview() {
  const box = $('#preview-list');
  const channelIds = [...state.selectedChannels];
  if (channelIds.length === 0) {
    clear(box).append(el('p', { class: 'muted small' }, 'Pick an account to preview its caption.'));
    return;
  }
  try {
    const { previews } = await api('/api/preview', {
      method: 'POST',
      body: {
        title: $('#in-title').value,
        description: $('#in-description').value,
        hashtags: state.hashtags,
        link: $('#in-link').value || undefined,
        channelIds,
        mediaIds: state.media.map((m) => m.id),
        perChannel: state.perChannel,
      },
    });
    clear(box);
    for (const p of previews) {
      const ch = state.channels.find((c) => c.id === p.channelId);
      box.append(el('div', { class: 'preview-card' }, [
        el('div', { class: 'preview-head' }, [
          ch ? avatarNode(ch) : null,
          p.name,
          el('span', { class: 'pill' },
            `${p.captionLength}${p.captionLimit && Number.isFinite(p.captionLimit) ? `/${p.captionLimit}` : ''}`),
        ]),
        el('pre', { class: 'preview-text' }, p.caption || '(no caption)'),
        p.truncated ? el('p', { class: 'muted small', style: 'margin:6px 0 0' }, '⚠️ Caption was truncated to fit the limit') : null,
        p.droppedHashtags > 0 ? el('p', { class: 'muted small', style: 'margin:4px 0 0' }, `⚠️ Dropped ${p.droppedHashtags} hashtag(s)`) : null,
        p.issues?.length
          ? el('ul', { class: 'preview-issues' }, p.issues.map((i) => el('li', { class: i.level === 'error' ? 'issue-error' : 'issue-warn' }, i.message)))
          : null,
      ]));
    }
  } catch (err) {
    clear(box).append(el('p', { class: 'alert alert-error' }, err.message));
  }
}

// ------------------------------------------------------------ hành động

function composerPayload(extra = {}) {
  commitHashtagInput();
  return {
    title: $('#in-title').value.trim(),
    description: $('#in-description').value.trim(),
    hashtags: state.hashtags,
    link: $('#in-link').value.trim() || undefined,
    mediaIds: state.media.map((m) => m.id),
    channelIds: [...state.selectedChannels],
    perChannel: state.perChannel,
    ...extra,
  };
}

function validateComposer({ needChannels = true } = {}) {
  const p = composerPayload();
  if (!p.title && !p.description && p.mediaIds.length === 0) {
    toast('This post is empty — add a title, a description or media.', { type: 'warn' });
    return null;
  }
  if (needChannels && p.channelIds.length === 0) {
    toast('Select at least one account.', { type: 'warn' });
    return null;
  }

  // TikTok co rang buoc rieng (che do hien thi, khai bao noi dung thuong mai).
  // Chan o day de nguoi dung sua trong form, thay vi an lo loi 403 tu API.
  for (const ch of selectedChannelObjects()) {
    if (ch.platform !== 'tiktok') continue;
    const per = state.perChannel[ch.id] ?? {};
    const info = state.creatorInfo[ch.id];
    const problem = tiktokComplianceError(ch, per, info?.status === 'ok' ? info.data : null);
    if (problem) {
      toast(problem, { type: 'warn', title: 'TikTok — ' + ch.name, hint: 'Open the per-account settings for this TikTok account to fix it.' });
      openPerChannelTab(ch.id);
      return null;
    }
  }
  return p;
}

async function savePost(extra = {}) {
  const payload = validateComposer({ needChannels: Boolean(extra.status === 'queued') });
  if (!payload) return null;
  const body = { ...payload, ...extra };
  const post = state.editingPostId
    ? (await api(`/api/posts/${state.editingPostId}`, { method: 'PATCH', body })).post
    : (await api('/api/posts', { method: 'POST', body })).post;
  state.editingPostId = post.id;
  await reloadPosts();
  return post;
}

async function publishNow() {
  if (state.busy) return;
  const payload = validateComposer();
  if (!payload) return;

  // Bai da dang thanh cong roi thi PHAI tao bai moi, khong duoc dang lai bai cu:
  // no se gui lai len ca cac kenh da thanh cong -> bai trung.
  if (state.editingPostId) {
    const existing = state.posts.find((x) => x.id === state.editingPostId);
    if (existing && ['posted', 'partial'].includes(existing.status)) {
      state.editingPostId = null;
    }
  }

  setBusy(true, '#btn-publish-now', 'Publishing...');
  try {
    const post = await savePost({ status: 'draft', scheduledAt: null });
    if (!post) return;
    const { report } = await api(`/api/posts/${post.id}/publish`, { method: 'POST', body: {} });
    showReport(report);
    if (report.failed.length === 0) {
      toast(`Published to ${report.succeeded.length} account(s).`, { type: 'success', title: 'Done' });
      resetComposer();
    } else {
      // Khong reset: giu noi dung de nguoi dung thu lai cac kenh lỗi.
      state.editingPostId = null;
      toast(`${report.succeeded.length} succeeded, ${report.failed.length} failed.`, {
        type: 'warn',
        hint: 'Use "Retry failed accounts" in the result panel to republish only what did not go through.',
      });
    }
    await reloadPosts();
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Publishing failed', hint: err.hint, timeout: 12000 });
  } finally {
    setBusy(false, '#btn-publish-now', 'Publish now');
  }
}

/**
 * Chan bam hai lan (double submit) tao hai bai dang.
 * @param {boolean} busy
 * @param {string} [sel] Nut dang bam.
 * @param {string} [label]
 */
function setBusy(busy, sel, label) {
  state.busy = busy;
  for (const id of ['#btn-publish-now', '#btn-queue', '#btn-dry-run', '#btn-save-draft']) {
    const b = $(id);
    if (b) b.disabled = busy;
  }
  if (sel && label) {
    const b = $(sel);
    if (b) b.textContent = label;
  }
}

async function dryRun() {
  if (state.busy) return;
  const payload = validateComposer();
  if (!payload) return;
  setBusy(true, '#btn-dry-run', 'Running...');
  try {
    const post = await savePost({ status: 'draft' });
    if (!post) return;
    const { report } = await api(`/api/posts/${post.id}/publish`, { method: 'POST', body: { dryRun: true } });
    showReport(report, { dryRun: true });
    toast('Dry run complete — no platform API was called.', { type: 'info' });
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Dry run failed', hint: err.hint });
  } finally {
    setBusy(false, '#btn-dry-run', 'Dry run');
  }
}

async function queuePost() {
  if (state.busy) return;
  const when = $('#in-schedule').value;
  if (!when) {
    toast('Pick a time to publish first.', { type: 'warn' });
    return;
  }
  const payload = validateComposer();
  if (!payload) return;
  setBusy(true, '#btn-queue', 'Saving...');
  try {
    const post = await savePost({ status: 'queued', scheduledAt: new Date(when).toISOString() });
    if (!post) return;
    toast(`Added to the queue: ${fmtDateTime(post.scheduledAt)} (${fmtRelative(post.scheduledAt)})`, {
      type: 'success',
      title: 'Scheduled',
    });
    resetComposer();
    setView('queue');
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Could not schedule', hint: err.hint });
  } finally {
    setBusy(false, '#btn-queue', 'Add to queue');
  }
}

function resetComposer() {
  $('#in-title').value = '';
  $('#in-description').value = '';
  $('#in-link').value = '';
  $('#in-schedule').value = '';
  state.hashtags = [];
  state.media = [];
  state.perChannel = {};
  state.editingPostId = null;
  renderHashtags();
  renderMedia();
  renderPerChannelTabs();
  updateCounters();
  void refreshPreview();
}

function showReport(report, { dryRun = false } = {}) {
  const failedChannels = report.results.filter((r) => !r.ok && !r.skipped).map((r) => r.channel);
  openModal(dryRun ? 'Dry run result' : 'Publishing result', el('div', {}, [
    el('p', { class: 'muted small' }, `${report.succeeded.length} succeeded · ${report.failed.length} failed · ${report.skipped.length} skipped · ${Math.round(report.durationMs / 100) / 10}s`),
    failedChannels.length > 0 && !dryRun
      ? el('button', {
        class: 'btn btn-primary',
        style: 'margin-bottom:12px',
        onclick: () => {
          // Chi chon lai cac kenh LOI -> dang lai khong lam trung bai o kenh da thanh cong.
          state.selectedChannels = new Set(failedChannels);
          state.editingPostId = null;
          closeModal();
          renderChannelPicker();
          renderPerChannelTabs();
          updateCounters();
          void refreshPreview();
          setView('composer');
          toast(`Selected ${failedChannels.length} failed account(s). Press "Publish now" to retry.`, { type: 'info' });
        },
      }, `Retry ${failedChannels.length} failed account(s)`)
      : null,
    ...report.results.map((r) => {
      const ch = state.channels.find((c) => c.id === r.channel);
      return el('div', { class: 'preview-card' }, [
        el('div', { class: 'preview-head' }, [
          ch ? avatarNode(ch) : null,
          ch?.name ?? r.channel,
          el('span', { class: 'pill' }, r.ok ? (r.skipped ? 'skipped' : 'succeeded') : 'failed'),
        ]),
        r.url ? el('p', { style: 'margin:4px 0' }, [el('a', { href: r.url, target: '_blank', rel: 'noreferrer' }, r.url)]) : null,
        r.preview ? el('pre', { class: 'preview-text' }, r.preview) : null,
        r.reason ? el('p', { class: 'muted small' }, r.reason) : null,
        r.error ? el('div', { class: 'alert alert-error' }, [
          el('div', {}, r.error.message),
          r.error.hint ? el('div', { class: 'small', style: 'margin-top:5px' }, `→ ${r.error.hint}`) : null,
        ]) : null,
      ]);
    }),
  ]));
}

// ============================================================ slots

async function loadSlots() {
  try {
    const { slots } = await api('/api/schedule/slots?count=8');
    const box = clear($('#slot-suggestions'));
    if (!slots?.length) {
      box.append(el('span', { class: 'muted small' }, 'No posting times configured yet (Settings tab).'));
      return;
    }
    box.append(el('span', { class: 'muted small', style: 'align-self:center' }, 'Suggested:'));
    for (const iso of slots) {
      box.append(el('button', {
        type: 'button',
        class: 'slot-btn',
        title: fmtDateTime(iso),
        onclick: () => {
          $('#in-schedule').value = toLocalInput(iso);
        },
      }, `${fmtDateTime(iso)}`));
    }
  } catch {
    // không quan trọng
  }
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ============================================================ posts list

async function reloadPosts() {
  const { posts } = await api('/api/posts?limit=200');
  state.posts = posts;
  renderQueue();
  renderHistory();
  renderSidebar();
}

function renderQueue() {
  const box = clear($('#queue-list'));
  const queued = state.posts
    .filter((p) => p.status === 'queued' || p.status === 'publishing')
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));

  if (queued.length === 0) {
    box.append(el('div', { class: 'empty-state' }, [
      el('span', { class: 'icon' }, '🗓️'),
      el('p', {}, 'The queue is empty.'),
      el('p', { class: 'small' }, 'Compose a post and press "Add to queue" to publish it at the time you pick.'),
    ]));
    return;
  }

  let lastDay = '';
  for (const post of queued) {
    const day = new Date(post.scheduledAt).toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit' });
    if (day !== lastDay) {
      box.append(el('div', { class: 'day-header' }, day));
      lastDay = day;
    }
    box.append(postCard(post, { queue: true }));
  }
}

function renderHistory() {
  const box = clear($('#history-list'));
  const filter = $('#history-filter').value;
  const items = state.posts
    .filter((p) => (filter ? p.status === filter : !['queued', 'publishing'].includes(p.status)))
    .sort((a, b) => String(b.publishedAt ?? b.updatedAt).localeCompare(String(a.publishedAt ?? a.updatedAt)));

  if (items.length === 0) {
    box.append(el('div', { class: 'empty-state' }, [
      el('span', { class: 'icon' }, '📜'),
      el('p', {}, 'Nothing published yet.'),
    ]));
    return;
  }
  for (const post of items) box.append(postCard(post, { history: true }));
}

function postCard(post, { queue = false, history = false } = {}) {
  const channels = post.channelIds.map((id) => state.channels.find((c) => c.id === id)).filter(Boolean);
  const title = post.content?.title || post.content?.description?.slice(0, 70) || '(untitled)';

  const actions = [];
  if (queue) {
    actions.push(el('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        try {
          await api(`/api/posts/${post.id}/publish`, { method: 'POST', body: {} });
          toast('Published.', { type: 'success' });
          await reloadPosts();
        } catch (err) {
          toast(err.message, { type: 'error', hint: err.hint });
        }
      },
    }, 'Publish now'));
  }
  actions.push(el('button', { class: 'btn btn-sm', onclick: () => loadIntoComposer(post) }, 'Edit'));
  if (history) {
    actions.push(el('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        const { post: copy } = await api(`/api/posts/${post.id}/duplicate`, { method: 'POST' });
        loadIntoComposer(copy);
        toast('Duplicate created.', { type: 'info' });
      },
    }, 'Duplicate'));
  }
  actions.push(el('button', {
    class: 'btn btn-sm btn-danger',
    onclick: async () => {
      if (!confirm('Delete this post?')) return;
      await api(`/api/posts/${post.id}`, { method: 'DELETE' });
      await reloadPosts();
    },
  }, 'Delete'));

  const results = post.report?.results ?? [];

  return el('div', { class: `post-card status-${post.status}` }, [
    el('div', {}, [
      el('div', { class: 'post-title' }, title),
      el('div', { class: 'post-meta' }, [
        el('span', { class: `status-tag ${post.status}` }, statusLabel(post.status)),
        post.scheduledAt ? el('span', {}, `🕒 ${fmtDateTime(post.scheduledAt)} (${fmtRelative(post.scheduledAt)})`) : null,
        post.publishedAt ? el('span', {}, `✅ ${fmtDateTime(post.publishedAt)}`) : null,
        post.mediaIds?.length ? el('span', {}, `📎 ${post.mediaIds.length} media`) : null,
        post.attempts > 1 ? el('span', {}, `🔁 ${post.attempts} attempts`) : null,
      ]),
      el('div', { class: 'post-channels' }, channels.map((c) => avatarNode(c))),
      post.note ? el('p', { class: 'muted small', style: 'margin:7px 0 0' }, post.note) : null,
      results.length
        ? el('div', { class: 'post-results' }, results.map((r) => {
          const ch = state.channels.find((c) => c.id === r.channel);
          return el('div', {}, [
            el('div', { class: 'result-row' }, [
              el('span', { class: r.skipped ? 'skip' : (r.ok ? 'ok' : 'fail') }, r.skipped ? '○' : (r.ok ? '✓' : '✕')),
              el('strong', {}, ch?.name ?? r.channel),
              r.url ? el('a', { href: r.url, target: '_blank', rel: 'noreferrer' }, 'view post') : null,
              r.status ? el('span', { class: 'muted small' }, r.status) : null,
              r.error ? el('span', { class: 'fail small' }, r.error.message) : null,
              r.reason ? el('span', { class: 'muted small' }, r.reason) : null,
            ]),
            r.error?.hint ? el('div', { class: 'result-hint' }, `→ ${r.error.hint}`) : null,
          ]);
        }))
        : null,
    ]),
    el('div', { class: 'post-actions' }, actions),
  ]);
}

function statusLabel(status) {
  return {
    draft: 'draft',
    queued: 'queued',
    publishing: 'publishing',
    posted: 'published',
    partial: 'partial',
    failed: 'failed',
    cancelled: 'cancelled',
  }[status] ?? status;
}

async function loadIntoComposer(post) {
  // Nap media TRUOC khi doi state: neu request loi thi khong de composer nua vơi.
  /** @type {any[]} */
  let mediaList = [];
  try {
    const { media } = await api('/api/media');
    mediaList = (post.mediaIds ?? []).map((id) => media.find((m) => m.id === id)).filter(Boolean);
    if (mediaList.length !== (post.mediaIds ?? []).length) {
      toast('Some media from this post is no longer on the server.', { type: 'warn' });
    }
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Could not load this post\u2019s media' });
    return;
  }

  state.editingPostId = post.id;
  $('#in-title').value = post.content?.title ?? '';
  $('#in-description').value = post.content?.description ?? '';
  $('#in-link').value = post.content?.link ?? '';
  state.hashtags = [...(post.content?.hashtags ?? [])];
  state.perChannel = structuredClone(post.perChannel ?? {});
  state.selectedChannels = new Set(post.channelIds ?? []);
  $('#in-schedule').value = post.scheduledAt ? toLocalInput(post.scheduledAt) : '';

  state.media = mediaList;

  renderHashtags();
  renderMedia();
  renderChannelPicker();
  renderPerChannelTabs();
  updateCounters();
  setView('composer');
  void refreshPreview();
  toast('Post loaded into the composer.', { type: 'info' });
}

// ============================================================ nguoi dung

/** Hien ten nguoi dang dang nhap va an cac muc chi danh cho admin. */
function renderCurrentUser() {
  const box = clear($('#current-user'));
  const me = state.me;
  if (!me) return;
  box.append(
    el('strong', {}, me.displayName || me.username),
    el('small', { class: 'muted' }, me.role === 'admin' ? ' · Administrator' : ' · Team member'),
  );
  // An nav admin. Day chi la tien nghi - server van tu chan moi API.
  $$('[data-admin-only]').forEach((nodeEl) => {
    nodeEl.classList.toggle('hidden', !isAdminUser());
  });
  if (me.mustChangePassword) {
    toast('Please change the password your administrator gave you.', {
      type: 'warn', title: 'Set your own password', timeout: 12000,
    });
  }
}

async function changeOwnPassword() {
  const currentPassword = prompt('Current password:');
  if (!currentPassword) return;
  const newPassword = prompt('New password (at least 10 characters):');
  if (!newPassword) return;
  try {
    await api('/api/session/password', { method: 'POST', body: { currentPassword, newPassword } });
    toast('Password changed. Please sign in again.', { type: 'success' });
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Could not change password' });
  }
}

async function reloadUsers() {
  if (!isAdminUser()) return;
  try {
    const { users } = await api('/api/users');
    state.users = users;
    renderTeam();
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Could not load the team' });
  }
}

async function addTeamMember() {
  const username = prompt('Username for the new team member (letters, digits, . _ -):');
  if (!username) return;
  const displayName = prompt('Full name:') || username;
  try {
    const { user, password } = await api('/api/users', {
      method: 'POST',
      body: { username, displayName, role: 'member', canPublish: true, channelIds: [] },
    });
    state.users.push(user);
    renderTeam();
    // Mat khau chi hien DUNG MOT LAN - server khong luu ban ro.
    openModal('Account created', el('div', {}, [
      el('p', {}, `Give ${user.displayName} these details. This password is shown once and cannot be recovered.`),
      el('pre', { class: 'preview-text' }, `username: ${user.username}\npassword: ${password}`),
      el('p', { class: 'muted small' }, 'They will be asked to choose their own password after signing in. Grant them accounts below before they can publish.'),
    ]));
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Could not create the account' });
  }
}

async function patchUser(id, patch) {
  try {
    const { user } = await api(`/api/users/${id}`, { method: 'PATCH', body: patch });
    state.users = state.users.map((u) => (u.id === user.id ? user : u));
    renderTeam();
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Could not update this account' });
    void reloadUsers();
  }
}

function renderTeam() {
  const box = clear($('#user-list'));
  if (state.users.length === 0) {
    box.append(el('p', { class: 'muted' }, 'No team members yet.'));
    return;
  }

  for (const u of state.users) {
    const isMe = u.id === state.me?.id;
    const admin = u.role === 'admin';

    const grants = admin
      ? [el('p', { class: 'muted small' }, 'Administrators can publish to every connected account.')]
      : state.channels.map((ch) => el('label', { class: 'checkbox' }, [
        el('input', {
          type: 'checkbox',
          checked: (u.channelIds ?? []).includes(ch.id),
          onchange: (e) => {
            const next = new Set(u.channelIds ?? []);
            if (e.target.checked) next.add(ch.id); else next.delete(ch.id);
            void patchUser(u.id, { channelIds: [...next] });
          },
        }),
        `${PLATFORM_ICON[ch.platform] ?? ''} ${ch.name}`,
      ]));

    if (!admin && state.channels.length === 0) {
      grants.push(el('p', { class: 'muted small' }, 'No accounts connected yet — connect one on the Channels tab first.'));
    }

    box.append(el('div', { class: `user-card${u.enabled ? '' : ' is-disabled'}` }, [
      el('div', { class: 'user-card-head' }, [
        el('div', {}, [
          el('strong', {}, u.displayName || u.username),
          el('small', { class: 'muted' }, ` @${u.username}`),
          isMe ? el('span', { class: 'pill' }, 'you') : null,
          u.enabled ? null : el('span', { class: 'pill' }, 'disabled'),
        ]),
        el('div', { class: 'user-card-actions' }, [
          el('select', {
            onchange: (e) => void patchUser(u.id, { role: e.target.value }),
            disabled: isMe,
            title: isMe ? 'You cannot change your own role' : 'Role',
          }, [
            el('option', { value: 'member', selected: !admin }, 'Team member'),
            el('option', { value: 'admin', selected: admin }, 'Administrator'),
          ]),
          el('button', {
            class: 'btn btn-sm',
            onclick: async () => {
              if (!confirm(`Reset the password for "${u.username}"?`)) return;
              try {
                const { password } = await api(`/api/users/${u.id}/password`, { method: 'POST', body: {} });
                openModal('New password', el('div', {}, [
                  el('p', {}, `Give this to ${u.displayName}. It is shown once.`),
                  el('pre', { class: 'preview-text' }, `username: ${u.username}\npassword: ${password}`),
                ]));
              } catch (err) {
                toast(err.message, { type: 'error', title: 'Could not reset the password' });
              }
            },
          }, 'Reset password'),
          el('button', {
            class: 'btn btn-sm',
            disabled: isMe,
            onclick: () => void patchUser(u.id, { enabled: !u.enabled }),
          }, u.enabled ? 'Disable' : 'Enable'),
          el('button', {
            class: 'btn btn-sm btn-danger',
            disabled: isMe,
            onclick: async () => {
              if (!confirm(`Remove "${u.username}"? They will be signed out immediately.`)) return;
              try {
                await api(`/api/users/${u.id}`, { method: 'DELETE' });
                state.users = state.users.filter((x) => x.id !== u.id);
                renderTeam();
                toast('Team member removed.', { type: 'info' });
              } catch (err) {
                toast(err.message, { type: 'error', title: 'Could not remove this account' });
              }
            },
          }, 'Remove'),
        ]),
      ]),
      el('label', { class: 'checkbox' }, [
        el('input', {
          type: 'checkbox',
          checked: u.canPublish,
          disabled: admin,
          onchange: (e) => void patchUser(u.id, { canPublish: e.target.checked }),
        }),
        'May publish',
        el('small', { class: 'muted' }, ' — turn off to let them draft posts only'),
      ]),
      el('div', { class: 'user-grants' }, [
        el('label', { class: 'field-label' }, 'Accounts this person may post to'),
        ...grants,
      ]),
      u.lastLoginAt
        ? el('p', { class: 'muted small' }, `Last signed in ${fmtRelative(u.lastLoginAt)}`)
        : el('p', { class: 'muted small' }, 'Has not signed in yet'),
    ]));
  }
}

// ============================================================ audit log

async function reloadAudit() {
  if (!isAdminUser()) return;
  const action = $('#audit-filter')?.value ?? '';
  try {
    const { entries } = await api(`/api/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`);
    state.audit = entries;
    renderAudit();
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Could not load the audit log' });
  }
}

const AUDIT_LABEL = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.password_change': 'Changed password',
  'post.publish': 'Published',
  'channel.connect': 'Connected account',
  'channel.disconnect': 'Disconnected account',
  'user.create': 'Created team member',
  'user.update': 'Changed permissions',
  'user.delete': 'Removed team member',
  'user.reset_password': 'Reset a password',
};

function renderAudit() {
  const body = clear($('#audit-rows'));
  if (state.audit.length === 0) {
    body.append(el('tr', {}, [el('td', { colspan: '6', class: 'muted' }, 'Nothing recorded yet.')]));
    return;
  }
  for (const row of state.audit) {
    body.append(el('tr', { class: row.result === 'fail' ? 'audit-fail' : '' }, [
      el('td', { title: row.at }, fmtRelative(row.at)),
      el('td', {}, row.username ?? '—'),
      el('td', {}, AUDIT_LABEL[row.action] ?? row.action),
      el('td', {}, row.channelId ? channelName(row.channelId) : '—'),
      el('td', {}, el('span', { class: row.result === 'fail' ? 'fail' : 'ok' }, row.result === 'fail' ? 'failed' : 'ok')),
      el('td', { class: 'audit-detail', title: row.detail ?? '' }, row.detail ?? ''),
    ]));
  }
}

// ============================================================ channels view

function renderProviders() {
  const box = clear($('#provider-cards'));
  for (const p of state.providers) {
    const connected = state.channels.filter((c) => p.platforms.includes(c.platform));
    box.append(el('div', { class: 'provider-card' }, [
      el('h3', {}, p.label),
      el('div', {}, [
        el('span', { class: p.configured ? 'tag-configured' : 'tag-not-configured' },
          p.configured ? '● App configured' : '○ Developer app not configured'),
      ]),
      el('p', { class: 'muted small', style: 'margin:6px 0' },
        connected.length ? `${connected.length} account(s) connected` : 'No accounts connected'),
      el('div', { class: 'redirect-box' }, [
        el('span', { title: p.redirectUri }, p.redirectUri),
        el('button', {
          class: 'icon-btn',
          title: 'Copy',
          onclick: () => {
            void navigator.clipboard?.writeText(p.redirectUri);
            toast('Redirect URI copied.', { type: 'info', timeout: 2200 });
          },
        }, '⧉'),
      ]),
      el('p', { class: 'setup-hint' }, p.setupHint),
      el('button', {
        class: 'btn btn-primary btn-block',
        disabled: !p.configured,
        onclick: async () => {
          try {
            const { url } = await api(`/api/oauth/${p.id}/start`, { method: 'POST', body: {} });
            location.href = url;
          } catch (err) {
            toast(err.message, { type: 'error', title: 'Could not open the sign-in page', hint: err.hint });
          }
        },
      }, p.configured ? `Connect ${p.label}` : 'Configure it on the Settings tab first'),
      el('p', { class: 'muted small', style: 'margin-top:8px' }, `Permissions: ${p.scopes.join(', ')}`),
    ]));
  }
}

function renderChannelCards() {
  const box = clear($('#channel-cards'));
  if (state.channels.length === 0) return;

  for (const ch of state.channels) {
    const caps = state.platforms.find((p) => p.platform === ch.platform);
    box.append(el('div', { class: `channel-card${ch.lastError ? ' has-error' : ''}` }, [
      el('div', { class: 'channel-card-head' }, [
        avatarNode(ch, 'lg'),
        el('div', { class: 'who' }, [
          el('strong', {}, ch.name),
          el('span', { class: 'muted small' }, [
            PLATFORM_LABEL[ch.platform] ?? ch.platform,
            ch.username ? ` · @${ch.username}` : '',
          ].join('')),
        ]),
        el('label', { class: 'checkbox', style: 'margin:0' }, [
          el('input', {
            type: 'checkbox',
            checked: ch.enabled,
            title: 'Enable or disable this account',
            onchange: async (e) => {
              await api(`/api/channels/${ch.id}`, { method: 'PATCH', body: { enabled: e.target.checked } });
              await refreshState();
            },
          }),
        ]),
      ]),
      el('div', { class: 'channel-facts' }, [
        el('span', {}, `Connected: ${fmtDateTime(ch.connectedAt)}`),
        ch.lastUsedAt ? el('span', {}, `Last used: ${fmtRelative(ch.lastUsedAt)}`) : null,
        ch.credentials?.target ? el('span', {}, `Target: ${ch.credentials.target}`) : null,
        caps ? el('span', {}, `Supports: ${[caps.text && 'text', caps.image && 'photo', caps.video && 'video', caps.album && 'album'].filter(Boolean).join(', ')}`) : null,
        ch.credentials?.hasRefreshToken ? el('span', {}, '🔑 refresh token saved (renews itself)') : null,
      ]),
      ch.lastError ? el('div', { class: 'channel-error' }, [
        el('strong', {}, 'Last error: '),
        ch.lastError.message,
      ]) : null,
      el('div', { class: 'channel-card-actions' }, [
        el('button', {
          class: 'btn btn-sm',
          onclick: async (e) => {
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = 'Checking...';
            try {
              const { result } = await api(`/api/channels/${ch.id}/verify`, { method: 'POST' });
              if (result.ok) toast(`${ch.name}: credentials are still valid.`, { type: 'success' });
              else toast(result.error ?? 'These credentials no longer work', { type: 'error', title: ch.name, hint: result.hint, timeout: 12000 });
            } finally {
              btn.disabled = false;
              btn.textContent = 'Check';
              await refreshState();
            }
          },
        }, 'Check'),
        el('button', {
          class: 'btn btn-sm',
          disabled: !ch.enabled,
          title: ch.enabled ? '' : 'This account is disabled',
          onclick: () => {
            if (!ch.enabled) return;
            state.selectedChannels.add(ch.id);
            renderChannelPicker();
            renderPerChannelTabs();
            updateCounters();
            void refreshPreview();
            setView('composer');
          },
        }, 'Compose'),
        el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            if (!confirm(`Disconnect "${ch.name}"? Its tokens will be deleted from this computer.`)) return;
            await api(`/api/channels/${ch.id}`, { method: 'DELETE' });
            toast('Disconnected.', { type: 'info' });
            await refreshState();
          },
        }, 'Disconnect'),
      ]),
    ]));
  }
}

async function connectTelegram(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const { channel } = await api('/api/channels/telegram', {
      method: 'POST',
      body: { botToken: $('#tg-token').value.trim(), chatId: $('#tg-chat').value.trim() },
    });
    toast(`Connected "${channel.name}".`, { type: 'success' });
    $('#tg-token').value = '';
    $('#tg-chat').value = '';
    await refreshState();
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Could not connect Telegram', hint: err.hint, timeout: 12000 });
  } finally {
    btn.disabled = false;
  }
}

async function verifyAll() {
  toast('Checking every account...', { type: 'info', timeout: 2500 });
  try {
    const { results } = await api('/api/channels/verify', { method: 'POST' });
    const bad = Object.entries(results).filter(([, r]) => !r.ok);
    if (bad.length === 0) toast('Every account is working.', { type: 'success' });
    else {
      for (const [id, r] of bad) {
        const ch = state.channels.find((c) => c.id === id);
        toast(r.error ?? 'error', { type: 'error', title: ch?.name ?? id, hint: r.hint, timeout: 14000 });
      }
    }
    await refreshState();
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

// ============================================================ settings

function fillSettings() {
  const s = state.settings;
  if (!s) return;
  // Dang go giua form Cai dat thi khong ghi de (refreshState co the chay bat ky luc nao).
  if (state.view === 'settings' && $('#view-settings')?.contains(document.activeElement)) {
    return;
  }
  $('#set-timezone').value = s.timezone ?? '';
  $('#set-times').value = (s.postingTimes ?? []).join('\n');
  $('#set-concurrency').value = s.publishing?.concurrency ?? 3;
  $('#set-retries').value = s.publishing?.retries ?? 3;

  const box = clear($('#credentials-form'));
  for (const p of state.providers) {
    box.append(el('h3', { style: 'margin-top:14px' }, p.label));
    for (const f of p.credentialFields) {
      if (f.type === 'boolean') {
        box.append(el('label', { class: 'checkbox' }, [
          el('input', {
            type: 'checkbox',
            id: `cred-${p.id}-${f.key}`,
            checked: Boolean(s.credentials?.[p.id]?.[f.key]),
          }),
          f.label,
        ]));
        if (f.key === 'audited') {
          box.append(el('p', { class: 'muted small' },
            'Leave this off while your app is unaudited: TikTok then only accepts the '
            + '"Only me" viewership, and your account must be private while posting. '
            + 'Turn it on once TikTok approves the app and public posting is allowed.'));
        }
        continue;
      }
      box.append(el('label', { class: 'field-label' }, f.label));
      box.append(el('input', {
        type: f.secret ? 'password' : 'text',
        id: `cred-${p.id}-${f.key}`,
        value: s.credentials?.[p.id]?.[f.key] ?? '',
        placeholder: f.secret ? '(leave empty to keep the saved value)' : f.label,
      }));
      if (f.key === 'redirectUri') {
        box.append(el('p', { class: 'muted small' },
          'Leave empty and the app uses the address you opened this page on. Set a value '
          + 'when the platform rejects an http://127.0.0.1 callback — TikTok requires https '
          + 'in production, while a Sandbox app accepts http too.'));
      }
    }
  }

  const mh = s.mediaHost ?? { type: 'none' };
  $('#mh-type').value = mh.type ?? 'none';
  $('#mh-s3').classList.toggle('hidden', mh.type !== 's3');
  $('#mh-tunnel').classList.toggle('hidden', mh.type !== 'tunnel');
  $('#s3-bucket').value = mh.s3?.bucket ?? '';
  $('#s3-region').value = mh.s3?.region ?? 'auto';
  $('#s3-endpoint').value = mh.s3?.endpoint ?? '';
  $('#s3-key').value = mh.s3?.accessKeyId ?? '';
  $('#s3-secret').value = mh.s3?.secretAccessKey ?? '';
  $('#s3-public').value = mh.s3?.publicBaseUrl ?? '';
  $('#s3-pathstyle').checked = Boolean(mh.s3?.forcePathStyle);
  $('#tunnel-url').value = mh.tunnel?.publicBaseUrl ?? '';
  $('#tunnel-port').value = mh.tunnel?.port ?? 8787;
}

async function saveSettings() {
  const credentials = {};
  for (const p of state.providers) {
    credentials[p.id] = {};
    for (const f of p.credentialFields) {
      const node = $(`#cred-${p.id}-${f.key}`);
      if (f.type === 'boolean') {
        credentials[p.id][f.key] = Boolean(node?.checked);
        continue;
      }
      const v = node?.value ?? '';
      // Field bi mat de trong = khong doi. Field thuong gui ca chuoi rong de xoa duoc.
      if (v || !f.secret) credentials[p.id][f.key] = v;
    }
  }
  const body = {
    timezone: $('#set-timezone').value.trim() || 'Asia/Ho_Chi_Minh',
    postingTimes: $('#set-times').value.split('\n').map((t) => t.trim()).filter(Boolean),
    credentials,
    publishing: {
      concurrency: Number($('#set-concurrency').value) || 3,
      retries: Number($('#set-retries').value) || 3,
    },
    mediaHost: {
      type: $('#mh-type').value,
      s3: {
        bucket: $('#s3-bucket').value.trim(),
        region: $('#s3-region').value.trim() || 'auto',
        endpoint: $('#s3-endpoint').value.trim(),
        accessKeyId: $('#s3-key').value.trim(),
        secretAccessKey: $('#s3-secret').value,
        publicBaseUrl: $('#s3-public').value.trim(),
        forcePathStyle: $('#s3-pathstyle').checked,
      },
      tunnel: {
        publicBaseUrl: $('#tunnel-url').value.trim(),
        port: Number($('#tunnel-port').value) || 8787,
      },
    },
  };
  try {
    const { settings } = await api('/api/settings', { method: 'PUT', body });
    state.settings = settings;
    toast('Settings saved.', { type: 'success' });
    await refreshState();
  } catch (err) {
    toast(err.message, { type: 'error', hint: err.hint });
  }
}

// ============================================================ SSE + activity

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data));
    } catch {
      // bỏ qua
    }
  };
  es.onerror = () => {
    // EventSource tự kết nối lại; chỉ ghi nhận.
    pushActivity({ level: 'warn', msg: 'Event stream disconnected, retrying...' });
  };
}

function handleEvent(evt) {
  const { type, data, at } = evt;
  switch (type) {
    case 'log':
      pushActivity({ level: data.level, msg: data.msg, meta: data.meta, at });
      break;
    case 'channel:start':
      pushActivity({ level: 'info', msg: `→ sending to ${channelName(data.channelId)}`, at });
      break;
    case 'channel:done':
      pushActivity({ level: 'ok', msg: `✓ ${channelName(data.channelId)}${data.url ? ` — ${data.url}` : ''}`, at });
      break;
    case 'channel:error':
      pushActivity({ level: 'error', msg: `✕ ${channelName(data.channelId)}: ${data.message}`, at });
      break;
    case 'post:done':
      pushActivity({ level: data.failed?.length ? 'warn' : 'ok', msg: `Done: ${data.succeeded.length} succeeded, ${data.failed.length} failed`, at });
      void reloadPosts();
      break;
    case 'post:retry':
      pushActivity({ level: 'warn', msg: `Rescheduled: ${data.message}`, at });
      void reloadPosts();
      break;
    case 'channels:changed':
      void refreshState();
      break;
    case 'posts:changed':
      break;
    default:
      break;
  }
}

function channelName(id) {
  return state.channels.find((c) => c.id === id)?.name ?? id;
}

function pushActivity(entry) {
  state.activity.push(entry);
  if (state.activity.length > 200) state.activity.shift();
  renderActivity();
}

function renderActivity() {
  const box = $('#activity');
  if (!box) return;
  clear(box);
  for (const a of state.activity.slice(-60)) {
    const cls = a.level === 'error' ? 'error' : a.level === 'warn' ? 'warn' : a.level === 'ok' ? 'ok' : '';
    box.append(el('div', { class: `activity-line ${cls}`.trim() }, [
      el('span', { class: 't' }, new Date(a.at ?? Date.now()).toLocaleTimeString('vi-VN')),
      a.msg,
    ]));
  }
  box.scrollTop = box.scrollHeight;
}

// ============================================================ modal

function openModal(title, content) {
  $('#modal-title').textContent = title;
  clear($('#modal-body')).append(content);
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
}

// ============================================================ start

boot().catch((err) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">
    <h1>The interface failed to start</h1>
    <pre style="white-space:pre-wrap">${String(err?.stack ?? err)}</pre>
  </div>`;
});
