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
  activeTab: null,
  editingPostId: null,
  previewTimer: null,
  activity: [],
  busy: false,
  sessionExpired: false,
};

/** Cac view hop le (dung cho dieu huong bang hash). */
const VIEWS = ['composer', 'queue', 'channels', 'history', 'settings'];

const PLATFORM_ICON = {
  youtube: '▶️',
  facebook: 'f',
  instagram: '◉',
  tiktok: '♪',
  telegram: '✈️',
};

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
  if (mins < 1) return diff >= 0 ? 'ngay bây giờ' : 'vừa xong';
  if (mins < 60) return diff >= 0 ? `sau ${mins} phút` : `${mins} phút trước`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diff >= 0 ? `sau ${hours} giờ` : `${hours} giờ trước`;
  const days = Math.round(hours / 24);
  return diff >= 0 ? `sau ${days} ngày` : `${days} ngày trước`;
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
      toast('Phiên đăng nhập đã hết hạn.', { type: 'warn', title: 'Cần đăng nhập lại' });
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
        const err = new Error(data.error || `Upload lỗi (HTTP ${xhr.status})`);
        err.hint = data.hint;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('Mất kết nối khi upload'));
    xhr.send(file);
  });
}

// ============================================================ khởi động

async function boot() {
  // Thông báo từ OAuth callback (?ok=... / ?error=...)
  const params = new URLSearchParams(location.search);
  if (params.get('ok')) toast(params.get('ok'), { type: 'success', title: 'Kết nối thành công' });
  if (params.get('error')) toast(params.get('error'), { type: 'error', title: 'Kết nối thất bại', timeout: 12000 });
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
      await api('/api/session', { method: 'POST', body: { token: $('#login-token').value } });
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
  state.channels = data.channels;
  state.platforms = data.platforms;
  state.providers = data.providers;
  state.settings = data.settings;
  state.posts = data.posts;
  state.scheduler = data.scheduler;

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
  state.view = view;
  location.hash = view;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`)?.classList.remove('hidden');
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'queue' || view === 'history') void reloadPosts();
  if (view === 'channels') renderChannelCards();
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
    toast('Đang chạy scheduler...', { type: 'info' });
    const r = await api('/api/scheduler/tick', { method: 'POST' });
    toast(`Đã đăng ${r.result.published}, lỗi ${r.result.failed}`, { type: r.result.failed ? 'warn' : 'success' });
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
    box.append(el('p', { class: 'muted small', style: 'padding:0 6px' }, 'Chưa kết nối kênh nào.'));
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
    `Scheduler ${s?.running ? 'đang chạy' : 'đã dừng'}`,
  );
  if (s?.lastTickAt) box.append(el('div', {}, `Kiểm tra: ${fmtRelative(s.lastTickAt)}`));
  renderSchedulerButton();
}

function renderSchedulerButton() {
  const btn = $('#btn-toggle-scheduler');
  if (btn) btn.textContent = state.scheduler?.running ? 'Tạm dừng' : 'Bật lại';
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
      title: ch.enabled ? '' : 'Kênh đang bị tắt',
      onclick: () => {
        if (!ch.enabled) {
          toast('Kênh đang bị tắt. Bật lại ở tab Kênh.', { type: 'warn' });
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
  titleBox.append(el('span', {}, `${title.length} ký tự`));
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
  descBox.append(el('span', {}, `Caption ghép: ${caption.length} ký tự`));
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
        title: 'Xoá',
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
      el('div', { class: 'media-meta' }, [el('span', { class: 'fname' }, file.name), el('span', {}, 'đang tải...')]),
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
      toast(err.message, { type: 'error', title: `Không tải được ${file.name}`, hint: err.hint });
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
        title: 'Bỏ khỏi bài',
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
    el('p', { class: 'muted small' }, `Để trống = dùng nội dung chung. Áp dụng riêng cho ${channel.name}.`),
    el('label', { class: 'field-label' }, 'Tiêu đề riêng'),
    el('input', {
      type: 'text',
      value: per.title ?? '',
      placeholder: $('#in-title').value || 'Tiêu đề riêng cho kênh này',
      oninput: (e) => setVal('title', e.target.value),
    }),
    el('label', { class: 'field-label' }, 'Nội dung riêng'),
    el('textarea', {
      rows: 4,
      placeholder: 'Nội dung riêng cho kênh này',
      oninput: (e) => setVal('description', e.target.value),
    }, per.description ?? ''),
    el('label', { class: 'field-label' }, 'Hashtag riêng (cách nhau bởi dấu phẩy)'),
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

  box.append(el('label', { class: 'field-label' }, 'Tuỳ chọn nền tảng'));
  box.append(el('div', { class: 'opt-grid' }, platformOptions(channel, per, setVal)));
}

// ------------------------------------------------------------------- TikTok

/**
 * Nhan hien thi cho tung privacy_level. Danh sach THUC TE luon lay tu
 * creator_info.privacy_level_options - bang nay chi de dich sang tieng Viet.
 */
const TIKTOK_PRIVACY_LABEL = {
  PUBLIC_TO_EVERYONE: 'Công khai — mọi người',
  MUTUAL_FOLLOW_FRIENDS: 'Bạn bè — người theo dõi lẫn nhau',
  FOLLOWER_OF_CREATOR: 'Người theo dõi',
  SELF_ONLY: 'Chỉ mình tôi — riêng tư',
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
        'Video/ảnh sẽ vào mục nháp trong app TikTok. Bạn tự chọn chế độ hiển thị, '
        + 'âm thanh và khai báo nội dung ngay trong app trước khi đăng.'));
      return;
    }

    // Tu day tro xuong la Direct Post -> can creator_info moi dung form duoc.
    if (info?.status !== 'ok') {
      box.append(el('p', { class: 'tiktok-note muted small' },
        info?.status === 'loading'
          ? 'Đang lấy thiết lập tài khoản từ TikTok...'
          : 'Chưa lấy được thiết lập tài khoản từ TikTok nên chưa dựng được form đăng trực tiếp.'));
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
  if (info?.status === 'loading') right.push(el('span', { class: 'muted small' }, 'đang tải...'));
  else if (info?.status === 'error') right.push(el('span', { class: 'tiktok-problem small' }, info.error));
  right.push(el('button', {
    type: 'button', class: 'link-btn', title: 'Lấy lại thiết lập mới nhất từ TikTok',
    onclick: (e) => {
      const host = e.target.closest('.tiktok-opts');
      ensureCreatorInfo(channel.id, { force: true }).then(() => host?._render?.());
      host?._render?.();
    },
  }, 'làm mới'));

  return el('div', { class: 'tiktok-creator' }, [
    avatarNode(channel),
    el('div', {}, [
      el('strong', {}, name),
      handle ? el('small', { class: 'muted' }, ' ' + handle) : null,
      data?.maxVideoPostDurationSec
        ? el('div', { class: 'muted small' }, 'Video tối đa ' + data.maxVideoPostDurationSec + 's cho tài khoản này')
        : null,
    ]),
    el('div', { class: 'tiktok-creator-actions' }, right),
  ]);
}

function tiktokPostModeField(channel, per, mode, setVal) {
  const chanDefault = String(channel.options?.postMode || 'DIRECT_POST').toUpperCase();
  return el('div', { class: 'tiktok-field' }, [
    el('label', { class: 'field-label' }, 'Kiểu đăng'),
    el('select', {
      onchange: (e) => setVal('postMode', e.target.value),
    }, [
      { value: '', label: '(theo kênh: ' + (isTikTokDraftMode(chanDefault) ? 'gửi vào nháp' : 'đăng trực tiếp') + ')' },
      { value: 'MEDIA_UPLOAD', label: 'Gửi vào nháp — bạn hoàn tất trong app TikTok' },
      { value: 'DIRECT_POST', label: 'Đăng trực tiếp từ đây' },
    ].map((o) => el('option', { value: o.value, selected: (per.postMode ?? '') === o.value }, o.label))),
    el('p', { class: 'muted small' }, isTikTokDraftMode(mode)
      ? 'An toàn nhất: không có gì lên TikTok cho đến khi bạn bấm đăng trong app.'
      : 'Bài sẽ lên thẳng tài khoản TikTok với thiết lập bên dưới.'),
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
    el('label', { class: 'field-label' }, 'Ai xem được bài này?'),
    el('select', {
      class: picked ? '' : 'needs-pick',
      onchange: (e) => setVal('privacyLevel', e.target.value),
    }, [
      el('option', { value: '', selected: !picked }, '— Chọn chế độ hiển thị —'),
      ...usable.map((v) => el('option', {
        value: v, selected: picked === v,
      }, TIKTOK_PRIVACY_LABEL[v] ?? v)),
    ]),
    brandContent && allowed.includes('SELF_ONLY')
      ? el('p', { class: 'muted small' }, 'Đã ẩn "Chỉ mình tôi": nội dung thương mại không được để riêng tư.')
      : null,
    !audited && usable.length > 0
      ? el('p', { class: 'muted small' },
        'App chưa qua audit nên TikTok chỉ nhận "Chỉ mình tôi", và tài khoản phải '
        + 'đang ở chế độ private lúc đăng. Muốn lên công khai ngay thì chọn '
        + 'Kiểu đăng "Gửi vào nháp" rồi tự đăng trong app TikTok.')
      : null,
    !audited && usable.length === 0
      ? el('p', { class: 'tiktok-problem' },
        'App chưa audit chỉ đăng được "Chỉ mình tôi", nhưng chế độ đó lại không dùng '
        + 'được cùng nội dung có tài trợ. Chuyển Kiểu đăng sang "Gửi vào nháp", hoặc '
        + 'tắt khai báo tài trợ.')
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
      accountOff ? el('small', { class: 'muted' }, ' — đã tắt trong cài đặt tài khoản') : null,
    ]);
  };

  return el('div', { class: 'tiktok-field' }, [
    el('label', { class: 'field-label' }, 'Cho phép người xem'),
    el('div', { class: 'tiktok-checks' }, [
      row('disableComment', 'Tắt bình luận', data.commentDisabled),
      row('disableDuet', 'Tắt Duet', data.duetDisabled),
      row('disableStitch', 'Tắt Stitch', data.stitchDisabled),
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
      'Khai báo nội dung thương mại',
    ]),
    el('p', { class: 'muted small' },
      'Bật nếu bài này quảng bá thương hiệu, sản phẩm hoặc dịch vụ — của bạn hoặc của người khác.'),
  ];

  if (on) {
    children.push(el('div', { class: 'tiktok-checks tiktok-disclose-body' }, [
      el('label', { class: 'checkbox' }, [
        el('input', {
          type: 'checkbox', checked: Boolean(per.brandOrganicToggle),
          onchange: (e) => setVal('brandOrganicToggle', e.target.checked ? true : ''),
        }),
        'Thương hiệu của tôi',
        el('small', { class: 'muted' }, ' — bài quảng bá chính bạn hoặc doanh nghiệp của bạn'),
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
        'Nội dung có tài trợ',
        el('small', { class: 'muted' }, ' — bài được thương hiệu khác trả tiền, sẽ gắn nhãn "Paid partnership"'),
      ]),
    ]));
  }

  return el('div', { class: 'tiktok-field tiktok-disclose' }, children);
}

/** Tuyen bo dong y - TikTok bat buoc hien ngay canh cho bam dang. */
function tiktokConsentText(per) {
  const branded = Boolean(per.brandContentToggle);
  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

  const parts = [document.createTextNode('Khi bấm đăng, bạn đồng ý với ')];
  if (branded) {
    parts.push(link(TIKTOK_LEGAL.branded, 'Chính sách nội dung có thương hiệu'));
    parts.push(document.createTextNode(' và '));
  }
  parts.push(link(TIKTOK_LEGAL.music, 'Xác nhận sử dụng âm nhạc'));
  parts.push(document.createTextNode(' của TikTok.'));

  return el('p', { class: 'tiktok-consent small' }, parts);
}

/**
 * Kiem tra rang buoc cua TikTok truoc khi cho dang.
 * @returns {string | null} Loi dau tien, hoac null neu hop le.
 */
function tiktokComplianceError(channel, per, data) {
  if (isTikTokDraftMode(tiktokPostMode(channel, per))) return null;

  if (!per.privacyLevel) return 'Chọn chế độ hiển thị cho TikTok trước khi đăng.';
  if (data && Array.isArray(data.privacyLevelOptions) && data.privacyLevelOptions.length > 0
    && !data.privacyLevelOptions.includes(per.privacyLevel)) {
    return 'Chế độ hiển thị đã chọn không còn khả dụng cho tài khoản này — chọn lại.';
  }
  // Bai nhap luu tu truoc co the con giu gia tri cong khai du app chua audit.
  const audited = Boolean(state.settings?.credentials?.tiktok?.audited);
  if (!audited && per.privacyLevel !== 'SELF_ONLY') {
    return 'App chưa qua audit nên TikTok chỉ nhận "Chỉ mình tôi". Chọn lại, hoặc '
      + 'chuyển Kiểu đăng sang "Gửi vào nháp" để tự đăng công khai trong app TikTok.';
  }

  const disclose = Boolean(per.discloseContent || per.brandContentToggle || per.brandOrganicToggle);
  if (disclose && !per.brandContentToggle && !per.brandOrganicToggle) {
    return 'Đã bật khai báo nội dung thương mại: chọn "Thương hiệu của tôi", "Nội dung có tài trợ", hoặc cả hai.';
  }
  if (per.brandContentToggle && per.privacyLevel === 'SELF_ONLY') {
    return 'Nội dung có tài trợ không được đặt ở chế độ "Chỉ mình tôi".';
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
      nodes.push(select('privacyStatus', 'Chế độ hiển thị', [
        { value: '', label: '(mặc định: private)' },
        { value: 'private', label: 'Riêng tư' },
        { value: 'unlisted', label: 'Không công khai' },
        { value: 'public', label: 'Công khai' },
      ], per.privacyStatus));
      nodes.push(select('categoryId', 'Danh mục', [
        { value: '', label: '(22 — People & Blogs)' },
        { value: '1', label: '1 — Film & Animation' },
        { value: '10', label: '10 — Music' },
        { value: '20', label: '20 — Gaming' },
        { value: '22', label: '22 — People & Blogs' },
        { value: '24', label: '24 — Entertainment' },
        { value: '28', label: '28 — Science & Technology' },
      ], per.categoryId));
      nodes.push(check('madeForKids', 'Nội dung cho trẻ em', per.madeForKids));
      nodes.push(check('notifySubscribers', 'Thông báo cho người đăng ký', per.notifySubscribers));
      nodes.push(check('asShort', 'Chủ đích là Shorts (cảnh báo nếu không đạt)', per.asShort));
      break;

    case 'facebook':
      nodes.push(check('asReel', 'Đăng dạng Reel', per.asReel));
      nodes.push(check('noStory', 'Không tạo story trên feed', per.noStory));
      nodes.push(select('contentCategory', 'Danh mục nội dung', [
        { value: '', label: '(không đặt)' },
        ...['BEAUTY_FASHION', 'ENTERTAINMENT', 'LIFESTYLE', 'TECHNOLOGY', 'OTHER']
          .map((v) => ({ value: v, label: v })),
      ], per.contentCategory));
      break;

    case 'instagram':
      nodes.push(select('target', 'Đăng vào', [
        { value: '', label: '(tự động: feed/reel)' },
        { value: 'story', label: 'Stories' },
      ], per.target));
      nodes.push(check('shareToFeed', 'Reel cũng hiện ở feed', per.shareToFeed));
      nodes.push(number('thumbOffset', 'Mốc ảnh bìa (ms)', per.thumbOffset, '0'));
      break;

    case 'tiktok':
      // Form TikTok phai dung tu creator_info -> xu ly rieng, khong dung helper chung.
      nodes.push(tiktokOptions(channel, setVal));
      break;

    case 'telegram':
      nodes.push(select('parseMode', 'Định dạng', [
        { value: '', label: '(HTML — an toàn nhất)' },
        { value: 'HTML', label: 'HTML' },
        { value: 'MarkdownV2', label: 'MarkdownV2' },
        { value: 'none', label: 'Không định dạng' },
      ], per.parseMode));
      nodes.push(select('longCaptionMode', 'Khi caption quá 1024 ký tự', [
        { value: '', label: '(cắt bớt)' },
        { value: 'split', label: 'Gửi phần còn lại thành tin nhắn riêng' },
      ], per.longCaptionMode));
      nodes.push(check('disableNotification', 'Gửi im lặng', per.disableNotification));
      nodes.push(check('sendAsDocument', 'Gửi dạng file gốc (giữ nguyên chất lượng)', per.sendAsDocument));
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
    clear(box).append(el('p', { class: 'muted small' }, 'Chọn kênh để xem trước caption từng nơi.'));
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
        el('pre', { class: 'preview-text' }, p.caption || '(không có caption)'),
        p.truncated ? el('p', { class: 'muted small', style: 'margin:6px 0 0' }, '⚠️ Caption bị cắt cho vừa giới hạn') : null,
        p.droppedHashtags > 0 ? el('p', { class: 'muted small', style: 'margin:4px 0 0' }, `⚠️ Bỏ ${p.droppedHashtags} hashtag`) : null,
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
    toast('Bài đăng đang trống: cần tiêu đề, nội dung hoặc media.', { type: 'warn' });
    return null;
  }
  if (needChannels && p.channelIds.length === 0) {
    toast('Chọn ít nhất một kênh.', { type: 'warn' });
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
      toast(problem, { type: 'warn', title: 'TikTok — ' + ch.name, hint: 'Mở phần tuỳ chọn riêng của kênh TikTok để sửa.' });
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

  setBusy(true, '#btn-publish-now', 'Đang đăng...');
  try {
    const post = await savePost({ status: 'draft', scheduledAt: null });
    if (!post) return;
    const { report } = await api(`/api/posts/${post.id}/publish`, { method: 'POST', body: {} });
    showReport(report);
    if (report.failed.length === 0) {
      toast(`Đã đăng lên ${report.succeeded.length} kênh.`, { type: 'success', title: 'Xong' });
      resetComposer();
    } else {
      // Khong reset: giu noi dung de nguoi dung thu lai cac kenh lỗi.
      state.editingPostId = null;
      toast(`Thành công ${report.succeeded.length}, thất bại ${report.failed.length}.`, {
        type: 'warn',
        hint: 'Bấm "Thử lại kênh lỗi" trong bảng kết quả để chỉ đăng lại phần chưa thành công.',
      });
    }
    await reloadPosts();
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Đăng thất bại', hint: err.hint, timeout: 12000 });
  } finally {
    setBusy(false, '#btn-publish-now', 'Đăng ngay');
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
  setBusy(true, '#btn-dry-run', 'Đang chạy...');
  try {
    const post = await savePost({ status: 'draft' });
    if (!post) return;
    const { report } = await api(`/api/posts/${post.id}/publish`, { method: 'POST', body: { dryRun: true } });
    showReport(report, { dryRun: true });
    toast('Chạy thử xong — không gọi API nền tảng nào.', { type: 'info' });
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Chạy thử lỗi', hint: err.hint });
  } finally {
    setBusy(false, '#btn-dry-run', 'Chạy thử');
  }
}

async function queuePost() {
  if (state.busy) return;
  const when = $('#in-schedule').value;
  if (!when) {
    toast('Chọn thời điểm đăng trước.', { type: 'warn' });
    return;
  }
  const payload = validateComposer();
  if (!payload) return;
  setBusy(true, '#btn-queue', 'Đang lưu...');
  try {
    const post = await savePost({ status: 'queued', scheduledAt: new Date(when).toISOString() });
    if (!post) return;
    toast(`Đã thêm vào hàng đợi: ${fmtDateTime(post.scheduledAt)} (${fmtRelative(post.scheduledAt)})`, {
      type: 'success',
      title: 'Đã lên lịch',
    });
    resetComposer();
    setView('queue');
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Không lên lịch được', hint: err.hint });
  } finally {
    setBusy(false, '#btn-queue', 'Thêm vào hàng đợi');
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
  openModal(dryRun ? 'Kết quả chạy thử' : 'Kết quả đăng bài', el('div', {}, [
    el('p', { class: 'muted small' }, `${report.succeeded.length} thành công · ${report.failed.length} thất bại · ${report.skipped.length} bỏ qua · ${Math.round(report.durationMs / 100) / 10}s`),
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
          toast(`Đã chọn ${failedChannels.length} kênh lỗi. Bấm "Đăng ngay" để thử lại.`, { type: 'info' });
        },
      }, `Thử lại ${failedChannels.length} kênh lỗi`)
      : null,
    ...report.results.map((r) => {
      const ch = state.channels.find((c) => c.id === r.channel);
      return el('div', { class: 'preview-card' }, [
        el('div', { class: 'preview-head' }, [
          ch ? avatarNode(ch) : null,
          ch?.name ?? r.channel,
          el('span', { class: 'pill' }, r.ok ? (r.skipped ? 'bỏ qua' : 'thành công') : 'lỗi'),
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
      box.append(el('span', { class: 'muted small' }, 'Chưa cấu hình khung giờ đăng (tab Cài đặt).'));
      return;
    }
    box.append(el('span', { class: 'muted small', style: 'align-self:center' }, 'Gợi ý:'));
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
      el('p', {}, 'Hàng đợi trống.'),
      el('p', { class: 'small' }, 'Soạn bài rồi bấm "Thêm vào hàng đợi" để tự đăng đúng giờ.'),
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
      el('p', {}, 'Chưa có bài nào.'),
    ]));
    return;
  }
  for (const post of items) box.append(postCard(post, { history: true }));
}

function postCard(post, { queue = false, history = false } = {}) {
  const channels = post.channelIds.map((id) => state.channels.find((c) => c.id === id)).filter(Boolean);
  const title = post.content?.title || post.content?.description?.slice(0, 70) || '(không có tiêu đề)';

  const actions = [];
  if (queue) {
    actions.push(el('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        try {
          await api(`/api/posts/${post.id}/publish`, { method: 'POST', body: {} });
          toast('Đã đăng.', { type: 'success' });
          await reloadPosts();
        } catch (err) {
          toast(err.message, { type: 'error', hint: err.hint });
        }
      },
    }, 'Đăng ngay'));
  }
  actions.push(el('button', { class: 'btn btn-sm', onclick: () => loadIntoComposer(post) }, 'Sửa'));
  if (history) {
    actions.push(el('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        const { post: copy } = await api(`/api/posts/${post.id}/duplicate`, { method: 'POST' });
        loadIntoComposer(copy);
        toast('Đã tạo bản sao.', { type: 'info' });
      },
    }, 'Nhân bản'));
  }
  actions.push(el('button', {
    class: 'btn btn-sm btn-danger',
    onclick: async () => {
      if (!confirm('Xoá bài đăng này?')) return;
      await api(`/api/posts/${post.id}`, { method: 'DELETE' });
      await reloadPosts();
    },
  }, 'Xoá'));

  const results = post.report?.results ?? [];

  return el('div', { class: `post-card status-${post.status}` }, [
    el('div', {}, [
      el('div', { class: 'post-title' }, title),
      el('div', { class: 'post-meta' }, [
        el('span', { class: `status-tag ${post.status}` }, statusLabel(post.status)),
        post.scheduledAt ? el('span', {}, `🕒 ${fmtDateTime(post.scheduledAt)} (${fmtRelative(post.scheduledAt)})`) : null,
        post.publishedAt ? el('span', {}, `✅ ${fmtDateTime(post.publishedAt)}`) : null,
        post.mediaIds?.length ? el('span', {}, `📎 ${post.mediaIds.length} media`) : null,
        post.attempts > 1 ? el('span', {}, `🔁 thử ${post.attempts} lần`) : null,
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
              r.url ? el('a', { href: r.url, target: '_blank', rel: 'noreferrer' }, 'xem bài') : null,
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
    draft: 'nháp',
    queued: 'chờ đăng',
    publishing: 'đang đăng',
    posted: 'đã đăng',
    partial: 'một phần',
    failed: 'thất bại',
    cancelled: 'đã huỷ',
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
      toast('Một số media của bài này đã bị xoá khỏi server.', { type: 'warn' });
    }
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Không nạp được media của bài' });
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
  toast('Đã nạp bài vào trình soạn.', { type: 'info' });
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
          p.configured ? '● Đã cấu hình app' : '○ Chưa cấu hình app OAuth'),
      ]),
      el('p', { class: 'muted small', style: 'margin:6px 0' },
        connected.length ? `Đã kết nối ${connected.length} kênh` : 'Chưa kết nối kênh nào'),
      el('div', { class: 'redirect-box' }, [
        el('span', { title: p.redirectUri }, p.redirectUri),
        el('button', {
          class: 'icon-btn',
          title: 'Copy',
          onclick: () => {
            void navigator.clipboard?.writeText(p.redirectUri);
            toast('Đã copy Redirect URI.', { type: 'info', timeout: 2200 });
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
            toast(err.message, { type: 'error', title: 'Không mở được trang cấp quyền', hint: err.hint });
          }
        },
      }, p.configured ? `Kết nối ${p.label}` : 'Cần cấu hình ở tab Cài đặt'),
      el('p', { class: 'muted small', style: 'margin-top:8px' }, `Quyền: ${p.scopes.join(', ')}`),
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
            title: 'Bật/tắt kênh',
            onchange: async (e) => {
              await api(`/api/channels/${ch.id}`, { method: 'PATCH', body: { enabled: e.target.checked } });
              await refreshState();
            },
          }),
        ]),
      ]),
      el('div', { class: 'channel-facts' }, [
        el('span', {}, `Kết nối: ${fmtDateTime(ch.connectedAt)}`),
        ch.lastUsedAt ? el('span', {}, `Đăng gần nhất: ${fmtRelative(ch.lastUsedAt)}`) : null,
        ch.credentials?.target ? el('span', {}, `Đích: ${ch.credentials.target}`) : null,
        caps ? el('span', {}, `Hỗ trợ: ${[caps.text && 'text', caps.image && 'ảnh', caps.video && 'video', caps.album && 'album'].filter(Boolean).join(', ')}`) : null,
        ch.credentials?.hasRefreshToken ? el('span', {}, '🔑 có refresh token (tự gia hạn)') : null,
      ]),
      ch.lastError ? el('div', { class: 'channel-error' }, [
        el('strong', {}, 'Lỗi gần nhất: '),
        ch.lastError.message,
      ]) : null,
      el('div', { class: 'channel-card-actions' }, [
        el('button', {
          class: 'btn btn-sm',
          onclick: async (e) => {
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = 'Đang kiểm tra...';
            try {
              const { result } = await api(`/api/channels/${ch.id}/verify`, { method: 'POST' });
              if (result.ok) toast(`${ch.name}: token còn hiệu lực.`, { type: 'success' });
              else toast(result.error ?? 'Token không dùng được', { type: 'error', title: ch.name, hint: result.hint, timeout: 12000 });
            } finally {
              btn.disabled = false;
              btn.textContent = 'Kiểm tra';
              await refreshState();
            }
          },
        }, 'Kiểm tra'),
        el('button', {
          class: 'btn btn-sm',
          disabled: !ch.enabled,
          title: ch.enabled ? '' : 'Kênh đang bị tắt',
          onclick: () => {
            if (!ch.enabled) return;
            state.selectedChannels.add(ch.id);
            renderChannelPicker();
            renderPerChannelTabs();
            updateCounters();
            void refreshPreview();
            setView('composer');
          },
        }, 'Soạn bài'),
        el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            if (!confirm(`Ngắt kết nối "${ch.name}"? Token sẽ bị xoá khỏi máy.`)) return;
            await api(`/api/channels/${ch.id}`, { method: 'DELETE' });
            toast('Đã ngắt kết nối.', { type: 'info' });
            await refreshState();
          },
        }, 'Ngắt kết nối'),
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
    toast(`Đã kết nối "${channel.name}".`, { type: 'success' });
    $('#tg-token').value = '';
    $('#tg-chat').value = '';
    await refreshState();
  } catch (err) {
    toast(err.message, { type: 'error', title: 'Kết nối Telegram thất bại', hint: err.hint, timeout: 12000 });
  } finally {
    btn.disabled = false;
  }
}

async function verifyAll() {
  toast('Đang kiểm tra tất cả kênh...', { type: 'info', timeout: 2500 });
  try {
    const { results } = await api('/api/channels/verify', { method: 'POST' });
    const bad = Object.entries(results).filter(([, r]) => !r.ok);
    if (bad.length === 0) toast('Tất cả kênh đều hoạt động.', { type: 'success' });
    else {
      for (const [id, r] of bad) {
        const ch = state.channels.find((c) => c.id === id);
        toast(r.error ?? 'lỗi', { type: 'error', title: ch?.name ?? id, hint: r.hint, timeout: 14000 });
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
            'Để tắt khi app chưa qua audit: TikTok chỉ cho đăng chế độ "Chỉ mình tôi", '
            + 'và tài khoản phải đang ở chế độ private lúc đăng. Bật lên sau khi TikTok '
            + 'duyệt app, lúc đó mới đăng công khai được.'));
        }
        continue;
      }
      box.append(el('label', { class: 'field-label' }, f.label));
      box.append(el('input', {
        type: f.secret ? 'password' : 'text',
        id: `cred-${p.id}-${f.key}`,
        value: s.credentials?.[p.id]?.[f.key] ?? '',
        placeholder: f.secret ? '(để trống nếu không đổi)' : f.label,
      }));
      if (f.key === 'redirectUri') {
        box.append(el('p', { class: 'muted small' },
          'Để trống thì app dùng địa chỉ web admin. Đặt giá trị ở đây khi nền tảng '
          + 'không nhận callback http://127.0.0.1 — TikTok production đòi https, '
          + 'còn app ở chế độ Sandbox thì nhận cả http.'));
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
    toast('Đã lưu cài đặt.', { type: 'success' });
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
    pushActivity({ level: 'warn', msg: 'Mất kết nối luồng sự kiện, đang thử lại...' });
  };
}

function handleEvent(evt) {
  const { type, data, at } = evt;
  switch (type) {
    case 'log':
      pushActivity({ level: data.level, msg: data.msg, meta: data.meta, at });
      break;
    case 'channel:start':
      pushActivity({ level: 'info', msg: `→ đang gửi tới ${channelName(data.channelId)}`, at });
      break;
    case 'channel:done':
      pushActivity({ level: 'ok', msg: `✓ ${channelName(data.channelId)}${data.url ? ` — ${data.url}` : ''}`, at });
      break;
    case 'channel:error':
      pushActivity({ level: 'error', msg: `✕ ${channelName(data.channelId)}: ${data.message}`, at });
      break;
    case 'post:done':
      pushActivity({ level: data.failed?.length ? 'warn' : 'ok', msg: `Xong: ${data.succeeded.length} thành công, ${data.failed.length} lỗi`, at });
      void reloadPosts();
      break;
    case 'post:retry':
      pushActivity({ level: 'warn', msg: `Lùi lịch: ${data.message}`, at });
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
    <h1>Không khởi động được giao diện</h1>
    <pre style="white-space:pre-wrap">${String(err?.stack ?? err)}</pre>
  </div>`;
});
