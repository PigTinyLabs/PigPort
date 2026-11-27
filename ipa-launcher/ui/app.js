const api = window.__TAURI__;
const get = (id) => document.getElementById(id);
const ui = {
  dropZone: get('drop-zone'),
  choose: get('choose'),
  review: get('review'),
  name: get('package-name'),
  file: get('package-file'),
  compatibility: get('compatibility'),
  details: get('package-details'),
  reason: get('package-reason'),
  clear: get('clear'),
  install: get('install'),
  refresh: get('refresh'),
  appCount: get('app-count'),
  libraryState: get('library-state'),
  apps: get('apps'),
};
const store = {
  status: get('store-account-status'),
  checkAccount: get('store-check-account'),
  signIn: get('store-sign-in'),
  form: get('store-search'),
  query: get('store-query'),
  search: get('store-search-button'),
  results: get('store-results'),
  count: get('store-count'),
  empty: get('store-empty'),
  apps: get('store-apps'),
};
const panels = {
  local: { tab: get('local-tab'), content: get('local-panel'), feedback: get('feedback'), message: get('feedback-text') },
  store: { tab: get('store-tab'), content: get('store-panel'), feedback: get('store-feedback'), message: get('store-feedback-text') },
};

const compatibility = {
  ready: { label: 'Có thể cài đặt' },
  encrypted: { label: 'Đã mã hóa', reason: 'Tệp vẫn có lớp mã hóa FairPlay. Hãy chọn bản xuất IPA ARM64 chưa mã hóa.' },
  unsupported: { label: 'Chưa hỗ trợ', reason: 'Bản IPA này chưa tương thích với trình chạy trên Mac.' },
};

const progressMessages = {
  'Checking IPA archive…': 'Đang kiểm tra gói IPA…',
  'Extracting IPA…': 'Đang giải nén IPA…',
  'Converting iOS binaries for Mac Catalyst…': 'Đang chuẩn bị ứng dụng cho macOS…',
  'Signing and verifying game…': 'Đang ký và kiểm tra ứng dụng…',
};

const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const collator = new Intl.Collator('vi', { sensitivity: 'base', numeric: true });
let selected;
let apps;
let pending;
let libraryError = false;
let activePanel = 'local';
let accountStatus = 'unchecked';
let signInOpened = false;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes >= 1024 ** 3) return `${number.format(bytes / 1024 ** 3)} GB`;
  if (bytes >= 1024 ** 2) return `${number.format(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${number.format(bytes / 1024)} KB`;
  return `${number.format(bytes)} B`;
}

function updateControls() {
  const busy = Boolean(pending) || !api;
  ui.choose.disabled = busy;
  ui.clear.disabled = busy;
  ui.refresh.disabled = busy;
  ui.install.disabled = busy || selected?.compatibility !== 'ready';
  for (const button of ui.apps.querySelectorAll('button')) button.disabled = busy;
  const canSearch = !busy && accountStatus === 'signed-in';
  store.checkAccount.disabled = busy;
  store.signIn.disabled = busy;
  store.signIn.hidden = accountStatus === 'signed-in';
  store.query.disabled = !canSearch;
  store.search.disabled = !canSearch || !store.query.value.trim();
  for (const button of store.apps.querySelectorAll('button')) button.disabled = !canSearch;
  if (busy) ui.dropZone.classList.remove('dragging');
}

function feedback(message = '', type = '', panel = 'local') {
  const view = panels[panel];
  view.feedback.hidden = !message;
  view.feedback.className = type ? `feedback ${type}` : 'feedback';
  view.message.textContent = message;
}

async function perform(action, message, work, panel = 'local') {
  if (pending || !api) return;
  pending = action;
  updateControls();
  feedback(message, 'busy', panel);
  try {
    await work();
  } catch (error) {
    const detail = typeof error === 'string' ? error : error?.message;
    feedback(detail || 'Thao tác chưa hoàn tất. Hãy thử lại.', 'error', panel);
  } finally {
    pending = undefined;
    if (panels[panel].feedback.classList.contains('busy')) feedback('', '', panel);
    updateControls();
  }
}

function review(pkg) {
  selected = pkg;
  ui.review.hidden = !pkg;
  if (pkg) {
    const status = compatibility[pkg.compatibility] ?? compatibility.unsupported;
    ui.name.textContent = pkg.name || pkg.appId;
    ui.file.textContent = pkg.file.split('/').at(-1);
    ui.file.title = pkg.file;
    ui.compatibility.textContent = status.label;
    ui.compatibility.className = `compatibility ${pkg.compatibility}`;

    const details = [
      ['Mã ứng dụng', pkg.appId],
      ['Phiên bản', pkg.version],
      ['Kiến trúc', pkg.architectures?.join(', ')],
      ['Dung lượng', formatSize(pkg.size)],
    ];
    ui.details.replaceChildren(...details.filter(([, value]) => value).map(([label, value]) => {
      const field = element('div');
      field.append(element('dt', '', label), element('dd', '', value));
      return field;
    }));

    const reason = pkg.compatibility === 'encrypted' ? status.reason : pkg.reason || status.reason;
    ui.reason.hidden = !reason;
    ui.reason.textContent = reason ?? '';
  }
  updateControls();
}

function appSummary(name, detail) {
  const mark = element('span', 'app-mark', Array.from(name)[0]?.toLocaleUpperCase('vi') || '·');
  mark.setAttribute('aria-hidden', 'true');
  const copy = element('div', 'app-copy');
  copy.append(element('h3', '', name), element('p', '', detail));
  return [mark, copy];
}

function appRow(app) {
  const name = app.name || app.appId;
  const row = element('li', 'app');
  const detail = [app.appId, app.version && `v${app.version}`, formatSize(app.size)].filter(Boolean).join(' · ');
  const actions = element('div', 'app-actions');
  const reveal = element('button', 'quiet', 'Finder');
  reveal.type = 'button';
  reveal.setAttribute('aria-label', `Hiện ${name} trong Finder`);
  reveal.addEventListener('click', () => perform('reveal', 'Đang mở Finder…', () =>
    api.core.invoke('ipa_reveal', { appId: app.appId })));

  const launch = element('button', 'primary', 'Mở');
  launch.type = 'button';
  launch.setAttribute('aria-label', `Mở ${name}`);
  launch.addEventListener('click', () => perform('launch', `Đang mở ${name}…`, async () => {
    await api.core.invoke('ipa_launch', { appId: app.appId });
    feedback(`Đã mở ${name}.`, 'success');
  }));

  actions.append(reveal, launch);
  row.append(...appSummary(name, detail), actions);
  return row;
}

function renderLibrary() {
  const entries = apps ?? [];
  ui.appCount.hidden = !entries.length;
  ui.appCount.textContent = `${entries.length} ứng dụng`;
  ui.libraryState.hidden = Boolean(entries.length);
  ui.libraryState.textContent = libraryError
    ? 'Không đọc được thư viện. Bấm Làm mới để thử lại.'
    : apps ? 'Thư viện đang trống.' : 'Đang mở thư viện…';
  ui.apps.hidden = !entries.length;
  ui.apps.replaceChildren(...[...entries].sort((a, b) => collator.compare(a.name, b.name)).map(appRow));
  updateControls();
}

async function loadLibrary() {
  try {
    apps = await api.core.invoke('ipa_list');
    libraryError = false;
  } catch (error) {
    libraryError = true;
    throw error;
  } finally {
    renderLibrary();
  }
}

async function inspect(file) {
  review(undefined);
  review(await api.core.invoke('ipa_inspect', { file }));
}

function refreshStoreStatus() {
  return perform('store-status', '', async () => {
    store.status.textContent = 'Đang kiểm tra đăng nhập…';
    try {
      const { signedIn } = await api.core.invoke('ipa_store_status');
      accountStatus = signedIn ? 'signed-in' : 'signed-out';
      if (signedIn) signInOpened = false;
      store.status.textContent = signedIn
        ? 'Đã đăng nhập.'
        : signInOpened
          ? 'Hoàn tất đăng nhập trong Terminal rồi bấm Kiểm tra đăng nhập.'
          : 'Đăng nhập để tìm và tải IPA.';
    } catch (error) {
      accountStatus = 'error';
      store.status.textContent = 'Chưa kiểm tra được phiên đăng nhập.';
      throw error;
    }
  }, 'store');
}

function selectPanel(panel) {
  activePanel = panel;
  for (const [name, view] of Object.entries(panels)) {
    const isActive = name === panel;
    view.content.hidden = !isActive;
    view.tab.setAttribute('aria-selected', String(isActive));
    view.tab.tabIndex = isActive ? 0 : -1;
  }
  ui.dropZone.classList.remove('dragging');
  if (panel === 'store' && accountStatus === 'unchecked' && !pending) void refreshStoreStatus();
}

function storeRow(app) {
  const row = element('li', 'app');
  const detail = [app.bundleId, app.version && `v${app.version}`].filter(Boolean).join(' · ');
  const actions = element('div', 'app-actions');
  const download = element('button', 'primary', 'Tải IPA');
  download.type = 'button';
  download.setAttribute('aria-label', `Tải IPA của ${app.name}`);
  download.addEventListener('click', () => perform('store-download', `Đang chuẩn bị tải ${app.name}…`, async () => {
    const savedPath = await api.core.invoke('ipa_store_download', { appId: app.id, name: app.name });
    if (savedPath) feedback(`Đã lưu IPA tại ${savedPath}`, 'success', 'store');
  }, 'store'));
  actions.append(download);
  row.append(...appSummary(app.name, detail), actions);
  return row;
}

for (const [panel, view] of Object.entries(panels)) {
  view.tab.addEventListener('click', () => selectPanel(panel));
  view.tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'local' : event.key === 'End' ? 'store' : panel === 'local' ? 'store' : 'local';
    selectPanel(next);
    panels[next].tab.focus();
  });
}

store.checkAccount.addEventListener('click', refreshStoreStatus);
store.signIn.addEventListener('click', () => perform('store-auth', 'Đang mở Terminal…', async () => {
  await api.core.invoke('ipa_store_auth');
  signInOpened = true;
  store.status.textContent = 'Hoàn tất đăng nhập trong Terminal rồi bấm Kiểm tra đăng nhập.';
}, 'store'));
store.query.addEventListener('input', updateControls);
store.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = store.query.value.trim();
  if (!query || accountStatus !== 'signed-in') return;

  void perform('store-search', 'Đang tìm trên App Store…', async () => {
    store.results.hidden = true;
    const matches = await api.core.invoke('ipa_store_search', { query });
    store.apps.replaceChildren(...matches.map(storeRow));
    store.apps.hidden = matches.length === 0;
    store.empty.hidden = matches.length > 0;
    store.count.textContent = matches.length ? `${matches.length} ứng dụng` : '';
    store.results.hidden = false;
  }, 'store');
});

ui.choose.addEventListener('click', () => perform('choose', 'Đang chọn tệp IPA…', async () => {
  const file = await api.core.invoke('ipa_choose');
  if (!file) return;
  feedback('Đang kiểm tra IPA…', 'busy');
  await inspect(file);
}));

ui.clear.addEventListener('click', () => {
  review(undefined);
  feedback();
  ui.choose.focus();
});

ui.install.addEventListener('click', () => {
  if (selected?.compatibility !== 'ready') return;
  const pkg = selected;
  void perform('install', `Đang cài ${pkg.name}…`, async () => {
    const app = await api.core.invoke('ipa_install', { file: pkg.file });
    apps = [...(apps ?? []).filter(({ appId }) => appId !== app.appId), app];
    libraryError = false;
    review(undefined);
    renderLibrary();
    feedback(`Đã cài ${app.name || pkg.name}.`, 'success');
  });
});

ui.refresh.addEventListener('click', () => perform('list', 'Đang làm mới thư viện…', loadLibrary));

function handleDrop({ payload }) {
  if (activePanel !== 'local' || payload.type === 'over') return;
  const files = payload.paths ?? [];
  const isIpa = files.length === 1 && /\.ipa$/i.test(files[0]);
  ui.dropZone.classList.toggle('dragging', !pending && payload.type === 'enter' && isIpa);
  if (payload.type !== 'drop' || pending) return;
  if (!isIpa) {
    feedback('Hãy thả một tệp có đuôi .ipa.', 'error');
    return;
  }
  void perform('inspect', 'Đang kiểm tra IPA…', () => inspect(files[0]));
}

updateControls();
if (api) {
  void api.event.listen('ipa-progress', ({ payload }) => {
    if (typeof payload !== 'string' || !payload.trim()) return;
    if (pending === 'install') feedback(progressMessages[payload] ?? payload, 'busy');
    if (pending === 'store-download') feedback(payload, 'busy', 'store');
  }).catch(() => {});
  void api.webview?.getCurrentWebview().onDragDropEvent(handleDrop).catch(() => {});
  void perform('list', '', loadLibrary);
} else {
  libraryError = true;
  renderLibrary();
  feedback('Hãy mở PigPort IPA từ ứng dụng macOS để chọn và cài tệp.', 'error');
}
